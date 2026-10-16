/**
 * The link from a car's mechanical damage record (the MechState its CarDamage keeps, src/core/mechanical.ts) to everything that
 * has to know about it: its physics and its driver. One per car. Settings: Damage, Full puts the record on the sinks whenever it
 * changes; any other mode takes it off again. Kept apart from the game so that its lifecycle is tested without a browser: a new car
 * (a restart, the next round) starts sound, and a reset to the track, which touches neither the record nor the link, leaves the
 * damage where it is.
 */
import { mechanicalEffects, neutralEffects, type MechEffects, type MechState } from '../core/mechanical';

/** Anything that takes mechanical damage: the physics of a car, the driver that drives it. */
export interface MechSink {
  setDamage(e: MechEffects | null): void;
}

export class MechLink {
  /** The version of the record that is on the sinks now, or -1 when nothing is (the car is sound as far as they know). */
  private applied = -1;
  private readonly fx = neutralEffects();

  constructor(private readonly sinks: MechSink[] = []) {}

  /** Another sink: a driver that drives this car from now on (the autopilot). It is told what the others know. */
  add(s: MechSink, m?: MechState | null): void {
    this.sinks.push(s);
    if (this.applied >= 0 && m) s.setDamage(m.pristine ? null : mechanicalEffects(m, this.fx));
  }

  /** What is on the sinks, as a record version (-1: nothing). */
  get version(): number {
    return this.applied;
  }

  /**
   * Call every frame. `full` is Damage: Full; `m` the car's record (undefined when the car keeps none). Cheap when nothing changed.
   * True when the sinks were told something.
   */
  update(m: MechState | null | undefined, full: boolean): boolean {
    const want = full && m ? m.version : -1;
    if (want === this.applied) return false;
    this.applied = want;
    const fx = want >= 0 && m && !m.pristine ? mechanicalEffects(m, this.fx) : null;
    for (const s of this.sinks) s.setDamage(fx);
    return true;
  }
}
