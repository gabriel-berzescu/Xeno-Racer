/**
 * CPU atmosphere model (owner: render).
 *
 * Single scattering (Rayleigh + Mie + ozone absorption) with an isotropic second-order
 * multiple-scattering term, integrated for a ground-level observer. The result is baked into a
 * small sky LUT (relative azimuth to the sun x elevation) that the sky-dome shader samples with one
 * texture fetch, plus the handful of derived values the light rig and fog need (sun transmittance,
 * mean sky radiance, horizon haze colour). Evaluated once per environment change, never per frame.
 *
 * Pure TypeScript: no three.js import, so it is unit-testable headlessly.
 *
 * Units: kilometres inside the integrator; radiance is relative to a solar irradiance of 1.
 */

export type RGB = [number, number, number];

const PI = Math.PI;
const R_PLANET = 6360;
const R_TOP = 6460;
const H_RAYLEIGH = 8.0;
const H_MIE = 1.2;
const BETA_R: RGB = [5.802e-3, 13.558e-3, 33.1e-3];
const BETA_M_SCAT = 3.996e-3;
const BETA_M_EXT = 3.996e-3 + 4.44e-3;
const BETA_OZONE: RGB = [0.65e-3, 1.881e-3, 0.085e-3];
/** Double Henyey-Greenstein aerosol phase: a tight forward lobe plus a broad one (wide haze glow toward the sun). */
const MIE_G1 = 0.8;
const MIE_G2 = 0.3;
const MIE_W1 = 0.62;
function hg(cosT: number, g: number): number {
  const g2 = g * g;
  return (1 - g2) / (4 * PI * Math.pow(1 + g2 - 2 * g * cosT, 1.5));
}

/** Elevation offset (rad) below the horizon that the LUT still covers. */
export const LUT_E0 = 0.06;
const LUT_RANGE = PI / 2 + LUT_E0;

/** LUT v coordinate for an elevation (rad). Matches the GLSL in skyShader.ts. */
export function lutV(el: number): number {
  return Math.sqrt(Math.min(1, Math.max(0, (el + LUT_E0) / LUT_RANGE)));
}
export function lutElevation(v: number): number {
  return v * v * LUT_RANGE - LUT_E0;
}
/** LUT u coordinate for the azimuth angle relative to the sun, phi in [0, PI]. */
export function lutU(phi: number): number {
  return Math.sqrt(Math.min(1, Math.max(0, phi / PI)));
}
export function lutPhi(u: number): number {
  return u * u * PI;
}

export interface SkyModelParams {
  /** Sun (or moon) elevation above the horizon, radians. May be slightly negative. */
  sunElevation: number;
  /** Aerosol multiplier: 1 = clear air, 2+ = hazy. */
  mieScale?: number;
  /** Multiple-scattering gain (1 = second order only). */
  msGain?: number;
  width?: number;
  height?: number;
  /** Samples along the view ray / the sun ray. */
  viewSteps?: number;
  sunSteps?: number;
  /** Observer altitude above sea level, km. */
  observerAltitude?: number;
}

export interface SkyModel {
  width: number;
  height: number;
  /** RGBA float LUT, row-major, v = row index. Radiance relative to solar irradiance 1. */
  lut: Float32Array;
  /** Transmittance of sunlight from the observer through the whole atmosphere (0..1 per channel). */
  sunTransmittance: RGB;
  /** Cosine-weighted mean sky radiance over the upper hemisphere (what a horizontal surface sees). */
  skyMeanCos: RGB;
  /** Plain mean radiance of the upper hemisphere. */
  skyMean: RGB;
  zenith: RGB;
  /** Horizon radiance at several azimuths relative to the sun (elevation ~1.5 degrees). */
  horizonSun: RGB;
  horizonSide: RGB;
  horizonAway: RGB;
  /**
   * Horizon haze colour at FOG_TABLE_SIZE azimuths relative to the sun, phi_k = PI * (k / (N-1))^2
   * (same square-root spacing as the LUT's u axis), RGB triplets. This is what distant geometry
   * fades into, so fog meets the sky at the horizon in every direction.
   */
  fogTable: Float32Array;
}

export const FOG_TABLE_SIZE = 8;

interface Ctx {
  sx: number; // sun direction
  sy: number;
  sz: number;
  mie: number;
  hObs: number;
  nView: number;
  nSun: number;
  viewW: Float64Array; // normalised distances (i/N)^k
  sunW: Float64Array;
}

const _acc = new Float64Array(12);

function makeTable(n: number, k: number): Float64Array {
  const t = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = Math.pow(i / n, k);
  return t;
}

/** Optical depth (per channel) from point p along the sun direction up to the top of the atmosphere. Returns false when the planet blocks the sun. */
function sunOpticalDepth(px: number, py: number, pz: number, ctx: Ctx, out: Float64Array, o: number): boolean {
  const r2 = px * px + py * py + pz * pz;
  const mu = px * ctx.sx + py * ctx.sy + pz * ctx.sz;
  if (mu < 0 && r2 - mu * mu < R_PLANET * R_PLANET) return false;
  const disc = mu * mu - (r2 - R_TOP * R_TOP);
  const tTop = -mu + Math.sqrt(Math.max(0, disc));
  const w = ctx.sunW;
  let tr = 0, tg = 0, tb = 0;
  for (let j = 0; j < ctx.nSun; j++) {
    const a = w[j] * tTop;
    const b = w[j + 1] * tTop;
    const t = (a + b) * 0.5;
    const ds = b - a;
    const x = px + ctx.sx * t, y = py + ctx.sy * t, z = pz + ctx.sz * t;
    const h = Math.sqrt(x * x + y * y + z * z) - R_PLANET;
    const dR = Math.exp(-h / H_RAYLEIGH);
    const dM = Math.exp(-h / H_MIE) * ctx.mie;
    const dO = Math.max(0, 1 - Math.abs(h - 25) / 15);
    tr += (BETA_R[0] * dR + BETA_M_EXT * dM + BETA_OZONE[0] * dO) * ds;
    tg += (BETA_R[1] * dR + BETA_M_EXT * dM + BETA_OZONE[1] * dO) * ds;
    tb += (BETA_R[2] * dR + BETA_M_EXT * dM + BETA_OZONE[2] * dO) * ds;
  }
  out[o] = tr;
  out[o + 1] = tg;
  out[o + 2] = tb;
  return true;
}

/**
 * Integrate one view ray. Writes radiance (3) into out[0..2] and the "air light coverage"
 * integral of sigma_s * T (3) into out[3..5] (used for the multiple scattering term).
 */
function traceRay(el: number, phi: number, ctx: Ctx, out: Float64Array): void {
  const e = Math.max(el, 0.0006);
  const ce = Math.cos(e);
  const dx = ce * Math.cos(phi), dy = Math.sin(e), dz = ce * Math.sin(phi);
  const py0 = R_PLANET + ctx.hObs;
  const b = py0 * dy;
  const c = py0 * py0 - R_TOP * R_TOP;
  const tMax = -b + Math.sqrt(Math.max(0, b * b - c));
  const cosT = dx * ctx.sx + dy * ctx.sy + dz * ctx.sz;
  const phaseR = (3 / (16 * PI)) * (1 + cosT * cosT);
  const phaseM = MIE_W1 * hg(cosT, MIE_G1) + (1 - MIE_W1) * hg(cosT, MIE_G2);

  let Lr = 0, Lg = 0, Lb = 0;
  let Ar = 0, Ag = 0, Ab = 0;
  let Tr = 1, Tg = 1, Tb = 1;
  const w = ctx.viewW;
  for (let i = 0; i < ctx.nView; i++) {
    const a = w[i] * tMax;
    const bb = w[i + 1] * tMax;
    const t = (a + bb) * 0.5;
    const ds = bb - a;
    const x = dx * t, y = py0 + dy * t, z = dz * t;
    const h = Math.sqrt(x * x + y * y + z * z) - R_PLANET;
    const dR = Math.exp(-h / H_RAYLEIGH);
    const dM = Math.exp(-h / H_MIE) * ctx.mie;
    const dO = Math.max(0, 1 - Math.abs(h - 25) / 15);

    const sr = BETA_R[0] * dR, sg = BETA_R[1] * dR, sb = BETA_R[2] * dR; // rayleigh scattering == extinction
    const sm = BETA_M_SCAT * dM;
    const er = sr + BETA_M_EXT * dM + BETA_OZONE[0] * dO;
    const eg = sg + BETA_M_EXT * dM + BETA_OZONE[1] * dO;
    const eb = sb + BETA_M_EXT * dM + BETA_OZONE[2] * dO;

    const tau_r = er * ds, tau_g = eg * ds, tau_b = eb * ds;
    const sr_ = Math.exp(-tau_r), sg_ = Math.exp(-tau_g), sb_ = Math.exp(-tau_b);

    if (sunOpticalDepth(x, y, z, ctx, _acc, 6)) {
      const Sr = (sr * phaseR + sm * phaseM) * Math.exp(-_acc[6]);
      const Sg = (sg * phaseR + sm * phaseM) * Math.exp(-_acc[7]);
      const Sb = (sb * phaseR + sm * phaseM) * Math.exp(-_acc[8]);
      // energy conserving integration of S over the step with transmittance
      Lr += (Tr * (Sr - Sr * sr_)) / Math.max(er, 1e-9);
      Lg += (Tg * (Sg - Sg * sg_)) / Math.max(eg, 1e-9);
      Lb += (Tb * (Sb - Sb * sb_)) / Math.max(eb, 1e-9);
    }
    // isotropic scattering coverage (for multiple scattering)
    const ssr = sr + sm, ssg = sg + sm, ssb = sb + sm;
    Ar += (Tr * (ssr - ssr * sr_)) / Math.max(er, 1e-9);
    Ag += (Tg * (ssg - ssg * sg_)) / Math.max(eg, 1e-9);
    Ab += (Tb * (ssb - ssb * sb_)) / Math.max(eb, 1e-9);

    Tr *= sr_;
    Tg *= sg_;
    Tb *= sb_;
  }
  out[0] = Lr;
  out[1] = Lg;
  out[2] = Lb;
  out[3] = Ar;
  out[4] = Ag;
  out[5] = Ab;
}

function makeCtx(p: SkyModelParams): Ctx {
  const nView = p.viewSteps ?? 22;
  const nSun = p.sunSteps ?? 6;
  return {
    sx: Math.cos(p.sunElevation),
    sy: Math.sin(p.sunElevation),
    sz: 0,
    mie: p.mieScale ?? 1,
    hObs: p.observerAltitude ?? 0.002,
    nView,
    nSun,
    viewW: makeTable(nView, 2.6),
    sunW: makeTable(nSun, 2.2),
  };
}

/** Transmittance of sunlight from the observer to space, per channel. */
export function sunTransmittance(sunElevation: number, mieScale = 1, observerAltitude = 0.002): RGB {
  const ctx = makeCtx({ sunElevation, mieScale, observerAltitude, sunSteps: 24 });
  const ok = sunOpticalDepth(0, R_PLANET + ctx.hObs, 0, ctx, _acc, 0);
  if (!ok) return [0, 0, 0];
  return [Math.exp(-_acc[0]), Math.exp(-_acc[1]), Math.exp(-_acc[2])];
}

/** Evaluate the radiance of a single direction (azimuth relative to the sun phi, elevation el). */
export function skyRadiance(p: SkyModelParams, el: number, phi: number): RGB {
  const ctx = makeCtx(p);
  traceRay(el, phi, ctx, _acc);
  return [_acc[0], _acc[1], _acc[2]];
}

/**
 * Bake the sky LUT and derived values. `yieldEvery` lets a caller keep the page responsive: when
 * given, the work is split into chunks and `yieldFn` is awaited between them.
 */
export async function computeSkyModel(p: SkyModelParams, yieldFn?: () => Promise<void>): Promise<SkyModel> {
  const width = p.width ?? 160;
  const height = p.height ?? 80;
  const ctx = makeCtx(p);
  const msGain = p.msGain ?? 1;
  const lut = new Float32Array(width * height * 4);
  const air = new Float32Array(width * height * 3);

  const rowsPerChunk = yieldFn ? Math.max(4, Math.ceil(height / 6)) : height;
  for (let j = 0; j < height; j++) {
    const el = lutElevation((j + 0.5) / height);
    for (let i = 0; i < width; i++) {
      const phi = lutPhi((i + 0.5) / width);
      traceRay(el, phi, ctx, _acc);
      const o = (j * width + i) * 4;
      lut[o] = _acc[0];
      lut[o + 1] = _acc[1];
      lut[o + 2] = _acc[2];
      lut[o + 3] = 1;
      const a = (j * width + i) * 3;
      air[a] = _acc[3];
      air[a + 1] = _acc[4];
      air[a + 2] = _acc[5];
    }
    if (yieldFn && (j + 1) % rowsPerChunk === 0) await yieldFn();
  }

  // Hemisphere statistics from the first-order radiance (cells above the horizon).
  let wSum = 0, wCos = 0;
  const mean: RGB = [0, 0, 0];
  const meanCos: RGB = [0, 0, 0];
  for (let j = 0; j < height; j++) {
    const elC = lutElevation((j + 0.5) / height);
    if (elC < 0) continue;
    const el0 = lutElevation(j / height), el1 = lutElevation((j + 1) / height);
    const dEl = Math.max(0, el1 - Math.max(el0, 0));
    for (let i = 0; i < width; i++) {
      const phi0 = lutPhi(i / width), phi1 = lutPhi((i + 1) / width);
      const dPhi = (phi1 - phi0) * 2; // symmetric about the sun's vertical plane
      const dOmega = Math.cos(elC) * dEl * dPhi;
      const wgt = dOmega;
      const wc = dOmega * Math.sin(elC);
      const o = (j * width + i) * 4;
      mean[0] += lut[o] * wgt; mean[1] += lut[o + 1] * wgt; mean[2] += lut[o + 2] * wgt;
      meanCos[0] += lut[o] * wc; meanCos[1] += lut[o + 1] * wc; meanCos[2] += lut[o + 2] * wc;
      wSum += wgt;
      wCos += wc;
    }
  }
  const Lbar: RGB = [mean[0] / wSum, mean[1] / wSum, mean[2] / wSum];
  const Lcos: RGB = [meanCos[0] / wCos, meanCos[1] / wCos, meanCos[2] / wCos];

  // Second-order (isotropic) multiple scattering: every air element re-scatters the mean radiance.
  if (msGain > 0) {
    for (let k = 0; k < width * height; k++) {
      const o = k * 4, a = k * 3;
      lut[o] += Lbar[0] * air[a] * msGain;
      lut[o + 1] += Lbar[1] * air[a + 1] * msGain;
      lut[o + 2] += Lbar[2] * air[a + 2] * msGain;
    }
    for (let c = 0; c < 3; c++) {
      mean[c] = 0;
      meanCos[c] = 0;
    }
    // recompute hemisphere stats including multiple scattering
    wSum = 0;
    wCos = 0;
    for (let j = 0; j < height; j++) {
      const elC = lutElevation((j + 0.5) / height);
      if (elC < 0) continue;
      const el0 = lutElevation(j / height), el1 = lutElevation((j + 1) / height);
      const dEl = Math.max(0, el1 - Math.max(el0, 0));
      for (let i = 0; i < width; i++) {
        const dPhi = (lutPhi((i + 1) / width) - lutPhi(i / width)) * 2;
        const dOmega = Math.cos(elC) * dEl * dPhi;
        const wc = dOmega * Math.sin(elC);
        const o = (j * width + i) * 4;
        for (let c = 0; c < 3; c++) {
          mean[c] += lut[o + c] * dOmega;
          meanCos[c] += lut[o + c] * wc;
        }
        wSum += dOmega;
        wCos += wc;
      }
    }
    for (let c = 0; c < 3; c++) {
      mean[c] /= wSum;
      meanCos[c] /= wCos;
    }
  } else {
    for (let c = 0; c < 3; c++) {
      mean[c] = Lbar[c];
      meanCos[c] = Lcos[c];
    }
  }

  // Horizon samples (read from the finished LUT so they include multiple scattering).
  const sample = (phi: number, el: number): RGB => {
    const u = lutU(phi) * width - 0.5;
    const v = lutV(el) * height - 0.5;
    const i0 = Math.max(0, Math.min(width - 2, Math.floor(u)));
    const j0 = Math.max(0, Math.min(height - 2, Math.floor(v)));
    const fu = Math.min(1, Math.max(0, u - i0));
    const fv = Math.min(1, Math.max(0, v - j0));
    const r: RGB = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = lut[(j0 * width + i0) * 4 + c], b = lut[(j0 * width + i0 + 1) * 4 + c];
      const d = lut[((j0 + 1) * width + i0) * 4 + c], e = lut[((j0 + 1) * width + i0 + 1) * 4 + c];
      r[c] = (a * (1 - fu) + b * fu) * (1 - fv) + (d * (1 - fu) + e * fu) * fv;
    }
    return r;
  };
  const hEl = 0.03;
  const horizonSun = sample(0.0, hEl);
  const horizonSide = sample(PI * 0.5, hEl);
  const horizonAway = sample(PI, hEl);

  const fogTable = new Float32Array(FOG_TABLE_SIZE * 3);
  for (let k = 0; k < FOG_TABLE_SIZE; k++) {
    const c = sample(PI * Math.pow(k / (FOG_TABLE_SIZE - 1), 2), 0.02);
    fogTable[k * 3] = c[0];
    fogTable[k * 3 + 1] = c[1];
    fogTable[k * 3 + 2] = c[2];
  }
  const zenith = sample(0, PI / 2 - 0.001);

  const trans = sunTransmittance(p.sunElevation, p.mieScale ?? 1, p.observerAltitude ?? 0.002);

  return {
    width,
    height,
    lut,
    sunTransmittance: trans,
    skyMeanCos: meanCos as RGB,
    skyMean: mean as RGB,
    zenith,
    horizonSun,
    horizonSide,
    horizonAway,
    fogTable,
  };
}
