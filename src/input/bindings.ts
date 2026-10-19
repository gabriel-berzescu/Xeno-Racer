/**
 * The binding table. One source of truth for: what the input system reads, what the Controls screen
 * draws on the controller diagram, and what the menus show in their button prompts.
 */

/** Physical controls of a standard-mapping gamepad (Xbox layout; the Logitech F310 in X mode). */
export type PadControl =
  | 'ls' | 'rs' | 'lsClick' | 'rsClick'
  | 'lt' | 'rt' | 'lb' | 'rb'
  | 'a' | 'b' | 'x' | 'y'
  | 'back' | 'start'
  | 'dUp' | 'dDown' | 'dLeft' | 'dRight';

export type DrivingAction =
  | 'steer' | 'throttle' | 'brake' | 'handbrake'
  | 'shiftUp' | 'shiftDown' | 'nitro'
  | 'camera' | 'reset' | 'pause'
  | 'look' | 'lookBack'
  | 'hud' | 'telemetry';

export interface Binding {
  id: DrivingAction;
  /** Short label shown on screen. */
  label: string;
  /** Gamepad controls (primary first). */
  pad: readonly PadControl[];
  /** Keyboard keys as printed on the key caps. */
  keys: readonly string[];
  /** One-liner for the Controls screen. */
  hint: string;
}

export const BINDINGS: readonly Binding[] = [
  { id: 'steer', label: 'Steer', pad: ['ls'], keys: ['A', 'D', 'Left', 'Right'], hint: 'Left stick. Keyboard steering ramps in and recenters.' },
  { id: 'throttle', label: 'Throttle', pad: ['rt'], keys: ['W', 'Up'], hint: 'Analog right trigger.' },
  { id: 'brake', label: 'Brake', pad: ['lt'], keys: ['S', 'Down'], hint: 'Analog left trigger.' },
  { id: 'handbrake', label: 'Handbrake', pad: ['a'], keys: ['Space'], hint: 'Locks the rear wheels while held.' },
  { id: 'shiftUp', label: 'Shift up', pad: ['rb'], keys: ['Shift'], hint: 'Manual gearbox only.' },
  { id: 'shiftDown', label: 'Shift down', pad: ['lb', 'x'], keys: ['Q', 'Ctrl'], hint: 'Manual gearbox only.' },
  { id: 'nitro', label: 'Nitro', pad: ['b'], keys: ['E'], hint: 'Four seconds of extra power. Two shots a lap.' },
  { id: 'camera', label: 'Camera', pad: ['y'], keys: ['C'], hint: 'Cycles chase, hood, cockpit, TV and more.' },
  { id: 'reset', label: 'Reset car', pad: ['back'], keys: ['R'], hint: 'Puts you back on the track.' },
  { id: 'pause', label: 'Pause', pad: ['start'], keys: ['Esc', 'P'], hint: 'Opens the pause menu.' },
  { id: 'look', label: 'Look', pad: ['rs'], keys: ['I', 'J', 'K', 'L'], hint: 'Right stick. Free look in the camera views.' },
  { id: 'lookBack', label: 'Look back', pad: ['rsClick'], keys: ['V'], hint: 'Hold to look behind you.' },
  { id: 'hud', label: 'Toggle HUD', pad: ['dUp'], keys: ['H'], hint: 'Hides the whole HUD for clean shots.' },
  { id: 'telemetry', label: 'Telemetry', pad: ['dDown'], keys: ['T'], hint: 'Tires, g-meter and live traces.' },
];

export const PAD_LABEL: Record<PadControl, string> = {
  ls: 'Left stick', rs: 'Right stick', lsClick: 'Left stick click', rsClick: 'Right stick click',
  lt: 'LT', rt: 'RT', lb: 'LB', rb: 'RB',
  a: 'A', b: 'B', x: 'X', y: 'Y',
  back: 'Back', start: 'Start',
  dUp: 'D-pad up', dDown: 'D-pad down', dLeft: 'D-pad left', dRight: 'D-pad right',
};

export type MenuAction = 'navigate' | 'adjust' | 'confirm' | 'back' | 'tabs' | 'x' | 'y' | 'start' | 'camera';

/** Menu actions, for the button prompts at the bottom of every screen. */
export const MENU_KEYS: Record<MenuAction, { pad: PadControl[]; keys: string[] }> = {
  navigate: { pad: ['dUp', 'dDown'], keys: ['Up', 'Down'] },
  adjust: { pad: ['dLeft', 'dRight'], keys: ['Left', 'Right'] },
  confirm: { pad: ['a'], keys: ['Enter'] },
  back: { pad: ['b'], keys: ['Esc'] },
  tabs: { pad: ['lb', 'rb'], keys: ['Q', 'E'] },
  x: { pad: ['x'], keys: ['X'] },
  y: { pad: ['y'], keys: ['Y'] },
  start: { pad: ['start'], keys: ['Enter'] },
  /** The camera button (Y on the pad, C on the keyboard; the replay changes camera with it). */
  camera: { pad: ['y'], keys: ['C'] },
};

/** Standard-mapping button indices (W3C Gamepad API). */
export const STD = {
  a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9, lsClick: 10, rsClick: 11,
  dUp: 12, dDown: 13, dLeft: 14, dRight: 15, guide: 16,
  lx: 0, ly: 1, rx: 2, ry: 3,
} as const;

/**
 * Best-effort layout for a Logitech F310 that is switched to D (DirectInput) mode and that Chrome does
 * not remap to `standard`. Face buttons are rotated (0 = X, 1 = A, 2 = B, 3 = Y), triggers are digital,
 * the right stick sits on axes 2 and 5 and the D-pad is a hat on axis 9.
 */
export const DINPUT = {
  a: 1, b: 2, x: 0, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9, lsClick: 10, rsClick: 11,
  lx: 0, ly: 1, rx: 2, ryWide: 5, ryNarrow: 3, hat: 9,
} as const;
