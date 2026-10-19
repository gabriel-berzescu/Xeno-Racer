/**
 * ChassisMapper — turns a VehicleState into the chassis part of the control vector. Stateful
 * (thump rate limiting, landing detection, impact counters) but allocation-free per frame.
 * Main-thread only; the DSP side lives in dsp/chassis-voice.ts.
 */
import type { SurfaceType, VehicleState } from '../core/contracts';
import { CTL, TIRE_STRIDE } from './controls';
import { clamp, smoothstep } from './dsp/util';
import { makeSquealLevels, tireSqueal } from './tires';

const SURF_INDEX: Record<SurfaceType, number> = {
  asphalt: 0,
  concrete: 0,
  curb: 1,
  grass: 2,
  gravel: 3,
  sand: 4,
  dirt: 5,
  // snow (packed and deep) crunches, studded ice rattles
  snow: 6,
  ice: 7,
  deepsnow: 6,
};

/** Rotate (px,py,pz) by the inverse of quaternion q (world -> car frame), returning the local X (left). */
export function localLeft(q: { x: number; y: number; z: number; w: number }, px: number, py: number, pz: number): number {
  // v' = v + 2w (u x v) + 2 u x (u x v) with u = -q.xyz (conjugate)
  const ux = -q.x;
  const uy = -q.y;
  const uz = -q.z;
  const cx = uy * pz - uz * py;
  const cy = uz * px - ux * pz;
  const cz = ux * py - uy * px;
  const dx = uy * cz - uz * cy;
  return px + 2 * q.w * cx + 2 * dx;
}

export class ChassisMapper {
  private lev = makeSquealLevels();
  private thumpCount = 0;
  private lastThumpAt = new Float64Array(4).fill(-10);
  private t = 0;
  private prevAirborne = false;
  private prevVy = 0;
  private lastImpactSeen = -1;
  private impactCount = 0;
  private bottomOut = new Uint8Array(4);

  /**
   * Fill the chassis fields of `v` from the physics state. dt in seconds; `wet` = water on the track (0..1,
   * 0 = exactly the dry mapping).
   */
  update(st: VehicleState, dt: number, v: Float32Array, wet = 0): void {
    this.t += dt;
    const w = st.wheels;

    // surface weights: share of wheels in contact on each surface class
    let nContact = 0;
    let hard = 0;
    let curb = 0;
    let grass = 0;
    let gravel = 0;
    let sand = 0;
    let dirt = 0;
    let snow = 0;
    let ice = 0;
    for (let i = 0; i < 4; i++) {
      if (!w[i].contact) continue;
      nContact++;
      switch (SURF_INDEX[w[i].surface]) {
        case 0:
          hard++;
          break;
        case 1:
          curb++;
          break;
        case 2:
          grass++;
          break;
        case 3:
          gravel++;
          break;
        case 4:
          sand++;
          break;
        case 6:
          snow++;
          break;
        case 7:
          ice++;
          break;
        default:
          dirt++;
      }
    }
    const inv = 0.25; // fractions of all four wheels, so a car with wheels off the ground is quieter
    v[CTL.SURF_HARD] = hard * inv;
    v[CTL.SURF_CURB] = curb * inv;
    v[CTL.SURF_GRASS] = grass * inv;
    v[CTL.SURF_GRAVEL] = gravel * inv;
    v[CTL.SURF_SAND] = sand * inv;
    v[CTL.SURF_DIRT] = dirt * inv;
    v[CTL.SURF_SNOW] = snow * inv;
    v[CTL.SURF_ICE] = ice * inv;
    v[CTL.AIRBORNE] = st.airborne || nContact === 0 ? 1 : 0;
    for (let i = 0; i < 4; i++) v[CTL.CURB_FL + i] = w[i].contact && w[i].surface === 'curb' ? 1 : 0;

    // tire squeal
    const speed = st.speed;
    for (let i = 0; i < 4; i++) {
      tireSqueal(w[i], i, speed, this.lev, wet);
      const b = CTL.TIRE0 + i * TIRE_STRIDE;
      v[b] = this.lev.scrub;
      v[b + 1] = this.lev.tone;
      v[b + 2] = this.lev.howl;
      v[b + 3] = this.lev.pitch;
      v[CTL.SLUSH0 + i] = this.lev.slush;
    }
    v[CTL.WET] = wet;

    // suspension thumps: hard compression, bump-stop, and landing
    let thump = 0;
    let thumpPan = 0;
    for (let i = 0; i < 4; i++) {
      const sv = w[i].suspensionVelocity;
      const hit = sv > 0.55 || (w[i].compression > 0.96 && !this.bottomOut[i]);
      this.bottomOut[i] = w[i].compression > 0.96 ? 1 : 0;
      if (hit && w[i].contact && this.t - this.lastThumpAt[i] > 0.11) {
        const strength = clamp((Math.max(sv, 0) - 0.5) / 1.5 + (w[i].compression > 0.96 ? 0.35 : 0), 0.05, 1);
        if (strength > thump) {
          thump = strength;
          thumpPan = i % 2 === 0 ? -0.6 : 0.6;
        }
        this.lastThumpAt[i] = this.t;
      }
    }
    const vy = st.velocity.y;
    if (this.prevAirborne && !st.airborne && this.prevVy < -1.2) {
      const s = clamp((-this.prevVy - 1) / 6, 0.15, 1);
      if (s > thump) {
        thump = s;
        thumpPan = 0;
      }
    }
    this.prevAirborne = st.airborne;
    this.prevVy = vy;
    if (thump > 0) {
      this.thumpCount = (this.thumpCount + 1) % 60000;
      v[CTL.THUMP_STRENGTH] = thump;
      v[CTL.THUMP_PAN] = thumpPan;
    }
    v[CTL.THUMP_COUNT] = this.thumpCount;

    // scrape + impacts
    v[CTL.SCRAPE] = clamp(st.scrape, 0, 1);
    if (this.lastImpactSeen < 0) this.lastImpactSeen = st.impactCount;
    // (a count that went back is a replay starting over: the new count is taken, nothing hit anything)
    if (st.impactCount < this.lastImpactSeen) this.lastImpactSeen = st.impactCount;
    if (st.impactCount !== this.lastImpactSeen) {
      this.lastImpactSeen = st.impactCount;
      this.impactCount = (this.impactCount + 1) % 60000;
      const li = st.lastImpact;
      v[CTL.IMPACT_STRENGTH] = li.strength;
      v[CTL.IMPACT_KIND] = li.kind === 'wall' ? 0 : li.kind === 'car' ? 1 : li.kind === 'snow' ? 3 : 2;
      const lx = localLeft(st.quaternion, li.point.x - st.position.x, li.point.y - st.position.y, li.point.z - st.position.z);
      // +X is the car's left; stereo pan -1 = left
      v[CTL.IMPACT_PAN] = clamp(-lx / 1.6, -1, 1) * smoothstep(0, 0.4, Math.abs(lx)) * 0.85;
    }
    v[CTL.IMPACT_COUNT] = this.impactCount;
  }
}
