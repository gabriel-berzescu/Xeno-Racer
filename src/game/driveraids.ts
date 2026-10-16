/**
 * The aids of one human driver that live above the physics (owner: game): the driving guide (the AI's racing line and speed profile,
 * worked out for this driver's car) and the braking assist that follows it. One per human. The game feeds it the car every frame;
 * the render system draws the guide (src/render/drivingLine.ts) and the HUD shows what the assist does. Kept apart from the game so
 * that it runs headless: tests/probes/brake-assist.test.ts drives a car round every circuit with exactly this code.
 */
import { DrivingGuide, type GuideOptions } from '../ai';
import type { CarControls, CarDefinition, LineMode, PlayerAssists, TrackPoint, TrackRuntime, VehicleState } from '../core/contracts';
import { BrakeAssist, brakeDemand, type AssistInput, type BrakeCall } from '../core/aids';
import type { MechSink } from './mechsync';

const _call: BrakeCall = { demand: 0, over: 0 };
const _tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };

export class DriverAids implements MechSink {
  readonly guide: DrivingGuide;
  readonly assist = new BrakeAssist();
  line: LineMode = 'off';
  brakeAssist = false;
  /** The car's place on the track as of the last update(): distance along it (m), and its speed along the car (m/s). */
  s = 0;
  speed = 0;
  /** The car has ABS (the assist may then ask for the whole pedal; without it the pedal stays short of locking the wheels). */
  private abs = true;
  private hint = -1;
  private idle = true;
  /** What the assist is handed every frame (one object, rewritten in place). */
  private readonly input: AssistInput = { speed: 0, pedal: 0, handbrake: 0, active: false, need: 0, over: 0, drag: 0, gain: 0, grip: 0, abs: true };

  constructor(
    readonly track: TrackRuntime,
    car: CarDefinition,
    opts: GuideOptions = {},
  ) {
    this.guide = new DrivingGuide(track, car, opts);
  }

  /** Take the settings of this human's aids. */
  setAssists(a: PlayerAssists): void {
    this.line = a.line;
    this.brakeAssist = a.brakeAssist;
    this.abs = a.abs;
    if (!this.brakeAssist) this.assist.reset();
  }

  /** Something of the guide is in use: the line is drawn or the assist is on. */
  get active(): boolean {
    return this.line !== 'off' || this.brakeAssist;
  }

  /** The car's mechanical damage (Damage: Full): the guide asks less of a damaged car. */
  setDamage(e: Parameters<DrivingGuide['setDamage']>[0]): void {
    this.guide.setDamage(e);
  }

  /**
   * Every frame. Keeps the guide up with the water on the road and finds the car on the track; and, with the braking assist on and
   * the race running, puts the assist's brake (and the throttle it lifts) into `c`, the controls the driver's pad has just filled in.
   * `racing` is false before the lights go out and after the flag. Nothing here allocates.
   */
  update(dt: number, state: VehicleState, c: CarControls, racing: boolean, wetness: number): void {
    if (!this.active) {
      // (a pause in use: whatever changed meanwhile is worked out the moment the guide is wanted again)
      this.idle = true;
      this.guide.setWetness(wetness);
      return;
    }
    if (this.idle) {
      this.guide.setWetness(wetness);
      this.guide.settle();
      this.idle = false;
    } else this.guide.setWetness(wetness);
    this.guide.update(dt);
    this.hint = this.track.project(state.position.x, state.position.z, _tp, this.hint);
    this.s = _tp.s;
    const v = state.forwardSpeed;
    this.speed = v;
    if (!this.brakeAssist) return;
    // the assist works for a car in the race that is on (not before the lights go out, nor after the flag) that drives the way the track
    // goes: one that has been spun round and faces the wrong way is not on the line's road, and the line's speeds say nothing to it
    const q = state.quaternion;
    const facing = 2 * (q.x * q.z + q.w * q.y) * _tp.tx + (1 - 2 * (q.x * q.x + q.y * q.y)) * _tp.tz;
    const on = racing && facing > -0.2;
    const speed = Math.max(0, v);
    const call = _call;
    if (on && speed > 0) brakeDemand(this.guide, this.s, speed, call);
    else {
      call.demand = 0;
      call.over = 0;
    }
    const bm = this.guide.brake;
    const i = this.input;
    i.speed = v;
    i.pedal = c.brake;
    i.handbrake = c.handbrake;
    i.active = on;
    i.need = call.demand;
    i.over = call.over;
    i.drag = bm.drag(speed);
    i.gain = bm.pedal;
    i.grip = bm.grip(speed);
    i.abs = this.abs;
    const out = this.assist.step(dt, i);
    c.throttle = this.assist.throttle(c.throttle);
    if (this.assist.added > 0) c.brake = out;
  }

  /** What the assist adds to the driver's pedal right now (0..1), for the HUD. */
  get added(): number {
    return this.brakeAssist ? this.assist.added : 0;
  }
}
