/**
 * The game: owns every subsystem and runs the frame loop.
 *
 * Phases: boot → menu (attract-mode race or showroom behind the UI) → loading → race → results.
 * URL flags for development: ?quick=race|timeTrial|freeRoam&track=&car=&opp=&diff=&laps=&tod=
 * &weather=&cam=&autopilot=1&ui=0 start straight into a session; window.__GAME__ exposes the instance.
 * ?quick=championship starts a new championship (car, opp, diff, start; &champlaps=N makes every round N laps).
 *
 * Championship: the season lives in `this.championship` (src/game/championship.ts, saved after every round). A round is
 * a normal race whose RaceConfig carries `championship` (the grid and the season identity of each driver); when the
 * results come up the finishing order is scored, the season saved and the UI sent a fresh view model.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { AIDriver } from '../ai';
import { CARS, getCar } from '../cars';
import { createAudioSystem, onLightning } from '../audio';
import { createCarVisual } from '../carvis';
import type {
  CameraMode,
  CarDefinition,
  ChampionshipSetup,
  ChampionshipView,
  Difficulty,
  HudState,
  HudStanding,
  InputFrame,
  Livery,
  MinimapTrack,
  RaceConfig,
  RaceResults,
  Settings,
  TimeOfDay,
  TrackFrame,
  Weather,
  TrackRuntime,
  UIIntent,
  VehicleState,
} from '../core/contracts';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../core/settings';
import type { AudioSystem, CameraRig, CarSound, CarVisual, EffectsSystem, InputSystem, RenderSystem, TrackScene, UISystem } from '../core/systems';
import { createInputSystem } from '../input';
import { PhysicsWorld, SteeringFilter, type Vehicle } from '../physics';
import { createCameraRig, createEffects, createRenderSystem, lightningStrength, type XenoRenderSystem } from '../render';
import { TRACKS, buildTrackScene, loadTrackRuntime } from '../track';
import { createUI } from '../ui';
import { GhostRecorder, ghostPose, loadBestLaps, loadGhost, recordKey, saveBestLap, saveGhost, type GhostLap } from './records';
import { buildView, championshipDef, createChampionship, isPlayable, loadChampionship, nextRound, recordRound, roundConfig, saveChampionship, type ChampionshipState, type Finisher } from './championship';
import { RaceSession, type Entrant } from './session';
import { DRIVER_NAMES, opponentLivery } from './liveries';
import { ReplayPlayer, ReplayRecorder } from './replay';

export const VERSION = '0.9.0';

interface RaceCar {
  entrant: Entrant;
  def: CarDefinition;
  vehicle: Vehicle;
  visual: CarVisual;
  sound: CarSound | null;
  ai: AIDriver | null;
  livery: Livery;
  /** Championship rounds: the driver's stable id in the season. */
  driverId?: string;
}

type Phase = 'boot' | 'menu' | 'loading' | 'race' | 'results';

const _frame: TrackFrame = { position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 };
const _m4 = new Matrix4();
const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();

export class Game {
  settings: Settings;
  render!: RenderSystem;
  input!: InputSystem;
  audio!: AudioSystem;
  ui!: UISystem;
  camera!: CameraRig;
  effects: EffectsSystem | null = null;

  track: TrackRuntime | null = null;
  trackScene: TrackScene | null = null;
  world: PhysicsWorld | null = null;
  cars: RaceCar[] = [];
  player: RaceCar | null = null;
  session: RaceSession | null = null;
  config: RaceConfig | null = null;
  phase: Phase = 'boot';
  paused = false;

  private steering = new SteeringFilter();
  private bestLaps: Record<string, number>;
  /** The saved championship (null = none). The UI only ever sees view models built from it. */
  private championship: ChampionshipState | null = null;
  /** "Round 2 / 4" for the HUD; one object for the whole race. */
  private hudChampionship: { name: string; round: number; rounds: number } | null = null;
  private loadToken = 0;
  private last = 0;
  private hudVisible = true;
  private showTelemetry: boolean;
  private banner: { text: string; until: number } | null = null;
  private toast: { text: string; until: number } | null = null;
  private finishAt: number | null = null;
  private resultsShown = false;
  private tvTimer = 0;
  private tvTarget = 0;
  private ghost: { lap: GhostLap; visual: CarVisual; state: VehicleState; mats: { opacity: number }[] } | null = null;
  private ghostRec = new GhostRecorder();
  private preview: { world: PhysicsWorld; car: RaceCar; carId: string; liveryKey: string } | null = null;
  private previewOrbit = 0;
  private minimaps = new Map<string, MinimapTrack>();
  private autopilot: AIDriver | null = null;
  private readonly params = new URLSearchParams(location.search);
  private frameCount = 0;
  private fpsAvg = 60;
  private minFrameMs = 0;
  private lastRender = 0;
  private replayRec: ReplayRecorder | null = null;
  private replay: { player: ReplayPlayer; t: number; target: number } | null = null;
  /** Frame-time samples for perfStats(): [frame interval ms, CPU ms spent in frame()]. */
  private perfSamples: number[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly uiRoot: HTMLElement,
  ) {
    this.settings = loadSettings();
    this.bestLaps = loadBestLaps();
    // a saved season that names a track or car this build no longer has cannot be raced: ignore it
    const saved = loadChampionship();
    this.championship = saved && isPlayable(saved, TRACKS.map((t) => t.info.id), CARS.map((c) => c.id)) ? saved : null;
    this.showTelemetry = this.settings.hud.telemetry;
    const q = this.params.get('quality');
    if (q === 'low' || q === 'medium' || q === 'high' || q === 'ultra') this.settings.graphics.quality = q;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Boot
  // ───────────────────────────────────────────────────────────────────────────

  async boot(): Promise<void> {
    this.render = await createRenderSystem(this.canvas, this.settings.graphics);
    this.input = createInputSystem(this.settings.controls);
    this.audio = createAudioSystem(this.settings.audio);
    // storms: the sky flashes at each strike, and its thunder follows from the audio after the flash-to-bang delay
    onLightning(this.audio, (s) => (this.render as XenoRenderSystem).lightning(lightningStrength(s.distanceKm)));
    this.ui = createUI(this.uiRoot, {
      cars: CARS,
      tracks: TRACKS.map((t) => t.info),
      settings: structuredClone(this.settings),
      version: VERSION,
      bestLaps: this.bestLaps,
      minimapFor: (id) => this.minimapFor(id),
      onIntent: (i) => this.onIntent(i),
      sound: (s) => this.audio.ui(s),
      championshipDef: championshipDef(TRACKS.map((t) => t.info)),
      championship: this.championshipView(),
    });
    this.applyMaxFps();
    const unlock = () => void this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('resize', () => this.onResize());
    this.onResize();
    // alt-tab / minimise: pause the race (the pause menu is waiting on return) and go silent
    const autoPause = () => {
      if (this.phase === 'race' && !this.paused && !this.resultsShown && !this.replay) this.setPaused(true);
    };
    window.addEventListener('blur', autoPause);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        autoPause();
        this.audio.setVolumes({ ...this.settings.audio, master: 0 });
      } else {
        this.audio.setVolumes(this.settings.audio);
        this.last = performance.now();
      }
    });
    (window as unknown as { __GAME__: Game }).__GAME__ = this;

    const quick = this.params.get('quick');
    this.ui.show('loading');
    this.ui.setLoading(0.05, 'Starting engines');
    if (quick === 'race' || quick === 'timeTrial' || quick === 'freeRoam') {
      await this.startRace(this.quickConfig(quick));
    } else if (quick === 'championship') {
      const p = this.params;
      await this.beginChampionship({
        carId: p.get('car') ?? 'vanta-gt',
        difficulty: (p.get('diff') as Difficulty) ?? 'pro',
        opponents: +(p.get('opp') ?? 7),
        length: 'standard',
        startPosition: (p.get('start') as RaceConfig['startPosition']) ?? 'back',
        grid: 'standings',
      });
    } else {
      // a different circuit, light and sky behind the title screen each time the game starts
      const attractTrack = this.params.get('track') ?? TRACKS[Math.floor(Math.random() * TRACKS.length)].info.id;
      await this.loadAttract(attractTrack, this.attractConditions(attractTrack));
      this.ui.show('title');
      this.audio.setMusic(true);
      this.phase = 'menu';
    }
    if (this.params.get('ui') === '0') this.uiRoot.style.display = 'none';
    (window as unknown as { __READY__: boolean }).__READY__ = true;
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  private quickConfig(mode: 'race' | 'timeTrial' | 'freeRoam'): RaceConfig {
    const p = this.params;
    return {
      mode,
      trackId: p.get('track') ?? 'aurelia',
      carId: p.get('car') ?? 'vanta-gt',
      laps: +(p.get('laps') ?? 3),
      opponents: mode === 'race' ? +(p.get('opp') ?? 7) : 0,
      difficulty: (p.get('diff') as Difficulty) ?? 'pro',
      environment: { timeOfDay: (p.get('tod') as TimeOfDay) ?? 'golden', weather: (p.get('weather') as Weather) ?? 'clear' },
      startPosition: (p.get('start') as RaceConfig['startPosition']) ?? 'middle',
    };
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.render.resize(w, h);
    this.camera?.setAspect(w / h);
  }

  private applyMaxFps(): void {
    const m = this.settings.graphics.maxFps;
    this.minFrameMs = m > 0 ? 1000 / m - 0.5 : 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Track & world loading
  // ───────────────────────────────────────────────────────────────────────────

  minimapFor(trackId: string): MinimapTrack | null {
    const hit = this.minimaps.get(trackId);
    if (hit) return hit;
    try {
      const rt = trackId === this.track?.info.id ? this.track : loadTrackRuntime(trackId);
      const points: { x: number; z: number }[] = [];
      const step = Math.max(1, Math.round(5 / rt.spacing));
      for (let i = 0; i < rt.count; i += step) points.push({ x: rt.px[i], z: rt.pz[i] });
      let w = 0;
      for (let i = 0; i < rt.count; i += 50) w += rt.widthLeft[i] + rt.widthRight[i];
      w /= Math.ceil(rt.count / 50);
      const m: MinimapTrack = {
        points,
        width: w,
        startIndex: 0,
        sectorIndices: [Math.round(rt.sectors[0] / rt.spacing / step), Math.round(rt.sectors[1] / rt.spacing / step)],
        bounds: { minX: rt.bounds.minX, maxX: rt.bounds.maxX, minZ: rt.bounds.minZ, maxZ: rt.bounds.maxZ },
      };
      this.minimaps.set(trackId, m);
      return m;
    } catch {
      return null;
    }
  }

  /** Load the track runtime + scene if it isn't the current one. */
  private async ensureTrack(trackId: string, env: RaceConfig['environment'], token: number): Promise<boolean> {
    await this.render.setEnvironment(env);
    if (token !== this.loadToken) return false;
    if (this.track?.info.id === trackId && this.trackScene) {
      this.trackScene.setEnvironment(this.render.env);
      return true;
    }
    this.disposeTrack();
    this.ui.setLoading(0.15, 'Surveying the circuit');
    const rt = loadTrackRuntime(trackId);
    const scene = await buildTrackScene(rt, {
      quality: this.settings.graphics.quality,
      vegetation: this.settings.graphics.vegetation,
      env: this.render.env,
      renderer: this.render.renderer,
      onProgress: (f, label) => this.ui.setLoading(0.15 + f * 0.6, label),
    });
    if (token !== this.loadToken) {
      scene.dispose();
      return false;
    }
    this.track = rt;
    this.trackScene = scene;
    this.render.scene.add(scene.root);
    scene.setEnvironment(this.render.env);
    this.camera = createCameraRig(rt, scene.tvCameras);
    this.camera.setFov(this.settings.camera.fov);
    this.camera.setShake(this.settings.camera.shake);
    this.camera.setAspect(window.innerWidth / window.innerHeight);
    this.effects = createEffects(this.render, rt, this.settings.graphics.quality);
    return true;
  }

  private disposeTrack(): void {
    this.clearCars();
    this.effects?.dispose();
    this.effects = null;
    if (this.trackScene) {
      this.render.scene.remove(this.trackScene.root);
      this.trackScene.dispose();
    }
    this.trackScene = null;
    this.track = null;
  }

  private clearCars(): void {
    for (const c of this.cars) {
      this.render.scene.remove(c.visual.root);
      c.visual.dispose();
      c.sound?.dispose();
      this.effects?.unregisterCar(c.vehicle.id);
    }
    this.cars = [];
    this.player = null;
    this.session = null;
    this.world = null;
    this.autopilot = null;
    this.replay = null;
    this.replayRec = null;
    if (this.ghost) {
      this.render.scene.remove(this.ghost.visual.root);
      this.ghost.visual.dispose();
      this.ghost = null;
    }
    this.clearPreview();
  }

  private placeOnTrack(v: Vehicle, s: number, d: number, speed = 0): void {
    const tr = this.world!.track;
    tr.frameAt(tr.wrapS(s), _frame);
    const q = new Quaternion().setFromRotationMatrix(_m4.makeBasis(_frame.left, _frame.normal, _frame.tangent));
    const p = _frame.position.clone().addScaledVector(_frame.left, d);
    // put the point back onto the actual surface (banked roads)
    tr.pointAt(tr.wrapS(s), d, p);
    v.placeOnGround(p, q, speed);
  }

  private async spawnCar(def: CarDefinition, livery: Livery, entrant: Omit<Entrant, 'state' | 'id'>, slot: number, withSound: boolean, ai: Difficulty | null, aiSeed?: number, driverId?: string): Promise<RaceCar> {
    const world = this.world!;
    const vehicle = world.addVehicle(def);
    vehicle.assists = entrant.isPlayer
      ? { ...this.settings.assists }
      : { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
    const g = world.track.grid[Math.min(slot, world.track.grid.length - 1)];
    if (slot < world.track.grid.length) vehicle.placeOnGround(g.position, g.quaternion, 0);
    else this.placeOnTrack(vehicle, g.s - 8 * (slot - world.track.grid.length + 1), g.d);
    vehicle.setTemperatures(0.8);
    const visual = await createCarVisual(def, livery, this.settings.graphics.quality);
    visual.setPlayer(entrant.isPlayer);
    this.render.scene.add(visual.root);
    visual.update(vehicle.state, 0, this.render.env);
    const sound = withSound ? this.audio.createCarSound(def.sound, entrant.isPlayer) : null;
    this.effects?.registerCar(vehicle.id, def);
    const car: RaceCar = {
      entrant: { ...entrant, id: vehicle.id, state: vehicle.state },
      def,
      vehicle,
      visual,
      sound,
      // a championship driver keeps the same seed (and so the same pace and mistakes) for the whole season
      ai: ai ? new AIDriver(world.track, def, { difficulty: ai, seed: aiSeed ?? vehicle.id * 17 + slot, wetness: world.wetness }) : null,
      livery,
      driverId,
    };
    this.cars.push(car);
    return car;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Attract mode (behind the menus)
  // ───────────────────────────────────────────────────────────────────────────

  /** Random conditions for the attract race at start-up (?tod= and ?weather= pin them). Mostly golden hour; night only under floodlights. */
  private attractConditions(trackId: string): RaceConfig['environment'] {
    const pick = <T>(w: [T, number][]): T => {
      let r = Math.random() * w.reduce((a, [, n]) => a + n, 0);
      for (const [v, n] of w) if ((r -= n) < 0) return v;
      return w[0][0];
    };
    const tod = this.params.get('tod') as TimeOfDay | null;
    const weather = this.params.get('weather') as Weather | null;
    return {
      timeOfDay: tod ?? pick<TimeOfDay>([['golden', 4], ['morning', 2], ['dusk', 2], ['night', TRACKS.find((t) => t.info.id === trackId)?.info.floodlit ? 2 : 0], ['dawn', 1]]),
      weather: weather ?? pick<Weather>([['clear', 6], ['cloudy', 3], ['overcast', 1]]),
    };
  }

  /** The menus' attract race. Without `env` it keeps the light of the session it follows (in dry weather). */
  private async loadAttract(trackId: string, env?: RaceConfig['environment']): Promise<void> {
    const token = ++this.loadToken;
    this.phase = 'loading';
    const tod = this.track?.info.id === trackId ? this.render.env.settings.timeOfDay : 'golden';
    if (!(await this.ensureTrack(trackId, env ?? { timeOfDay: tod, weather: 'clear' }, token))) return;
    this.clearCars();
    this.world = new PhysicsWorld(this.track!);
    this.audio.setWeather(0, 0);
    const n = Math.min(8, this.track!.grid.length);
    for (let i = 0; i < n; i++) {
      if (token !== this.loadToken) return;
      const def = CARS[i % CARS.length];
      const livery = opponentLivery(i, def);
      this.ui.setLoading(0.8 + (0.2 * i) / n, 'Rolling out the field');
      await this.spawnCar(def, livery, { name: livery.driver, color: livery.primary, carId: def.id, isPlayer: false }, i, false, i % 3 === 0 ? 'alien' : 'pro');
    }
    if (token !== this.loadToken) return;
    // spread them around the lap so the TV cameras always have action
    const L = this.track!.length;
    this.cars.forEach((c, i) => {
      // rolling start at a speed the car can actually carry there (not 108 km/h into a hairpin)
      const s = (i * L) / n + 50;
      const v = Math.min(30, c.ai ? 0.8 * Math.min(c.ai.targetSpeed(s), c.ai.targetSpeed(s + 40)) : 20);
      this.placeOnTrack(c.vehicle, s, 0, v);
      c.vehicle.setTemperatures(1);
    });
    this.session = new RaceSession(this.track!, { ...this.quickConfig('freeRoam'), trackId }, this.cars.map((c) => c.entrant), null, 0.5);
    this.session.startCountdown(0, false);
    this.camera.setMode('tv');
    this.camera.snap();
    this.tvTarget = 0;
    this.ui.setHudVisible(false);
    this.phase = 'menu';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Showroom preview (car select)
  // ───────────────────────────────────────────────────────────────────────────

  private async showPreview(carId: string, liveryOver?: Partial<Livery>): Promise<void> {
    if (!this.track) return;
    const def = getCar(carId);
    const livery: Livery = { ...def.defaultLivery, ...liveryOver, driver: this.settings.playerName };
    const key = JSON.stringify(livery);
    if (this.preview && this.preview.carId === carId) {
      if (this.preview.liveryKey !== key) {
        this.preview.car.visual.setLivery(livery);
        this.preview.liveryKey = key;
      }
      return;
    }
    const token = this.loadToken;
    const world = new PhysicsWorld(this.track);
    const vehicle = world.addVehicle(def);
    // a spot on the start straight, slightly off the racing line
    const s = this.track.wrapS(60);
    this.track.frameAt(s, _frame);
    const q = new Quaternion().setFromRotationMatrix(_m4.makeBasis(_frame.left, _frame.normal, _frame.tangent));
    const p = this.track.pointAt(s, 0, new Vector3());
    vehicle.placeOnGround(p, q, 0);
    vehicle.holdOnGrid = true;
    const visual = await createCarVisual(def, livery, this.settings.graphics.quality);
    if (token !== this.loadToken) {
      visual.dispose();
      return;
    }
    this.clearPreview();
    visual.setPlayer(true);
    this.render.scene.add(visual.root);
    // hide the attract field while the showroom car is up (and its smoke and dust, which would
    // otherwise hang frozen in the air: effects don't update while the showroom runs)
    for (const c of this.cars) c.visual.root.visible = false;
    this.effects?.clear();
    const car: RaceCar = { entrant: { id: vehicle.id, name: '', color: livery.primary, carId, isPlayer: true, state: vehicle.state }, def, vehicle, visual, sound: null, ai: null, livery };
    this.preview = { world, car, carId, liveryKey: key };
    this.camera.setMode('orbit');
    this.camera.snap();
  }

  private clearPreview(): void {
    if (!this.preview) return;
    this.render.scene.remove(this.preview.car.visual.root);
    this.preview.car.visual.dispose();
    this.preview = null;
    this.camera?.setFov(this.settings.camera.fov);
    for (const c of this.cars) c.visual.root.visible = true;
    if (this.camera && this.phase === 'menu') {
      this.camera.setMode('tv');
      this.camera.snap();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Races
  // ───────────────────────────────────────────────────────────────────────────

  async startRace(config: RaceConfig): Promise<void> {
    const token = ++this.loadToken;
    this.phase = 'loading';
    this.paused = false;
    this.resultsShown = false;
    this.finishAt = null;
    this.banner = this.toast = null;
    this.config = config;
    this.ui.setRaceConfig(config);
    this.ui.show('loading');
    this.ui.setLoading(0.05, getTrackName(config.trackId));
    this.audio.setMusic(false);
    if (!(await this.ensureTrack(config.trackId, config.environment, token))) return;
    this.clearCars();
    const track = this.track!;
    this.world = new PhysicsWorld(track);
    // rain: water on the track for the tires and the AI, the rain bed and wet tires for the audio
    this.world.wetness = this.render.env.wetness;
    this.audio.setWeather(this.render.env.rain, this.render.env.wetness);
    const def = getCar(config.carId);
    // a championship round brings its own grid: who starts where, with the season's liveries
    const champ = config.mode === 'race' ? config.championship : undefined;
    const opponents = champ ? Math.max(0, Math.min(11, champ.grid.length - 1)) : config.mode === 'race' ? Math.max(0, Math.min(11, config.opponents)) : 0;
    const total = opponents + 1;
    const playerSlot = champ
      ? Math.max(0, champ.grid.findIndex((g) => g.isPlayer))
      : config.mode !== 'race' ? 0 : config.startPosition === 'pole' ? 0 : config.startPosition === 'back' ? total - 1 : Math.floor(total / 2);
    const playerLivery: Livery = { ...def.defaultLivery, ...config.livery, driver: this.settings.playerName || 'You' };
    this.hudChampionship = champ ? { name: champ.name, round: champ.round, rounds: champ.rounds } : null;
    let slot = 0;
    let aiIndex = 0;
    for (let i = 0; i < total; i++) {
      if (token !== this.loadToken) return;
      this.ui.setLoading(0.78 + (0.2 * i) / total, 'Preparing the grid');
      if (i === playerSlot) {
        this.player = await this.spawnCar(def, playerLivery, { name: playerLivery.driver, color: '#16e0bd', carId: def.id, isPlayer: true }, slot++, true, null, undefined, champ?.grid[i]?.id);
      } else if (champ && champ.grid[i]) {
        const g = champ.grid[i];
        const livery: Livery = g.livery ? { ...g.livery, driver: g.name } : opponentLivery(aiIndex, def, playerLivery);
        await this.spawnCar(def, livery, { name: livery.driver, color: livery.primary, carId: def.id, isPlayer: false }, slot++, true, config.difficulty, g.seed, g.id);
        aiIndex++;
      } else {
        const livery = opponentLivery(aiIndex, def, playerLivery);
        await this.spawnCar(def, livery, { name: livery.driver, color: livery.primary, carId: def.id, isPlayer: false }, slot++, true, config.difficulty);
        aiIndex++;
      }
    }
    if (token !== this.loadToken) return;
    if (config.mode !== 'race') {
      // time trial / free roam: a rolling start 250 m before the line
      this.placeOnTrack(this.player!.vehicle, track.length - 250, 0, 25);
      this.player!.vehicle.setTemperatures(1);
    }
    const stored = this.bestLaps[recordKey(this.recordTrack(config), config.carId)] ?? null;
    this.session = new RaceSession(track, config, this.cars.map((c) => c.entrant), stored, Math.random());
    if (config.mode === 'race') {
      for (const c of this.cars) c.vehicle.holdOnGrid = true;
      this.session.startCountdown(this.world.time, true);
    } else this.session.startCountdown(this.world.time, false);

    // ghost of the personal best (time trial)
    if (config.mode === 'timeTrial' && this.settings.hud.ghost) {
      const lap = loadGhost(this.recordTrack(config), config.carId);
      if (lap) await this.makeGhost(lap, def, playerLivery);
    }
    this.ghostRec.reset();
    if (this.params.get('autopilot') === '1') this.autopilot = new AIDriver(track, def, { difficulty: 'alien', seed: 99, wetness: this.world.wetness });

    this.steering.reset();
    this.replay = null;
    this.replayRec = new ReplayRecorder(this.cars.length, this.world.time);
    const cam = (this.params.get('cam') as CameraMode) || this.settings.camera.defaultMode;
    this.camera.setMode(cam);
    this.camera.snap();
    this.ui.setMinimap(this.minimapFor(config.trackId));
    // compile every shader the grid needs behind the loading screen, not in the first frames of the countdown
    this.ui.setLoading(0.99, 'Warming up');
    await (this.render as XenoRenderSystem).precompile();
    if (token !== this.loadToken) return;
    this.ui.show('none');
    this.ui.setHudVisible(this.hudVisible);
    this.phase = 'race';
  }

  /** Records and ghosts are kept apart for wet sessions (a wet lap can't chase a dry one). */
  private recordTrack(cfg: RaceConfig): string {
    return this.world && this.world.wetness > 0 ? `${cfg.trackId}~wet` : cfg.trackId;
  }

  private async makeGhost(lap: GhostLap, def: CarDefinition, livery: Livery): Promise<void> {
    const visual = await createCarVisual(def, { ...livery, primary: '#9fe9ff', secondary: '#9fe9ff', accent: '#ffffff' }, 'low');
    const ghostMats: { opacity: number }[] = [];
    visual.root.traverse((o) => {
      const m = (o as { material?: { transparent: boolean; opacity: number; depthWrite: boolean } | { transparent: boolean; opacity: number; depthWrite: boolean }[] }).material;
      const mats = Array.isArray(m) ? m : m ? [m] : [];
      for (const mm of mats) {
        mm.transparent = true;
        mm.opacity = 0.28;
        mm.depthWrite = false;
        ghostMats.push(mm);
      }
      o.castShadow = false;
    });
    this.render.scene.add(visual.root);
    // a minimal state for the visual: the ghost has no wheels physics — reuse a spare vehicle state
    const tmpWorld = new PhysicsWorld(this.track!);
    const v = tmpWorld.addVehicle(def);
    v.placeOnGround(this.track!.grid[0].position, this.track!.grid[0].quaternion, 0);
    this.ghost = { lap, visual, state: v.state, mats: ghostMats };
  }

  private resetCar(c: RaceCar): void {
    const tr = this.world!.track;
    const tp = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
    tr.project(c.vehicle.p.x, c.vehicle.p.z, tp);
    const d = Math.max(-tp.widthRight + 1.5, Math.min(tp.widthLeft - 1.5, tp.d));
    this.placeOnTrack(c.vehicle, tp.s - 4, d, 0);
    c.ai?.onReset();
    if (c === this.player) {
      this.steering.reset();
      this.camera.snap();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // UI intents
  // ───────────────────────────────────────────────────────────────────────────

  private onIntent(i: UIIntent): void {
    switch (i.type) {
      case 'startRace':
        this.clearPreview();
        void this.startRace(i.config);
        break;
      case 'resume':
        this.setPaused(false);
        break;
      case 'restart':
        if (this.config) {
          this.setPaused(false);
          void this.startRace(this.config);
        }
        break;
      case 'quitToMenu':
        this.setPaused(false);
        this.ui.setHudVisible(false);
        // the attract field takes a moment to roll out: show the loading screen, not a frozen race frame
        this.ui.setRaceConfig(null);
        this.ui.show('loading');
        this.ui.setLoading(0.05, 'Back to the paddock');
        void this.loadAttract(this.track?.info.id ?? 'aurelia').then(() => {
          this.ui.show('main');
          this.audio.setMusic(true);
        });
        break;
      case 'settingsChanged':
        this.applySettings(i.settings);
        break;
      case 'previewCar':
        void this.showPreview(i.carId, i.livery);
        break;
      case 'previewTrack':
        break;
      case 'menuOpened':
        if (i.screen !== 'setup:car') this.clearPreview();
        break;
      case 'watchReplay':
        this.startReplay();
        break;
      case 'startChampionship':
        void this.beginChampionship(i.setup);
        break;
      case 'championshipNext':
        this.raceNextRound();
        break;
      case 'championshipAbandon':
        this.championship = null;
        saveChampionship(null);
        this.syncChampionship();
        break;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Championship
  // ───────────────────────────────────────────────────────────────────────────

  private championshipView(): ChampionshipView | null {
    return this.championship ? buildView(this.championship, this.settings.playerName) : null;
  }

  private syncChampionship(): void {
    this.ui.setChampionship(this.championshipView());
  }

  /** A new season replaces any saved one and goes straight into round 1. */
  private beginChampionship(setup: ChampionshipSetup): Promise<void> {
    this.clearPreview();
    const def = getCar(setup.carId);
    const name = this.settings.playerName || 'You';
    const state = createChampionship({
      setup,
      tracks: TRACKS.map((t) => t.info),
      playerName: name,
      playerLivery: { ...def.defaultLivery, ...setup.livery, driver: name },
      car: def,
      seed: Math.floor(Math.random() * 2147483647),
    });
    // dev: ?champlaps=N makes every round N laps
    const devLaps = Math.round(+(this.params.get('champlaps') ?? 0));
    if (devLaps >= 1) for (const r of state.calendar) r.laps = Math.min(50, devLaps);
    this.championship = state;
    saveChampionship(state);
    this.syncChampionship();
    return this.startRace(roundConfig(state, 0));
  }

  /** Race the round the saved season is waiting for. */
  private raceNextRound(): void {
    const c = this.championship;
    const r = c ? nextRound(c) : -1;
    if (!c || r < 0) return;
    this.clearPreview();
    void this.startRace(roundConfig(c, r));
  }

  /**
   * A championship round just finished: score it, save the season and hand the UI its new standings. The entries of
   * `res` get the points each driver scored, so the results screen can show them.
   */
  private scoreChampionshipRound(res: RaceResults): void {
    const c = this.championship;
    const info = res.config.championship;
    const session = this.session;
    if (!c || !info || !session || info.round - 1 !== c.results.length) return; // not the round the season is waiting for
    const order = session.ordered();
    const finishers: Finisher[] = order.map((p, i) => ({
      id: this.cars.find((car) => car.entrant.id === p.entrant.id)?.driverId ?? '',
      position: res.entries[i].position,
      totalTime: res.entries[i].totalTime,
      bestLap: res.entries[i].bestLap,
      laps: res.entries[i].laps,
    }));
    const next = recordRound(c, finishers);
    this.championship = next;
    saveChampionship(next);
    const scored = next.results[next.results.length - 1];
    res.entries.forEach((e, i) => {
      const r = scored.entries.find((x) => x.id === finishers[i].id);
      e.points = r?.points ?? 0;
      e.fastestLap = r?.fastestLap ?? false;
    });
    this.syncChampionship();
  }

  private applySettings(s: Settings): void {
    const prevQuality = this.settings.graphics.quality;
    const renamed = this.settings.playerName !== s.playerName;
    this.settings = structuredClone(s);
    saveSettings(this.settings);
    this.render.applyGraphics(s.graphics);
    this.audio.setVolumes(s.audio);
    this.input.setControls(s.controls);
    if (this.player) this.player.vehicle.assists = { ...s.assists };
    this.camera?.setFov(s.camera.fov);
    this.camera?.setShake(s.camera.shake);
    this.showTelemetry = s.hud.telemetry;
    this.applyMaxFps();
    if (renamed && this.championship) this.syncChampionship();
    void prevQuality;
  }

  private setPaused(p: boolean): void {
    if (this.phase !== 'race') return;
    this.paused = p;
    if (this.world) this.world.paused = p;
    this.audio.setPaused(p);
    this.ui.show(p ? 'pause' : 'none');
    this.ui.setHudVisible(!p && this.hudVisible);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Frame loop
  // ───────────────────────────────────────────────────────────────────────────

  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
    if (this.minFrameMs > 0 && now - this.lastRender < this.minFrameMs) return;
    this.lastRender = now;
    const dt = Math.min(0.05, Math.max(0.0005, (now - this.last) / 1000));
    this.last = now;
    this.fpsAvg += (1 / dt - this.fpsAvg) * 0.05;
    this.frameCount++;

    const cpu0 = performance.now();
    const input = this.input.poll(dt);
    if (input.anyPressed) void this.audio.unlock();
    this.ui.setDevice(input.device === 'gamepad' ? input.gamepadId : null);

    if (this.phase === 'race') this.updateRace(dt, input, now);
    else if (this.phase === 'menu' || this.phase === 'results') {
      this.ui.handleInput(input);
      this.updateAttract(dt);
    } else if (this.phase === 'loading') {
      // keep the last scene alive behind the loading screen
      if (this.world && this.camera) this.updateAttract(dt);
    }
    this.audio.update(dt);
    if (this.perfSamples.length < 20000) this.perfSamples.push(dt * 1000, performance.now() - cpu0);
  }

  private updateAttract(dt: number): void {
    if (!this.world || !this.camera || !this.track) return;
    if (this.preview) {
      const pw = this.preview.world;
      pw.step(dt);
      const car = this.preview.car;
      car.visual.update(car.vehicle.state, dt, this.render.env);
      // showroom camera: slow orbit from a front three-quarter view, car framed in the right half
      this.previewOrbit += dt * 0.11;
      const st = car.vehicle.state;
      const cam = this.camera.camera;
      const theta = 0.62 + Math.sin(this.previewOrbit) * 0.55;
      const r = 8.2;
      _v.set(Math.sin(theta) * r, 1.35, Math.cos(theta) * r).applyQuaternion(st.quaternion).add(st.position);
      cam.position.copy(_v);
      _v2.copy(st.position);
      _v2.y += 0.25;
      cam.lookAt(_v2);
      // shift the aim left so the car sits right of center, clear of the menu panel
      _v3.set(1, 0, 0).applyQuaternion(cam.quaternion);
      _v2.addScaledVector(_v3, -2.1);
      cam.lookAt(_v2);
      cam.fov = 38;
      cam.updateProjectionMatrix();
      this.render.setFocus(car.vehicle.state.position);
      this.drawWorld(dt, car.vehicle.state.speed);
      return;
    }
    for (const c of this.cars) {
      if (c.ai) {
        c.ai.update(dt, c.vehicle.state, this.world.states, c.vehicle.controls, true);
        if (c.ai.needsReset) this.resetCar(c);
      }
    }
    this.world.step(dt);
    this.session?.update(dt, this.world.time);
    this.session?.drainEvents();
    for (const c of this.cars) c.visual.update(c.vehicle.state, dt, this.render.env);
    this.effects?.update(dt, this.world.states, this.camera.camera);
    // switch the followed car every ~9 s
    this.tvTimer -= dt;
    if (this.tvTimer <= 0 && this.cars.length) {
      this.tvTimer = 9;
      this.tvTarget = (this.tvTarget + 1 + Math.floor(Math.random() * (this.cars.length - 1))) % this.cars.length;
      this.camera.snap();
    }
    const target = this.cars[this.tvTarget % this.cars.length];
    if (target) {
      this.camera.update(dt, { state: target.vehicle.state, anchors: target.visual.anchors }, { x: 0, y: 0, back: false });
      this.render.setFocus(target.vehicle.state.position);
      this.drawWorld(dt, target.vehicle.state.speed);
    }
  }

  private drawWorld(dt: number, speed: number): void {
    this.trackScene?.update(dt, this.camera.camera);
    _v.set(0, 0, 0);
    this.audio.setListener(this.camera.camera, _v);
    this.render.render(this.camera.camera, dt, speed);
  }

  private updateRace(dt: number, input: InputFrame, now: number): void {
    const world = this.world!;
    const session = this.session!;
    const player = this.player!;
    const pv = player.vehicle;

    if (this.replay) {
      this.updateReplay(dt, input);
      return;
    }

    // pause / menus (once the flag has fallen, Start and Esc belong to the results and standings screens)
    if (input.pause && !this.resultsShown) {
      this.setPaused(!this.paused);
      this.audio.ui(this.paused ? 'select' : 'back');
    }
    if (this.paused || this.resultsShown) {
      this.ui.handleInput(input);
      if (this.paused) {
        this.drawWorld(0, 0);
        return;
      }
    }

    // global race controls
    if (!this.resultsShown) {
      if (input.cameraNext) this.camera.next();
      if (input.toggleHud) {
        this.hudVisible = !this.hudVisible;
        this.ui.setHudVisible(this.hudVisible);
      }
      if (input.toggleTelemetry) this.showTelemetry = !this.showTelemetry;
      if (input.resetCar && session.phase === 'racing') this.resetCar(player);
    }

    // player controls
    const c = pv.controls;
    if (this.autopilot) {
      this.autopilot.update(dt, pv.state, world.states, c, session.phase === 'racing');
      if (this.autopilot.needsReset) {
        this.resetCar(player);
        this.autopilot.onReset();
      }
    } else if (!this.resultsShown) {
      c.steer = this.steering.update(input.steer, dt, pv.state, player.def, this.settings.controls);
      c.throttle = input.throttle;
      c.brake = input.brake;
      c.handbrake = input.handbrake;
      c.clutch = input.clutch;
      if (input.shiftUp) c.shift = 1;
      else if (input.shiftDown) c.shift = -1;
    } else {
      // after the flag the car coasts to a stop
      c.steer = 0;
      c.throttle = 0;
      c.brake = 0.3;
    }
    if (player.entrant.state.forwardSpeed < -0.5 && c.throttle > 0.1) c.handbrake = 0;

    // AI
    const racing = session.phase === 'racing' || session.phase === 'finished';
    for (const car of this.cars) {
      if (!car.ai) continue;
      car.ai.update(dt, car.vehicle.state, world.states, car.vehicle.controls, racing);
      if (car.ai.needsReset) this.resetCar(car);
    }

    world.step(dt);
    session.update(dt, world.time);
    this.handleSessionEvents(now);
    if (this.replayRec && session.phase !== 'countdown') this.replayRec.capture(world.time - this.replayRec.t0, world.states);

    // ghost recording / playback
    const pp = session.player;
    if (pp && session.phase === 'racing' && pp.crossings >= 1) {
      this.ghostRec.sample(world.time - pp.lapStart, pv.state.position, pv.state.quaternion);
      if (this.ghost) {
        const st = this.ghost.state;
        const ok = ghostPose(this.ghost.lap, world.time - pp.lapStart, st.position, st.quaternion);
        this.ghost.visual.root.visible = ok;
        if (ok) {
          // wheels follow the body rigidly at static ride height
          const ch = this.player!.def.physics.chassis;
          const tf = this.player!.def.physics.tireFront;
          const tr = this.player!.def.physics.tireRear;
          for (let i = 0; i < 4; i++) {
            const front = i < 2;
            const x = ((i % 2 === 0 ? 1 : -1) * (front ? ch.trackFront : ch.trackRear)) / 2;
            const z = front ? ch.cgToFrontAxle : ch.cgToFrontAxle - ch.wheelbase;
            const r = front ? tf.radius : tr.radius;
            st.wheels[i].hub.set(x, r - ch.cgHeight, z).applyQuaternion(st.quaternion).add(st.position);
            st.wheels[i].spin += (pv.state.speed / r) * dt;
          }
          this.ghost.visual.update(st, dt, this.render.env);
          // fade out when it overlaps the player's car (a double image reads as a glitch)
          const near = st.position.distanceTo(pv.state.position);
          const op = 0.28 * Math.min(1, Math.max(0, (near - 2.5) / 6));
          for (const m of this.ghost.mats) m.opacity = op;
          this.ghost.visual.root.visible = op > 0.01;
        }
      }
    }

    // visuals, sound, effects
    const interior = this.camera.mode === 'cockpit' || this.camera.mode === 'hood' || this.camera.mode === 'bumper';
    for (const car of this.cars) {
      car.visual.update(car.vehicle.state, dt, this.render.env);
      if (car.sound) {
        car.sound.update(car.vehicle.state, dt);
        if (car === player) car.sound.setInterior(interior);
      }
    }
    player.visual.setCockpitView(this.camera.mode === 'cockpit');
    this.effects?.update(dt, world.states, this.camera.camera);
    this.camera.update(dt, { state: pv.state, anchors: player.visual.anchors }, { x: input.lookX, y: input.lookY, back: input.lookBack });
    this.render.setFocus(pv.state.position);
    this.trackScene?.update(dt, this.camera.camera);
    this.trackScene?.setStartLights(session.phase === 'countdown' ? session.lights : session.phase === 'racing' && world.time - session.startTime < 3 ? 6 : null);
    this.audio.setListener(this.camera.camera, pv.state.velocity);
    this.render.render(this.camera.camera, dt, pv.state.speed);

    // rumble on impacts and kerbs
    this.rumble(player);

    // HUD
    if (this.hudVisible && !this.resultsShown) this.ui.updateHud(this.buildHud(now));

    // results
    if (this.finishAt !== null && !this.resultsShown && (now > this.finishAt || session.phase === 'finished')) this.showResults();
  }

  private lastImpactSeen = 0;
  private rumble(p: RaceCar): void {
    if (!this.settings.controls.vibration) return;
    const st = p.vehicle.state;
    if (st.impactCount !== this.lastImpactSeen) {
      this.lastImpactSeen = st.impactCount;
      const k = Math.min(1, st.lastImpact.strength / 12);
      this.input.rumble(k, k * 0.6, 120 + 200 * k);
    }
    let curb = 0;
    let slip = 0;
    for (const w of st.wheels) {
      if (w.contact && w.surface === 'curb') curb = Math.max(curb, Math.min(1, st.speed / 30));
      slip = Math.max(slip, w.skid);
    }
    if (curb > 0.05 || slip > 0.3) this.input.rumble(curb * 0.35, Math.max(curb * 0.5, slip * 0.25), 60);
  }

  private handleSessionEvents(now: number): void {
    const session = this.session!;
    for (const e of session.drainEvents()) {
      switch (e.type) {
        case 'light':
          this.audio.ui('countdown');
          break;
        case 'go':
          this.audio.ui('go');
          for (const c of this.cars) c.vehicle.holdOnGrid = false;
          break;
        case 'lap':
          if (e.entrant.isPlayer) {
            const lapLap = this.ghostRec.finish(e.time);
            this.ghostRec.reset();
            const cfg = this.config!;
            if (e.personalBest) {
              this.bestLaps = saveBestLap(this.recordTrack(cfg), cfg.carId, e.time);
              this.ui.setBestLaps(this.bestLaps);
              saveGhost(this.recordTrack(cfg), cfg.carId, lapLap);
              if (cfg.mode === 'timeTrial' && this.settings.hud.ghost) {
                if (this.ghost) {
                  this.ghost.lap = lapLap;
                } else void this.makeGhost(lapLap, this.player!.def, this.player!.livery);
              }
              this.flashToast(`PERSONAL BEST  ${fmtTime(e.time)}`, now);
              this.audio.ui('bestLap');
            } else {
              this.flashToast(`${e.best ? 'BEST LAP' : 'LAP'}  ${fmtTime(e.time)}`, now);
              this.audio.ui('lap');
            }
          }
          break;
        case 'finalLap':
          if (e.entrant.isPlayer) this.flashBanner('FINAL LAP', now, 2500);
          break;
        case 'finish':
          if (e.entrant.isPlayer) {
            this.flashBanner(e.position === 1 ? 'VICTORY' : `FINISHED  P${e.position}`, now, 5000);
            this.audio.ui('finish');
            this.finishAt = now + 7000;
          }
          break;
        case 'sector':
          break;
      }
    }
  }

  private flashBanner(text: string, now: number, ms: number): void {
    this.banner = { text, until: now + ms };
  }
  private flashToast(text: string, now: number): void {
    this.toast = { text, until: now + 4000 };
  }

  private showResults(): void {
    const session = this.session!;
    if (session.phase !== 'finished') session.closeRace();
    const cfg = this.config!;
    const pb = session.player?.bestLap ?? null;
    const stored = session.storedBest;
    const res = session.results(pb !== null && (stored === null || pb <= stored));
    if (cfg.championship) this.scoreChampionshipRound(res);
    this.ui.setResults(res);
    this.ui.setHudVisible(false);
    this.ui.show('results');
    this.resultsShown = true;
    this.camera.setMode('tv');
    this.camera.snap();
    this.audio.setMusic(true);
  }

  private startReplay(): void {
    if (!this.replayRec || this.replayRec.frames < 30 || !this.world) return;
    this.replay = { player: new ReplayPlayer(this.replayRec, this.world.states), t: 0, target: this.cars.indexOf(this.player!) };
    this.effects?.clear();
    this.ui.show('none');
    this.ui.setHudVisible(false);
    this.camera.setMode('tv');
    this.camera.snap();
    this.audio.setMusic(false);
  }

  private stopReplay(): void {
    this.replay = null;
    this.effects?.clear();
    this.ui.show('results');
    this.audio.setMusic(true);
  }

  private updateReplay(dt: number, input: InputFrame): void {
    const r = this.replay!;
    if (input.nav.back || input.pause) {
      this.stopReplay();
      return;
    }
    if (input.nav.right || input.nav.tabRight) {
      r.target = (r.target + 1) % this.cars.length;
      this.camera.snap();
    }
    if (input.nav.left || input.nav.tabLeft) {
      r.target = (r.target - 1 + this.cars.length) % this.cars.length;
      this.camera.snap();
    }
    if (input.cameraNext) this.camera.next();
    r.t += dt;
    if (r.t > r.player.rec.duration) {
      r.t = 0;
      this.effects?.clear();
      this.camera.snap();
    }
    r.player.apply(r.t);
    const states = r.player.states;
    this.cars.forEach((c, i) => {
      c.visual.update(states[i], dt, this.render.env);
      c.sound?.update(states[i], dt);
    });
    this.effects?.update(dt, states, this.camera.camera);
    const target = this.cars[r.target];
    const ts = states[r.target];
    this.camera.update(dt, { state: ts, anchors: target.visual.anchors }, { x: input.lookX, y: input.lookY, back: false });
    this.render.setFocus(ts.position);
    this.trackScene?.update(dt, this.camera.camera);
    this.audio.setListener(this.camera.camera, ts.velocity);
    this.render.render(this.camera.camera, dt, ts.speed);
  }

  private buildHud(now: number): HudState {
    const session = this.session!;
    const p = this.player!;
    const st = p.vehicle.state;
    const def = p.def;
    const pp = session.player!;
    const order = session.ordered();
    const leader = order[0];
    const cfg = this.config!;
    // standings: leader + the cars around the player
    const standings: HudStanding[] = [];
    const idx = order.indexOf(pp);
    const pick = new Set<number>([0, idx - 1, idx, idx + 1, 1, 2].filter((i) => i >= 0 && i < order.length));
    [...pick].sort((a, b) => a - b).slice(0, 6).forEach((i) => {
      const e = order[i];
      standings.push({ position: e.position, name: e.entrant.name, gap: session.gapString(e, leader), isPlayer: e.entrant.isPlayer, color: e.entrant.color });
    });
    const up = def.physics.drivetrain.upshiftRpm;
    const shiftLight = Math.max(0, Math.min(1, (st.rpm - (up - 2200)) / 2200));
    const tires = st.wheels.map((w, i) => ({ slip: Math.min(1.25, p.vehicle.slipUsage(i)), tempC: w.tempC, load: w.load / p.vehicle.staticLoad(i) }));
    const cars = this.cars.map((c) => {
      const s = c.vehicle.state;
      _v.set(0, 0, 1).applyQuaternion(s.quaternion);
      return { x: s.position.x, z: s.position.z, heading: Math.atan2(_v.x, _v.z), color: c.entrant.color, isPlayer: c === p };
    });
    if (this.banner && now > this.banner.until) this.banner = null;
    if (this.toast && now > this.toast.until) this.toast = null;
    const t = this.world!.time;
    const racing = session.phase === 'racing' || session.phase === 'finished';
    const countdown = session.phase === 'countdown' ? session.lights : racing && t - session.startTime < 1.2 && cfg.mode === 'race' ? 6 : null;
    return {
      mode: cfg.mode,
      units: this.settings.units,
      speed: Math.abs(st.forwardSpeed),
      rpm: st.rpm,
      idleRpm: st.idleRpm,
      redlineRpm: st.redlineRpm,
      limiterRpm: st.limiterRpm,
      gear: st.gear,
      throttle: st.throttle,
      brake: st.brake,
      steer: st.steer,
      shiftLight,
      absActive: st.absActive,
      tcsActive: st.tcsActive,
      escActive: st.escActive,
      lap: Math.max(1, Math.min(cfg.mode === 'race' ? cfg.laps : 999, pp.crossings)),
      totalLaps: cfg.mode === 'race' ? cfg.laps : 0,
      position: pp.position,
      totalCars: this.cars.length,
      raceTime: racing ? t - session.startTime : 0,
      lapTime: racing && (pp.crossings >= 1 || cfg.mode === 'race') ? t - pp.lapStart : 0,
      lastLap: pp.lapTimes.length ? pp.lapTimes[pp.lapTimes.length - 1] : null,
      bestLap: pp.bestLap ?? session.storedBest,
      delta: session.liveDelta(),
      sector: pp.sector,
      sectorDeltas: session.sectorDeltas(),
      standings: cfg.mode === 'race' && this.settings.hud.standings ? standings : [],
      cars,
      gLat: st.localAccel.x / 9.81,
      gLong: st.localAccel.z / 9.81,
      tires,
      countdown,
      wrongWay: pp.wrongWayTime > 1.5,
      banner: this.banner?.text ?? null,
      toast: this.toast?.text ?? null,
      showTelemetry: this.showTelemetry,
      hudVisible: this.hudVisible,
      championship: this.hudChampionship,
    };
  }

  /** Debug helper: average frames per second. */
  get fps(): number {
    return this.fpsAvg;
  }

  /** Debug helper: frame-time statistics since the last reset (used by scripts/tour.mjs). */
  perfStats(reset = false): Record<string, number> {
    const n = this.perfSamples.length / 2;
    const frames: number[] = [];
    const cpu: number[] = [];
    for (let i = 0; i < n; i++) {
      frames.push(this.perfSamples[i * 2]);
      cpu.push(this.perfSamples[i * 2 + 1]);
    }
    const pct = (a: number[], q: number) => {
      const b = a.slice().sort((x, y) => x - y);
      return b.length ? +b[Math.min(b.length - 1, Math.floor(q * b.length))].toFixed(2) : 0;
    };
    const mean = (a: number[]) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0);
    const info = this.render.renderer.info;
    const out = {
      frames: n,
      fps: mean(frames) > 0 ? +(1000 / mean(frames)).toFixed(1) : 0,
      frameP50: pct(frames, 0.5),
      frameP95: pct(frames, 0.95),
      frameMax: pct(frames, 1),
      cpuMean: mean(cpu),
      cpuP95: pct(cpu, 0.95),
      calls: info.render.calls,
      tris: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      heapMB: +((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576,
    };
    if (reset) this.perfSamples.length = 0;
    return out;
  }
}

function getTrackName(id: string): string {
  return TRACKS.find((t) => t.info.id === id)?.info.name ?? id;
}

export function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export { DEFAULT_SETTINGS, DRIVER_NAMES };
