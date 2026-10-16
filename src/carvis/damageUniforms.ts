/**
 * From the CarDamage model to the uniform tables the body shader reads (damageShader.ts). Plain arrays in, plain arrays
 * out, so the packing is tested without a GPU.
 */
import { MAX_CRACKS, MAX_DENTS, MAX_MARKS, hash01, type CarDamage, type DamageMode, type LampDamage } from '../core/damage';
import type { BodyUniforms } from './materials';

/** Light output of a lamp right now: 1 intact, 0 dark, and for a flickering one irregular bursts of both. */
export function lampOutput(l: LampDamage, index: number, clock: number): number {
  if (l.out >= 1) return 1;
  if (l.out <= 0) return 0;
  // a loose bulb behind a cracked lens: on most of the time, in bursts that come and go
  const burst = hash01(Math.floor(clock * 9), index, 3);
  const gate = hash01(Math.floor(clock * 2.7), index, 5);
  return burst > 0.3 + 0.35 * gate ? 1 : 0.04;
}

/** True while any lamp is flickering: its uniform has to be refreshed every frame, not only when the damage changes. */
export function anyLampFlickers(m: CarDamage): boolean {
  for (let i = 0; i < m.lamps.length; i++) if (m.lamps[i].out > 0 && m.lamps[i].out < 1) return true;
  return false;
}

/** Seconds the sheet takes to give way under a hit (a fresh dent grows to its depth over a few frames instead of appearing). */
export const DENT_SETTLE_S = 0.045;

/**
 * Move the depth each dent is drawn at towards the model's. A dent that appears or deepens settles over DENT_SETTLE_S; a
 * freed slot is gone at once, and a step of no time (a warm-up, a photo) lands at once. True while anything still moves.
 */
export function settleDentDepth(m: CarDamage, shown: Float32Array, dt: number): boolean {
  const k = dt > 0 ? 1 - Math.exp(-dt / DENT_SETTLE_S) : 1;
  let moving = false;
  for (let i = 0; i < MAX_DENTS; i++) {
    if (i >= m.dents.length) {
      shown[i] = 0;
      continue;
    }
    const target = m.dents[i].depth;
    const gap = target - shown[i];
    if (Math.abs(gap) > 2e-4) {
      shown[i] += gap * k;
      moving = true;
    } else shown[i] = target;
  }
  return moving;
}

/**
 * Write the model into the uniforms. In mode 'off' the car is drawn as if it had never been hit. `shown` are the depths the
 * dents are drawn at (settleDentDepth); without them the model's own depths are used.
 */
export function packDamage(m: CarDamage, mode: DamageMode, U: BodyUniforms, clock: number, shown?: Float32Array): void {
  const live = mode !== 'off';
  const nd = live ? Math.min(m.dents.length, MAX_DENTS) : 0;
  const nm = live ? Math.min(m.marks.length, MAX_MARKS) : 0;
  const dent = U.uDent.value;
  for (let i = 0; i < nd; i++) {
    const d = m.dents[i];
    const o = i * 12;
    dent[o] = d.c[0];
    dent[o + 1] = d.c[1];
    dent[o + 2] = d.c[2];
    dent[o + 3] = d.r;
    dent[o + 4] = d.d[0];
    dent[o + 5] = d.d[1];
    dent[o + 6] = d.d[2];
    dent[o + 7] = shown ? shown[i] : d.depth;
    dent[o + 8] = d.t[0];
    dent[o + 9] = d.t[1];
    dent[o + 10] = d.t[2];
    dent[o + 11] = d.e;
  }
  U.uDentN.value = nd;
  const mark = U.uMark.value;
  for (let i = 0; i < nm; i++) {
    const k = m.marks[i];
    const o = i * 12;
    mark[o] = k.c[0];
    mark[o + 1] = k.c[1];
    mark[o + 2] = k.c[2];
    mark[o + 3] = k.hl;
    mark[o + 4] = k.t[0];
    mark[o + 5] = k.t[1];
    mark[o + 6] = k.t[2];
    mark[o + 7] = k.hw;
    mark[o + 8] = k.wear;
    mark[o + 9] = k.kind;
    mark[o + 10] = k.col;
    mark[o + 11] = k.seed;
  }
  U.uMarkN.value = nm;
  const nc = live ? Math.min(m.cracks.length, MAX_CRACKS) : 0;
  const crack = U.uCrack.value;
  for (let i = 0; i < nc; i++) {
    const k = m.cracks[i];
    const o = i * 8;
    crack[o] = k.c[0];
    crack[o + 1] = k.c[1];
    crack[o + 2] = k.c[2];
    crack[o + 3] = k.r;
    crack[o + 4] = k.n[0];
    crack[o + 5] = k.n[1];
    crack[o + 6] = k.n[2];
    crack[o + 7] = k.seed;
  }
  U.uCrackN.value = nc;
  const out = U.uLampOut.value;
  const crk = U.uLampCrk.value;
  const hit = U.uLampHit.value;
  for (let i = 0; i < 4; i++) {
    const l = m.lamps[i];
    out.setComponent(i, live ? lampOutput(l, i, clock) : 1);
    crk.setComponent(i, live ? l.crack : 0);
    hit[i * 4] = l.hit[0];
    hit[i * 4 + 1] = l.hit[1];
    hit[i * 4 + 2] = l.hit[2];
    hit[i * 4 + 3] = hash01(l.hit[0], l.hit[1], l.hit[2], i);
  }
}
