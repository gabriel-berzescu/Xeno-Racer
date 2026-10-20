/**
 * The game: owns every subsystem and runs the frame loop.
 *
 * Phases: boot → menu (attract-mode race or showroom behind the UI) → loading → race → results.
 * URL flags for development: ?quick=race|timeTrial|freeRoam&track=&car=&opp=&diff=&laps=&tod=
 * &weather=&cam=&autopilot=1&ui=0 start straight into a session; window.__GAME__ exposes the instance.
 * ?quick=championship starts a new championship (car, opp, diff, start; &champlaps=N makes every round N laps).
 * &players=2 (race or freeRoam) puts a second human on the same screen in &car2= (default: another car), each with a camera and a HUD of
 * their own; with &autopilot=1 both drive themselves. Split screen: see src/core/split.ts, and `drivers` below for what is whose.
 * &assists=pro|standard|beginner, &line=off|braking|full and &brakeassist=1 set player 1's aids for the session (player 2's: &assists2=,
 * &line2=, &brakeassist2=); see src/core/aids.ts. A dev autopilot has pedals of its own: the braking assist leaves them alone.
 *
 * Championship: the season lives in `this.championship` (src/game/championship.ts, saved after every round). A round is
 * a normal race whose RaceConfig carries `championship` (the grid and the season identity of each driver); when the
 * results come up the finishing order is scored, the season saved and the UI sent a fresh view model.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { version } from '../../package.json';
import { AIDriver } from '../ai';
import { NITRO_PER_LAP, NITRO_SECONDS, NitroTank } from '../core/nitro';
import { CARS, getCar } from '../cars';
import { armWeather, createAudioSystem, onAlbumTrack, onLightning, primeAlbum, primeCarVoices, setDriving, setWiper, skipTrack } from '../audio';
import { createCarVisual } from '../carvis';
import type {
  CameraMode,
  CarDefinition,
  ChampionshipSetup,
  ChampionshipView,
  Difficulty,
  Forecast,
  HudDamage,
  HudState,
  HudStanding,
  HudWeather,
  InputFrame,
  Livery,
  MinimapTrack,
  PlayersInfo,
  RaceConfig,
  RaceResults,
  Seat,
  Settings,
  SplitLayout,
  TimeOfDay,
  TrackFrame,
  Weather,
  WeatherState,
  TrackRuntime,
  UIIntent,
  VehicleState,
} from '../core/contracts';
import { ASSIST_PRESET_IDS, applyAssistPreset, assistsOfSeat, carAssists, lineLead, lineShownIn, lineWidth, LINE_MODES, type AssistPreset } from '../core/aids';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../core/settings';
import type { AudioSystem, CameraRig, CarSound, CarVisual, EffectsSystem, RenderSystem, TrackScene, UISystem } from '../core/systems';
import { opponentLimit, playerSlots, SEAT_COLOR, splitFov, viewAspect } from '../core/split';
import { createInputSystem, type PlayerSource, type XenoInputSystem } from '../input';
import { PhysicsWorld, SteeringFilter, type Vehicle } from '../physics';
import { createCameraRig, createDrivingLine, createEffects, createRenderSystem, lightningStrength, LINE_LAYERS, type DrivingLine, type MirrorFrame, type ViewSpec, type XenoRenderSystem } from '../render';
import { TRACKS, buildTrackScene, loadTrackRuntime } from '../track';
import { createUI } from '../ui';
import { GhostRecorder, ghostPose, loadBestLaps, loadGhost, recordKey, saveBestLap, saveGhost, type GhostLap } from './records';
import { buildView, championshipDef, createChampionship, isPlayable, loadChampionship, nextRound, recordRound, roundConfig, saveChampionship, type ChampionshipState, type Finisher } from './championship';
import { RaceSession, type Entrant } from './session';
import { DRIVER_NAMES, opponentLivery } from './liveries';
import type { ContactOther } from '../core/damage';
import { DAMAGE_SHOWN, mechanicalReport, mechanicalWorst } from '../core/mechanical';
import { DriverAids } from './driveraids';
import { MechLink } from './mechsync';
import { ReplayPlayer, ReplayRecorder } from './replay';
import { makeSpotter, updateSpotter, type SpotterBody, type SpotterState } from './spotter';
import { collectHeadlamps, makeMirrorLamps } from './headlamps';
import { makePlan, nearestWeather, trackCondition, WET_RECORD, WeatherDirector, WeatherLog, type WeatherPlan } from './weather';

/** Camera names for the replay overlay. */
const CAMERA_LABEL: Record<CameraMode, string> = { chase: 'Chase', 'chase-far': 'Chase far', hood: 'Hood', bumper: 'Bumper', cockpit: 'Cockpit', tv: 'TV', orbit: 'Orbit' };

/** The game's version: package.json's, the one place it is written (bump it with `npm version patch|minor|major`). */
export const VERSION: string = version;

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
  /** Puts the mechanical damage of the car's record on its physics and its driver (Damage: Full, see syncMechanical). */
  mech: MechLink;
  /** The car's nitro shots (src/core/nitro.ts): refilled every lap, fired by its human or its AI driver. */
  nitro: NitroTank;
}

/**
 * One human at the wheel: their car, the camera that films it, and everything that is theirs alone (their steering filter, their
 * banners, their spotter, the lap they are on). A single-player race has one; a split screen has two, in seat order.
 */
interface Driver {
  seat: Seat;
  car: RaceCar;
  rig: CameraRig;
  steering: SteeringFilter;
  /** Development (?autopilot=1): the AI that drives this car. */
  autopilot: AIDriver | null;
  banner: { text: string; until: number } | null;
  toast: { text: string; until: number } | null;
  /** Split screen: this seat's HUD is shown (D-pad up hides it, leaving the centre messages). A single player's is Game.hudVisible. */
  hudVisible: boolean;
  /** Proximity spotter: the smoothed state, and what the HUD is handed. */
  spotter: SpotterState;
  spotOut: { left: number; right: number; leftAt: number; rightAt: number };
  /** The most water on the track since this driver's lap began: a lap on a road that was wet at any point is a wet lap. */
  lapWet: number;
  /** The last impact the controller was told about (rumble). */
  impactSeen: number;
  /** Crossed the line after the last lap. */
  finished: boolean;
  /** Split screen: this human's own lap recorder (the ghost saved with a record they set; a single player's is Game.ghostRec). */
  ghostRec: GhostRecorder;
  /** This human's driving guide and braking assist (src/game/driveraids.ts), and the driving line drawn from the guide. */
  aids: DriverAids;
  line: DrivingLine;
  /** Split screen: a lap of theirs beat the record of their car on this track during the race. */
  pb: boolean;
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
  input!: XenoInputSystem;
  audio!: AudioSystem;
  ui!: UISystem;
  camera!: CameraRig;
  effects: EffectsSystem | null = null;

  track: TrackRuntime | null = null;
  trackScene: TrackScene | null = null;
  world: PhysicsWorld | null = null;
  cars: RaceCar[] = [];
  /** Player 1's car (the one player's, in a single-player race). */
  player: RaceCar | null = null;
  /** The humans at the wheel, in seat order. */
  drivers: Driver[] = [];
  /**
   * Development (?autopilot=1): the AI that drives player 1's car. Setting it to null hands every human's car to their pad again, as
   * the QA scripts do from the console (`__GAME__.autopilot = null`); a split screen's second AI is `drivers[1].autopilot`.
   */
  get autopilot(): AIDriver | null {
    return this.drivers[0]?.autopilot ?? null;
  }
  set autopilot(v: AIDriver | null) {
    if (v === null) for (const d of this.drivers) d.autopilot = null;
    else if (this.drivers[0]) this.drivers[0].autopilot = v;
  }
  /** How the screen is divided right now: two views (a split-screen race), or null for one over all of it. */
  splitLayout: SplitLayout | null = null;
  session: RaceSession | null = null;
  config: RaceConfig | null = null;
  phase: Phase = 'boot';
  paused = false;

  private bestLaps: Record<string, number>;
  /** The saved championship (null = none). The UI only ever sees view models built from it. */
  private championship: ChampionshipState | null = null;
  /** "Round 2 / 4" for the HUD; one object for the whole race. */
  private hudChampionship: { name: string; round: number; rounds: number } | null = null;
  private loadToken = 0;
  private last = 0;
  private hudVisible = true;
  private showTelemetry: boolean;
  private finishAt: number | null = null;
  private resultsShown = false;
  /** The pad driving the race, to notice it being unplugged. */
  private racePadId: string | null = null;
  private tvTimer = 0;
  private tvTarget = 0;
  private ghost: { lap: GhostLap; visual: CarVisual; state: VehicleState; mats: { opacity: number }[] } | null = null;
  private ghostRec = new GhostRecorder();
  private preview: { world: PhysicsWorld; car: RaceCar; carId: string; liveryKey: string } | null = null;
  private previewOrbit = 0;
  private minimaps = new Map<string, MinimapTrack>();
  /** Player 2's camera (made when a split-screen race first needs it, kept after). */
  private rig2: CameraRig | null = null;
  private readonly viewSpecs: ViewSpec[] = [];
  /** The step of the frame being drawn, for the second view's track scene update. */
  private viewDt = 0;
  private readonly prepareViewFn = (i: number): void => this.prepareView(i);
  private readonly params = new URLSearchParams(location.search);
  private frameCount = 0;
  private fpsAvg = 60;
  private minFrameMs = 0;
  /** The track, quality and vegetation the current track scene was built with. */
  private trackBuilt = '';
  /** Frame cap: when the next frame is due, and the display's refresh interval (smoothed). */
  private nextFrameAt = 0;
  private lastTick = 0;
  private tickMs = 1000 / 60;
  private replayRec: ReplayRecorder | null = null;
  private replay: { player: ReplayPlayer; t: number; target: number } | null = null;
  /** Frame-time samples for perfStats(): [frame interval ms, CPU ms spent in frame()]. */
  private perfSamples: number[] = [];
  /** Each car's footprint for the proximity spotter (see src/game/spotter.ts). */
  private spotList: SpotterBody[] = [];
  private spotCars: RaceCar[] | null = null;
  /** Each car's lamp light output (damage: head left, head right, tail left, tail right), for the glare in the mirrors. */
  private lampOutputs: Array<Readonly<Float32Array> | undefined> = [];
  /** What the mirrors are told every frame (one object, rewritten in place). */
  private readonly mirrorFrame: MirrorFrame = { mode: 'off', rig: null, hud: false };
  /** The lit headlamps of the cars behind, for the glare in the mirrors at night (see src/game/headlamps.ts). */
  private readonly mirrorLamps = makeMirrorLamps();
  /** The weather of the race that is loaded, when it changes during the race (null: the weather in the settings, all race long). */
  private wx: WeatherDirector | null = null;
  /** What the HUD shows of it (one object, rewritten in place) and the notice on show: "Rain is coming". */
  private readonly wxHud: HudWeather = { sky: 'clear', rain: 0, wetness: 0, track: 'Dry', forecast: 'rainLater', called: false, notice: null };
  private wxNotice: { n: NonNullable<HudWeather['notice']>; until: number } | null = null;
  /** The environment the track scene was last given: it is told again once the weather has moved on. */
  private readonly wxSent = { rain: -1, wetness: -1, darkness: -1 };
  /** The weather as it was during the race, for the replay. */
  private readonly wxLog = new WeatherLog();
  private readonly wxReplay: WeatherState = { sky: 0, rain: 0, wetness: 0 };
  /** The water on the track the drivers were built for, and the water each was last told about. */
  private wxStartWet = 0;
  private readonly wxTuned = new WeakMap<AIDriver, number>();
  /** Damage: Full. What each seat's HUD is handed of its car's mechanical damage (one object per seat, rewritten in place). */
  private readonly dmgHud: HudDamage[] = [0, 1].map(() => ({ front: 0, rear: 0, left: 0, right: 0, wheels: [0, 0, 0, 0] }));

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
    // development: ?damage=off|visual|full
    const dm = this.params.get('damage');
    if (dm === 'off' || dm === 'visual' || dm === 'full') this.settings.damage = dm;
    // development: ?nitro=off|on
    const nt = this.params.get('nitro');
    if (nt === 'off' || nt === 'on') this.settings.nitro = nt === 'on';
    // development: ?assists=pro|standard|beginner, ?line=off|braking|full and ?brakeassist=1 set player 1's aids (player 2's: assists2, line2, brakeassist2)
    for (const seat of [0, 1] as const) {
      const sfx = seat === 1 ? '2' : '';
      const set = assistsOfSeat(this.settings, seat);
      const preset = this.params.get('assists' + sfx) as AssistPreset | null;
      if (preset && ASSIST_PRESET_IDS.includes(preset)) applyAssistPreset(set, preset);
      const lm = this.params.get('line' + sfx);
      if (lm && (LINE_MODES as readonly string[]).includes(lm)) set.line = lm as typeof set.line;
      const ba = this.params.get('brakeassist' + sfx);
      if (ba !== null) set.brakeAssist = ba !== '0' && ba !== 'false';
    }
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
    // the race music: a card on the HUD and a line on the pause menu say which song has started
    onAlbumTrack(this.audio, (np) => this.ui.setNowPlaying(np));
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
    // &players=2: a second human, in &car2= (the next car of the roster when it is not given)
    const two = p.get('players') === '2' && mode !== 'timeTrial';
    const car = p.get('car') ?? 'vanta-gt';
    const car2 = p.get('car2') ?? CARS[(Math.max(0, CARS.findIndex((c) => c.id === car)) + 1) % CARS.length].id;
    return {
      mode,
      trackId: p.get('track') ?? 'aurelia',
      carId: car,
      laps: +(p.get('laps') ?? 3),
      opponents: mode === 'race' ? Math.min(+(p.get('opp') ?? 7), opponentLimit(two ? 2 : 1)) : 0,
      ...(two ? { player2: { carId: car2, livery: { driver: this.settings.player2Name || 'Player 2' } } } : {}),
      difficulty: (p.get('diff') as Difficulty) ?? 'pro',
      environment: { timeOfDay: (p.get('tod') as TimeOfDay) ?? 'golden', weather: (p.get('weather') as Weather) ?? 'clear' },
      startPosition: (p.get('start') as RaceConfig['startPosition']) ?? 'middle',
      // weather that changes: ?forecast=rainLater|clearing (&wxseed=N picks when and how hard)
      forecast: (p.get('forecast') as Forecast | null) ?? undefined,
      forecastSeed: p.has('wxseed') ? +(p.get('wxseed') ?? 1) : undefined,
    };
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.render.resize(w, h);
    this.applyLens();
  }

  /**
   * The lens of each camera: the shape of the screen, or in a split screen the shape of its own view, with a field of view that
   * suits a view that wide and short (or tall and narrow): see splitFov.
   */
  private applyLens(): void {
    const geo = this.splitLayout && this.drivers.length > 1 ? (this.render as XenoRenderSystem).splitView : null;
    if (geo) {
      this.drivers.forEach((d, i) => {
        const a = viewAspect(geo.views[Math.min(i, 1)]);
        d.rig.setAspect(a);
        d.rig.setFov(splitFov(this.settings.camera.fov, a));
      });
      return;
    }
    this.camera?.setAspect(window.innerWidth / window.innerHeight);
  }

  /** Cut the screen in two. Behind the loading screen, before the shaders are compiled: the render system, the audio and each camera's lens. */
  private beginSplit(layout: SplitLayout): void {
    this.splitLayout = layout;
    (this.render as XenoRenderSystem).setSplit(layout);
    this.audio.setSplit(true);
    this.applyLens();
  }

  /** The screen as one view again: the render system, the HUD, the audio and the lens of the camera. */
  private endSplit(): void {
    if (!this.splitLayout) return;
    this.splitLayout = null;
    (this.render as XenoRenderSystem).setSplit(null);
    this.ui.setSplit(null);
    this.audio.setSplit(false);
    this.camera?.setFov(this.settings.camera.fov);
    this.applyLens();
  }

  private applyMaxFps(): void {
    const m = this.settings.graphics.maxFps;
    this.minFrameMs = m > 0 ? 1000 / m : 0;
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
  private async ensureTrack(trackId: string, env: RaceConfig['environment'], token: number, forecastTo: Weather | null = null): Promise<boolean> {
    // (a winter circuit has its own light, its own ground and a snowfall for rain: the environment is told)
    const winter = TRACKS.find((t) => t.info.id === trackId)?.info.winter === true;
    const xr = this.render as XenoRenderSystem;
    // the scene is reused for the same track, unless the quality or vegetation it was built with has changed since
    const built = `${trackId}|${this.settings.graphics.quality}|${this.settings.graphics.vegetation}`;
    const kept = this.track?.info.id === trackId && this.trackScene !== null && this.trackBuilt === built;
    // (a new circuit: the ground of the one before has nothing to say about this race's sun; a kept one has its map remade by setEnvironment if the sun moved)
    if (!kept) await xr.setTerrain(null);
    await xr.setEnvironment(winter ? { ...env, winter } : env, forecastTo);
    if (token !== this.loadToken) return false;
    if (kept && this.trackScene) {
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
    // where the hills hide the sun from this circuit (a few hundred ms of work in slices, behind the loading screen)
    this.ui.setLoading(0.76, 'Sun and shade');
    await xr.setTerrain(scene.terrain ?? null);
    if (token !== this.loadToken) {
      scene.dispose();
      return false;
    }
    this.track = rt;
    this.trackScene = scene;
    this.trackBuilt = built;
    this.render.scene.add(scene.root);
    scene.setEnvironment(this.render.env);
    this.camera = createCameraRig(rt, scene.tvCameras);
    this.rig2 = null;
    this.camera.setFov(this.settings.camera.fov);
    this.camera.setShake(this.settings.camera.shake);
    this.camera.setAspect(window.innerWidth / window.innerHeight);
    this.effects = createEffects(this.render, rt, this.settings.graphics.quality);
    return true;
  }

  private disposeTrack(): void {
    void (this.render as XenoRenderSystem).setTerrain(null);
    this.clearCars();
    this.effects?.dispose();
    this.effects = null;
    if (this.trackScene) {
      this.render.scene.remove(this.trackScene.root);
      this.trackScene.dispose();
    }
    this.trackScene = null;
    this.track = null;
    this.rig2 = null;
  }

  private clearCars(): void {
    for (const c of this.cars) {
      this.render.scene.remove(c.visual.root);
      c.visual.dispose();
      c.sound?.dispose();
      this.effects?.unregisterCar(c.vehicle.id);
    }
    for (const d of this.drivers) {
      this.render.scene.remove(d.line.mesh);
      d.line.dispose();
    }
    this.cars = [];
    this.mirrorsOff();
    this.player = null;
    this.session = null;
    this.world = null;
    this.drivers = [];
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
    // a human drives with the aids of their seat (player 1's, or player 2's in a split screen); the opponents have fixed ones
    vehicle.assists = entrant.isPlayer
      ? carAssists(assistsOfSeat(this.settings, entrant.seat ?? 0))
      : { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
    const g = world.track.grid[Math.min(slot, world.track.grid.length - 1)];
    if (slot < world.track.grid.length) vehicle.placeOnGround(g.position, g.quaternion, 0);
    else this.placeOnTrack(vehicle, g.s - 8 * (slot - world.track.grid.length + 1), g.d);
    vehicle.setTemperatures(0.8);
    const visual = await createCarVisual(def, livery, this.settings.graphics.quality);
    visual.setPlayer(entrant.isPlayer);
    this.render.scene.add(visual.root);
    visual.update(vehicle.state, 0, this.render.env);
    // crash damage: the mode from the settings, every event into the replay's timeline, and the other car's paint in a contact
    const dmg = visual.damage;
    if (dmg) {
      const index = this.cars.length;
      dmg.setMode(this.settings.damage);
      dmg.onEvent = (e) => this.replayRec?.addDamage(index, e);
      dmg.otherAt = (x, y, z) => this.contactOther(vehicle.id, x, y, z);
    }
    const sound = withSound ? this.audio.createCarSound(def.sound, entrant.isPlayer, entrant.seat ?? 0) : null;
    this.effects?.registerCar(vehicle.id, def, visual.damage);
    const driver = ai ? new AIDriver(world.track, def, { difficulty: ai, seed: aiSeed ?? vehicle.id * 17 + slot, wetness: world.wetness }) : null;
    // a race whose weather changes: the racing line of the other weather is made now, behind the loading screen, not when it turns
    if (this.wx?.plan) driver?.prepareWeather();
    const car: RaceCar = {
      entrant: { ...entrant, id: vehicle.id, state: vehicle.state },
      def,
      vehicle,
      visual,
      sound,
      // a championship driver keeps the same seed (and so the same pace and mistakes) for the whole season
      ai: driver,
      livery,
      driverId,
      mech: new MechLink(driver ? [vehicle, driver] : [vehicle]),
      nitro: new NitroTank(),
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
    this.endSplit();
    this.wx = null;
    armWeather(this.audio, false);
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
    this.ui.setLoading(0.99, 'Warming up');
    if (!(await this.warmUp(this.cars[0], token))) return;
    this.ui.setHudVisible(false);
    this.phase = 'menu';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Showroom preview (car select)
  // ───────────────────────────────────────────────────────────────────────────

  private async showPreview(carId: string, liveryOver?: Partial<Livery>): Promise<void> {
    if (!this.track) return;
    const def = getCar(carId);
    const livery: Livery = { ...def.defaultLivery, ...liveryOver, driver: liveryOver?.driver || this.settings.playerName };
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
    const car: RaceCar = { entrant: { id: vehicle.id, name: '', color: livery.primary, carId, isPlayer: true, state: vehicle.state }, def, vehicle, visual, sound: null, ai: null, livery, mech: new MechLink([vehicle]), nitro: new NitroTank() };
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
    this.config = config;
    // two humans on one screen: races and free roam only (a time trial and a championship are for one)
    const splitRace = !!config.player2 && config.mode !== 'timeTrial' && !config.championship;
    this.endSplit();
    if (!splitRace) this.input.unbindPlayers();
    this.input.menuOwner = null;
    // (a split race started from the address with nobody joined: A on a second pad, or Enter, gives player 2 a device)
    if (splitRace && !this.input.split) this.input.beginJoin();
    this.ui.setRaceConfig(config);
    this.ui.show('loading');
    this.ui.setLoading(0.05, getTrackName(config.trackId));
    this.audio.setMusic(false);
    // the race music is built behind the loading screen, silently, and starts when the race does (a restart: it is playing already)
    primeAlbum(this.audio);
    // weather that changes: its plan is fixed by the config (so a restart repeats it); the renderer gets both ends of it to
    // solve and fit before the track is built
    const plan = this.weatherPlan(config);
    this.wx = plan ? new WeatherDirector(plan, Math.max(0.1, +(this.params.get('wxspeed') ?? 1) || 1), TRACKS.find((t) => t.info.id === config.trackId)?.info.winter === true) : null;
    armWeather(this.audio, plan !== null);
    this.wxNotice = null;
    this.wxLog.reset();
    if (!(await this.ensureTrack(config.trackId, config.environment, token, plan?.to ?? null))) return;
    this.clearCars();
    const track = this.track!;
    this.world = new PhysicsWorld(track);
    // rain: water on the track for the tires and the AI, the rain bed and wet tires for the audio
    this.world.wetness = this.render.env.wetness;
    this.audio.setWeather(this.render.env.rain, this.render.env.wetness, track.info.winter === true);
    this.wxStartWet = this.world.wetness;
    this.wxSent.rain = this.wxSent.wetness = this.wxSent.darkness = -1;
    const def = getCar(config.carId);
    // a championship round brings its own grid: who starts where, with the season's liveries
    const champ = config.mode === 'race' ? config.championship : undefined;
    const humans = splitRace ? 2 : 1;
    const opponents = champ ? Math.max(0, Math.min(11, champ.grid.length - 1)) : config.mode === 'race' ? Math.max(0, Math.min(opponentLimit(humans), config.opponents)) : 0;
    const total = opponents + humans;
    // the second human's car (the opponents drive one car or the other, alternately, so both are on the grid)
    const def2 = splitRace ? getCar(config.player2!.carId) : def;
    // where the humans start: one place, or the two places of one row
    const [playerSlot, playerSlot2] = splitRace
      ? playerSlots(total, config.mode === 'race' ? config.startPosition : 'pole')
      : [champ
          ? Math.max(0, champ.grid.findIndex((g) => g.isPlayer))
          : config.mode !== 'race' ? 0 : config.startPosition === 'pole' ? 0 : config.startPosition === 'back' ? total - 1 : Math.floor(total / 2), -1];
    const playerLivery: Livery = { ...def.defaultLivery, ...config.livery, driver: this.settings.playerName || 'You' };
    const playerLivery2: Livery = { ...def2.defaultLivery, ...config.player2?.livery, driver: config.player2?.livery?.driver || this.settings.player2Name || 'Player 2' };
    this.hudChampionship = champ ? { name: champ.name, round: champ.round, rounds: champ.rounds } : null;
    let slot = 0;
    let aiIndex = 0;
    let car2: RaceCar | null = null;
    for (let i = 0; i < total; i++) {
      if (token !== this.loadToken) return;
      this.ui.setLoading(0.78 + (0.2 * i) / total, 'Preparing the grid');
      if (i === playerSlot) {
        this.player = await this.spawnCar(def, playerLivery, { name: playerLivery.driver, color: SEAT_COLOR[0], carId: def.id, isPlayer: true, ...(splitRace ? { seat: 0 as Seat } : {}) }, slot++, true, null, undefined, champ?.grid[i]?.id);
      } else if (i === playerSlot2) {
        car2 = await this.spawnCar(def2, playerLivery2, { name: playerLivery2.driver, color: SEAT_COLOR[1], carId: def2.id, isPlayer: true, seat: 1 }, slot++, true, null);
      } else if (champ && champ.grid[i]) {
        const g = champ.grid[i];
        const livery: Livery = g.livery ? { ...g.livery, driver: g.name } : opponentLivery(aiIndex, def, playerLivery);
        await this.spawnCar(def, livery, { name: livery.driver, color: livery.primary, carId: def.id, isPlayer: false }, slot++, true, config.difficulty, g.seed, g.id);
        aiIndex++;
      } else {
        // (the humans' liveries are avoided, and so are their cars' by alternating)
        const aiDef = splitRace && aiIndex % 2 === 1 ? def2 : def;
        const livery = opponentLivery(aiIndex, aiDef, splitRace ? [playerLivery, playerLivery2] : playerLivery);
        await this.spawnCar(aiDef, livery, { name: livery.driver, color: livery.primary, carId: aiDef.id, isPlayer: false }, slot++, true, config.difficulty);
        aiIndex++;
      }
    }
    if (token !== this.loadToken) return;
    if (config.mode !== 'race') {
      // time trial / free roam: a rolling start 250 m before the line, at a speed the car can carry through what lies
      // ahead (Kuroyama and Brennwald have a tight bend there, not a straight): what a fast driver aims for, with a margin
      const s0 = track.length - 250;
      const guide = new AIDriver(track, def, { difficulty: 'alien', seed: 1, wetness: this.world.wetness });
      let v = 25;
      for (let ds = 0; ds <= 120; ds += 10) v = Math.min(v, 0.8 * guide.targetSpeed(track.wrapS(s0 + ds)));
      // (two humans roll out side by side)
      this.placeOnTrack(this.player!.vehicle, s0, splitRace ? 1.9 : 0, v);
      this.player!.vehicle.setTemperatures(1);
      if (car2) {
        this.placeOnTrack(car2.vehicle, s0, -1.9, v);
        car2.vehicle.setTemperatures(1);
      }
    }
    // each human's own record (their car on this track), for the personal bests
    const stored = this.bestLaps[recordKey(this.recordTrack(config), config.carId)] ?? null;
    const stored2 = car2 ? this.bestLaps[recordKey(this.recordTrack(config), car2.def.id)] ?? null : null;
    this.session = new RaceSession(track, config, this.cars.map((c) => c.entrant), car2 ? [stored, stored2] : stored, Math.random());
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
    // the humans at the wheel, each with a camera and the rest of what is theirs alone
    const wet = this.world.wetness;
    const driver = (seat: Seat, car: RaceCar, rig: CameraRig): Driver => {
      // the driving guide of this human's car (the AI's racing line and speeds for it), the braking assist that follows it, the line drawn from it
      const aids = new DriverAids(track, car.def, { wetness: wet, weatherMayChange: !!this.wx?.plan });
      aids.setAssists(assistsOfSeat(this.settings, seat));
      car.mech.add(aids, car.visual.damage?.state.mech);
      const line = createDrivingLine(track, aids.guide, seat);
      line.setMode(aids.line);
      this.render.scene.add(line.mesh);
      rig.camera.layers.enable(LINE_LAYERS[seat]);
      return {
        seat,
        car,
        rig,
        steering: new SteeringFilter(),
        autopilot: null,
        banner: null,
        toast: null,
        hudVisible: true,
        spotter: makeSpotter(),
        spotOut: { left: 0, right: 0, leftAt: 0, rightAt: 0 },
        lapWet: wet,
        impactSeen: 0,
        finished: false,
        ghostRec: new GhostRecorder(),
        pb: false,
        aids,
        line,
      };
    };
    this.drivers = [driver(0, this.player!, this.camera)];
    if (car2) {
      this.rig2 ??= createCameraRig(track, this.trackScene!.tvCameras);
      this.rig2.setShake(this.settings.camera.shake);
      this.drivers.push(driver(1, car2, this.rig2));
    }
    if (this.params.get('autopilot') === '1') {
      for (const d of this.drivers) {
        d.autopilot = new AIDriver(track, d.car.def, { difficulty: 'alien', seed: 99 + d.seat, wetness: this.world.wetness });
        if (this.wx?.plan) d.autopilot.prepareWeather();
        // (it drives this human's car: it learns of that car's damage too)
        d.car.mech.add(d.autopilot, d.car.visual.damage?.state.mech);
      }
    }

    this.replay = null;
    this.replayRec = new ReplayRecorder(this.cars.length, this.world.time);
    const cam = (this.params.get('cam') as CameraMode) || this.settings.camera.defaultMode;
    const cam2 = (this.params.get('cam2') as CameraMode) || cam;
    this.drivers.forEach((d, i) => {
      d.rig.setMode(i === 0 ? cam : cam2);
      d.rig.snap();
    });
    this.ui.setMinimap(this.minimapFor(config.trackId));
    // two humans: the screen is cut in two now, so that the shaders and buffers prepared are the split's
    if (car2) this.beginSplit(this.settings.split.layout);
    // compile every shader the grid needs behind the loading screen, not in the first frames of the countdown
    this.ui.setLoading(0.99, 'Warming up');
    if (!(await this.warmUp(this.player!, token))) return;
    this.ui.setSplit(this.splitLayout);
    this.ui.show('none');
    this.ui.setHudVisible(this.hudVisible);
    this.phase = 'race';
    setDriving(this.audio, true);
    this.racePadId = null;
    // switched away while it loaded: the countdown waits behind the pause menu, as it would for an alt-tab mid-race
    if (document.hidden || !document.hasFocus()) this.setPaused(true);
  }

  /**
   * Builds every shader program the first frames will need while the loading screen is still up: the scene's through
   * precompile, then one hidden frame looking at `focus` for the rest (shadow-map depth and post-processing programs).
   * A moment's freeze here instead of in the first second on screen. False when a newer load took over.
   */
  private async warmUp(focus: RaceCar, token: number): Promise<boolean> {
    const xr = this.render as XenoRenderSystem;
    if (this.splitLayout && this.drivers.length > 1) return this.warmUpSplit(xr, token);
    // the player's mirror glass gets its shader before the scene is compiled, so the cockpit's first frame builds nothing
    xr.setMirrors({ mode: 'off', rig: focus.visual.mirrors ?? null, hud: false });
    await xr.precompile();
    if (token !== this.loadToken) return false;
    const st = focus.vehicle.state;
    for (const car of this.cars) car.visual.update(car.vehicle.state, 1 / 60, this.render.env);
    this.camera.update(1 / 60, { state: st, anchors: focus.visual.anchors }, { x: 0, y: 0, back: false });
    this.render.setFocus(st.position);
    this.trackScene?.update(1 / 60, this.camera.camera);
    xr.renderNow(this.camera.camera, 1 / 60, 0);
    primeCarVoices(this.audio);
    this.camera.snap();
    return true;
  }

  /**
   * warmUp() for a split screen: the same shaders, built for the number of lights its views have (the beams of one car at a time),
   * and one hidden frame through both views, which makes the second view's shadow maps too.
   */
  private async warmUpSplit(xr: XenoRenderSystem, token: number): Promise<boolean> {
    // (no mirrors in a split screen)
    xr.setMirrors({ mode: 'off', rig: null, hud: false });
    this.driveViewCars(0);
    await xr.precompile();
    if (token !== this.loadToken) return false;
    for (const car of this.cars) car.visual.update(car.vehicle.state, 1 / 60, this.render.env);
    for (const d of this.drivers) d.rig.update(1 / 60, { state: d.car.vehicle.state, anchors: d.car.visual.anchors }, { x: 0, y: 0, back: false });
    this.viewDt = 1 / 60;
    xr.renderViewsNow(1 / 60, this.viewsOfDrivers(), this.prepareViewFn);
    primeCarVoices(this.audio);
    for (const d of this.drivers) d.rig.snap();
    return true;
  }

  /** The views of this frame, one per human: the camera, the car it films, its speed and whether the driver sits inside. */
  private viewsOfDrivers(): ViewSpec[] {
    const specs = this.viewSpecs;
    const drivers = this.drivers;
    for (let i = 0; i < drivers.length; i++) {
      const d = drivers[i];
      const spec = (specs[i] ??= { camera: d.rig.camera, focus: d.car.vehicle.state.position, speed: 0, cockpit: false });
      spec.camera = d.rig.camera;
      spec.focus = d.car.vehicle.state.position;
      spec.speed = d.car.vehicle.state.speed;
      spec.cockpit = d.rig.mode === 'cockpit';
    }
    specs.length = drivers.length;
    return specs;
  }

  /**
   * Which car shows its interior and its real headlight beams in the view of seat `i`: that view's driver only. In the other view the
   * same car is seen from outside, with the glow on the road an opponent has, so the scene always has the same number of lights.
   */
  private driveViewCars(i: number): void {
    for (const d of this.drivers) {
      d.car.visual.setCockpitView(d.seat === i && d.rig.mode === 'cockpit');
      d.car.visual.setBeams?.(d.seat === i);
    }
  }

  /** Just before view `i` is drawn: everything that depends on the camera is pointed at it. */
  private prepareView(i: number): void {
    const d = this.drivers[i];
    if (!d) return;
    this.driveViewCars(i);
    // (the second view's step is 0: the clocks of the track have moved already)
    this.trackScene?.update(i === 0 ? this.viewDt : 0, d.rig.camera);
    if (i > 0) this.effects?.view?.(d.rig.camera);
  }

  /**
   * Records and ghosts are kept apart for wet sessions (a wet lap can't chase a dry one). `wetness` is the water on the track:
   * now, or the most there was during the lap in question. In a race whose weather changes a lap is wet when the road was wet
   * at any point of it, more than a trace of damp.
   */
  private recordTrack(cfg: RaceConfig, wetness = this.world ? this.world.wetness : 0): string {
    const wet = this.wx?.plan ? wetness >= WET_RECORD : wetness > 0;
    return wet ? `${cfg.trackId}~wet` : cfg.trackId;
  }

  /** The plan of the weather of this race (null when it stays as set), with the development flags applied. */
  private weatherPlan(config: RaceConfig): WeatherPlan | null {
    const plan = makePlan({ forecast: config.forecast, weather: config.environment.weather, mode: config.mode, laps: config.laps, seed: config.forecastSeed });
    // development: ?wxat=<seconds> brings the call in at that second of the race
    const at = this.params.get('wxat');
    return plan && at !== null && Number.isFinite(+at) ? { ...plan, at: { seconds: +at } } : plan;
  }

  private async makeGhost(lap: GhostLap, def: CarDefinition, livery: Livery): Promise<void> {
    const visual = await createCarVisual(def, { ...livery, primary: '#9fe9ff', secondary: '#9fe9ff', accent: '#ffffff' }, 'low');
    visual.damage?.setMode('off'); // the ghost is a see-through lap, not a car that races
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

  /** The car nearest a contact point, other than `selfId`: its paint and velocity, for what a car-to-car hit leaves on the other one. */
  private contactOther(selfId: number, x: number, y: number, z: number): ContactOther | undefined {
    let best = 16; // squared metres: a contact is within a few metres of the car it touched
    let found: RaceCar | undefined;
    for (const c of this.cars) {
      if (c.vehicle.id === selfId) continue;
      const p = c.vehicle.state.position;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2;
      if (d < best) {
        best = d;
        found = c;
      }
    }
    if (!found) return undefined;
    const v = found.vehicle.state.velocity;
    return { paint: parseInt(found.livery.primary.slice(1), 16), vx: v.x, vy: v.y, vz: v.z };
  }

  private resetCar(c: RaceCar): void {
    const tr = this.world!.track;
    const tp = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
    tr.project(c.vehicle.p.x, c.vehicle.p.z, tp);
    const d = Math.max(-tp.widthRight + 1.5, Math.min(tp.widthLeft - 1.5, tp.d));
    this.placeOnTrack(c.vehicle, tp.s - 4, d, 0);
    c.ai?.onReset();
    c.nitro.cancel();
    c.vehicle.nitro = 0;
    const drv = this.drivers.find((x) => x.car === c);
    if (drv) {
      drv.steering.reset();
      drv.rig.snap();
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
        // the way back to the menus: the race music fades out as the menu theme comes in
        setDriving(this.audio, false);
        this.audio.setMusic(true);
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
      case 'split':
        this.onSplitIntent(i.action);
        break;
      case 'nextTrack':
        skipTrack(this.audio);
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
    const damageChanged = this.settings.damage !== s.damage;
    this.settings = structuredClone(s);
    saveSettings(this.settings);
    this.render.applyGraphics(s.graphics);
    this.audio.setVolumes(s.audio);
    this.input.setControls(s.controls);
    for (const c of this.cars) c.visual.damage?.setMode(s.damage);
    this.syncMechanical();
    // (changed from the pause menu, where the HUD is not drawn: its last state is what the pause screen shows of the damage)
    if (damageChanged && this.phase === 'race' && this.session && this.player && !this.replay && !this.resultsShown) {
      const now = performance.now();
      for (const d of this.drivers) this.ui.updateHud(this.buildHud(now, d), d.seat);
    }
    // each human's aids, live (from the pause menu too): the car's own, the braking assist and the line
    for (const d of this.drivers) {
      const set = assistsOfSeat(s, d.seat);
      d.car.vehicle.assists = carAssists(set);
      d.aids.setAssists(set);
      d.line.setMode(set.line);
    }
    this.camera?.setFov(s.camera.fov);
    this.camera?.setShake(s.camera.shake);
    this.rig2?.setShake(s.camera.shake);
    // the layout of a split screen can change in the middle of a race: the buffers take the new size, nothing new is compiled
    if (this.splitLayout && s.split.layout !== this.splitLayout) {
      this.splitLayout = s.split.layout;
      (this.render as XenoRenderSystem).setSplit(this.splitLayout);
      this.ui.setSplit(this.splitLayout);
    }
    if (this.splitLayout) this.applyLens();
    this.showTelemetry = s.hud.telemetry;
    this.applyMaxFps();
    if (renamed && this.championship) this.syncChampionship();
    void prevQuality;
  }

  /**
   * `owner`: the seat whose pad paused a split-screen race (its menu follows that pad); `missing`: the seat whose controller was
   * unplugged (the menu says so).
   */
  private setPaused(p: boolean, owner: Seat | null = null, missing: Seat | null = null): void {
    if (this.phase !== 'race') return;
    this.paused = p;
    if (this.world) this.world.paused = p;
    this.audio.setPaused(p);
    this.input.menuOwner = p ? owner : null;
    this.pausedMissing = p ? missing : null;
    this.pushPlayers();
    this.ui.show(p ? 'pause' : 'none');
    this.ui.setHudVisible(!p && this.hudVisible);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Two players: who plays on what
  // ───────────────────────────────────────────────────────────────────────────

  /** The seat whose controller is unplugged while the race waits behind the pause menu. */
  private pausedMissing: Seat | null = null;
  private lastPadCount = -1;

  /** The join step of the split-screen setup (UIIntent 'split'). */
  private onSplitIntent(action: 'join' | 'cancel' | 'swap' | 'unbind'): void {
    const input = this.input;
    if (action === 'join') {
      // (a binding left from the last split race stands if both its devices are still there; else the second player joins again)
      if (input.split && input.missingSeat() !== null) input.unbindPlayers();
      if (!input.split) input.beginJoin();
    } else if (action === 'cancel') input.endJoin();
    else if (action === 'swap') input.swapPlayers();
    else {
      input.endJoin();
      input.unbindPlayers();
    }
    this.pushPlayers();
  }

  /**
   * Every frame: a second player who asks to join gets the seat, and a change in the controllers connected reaches the join card.
   * True when someone joined this frame: the press that did it (the keyboard's Enter is a menu press too) is theirs alone, the
   * menus must not take it as a confirmation of whatever comes next.
   */
  private pollJoin(): boolean {
    const input = this.input;
    let joined = false;
    if (input.joining) {
      const joiner = input.takeJoiner();
      if (joiner) {
        input.bindPlayers(input.primarySource(), joiner);
        this.pushPlayers();
        joined = true;
      }
    }
    if (input.padCount !== this.lastPadCount) {
      this.lastPadCount = input.padCount;
      this.pushPlayers();
    }
    return joined;
  }

  /** Tell the UI who plays on what. */
  private pushPlayers(): void {
    const input = this.input;
    const [a, b] = input.sources;
    const info: PlayersInfo = {
      devices: [input.deviceName(a ?? input.primarySource()), input.deviceName(b)],
      pads: input.padCount,
      joined: input.split,
      owner: input.menuOwner,
      missing: this.pausedMissing,
    };
    this.ui?.setPlayers(info);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Frame loop
  // ───────────────────────────────────────────────────────────────────────────

  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
    const tick = now - this.lastTick;
    this.lastTick = now;
    if (tick > 0 && tick < 100) this.tickMs += (tick - this.tickMs) * 0.05;
    if (this.minFrameMs > 0) {
      // a frame is drawn on the refresh nearest each slot of the capped rate, and the slots advance by the cap's interval:
      // on a 144 Hz screen a 60 cap draws on every second or third refresh and averages 60 (waiting a whole interval after
      // each frame instead fell to about 47)
      if (now < this.nextFrameAt - this.tickMs / 2) return;
      this.nextFrameAt = now - this.nextFrameAt > this.minFrameMs ? now + this.minFrameMs : this.nextFrameAt + this.minFrameMs;
    }
    const dt = Math.min(0.05, Math.max(0.0005, (now - this.last) / 1000));
    this.last = now;
    this.fpsAvg += (1 / dt - this.fpsAvg) * 0.05;
    this.frameCount++;

    const cpu0 = performance.now();
    const input = this.input.poll(dt);
    if (input.anyPressed) void this.audio.unlock();
    this.ui.setSoundLocked(!this.audio.unlocked);
    if (this.pollJoin()) input.nav.confirm = false;
    this.ui.setDevice(input.device === 'gamepad' ? input.gamepadId : null);

    if (this.phase === 'race') this.updateRace(dt, input, now);
    else if (this.phase === 'menu' || this.phase === 'results') {
      this.ui.handleInput(input);
      this.updateAttract(dt);
    } else if (this.phase === 'loading') {
      // keep the last scene alive behind the loading screen (not once a split screen is being made ready: the views are its own)
      if (this.world && this.camera && !this.splitLayout) this.updateAttract(dt);
    }
    if (this.phase !== 'race') this.mirrorsOff();
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
    if (this.splitLayout) return;
    this.trackScene?.update(dt, this.camera.camera);
    _v.set(0, 0, 0);
    this.audio.setListener(this.camera.camera, _v);
    this.render.render(this.camera.camera, dt, speed);
  }

  /** The controller frame of a driver: their own pad's in a split screen, the merged one of a single player. */
  private frameOf(d: Driver, merged: InputFrame): InputFrame {
    return this.drivers.length > 1 && this.input.split ? this.input.players[d.seat] : merged;
  }

  /** The driver a session entrant is (undefined for an opponent). */
  private driverOf(entrant: Entrant): Driver | undefined {
    return this.drivers.find((d) => d.car.entrant.id === entrant.id);
  }

  private updateRace(dt: number, input: InputFrame, now: number): void {
    const world = this.world!;
    const session = this.session!;
    const drivers = this.drivers;
    const split = drivers.length > 1;
    const player = this.player!;
    const pv = player.vehicle;

    if (this.replay) {
      this.updateReplay(dt, input);
      return;
    }

    // a pad was unplugged mid-race: wait behind the pause menu (it says why, and whose) instead of coasting on with no input
    if (split && this.input.split) {
      const miss = this.input.missingSeat();
      if (miss !== null && !this.paused && !this.resultsShown) this.setPaused(true, null, miss);
    } else if (input.gamepadId !== this.racePadId) {
      if (this.racePadId && !input.gamepadId && !this.paused && !this.resultsShown) this.setPaused(true);
      this.racePadId = input.gamepadId;
    }
    // pause / menus (once the flag has fallen, Start and Esc belong to the results and standings screens). Start only
    // pauses here: while paused it belongs to the screen on show, which resumes from the pause menu but accepts a
    // name or steps back in the settings
    if (input.pause && !this.resultsShown && !this.paused) {
      // either player's Start pauses the race for both, and the menu follows the device that paused (a keyboard that is not one of the
      // two players' is anyone's; the keyboard of a seat is that seat's, and it navigates the menu whoever owns it)
      const owner: Seat | null = split && this.input.split ? (this.input.players[0].pause ? 0 : this.input.players[1].pause ? 1 : null) : null;
      this.setPaused(true, owner);
      this.audio.ui('select');
    }
    // (the press that closes the pause menu, B or Esc, must not also fire a nitro shot as the race goes on in this same frame)
    const wasPaused = this.paused;
    if (this.paused || this.resultsShown) {
      this.ui.handleInput(input);
      if (this.paused) {
        // the controller that was unplugged is back: the menu stops saying so
        if (this.pausedMissing !== null && this.input.missingSeat() === null) {
          this.pausedMissing = null;
          this.pushPlayers();
        }
        this.driveMirrors(false);
        if (this.splitLayout) this.drawSplit(0);
        else this.drawWorld(0, 0);
        return;
      }
    }

    // global race controls: each human's own camera, HUD and reset
    if (!this.resultsShown) {
      // (the race music: D-pad right or N, either player's in a split screen)
      if (input.nextTrack) skipTrack(this.audio);
      for (const d of drivers) {
        const f = this.frameOf(d, input);
        if (f.cameraNext) d.rig.next();
        if (f.toggleHud) {
          if (split) d.hudVisible = !d.hudVisible;
          else {
            this.hudVisible = !this.hudVisible;
            this.ui.setHudVisible(this.hudVisible);
          }
        }
        if (f.toggleTelemetry && !split) this.showTelemetry = !this.showTelemetry;
        if (f.resetCar && session.phase === 'racing') this.resetCar(d.car);
      }
    }

    // the weather: its state to the physics, the AI, the sound and the picture (nothing to do in a race that stays as set)
    this.updateWeather(dt, now);

    // player controls
    for (const d of drivers) {
      const f = this.frameOf(d, input);
      const dv = d.car.vehicle;
      const c = dv.controls;
      if (d.autopilot) {
        d.autopilot.nitroOn = d.car.nitro.active;
        d.autopilot.update(dt, dv.state, world.states, c, session.phase === 'racing');
        if (d.autopilot.needsReset) {
          this.resetCar(d.car);
          d.autopilot.onReset();
        }
      } else if (!this.resultsShown) {
        // (the car as it is fitted for the track: on a winter circuit, with its studded tyres)
        c.steer = d.steering.update(f.steer, dt, dv.state, dv.def, this.settings.controls);
        c.throttle = f.throttle;
        c.brake = f.brake;
        c.handbrake = f.handbrake;
        c.clutch = f.clutch;
        if (f.shiftUp) c.shift = 1;
        else if (f.shiftDown) c.shift = -1;
      } else {
        // after the flag the car coasts to a stop
        c.steer = 0;
        c.throttle = 0;
        c.brake = 0.3;
      }
      if (d.car.entrant.state.forwardSpeed < -0.5 && c.throttle > 0.1) c.handbrake = 0;
      // nitro: E or B, while racing (a dev autopilot's driver presses it too)
      if (f.nitro && !wasPaused && !this.resultsShown && session.phase === 'racing' && !d.finished) d.car.nitro.fire();
    }

    // the driving guide follows the road and the water, and the braking assist adds to the pedals the pad has just set (a dev autopilot
    // has its own pedals: the assist leaves them alone)
    const live = session.phase === 'racing' && !this.resultsShown;
    for (const d of drivers) d.aids.update(dt, d.car.vehicle.state, d.car.vehicle.controls, live && !d.autopilot, world.wetness);

    // AI
    const racing = session.phase === 'racing' || session.phase === 'finished';
    for (const car of this.cars) {
      if (!car.ai) continue;
      car.ai.nitroReady = car.nitro.ready;
      car.ai.nitroOn = car.nitro.active;
      car.ai.update(dt, car.vehicle.state, world.states, car.vehicle.controls, racing);
      if (car.ai.wantNitro) car.nitro.fire();
      if (car.ai.needsReset) this.resetCar(car);
    }

    // nitro: each tank follows its car's laps (a new lap fills it) and burns its shot; a car that has finished has none, and with nitro
    // off in the settings no car has any (a tank that is not running is never ready: a press, or an AI driver, fires nothing)
    const prog = session.progress;
    const nitroOn = this.settings.nitro;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const p = prog[i];
      car.nitro.update(dt, p ? p.crossings : 0, nitroOn && racing && !(p && p.finished) && !this.resultsShown);
      car.vehicle.nitro = car.nitro.level;
    }

    world.step(dt);
    session.update(dt, world.time);
    this.handleSessionEvents(now);
    if (this.replayRec && session.phase !== 'countdown') this.replayRec.capture(world.time - this.replayRec.t0, world.states);

    // ghost recording / playback (a lap against your own best: one player; in a split screen each human's lap is recorded, to be saved
    // with the record it sets, but no ghost is shown)
    const pp = session.player;
    if (split && session.phase === 'racing') {
      for (const d of drivers) {
        const ph = session.playerAt(d.seat);
        if (ph && ph.crossings >= 1) d.ghostRec.sample(world.time - ph.lapStart, d.car.vehicle.state.position, d.car.vehicle.state.quaternion);
      }
    }
    if (!split && pp && session.phase === 'racing' && pp.crossings >= 1) {
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
    for (const car of this.cars) {
      car.visual.update(car.vehicle.state, dt, this.render.env);
      car.sound?.update(car.vehicle.state, dt);
    }
    for (const d of drivers) {
      const m = d.rig.mode;
      d.car.sound?.setInterior(m === 'cockpit' || m === 'hood' || m === 'bumper');
    }

    // (the visuals just took this frame's hits: what they did to the mechanics goes on the physics before the next step)
    this.syncMechanical();
    if (split && this.splitLayout) this.drawRaceSplit(dt, input);
    else this.drawRaceWhole(dt, input);

    // rumble on impacts and kerbs
    for (const d of drivers) this.rumble(d);

    // HUD
    if (split) {
      if (!this.resultsShown) for (const d of drivers) this.ui.updateHud(this.buildHud(now, d), d.seat);
    } else if (this.hudVisible && !this.resultsShown) this.ui.updateHud(this.buildHud(now, drivers[0]));

    // results
    if (this.finishAt !== null && !this.resultsShown && (now > this.finishAt || session.phase === 'finished')) this.showResults();
  }

  /** One view over the whole screen (a single player; also what a split screen shows behind its results). */
  private drawRaceWhole(dt: number, input: InputFrame): void {
    const session = this.session!;
    const player = this.player!;
    const pv = player.vehicle;
    const xr = this.render as XenoRenderSystem;
    player.visual.setCockpitView(this.camera.mode === 'cockpit');
    xr.setCockpitView(this.camera.mode === 'cockpit');
    this.effects?.update(dt, this.world!.states, this.camera.camera);
    this.camera.update(dt, { state: pv.state, anchors: player.visual.anchors }, { x: input.lookX, y: input.lookY, back: input.lookBack });
    this.render.setFocus(pv.state.position);
    this.trackScene?.update(dt, this.camera.camera);
    this.trackScene?.setStartLights(session.phase === 'countdown' ? session.lights : session.phase === 'racing' && this.world!.time - session.startTime < 3 ? 6 : null);
    this.audio.setListener(this.camera.camera, pv.state.velocity);
    this.updateSpotter(this.drivers[0], dt, input.lookBack);
    this.driveMirrors(input.lookBack);
    this.paintLines();
    this.render.render(this.camera.camera, dt, pv.state.speed);
    // the cockpit wiper: its swish and thunks follow the windscreen pass's own clock, so they land on the blade you see
    setWiper(this.audio, xr.wiper);
  }

  /** Two views, one for each human, each through the whole post chain into its half of the screen. */
  private drawRaceSplit(dt: number, input: InputFrame): void {
    const session = this.session!;
    const xr = this.render as XenoRenderSystem;
    const world = this.world!;
    for (const d of this.drivers) {
      const f = this.frameOf(d, input);
      d.rig.update(dt, { state: d.car.vehicle.state, anchors: d.car.visual.anchors }, { x: f.lookX, y: f.lookY, back: f.lookBack });
      this.updateSpotter(d, dt, f.lookBack);
      this.audio.setListener(d.rig.camera, d.car.vehicle.state.velocity, d.seat);
    }
    this.effects?.update(dt, world.states, this.drivers[0].rig.camera);
    this.trackScene?.setStartLights(session.phase === 'countdown' ? session.lights : session.phase === 'racing' && world.time - session.startTime < 3 ? 6 : null);
    this.mirrorsOff();
    this.paintLines();
    this.drawSplit(dt);
    // the cockpit wiper of whichever view shows its blade (player 1's first)
    const w0 = xr.wiperOf(0);
    setWiper(this.audio, w0.drawn ? w0 : xr.wiperOf(1));
  }

  /**
   * The driving line of each human: drawn in the cameras that look along the road (not the TV, the orbit view, the replay, the photo
   * mode that takes the HUD away, or the results behind the menus), in the race that is on, and rewritten for where the car is now. In a
   * split screen every view has its own: the line of a seat is on a camera layer only that seat's camera has.
   */
  private paintLines(): void {
    const exposure = (this.render as XenoRenderSystem).solution?.exposure ?? 1;
    const live = this.phase === 'race' && !this.resultsShown && !this.replay;
    const split = this.drivers.length > 1;
    for (const d of this.drivers) {
      const on = live && (split ? d.hudVisible : this.hudVisible) && d.aids.line !== 'off' && lineShownIn(d.rig.mode);
      d.line.show(on);
      if (on) d.line.update(d.aids.s, Math.max(0, d.aids.speed), exposure, lineLead(d.rig.mode), lineWidth(d.rig.mode));
    }
  }

  /** Draw the two views of a split screen (the race, or the pause menu's frozen frame). */
  private drawSplit(dt: number): void {
    this.viewDt = dt;
    (this.render as XenoRenderSystem).renderViews(dt, this.viewsOfDrivers(), this.prepareViewFn);
  }

  /**
   * Damage: Full. What the crashes did to each car's mechanics (the CarDamage record of its visual, src/core/mechanical.ts) goes
   * on its physics and its driver, when it changes: bent suspension, lost downforce and a tired engine on the cars that have them to
   * lose (the record knows its car), and an AI that drives the car it has now. Any other mode takes it off again. Every car, the AI's
   * too; the ghost is no car in this list.
   * A restart or the next round builds new cars (repaired), and a reset to the track leaves the car as it is.
   */
  private syncMechanical(): void {
    const full = this.settings.damage === 'full';
    for (const c of this.cars) c.mech.update(c.visual.damage?.state.mech, full);
  }

  /** What a seat's HUD shows of its car's mechanical damage: null when the mode is not Full or nothing is bent enough to show (a few taps are not). */
  private hudDamage(p: RaceCar, seat: Seat): HudDamage | null {
    if (this.settings.damage !== 'full') return null;
    const m = p.visual.damage?.state.mech;
    if (!m || mechanicalWorst(m) < DAMAGE_SHOWN) return null;
    const out = this.dmgHud[seat];
    mechanicalReport(m, out);
    out.style = p.def.visual.style;
    return out;
  }

  /** Rumble on impacts and kerbs, in the pad of the driver they happen to. */
  private rumble(d: Driver): void {
    if (!this.settings.controls.vibration) return;
    const st = d.car.vehicle.state;
    const seat = this.drivers.length > 1 ? d.seat : undefined;
    if (st.impactCount !== d.impactSeen) {
      d.impactSeen = st.impactCount;
      const k = Math.min(1, st.lastImpact.strength / 12);
      this.input.rumble(k, k * 0.6, 120 + 200 * k, seat);
    }
    let curb = 0;
    let slip = 0;
    for (const w of st.wheels) {
      if (w.contact && w.surface === 'curb') curb = Math.max(curb, Math.min(1, st.speed / 30));
      slip = Math.max(slip, w.skid);
    }
    if (curb > 0.05 || slip > 0.3) this.input.rumble(curb * 0.35, Math.max(curb * 0.5, slip * 0.25), 60, seat);
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
        case 'lap': {
          const d = this.driverOf(e.entrant);
          if (!d) break;
          // (a split screen records each human's lap on their own recorder)
          const split = this.drivers.length > 1;
          const rec = split ? d.ghostRec : this.ghostRec;
          const lapLap = rec.finish(e.time);
          rec.reset();
          const cfg = this.config!;
          const carId = d.car.def.id;
          // a lap is dry or wet by the water the road had at any point of it (see recordTrack), and a race whose weather
          // changes compares it with the best of its own kind, not with the one of the weather the race started in
          const key = this.recordTrack(cfg, d.lapWet);
          let pb = e.personalBest;
          if (this.wx?.plan || split) {
            // (two humans may drive the same car: a lap is a record against what is saved now, whoever set it)
            const best = this.bestLaps[recordKey(key, carId)];
            pb = best === undefined || e.time < best;
          }
          d.lapWet = this.world ? this.world.wetness : 0;
          if (pb) {
            d.pb = true;
            this.bestLaps = saveBestLap(key, carId, e.time);
            this.ui.setBestLaps(this.bestLaps);
            if (lapLap) saveGhost(key, carId, lapLap);
            if (lapLap && cfg.mode === 'timeTrial' && this.settings.hud.ghost) {
              if (this.ghost) {
                this.ghost.lap = lapLap;
              } else void this.makeGhost(lapLap, this.player!.def, this.player!.livery);
            }
            this.flashToast(d, `PERSONAL BEST  ${fmtTime(e.time)}`, now);
            this.audio.ui('bestLap');
          } else {
            this.flashToast(d, `${e.best ? 'BEST LAP' : 'LAP'}  ${fmtTime(e.time)}`, now);
            this.audio.ui('lap');
          }
          break;
        }
        case 'finalLap': {
          const d = this.driverOf(e.entrant);
          if (d) this.flashBanner(d, 'FINAL LAP', now, 2500);
          break;
        }
        case 'finish': {
          const d = this.driverOf(e.entrant);
          if (!d) break;
          d.finished = true;
          this.flashBanner(d, e.position === 1 ? 'VICTORY' : `FINISHED  P${e.position}`, now, 5000);
          this.audio.ui('finish');
          // the results come 7 s after the flag for a single player; a split screen waits for the other human to cross the line too
          // (at most 25 s after the first, and 5 s after the last)
          if (this.drivers.length < 2) this.finishAt = now + 7000;
          else this.finishAt = this.drivers.every((x) => x.finished) ? Math.min(this.finishAt ?? Infinity, now + 5000) : this.finishAt ?? now + 25000;
          break;
        }
        case 'sector':
          break;
      }
    }
  }

  private flashBanner(d: Driver, text: string, now: number, ms: number): void {
    d.banner = { text, until: now + ms };
  }
  private flashToast(d: Driver, text: string, now: number): void {
    d.toast = { text, until: now + 4000 };
  }

  private showResults(): void {
    const session = this.session!;
    if (session.phase !== 'finished') session.closeRace();
    const cfg = this.config!;
    // a personal best: the best lap of the session beats the record the race began with. In a split screen, where two humans may drive
    // the same car and so share one record, it is what each one's laps did against the record as it stood at the time (d.pb).
    const isPb = (seat: Seat): boolean => {
      const best = session.playerAt(seat)?.bestLap ?? null;
      const stored = session.storedBestFor(seat);
      return best !== null && (stored === null || best <= stored);
    };
    const res = this.drivers.length > 1 ? session.results([this.drivers[0].pb, this.drivers[1].pb]) : session.results(isPb(0));
    if (cfg.championship) this.scoreChampionshipRound(res);
    this.ui.setResults(res);
    this.ui.setHudVisible(false);
    this.ui.show('results');
    this.resultsShown = true;
    // behind the results the screen is whole again: a TV camera on player 1's car (the lights keep the number they had)
    if (this.splitLayout) {
      this.endSplit();
      this.driveViewCars(0);
    }
    this.camera.setMode('tv');
    this.camera.snap();
    this.audio.setMusic(true);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Weather that changes
  // ───────────────────────────────────────────────────────────────────────────

  /** Run the weather of the race: the leader's progress calls the change, its state goes to everyone who reads it. */
  private updateWeather(dt: number, now: number): void {
    const world = this.world!;
    for (const d of this.drivers) d.lapWet = Math.max(d.lapWet, world.wetness);
    const wx = this.wx;
    if (!wx?.plan) return;
    const session = this.session!;
    const racing = session.phase === 'racing' || session.phase === 'finished';
    let lead = -Infinity;
    for (const p of session.progress) if (p.distance > lead) lead = p.distance;
    const cfg = this.config!;
    const total = cfg.mode === 'race' ? cfg.laps * this.track!.length : Infinity;
    wx.update(dt, racing ? lead / total : -1, racing ? world.time - session.startTime : 0);
    for (const ev of wx.drain()) this.wxNotice = { n: ev.notice, until: now + 9000 };
    this.wxLog.sample(world.time - (this.replayRec?.t0 ?? 0), wx.state);
    this.applyWeather(wx.state, true);
  }

  /**
   * Hand a weather state to everything that reads it: the physics and the AI (the road's grip), the sound, the picture (sky, rain,
   * spray) and the track scene (wet shaders, lamp pools). `live`: a race, not a replay: the cars' physics and drivers are not
   * touched in a replay.
   */
  private applyWeather(s: WeatherState, live: boolean): void {
    if (live && this.world) {
      this.world.wetness = s.wetness;
      this.retuneDrivers(s.wetness);
    }
    this.audio.setWeather(s.rain, s.wetness, this.track?.info.winter === true);
    const xr = this.render as XenoRenderSystem;
    xr.setWeatherState(s);
    // the track scene reads the environment (the wet look, the lamps' pools): tell it once the weather has moved on a little
    const env = xr.env;
    const sent = this.wxSent;
    if (Math.abs(env.wetness - sent.wetness) > 0.004 || Math.abs(env.rain - sent.rain) > 0.004 || Math.abs(env.darkness - sent.darkness) > 0.004) {
      sent.wetness = env.wetness;
      sent.rain = env.rain;
      sent.darkness = env.darkness;
      this.trackScene?.setEnvironment(env);
    }
  }

  /**
   * The drivers learn the road is wetter (or drier): each re-derives its speed profile (a pass over the whole racing line, a couple
   * of ms) and eases into it over a couple of seconds, so one of them a frame and only once the water has moved by a couple of
   * hundredths since the last time it was told.
   */
  private retuneDrivers(wetness: number): void {
    const cars = this.cars;
    const drivers = this.drivers;
    for (let k = 0; k < cars.length + drivers.length; k++) {
      const d = k < cars.length ? cars[k].ai : drivers[k - cars.length].autopilot;
      if (!d || Math.abs(wetness - (this.wxTuned.get(d) ?? this.wxStartWet)) < 0.02) continue;
      this.wxTuned.set(d, wetness);
      d.setWetness(wetness);
      return;
    }
  }

  /** Development: pin the weather of the race at this state (its plan is ignored from now on), e.g. to take pictures of it. */
  holdWeather(s: Partial<WeatherState>): void {
    this.wx?.hold(s);
  }

  private startReplay(): void {
    if (!this.replayRec || this.replayRec.frames < 30 || !this.world) return;
    this.replay = { player: new ReplayPlayer(this.replayRec, this.world.states), t: 0, target: this.cars.indexOf(this.player!) };
    for (const d of this.drivers) d.line.show(false);
    // every car is pristine again at the start, and gets dented as the replay plays
    this.cars.forEach((c, i) => c.visual.damage?.replay(this.replayRec!.damage[i], 0));
    this.effects?.clear();
    this.ui.show('none');
    this.ui.setHudVisible(false);
    this.camera.setMode('tv');
    this.camera.snap();
    this.audio.setMusic(false);
  }

  private stopReplay(): void {
    this.replay = null;
    this.ui.setReplay(null);
    // back to the race's own damage
    for (const c of this.cars) c.visual.damage?.replay(null, 0);
    this.effects?.clear();
    // the weather is the race's own again
    if (this.wx?.plan) this.applyWeather(this.wx.state, false);
    this.ui.show('results');
    this.audio.setMusic(true);
  }

  private updateReplay(dt: number, input: InputFrame): void {
    const r = this.replay!;
    this.mirrorsOff();
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
    // the weather of the race, as it was at this moment of it
    if (this.wx?.plan && this.wxLog.at(r.t, this.wxReplay)) this.applyWeather(this.wxReplay, false);
    const states = r.player.states;
    this.cars.forEach((c, i) => {
      c.visual.damage?.replay(r.player.rec.damage[i], r.player.frame);
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
    const e = target.entrant;
    this.ui.setReplay({
      driver: e.name,
      color: e.color,
      position: this.session?.progress[r.target]?.position ?? r.target + 1,
      camera: CAMERA_LABEL[this.camera.mode],
      t: r.t,
      duration: r.player.rec.duration,
    });
  }

  /** The HUD of one human's view. */
  private buildHud(now: number, d: Driver): HudState {
    const session = this.session!;
    const p = d.car;
    const st = p.vehicle.state;
    const def = p.def;
    const split = this.drivers.length > 1;
    const pp = session.playerAt(d.seat)!;
    const order = session.ordered();
    const leader = order[0];
    const cfg = this.config!;
    // standings: leader + the cars around the player (and, in a split screen, the other human wherever they are)
    const standings: HudStanding[] = [];
    const idx = order.indexOf(pp);
    const other = split ? session.playerAt(d.seat === 0 ? 1 : 0) : undefined;
    const oi = other ? order.indexOf(other) : -1;
    const pick = new Set<number>([0, idx - 1, idx, idx + 1, oi, 1, 2].filter((i) => i >= 0 && i < order.length));
    [...pick].sort((a, b) => a - b).slice(0, split ? 7 : 6).forEach((i) => {
      const e = order[i];
      standings.push({
        position: e.position,
        name: e.entrant.name,
        gap: session.gapString(e, leader),
        isPlayer: e.entrant.isPlayer,
        color: e.entrant.color,
        ...(split && e.entrant.seat !== undefined ? { seat: e.entrant.seat } : {}),
      });
    });
    const up = def.physics.drivetrain.upshiftRpm;
    const shiftLight = Math.max(0, Math.min(1, (st.rpm - (up - 2200)) / 2200));
    const tires = st.wheels.map((w, i) => ({ slip: Math.min(1.25, p.vehicle.slipUsage(i)), tempC: w.tempC, load: w.load / p.vehicle.staticLoad(i) }));
    const cars = this.cars.map((c) => {
      const s = c.vehicle.state;
      _v.set(0, 0, 1).applyQuaternion(s.quaternion);
      return {
        x: s.position.x,
        z: s.position.z,
        heading: Math.atan2(_v.x, _v.z),
        color: c.entrant.color,
        // (both humans are on every map in a split screen, each view draws its own as the player's)
        isPlayer: split ? c.entrant.isPlayer : c === p,
        ...(split && c.entrant.seat !== undefined ? { seat: c.entrant.seat } : {}),
      };
    });
    if (d.banner && now > d.banner.until) d.banner = null;
    if (d.toast && now > d.toast.until) d.toast = null;
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
      bestLap: pp.bestLap ?? session.storedBestFor(d.seat),
      delta: session.liveDelta(d.seat),
      sector: pp.sector,
      sectorDeltas: session.sectorDeltas(d.seat),
      standings: cfg.mode === 'race' && this.settings.hud.standings ? standings : [],
      cars,
      gLat: st.localAccel.x / 9.81,
      gLong: st.localAccel.z / 9.81,
      tires,
      countdown,
      wrongWay: pp.wrongWayTime > 1.5,
      banner: d.banner?.text ?? null,
      toast: d.toast?.text ?? null,
      // (no telemetry overlay in a split screen: it would fill a view)
      showTelemetry: split ? false : this.showTelemetry,
      hudVisible: split ? d.hudVisible : this.hudVisible,
      championship: this.hudChampionship,
      spotter: this.settings.hud.spotter ? d.spotOut : null,
      mirror: split ? false : (this.render as XenoRenderSystem).mirrorStrip,
      weather: this.wx?.plan ? this.hudWeather(now) : null,
      damage: this.hudDamage(p, d.seat),
      brakeAssist: d.aids.added,
      nitro: this.settings.nitro ? { charges: p.nitro.charges, max: NITRO_PER_LAP, burn: p.nitro.left / NITRO_SECONDS } : null,
    };
  }

  /** The conditions chip of a race whose weather changes, and the notice on show. */
  private hudWeather(now: number): HudWeather {
    const h = this.wxHud;
    const wx = this.wx!;
    const s = wx.state;
    h.sky = nearestWeather(wx.plan!, s);
    h.rain = s.rain;
    h.wetness = s.wetness;
    h.track = trackCondition(s.wetness, wx.winter);
    h.winter = wx.winter;
    h.forecast = wx.plan!.forecast;
    h.called = wx.called;
    if (this.wxNotice && now > this.wxNotice.until) this.wxNotice = null;
    h.notice = this.wxNotice ? this.wxNotice.n : null;
    return h;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Proximity spotter and mirrors
  // ───────────────────────────────────────────────────────────────────────────

  /** Every car's footprint for the spotter. The states are the vehicles' own, so the list only changes with the field. */
  private spotBodies(): SpotterBody[] {
    if (this.spotCars !== this.cars || this.spotList.length !== this.cars.length) {
      this.spotCars = this.cars;
      this.spotList = this.cars.map((c) => {
        const st = c.vehicle.state;
        return { position: st.position, quaternion: st.quaternion, velocity: st.velocity, halfLength: c.def.visual.length / 2, halfWidth: c.def.visual.width / 2 };
      });
      this.lampOutputs = this.cars.map((c) => c.visual.damage?.lamps);
    }
    return this.spotList;
  }

  /** Fold the field into the spotter's two sides. It speaks only while the screen's left and right are the car's. */
  private updateSpotter(d: Driver, dt: number, lookBack: boolean): void {
    const session = this.session;
    if (!session) return;
    const bodies = this.spotBodies();
    const me = bodies[this.cars.indexOf(d.car)];
    if (!me) return;
    const mode = d.rig.mode;
    // not in the TV or orbit cameras (the screen's left is anybody's), and not while looking back
    const driversView = mode !== 'tv' && mode !== 'orbit' && !lookBack;
    const on = this.settings.hud.spotter && driversView && session.phase === 'racing' && !this.resultsShown && !this.replay;
    updateSpotter(d.spotter, me, bodies, dt, on);
    const o = d.spotOut;
    o.left = d.spotter.left.level;
    o.right = d.spotter.right.level;
    o.leftAt = d.spotter.left.at;
    o.rightAt = d.spotter.right.at;
  }

  /**
   * Tell the render system what the mirrors do this frame: real glass in the cockpit, the HUD strip in the hood and
   * bumper views (not while looking back, where the camera already faces the road behind), nothing in the others or
   * with the setting off.
   */
  private driveMirrors(lookBack: boolean): void {
    // (a split screen has no mirrors: each view is half a screen, and the glass would have to be drawn for both)
    if (this.drivers.length > 1) {
      this.mirrorsOff();
      return;
    }
    const player = this.player;
    const f = this.mirrorFrame;
    const cam = this.camera.mode;
    f.rig = player?.visual.mirrors ?? null;
    f.mode =
      !player || this.replay || this.resultsShown || this.settings.hud.mirror === 'off' ? 'off' : cam === 'cockpit' ? 'real' : (cam === 'hood' || cam === 'bumper') && !lookBack ? 'virtual' : 'off';
    // the strip is part of the HUD: it goes with the H key, the pause menu and the start sequence
    f.hud = this.hudVisible && !this.paused && this.session?.phase !== 'countdown';
    // the lamps of the cars that face us glare in the glass once it is dark enough for them to be lit
    const lamps = this.mirrorLamps;
    lamps.n = 0;
    if (f.mode !== 'off' && player) {
      const head = Math.min(1, Math.max(0, ((this.render as XenoRenderSystem).env.darkness - 0.25) / 0.35));
      if (head > 0.01) {
        const bodies = this.spotBodies();
        const at = this.cars.indexOf(player);
        if (bodies[at]) collectHeadlamps(lamps, bodies, at, bodies[at].position, head, this.lampOutputs);
      }
    }
    f.lamps = lamps;
    (this.render as XenoRenderSystem).setMirrors(f);
  }

  private mirrorsOff(): void {
    const f = this.mirrorFrame;
    if (f.mode === 'off' && f.rig === null && !f.hud) return;
    f.mode = 'off';
    f.rig = null;
    f.hud = false;
    f.lamps = null;
    (this.render as XenoRenderSystem).setMirrors(f);
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
