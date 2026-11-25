/**
 * The viaducts of an orbital habitat (habitat.ts): a line carried high over the land from stalk to stalk, far out beyond the
 * circuit, where its size is what one reads the size of everything else by.
 *
 * A thin deck at one height above the floor of the ring; under it, from pier to pier, a rib in a parabola that touches the deck at
 * mid-span, with a few slim posts between rib and deck; and piers that taper from a spread foot to the width of the rib. Tall and
 * narrow: the arches are higher than they are wide. A lamp on the deck every thirty metres after dark.
 */
import type { OrbitalRing } from '../../core/contracts';
import type { ViaductDef } from '../types';
import type { TrackRuntimeImpl } from '../runtime';
import { HabBuf, LAMP, PAL, type HabLights, type V3 } from './habitatKit';

/** Half the deck's width, its depth, and half the rib's width (m). */
const DECK_HW = 4.2;
const DECK_D = 2.6;
const RIB_HW = 2.2;

export function emitViaduct(buf: HabBuf, lights: HabLights, rt: TrackRuntimeImpl, ring: OrbitalRing, def: ViaductDef): void {
  const R = ring.radius;
  /** The deck's level over (x, z): `height` above the ring's floor there (the floor of the true circle, which the land joins as it climbs). */
  const deckY = (z: number): number => {
    const c = Math.min(Math.abs(z - ring.z), R * 0.9);
    return ring.y + (R - Math.sqrt(R * R - c * c)) + def.height;
  };
  for (let leg = 0; leg + 1 < def.pts.length; leg++) {
    const [ax, az] = def.pts[leg];
    const [bx, bz] = def.pts[leg + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const bays = Math.max(1, Math.round(len / def.span));
    const span = len / bays;
    const tx = (bx - ax) / len;
    const tz = (bz - az) / len;
    // across the deck
    const nx = -tz;
    const nz = tx;
    const rise = span * 0.3;
    const P = (along: number, y: number, lat: number): V3 => [ax + tx * along + nx * lat, y, az + tz * along + nz * lat];
    const yAt = (along: number): number => deckY(az + tz * along);
    const fwd: V3 = [tx, 0, tz];
    const back: V3 = [-tx, 0, -tz];
    const side = (sgn: number): V3 => [nx * sgn, 0, nz * sgn];
    const NS = 8;
    for (let b = 0; b < bays; b++) {
      const s0 = b * span;
      // the deck and the rib, in NS pieces
      for (let k = 0; k < NS; k++) {
        const u0 = k / NS;
        const u1 = (k + 1) / NS;
        const a0 = s0 + u0 * span;
        const a1 = s0 + u1 * span;
        const y0 = yAt(a0);
        const y1 = yAt(a1);
        buf.quad(P(a0, y0, -DECK_HW), P(a1, y1, -DECK_HW), P(a1, y1, DECK_HW), P(a0, y0, DECK_HW), PAL.bone, { toward: [0, 1, 0] });
        buf.quad(P(a0, y0 - DECK_D, -DECK_HW), P(a1, y1 - DECK_D, -DECK_HW), P(a1, y1 - DECK_D, DECK_HW), P(a0, y0 - DECK_D, DECK_HW), PAL.shell, { toward: [0, -1, 0], k: [0.7, 0.7, 0.7, 0.7] });
        for (const sg of [-1, 1]) {
          buf.quad(P(a0, y0 - DECK_D, sg * DECK_HW), P(a1, y1 - DECK_D, sg * DECK_HW), P(a1, y1, sg * DECK_HW), P(a0, y0, sg * DECK_HW), PAL.white, { toward: side(sg) });
        }
        // the rib: a parabola from pier to pier, at the deck's underside in the middle
        const r0 = y0 - DECK_D - rise * (2 * u0 - 1) * (2 * u0 - 1);
        const r1 = y1 - DECK_D - rise * (2 * u1 - 1) * (2 * u1 - 1);
        const rd = 2.4;
        buf.quad(P(a0, r0 - rd, -RIB_HW), P(a1, r1 - rd, -RIB_HW), P(a1, r1 - rd, RIB_HW), P(a0, r0 - rd, RIB_HW), PAL.shell, { toward: [0, -1, 0], k: [0.72, 0.72, 0.72, 0.72] });
        for (const sg of [-1, 1]) {
          buf.quad(P(a0, r0 - rd, sg * RIB_HW), P(a1, r1 - rd, sg * RIB_HW), P(a1, r1, sg * RIB_HW), P(a0, r0, sg * RIB_HW), PAL.white, { toward: side(sg) });
        }
        // a post between rib and deck (none at the crown, where they touch)
        if (k > 0 && k !== NS / 2) {
          const ph = 0.7;
          for (const sg of [-1, 1]) {
            buf.quad(P(a0 - ph, r0 - 0.5, sg * RIB_HW), P(a0 + ph, r0 - 0.5, sg * RIB_HW), P(a0 + ph, y0 - DECK_D, sg * RIB_HW), P(a0 - ph, y0 - DECK_D, sg * RIB_HW), PAL.white, { toward: side(sg) });
          }
          buf.quad(P(a0 - ph, r0 - 0.5, -RIB_HW), P(a0 - ph, r0 - 0.5, RIB_HW), P(a0 - ph, y0 - DECK_D, RIB_HW), P(a0 - ph, y0 - DECK_D, -RIB_HW), PAL.shell, { toward: back });
          buf.quad(P(a0 + ph, r0 - 0.5, -RIB_HW), P(a0 + ph, r0 - 0.5, RIB_HW), P(a0 + ph, y0 - DECK_D, RIB_HW), P(a0 + ph, y0 - DECK_D, -RIB_HW), PAL.shell, { toward: fwd });
        }
        if (k % 2 === 0) {
          for (const sg of [-1, 1]) lights.add(P(a0 + span / (NS * 2), y0 + 1.2, sg * (DECK_HW - 0.4)), LAMP.warm, 1.4, 3);
        }
      }
      // the pier at the start of the bay (the first and the last of a leg stand inside the stalks it joins)
      if (b === 0) continue;
      const px = ax + tx * s0;
      const pz = az + tz * s0;
      const g = rt.fieldHeight(px, pz);
      const top = yAt(s0) - DECK_D - rise;
      const H = top - g;
      // [height, half-thickness along the line, half-width across it]
      const st: [number, number, number][] = [
        [g - 8, 5.2, 7.5],
        [g + H * 0.1, 3.4, 5.2],
        [g + H * 0.45, 2.3, 3.4],
        [top, 1.7, RIB_HW],
        // (the pier carries on to the deck between the two ribs it parts)
        [top + rise, 1.5, RIB_HW],
      ];
      for (let k = 0; k + 1 < st.length; k++) {
        const [h0, t0, w0] = st[k];
        const [h1, t1, w1] = st[k + 1];
        buf.quad(P(s0 - t0, h0, -w0), P(s0 - t0, h0, w0), P(s0 - t1, h1, w1), P(s0 - t1, h1, -w1), PAL.shell, { toward: back });
        buf.quad(P(s0 + t0, h0, -w0), P(s0 + t0, h0, w0), P(s0 + t1, h1, w1), P(s0 + t1, h1, -w1), PAL.shell, { toward: fwd });
        for (const sg of [-1, 1]) {
          buf.quad(P(s0 - t0, h0, sg * w0), P(s0 + t0, h0, sg * w0), P(s0 + t1, h1, sg * w1), P(s0 - t1, h1, sg * w1), PAL.white, { toward: side(sg) });
        }
      }
    }
  }
}

/** The ground a viaduct's piers stand on: (x, z, radius) of each. */
export function viaductFeet(def: ViaductDef): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let leg = 0; leg + 1 < def.pts.length; leg++) {
    const [ax, az] = def.pts[leg];
    const [bx, bz] = def.pts[leg + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const bays = Math.max(1, Math.round(len / def.span));
    for (let b = 1; b < bays; b++) out.push([ax + ((bx - ax) * b) / bays, az + ((bz - az) * b) / bays, 9]);
  }
  return out;
}
