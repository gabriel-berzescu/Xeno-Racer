/**
 * Nitro: a short burst of extra power that every car carries, humans and AI alike. A car has NITRO_PER_LAP shots for each lap;
 * the tank is filled again every time the car starts a new lap (a shot not used is not carried over). A shot burns for
 * NITRO_SECONDS, and while it burns the engine makes NITRO_POWER more torque and the bottle pushes the car along with a
 * thrust of NITRO_THRUST_G, both in proportion to the throttle (lifting or braking takes the push away, the clock still runs).
 *
 * Pure and allocation-free: the game keeps one NitroTank per car, `update()`s it every frame with the line crossings the session
 * counted for the car, and hands `level` (0..1, with a short ramp in and out) to the physics as `Vehicle.nitro`.
 */

/** Shots per lap. */
export const NITRO_PER_LAP = 2;
/** How long one shot burns (s). */
export const NITRO_SECONDS = 4;
/** Extra engine torque at full nitro (0.5 = half as much again). */
export const NITRO_POWER = 0.5;
/** Push of the bottle at full nitro and full throttle, as a share of the car's weight (m/s^2 = this * 9.81). */
export const NITRO_THRUST_G = 0.3;
/** Time (s) the level takes to come in and to go out (no step in the push the tyres would feel as a jolt). */
const RAMP = 0.15;

export class NitroTank {
  /** Shots left on this lap. */
  charges = NITRO_PER_LAP;
  /** Seconds left of the shot burning now (0 = none). */
  left = 0;
  /** 0..1, what the physics uses: 1 while a shot burns, ramped at both ends. */
  level = 0;
  /** The most line crossings the tank has seen (it was last filled there). */
  private lap = -1;
  /** The car was racing at the last update (a shot can only be fired then). */
  private running = false;

  /** A shot can be fired: the car is racing, a shot is left and none is burning. */
  get ready(): boolean {
    return this.running && this.charges > 0 && this.left <= 0;
  }

  /** A shot is burning. */
  get active(): boolean {
    return this.left > 0;
  }

  /** Fire a shot if one is ready; true if it was fired. */
  fire(): boolean {
    if (!this.ready) return false;
    this.charges--;
    this.left = NITRO_SECONDS;
    return true;
  }

  /** Put out the shot burning now (a reset to the track); the shot is spent. */
  cancel(): void {
    this.left = 0;
    this.level = 0;
  }

  /** A full tank and nothing burning (a new race, a restart). */
  refill(): void {
    this.charges = NITRO_PER_LAP;
    this.left = 0;
    this.level = 0;
    this.lap = -1;
    this.running = false;
  }

  /**
   * Advance by dt. `crossings` is the session's count of the car's line crossings: a value above any seen before is a new lap,
   * which fills the tank (a shot burning across the line goes on burning). Backing over the line and driving across it again
   * takes the count down and back up to where it was, and fills nothing. `running` false (the grid, after the flag) puts any shot out.
   */
  update(dt: number, crossings: number, running: boolean): void {
    if (crossings > this.lap) {
      // (the first update only notes the lap the car is on: the tank starts full)
      if (this.lap >= 0) this.charges = NITRO_PER_LAP;
      this.lap = crossings;
    }
    this.running = running;
    if (!running) {
      this.left = 0;
      this.level = 0;
      return;
    }
    if (this.left > 0) this.left = Math.max(0, this.left - dt);
    const target = this.left > 0 ? 1 : 0;
    const step = dt / RAMP;
    this.level = target > this.level ? Math.min(target, this.level + step) : Math.max(target, this.level - step);
  }
}
