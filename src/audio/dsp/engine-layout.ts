/**
 * Engine layout model: firing angles, bank assignment, header (primary pipe) lengths and the
 * per-cycle event table that drives the synthesis. Everything is derived from EngineSoundProfile.
 *
 * Angles are crank degrees inside the 720 degree four-stroke cycle, measured from each cylinder's
 * firing TDC. Event offsets are textbook valve timing:
 *   combustion pressure peak  ~ +10   deg
 *   exhaust valve opens (EVO) ~ +140  deg   (blowdown pulse leaves the cylinder)
 *   intake valve opens (IVO)  ~ +352  deg
 *   exhaust valve closes      ~ +385  deg
 *   intake valve closes (IVC) ~ +585  deg
 */
import type { EngineSoundProfile } from '../../core/contracts';

export const EV_EXHAUST = 0;
export const EV_COMBUSTION = 1;
export const EV_TICK_EXH_CLOSE = 2;
export const EV_TICK_INT_OPEN = 3;
export const EV_TICK_INT_CLOSE = 4;

export const DEG_EVO = 140;
export const DEG_COMBUSTION = 10;
export const DEG_EVC = 385;
export const DEG_IVO = 352;
export const DEG_IVC = 585;

export interface CylinderSpec {
  /** Firing TDC angle inside the 720 degree cycle. */
  fireDeg: number;
  bank: number;
  /** Header primary length (m). */
  lenM: number;
  /** Static pulse-strength factor (manufacturing + header imbalance). */
  gain: number;
}

export interface PipeGroup {
  bank: number;
  lenM: number;
  count: number;
}

export interface EngineLayout {
  cylinders: number;
  banks: number;
  cyl: CylinderSpec[];
  /** Cylinders with identical primary length in the same bank share one waveguide pair (exact for LTI pipes). */
  groups: PipeGroup[];
  cylGroup: number[];
  /** Cylinders per bank. */
  bankCount: number[];
  /** Sorted per-cycle event table. */
  evPhase: Float64Array;
  evType: Int32Array;
  evCyl: Int32Array;
  /** Summed intake valve window over one cycle (1024 points, normalised to peak 1). */
  intakeWindow: Float32Array;
  /** Mean intake-window modulation depth (0 = flat, 1 = fully pulsed). */
  intakeDepth: number;
  /** Firing frequency in Hz per rpm: cylinders/2/60. */
  firingHzPerRpm: number;
}

/** Deterministic pseudo-random in [-1, 1] from an integer. */
function hash(i: number): number {
  let x = (i + 1) * 2654435761;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519);
  x ^= x >>> 13;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}

export function buildLayout(p: EngineSoundProfile): EngineLayout {
  const N = p.cylinders;
  const single = p.layout === 'inline';
  const banks = single ? 1 : 2;
  const crossplaneV8 = p.crankType === 'crossplane' && N === 8;
  const boxer4 = p.crankType === 'boxer' && N === 4;

  const bankOf: number[] = [];
  for (let k = 0; k < N; k++) {
    if (single) bankOf.push(0);
    else if (boxer4) bankOf.push(k < 2 ? 0 : 1); // order 1-3-2-4: right bank fires twice, then left twice
    else if (crossplaneV8) bankOf.push([0, 1, 1, 0, 1, 0, 0, 1][k]); // order 1-8-4-3-6-5-7-2 (L R R L R L L R)
    else bankOf.push(k % 2);
  }

  const baseLen = N <= 4 ? 0.42 : N <= 6 ? 0.46 : N <= 8 ? 0.58 : 0.5;
  const lenScale = 1.1 - 0.2 * p.exhaustOpenness;

  const boxerGain = [1.0, 0.84, 1.12, 0.92];
  const cyl: CylinderSpec[] = [];
  for (let k = 0; k < N; k++) {
    let lenM = baseLen * lenScale;
    let gain = 1 + 0.025 * hash(k * 7 + N);
    if (boxer4) {
      lenM = (bankOf[k] === 0 ? 0.3 : 0.8) * lenScale; // unequal-length headers
      gain = boxerGain[k];
    }
    cyl.push({ fireDeg: (720 * k) / N, bank: bankOf[k], lenM, gain });
  }

  // pipe groups: same bank + same length (rounded to mm)
  const groups: PipeGroup[] = [];
  const cylGroup: number[] = [];
  for (let k = 0; k < N; k++) {
    const key = Math.round(cyl[k].lenM * 1000);
    let gi = groups.findIndex((g) => g.bank === cyl[k].bank && Math.round(g.lenM * 1000) === key);
    if (gi < 0) {
      groups.push({ bank: cyl[k].bank, lenM: cyl[k].lenM, count: 0 });
      gi = groups.length - 1;
    }
    groups[gi].count++;
    cylGroup.push(gi);
  }
  const bankCount = new Array<number>(banks).fill(0);
  for (const c of cyl) bankCount[c.bank]++;

  // event table
  const evs: { ph: number; type: number; cyl: number }[] = [];
  const add = (type: number, k: number, deg: number): void => {
    let ph = (cyl[k].fireDeg + deg) / 720;
    ph -= Math.floor(ph);
    evs.push({ ph, type, cyl: k });
  };
  for (let k = 0; k < N; k++) {
    add(EV_EXHAUST, k, DEG_EVO);
    add(EV_COMBUSTION, k, DEG_COMBUSTION);
    add(EV_TICK_EXH_CLOSE, k, DEG_EVC);
    add(EV_TICK_INT_OPEN, k, DEG_IVO);
    add(EV_TICK_INT_CLOSE, k, DEG_IVC);
  }
  evs.sort((a, b) => a.ph - b.ph || a.type - b.type);
  const evPhase = new Float64Array(evs.length);
  const evType = new Int32Array(evs.length);
  const evCyl = new Int32Array(evs.length);
  evs.forEach((e, i) => {
    evPhase[i] = e.ph;
    evType[i] = e.type;
    evCyl[i] = e.cyl;
  });

  // intake window: sum of raised-cosine valve-open windows
  const M = 1024;
  const win = new Float32Array(M);
  const width = (DEG_IVC - DEG_IVO) / 720;
  let max = 0;
  for (let j = 0; j < M; j++) {
    const ph = j / M;
    let s = 0;
    for (let k = 0; k < N; k++) {
      let d = ph - (cyl[k].fireDeg + DEG_IVO) / 720;
      d -= Math.floor(d);
      if (d < width) s += 0.5 * (1 - Math.cos((2 * Math.PI * d) / width));
    }
    win[j] = s;
    if (s > max) max = s;
  }
  let mn = Infinity;
  for (let j = 0; j < M; j++) {
    win[j] /= max;
    if (win[j] < mn) mn = win[j];
  }
  const intakeDepth = 1 - mn;

  return {
    cylinders: N,
    banks,
    cyl,
    groups,
    cylGroup,
    bankCount,
    evPhase,
    evType,
    evCyl,
    intakeWindow: win,
    intakeDepth,
    firingHzPerRpm: N / 2 / 60,
  };
}

/** Firing intervals (crank degrees) between successive exhaust pulses in one bank — for tests and docs. */
export function bankFiringIntervals(layout: EngineLayout, bank: number): number[] {
  const angles = layout.cyl
    .filter((c) => c.bank === bank)
    .map((c) => c.fireDeg)
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < angles.length; i++) {
    const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 720;
    out.push(next - angles[i]);
  }
  return out;
}
