/**
 * The fleet of Halcyon Ring (src/track/scene/fleet*.ts), headless: where the boats lie and sail, how far the great ship is from the
 * road, and what it all costs. Run: npx vitest run tests/track-fleet.test.ts
 */
import { describe, expect, it } from 'vitest';
import { TRACKS, loadTrackRuntime } from '../src/track';
import type { TrackRuntimeImpl } from '../src/track';
import { BOATS, BOAT_KINDS, boatBuffer } from '../src/track/scene/fleetBoats';
import type { FleetBuf } from '../src/track/scene/fleetKit';
import { KIND } from '../src/track/scene/fleetKit';
import { type PointOfSail, planFleet, pointOfSail, waterAtAnchor, waterUnderSail } from '../src/track/scene/fleetPlan';
import { greatShipBuffer } from '../src/track/scene/fleetShip';

const rt = loadTrackRuntime('halcyon') as TrackRuntimeImpl;
rt.ensureField();
const def = rt.def.scenery!.fleet!;
const sea = rt.def.terrain.ocean!.level;
const depth = (x: number, z: number): number => sea - rt.heightFast(x, z);
const plan = planFleet(rt, def, 2);

/** The distance from (x, z) to the nearest point of the centre line (m). */
function toRoad(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < rt.count; i++) best = Math.min(best, Math.hypot(rt.X[i] - x, rt.Z[i] - z));
  return best;
}

function sound(buf: FleetBuf, what: string): void {
  for (const v of buf.pos) if (!Number.isFinite(v)) throw new Error(`${what}: a position that is not a number`);
  for (let i = 0; i < buf.nor.length; i += 3) {
    const l = Math.hypot(buf.nor[i], buf.nor[i + 1], buf.nor[i + 2]);
    if (!(Math.abs(l - 1) < 1e-3)) throw new Error(`${what}: a normal of length ${l}`);
  }
  for (const i of buf.idx) if (!(i >= 0 && i < buf.count)) throw new Error(`${what}: an index out of range`);
}

describe("Halcyon Ring's fleet", () => {
  it('belongs to this circuit alone', () => {
    for (const t of TRACKS) {
      if (t.info.id === 'halcyon') continue;
      expect((loadTrackRuntime(t.info.id) as TrackRuntimeImpl).def.scenery?.fleet, t.info.id).toBeUndefined();
    }
  });

  it('lies at anchor in water deep enough for each boat, off the land, off the road and clear of its neighbours', () => {
    expect(plan.berths.length).toBeGreaterThanOrEqual(110);
    expect(plan.berths.length).toBeLessThanOrEqual(190);
    for (const b of plan.berths) {
      const c = BOATS[b.kind];
      const what = `${b.kind} at ${b.x.toFixed(0)}, ${b.z.toFixed(0)}`;
      // under its middle and under both its ends, however it swings
      const half = (c.length / 2) * b.scale;
      for (let a = 0; a < 8; a++) {
        const an = (a / 8) * Math.PI * 2;
        expect(depth(b.x + Math.cos(an) * half, b.z + Math.sin(an) * half), what).toBeGreaterThanOrEqual(c.draft + 0.2);
      }
      expect(depth(b.x, b.z), what).toBeGreaterThanOrEqual(waterAtAnchor(b.kind));
      expect(rt.stripMargin(b.x, b.z), what).toBeGreaterThan(half);
      expect(toRoad(b.x, b.z), what).toBeGreaterThan(36);
    }
    for (let i = 0; i < plan.berths.length; i++) {
      for (let j = i + 1; j < plan.berths.length; j++) {
        const a = plan.berths[i];
        const b = plan.berths[j];
        const room = 0.5 * (BOATS[a.kind].length * a.scale + BOATS[b.kind].length * b.scale);
        expect(Math.hypot(a.x - b.x, a.z - b.z), `${a.kind} and ${b.kind} near ${a.x.toFixed(0)}, ${a.z.toFixed(0)}`).toBeGreaterThan(room);
      }
    }
  });

  it('lines the Causeway on the lagoon side, 40 to 260 m from the road, the small boats nearest', () => {
    // the Causeway runs north along x = 1293 from z = 0 to 1310, the lagoon to the east of it (x below 1270)
    const line = plan.berths.filter((b) => b.z > 40 && b.z < 1260 && b.x < 1270 && b.x > 1293 - 262);
    expect(line.length).toBeGreaterThanOrEqual(50);
    for (const b of line) expect(1293 - b.x, `${b.kind} at ${b.x.toFixed(0)}, ${b.z.toFixed(0)}`).toBeGreaterThan(38);
    const near = line.filter((b) => 1293 - b.x < 90);
    expect(near.length).toBeGreaterThanOrEqual(18);
    for (const b of near) expect(['proa', 'cat']).toContain(b.kind);
    expect(line.filter((b) => b.kind === 'ketch').length).toBeGreaterThanOrEqual(5);
    // along all of it: no stretch of 200 m without a boat
    for (let z = 100; z < 1100; z += 100) expect(line.filter((b) => b.z >= z && b.z < z + 200).length, `z ${z}`).toBeGreaterThanOrEqual(4);
  });

  it('has boats of every kind, the big ships in deep water off the east shore, and boats off the Strand', () => {
    for (const k of BOAT_KINDS) expect(plan.berths.some((b) => b.kind === k) || plan.sailors.some((b) => b.kind === k), k).toBe(true);
    const ships = plan.berths.filter((b) => b.kind === 'tall');
    expect(ships.length).toBe(def.berths!.filter((b) => b.kind === 'tall').length);
    expect(ships.filter((b) => b.x < -400).length).toBeGreaterThanOrEqual(3);
    for (const s of ships) expect(depth(s.x, s.z)).toBeGreaterThan(8);
    expect(plan.berths.filter((b) => b.z < -120 && b.x > 150 && b.x < 1000).length).toBeGreaterThanOrEqual(15);
    // the fleet at anchor lies head to wind, within a few degrees: most of its bows point one way
    const mean = Math.atan2(plan.berths.reduce((s, b) => s + Math.sin(b.yaw), 0), plan.berths.reduce((s, b) => s + Math.cos(b.yaw), 0));
    const off = plan.berths.filter((b) => Math.abs(Math.atan2(Math.sin(b.yaw - mean), Math.cos(b.yaw - mean))) > 0.35).length;
    expect(off).toBeLessThanOrEqual(6);
  });

  it('sails courses that never leave deep water, come no nearer the road than the beach, and keep clear of the boats at anchor', () => {
    expect(plan.sailors.length).toBeGreaterThanOrEqual(6);
    expect(plan.sailors.length).toBeLessThanOrEqual(14);
    const at = { x: 0, z: 0, tx: 0, tz: 0 };
    for (const c of plan.courses) {
      const boat = BOATS[c.kind];
      expect(c.length).toBeGreaterThan(300);
      for (let s = 0; s < c.length; s += 2) {
        c.at(s, at);
        const what = `${c.kind} course at ${at.x.toFixed(0)}, ${at.z.toFixed(0)}`;
        expect(Math.hypot(at.tx, at.tz), what).toBeCloseTo(1, 6);
        // a metre and a half of water under the keel, under the boat and to both sides of it
        for (const d of [-boat.beam, 0, boat.beam]) expect(depth(at.x - at.tz * d, at.z + at.tx * d), what).toBeGreaterThanOrEqual(waterUnderSail(c.kind));
        expect(depth(at.x, at.z), what).toBeGreaterThanOrEqual(1.5);
        expect(toRoad(at.x, at.z), what).toBeGreaterThan(45);
        for (const b of plan.berths) {
          expect(Math.hypot(b.x - at.x, b.z - at.z), `${what} and the ${b.kind} at ${b.x.toFixed(0)}, ${b.z.toFixed(0)}`).toBeGreaterThan(0.5 * (BOATS[b.kind].length * b.scale + boat.length) + 3);
        }
      }
      // no corner too tight to sail: it turns in a circle no smaller than 0.8 of its length, and never smaller than 15 m
      let prev = Math.atan2(c.z[1] - c.z[0], c.x[1] - c.x[0]);
      let turn = 0;
      for (let i = 1; i <= c.n; i++) {
        const h = Math.atan2(c.z[(i + 1) % c.n] - c.z[i % c.n], c.x[(i + 1) % c.n] - c.x[i % c.n]);
        turn = Math.max(turn, Math.abs(Math.atan2(Math.sin(h - prev), Math.cos(h - prev))));
        prev = h;
      }
      expect(c.step / turn, c.kind + ' course: the radius of its tightest turn').toBeGreaterThan(Math.max(15, 0.8 * boat.length));
    }
  });

  it('trims a sail to the wind: sheeted in close-hauled, squared off on a run, the boom and the heel to leeward', () => {
    const p: PointOfSail = { trim: 0, heel: 0, drive: 0 };
    // the wind from the east (90): a boat going north has it on her starboard side, so the boom lies to port (below 0)
    pointOfSail('sloop', 0, 1, 90, p);
    expect(p.trim).toBeLessThan(-0.6);
    expect(p.heel).toBeLessThan(-0.05);
    expect(p.drive).toBeCloseTo(1, 3);
    const reach = Math.abs(p.trim);
    // going south: on the other side
    pointOfSail('sloop', 0, -1, 90, p);
    expect(p.trim).toBeGreaterThan(0.6);
    // going west, before the wind: the boom right out on the side it was on, no heel to speak of
    pointOfSail('sloop', 1, 0, 90, p);
    expect(p.trim).toBeGreaterThan(reach);
    expect(Math.abs(p.heel)).toBeLessThan(0.01);
    // going east, into its eye: nothing draws
    pointOfSail('sloop', -1, 0, 90, p);
    expect(Math.abs(p.trim)).toBeLessThan(0.07);
    expect(p.drive).toBeLessThan(0.4);
  });

  it('is the same fleet every time, and a smaller one at a lower quality', () => {
    const again = planFleet(rt, def, 2);
    expect(again.berths.length).toBe(plan.berths.length);
    for (let i = 0; i < plan.berths.length; i++) expect([again.berths[i].x, again.berths[i].z, again.berths[i].kind]).toEqual([plan.berths[i].x, plan.berths[i].z, plan.berths[i].kind]);
    const low = planFleet(rt, def, 0);
    expect(low.berths.length).toBeLessThan(plan.berths.length * 0.65);
    expect(low.berths.length).toBeGreaterThan(plan.berths.length * 0.4);
    expect(low.sailors.length).toBe(plan.sailors.length);
  });

  it('hangs the great ship within sight of every part of the circuit, high over the sea and off the land', () => {
    const ship = def.ship!;
    expect(ship.length).toBeGreaterThanOrEqual(1600);
    expect(ship.length).toBeLessThanOrEqual(2400);
    const buf = greatShipBuffer(ship);
    sound(buf, 'the great ship');
    // the camera's far plane is 6 km and a camera is never far from the road: every vertex within 4.7 km of every part of it
    let far = 0;
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < buf.pos.length; i += 3) {
      const x = buf.pos[i];
      const y = buf.pos[i + 1];
      const z = buf.pos[i + 2];
      low = Math.min(low, y);
      high = Math.max(high, y);
      for (let k = 0; k < rt.count; k += 8) far = Math.max(far, Math.hypot(rt.X[k] - x, rt.Y[k] - y, rt.Z[k] - z));
      // over water, clear of the atoll
      if (i % 30 === 0) expect(depth(x, z)).toBeGreaterThan(5);
    }
    expect(far).toBeLessThan(4700);
    expect(low).toBeGreaterThan(500);
    expect(high).toBeLessThan(2300);
    // it carries its lights: lamps, lines that shine after dark and the lift light that shines by day
    const kinds = new Set<number>();
    let lit = 0;
    for (let i = 0; i < buf.rig.length; i += 4) {
      kinds.add(buf.rig[i]);
      if (buf.rig[i] === KIND.solid && buf.rig[i + 1] !== 0) lit++;
    }
    expect(kinds.has(KIND.lamp)).toBe(true);
    expect(kinds.has(KIND.lift)).toBe(true);
    expect(lit).toBeGreaterThan(500);
  });

  it('builds boats that are sound, that sit in the water and carry sails and lights, inside the budget of triangles', () => {
    let tris = greatShipBuffer(def.ship!).triangles;
    const per: Record<string, number> = {};
    for (const k of BOAT_KINDS) {
      const c = BOATS[k];
      const buf = boatBuffer(k);
      sound(buf, k);
      per[k] = buf.triangles;
      let minY = Infinity;
      let maxY = -Infinity;
      let minX = Infinity;
      let maxX = -Infinity;
      let sails = 0;
      let lamps = 0;
      for (let i = 0; i < buf.count; i++) {
        const kind = buf.rig[i * 4];
        if (kind === KIND.sail) sails++;
        if (kind === KIND.lamp) lamps++;
        minY = Math.min(minY, buf.pos[i * 3 + 1]);
        maxY = Math.max(maxY, buf.pos[i * 3 + 1]);
        if (kind === KIND.solid) {
          minX = Math.min(minX, buf.pos[i * 3]);
          maxX = Math.max(maxX, buf.pos[i * 3]);
        }
      }
      // the keel is as deep as the kind says and the masthead as high, within a little
      expect(minY, k).toBeCloseTo(-c.draft, 1);
      expect(maxY, k).toBeGreaterThan(c.height * 0.93);
      expect(maxY, k).toBeLessThan(c.height * 1.07);
      expect(maxX - minX, k).toBeGreaterThan(c.length);
      expect(maxX - minX, k).toBeLessThan(c.length * 1.3);
      expect(sails, k).toBeGreaterThan(20);
      expect(lamps, k).toBeGreaterThanOrEqual(14);
      const n = plan.berths.filter((b) => b.kind === k).length + plan.sailors.filter((b) => b.kind === k).length;
      tris += buf.triangles * n;
    }
    // (every boat is drawn whatever the view: all of it counts)
    expect(tris).toBeLessThan(150_000);
    expect(per.proa).toBeLessThan(450);
    expect(per.tall).toBeLessThan(3200);
  });
});
