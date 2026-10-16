/**
 * Damage calibration probe: what do the physics' impact strengths look like for real hits?
 *
 *   DMG=1 npx vitest run tests/damage-probe.test.ts        → .cache/dmg/probe-*.txt
 *
 * Scenarios: a car coasting into the barrier at a set speed and angle, one car running into another, and
 * AI packs racing (the way the game sets them up). Skipped unless DMG is set.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { it } from 'vitest';
import { AIDriver } from '../src/ai';
import { CARS, getCar } from '../src/cars';
import type { CarDefinition, Difficulty, TrackFrame, TrackPoint, VehicleState } from '../src/core/contracts';
import { PhysicsWorld, type Vehicle } from '../src/physics';
import { loadTrackRuntime } from '../src/track';

const OUT = '.cache/dmg';

interface Hit {
  car: number;
  t: number;
  kind: string;
  strength: number;
  speedKmh: number;
  /** body-frame point / normal at the observation */
  px: number; py: number; pz: number;
  nx: number; ny: number; nz: number;
  other: number;
}

const _q = new Quaternion();
const _v = new Vector3();

/** World point -> body frame (origin on the ground between the axles, +Z forward, +X left). */
function toBody(def: CarDefinition, st: VehicleState, p: Vector3, out: Vector3): Vector3 {
  const v = def.visual;
  _q.copy(st.quaternion).invert();
  out.copy(p).sub(st.position).applyQuaternion(_q);
  out.y += v.cgHeight;
  out.z += v.cgToFrontAxle - v.wheelbase / 2;
  return out;
}
function dirToBody(st: VehicleState, d: Vector3, out: Vector3): Vector3 {
  _q.copy(st.quaternion).invert();
  return out.copy(d).applyQuaternion(_q);
}

const frame: TrackFrame = { position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 };
const m4 = new Matrix4();

function placeAt(world: PhysicsWorld, v: Vehicle, s: number, d: number, speedMs: number, yaw = 0): void {
  const tr = world.track;
  tr.frameAt(tr.wrapS(s), frame);
  const q = new Quaternion().setFromRotationMatrix(m4.makeBasis(frame.left, frame.normal, frame.tangent));
  q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw));
  const p = tr.pointAt(tr.wrapS(s), d, new Vector3());
  v.placeOnGround(p, q, speedMs);
}

function fmt(h: Hit): string {
  return `${h.kind.padEnd(6)} str ${h.strength.toFixed(2).padStart(6)}  v ${h.speedKmh.toFixed(0).padStart(4)} km/h  p(${h.px.toFixed(2)},${h.py.toFixed(2)},${h.pz.toFixed(2)}) n(${h.nx.toFixed(2)},${h.ny.toFixed(2)},${h.nz.toFixed(2)})`;
}

/** Coast into the left barrier at `kmh` and `deg` off parallel; log every registered impact in the next 2 s. */
function wallScenario(def: CarDefinition, kmh: number, deg: number, fine: boolean): Hit[] {
  const track = loadTrackRuntime('aurelia');
  const world = new PhysicsWorld(track);
  const v = world.addVehicle(def);
  v.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  const s = 600; // a straight stretch
  const tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
  track.project(track.pointAt(s, 0, new Vector3()).x, track.pointAt(s, 0, new Vector3()).z, tp);
  const wallL = tp.wallLeft;
  // start so that the nose reaches the wall after ~ 25 m of travel
  const yaw = (deg * Math.PI) / 180;
  const lateral = Math.sin(yaw) * 25;
  const d0 = Math.max(-tp.wallRight + 2.5, wallL - 2.4 - lateral);
  placeAt(world, v, s, d0, kmh / 3.6, yaw);
  v.setTemperatures(1);
  const hits: Hit[] = [];
  let seen = v.state.impactCount;
  const dt = fine ? 1 / 1000 : 1 / 60;
  const pb = new Vector3();
  const nb = new Vector3();
  for (let i = 0; i < 2.5 / dt; i++) {
    world.step(dt);
    const st = v.state;
    if (st.impactCount !== seen) {
      seen = st.impactCount;
      toBody(def, st, st.lastImpact.point, pb);
      dirToBody(st, st.lastImpact.normal, nb);
      hits.push({ car: 0, t: world.time, kind: st.lastImpact.kind, strength: st.lastImpact.strength, speedKmh: st.speed * 3.6, px: pb.x, py: pb.y, pz: pb.z, nx: nb.x, ny: nb.y, nz: nb.z, other: -1 });
    }
  }
  return hits;
}

/** Car B runs into the back of car A (parked, 120 m apart) at closing speed `closing` m/s, with `lateral` m of offset. */
function carScenario(def: CarDefinition, closing: number, lateral: number, sideways = 0, fine = true): Hit[] {
  const track = loadTrackRuntime('aurelia');
  const world = new PhysicsWorld(track);
  const a = world.addVehicle(def);
  const b = world.addVehicle(def);
  for (const v of [a, b]) v.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  placeAt(world, a, 620, 0, 0);
  placeAt(world, b, 620 - 22, lateral, closing, sideways);
  a.holdOnGrid = true;
  const hits: Hit[] = [];
  const seen = [a.state.impactCount, b.state.impactCount];
  const dt = fine ? 1 / 1000 : 1 / 60;
  const pb = new Vector3();
  const nb = new Vector3();
  for (let i = 0; i < 2 / dt; i++) {
    world.step(dt);
    [a, b].forEach((v, k) => {
      const st = v.state;
      if (st.impactCount !== seen[k]) {
        seen[k] = st.impactCount;
        toBody(def, st, st.lastImpact.point, pb);
        dirToBody(st, st.lastImpact.normal, nb);
        hits.push({ car: k, t: world.time, kind: st.lastImpact.kind, strength: st.lastImpact.strength, speedKmh: st.speed * 3.6, px: pb.x, py: pb.y, pz: pb.z, nx: nb.x, ny: nb.y, nz: nb.z, other: 1 - k });
      }
    });
  }
  return hits;
}

it.skipIf(!process.env.DMG)('wall hits at speeds and angles (DMG=1)', () => {
  mkdirSync(OUT, { recursive: true });
  const out: string[] = [];
  for (const id of ['vanta-gt', 'lmp-x']) {
    const def = getCar(id);
    out.push(`== ${id}: coast into the barrier (sub-step observation | 60 fps observation)`);
    for (const kmh of [30, 60, 100, 150, 200]) {
      for (const deg of [4, 10, 25, 50, 85]) {
        const fine = wallScenario(def, kmh, deg, true);
        const coarse = wallScenario(def, kmh, deg, false);
        out.push(`v=${String(kmh).padStart(3)} km/h  angle ${String(deg).padStart(2)}°  impacts ${fine.length}/${coarse.length}`);
        fine.slice(0, 3).forEach((h) => out.push('   fine   ' + fmt(h)));
        coarse.slice(0, 3).forEach((h) => out.push('   coarse ' + fmt(h)));
      }
    }
  }
  writeFileSync(`${OUT}/probe-wall.txt`, out.join('\n') + '\n');
}, 900000);

it.skipIf(!process.env.DMG)('car to car contacts (DMG=1)', () => {
  mkdirSync(OUT, { recursive: true });
  const out: string[] = [];
  const def = getCar('kestrel-r');
  out.push('== rear-end shunts (B into the back of a parked A), closing speed m/s, lateral offset m');
  for (const closing of [2, 4, 8, 15, 25, 40]) {
    for (const lat of [0, 0.7, 1.4]) {
      const hits = carScenario(def, closing, lat);
      out.push(`closing ${closing} m/s  offset ${lat}  impacts ${hits.length}`);
      hits.slice(0, 4).forEach((h) => out.push(`   car${h.car} ` + fmt(h)));
    }
  }
  out.push('== sideswipe: B alongside A drifting in at a yaw angle');
  for (const speed of [15, 30, 50]) {
    for (const yawDeg of [1, 3, 8]) {
      const hits = carScenario(def, speed, 1.75, (yawDeg * Math.PI) / 180);
      out.push(`speed ${speed} m/s  yaw ${yawDeg}°  impacts ${hits.length}`);
      hits.slice(0, 4).forEach((h) => out.push(`   car${h.car} ` + fmt(h)));
    }
  }
  writeFileSync(`${OUT}/probe-car.txt`, out.join('\n') + '\n');
}, 900000);

/** An AI pack, set up like the game does it; every impact is logged with its body-frame geometry. */
function pack(trackId: string, carSpec: string, diff: Difficulty, n: number, laps: number): { hits: Hit[]; seconds: number; resets: number } {
  const DT = 1 / 60;
  const track = loadTrackRuntime(trackId);
  const world = new PhysicsWorld(track);
  const cars: { v: Vehicle; ai: AIDriver; def: CarDefinition; seen: number }[] = [];
  for (let i = 0; i < n; i++) {
    const def = carSpec === 'mixed' ? CARS[i % CARS.length] : getCar(carSpec);
    const v = world.addVehicle(def);
    v.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
    const g = track.grid[Math.min(i, track.grid.length - 1)];
    if (i < track.grid.length) v.placeOnGround(g.position, g.quaternion, 0);
    else placeAt(world, v, g.s - 8 * (i - track.grid.length + 1), g.d, 0);
    v.setTemperatures(0.8);
    v.holdOnGrid = true;
    cars.push({ v, def, ai: new AIDriver(track, def, { difficulty: diff, seed: v.id * 17 + i, wetness: 0 }), seen: 0 });
  }
  const tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
  const states = world.states;
  const goAt = 6;
  let racing = false;
  const hits: Hit[] = [];
  let resets = 0;
  const pb = new Vector3();
  const nb = new Vector3();
  const limit = goAt + (track.length / 55) * laps + 20;
  while (world.time < limit) {
    if (!racing && world.time >= goAt) {
      racing = true;
      for (const c of cars) c.v.holdOnGrid = false;
    }
    for (const c of cars) {
      c.ai.update(DT, c.v.state, states, c.v.controls, racing);
      if (c.ai.needsReset) {
        resets++;
        track.project(c.v.p.x, c.v.p.z, tp);
        const d = Math.max(-tp.widthRight + 1.5, Math.min(tp.widthLeft - 1.5, tp.d));
        placeAt(world, c.v, tp.s - 4, d, 0);
        c.ai.onReset();
      }
    }
    world.step(DT);
    cars.forEach((c, i) => {
      const st = c.v.state;
      if (st.impactCount !== c.seen) {
        c.seen = st.impactCount;
        toBody(c.def, st, st.lastImpact.point, pb);
        dirToBody(st, st.lastImpact.normal, nb);
        let other = -1;
        if (st.lastImpact.kind === 'car') {
          let best = 1e9;
          cars.forEach((o, j) => {
            if (j === i) return;
            const d = o.v.state.position.distanceTo(st.lastImpact.point);
            if (d < best) {
              best = d;
              other = j;
            }
          });
        }
        hits.push({ car: i, t: world.time - goAt, kind: st.lastImpact.kind, strength: st.lastImpact.strength, speedKmh: st.speed * 3.6, px: pb.x, py: pb.y, pz: pb.z, nx: nb.x, ny: nb.y, nz: nb.z, other });
      }
    });
  }
  return { hits, seconds: world.time - goAt, resets };
}

function quantile(a: number[], q: number): number {
  if (!a.length) return 0;
  const b = a.slice().sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(q * b.length))];
}

it.skipIf(!process.env.DMG)('AI pack impacts (DMG=1)', () => {
  mkdirSync(OUT, { recursive: true });
  const out: string[] = [];
  const all: Hit[] = [];
  const tracks = (process.env.TRACKS ?? 'aurelia,kuroyama,brennwald').split(',');
  const diffs = (process.env.DIFFS ?? 'pro,alien').split(',') as Difficulty[];
  const laps = +(process.env.LAPS ?? 2);
  const n = +(process.env.N ?? 12);
  for (const t of tracks) {
    for (const d of diffs) {
      for (const c of ['mixed']) {
        const r = pack(t, c, d, n, laps);
        const per = new Map<number, Hit[]>();
        for (const h of r.hits) {
          if (!per.has(h.car)) per.set(h.car, []);
          per.get(h.car)!.push(h);
        }
        const wall = r.hits.filter((h) => h.kind === 'wall');
        const car = r.hits.filter((h) => h.kind === 'car');
        const gnd = r.hits.filter((h) => h.kind === 'ground');
        out.push(`${t} ${d} ${c} N=${n} laps=${laps} (${r.seconds.toFixed(0)} s, resets ${r.resets}): wall ${wall.length} car ${car.length} ground ${gnd.length}`);
        const q = (a: Hit[]): string => (a.length ? `p50 ${quantile(a.map((h) => h.strength), 0.5).toFixed(1)} p90 ${quantile(a.map((h) => h.strength), 0.9).toFixed(1)} max ${Math.max(...a.map((h) => h.strength)).toFixed(1)}` : '-');
        out.push(`   wall ${q(wall)} | car ${q(car)} | ground ${q(gnd)}`);
        out.push('   per car (hits wall/car, worst strength): ' + [...per.entries()].map(([k, hs]) => `#${k}:${hs.filter((h) => h.kind === 'wall').length}/${hs.filter((h) => h.kind === 'car').length}@${Math.max(...hs.map((h) => h.strength)).toFixed(0)}`).join('  '));
        all.push(...r.hits);
      }
    }
  }
  const hist = (kind: string): string => {
    const hs = all.filter((h) => h.kind === kind);
    const edges = [0, 1.5, 2.5, 4, 6, 9, 13, 18, 25, 35, 1000];
    const bins = edges.slice(0, -1).map((e, i) => hs.filter((h) => h.strength >= e && h.strength < edges[i + 1]).length);
    return `${kind.padEnd(6)} n=${hs.length}  ` + edges.slice(0, -1).map((e, i) => `[${e}-${edges[i + 1] === 1000 ? '+' : edges[i + 1]}) ${bins[i]}`).join('  ');
  };
  out.push('', 'strength histogram (m/s):', hist('wall'), hist('car'), hist('ground'));
  writeFileSync(`${OUT}/probe-pack.txt`, out.join('\n') + '\n');
  writeFileSync(`${OUT}/probe-pack-hits.json`, JSON.stringify(all));
}, 1800000);
