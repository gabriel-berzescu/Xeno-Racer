/**
 * On-demand probe (WXRACE=1 npx vitest run tests/probes/weather-race.test.ts): a full grid of AI cars races through weather that
 * changes, driven exactly as the game drives it (the director calls the change at the leader's progress, the water on the road
 * goes to the physics every frame, and the drivers are told about it one a frame, a couple of hundredths at a time). It prints a
 * table of how clean the racing stays in each phase of the change (before the call, the sky closing, the rain building, the wet
 * road), and the same race with drivers that never learn that it rains (the control), so that the adaptation is measured.
 *
 *   WXRACE=1 WXTRACK=aurelia WXFORECAST=rainLater WXSEED=3 WXLAPS=3 WXN=8 npx vitest run tests/probes/weather-race.test.ts
 *
 * The table is printed and written to .cache/weather-race-<track>-<forecast>.txt.
 *
 * Env: WXTRACK (aurelia|kuroyama|brennwald|portovela, or all), WXFORECAST (rainLater|clearing|both), WXWEATHER (start weather;
 * clear / rain by default), WXSEED, WXLAPS, WXN (cars), WXDIFF (rookie|amateur|pro|alien), WXCAR, WXCONTROL=0 to skip the control.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { AIDriver } from '../../src/ai';
import { getCar } from '../../src/cars';
import type { Difficulty, TrackFrame, TrackPoint, Weather } from '../../src/core/contracts';
import { PhysicsWorld, type Vehicle } from '../../src/physics';
import { loadTrackRuntime } from '../../src/track';
import { makePlan, WeatherDirector, type WeatherPlan } from '../../src/game/weather';

const DT = 1 / 60;
const PHASES = ['before the call', 'call to first drops / easing', 'rain building / easing', 'after: wet / drying road'] as const;

interface Row {
  secs: number;
  off: number;
  walls: number;
  hits: number;
  hard: number;
  resets: number;
  avgKmh: number;
  n: number;
}

interface Result {
  phases: Row[];
  laps: { car: number; lap: number; time: number; wet: number }[];
  finished: number;
  raceTime: number;
  callAt: number;
}

const fmt = (x: number): string => {
  const c = Math.round(x * 100);
  return `${Math.floor(c / 6000)}:${((c % 6000) / 100).toFixed(2).padStart(5, '0')}`;
};

function run(trackId: string, plan: WeatherPlan, laps: number, n: number, diff: Difficulty, carId: string, seed: number, adapt: boolean): Result {
  const track = loadTrackRuntime(trackId);
  const world = new PhysicsWorld(track);
  const dir = new WeatherDirector(plan);
  const wet0 = dir.state.wetness;
  world.wetness = wet0;
  const frame: TrackFrame = { position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 };
  const m4 = new Matrix4();
  const place = (v: Vehicle, s: number, d: number, speed: number): void => {
    track.frameAt(track.wrapS(s), frame);
    const q = new Quaternion().setFromRotationMatrix(m4.makeBasis(frame.left, frame.normal, frame.tangent));
    v.placeOnGround(track.pointAt(track.wrapS(s), d, new Vector3()), q, speed);
  };
  const def = getCar(carId);
  const cars: { v: Vehicle; ai: AIDriver; hint: number; prevS: number; crossings: number; lapStart: number; lapWet: number; seenImpact: number; wasOff: boolean; finished: boolean; told: number }[] = [];
  for (let i = 0; i < n; i++) {
    const v = world.addVehicle(def);
    v.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
    const g = track.grid[Math.min(i, track.grid.length - 1)];
    if (i < track.grid.length) v.placeOnGround(g.position, g.quaternion, 0);
    else place(v, g.s - 8 * (i - track.grid.length + 1), g.d, 0);
    v.setTemperatures(0.8);
    v.holdOnGrid = true;
    const ai = new AIDriver(track, def, { difficulty: diff, seed: v.id * 17 + i + seed * 101, wetness: wet0 });
    if (adapt) ai.prepareWeather();
    cars.push({ v, ai, hint: -1, prevS: 0, crossings: 0, lapStart: 0, lapWet: wet0, seenImpact: 0, wasOff: false, finished: false, told: wet0 });
  }
  const tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
  for (const c of cars) {
    c.hint = track.project(c.v.p.x, c.v.p.z, tp, c.hint);
    c.prevS = tp.s;
  }
  const phases: Row[] = PHASES.map(() => ({ secs: 0, off: 0, walls: 0, hits: 0, hard: 0, resets: 0, avgKmh: 0, n: 0 }));
  const lapsOut: Result['laps'] = [];
  const states = world.states;
  const goAt = 6;
  let racing = false;
  let finishedCount = 0;
  let raceTime = 0;
  let callAt = -1;
  const dist = new Float64Array(n);
  const limit = goAt + 420 * laps;
  const total = laps * track.length;
  while (world.time < limit && finishedCount < n) {
    if (!racing && world.time >= goAt) {
      racing = true;
      for (const c of cars) {
        c.v.holdOnGrid = false;
        c.lapStart = world.time;
      }
    }
    // the weather, as the game runs it
    let lead = -Infinity;
    for (let i = 0; i < n; i++) if (dist[i] > lead) lead = dist[i];
    dir.update(DT, racing ? lead / total : -1, racing ? world.time - goAt : 0);
    if (dir.called && callAt < 0) callAt = world.time - goAt;
    world.wetness = dir.state.wetness;
    if (adapt) {
      let budget = 1;
      for (const c of cars) {
        if (budget > 0 && Math.abs(dir.state.wetness - c.told) >= 0.02) {
          c.told = dir.state.wetness;
          budget--;
          c.ai.setWetness(dir.state.wetness);
        }
      }
    }
    const pl = dir.plan!;
    const ph = !dir.called ? 0 : dir.elapsed < pl.lead ? 1 : dir.elapsed < pl.lead + pl.span ? 2 : 3;
    const row = phases[ph];
    if (racing) row.secs += DT;
    for (const c of cars) {
      c.ai.update(DT, c.v.state, states, c.v.controls, racing);
      if (c.ai.needsReset) {
        if (!c.finished && racing) row.resets++;
        track.project(c.v.p.x, c.v.p.z, tp);
        const d = Math.max(-tp.widthRight + 1.5, Math.min(tp.widthLeft - 1.5, tp.d));
        place(c.v, tp.s - 4, d, 0);
        c.ai.onReset();
      }
    }
    world.step(DT);
    for (let i = 0; i < n; i++) {
      const c = cars[i];
      const st = c.v.state;
      c.lapWet = Math.max(c.lapWet, world.wetness);
      if (!c.finished && racing && st.impactCount !== c.seenImpact) {
        c.seenImpact = st.impactCount;
        if (st.lastImpact.kind === 'car') {
          row.hits++;
          if (st.lastImpact.strength > 3) row.hard++;
        } else row.walls++;
      }
      c.hint = track.project(c.v.p.x, c.v.p.z, tp, c.hint);
      const isOff = !c.finished && racing && (tp.d > tp.widthLeft + 0.8 || tp.d < -tp.widthRight - 0.8);
      if (isOff) row.off += DT;
      c.wasOff = isOff;
      if (racing && !c.finished) {
        row.avgKmh += st.speed * 3.6;
        row.n++;
      }
      let ds = tp.s - c.prevS;
      if (ds < -track.length / 2) {
        ds += track.length;
        c.crossings++;
        if (c.crossings >= 2 && !c.finished) lapsOut.push({ car: c.v.id, lap: c.crossings - 1, time: world.time - c.lapStart, wet: c.lapWet });
        if (c.crossings >= 1) {
          c.lapStart = world.time;
          c.lapWet = world.wetness;
        }
        if (c.crossings > laps && !c.finished) {
          c.finished = true;
          finishedCount++;
          if (finishedCount === 1) raceTime = world.time - goAt;
        }
      } else if (ds > track.length / 2) {
        ds -= track.length;
        c.crossings--;
      }
      c.prevS = tp.s;
      dist[i] = (c.crossings - 1) * track.length + tp.s;
    }
  }
  return { phases, laps: lapsOut, finished: finishedCount, raceTime, callAt };
}

function table(title: string, a: Result, control: Result | null): string[] {
  const out = [title];
  const line = (name: string, r: Row, tag: string): string =>
    `    ${tag.padEnd(8)} ${name.padEnd(26)} ${r.secs.toFixed(0).padStart(5)} s  avg ${(r.n ? r.avgKmh / r.n : 0).toFixed(0).padStart(3)} km/h  off ${r.off.toFixed(1).padStart(5)} s  walls ${String(r.walls).padStart(2)}  car hits ${String(r.hits).padStart(2)} (hard ${r.hard})  resets ${r.resets}`;
  PHASES.forEach((name, i) => {
    if (a.phases[i].secs < 0.5 && (!control || control.phases[i].secs < 0.5)) return;
    out.push(line(name, a.phases[i], 'adapts'));
    if (control) out.push(line(name, control.phases[i], 'control'));
  });
  const sum = (r: Result): string => {
    const t = r.phases.reduce((s, p) => ({ off: s.off + p.off, walls: s.walls + p.walls, hits: s.hits + p.hits, resets: s.resets + p.resets }), { off: 0, walls: 0, hits: 0, resets: 0 });
    return `off ${t.off.toFixed(1)} s, walls ${t.walls}, car hits ${t.hits}, resets ${t.resets}, finished ${r.finished}, winner ${fmt(r.raceTime)}`;
  };
  out.push(`    TOTAL adapts: ${sum(a)}`);
  if (control) out.push(`    TOTAL control: ${sum(control)}`);
  // lap times by lap number, the field's median, with the water the road had in it
  const byLap = new Map<number, { t: number[]; w: number[] }>();
  for (const l of a.laps) {
    const e = byLap.get(l.lap) ?? { t: [], w: [] };
    e.t.push(l.time);
    e.w.push(l.wet);
    byLap.set(l.lap, e);
  }
  const med = (x: number[]): number => x.slice().sort((p, q) => p - q)[x.length >> 1];
  out.push('    lap  median time  water on the road during the lap (median of the most per car)');
  for (const [lap, e] of [...byLap.entries()].sort((p, q) => p[0] - q[0])) out.push(`    ${String(lap).padStart(3)}  ${fmt(med(e.t))}      ${med(e.w).toFixed(2)}`);
  return out;
}

const on = !!process.env.WXRACE;

describe.skipIf(!on)('AI through weather that changes (probe)', () => {
  const tracks = process.env.WXTRACK && process.env.WXTRACK !== 'all' ? process.env.WXTRACK.split(',') : ['aurelia', 'kuroyama', 'brennwald'];
  const kinds = process.env.WXFORECAST === 'rainLater' ? ['rainLater'] : process.env.WXFORECAST === 'clearing' ? ['clearing'] : ['rainLater', 'clearing'];
  const seed = +(process.env.WXSEED ?? 3);
  const laps = +(process.env.WXLAPS ?? 3);
  const n = +(process.env.WXN ?? 8);
  const diff = (process.env.WXDIFF ?? 'pro') as Difficulty;
  const car = process.env.WXCAR ?? 'vanta-gt';
  for (const trackId of tracks) {
    for (const kind of kinds) {
      it(`${trackId} ${kind}`, { timeout: 1_200_000 }, () => {
        const weather: Weather = (process.env.WXWEATHER as Weather | undefined) ?? (kind === 'rainLater' ? 'clear' : 'rain');
        const plan = makePlan({ forecast: kind as 'rainLater' | 'clearing', weather, mode: 'race', laps, seed })!;
        const a = run(trackId, plan, laps, n, diff, car, seed, true);
        const c = process.env.WXCONTROL === '0' ? null : run(trackId, plan, laps, n, diff, car, seed, false);
        const head = `${trackId} ${car} ${diff} N=${n} laps=${laps}  ${kind} ${plan.from} -> ${plan.to}  seed ${seed}  call at ${a.callAt.toFixed(0)} s, lead ${plan.lead.toFixed(0)} s, span ${plan.span.toFixed(0)} s`;
        const text = table(head, a, c).join('\n');
        mkdirSync('.cache', { recursive: true });
        writeFileSync(`.cache/weather-race-${trackId}-${kind}.txt`, text + '\n');
        console.log(text);
      });
    }
  }
});
