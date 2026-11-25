/**
 * The built world of Hyperion Ring's habitat (src/track/scene/habitat*.ts), headless: where it may stand, that the rim's piers end
 * where the sky's ribs begin, and what it costs. Run: npx vitest run tests/track-habitat.test.ts
 */
import { describe, expect, it } from 'vitest';
import { TRACKS, loadTrackRuntime } from '../src/track';
import type { TrackRuntimeImpl } from '../src/track';
import type { Ctx } from '../src/track/scene/ctx';
import { HabBuf, HabLights } from '../src/track/scene/habitatKit';
import { emitRim } from '../src/track/scene/habitatRim';
import { emitViaduct } from '../src/track/scene/habitatSpan';
import { emitStalk, placeStalk } from '../src/track/scene/habitatStalks';
import { emitTown } from '../src/track/scene/habitatTown';

const rt = loadTrackRuntime('hyperion') as TrackRuntimeImpl;
rt.ensureField();
const def = rt.def.scenery!.habitat!;
const ring = rt.info.orbital!;
const ctx = { rt, reserved: [], viewReserved: [] } as unknown as Ctx;

/** The distance from (x, z) to the nearest point of the centre line (m). */
function toRoad(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < rt.count; i++) best = Math.min(best, Math.hypot(rt.X[i] - x, rt.Z[i] - z));
  return best;
}

describe("Hyperion Ring's habitat", () => {
  it('belongs to this circuit alone', () => {
    for (const t of TRACKS) {
      if (t.info.id === 'hyperion') continue;
      expect((loadTrackRuntime(t.info.id) as TrackRuntimeImpl).def.scenery?.habitat, t.info.id).toBeUndefined();
    }
  });

  it('has six to nine stalks: none near a road, none to the west, one landmark that is the tallest, each leaning with the floor', () => {
    const stalks = def.stalks!;
    expect(stalks.length).toBeGreaterThanOrEqual(6);
    expect(stalks.length).toBeLessThanOrEqual(9);
    const b = rt.bounds;
    for (const s of stalks) {
      expect(toRoad(s.x, s.z), `stalk at ${s.x}, ${s.z}`).toBeGreaterThan(300 + rt.maxWall);
      expect(s.x).toBeLessThan(b.maxX);
      expect(s.x).toBeGreaterThan(ring.rims[0] + 300);
      expect(s.height).toBeGreaterThanOrEqual(400);
      expect(s.height).toBeLessThanOrEqual(1100);
      // square to the floor of the ring: its axis points at the ring's axis
      const p = placeStalk(rt, ring, s);
      expect(p.frame.up[2]).toBeCloseTo(-(s.z - ring.z) / ring.radius, 6);
      expect(Math.hypot(...p.frame.up)).toBeCloseTo(1, 9);
    }
    const marks = stalks.filter((s) => s.landmark);
    expect(marks.length).toBe(1);
    expect(marks[0].height).toBe(Math.max(...stalks.map((s) => s.height)));
  });

  it("ends each pier in the plane of the glass, as wide as a rib, on the rib's own line through the axis of the ring", () => {
    const lights = new HabLights();
    const rim = emitRim(ctx, def.rim!, ring, lights);
    const X = ring.rims[def.rim!.side];
    const pitch = def.rim!.pitch ?? 240;
    const pos: number[] = [];
    for (const b of rim.bufs) for (const v of b.pos) pos.push(v);
    for (const k of [-14, -6, -1, 0, 1, 2, 9, 17]) {
      const th = (k * pitch) / ring.radius;
      // the rib's line: from the axis of the ring down through the floor at the angle th
      const along = (x: number, y: number, z: number): { off: number; h: number; lat: number } => {
        const dy = ring.y + ring.radius - y;
        const dz = z - ring.z;
        return { off: x - X, h: ring.radius - (dy * Math.cos(th) + dz * Math.sin(th)), lat: dz * Math.cos(th) - dy * Math.sin(th) };
      };
      // the pier's vertices: within 5 m of the rib's line; its top is the highest of them
      let top = -Infinity;
      const near: { off: number; h: number; lat: number }[] = [];
      for (let i = 0; i < pos.length; i += 3) {
        const a = along(pos[i], pos[i + 1], pos[i + 2]);
        if (Math.abs(a.lat) > 5) continue;
        near.push(a);
        top = Math.max(top, a.h);
      }
      // (its face: the flanks run on 0.6 m behind the plane)
      const crown = near.filter((a) => a.h > top - 0.01 && a.off < 0.3);
      expect(crown.length, `rib ${k}`).toBeGreaterThanOrEqual(4);
      // in the plane of the glass, and six metres wide, centred on the line
      for (const a of crown) expect(Math.abs(a.off), `rib ${k}`).toBeLessThan(1e-3);
      expect(Math.max(...crown.map((a) => a.lat)), `rib ${k}`).toBeCloseTo(3, 1);
      expect(Math.min(...crown.map((a) => a.lat)), `rib ${k}`).toBeCloseTo(-3, 1);
      // 45 m above the crest of the bank there
      const z = ring.z + ring.radius * Math.sin(th);
      const ground = rt.fieldHeight(X - 9, z) - (ring.y + ring.radius * (1 - Math.cos(th)));
      expect(top - ground, `rib ${k}`).toBeGreaterThan(41);
      expect(top - ground, `rib ${k}`).toBeLessThan(49);
    }
    // nothing of it beyond the glass by more than the piers' own backs, and the ground at its foot is kept clear
    for (let i = 0; i < pos.length; i += 3) expect(pos[i]).toBeLessThan(X + 0.7);
    expect(rim.reserve(X - 10, 300, 0)).toBe(true);
    expect(rim.reserve(X - 400, 300, 0)).toBe(false);
  });

  it('builds its settlements off the roads and out of the water, twenty houses or more each', () => {
    const lake = rt.terrain.lakeLevel!;
    expect(def.settlements!.length).toBeGreaterThanOrEqual(4);
    expect(def.settlements!.length).toBeLessThanOrEqual(7);
    def.settlements!.forEach((s, i) => {
      const plots = emitTown(ctx, new HabBuf(), new HabLights(), s, i);
      expect(plots.length, `settlement ${i}`).toBeGreaterThanOrEqual(20);
      expect(plots.length, `settlement ${i}`).toBeLessThanOrEqual(62);
      for (const p of plots) {
        expect(rt.stripMargin(p.x, p.z), `settlement ${i}`).toBeGreaterThan(20);
        expect(rt.fieldHeight(p.x, p.z), `settlement ${i}`).toBeGreaterThan(lake + 0.5);
      }
    });
  });

  it('stays inside the land that is drawn, and inside its budget of triangles and lights', () => {
    const lights = new HabLights();
    let tris = 0;
    const b = rt.bounds;
    const check = (buf: HabBuf, what: string): void => {
      tris += buf.tris;
      for (let i = 0; i < buf.pos.length; i += 3) {
        const x = buf.pos[i];
        const z = buf.pos[i + 2];
        if (x < b.minX - 5000 || x > ring.rims[1] + 1 || z < b.minZ - 5000 || z > b.maxZ + 5000) throw new Error(`${what}: a vertex at ${x.toFixed(0)}, ${z.toFixed(0)} is off the land`);
        if (!Number.isFinite(x + buf.pos[i + 1] + z)) throw new Error(`${what}: a vertex that is not a number`);
      }
      for (const n of buf.nor) if (!Number.isFinite(n)) throw new Error(`${what}: a normal that is not a number`);
    };
    emitRim(ctx, def.rim!, ring, lights).bufs.forEach((buf, i) => check(buf, `rim ${i}`));
    def.stalks!.forEach((s, i) => {
      const buf = new HabBuf();
      emitStalk(buf, lights, placeStalk(rt, ring, s), i);
      check(buf, `stalk ${i}`);
    });
    def.settlements!.forEach((s, i) => {
      const buf = new HabBuf();
      emitTown(ctx, buf, lights, s, i);
      check(buf, `settlement ${i}`);
    });
    (def.viaducts ?? []).forEach((v, i) => {
      const buf = new HabBuf();
      emitViaduct(buf, lights, rt, ring, v);
      check(buf, `viaduct ${i}`);
    });
    // (all of it, were it all on screen at once: the worst view holds about half)
    expect(tris).toBeLessThan(260_000);
    expect(lights.count).toBeLessThan(3000);
  });
});
