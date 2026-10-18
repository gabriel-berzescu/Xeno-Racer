/**
 * Shared context every screen receives.
 */
import type { ChampionshipDef, ChampionshipSetup, ChampionshipView, HudState, InputFrame, NowPlaying, PlayersInfo, RaceConfig, RaceResults, Settings, SplitLayout, UIIntent, UiSound } from '../core/contracts';
import type { ScreenId, UIDeps } from '../core/systems';
import type { SetupMode, SetupOpts } from './model';

export type Device = 'gamepad' | 'keyboard';

export interface UiCtx {
  readonly deps: UIDeps;
  /** Live working copy of the settings (edited in place by the settings screen). */
  settings: Settings;
  bestLaps: Record<string, number>;
  device: Device;
  deviceName: string | null;
  padWarning: string | null;
  lastConfig: RaceConfig | null;
  lastHud: HudState | null;
  /** Split screen: the last HUD state of seat 1's view (seat 0's is `lastHud`); null outside a split. */
  lastHud2: HudState | null;
  results: RaceResults | null;
  /** The saved championship (in progress or just finished), or null. */
  championship: ChampionshipView | null;
  /** The fixed calendar and rules; null when this build has no championship. */
  readonly championshipDef: ChampionshipDef | null;
  /** Split screen: who plays on what (the join step, the pause menu); the game updates it through `setPlayers()`. */
  players: PlayersInfo;
  /** The song of the race music being heard (the pause menu says so), or null; the game updates it through `setNowPlaying()`. */
  nowPlaying: NowPlaying | null;
  /** Split screen: the layout the HUDs are in, or null while the screen is whole. */
  split: SplitLayout | null;
  /** Device pixels per stage CSS pixel (stage scale x devicePixelRatio) for crisp canvases. */
  pxScale: number;

  sound(s: UiSound): void;
  emit(i: UIIntent): void;
  /** Navigate to another screen (UI-initiated: also emits `menuOpened`). */
  go(screen: ScreenId): void;
  /** Open the setup wizard for a mode. */
  openSetup(mode: SetupMode, opts?: SetupOpts): void;
  /** Emit `startRace` and switch to the loading screen. */
  startRace(config: RaceConfig): void;
  /** Emit `startChampionship` (replacing any saved one) and switch to the loading screen. */
  startChampionship(setup: ChampionshipSetup): void;
  /** Emit `championshipNext` (race the next round of the saved championship) and switch to the loading screen. */
  nextRound(): void;
  /** The UI edited `settings`: re-apply (HUD flags, quality fx) and emit `settingsChanged`. */
  changed(): void;
  /** Re-render everything that depends on the device (prompts, indicators). */
  onDevice(cb: () => void): void;
  /** Subscribe to settings replaced from outside (`setSettings`). */
  onSettings(cb: () => void): void;
  /** Subscribe to stage resizes (re-size canvases). */
  onResize(cb: () => void): void;
  /** The most recent input frame the UI has seen (live input for the Controls screen). */
  readonly frame: InputFrame | null;
}
