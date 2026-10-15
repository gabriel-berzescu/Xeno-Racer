/**
 * Pack-race probe: a full grid of AI cars races from a standing start, the way the game sets it up.
 * Counts car-to-car contacts, wall hits, off-track time, resets and overtakes per car.
 *
 *   PACK=1 [TRACK=kuroyama] [CAR=vanta-gt|mixed] [DIFF=pro] [N=8] [LAPS=2] npx vitest run tests/probes/pack.test.ts
 *   → .cache/pack.txt
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { it } from 'vitest';
import { AIDriver } from '../../src/ai';
import { CARS, getCar } from '../../src/cars';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import type { Difficulty, TrackFrame, TrackPoint } from '../../src/core/contracts';
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
}

export function runPack(trackId: string, carSpec: string, diff: Difficulty, n: number, laps: number, log = false): PackResult {
  const track = loadTrackRuntime(trackId);
  const world = new PhysicsWorld(track);
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
    cars.push({ v, ai: new AIDriver(track, def, { difficulty: d, seed: v.id * 17 + i }), hint: -1, prevS: 0, crossings: 0, lapStart: 0, laps: [], carHits: 0, hardHits: 0, wallHits: 0, resets: 0, off: 0, finished: false, finishT: 0, seenImpact: 0, wasOff: false });
  }
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
    for (const c of cars) {
      c.ai.update(DT, c.v.state, states, c.v.controls, racing);
      if (c.ai.needsReset) {
        if (!c.finished) c.resets++;
        track.project(c.v.p.x, c.v.p.z, tp);
        const d = Math.max(-tp.widthRight + 1.5, Math.min(tp.widthLeft - 1.5, tp.d));
        place(c.v, tp.s - 4, d, 0);
        c.ai.onReset();
        if (log) events.push(`t=${world.time.toFixed(1)} reset car${c.v.id}`);
      }
    }
    world.step(DT);
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
          if (log && st.lastImpact.strength > 3) events.push(`t=${world.time.toFixed(1)} car${c.v.id} hit car (${st.lastImpact.strength.toFixed(1)} m/s) s=${c.ai.s.toFixed(0)} d=${c.ai.d.toFixed(1)}`);
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
  const fmt = (x: number) => `${Math.floor(x / 60)}:${(x % 60).toFixed(2).padStart(5, '0')}`;
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
  rows.push(`  TOTAL carHits ${contacts} hard ${hard} walls ${walls} off ${offTrack.toFixed(1)}s resets ${resets}`);
  if (log) rows.push(...events.slice(0, process.env.TRACE ? 400 : 80));
  return { rows, contacts, hardContacts: hard, walls, resets, offTrack, overtakes, finished: finishedCount, winnerTime };
}

it.skipIf(!process.env.PACK)('pack race probe (set PACK=1)', () => {
  const tracks = (process.env.TRACK ?? 'aurelia,kuroyama').split(',');
  const out: string[] = [];
  for (const t of tracks) {
    const r = runPack(t, process.env.CAR ?? 'vanta-gt', (process.env.DIFF as Difficulty) ?? 'pro', +(process.env.N ?? 8), +(process.env.LAPS ?? 2), !!process.env.LOG);
    out.push(...r.rows, '');
  }
  mkdirSync('.cache', { recursive: true });
  writeFileSync('.cache/pack.txt', out.join('\n') + '\n');
}, 900000);

/** Benchmark set: same-car fields like the game races, plus one mixed field, on both tracks. */
it.skipIf(!process.env.PACKSET)('pack race benchmark set (set PACKSET=1)', () => {
  const diff = (process.env.DIFF as Difficulty) ?? 'pro';
  const sets: [string, string, number][] = [];
  for (const t of ['aurelia', 'kuroyama']) {
    for (const c of ['vanta-gt', 'kestrel-r', 'ronin-86', 'lmp-x', 'mixed']) sets.push([t, c, c === 'mixed' ? 12 : 8]);
  }
  const out: string[] = [];
  const tot = { contacts: 0, hard: 0, walls: 0, resets: 0, off: 0, overtakes: 0 };
  for (const [t, c, n] of sets) {
    const r = runPack(t, c, diff, n, 2);
    tot.contacts += r.contacts;
    tot.hard += r.hardContacts;
    tot.walls += r.walls;
    tot.resets += r.resets;
    tot.off += r.offTrack;
    tot.overtakes += r.overtakes;
    out.push(`${t.padEnd(9)} ${c.padEnd(10)} N=${n}  hits ${String(r.contacts).padStart(3)} hard ${String(r.hardContacts).padStart(2)}  walls ${String(r.walls).padStart(2)}  off ${r.offTrack.toFixed(1).padStart(5)}s  resets ${r.resets}  overtakes ${String(r.overtakes).padStart(3)}  winner ${r.winnerTime.toFixed(1)}s  finished ${r.finished}/${n}`);
  }
  out.push(`TOTAL hits ${tot.contacts} hard ${tot.hard} walls ${tot.walls} off ${tot.off.toFixed(1)}s resets ${tot.resets} overtakes ${tot.overtakes}`);
  mkdirSync('.cache', { recursive: true });
  writeFileSync(`.cache/packset-${process.env.TAG ?? 'run'}.txt`, out.join('\n') + '\n');
}, 1800000);
