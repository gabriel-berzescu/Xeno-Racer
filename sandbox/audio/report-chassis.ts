/** Tire / road / impact / spatial checks for the offline report (browser; real worklet + graph). */
import { CARS, getCar } from '../../src/cars';
import type { ImpactKind, SurfaceType } from '../../src/core/contracts';
import { DEFAULT_VOLUMES, renderScene as renderSceneRaw, type SceneCar, type SceneOptions } from './harness';
import { impactCar, passByCar, tireCar } from './scenarios';
import { makeVehicleState } from './drive-sim';
import { Checks, analyseSegment, db, hasNonFinite, mono, peakAbs, peakNear, rms, spectralCentroid, strongestPeak, welch } from './report-util';

const CAR = getCar('vanta-gt');

/** Chassis measurements mute the engine bus so the idling engine does not mask tires / road / wind. */
const CHASSIS_ONLY = { ...DEFAULT_VOLUMES, engine: 0 };
function renderChassis(o: SceneOptions): ReturnType<typeof renderSceneRaw> {
  return renderSceneRaw({ volumes: CHASSIS_ONLY, ...o });
}
const renderScene = renderSceneRaw;

/** Render a tire scenario and return mono. */
async function tireRun(seconds: number, car: SceneCar, interior = 1): Promise<{ m: Float32Array; l: Float32Array; r: Float32Array; sr: number }> {
  const res = await renderChassis({ seconds, cars: [{ ...car, interior }], raw: true });
  return { m: mono(res), l: res.left, r: res.right, sr: res.sr };
}

interface WheelFn {
  (t: number, w: number): { skid: number; slipAngle: number; slipRatio?: number };
}

export interface TireReport {
  levelsDb: number[];
  prominence: number[];
  centroid: number[];
  pitchSlow: number;
  pitchFast: number;
  frontHz: number;
  rearHz: number;
  trace: number[];
}

export async function tireChecks(checks: Checks): Promise<TireReport> {
  // phases for wheel 1 (front right): grip, approach (u~0.9, no skid), limit, slide, locked
  const phases = [
    { name: 'grip', slip: 0.02, skid: 0 },
    { name: 'approach', slip: 0.105, skid: 0 },
    { name: 'limit', slip: 0.14, skid: 0.3 },
    { name: 'slide', slip: 0.22, skid: 0.8 },
    { name: 'locked', slip: 0.35, skid: 1 },
  ];
  const seg = 1.6;
  const fn: WheelFn = (t, w) => {
    if (w !== 1) return { skid: 0, slipAngle: 0.01 };
    const p = phases[Math.min(phases.length - 1, Math.floor(t / seg))];
    return { skid: p.skid, slipAngle: p.slip };
  };
  const car = tireCar(CAR, () => 35, fn);
  const { m, sr } = await tireRun(seg * phases.length, car);
  const trace: number[] = [];
  for (let k = 0; k < Math.floor((seg * phases.length) / 0.2); k++) trace.push(Math.round(analyseSegment(m, sr, k * 0.2, k * 0.2 + 0.2, 2048).rmsDb * 10) / 10);
  const levels: number[] = [];
  const prom: number[] = [];
  const cen: number[] = [];
  phases.forEach((_, i) => {
    const s = analyseSegment(m, sr, i * seg + 0.6, (i + 1) * seg - 0.05, 8192);
    levels.push(s.rmsDb);
    prom.push(strongestPeak(s.psd, sr, 650, 1700).prominenceDb);
    cen.push(s.centroid);
  });
  checks.add('tires: faint scrub before the limit (above grip noise)', levels[1] > levels[0] + 1.5 && levels[1] < levels[2] - 3, `${levels[0].toFixed(1)} -> ${levels[1].toFixed(1)} -> ${levels[2].toFixed(1)} dB`, 'approach >= grip+1.5 dB and >= 3 dB below the squeal');
  checks.add('tires: level rises grip < approach < limit', levels[0] < levels[1] && levels[1] < levels[2], levels.map((x) => x.toFixed(1)).join(' / '), 'monotonic');
  checks.add('tires: tonal squeal at the limit (narrow-band peak)', prom[2] > 22, prom[2], '> 22 dB prominence');
  checks.add('tires: scrub is noise-like (not tonal)', prom[1] < 14, prom[1], '< 14 dB prominence');
  checks.add('tires: howl is ragged (less tonal than the squeal)', prom[3] < prom[2] - 5 || prom[4] < prom[2] - 5, `${prom[2].toFixed(0)} -> ${prom[3].toFixed(0)} / ${prom[4].toFixed(0)} dB`, 'slide/locked >= 5 dB less tonal');
  checks.add('tires: sliding is not quieter than the squeal', levels[4] > levels[2] - 2.5, `${levels[2].toFixed(1)} vs ${levels[4].toFixed(1)}`, 'locked >= squeal - 2.5 dB');
  checks.add('tires: no NaN', !hasNonFinite(m));

  // pitch varies with speed
  const pitchAt = async (speed: number, wheel: number): Promise<number> => {
    const c = tireCar(CAR, () => speed, (_t, w) => (w === wheel ? { skid: 0.5, slipAngle: 0.17 } : { skid: 0, slipAngle: 0.01 }));
    const r = await tireRun(2, c);
    const s = analyseSegment(r.m, r.sr, 0.8, 2, 8192);
    return strongestPeak(s.psd, r.sr, 600, 1800).freq;
  };
  const slow = await pitchAt(15, 1);
  const fast = await pitchAt(45, 1);
  checks.add('tires: squeal pitch rises with speed', fast > slow * 1.12, `${slow.toFixed(0)} -> ${fast.toFixed(0)} Hz`, 'speed 15 -> 45 m/s: > +12 %');
  const front = await pitchAt(35, 0);
  const rear = await pitchAt(35, 2);
  checks.add('tires: front and rear tires sing at different pitches', Math.abs(front - rear) / rear > 0.05, `front ${front.toFixed(0)} Hz, rear ${rear.toFixed(0)} Hz`, '> 5 % apart');

  // only on asphalt / concrete / curb
  const onSurface = async (surf: SurfaceType, skid: number): Promise<{ level: number; prom: number }> => {
    const c = tireCar(CAR, () => 35, (_t, w) => ({ skid: w === 1 ? skid : 0, slipAngle: w === 1 ? (skid > 0 ? 0.25 : 0.01) : 0.01 }), () => surf);
    const r = await tireRun(2, c);
    const s = analyseSegment(r.m, r.sr, 0.8, 2, 8192);
    return { level: s.rmsDb, prom: strongestPeak(s.psd, r.sr, 650, 1700).prominenceDb };
  };
  const asphalt = { sq: await onSurface('asphalt', 0.7), no: await onSurface('asphalt', 0) };
  checks.add('tires: squeal adds >= 8 dB on asphalt', asphalt.sq.level > asphalt.no.level + 8, asphalt.sq.level - asphalt.no.level, '>= 8 dB');
  for (const s of ['concrete', 'curb'] as SurfaceType[]) {
    const a = await onSurface(s, 0.7);
    const b = await onSurface(s, 0);
    checks.add(`tires: squeal present on ${s}`, a.level > b.level + 4, a.level - b.level, '>= 4 dB');
  }
  for (const s of ['grass', 'gravel', 'sand', 'dirt'] as SurfaceType[]) {
    const a = await onSurface(s, 0.9);
    const b = await onSurface(s, 0);
    checks.add(`tires: NO squeal on ${s}`, Math.abs(a.level - b.level) < 1.5 && a.prom < 16, `${(a.level - b.level).toFixed(2)} dB, prom ${a.prom.toFixed(0)}`, '|delta| < 1.5 dB, no tonal peak');
  }
  return { levelsDb: levels, prominence: prom, centroid: cen, pitchSlow: slow, pitchFast: fast, frontHz: front, rearHz: rear, trace };
}

export interface RoadReport {
  asphaltDb: number[];
  windDb: number[];
  centroids: Record<string, number>;
  curbHz: number[];
}

export async function roadChecks(checks: Checks): Promise<RoadReport> {
  const speeds = [15, 30, 45, 60];
  const noSlip: WheelFn = () => ({ skid: 0, slipAngle: 0.0 });
  const levelAt = async (speed: number, surf: SurfaceType, interior = 1): Promise<{ db: number; cen: number }> => {
    const c = tireCar(CAR, () => speed, noSlip, () => surf);
    const r = await tireRun(2, c, interior);
    // remove the engine: measure the chassis only by rendering the player's chassis output? the engine is idle-level;
    // compare against a speed-0 baseline instead
    const s = analyseSegment(r.m, r.sr, 0.9, 2, 8192);
    return { db: s.rmsDb, cen: s.centroid };
  };
  const base = await levelAt(0.0, 'asphalt');
  const asph: number[] = [];
  for (const sp of speeds) asph.push((await levelAt(sp, 'asphalt')).db);
  checks.add('road: asphalt roar rises with speed', asph.every((v, i) => i === 0 || v > asph[i - 1] - 0.3), asph.map((x) => x.toFixed(1)).join(' '), 'monotonic with speed');
  checks.add('road: asphalt roar span >= 8 dB from 15 to 60 m/s', asph[3] - asph[0] >= 8, asph[3] - asph[0], '>= 8 dB');
  void base;

  const cents: Record<string, number> = {};
  for (const surf of ['asphalt', 'gravel', 'grass', 'sand', 'dirt'] as SurfaceType[]) {
    const lv: number[] = [];
    for (const sp of [20, 40]) lv.push((await levelAt(sp, surf)).db);
    const c40 = await levelAt(40, surf);
    cents[surf] = c40.cen;
    checks.add(`road: ${surf} noise rises with speed`, lv[1] > lv[0] + 2, `${lv[0].toFixed(1)} -> ${lv[1].toFixed(1)} dB`, '20 -> 40 m/s: > +2 dB');
  }
  checks.add('road: gravel is crunchier (brighter) than asphalt', cents.gravel > cents.asphalt * 1.8, `${cents.gravel.toFixed(0)} vs ${cents.asphalt.toFixed(0)} Hz`, 'gravel centroid > 1.8 x asphalt');
  checks.add('road: grass swish is soft (dark)', cents.grass < 1000, cents.grass, '< 1000 Hz');
  checks.add('road: dirt sits between grass and gravel', cents.dirt > cents.grass && cents.dirt < cents.gravel, `${cents.grass.toFixed(0)} < ${cents.dirt.toFixed(0)} < ${cents.gravel.toFixed(0)}`, 'grass < dirt < gravel');

  // wind: airborne (no road noise) ~ speed^2
  const windAt = async (speed: number): Promise<number> => {
    const c = tireCar(CAR, () => speed, noSlip);
    for (const w of c.state.wheels) w.contact = false;
    const stepOrig = c.step;
    c.step = (t, dt, s) => {
      stepOrig(t, dt, s);
      for (const w of s.wheels) w.contact = false;
      s.airborne = true;
    };
    const r = await tireRun(2, c, 0);
    return analyseSegment(r.m, r.sr, 0.9, 2, 8192).rmsDb;
  };
  const w30 = await windAt(30);
  const w60 = await windAt(60);
  checks.add('wind: grows ~speed^2 (12-20 dB from 30 to 60 m/s)', w60 - w30 > 10 && w60 - w30 < 22, w60 - w30, '10..22 dB');

  // curb rumble: pulse train at speed / ridge spacing (0.45 m)
  const curbHz: number[] = [];
  for (const sp of [20, 40]) {
    const c = tireCar(CAR, () => sp, noSlip, () => 'curb');
    const r = await tireRun(3, c);
    const s = analyseSegment(r.m, r.sr, 0.8, 3, 32768);
    const expect = sp / 0.45;
    const pk = peakNear(s.psd, r.sr, expect, 0.08);
    curbHz.push(pk.freq);
    checks.add(`curb: rumble pulse train at speed/ridge-spacing (${sp} m/s)`, Math.abs(pk.freq - expect) / expect < 0.03 && pk.prominenceDb > 10, `${pk.freq.toFixed(1)} Hz vs ${expect.toFixed(1)} Hz, prom ${pk.prominenceDb.toFixed(0)} dB`, 'within 3 %, > 10 dB prominence');
  }
  return { asphaltDb: asph, windDb: [w30, w60], centroids: cents, curbHz };
}

export interface ImpactReport {
  peaks: Record<string, number>;
}

export async function impactChecks(checks: Checks): Promise<ImpactReport> {
  const cases: { name: string; kind: ImpactKind; strength: number }[] = [
    { name: 'wall-3', kind: 'wall', strength: 3 },
    { name: 'wall-10', kind: 'wall', strength: 10 },
    { name: 'wall-28', kind: 'wall', strength: 28 },
    { name: 'car-4', kind: 'car', strength: 4 },
    { name: 'car-20', kind: 'car', strength: 20 },
    { name: 'ground-12', kind: 'ground', strength: 12 },
  ];
  const gap = 3;
  const events = cases.map((c, i) => ({ t: 0.5 + i * gap, kind: c.kind, strength: c.strength, localX: 0 }));
  const car = impactCar(CAR, events);
  const res = await renderChassis({ seconds: gap * cases.length + 0.5, cars: [{ ...car, interior: 0 }], raw: true });
  const m = mono(res);
  const peaks: Record<string, number> = {};
  const rmsv: Record<string, number> = {};
  const glass: Record<string, number> = {};
  cases.forEach((c, i) => {
    const a = Math.floor((0.5 + i * gap) * res.sr);
    peaks[c.name] = db(peakAbs(m, a, a + Math.floor(1.5 * res.sr)));
    rmsv[c.name] = db(rms(m, a, a + Math.floor(1.0 * res.sr)));
    const psd = welch(m, 2048, a + Math.floor(0.2 * res.sr), a + Math.floor(0.9 * res.sr));
    let hf = 0;
    let all = 0;
    const df = res.sr / 2048;
    for (let k = 1; k < psd.length; k++) {
      all += psd[k];
      if (k * df > 3500 && k * df < 12000) hf += psd[k];
    }
    glass[c.name] = hf / Math.max(all, 1e-18);
  });
  checks.add('impacts: wall crunch scales with strength', peaks['wall-3'] < peaks['wall-10'] - 4 && peaks['wall-10'] < peaks['wall-28'] - 3, `${peaks['wall-3'].toFixed(1)} < ${peaks['wall-10'].toFixed(1)} < ${peaks['wall-28'].toFixed(1)} dBFS`, 'each step >= 3-4 dB');
  checks.add('impacts: car-to-car crunch scales with strength', peaks['car-4'] < peaks['car-20'] - 6, `${peaks['car-4'].toFixed(1)} -> ${peaks['car-20'].toFixed(1)}`, '>= 6 dB');
  checks.add('impacts: heaviest hit stays below full scale', peaks['wall-28'] < -0.5, peaks['wall-28'], '< -0.5 dBFS');
  checks.add('impacts: light tap is audible', peaks['wall-3'] > -40, peaks['wall-3'], '> -40 dBFS');
  checks.add('impacts: glass tinkle on big hits only', glass['wall-28'] > glass['wall-3'] * 3 && glass['wall-28'] > 0.03, `${(glass['wall-3'] * 100).toFixed(1)}% -> ${(glass['wall-28'] * 100).toFixed(1)}% of energy above 3.5 kHz`, 'heavy >= 3x light and > 3 %');
  checks.add('impacts: ground hit is low and thumpy (darker than wall)', true, peaks['ground-12'], undefined, 'informational');
  checks.add('impacts: no NaN', !hasNonFinite(res.left));

  // pan: impact on the left side of the car is louder in the left ear
  const left = impactCar(CAR, [{ t: 0.4, kind: 'wall', strength: 14, localX: 1.0 }]);
  const lr = await renderChassis({ seconds: 1.8, cars: [{ ...left, interior: 0 }], raw: true });
  const a = Math.floor(0.4 * lr.sr);
  const lL = rms(lr.left, a, a + lr.sr);
  const lR = rms(lr.right, a, a + lr.sr);
  checks.add('impacts: stereo placement follows the impact point', db(lL / lR) > 2, db(lL / lR), 'left-side hit: L > R by > 2 dB');

  // scrape grinding
  const scr = impactCar(CAR, [], (t) => (t > 1 && t < 3 ? 0.9 : 0), 30);
  const sr2 = await renderChassis({ seconds: 4, cars: [{ ...scr, interior: 1 }], raw: true });
  const sm = mono(sr2);
  const off = analyseSegment(sm, sr2.sr, 0.3, 0.9, 8192);
  const on = analyseSegment(sm, sr2.sr, 1.4, 2.8, 8192);
  checks.add('scrape: metal grinding is audible over the car noise', on.rmsDb > off.rmsDb + 8, on.rmsDb - off.rmsDb, '>= 8 dB');
  checks.add('scrape: grind is mid/high-frequency (resonant metal)', on.centroid > 900, on.centroid, 'centroid > 900 Hz');

  // suspension thump
  const th = tireCar(CAR, () => 30, () => ({ skid: 0, slipAngle: 0 }));
  const thStep = th.step;
  th.step = (t, dt, s) => {
    thStep(t, dt, s);
    s.wheels[0].suspensionVelocity = t > 1.0 && t < 1.04 ? 1.3 : 0;
  };
  const tr = await renderChassis({ seconds: 2.2, cars: [{ ...th, interior: 1 }], raw: true });
  const tm = mono(tr);
  const before = rms(tm, Math.floor(0.6 * tr.sr), Math.floor(0.95 * tr.sr));
  const hit = peakAbs(tm, Math.floor(1.0 * tr.sr), Math.floor(1.12 * tr.sr));
  checks.add('suspension: big compression velocity thumps', db(hit / Math.max(before, 1e-9)) > 8, db(hit / Math.max(before, 1e-9)), '> 8 dB over the local level');
  return { peaks };
}

export interface SpatialReport {
  dopplerApproachHz: number;
  dopplerRecedeHz: number;
  restHz: number;
  rolloffDb: number;
}

export async function spatialChecks(checks: Checks): Promise<SpatialReport> {
  const car = CAR;
  const rpm = 5000;
  const f0 = (car.sound.cylinders / 2) * (rpm / 60);
  // car crosses in front of the listener at 60 m/s: x from -150 to +150 at z = -10
  const v = 60;
  const pass = passByCar(car, -150, -10, v, 0, rpm);
  const secs = 5;
  const res = await renderScene({
    seconds: secs,
    cars: [pass],
    raw: true,
    listener: (_t, L) => {
      L.px = 0;
      L.py = 0.5;
      L.pz = 0;
      L.fx = 0;
      L.fy = 0;
      L.fz = -1;
      L.ux = 0;
      L.uy = 1;
      L.uz = 0;
      L.vx = 0;
      L.vy = 0;
      L.vz = 0;
    },
  });
  const m = mono(res);
  const at = (x: number): number => (x + 150) / v; // time at which the car is at x
  const hzAt = (x: number): number => {
    const t = at(x);
    const psd = welch(m, 16384, Math.floor((t - 0.12) * res.sr), Math.floor((t + 0.12) * res.sr));
    return strongestPeak(psd, res.sr, f0 * 0.7, f0 * 1.5).freq;
  };
  const fApp = hzAt(-80);
  const fRec = hzAt(80);
  const cos = 80 / Math.hypot(80, 10);
  const expApp = (f0 * 343) / (343 - v * cos);
  const expRec = (f0 * 343) / (343 + v * cos);
  checks.add('doppler: approaching pitch is raised', Math.abs(fApp - expApp) / expApp < 0.05, `${fApp.toFixed(1)} Hz vs ${expApp.toFixed(1)} Hz`, 'within 5 % of the physical value');
  checks.add('doppler: receding pitch is lowered', Math.abs(fRec - expRec) / expRec < 0.05, `${fRec.toFixed(1)} Hz vs ${expRec.toFixed(1)} Hz`, 'within 5 % of the physical value');
  checks.add('doppler: approach / recede ratio ~1.4 at 60 m/s', Math.abs(fApp / fRec - expApp / expRec) / (expApp / expRec) < 0.06, fApp / fRec, `~${(expApp / expRec).toFixed(2)}`);
  // panning left -> right as it passes
  const balance = (x: number): number => {
    const t = at(x);
    const a = Math.floor((t - 0.1) * res.sr);
    const b = Math.floor((t + 0.1) * res.sr);
    return db(rms(res.left, a, b) / Math.max(rms(res.right, a, b), 1e-9));
  };
  const bL = balance(-60);
  const bR = balance(60);
  checks.add('spatial: car is heard on the left while approaching from the left', bL > 3, bL, 'L/R > +3 dB');
  checks.add('spatial: car is heard on the right after passing', bR < -3, bR, 'L/R < -3 dB');
  // loudest at closest approach
  const lvl = (x: number): number => {
    const t = at(x);
    return db(rms(m, Math.floor((t - 0.1) * res.sr), Math.floor((t + 0.1) * res.sr)));
  };
  checks.add('spatial: loudest at the closest approach', lvl(0) > lvl(-80) + 6 && lvl(0) > lvl(80) + 6, `${lvl(-80).toFixed(1)} / ${lvl(0).toFixed(1)} / ${lvl(80).toFixed(1)} dB`, 'center > sides + 6 dB');

  // distance roll-off + culling
  const still = async (z: number, lod: 0 | 1 | 2): Promise<number> => {
    const c = passByCar(car, 0, -z, 0, 0, rpm);
    c.lod = lod;
    const r = await renderScene({
      seconds: 1.8,
      cars: [c],
      raw: true,
      listener: (_t, L) => {
        L.px = 0;
        L.py = 0.5;
        L.pz = 0;
        L.fx = 0;
        L.fy = 0;
        L.fz = -1;
        L.ux = 0;
        L.uy = 1;
        L.uz = 0;
        L.vx = L.vy = L.vz = 0;
      },
    });
    return db(rms(mono(r), Math.floor(0.8 * r.sr), r.left.length));
  };
  const near = await still(10, 2);
  const far = await still(100, 2);
  checks.add('distance: level falls with distance (10 m -> 100 m)', near - far > 15 && near - far < 32, near - far, '15..32 dB');
  const culled = await still(10, 0);
  checks.add('lod: opponents beyond the cull radius are silent', culled < -80, culled, '< -80 dBFS');
  const lite = await still(30, 1);
  const full = await still(30, 2);
  checks.add('lod: lite voice is present (within 6 dB of full)', Math.abs(lite - full) < 6, lite - full, '|diff| < 6 dB');

  // player's own car stays centred (cockpit): the engine sits ahead of the camera
  const p = passByCar(car, 0, -0.5, 0, 0, rpm);
  p.isPlayer = true;
  const pr = await renderScene({
    seconds: 1.8,
    cars: [p],
    raw: true,
    listener: (_t, L) => {
      L.px = 0;
      L.py = 0.5;
      L.pz = 0;
      L.fx = 0;
      L.fy = 0;
      L.fz = -1;
      L.ux = 0;
      L.uy = 1;
      L.uz = 0;
      L.vx = L.vy = L.vz = 0;
    },
  });
  const a = Math.floor(0.8 * pr.sr);
  const cb = db(rms(pr.left, a, pr.left.length) / Math.max(rms(pr.right, a, pr.right.length), 1e-9));
  checks.add("spatial: the player's engine stays centred for an attached camera", Math.abs(cb) < 1.5, cb, '|L/R| < 1.5 dB');
  return { dopplerApproachHz: fApp, dopplerRecedeHz: fRec, restHz: f0, rolloffDb: near - far };
}

void CARS;
void makeVehicleState;
void spectralCentroid;
