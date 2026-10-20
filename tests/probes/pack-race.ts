/**
 * Pack-race simulation shared by the pack probes and the AI tests: a full grid of AI cars races from a standing start,
 * the way the game sets it up. Counts car-to-car contacts, wall hits, off-track time, resets and overtakes per car.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { AIDriver } from '../../src/ai';
import { CARS, getCar } from '../../src/cars';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import type { Difficulty, TrackFrame, TrackPoint } from '../../src/core/contracts';
import { CarDamage, ImpactObserver, hullOf } from '../../src/core/damage';
import { mechanicalProfile, mechanicalWorst, type MechState } from '../../src/core/mechanical';
import { NitroTank } from '../../src/core/nitro';
import { MechLink } from '../../src/game/mechsync';
import { PhysicsWorld, type Vehicle } from '../../src/physics';
import { loadTrackRuntime } from '../../src/track';

const DT = 1 / 60;

export interface PackResult {
  rows: string[];
  contacts: number;
  hardContacts: number;
  walls: number;
  resets: number;
  offTrack: number;
  overtakes: number;
  finished: number;
  winnerTime: number;
  perCar: { model: string; off: number; walls: number; hits: number; hard: number; resets: number }[];
  /** Damage: Full only: hits that moved the mechanics, and the worst part (0..1) on any car at the end */
  mechHits?: number;
  worstWear?: number;
  /** the damage each car had at the end, 0..1 (the worst part) */
  wear?: number[];
  /** Nitro (opts.nitro): shots fired, in all and by each car */
  nitroShots?: number;
  nitroPerCar?: number[];
}

export interface PackOptions {
  /** Shifts every driver's AI seed (a different race with the same grid). */
  seed?: number;
  /** Water on the track 0..1; defaults to the WET environment variable. */
  wetness?: number;
  /**
   * Damage: Full, as the game does it: each car's impacts are folded into a CarDamage every frame (the way the car visual does)
   * and what that did to the mechanics goes on its physics and its driver.
   */
  full?: boolean;
  /** The mechanical damage each car starts the race with (index = grid slot; implies `full`): put into its record before the start. */
  initial?: (i: number) => MechState | null;
  /** The drivers are not told about the damage on their cars (their physics is). */
  blind?: boolean;
  /** Nitro, as the game does it: every car carries a NitroTank, refilled each lap, and its driver fires the shots. */
  nitro?: boolean;
}

export function runPack(trackId: string, carSpec: string, diff: Difficulty, n: number, laps: number, log = false, opts: PackOptions = {}): PackResult {
  const track = loadTrackRuntime(trackId);
  const world = new PhysicsWorld(track);
  const wetness = opts.wetness ?? +(process.env.WET ?? 0);
  world.wetness = wetness;
  const frame: TrackFrame = { position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 };
  const m4 = new Matrix4();
  const place = (v: Vehicle, s: number, d: number, speed: number) => {
    track.frameAt(track.wrapS(s), frame);
    const q = new Quaternion().setFromRotationMatrix(m4.makeBasis(frame.left, frame.normal, frame.tangent));
    const p = track.pointAt(track.wrapS(s), d, new Vector3());
    v.placeOnGround(p, q, speed);
  };
  const cars: { v: Vehicle; ai: AIDriver; hint: number; prevS: number; crossings: number; lapStart: number; laps: number[]; carHits: number; hardHits: number; wallHits: number; seenImpact: number; wasOff: boolean; resets: number; off: number; finished: boolean; finishT: number }[] = [];
  for (let i = 0; i < n; i++) {
    const def = carSpec === 'mixed' ? CARS[i % CARS.length] : getCar(carSpec);
    const v = world.addVehicle(def);
    v.assists = process.env.ASSISTS === 'player' ? { ...DEFAULT_SETTINGS.assists } : { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
    const g = track.grid[Math.min(i, track.grid.length - 1)];
    if (i < track.grid.length) v.placeOnGround(g.position, g.quaternion, 0);
    else place(v, g.s - 8 * (i - track.grid.length + 1), g.d, 0);
    v.setTemperatures(0.8);
    v.holdOnGrid = true;
    const d = i === n - 1 && process.env.LASTDIFF ? (process.env.LASTDIFF as Difficulty) : diff;
    const ai = new AIDriver(track, def, { difficulty: d, seed: v.id * 17 + i + (opts.seed ?? 0) * 101, wetness });
    cars.push({ v, ai, hint: -1, prevS: 0, crossings: 0, lapStart: 0, laps: [], carHits: 0, hardHits: 0, wallHits: 0, resets: 0, off: 0, finished: false, finishT: 0, seenImpact: 0, wasOff: false });
  }
  // Damage: Full: the record of each car (what its visual keeps), the observer that feeds it, and the link to its physics and driver
  const records = opts.full || opts.initial
    ? cars.map((c, i) => {
        const def = c.v.def;
        const dmg = new CarDamage(hullOf(def.visual), { surfacePoint: (p) => [p[0], 0.5, p[2]], lamps: [] }, mechanicalProfile(def));
        const obs = new ImpactObserver(dmg.hull);
        obs.otherAt = (x, y, z) => {
          let best = 16;
          let found: Vehicle | undefined;
          for (const o of cars) {
            if (o === c) continue;
            const d2 = (o.v.state.position.x - x) ** 2 + (o.v.state.position.y - y) ** 2 + (o.v.state.position.z - z) ** 2;
            if (d2 < best) {
              best = d2;
              found = o.v;
            }
          }
          return found ? { paint: 0xffffff, vx: found.state.velocity.x, vy: found.state.velocity.y, vz: found.state.velocity.z } : undefined;
        };
        const start = opts.initial?.(i);
        if (start) {
          dmg.mech.front = start.front;
          dmg.mech.rear = start.rear;
          for (let w = 0; w < 4; w++) dmg.mech.wheel[w] = start.wheel[w];
          dmg.mech.version++;
        }
        const link = new MechLink(opts.blind ? [c.v] : [c.v, c.ai]);
        // (the damage a car starts with is on it from the first step: the game would have it from the frame after the hit)
        link.update(dmg.mech, true);
        return { dmg, obs, link, i };
      })
    : [];
  let mechHits = 0;
  const tanks = opts.nitro ? cars.map(() => new NitroTank()) : null;
  const shots = new Array<number>(n).fill(0);
  const tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
  for (const c of cars) {
    c.hint = track.project(c.v.p.x, c.v.p.z, tp, c.hint);
    c.prevS = tp.s;
  }
  const states = world.states;
  const goAt = 6;
  let racing = false;
  let order: number[] = cars.map((_, i) => i);
  let overtakes = 0;
  const dist = new Float64Array(n);
  const events: string[] = [];
  let finishedCount = 0;
  let winnerTime = 0;
  const limit = goAt + 400 * laps;
  while (world.time < limit && finishedCount < n) {
    if (!racing && world.time >= goAt) {
      racing = true;
      for (const c of cars) {
        c.v.holdOnGrid = false;
        c.lapStart = world.time;
      }
    }
    for (let i = 0; i < n; i++) {
      const c = cars[i];
      const tank = tanks?.[i];
      if (tank) {
        c.ai.nitroReady = tank.ready;
        c.ai.nitroOn = tank.active;
      }
      c.ai.update(DT, c.v.state, states, c.v.controls, racing);
      if (tank && c.ai.wantNitro && tank.fire()) {
        shots[i]++;
        if (log) events.push(`t=${world.time.toFixed(1)} car${c.v.id} NITRO s=${c.ai.s.toFixed(0)} v=${(c.v.state.speed * 3.6).toFixed(0)}`);
      }
      if (c.ai.needsReset) {
        if (!c.finished) c.resets++;
        track.project(c.v.p.x, c.v.p.z, tp);
        const d = Math.max(-tp.widthRight + 1.5, Math.min(tp.widthLeft - 1.5, tp.d));
        place(c.v, tp.s - 4, d, 0);
        c.ai.onReset();
        tank?.cancel();
        if (log) events.push(`t=${world.time.toFixed(1)} reset car${c.v.id}`);
      }
    }
    if (tanks) {
      for (let i = 0; i < n; i++) {
        tanks[i].update(DT, cars[i].crossings, racing && !cars[i].finished);
        cars[i].v.nitro = tanks[i].level;
      }
    }
    world.step(DT);
    for (const r of records) {
      const before = r.dmg.mech.version;
      r.obs.update(cars[r.i].v.state, DT, (e) => r.dmg.apply(e));
      if (r.dmg.mech.version !== before) mechHits++;
      r.link.update(r.dmg.mech, true);
    }
    const tr = process.env.TRACE ? process.env.TRACE.split(',').map(Number) : null; // carId,from,to
    if (tr && world.time > tr[1] && world.time < tr[2] && Math.round(world.time * 60) % 3 === 0) {
      const c = cars.find((x) => x.v.id === tr[0])!;
      const st = c.v.state;
      const sl = st.wheels.map((w) => (w.slipAngle * 57.3).toFixed(0)).join('/');
      events.push(`T t=${world.time.toFixed(2)} s=${c.ai.s.toFixed(0)} d=${c.ai.d.toFixed(2)} v=${(st.speed * 3.6).toFixed(0)} thr=${c.v.controls.throttle.toFixed(2)} brk=${c.v.controls.brake.toFixed(2)} steer=${c.v.controls.steer.toFixed(2)} slip=${sl} gLat=${(st.localAccel.x / 9.81).toFixed(2)} ${c.ai.debugTraffic} ${c.ai.debug}`);
    }
    for (let i = 0; i < n; i++) {
      const c = cars[i];
      const st = c.v.state;
      // impacts count only while the car is still racing
      if (!c.finished && st.impactCount !== c.seenImpact) {
        c.seenImpact = st.impactCount;
        if (st.lastImpact.kind === 'car') {
          c.carHits++;
          if (st.lastImpact.strength > 3) c.hardHits++;
          if (log && st.lastImpact.strength > +(process.env.HITMIN ?? 3)) events.push(`t=${world.time.toFixed(2)} car${c.v.id} ${c.v.def.id} hit car (${st.lastImpact.strength.toFixed(1)} m/s) s=${c.ai.s.toFixed(0)} d=${c.ai.d.toFixed(1)}`);
        } else {
          c.wallHits++;
          if (log) events.push(`t=${world.time.toFixed(1)} car${c.v.id} hit ${st.lastImpact.kind} (${st.lastImpact.strength.toFixed(1)} m/s) s=${c.ai.s.toFixed(0)} d=${c.ai.d.toFixed(1)}`);
        }
      }
      c.hint = track.project(c.v.p.x, c.v.p.z, tp, c.hint);
      const isOff = !c.finished && (tp.d > tp.widthLeft + 0.8 || tp.d < -tp.widthRight - 0.8);
      if (isOff) {
        if (log && !c.wasOff) events.push(`t=${world.time.toFixed(1)} car${c.v.id} ${c.v.def.id} OFF s=${tp.s.toFixed(0)} d=${tp.d.toFixed(1)} wL=${tp.widthLeft.toFixed(1)} wR=${tp.widthRight.toFixed(1)} v=${(st.speed * 3.6).toFixed(0)} ${c.ai.debugTraffic}`);
        c.off += DT;
      }
      c.wasOff = isOff;
      let ds = tp.s - c.prevS;
      if (ds < -track.length / 2) {
        ds += track.length;
        c.crossings++;
        if (c.crossings >= 2 && !c.finished) c.laps.push(world.time - c.lapStart);
        if (c.crossings >= 1) c.lapStart = world.time;
        if (c.crossings > laps && !c.finished) {
          c.finished = true;
          c.finishT = world.time - goAt;
          finishedCount++;
          if (finishedCount === 1) winnerTime = c.finishT;
        }
      } else if (ds > track.length / 2) {
        ds -= track.length;
        c.crossings--;
      }
      c.prevS = tp.s;
      dist[i] = (c.crossings - 1) * track.length + tp.s;
    }
    if (racing) {
      const next = cars.map((_, i) => i).sort((a, b) => dist[b] - dist[a]);
      // overtakes: count pairs that swapped order (finished cars excluded)
      for (let k = 0; k < n - 1; k++) {
        if (next[k] !== order[k] && order.indexOf(next[k]) > k && !cars[next[k]].finished) {
          overtakes++;
          break;
        }
      }
      order = next;
    }
  }
  const fmt = (x: number) => { const c = Math.round(x * 100); return `${Math.floor(c / 6000)}:${((c % 6000) / 100).toFixed(2).padStart(5, '0')}`; };
  const rows = [`${trackId} ${carSpec} ${diff} N=${n} laps=${laps}  winner ${fmt(winnerTime)}  finished ${finishedCount}/${n}  overtakes ${overtakes}`];
  let contacts = 0, hard = 0, walls = 0, resets = 0, offTrack = 0;
  order.forEach((i, pos) => {
    const c = cars[i];
    contacts += c.carHits;
    hard += c.hardHits;
    walls += c.wallHits;
    resets += c.resets;
    offTrack += c.off;
    rows.push(`  P${pos + 1} car${c.v.id} ${c.v.def.id.padEnd(10)} grid ${i + 1}  laps ${c.laps.map(fmt).join(' ')}  carHits ${c.carHits} (hard ${c.hardHits})  walls ${c.wallHits}  off ${c.off.toFixed(1)}s  resets ${c.resets}`);
  });
  rows.push(`  TOTAL carHits ${contacts} hard ${hard} walls ${walls} off ${offTrack.toFixed(1)}s resets ${resets}${tanks ? `  nitro shots ${shots.reduce((a, b) => a + b, 0)}` : ''}`);
  if (log) rows.push(...events.slice(0, process.env.TRACE ? 400 : 80));
  const perCar = cars.map((c) => ({ model: c.v.def.id, off: c.off, walls: c.wallHits, hits: c.carHits, hard: c.hardHits, resets: c.resets }));
  const res: PackResult = { rows, contacts, hardContacts: hard, walls, resets, offTrack, overtakes, finished: finishedCount, winnerTime, perCar };
  if (tanks) {
    res.nitroShots = shots.reduce((a, b) => a + b, 0);
    res.nitroPerCar = shots;
  }
  if (opts.full || opts.initial) {
    res.mechHits = mechHits;
    res.wear = records.map((r) => mechanicalWorst(r.dmg.mech));
    res.worstWear = Math.max(0, ...res.wear);
  }
  return res;
}

