/**
 * Public APIs every subsystem must export. The game (src/game, src/main.ts) wires them together.
 * Each module's index.ts must export the factory named here with exactly this signature.
 *
 *   src/track/index.ts   -> TRACKS, loadTrackRuntime(), buildTrackScene()
 *   src/render/index.ts  -> createRenderSystem(), createEffects(), createCameraRig()
 *   src/carvis/index.ts  -> createCarVisual()
 *   src/audio/index.ts   -> createAudioSystem()
 *   src/input/index.ts   -> createInputSystem()
 *   src/ui/index.ts      -> createUI()
 */
import type * as THREE from 'three';
import type { CarDamageControl } from './damage';
import type {
  AudioSettings,
  CameraMode,
  CarDefinition,
  CarMirrors,
  ChampionshipDef,
  ChampionshipView,
  ControlSettings,
  EngineSoundProfile,
  EnvironmentSettings,
  EnvironmentState,
  GraphicsSettings,
  HudState,
  InputFrame,
  Livery,
  MinimapTrack,
  QualityLevel,
  RaceConfig,
  RaceResults,
  Settings,
  TrackInfo,
  TrackRuntime,
  UIIntent,
  UiSound,
  VehicleState,
} from './contracts';

// ── Track ────────────────────────────────────────────────────────────────────

export interface TrackEntry {
  info: TrackInfo;
}
/** src/track/index.ts:
 *    export const TRACKS: TrackEntry[];
 *    export function loadTrackRuntime(id: string): TrackRuntime;           // headless, sync, < 300 ms
 *    export function buildTrackScene(rt: TrackRuntime, opts: TrackSceneOptions): Promise<TrackScene>;
 */
export type LoadTrackRuntime = (id: string) => TrackRuntime;

export interface TrackSceneOptions {
  quality: QualityLevel;
  vegetation: number; // 0..1
  env: EnvironmentState;
  renderer: THREE.WebGLRenderer; // for texture uploads / anisotropy / KTX2 if needed
  onProgress?: (fraction: number, label: string) => void;
}

export interface TrackScene {
  /** Everything visible: road, curbs, lines, terrain, barriers, scenery, start gantry… */
  root: THREE.Group;
  /** Called every frame (animated flags, start lights, crowd, water…). */
  update(dt: number, camera: THREE.Camera): void;
  /** Start-light gantry: 0..5 red lights lit, 6 = all off (GO), null = idle/off. */
  setStartLights(state: number | null): void;
  /** Night lighting on/off (floodlights, emissive). */
  setEnvironment(env: EnvironmentState): void;
  /**
   * Fixed trackside camera positions for TV/replay cameras, ordered by s; `occluders` are the buildings near a camera that can stand
   * between it and a car (centre x, z, radius, roof height, then four footprint corners x, z: 12 floats each).
   */
  tvCameras: { position: THREE.Vector3; s: number; occluders?: Float32Array }[];
  dispose(): void;
}

// ── Render ───────────────────────────────────────────────────────────────────

export interface RenderSystem {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly env: EnvironmentState;
  /** Sky, sun, fog, environment map, light rig. */
  setEnvironment(e: EnvironmentSettings): Promise<void>;
  applyGraphics(g: GraphicsSettings): void;
  /** Center the sun shadow frustum / cascades on this point (usually the player car). */
  setFocus(p: THREE.Vector3): void;
  /** speed (m/s) of the viewed car — used for motion blur / speed effects. */
  render(camera: THREE.PerspectiveCamera, dt: number, speed: number): void;
  resize(width: number, height: number): void;
  readonly stats: { fps: number; frameMs: number; drawCalls: number; triangles: number };
  dispose(): void;
}
/** export function createRenderSystem(canvas: HTMLCanvasElement, g: GraphicsSettings): Promise<RenderSystem> */
export type CreateRenderSystem = (canvas: HTMLCanvasElement, g: GraphicsSettings) => Promise<RenderSystem>;

/** Tire smoke, dust, skidmarks, sparks, exhaust flames, debris. */
export interface EffectsSystem {
  /**
   * Tell effects about a car (exhaust positions, size) before its first update. id = VehicleState.id. With the car's
   * damage handle, its broken lamps dim the lights around it and its hits throw bits of its bodywork.
   */
  registerCar(id: number, def: CarDefinition, damage?: CarDamageControl): void;
  unregisterCar(id: number): void;
  update(dt: number, cars: readonly VehicleState[], camera: THREE.Camera): void;
  clear(): void;
  dispose(): void;
}
/** export function createEffects(render: RenderSystem, track: TrackRuntime, quality: QualityLevel): EffectsSystem */
export type CreateEffects = (render: RenderSystem, track: TrackRuntime, quality: QualityLevel) => EffectsSystem;

export interface CameraTarget {
  state: VehicleState;
  /** Anchors from the car visual (world matrices kept up to date by CarVisual.update). */
  anchors: CarVisual['anchors'];
}
export interface CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode;
  next(): CameraMode;
  setMode(m: CameraMode): void;
  /** Hard-cut (no smoothing) on next update — after resets / restarts. */
  snap(): void;
  update(dt: number, target: CameraTarget, look: { x: number; y: number; back: boolean }): void;
  setFov(deg: number): void;
  setShake(amount: number): void; // 0..1 user setting
  setAspect(aspect: number): void;
}
/** export function createCameraRig(track: TrackRuntime | null, tvCameras: TrackScene['tvCameras']): CameraRig */
export type CreateCameraRig = (track: TrackRuntime | null, tvCameras: TrackScene['tvCameras']) => CameraRig;

// ── Car visuals ──────────────────────────────────────────────────────────────

export interface CarVisual {
  readonly root: THREE.Group;
  /** Apply chassis + wheel transforms, suspension, brake lights, disc glow, steering wheel, headlights. */
  update(state: VehicleState, dt: number, env: EnvironmentState): void;
  setLivery(l: Livery): void;
  /** The player's car: full detail, interior, real headlight spotlights at night. AI cars: cheaper. */
  setPlayer(on: boolean): void;
  /** Hide exterior parts that block the cockpit view / show the interior. */
  setCockpitView(on: boolean): void;
  /** World-space anchors (Object3D children of root) for cameras. +Z forward. */
  readonly anchors: { hood: THREE.Object3D; bumper: THREE.Object3D; cockpit: THREE.Object3D; chase: THREE.Object3D };
  /**
   * What crashes have done to this car (src/core/damage.ts). The visual watches VehicleState.impactCount and scrape itself;
   * the game sets the mode from Settings.damage, listens to `onEvent` for the replay and drives `replay()` during one.
   */
  readonly damage?: CarDamageControl;
  /** The mirror glass of the player's car (cockpit view) and its rear camera; the render system's mirror pass draws into them. */
  readonly mirrors?: CarMirrors;
  dispose(): void;
}
/** export function createCarVisual(def: CarDefinition, livery: Livery, quality: QualityLevel): Promise<CarVisual> */
export type CreateCarVisual = (def: CarDefinition, livery: Livery, quality: QualityLevel) => Promise<CarVisual>;

// ── Audio ────────────────────────────────────────────────────────────────────

export interface CarSound {
  update(state: VehicleState, dt: number): void;
  /** Player in cockpit/hood view (more intake/mechanical, less exhaust). */
  setInterior(on: boolean): void;
  dispose(): void;
}
export interface AudioSystem {
  /** Resume the AudioContext. Call from a user gesture (click/key/gamepad button). Safe to call repeatedly. */
  unlock(): Promise<void>;
  readonly unlocked: boolean;
  setListener(camera: THREE.Camera, velocity: THREE.Vector3): void;
  createCarSound(profile: EngineSoundProfile, isPlayer: boolean): CarSound;
  /** Global effects that are not tied to a car. */
  ui(sound: UiSound): void;
  setVolumes(v: AudioSettings): void;
  /** Pause dims/mutes cars, keeps UI sounds. */
  setPaused(p: boolean): void;
  /** Menu / results music on or off. */
  setMusic(on: boolean): void;
  /** Weather for the ambience and tire sounds: rain intensity and track water, both 0..1. */
  setWeather(rain: number, wetness: number): void;
  update(dt: number): void;
  dispose(): void;
}
/** export function createAudioSystem(v: AudioSettings): AudioSystem */
export type CreateAudioSystem = (v: AudioSettings) => AudioSystem;

// ── Input ────────────────────────────────────────────────────────────────────

export interface InputSystem {
  poll(dt: number): InputFrame;
  setControls(c: ControlSettings): void;
  /** Rumble if the device supports it (F310 does not — must be a silent no-op). */
  rumble(strong: number, weak: number, durationMs: number): void;
  readonly connected: boolean;
  dispose(): void;
}
/** export function createInputSystem(c: ControlSettings): InputSystem */
export type CreateInputSystem = (c: ControlSettings) => InputSystem;

// ── UI ───────────────────────────────────────────────────────────────────────

export interface UIDeps {
  cars: CarDefinition[];
  tracks: TrackInfo[];
  settings: Settings;
  version: string;
  /** Personal best laps, key = `${trackId}/${carId}` (seconds). */
  bestLaps: Record<string, number>;
  /** Minimap geometry for any track (for the track-select preview). */
  minimapFor(trackId: string): MinimapTrack | null;
  onIntent(intent: UIIntent): void;
  sound(s: UiSound): void;
  /** The fixed championship calendar and rules. Without it the Championship menu entry is hidden. */
  championshipDef?: ChampionshipDef;
  /** The saved championship, if there is one. */
  championship?: ChampionshipView | null;
}

export type ScreenId =
  | 'title' | 'main' | 'setup' | 'settings' | 'pause' | 'results' | 'loading' | 'credits'
  /** Championship standings between rounds (also the hub a saved championship resumes at). */
  | 'standings'
  /** The final table of a finished championship: podium, champion celebration, season summary. */
  | 'champion'
  | 'none';

/** What a replay is showing, for its overlay. */
export interface ReplayInfo {
  /** The driver the camera follows, their livery colour and finishing position. */
  driver: string;
  color: string;
  position: number;
  /** Camera name ("TV", "Chase", "Cockpit"...). */
  camera: string;
  /** Replay time and length (s). */
  t: number;
  duration: number;
}

export interface UISystem {
  readonly root: HTMLElement;
  /** Feed every polled input frame; menus navigate with nav edges. Returns true if UI consumed it. */
  handleInput(frame: InputFrame): boolean;
  show(screen: ScreenId): void;
  readonly screen: ScreenId;
  setLoading(fraction: number, label: string): void;
  setResults(r: RaceResults): void;
  /** The race being loaded / run (the loading and pause screens describe it). Call before `show('loading')`. */
  setRaceConfig(c: RaceConfig | null): void;
  /** The saved championship changed: a round was recorded, one started, or it was abandoned. */
  setChampionship(v: ChampionshipView | null): void;
  setSettings(s: Settings): void;
  setBestLaps(b: Record<string, number>): void;
  /** HUD. */
  setHudVisible(v: boolean): void;
  setMinimap(m: MinimapTrack | null): void;
  updateHud(h: HudState): void;
  /** Device indicator (gamepad name or keyboard). */
  setDevice(name: string | null): void;
  /** The replay overlay (what is playing and how to drive it), or null to hide it. */
  setReplay(r: ReplayInfo | null): void;
  dispose(): void;
}
/** export function createUI(container: HTMLElement, deps: UIDeps): UISystem */
export type CreateUI = (container: HTMLElement, deps: UIDeps) => UISystem;
