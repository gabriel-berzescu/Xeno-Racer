/**
 * Track runtime tests (headless). Run: npx vitest run tests/track.test.ts
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { GroundSample, TrackFrame, TrackPoint } from '../src/core/contracts';
import { TRACKS, loadTrackRuntime } from '../src/track';
import type { TrackRuntimeImpl } from '../src/track';
import { mulberry32 } from '../src/track/math';
import { portovela } from '../src/track/defs/portovela';
import { emitArch, placeLandmark } from '../src/track/scene/landmarks';
import { CityBuf } from '../src/track/scene/cityBuf';
import { resolveMark } from '../src/track/plan';
import { SURF_NAME } from '../src/track/types';

// ── per-track design limits ────────────────────────────────────────────────────
interface Limits {
  minRadius: number;
  maxGrade: number;
  minCrestR: number;
  minSagR: number;
  maxBankDeg: number;
  elev: [number, number];
  length: [number, number];
  /** Largest height step per 0.5 m allowed when walking away from the barrier (terrain steepness). */
  maxFieldStep: number;
  /** Largest analytic-normal vs finite-difference mismatch on the curbs (default 0.2). On the inside of an R20 corner the ridge slope is amplified by the converging patch and the 0.4 m FD window smooths it more. */
  maxNormalMismatch?: number;
}
const LIMITS: Record<string, Limits> = {
  aurelia: { minRadius: 29, maxGrade: 0.09, minCrestR: 450, minSagR: 200, maxBankDeg: 12, elev: [22, 38], length: [4400, 5100], maxFieldStep: 0.75 },
  kuroyama: { minRadius: 11, maxGrade: 0.11, minCrestR: 250, minSagR: 120, maxBankDeg: 9, elev: [60, 400], length: [5000, 6200], maxFieldStep: 1.6 },
  // forest GP circuit: 6.6 km, ~90 m of relief, a 450 m radius valley compression, ~1.4 km radius crests
  brennwald: { minRadius: 29, maxGrade: 0.105, minCrestR: 1000, minSagR: 380, maxBankDeg: 6, elev: [80, 110], length: [6300, 7100], maxFieldStep: 0.8 },
  // harbour street circuit: 4 km, 43 m of relief, R14 hairpin, 8 % descent
  portovela: { minRadius: 13, maxGrade: 0.09, minCrestR: 600, minSagR: 700, maxBankDeg: 3, elev: [38, 50], length: [3800, 4300], maxFieldStep: 1.2, maxNormalMismatch: 0.25 },
  // winter circuit: 4.3 km, 13 m of relief with a dead flat frozen lake, R25 switchbacks, no banking
  isvik: { minRadius: 24, maxGrade: 0.045, minCrestR: 300, minSagR: 300, maxBankDeg: 0.5, elev: [9, 16], length: [3900, 4500], maxFieldStep: 1.2 },
};

function newGround(): GroundSample {
  return { height: 0, normal: new Vector3(), surface: 'asphalt' };
}
function newPoint(): TrackPoint {
  return { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 0, lx: 0, lz: 0, y: 0 };
}
function newFrame(): TrackFrame {
  return {
    position: new Vector3(),
    tangent: new Vector3(),
    normal: new Vector3(),
    left: new Vector3(),
    widthLeft: 0,
    widthRight: 0,
    wallLeft: 0,
    wallRight: 0,
    curvature: 0,
    bank: 0,
  };
}

// First load of each track happens here so the timing is a cold one.
const loadMs: Record<string, number> = {};
for (const t of TRACKS) {
  const t0 = performance.now();
  loadTrackRuntime(t.info.id);
  loadMs[t.info.id] = performance.now() - t0;
}

describe.each(TRACKS.map((t) => t.info.id))('track %s', (id) => {
  const rt = loadTrackRuntime(id) as TrackRuntimeImpl;
  const lim = LIMITS[id];
  const N = rt.count;
  const h = rt.spacing;
  const wrapDiff = (a: number, b: number) => {
    let d = a - b;
    while (d > rt.length / 2) d -= rt.length;
    while (d < -rt.length / 2) d += rt.length;
    return d;
  };

  it('loads headless in < 300 ms', { retry: 3 }, () => {
    console.info(`[track:${id}] cold load ${loadMs[id].toFixed(0)} ms, ${rt.length.toFixed(1)} m, ${rt.count} samples`);
    expect(loadMs[id]).toBeLessThan(300);
  });

  it('has a closed, evenly sampled centerline and sane metadata', () => {
    expect(rt.info.id).toBe(id);
    expect(rt.spacing).toBeLessThanOrEqual(1.0001);
    expect(rt.spacing * rt.count).toBeCloseTo(rt.length, 6);
    expect(rt.length).toBeGreaterThan(lim.length[0]);
    expect(rt.length).toBeLessThan(lim.length[1]);
    expect(Math.abs(rt.info.lengthHint - rt.length) / rt.length).toBeLessThan(0.04);
    for (const a of [rt.px, rt.py, rt.pz, rt.tx, rt.ty, rt.tz, rt.nx, rt.ny, rt.nz, rt.lx, rt.ly, rt.lz, rt.widthLeft, rt.widthRight, rt.wallLeft, rt.wallRight, rt.curvature, rt.bank]) {
      expect(a.length).toBe(N + 1);
      expect(a[N]).toBeCloseTo(a[0], 3);
    }
    // evenly spaced
    for (let i = 0; i < N; i += 7) {
      const d = Math.hypot(rt.px[i + 1] - rt.px[i], rt.pz[i + 1] - rt.pz[i]);
      expect(d).toBeGreaterThan(h * 0.97);
      expect(d).toBeLessThan(h * 1.001);
    }
    expect(rt.sectors[0]).toBeGreaterThan(0);
    expect(rt.sectors[1]).toBeGreaterThan(rt.sectors[0]);
    expect(rt.sectors[1]).toBeLessThan(rt.length);
    for (let i = 0; i < N; i += 5) {
      expect(rt.px[i]).toBeGreaterThanOrEqual(rt.bounds.minX);
      expect(rt.px[i]).toBeLessThanOrEqual(rt.bounds.maxX);
      expect(rt.pz[i]).toBeGreaterThanOrEqual(rt.bounds.minZ);
      expect(rt.pz[i]).toBeLessThanOrEqual(rt.bounds.maxZ);
      expect(rt.py[i]).toBeGreaterThanOrEqual(rt.bounds.minY - 1e-3);
      expect(rt.py[i]).toBeLessThanOrEqual(rt.bounds.maxY + 1e-3);
    }
    // frames are orthonormal
    for (let i = 0; i < N; i += 11) {
      const t = new Vector3(rt.tx[i], rt.ty[i], rt.tz[i]);
      const n = new Vector3(rt.nx[i], rt.ny[i], rt.nz[i]);
      const l = new Vector3(rt.lx[i], rt.ly[i], rt.lz[i]);
      expect(t.length()).toBeCloseTo(1, 4);
      expect(n.length()).toBeCloseTo(1, 4);
      expect(l.length()).toBeCloseTo(1, 4);
      expect(Math.abs(t.dot(n))).toBeLessThan(1e-4);
      expect(Math.abs(t.dot(l))).toBeLessThan(1e-4);
      expect(l.distanceTo(new Vector3().crossVectors(n, t))).toBeLessThan(1e-4);
    }
  });

  it('pointAt -> project round-trips (s, d)', () => {
    const rnd = mulberry32(1234);
    const out = new Vector3();
    const tp = newPoint();
    let hint = -1;
    let worstS = 0;
    let worstD = 0;
    for (let k = 0; k < 6000; k++) {
      const s = rnd() * rt.length;
      const f = rnd();
      const wl = rt.wallLeft[Math.floor(s / h)];
      const wr = rt.wallRight[Math.floor(s / h)];
      const d = f < 0.5 ? (rnd() * 2 - 1) * 8 : -wr + 0.5 + rnd() * (wl + wr - 1);
      rt.pointAt(s, d, out);
      // alternate between no hint and a stale-ish hint
      const useHint = k % 3 === 0 ? -1 : hint;
      hint = rt.project(out.x, out.z, tp, useHint);
      worstS = Math.max(worstS, Math.abs(wrapDiff(tp.s, s)));
      worstD = Math.max(worstD, Math.abs(tp.d - d));
    }
    expect(worstS).toBeLessThan(0.01);
    expect(worstD).toBeLessThan(0.01);
    console.info(`[track:${id}] round-trip worst |ds| ${(worstS * 1000).toFixed(2)} mm, |dd| ${(worstD * 1000).toFixed(2)} mm`);
  });

  it('project is consistent with continuous motion and survives a bad hint', () => {
    const out = new Vector3();
    const tp = newPoint();
    const tp2 = newPoint();
    // drive a lap at 0.2 m steps with a rolling hint
    let hint = -1;
    for (let s = 0; s < rt.length; s += 0.2) {
      rt.pointAt(s, 1.3, out);
      hint = rt.project(out.x, out.z, tp, hint);
      expect(Math.abs(wrapDiff(tp.s, s))).toBeLessThan(0.02);
    }
    // a wildly wrong hint on the road still finds the right place
    const rnd = mulberry32(99);
    for (let k = 0; k < 400; k++) {
      const s = rnd() * rt.length;
      rt.pointAt(s, (rnd() * 2 - 1) * 5, out);
      rt.project(out.x, out.z, tp2, Math.floor(rnd() * N));
      expect(Math.abs(wrapDiff(tp2.s, s))).toBeLessThan(0.05);
    }
  });

  /** What the road is made of at s: asphalt, or on a winter circuit packed snow with ice on the frozen lake. */
  const roadAt = (s: number): string => {
    const f = rt.wrapS(s) / h;
    const i = Math.min(N - 1, Math.floor(f));
    return SURF_NAME[rt.roadSurf[f - i < 0.5 ? i : i + 1]];
  };

  it('groundAt agrees with pointAt on the road and reports its surface', () => {
    const rnd = mulberry32(7);
    const out = new Vector3();
    const g = newGround();
    let hint = -1;
    for (let k = 0; k < 4000; k++) {
      const s = rnd() * rt.length;
      const i = Math.floor(s / h);
      const d = (rnd() * 2 - 1) * 0.98 * (rnd() < 0.5 ? rt.widthLeft[i] : -rt.widthRight[i]);
      rt.pointAt(s, d, out);
      hint = rt.groundAt(out.x, out.z, g, hint);
      expect(g.height).toBeCloseTo(out.y, 4);
      expect(g.surface).toBe(roadAt(s));
    }
  });

  it('is continuous: heights across the full corridor have no cliffs or needles', () => {
    const rnd = mulberry32(42);
    const out = new Vector3();
    const g = newGround();
    let maxSlope = 0;
    for (let k = 0; k < 500; k++) {
      const s = rnd() * rt.length;
      const i = Math.floor(s / h);
      const x0 = -rt.wallRight[i] - 1;
      const x1 = rt.wallLeft[i] + 1;
      let prev = NaN;
      let hint = -1;
      const step = 0.02;
      for (let d = x0; d <= x1; d += step) {
        rt.pointAt(s, d, out);
        hint = rt.groundAt(out.x, out.z, g, hint);
        if (!Number.isNaN(prev)) maxSlope = Math.max(maxSlope, Math.abs(g.height - prev) / step);
        prev = g.height;
      }
    }
    expect(maxSlope).toBeLessThan(0.36);
    // and along the road at fixed offsets (ridges: 0.5 m period)
    let maxAlong = 0;
    for (const d of [-9, -7.4, -7.1, 0, 7.1, 7.4, 9]) {
      let prev = NaN;
      let hint = -1;
      for (let s = 300; s < 1500; s += 0.03) {
        rt.pointAt(s, d, out);
        hint = rt.groundAt(out.x, out.z, g, hint);
        if (!Number.isNaN(prev)) maxAlong = Math.max(maxAlong, Math.abs(g.height - prev) / 0.03);
        prev = g.height;
      }
    }
    expect(maxAlong).toBeLessThan(0.3);
  });

  it('curb relief never exceeds 4 cm and curbs are ramps', () => {
    for (const S of [rt.L, rt.R]) {
      let any = false;
      for (let i = 0; i < N; i++) {
        expect(S.curbH0[i] + S.curbH1[i]).toBeLessThanOrEqual(0.04 + 1e-9);
        if (S.curbW[i] > 0.3) any = true;
      }
      if (rt.def.curbs !== false) expect(any).toBe(true);
    }
  });

  it('every drivable point has a near-vertical normal that matches the height field', () => {
    const g = newGround();
    const g2 = newGround();
    const out = new Vector3();
    let minNy = 1;
    let minAt = '';
    let worstMismatch = 0;
    let nonFinite = 0;
    // coarse scan of the whole corridor
    let hint = -1;
    for (let s = 0; s < rt.length; s += 0.25) {
      const i = Math.floor(s / h);
      const x0 = -rt.wallRight[i];
      const x1 = rt.wallLeft[i];
      for (let d = x0; d <= x1; d += 0.11) {
        rt.pointAt(s, d, out);
        hint = rt.groundAt(out.x, out.z, g, hint);
        if (!Number.isFinite(g.height) || !Number.isFinite(g.normal.y)) nonFinite++;
        if (g.normal.y < minNy) {
          minNy = g.normal.y;
          minAt = `s=${s.toFixed(2)} d=${d.toFixed(2)} ${g.surface}`;
        }
      }
    }
    // dense scan around every curb strip (this is where needles used to hide)
    for (const S of [rt.L, rt.R]) {
      const sgn = S === rt.L ? 1 : -1;
      for (let i = 0; i < N; i += 2) {
        const cw = S.curbW[i];
        if (cw < 0.02) continue;
        for (let s = i * h; s < (i + 2) * h; s += 0.043) {
          for (let u = -0.15; u <= cw + 0.15; u += 0.027) {
            rt.pointAt(s, sgn * (S.W[i] + u), out);
            hint = rt.groundAt(out.x, out.z, g, hint);
            if (g.normal.y < minNy) {
              minNy = g.normal.y;
              minAt = `s=${s.toFixed(2)} u=${u.toFixed(2)} curb ${g.surface}`;
            }
            // analytic normal vs central differences over +-0.2 m of the height field
            const e = 0.2;
            const hx = (rt.heightXZ(out.x + e, out.z, hint) - rt.heightXZ(out.x - e, out.z, hint)) / (2 * e);
            const hz = (rt.heightXZ(out.x, out.z + e, hint) - rt.heightXZ(out.x, out.z - e, hint)) / (2 * e);
            const inv = 1 / Math.sqrt(hx * hx + 1 + hz * hz);
            g2.normal.set(-hx * inv, inv, -hz * inv);
            worstMismatch = Math.max(worstMismatch, g.normal.distanceTo(g2.normal));
          }
        }
      }
    }
    expect(nonFinite).toBe(0);
    console.info(`[track:${id}] min normal.y ${minNy.toFixed(4)} (${minAt}), worst normal/FD mismatch ${worstMismatch.toFixed(3)}`);
    expect(minNy, `min normal.y at ${minAt}`).toBeGreaterThanOrEqual(0.95);
    // ridges are 0.125 m ramps, so a 0.4 m FD window smooths them; the bound is loose but catches wrong derivatives
    expect(worstMismatch).toBeLessThan(lim.maxNormalMismatch ?? 0.2);
  });

  it('keeps a continuous barrier corridor, at least 2 m beyond the asphalt everywhere', () => {
    for (let i = 0; i < N; i++) {
      // (both are float32: a runoff of exactly 2 m comes out a rounding step short where the wall offset crosses into a coarser binade)
      expect(rt.wallLeft[i] - rt.widthLeft[i]).toBeGreaterThanOrEqual(2 - 1e-5);
      expect(rt.wallRight[i] - rt.widthRight[i]).toBeGreaterThanOrEqual(2 - 1e-5);
      // the barrier line may angle away gently, never jump (<= 0.25 m of lateral movement per metre)
      expect(Math.abs(rt.wallLeft[i + 1] - rt.wallLeft[i])).toBeLessThan(0.25 * h);
      expect(Math.abs(rt.wallRight[i + 1] - rt.wallRight[i])).toBeLessThan(0.25 * h);
      expect(Math.abs(rt.widthLeft[i + 1] - rt.widthLeft[i])).toBeLessThan(0.06);
    }
  });

  it('never self-approaches: non-adjacent parts stay > both wall distances + 20 m apart', () => {
    let worst = Infinity;
    let at = '';
    const step = 3;
    const X = rt.X;
    const Z = rt.Z;
    for (let i = 0; i < N; i += step) {
      for (let j = i + step; j < N; j += step) {
        let ds = (j - i) * h;
        ds = Math.min(ds, rt.length - ds);
        if (ds < 120) continue;
        const dx = X[j] - X[i];
        const dz = Z[j] - Z[i];
        const dist = Math.hypot(dx, dz);
        if (dist > 260) continue;
        const wi = dx * rt.HLX[i] + dz * rt.HLZ[i] > 0 ? rt.wallLeft[i] : rt.wallRight[i];
        const wj = -(dx * rt.HLX[j] + dz * rt.HLZ[j]) > 0 ? rt.wallLeft[j] : rt.wallRight[j];
        const gap = dist - wi - wj;
        if (gap < worst) {
          worst = gap;
          at = `s=${(i * h).toFixed(0)} vs ${(j * h).toFixed(0)}`;
        }
      }
    }
    expect(worst, `closest approach at ${at}`).toBeGreaterThan(20);
  });

  it('has a starting grid of >= 12 slots on the road behind the line', () => {
    expect(rt.grid.length).toBeGreaterThanOrEqual(12);
    const f = newFrame();
    const g = newGround();
    const q = new Quaternion();
    const fwd = new Vector3();
    const up = new Vector3();
    for (let k = 0; k < rt.grid.length; k++) {
      const slot = rt.grid[k];
      const back = rt.length - slot.s;
      expect(back).toBeGreaterThan(4);
      expect(back).toBeLessThan(200);
      rt.frameAt(slot.s, f);
      const iseg = Math.floor(slot.s / h);
      expect(Math.abs(slot.d) + 1.1).toBeLessThan(Math.min(rt.widthLeft[iseg], rt.widthRight[iseg]));
      rt.groundAt(slot.position.x, slot.position.z, g);
      expect(g.surface).toBe(roadAt(slot.s));
      expect(slot.position.y).toBeCloseTo(g.height, 3);
      q.copy(slot.quaternion);
      fwd.set(0, 0, 1).applyQuaternion(q);
      up.set(0, 1, 0).applyQuaternion(q);
      expect(fwd.dot(f.tangent)).toBeGreaterThan(0.9995);
      expect(up.dot(f.normal)).toBeGreaterThan(0.9995);
      if (k >= 2) {
        expect(rt.grid[k - 2].s - slot.s).toBeCloseTo(8, 1); // 8 m between rows (further back = smaller s)
      }
      expect(Math.sign(slot.d)).toBe(k % 2 === 0 ? 1 : -1); // two-wide stagger
    }
  });

  it('obeys curvature, vertical curvature, grade and bank design limits', () => {
    let minR = Infinity;
    let maxDk = 0;
    for (let i = 0; i < N; i++) {
      const k = Math.abs(rt.curvature[i]);
      if (k > 1e-6) minR = Math.min(minR, 1 / k);
      maxDk = Math.max(maxDk, Math.abs(rt.curvature[i + 1] - rt.curvature[i]) / h);
    }
    expect(minR).toBeGreaterThan(lim.minRadius);
    expect(maxDk).toBeLessThan(0.004); // clothoids: curvature never jumps
    let crest = 0;
    let sag = 0;
    let maxGrade = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    let maxBank = 0;
    let maxDb = 0;
    for (let i = 1; i < N - 1; i++) {
      const y2 = (rt.py[i + 1] - 2 * rt.py[i] + rt.py[i - 1]) / (h * h);
      crest = Math.min(crest, y2);
      sag = Math.max(sag, y2);
      maxGrade = Math.max(maxGrade, Math.abs(rt.ty[i]) / Math.hypot(rt.tx[i], rt.tz[i]));
    }
    for (let i = 0; i < N; i++) {
      minY = Math.min(minY, rt.py[i]);
      maxY = Math.max(maxY, rt.py[i]);
      maxBank = Math.max(maxBank, Math.abs(rt.bank[i]));
      maxDb = Math.max(maxDb, Math.abs(rt.bank[i + 1] - rt.bank[i]) / h);
    }
    expect(maxGrade).toBeLessThan(lim.maxGrade);
    expect(1 / Math.max(1e-9, -crest)).toBeGreaterThan(lim.minCrestR);
    expect(1 / Math.max(1e-9, sag)).toBeGreaterThan(lim.minSagR);
    expect((maxBank * 180) / Math.PI).toBeLessThan(lim.maxBankDeg);
    expect((maxDb * 180) / Math.PI).toBeLessThan(0.5); // deg per metre
    expect(maxY - minY).toBeGreaterThan(lim.elev[0]);
    expect(maxY - minY).toBeLessThan(lim.elev[1]);
    // no step in height between samples
    for (let i = 0; i < N; i++) expect(Math.abs(rt.py[i + 1] - rt.py[i])).toBeLessThan(0.12);
  });

  it('wrapS, frameAt and pointAt are consistent', () => {
    expect(rt.wrapS(-1)).toBeCloseTo(rt.length - 1, 6);
    expect(rt.wrapS(rt.length + 5)).toBeCloseTo(5, 6);
    expect(rt.wrapS(2.5 * rt.length)).toBeCloseTo(0.5 * rt.length, 5);
    const f = newFrame();
    const p = new Vector3();
    const rnd = mulberry32(5);
    for (let k = 0; k < 500; k++) {
      const s = rnd() * rt.length;
      rt.frameAt(s, f);
      rt.pointAt(s, 0, p);
      expect(f.position.distanceTo(p)).toBeLessThan(2e-3);
      expect(f.tangent.length()).toBeCloseTo(1, 5);
      expect(f.normal.length()).toBeCloseTo(1, 5);
      expect(Math.abs(f.tangent.dot(f.normal))).toBeLessThan(5e-3);
      expect(Math.abs(f.left.dot(f.normal))).toBeLessThan(5e-3);
      // left of the frame points toward positive d
      rt.pointAt(s, 3, p);
      const toLeft = p.clone().sub(f.position);
      expect(toLeft.dot(f.left)).toBeGreaterThan(2.9);
    }
  });

  it('answers sanely far outside the corridor (finite, continuous)', () => {
    const g = newGround();
    const out = new Vector3();
    const rnd = mulberry32(3);
    for (let k = 0; k < 300; k++) {
      rt.groundAt((rnd() * 2 - 1) * 6000, (rnd() * 2 - 1) * 6000, g);
      expect(Number.isFinite(g.height)).toBe(true);
      expect(g.normal.y).toBeGreaterThan(0.2);
    }
    // walk straight out from the barrier on several sides: no cliffs (< 45 deg per metre)
    for (const sFrac of [0.05, 0.22, 0.41, 0.63, 0.88]) {
      const s = sFrac * rt.length;
      const i = Math.floor(s / h);
      for (const sgn of [1, -1]) {
        let prev = NaN;
        let hint = -1;
        const w = sgn > 0 ? rt.wallLeft[i] : rt.wallRight[i];
        for (let u = w - 3; u < w + 120; u += 0.5) {
          rt.pointAt(s, sgn * u, out);
          hint = rt.groundAt(out.x, out.z, g, hint);
          if (!Number.isNaN(prev)) expect(Math.abs(g.height - prev)).toBeLessThan(lim.maxFieldStep);
          prev = g.height;
        }
      }
    }
  });

  it('is fast: 1M groundAt calls with hints in < 1 s', { retry: 3 }, () => {
    const g = newGround();
    const hints = [-1, -1, -1, -1];
    const offs = [-0.9, 0.9, -0.85, 0.85];
    const fwd = [1.4, 1.4, -1.3, -1.3];
    const out = new Vector3();
    // warm-up
    for (let k = 0; k < 20000; k++) rt.groundAt(rt.px[k % N], rt.pz[k % N], g, -1);
    const t0 = performance.now();
    let sum = 0;
    let s = 5;
    for (let k = 0; k < 250000; k++) {
      s += 0.07;
      if (s > rt.length - 5) s = 5;
      const i = Math.floor(s / h);
      for (let w = 0; w < 4; w++) {
        const ss = s + fwd[w];
        const j = Math.floor(ss / h);
        const x = rt.px[j] + rt.lx[j] * (offs[w] + 4.0 * Math.sin(s * 0.01));
        const z = rt.pz[j] + rt.lz[j] * (offs[w] + 4.0 * Math.sin(s * 0.01));
        hints[w] = rt.groundAt(x, z, g, hints[w]);
        sum += g.height;
      }
      void i;
    }
    const ms = performance.now() - t0;
    expect(Number.isFinite(sum)).toBe(true);
    expect(ms, `1M groundAt took ${ms.toFixed(0)} ms`).toBeLessThan(1000);
    // project (barrier collisions) is also called a lot
    const tp = newPoint();
    const t1 = performance.now();
    let hint = -1;
    for (let k = 0; k < 400000; k++) {
      const j = (k * 3) % N;
      rt.pointAt(j * h, 2 * Math.sin(k * 0.01), out);
      hint = rt.project(out.x, out.z, tp, hint);
    }
    const ms2 = performance.now() - t1;
    console.info(`[track:${id}] 1M groundAt ${ms.toFixed(0)} ms, 400k pointAt+project ${ms2.toFixed(0)} ms`);
    expect(ms2, `400k pointAt+project took ${ms2.toFixed(0)} ms`).toBeLessThan(900);
  });
});

describe('TRACKS', () => {
  it('lists every track with complete info', () => {
    expect(TRACKS.length).toBeGreaterThanOrEqual(2);
    expect(TRACKS.map((t) => t.info.id)).toEqual(expect.arrayContaining(['aurelia', 'kuroyama']));
    for (const t of TRACKS) {
      expect(t.info.name.length).toBeGreaterThan(2);
      expect(t.info.description.length).toBeGreaterThan(40);
      expect(t.info.defaultLaps).toBeGreaterThan(0);
      expect(t.info.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(() => loadTrackRuntime('nope')).toThrow();
  });
});

// ── Brennwald Ring: the layout brief, as numbers ─────────────────────────────────────────────────────────────
describe('Brennwald Ring layout', () => {
  const rt = loadTrackRuntime('brennwald') as TrackRuntimeImpl;
  const info = TRACKS.find((t) => t.info.id === 'brennwald')!.info;
  const N = rt.count;
  const h = rt.spacing;
  const L = rt.length;
  const yAt = (s: number) => rt.py[Math.round((((s % L) + L) % L) / h) % N];
  const gradeBetween = (a: number, b: number) => (yAt(b) - yAt(a)) / (b - a);
  const corner = (name: string) => {
    const c = rt.corners.find((k) => k.name === name);
    expect(c, `corner ${name} exists`).toBeDefined();
    return c!;
  };
  /** Farthest distance from which a 1.0 m high object (a stopped car) at s is still hidden behind the crest, seen from a 1.1 m eye. */
  const blindFrom = (so: number) => {
    const yo = yAt(so) + 1.0;
    for (let D = 5; D <= 600; D++) {
      const ye = yAt(so - D) + 1.1;
      for (let e = 1; e < D; e++) if ((yAt(so - D + e) - ye) / e > (yo - ye) / D) return D;
    }
    return 600;
  };

  it('is a closed clockwise loop of 6.3-7.1 km made of the named corners, in order', () => {
    expect(rt.plan.closureError).toBeLessThan(0.01);
    expect((rt.plan.totalTurn * 180) / Math.PI).toBeCloseTo(-360, 1);
    const order = ['Tor', 'Birke', 'Hirsch', 'Hang', 'Wald', 'KesselL', 'KesselR', 'Jaeger', 'Ausfahrt', 'Mutprobe', 'Wacht', 'ZwillingA', 'ZwillingB', 'KoehlerR', 'KoehlerL'];
    const names = rt.corners.map((c) => c.name).filter((n) => order.includes(n));
    expect(names).toEqual(order);
    for (let i = 1; i < rt.corners.length; i++) expect(rt.corners[i].sStart).toBeGreaterThan(rt.corners[i - 1].sEnd - 1e-6);
    expect(info.lengthHint).toBeGreaterThan(L - 5);
    expect(info.lengthHint).toBeLessThan(L + 5);
  });

  it('has the signature corners of the brief', () => {
    const deg = (c: { angle: number }) => (c.angle * 180) / Math.PI;
    // fast double-apex: two right-handers back to back, the second apex tighter
    const za = corner('ZwillingA');
    const zb = corner('ZwillingB');
    expect(za.dir).toBe(-1);
    expect(zb.dir).toBe(-1);
    expect(zb.radius).toBeLessThan(za.radius);
    expect(zb.sStart - za.sEnd).toBeLessThan(80);
    expect(deg(za) + deg(zb)).toBeGreaterThan(60);
    expect(Math.min(za.radius, zb.radius)).toBeGreaterThan(120); // fast
    // hairpin for overtaking, taken from a long straight
    const j = corner('Jaeger');
    expect(j.dir).toBe(-1);
    expect(deg(j)).toBeGreaterThan(110);
    expect(j.radius).toBeLessThan(40);
    expect(j.sStart - corner('Rampe2').sEnd).toBeGreaterThan(300);
    // slow chicane (right-left) as the last corners before the line
    const kr = corner('KoehlerR');
    const kl = corner('KoehlerL');
    expect(kr.dir).toBe(-1);
    expect(kl.dir).toBe(1);
    expect(Math.max(kr.radius, kl.radius)).toBeLessThan(60);
    expect(L - kl.sEnd).toBeLessThan(250);
    expect(kl.sStart - kr.sEnd).toBeLessThan(80);
    // compression kicks into a left-right
    const kL = corner('KesselL');
    const kR = corner('KesselR');
    expect(kL.dir).toBe(1);
    expect(kR.dir).toBe(-1);
    expect(kR.sStart - kL.sEnd).toBeLessThan(30);
    // the start/finish straight (across the line) is the longest one
    expect(rt.corners.find((c) => c.name === 'Tor')!.sStart + (L - kl.sEnd)).toBeGreaterThan(780);
    // the medium sweepers in between
    for (const n of ['Birke', 'Hang', 'Ausfahrt', 'Wacht']) {
      const c = corner(n);
      expect(c.radius).toBeGreaterThan(200);
      expect(c.radius).toBeLessThan(900);
    }
  });

  it('plunges into the Kessel compression, then climbs steeply and for a long time', () => {
    // the lowest point of the lap is the bottom of the valley, a few metres before KesselL's entry
    let iMin = 0;
    for (let i = 0; i < N; i++) if (rt.py[i] < rt.py[iMin]) iMin = i;
    const sMin = iMin * h;
    const kL = corner('KesselL');
    expect(Math.abs(sMin - kL.sStart)).toBeLessThan(40);
    // fast downhill into it (>= 4.5 % over 250 m), a steep wall out of it
    expect(gradeBetween(sMin - 270, sMin - 20)).toBeLessThan(-0.045);
    expect(gradeBetween(sMin + 20, sMin + 170)).toBeGreaterThan(0.07);
    // the long uphill straight that follows (Rampe): ~0.9 km of slipstream climbing (3 % on average, 7.5 % at the foot) before the hairpin
    const sEnd = corner('KesselR').sEnd;
    const sHairpin = corner('Jaeger').sStart;
    expect(sHairpin - sEnd).toBeGreaterThan(850);
    expect(gradeBetween(sEnd, sHairpin)).toBeGreaterThan(0.025);
    // ... and the kinks on it are flat-out (R >= 1000 m) so that it really is a straight
    for (const n of ['Rampe1', 'Rampe2']) expect(corner(n).radius).toBeGreaterThanOrEqual(1000);
  });

  it('has a genuinely blind crest at the top of the circuit (Mutprobe)', () => {
    let iMax = 0;
    for (let i = 0; i < N; i++) if (rt.py[i] > rt.py[iMax]) iMax = i;
    const mut = corner('Mutprobe');
    expect(iMax * h).toBeGreaterThan(mut.sStart);
    expect(iMax * h).toBeLessThan(mut.sEnd);
    // not a cliff: a stopped car 40 m past the top is hidden until ~100 m away, but never closer than 60 m
    const d = blindFrom(iMax * h + 40);
    expect(d).toBeGreaterThan(60);
    expect(d).toBeLessThan(140);
    // vertical curvature stays a real crest (not flattened) yet gentle enough to be taken flat in the GT
    let crest = 0;
    for (let i = Math.floor(mut.sStart / h); i < Math.ceil(mut.sEnd / h); i++) crest = Math.min(crest, (rt.py[i + 1] - 2 * rt.py[i] + rt.py[i - 1]) / (h * h));
    expect(1 / -crest).toBeGreaterThan(1000);
    expect(1 / -crest).toBeLessThan(1600);
  });

  it('keeps 90 m of relief with believable gradients', () => {
    let minY = Infinity;
    let maxY = -Infinity;
    let up = 0;
    let down = 0;
    for (let i = 0; i < N; i++) {
      minY = Math.min(minY, rt.py[i]);
      maxY = Math.max(maxY, rt.py[i]);
      const g = rt.ty[i] / Math.hypot(rt.tx[i], rt.tz[i]);
      up = Math.max(up, g);
      down = Math.min(down, g);
    }
    expect(maxY - minY).toBeGreaterThan(85);
    expect(up).toBeGreaterThan(0.08); // the Kesselwand is steep
    expect(up).toBeLessThan(0.1);
    expect(down).toBeLessThan(-0.05); // the Abfahrt is fast and steep
    expect(down).toBeGreaterThan(-0.07);
  });

  it('has 11-13 m of asphalt everywhere and a banked, curbed corner set', () => {
    for (let i = 0; i < N; i++) {
      const w = rt.widthLeft[i] + rt.widthRight[i];
      expect(w).toBeGreaterThanOrEqual(11.9);
      expect(w).toBeLessThanOrEqual(13.1);
    }
    let curbed = 0;
    for (let i = 0; i < N; i++) if (rt.L.curbW[i] > 0.02 || rt.R.curbW[i] > 0.02) curbed++;
    expect(curbed * h).toBeGreaterThan(1200); // GP curbs on the inside of the corners
  });

  it('is distinguishable from the other circuits and fully described', () => {
    expect(info.color.toLowerCase()).not.toBe('#16e0bd'); // Aurelia
    expect(info.color.toLowerCase()).not.toBe('#ff2e63'); // Kuroyama
    expect(info.location.length).toBeGreaterThan(10);
    expect(info.difficulty).toBeGreaterThanOrEqual(1);
    expect(info.difficulty).toBeLessThanOrEqual(5);
    expect(['dawn', 'morning', 'noon', 'golden', 'dusk', 'night']).toContain(info.defaultTimeOfDay);
  });
});

// ── Porto Vela: the layout brief, as numbers ─────────────────────────────────────────────────────────────────
describe('Porto Vela layout', () => {
  const rt = loadTrackRuntime('portovela') as TrackRuntimeImpl;
  const info = TRACKS.find((t) => t.info.id === 'portovela')!.info;
  const N = rt.count;
  const h = rt.spacing;
  const L = rt.length;
  const corner = (name: string) => {
    const c = rt.corners.find((k) => k.name === name);
    expect(c, `corner ${name} exists`).toBeDefined();
    return c!;
  };
  const deg = (c: { angle: number }) => (c.angle * 180) / Math.PI;

  it('is a closed counter-clockwise loop of 3.8-4.2 km made of the named corners, in order', () => {
    expect(rt.plan.closureError).toBeLessThan(0.01);
    expect((rt.plan.totalTurn * 180) / Math.PI).toBeCloseTo(360, 1);
    const order = ['Cais', 'Farol1', 'Farol2', 'Farol3', 'Mirante', 'Colina1', 'Colina2', 'Praca1', 'Praca2', 'Cantar1', 'Cantar2', 'Sea', 'Seb', 'Castelo', 'Escadas', 'Descida1', 'Descida2', 'MarinaR', 'MarinaL', 'Doca'];
    expect(rt.corners.map((c) => c.name)).toEqual(order);
    for (let i = 1; i < rt.corners.length; i++) expect(rt.corners[i].sStart).toBeGreaterThan(rt.corners[i - 1].sEnd - 1e-6);
    expect(L).toBeGreaterThan(3800);
    expect(L).toBeLessThan(4200);
    expect(info.lengthHint).toBeGreaterThan(L - 60);
    expect(info.lengthHint).toBeLessThan(L + 60);
    expect(info.floodlit).toBe(true);
  });

  it('has the city-block corners, the hairpin and the harbourside chicane of the brief', () => {
    // 90 degree blocks, taken at different speeds (radii 18 to 34 m), rights and lefts
    const blocks = ['Cais', 'Mirante', 'Praca1', 'Praca2', 'Doca'];
    for (const n of blocks) expect(Math.abs(deg(corner(n)) - 90)).toBeLessThan(1);
    expect(corner('Praca1').dir).toBe(1);
    expect(corner('Praca2').dir).toBe(-1);
    const radii = blocks.map((n) => corner(n).radius);
    expect(Math.min(...radii)).toBeLessThan(20);
    expect(Math.max(...radii)).toBeGreaterThan(30);
    // the tight hairpin: two joined halves that turn the street round (> 160 degrees, R < 16 m)
    const sea = corner('Sea');
    const seb = corner('Seb');
    expect(seb.sStart - sea.sEnd).toBeLessThan(1);
    expect(deg(sea) + deg(seb)).toBeGreaterThan(160);
    expect(Math.max(sea.radius, seb.radius)).toBeLessThan(16);
    // the harbourside chicane (right-left) and the last left before the line
    expect(corner('MarinaR').dir).toBe(-1);
    expect(corner('MarinaL').dir).toBe(1);
    expect(corner('MarinaL').sStart - corner('MarinaR').sEnd).toBeLessThan(80);
    expect(L - corner('Doca').sEnd).toBeLessThan(150);
    // the fast waterfront straight runs from the line to the first corner, and is the longest stretch of the lap
    expect(corner('Cais').sStart).toBeGreaterThan(600);
    let longest = 0;
    for (let i = 1; i < rt.corners.length; i++) longest = Math.max(longest, rt.corners[i].sStart - rt.corners[i - 1].sEnd);
    expect(corner('Cais').sStart + (L - corner('Doca').sEnd)).toBeGreaterThan(longest);
    // the fast uphill sweepers (the LMP prototype takes them flat out): radii of 110 m and more
    for (const n of ['Farol1', 'Farol2', 'Farol3']) expect(corner(n).radius).toBeGreaterThanOrEqual(110);
  });

  it('climbs the hill and comes down again: 40 m of relief, 6 % up and 8 % down', () => {
    let minY = Infinity;
    let maxY = -Infinity;
    let up = 0;
    let down = 0;
    for (let i = 0; i < N; i++) {
      minY = Math.min(minY, rt.py[i]);
      maxY = Math.max(maxY, rt.py[i]);
      const g = rt.ty[i] / Math.hypot(rt.tx[i], rt.tz[i]);
      up = Math.max(up, g);
      down = Math.min(down, g);
    }
    expect(maxY - minY).toBeGreaterThan(38);
    expect(maxY - minY).toBeLessThan(50);
    expect(up).toBeGreaterThan(0.055);
    expect(up).toBeLessThan(0.075);
    expect(down).toBeLessThan(-0.075);
    expect(down).toBeGreaterThan(-0.095);
    // the quay is the lowest part, the old town the highest
    expect(rt.py[0]).toBeLessThan(minY + 1.5);
    const top = corner('Colina1');
    expect(rt.py[Math.round((top.sArcA + top.sArcB) / 2 / h)]).toBeGreaterThan(maxY - 3);
    // the long climb (Farol) gains most of it
    const yAt = (s: number) => rt.py[Math.round(rt.wrapS(s) / h) % N];
    expect(yAt(corner('Mirante').sStart) - yAt(corner('Cais').sEnd)).toBeGreaterThan(30);
  });

  it('has a tunnel on the Rua do Castelo, ending before the Escadas braking zone', () => {
    expect(rt.tunnelSpans.length).toBe(1);
    const [a, b] = rt.tunnelSpans[0];
    expect(b - a).toBeGreaterThan(180);
    expect(b - a).toBeLessThan(260);
    expect(a).toBeGreaterThan(corner('Castelo').sEnd - 1);
    expect(corner('Escadas').sStart - b).toBeGreaterThan(40);
    expect(rt.tunnelMask[Math.round((a + b) / 2 / h)]).toBe(1);
  });

  it('has a hill over the tunnel, with the castle on its crest clear of the tube', () => {
    const [a, b] = rt.tunnelSpans[0];
    const v = new Vector3();
    // the ground over the middle of the tube stands 8 m or more above the road: the terrain makes the hill, not the tunnel's cap
    for (let s = a + 70; s <= b - 70; s += 10) {
      for (const d of [-12, 0, 12]) {
        rt.pointAt(s, d, v);
        expect(rt.fieldHeight(v.x, v.z) - rt.py[Math.round(s / h)]).toBeGreaterThan(8);
      }
    }
    const lm = portovela.scenery!.city!.landmarks!.find((l) => l.kind === 'castle')!;
    const pl = placeLandmark(rt, lm)!;
    // its floor level (10.5 m above `pl.y`) is the crest; its walls start 3 m under that, over the tube's crown (5.6 m above the road),
    // or they would show inside the tunnel
    expect(Math.abs(pl.y + 10.5 - rt.fieldHeight(pl.x, pl.z))).toBeLessThan(2.5);
    const sMid = rt.wrapS((a + b) / 2);
    expect(pl.y + 7.5).toBeGreaterThan(rt.py[Math.round(sMid / h)] + 6);
  });

  it('has stone arches across the street that clear the barriers, the catch fences and the cars', () => {
    const arches = portovela.scenery!.city!.arches!;
    expect(arches.length).toBeGreaterThan(0);
    for (const a of arches) {
      const s = rt.wrapS(resolveMark(rt.plan.marks, L, a.at));
      const k = Math.round(s / h) % N;
      const c = rt.pointAt(s, 0, new Vector3());
      // on a straight, clear of the corners and the tunnel
      expect(Math.abs(rt.curvature[k])).toBeLessThan(1 / 800);
      for (const [t0, t1] of rt.tunnelSpans) expect(s < t0 - 30 || s > t1 + 30).toBe(true);
      const buf = new CityBuf();
      emitArch(buf, rt, s, a.depth);
      expect(buf.pos.length).toBeGreaterThan(600);
      let low = Infinity;
      let top = -Infinity;
      for (let i = 0; i < buf.pos.length; i += 3) {
        expect(Number.isFinite(buf.pos[i] + buf.pos[i + 1] + buf.pos[i + 2])).toBe(true);
        const u = (buf.pos[i] - c.x) * rt.HLX[k] + (buf.pos[i + 2] - c.z) * rt.HLZ[k];
        // between the barriers (and the posts and the leaning fence beside them) there is nothing below 6 m
        if (u > -rt.R.wall[k] - 0.3 && u < rt.L.wall[k] + 0.3) low = Math.min(low, buf.pos[i + 1] - c.y);
        top = Math.max(top, buf.pos[i + 1] - c.y);
      }
      expect(low).toBeGreaterThanOrEqual(6.1);
      expect(top).toBeLessThan(14);
    }
  });

  it('is 9.5-14 m of asphalt between walls, with escape roads at the heavy braking zones and tyre walls on the outside of the corners', () => {
    let widest = 0;
    for (let i = 0; i < N; i++) {
      const w = rt.widthLeft[i] + rt.widthRight[i];
      expect(w).toBeGreaterThanOrEqual(9.4);
      expect(w).toBeLessThanOrEqual(14.1);
      widest = Math.max(widest, w);
    }
    expect(widest).toBeGreaterThan(13.5); // the boulevard widens before the first corner
    // an escape road: the barrier stands 12+ m beyond the asphalt on the outside of the corner
    const outsideWall = (c: { sStart: number; sEnd: number; dir: number }): number => {
      let m = 0;
      for (let s = c.sStart - 60; s < c.sEnd; s += 2) {
        const i = Math.round(rt.wrapS(s) / h) % N;
        m = Math.max(m, c.dir > 0 ? rt.wallRight[i] - rt.widthRight[i] : rt.wallLeft[i] - rt.widthLeft[i]);
      }
      return m;
    };
    const escapes = ['Cais', 'Mirante', 'Praca1', 'Sea', 'Escadas', 'MarinaR', 'Doca'].filter((n) => outsideWall(corner(n)) > 12);
    expect(escapes.length).toBeGreaterThanOrEqual(5);
    // concrete walls with catch fences almost everywhere, tyre walls at the impact points
    let fence = 0;
    let tyres = 0;
    for (const S of [rt.L, rt.R]) {
      for (let i = 0; i < N; i++) {
        if (S.barrier[i] === 4) fence++;
        if (S.barrier[i] === 2) tyres++;
      }
    }
    expect((fence * h) / (2 * L)).toBeGreaterThan(0.4);
    expect(tyres * h).toBeGreaterThan(500);
  });

  it('is a city: paved beyond the barriers, with buildings, lamps and a harbour defined', () => {
    expect(rt.def.paved).toBe(true);
    const sc = rt.def.scenery!;
    expect(sc.city).toBeDefined();
    expect(sc.city!.skyline!.reach).toBeGreaterThan(500);
    expect(sc.lamps!.length).toBeGreaterThan(0);
    expect(rt.def.terrain.sea).toBeDefined();
    // the sea lies south of the waterfront (north < 0 on the map) and the straight is clear of it
    const sea = rt.terrain.seaDistance;
    for (let s = 0; s < 600; s += 50) {
      const i = Math.round(s / h);
      expect(sea(rt.px[i], rt.pz[i])).toBeGreaterThan(50);
    }
    expect(sea(-500, -300)).toBeLessThan(0); // in the bay
    expect(sea(-500, 300)).toBeGreaterThan(0); // in the city
  });

  it('is distinguishable from the other circuits and fully described', () => {
    for (const c of ['#16e0bd', '#ff2e63', '#ffb02e']) expect(info.color.toLowerCase()).not.toBe(c);
    expect(info.location.length).toBeGreaterThan(10);
    expect(info.description.length).toBeGreaterThan(100);
    expect(info.difficulty).toBeGreaterThanOrEqual(1);
    expect(info.difficulty).toBeLessThanOrEqual(5);
    expect(['dawn', 'morning', 'noon', 'golden', 'dusk', 'night']).toContain(info.defaultTimeOfDay);
  });
});
