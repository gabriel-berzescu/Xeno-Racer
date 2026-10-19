/**
 * Livery textures: three planar-projected canvases (side atlas, top, end) painted from a Livery.
 * Side projection keeps numbers undistorted on the doors (left half of the atlas is the left
 * flank, right half the right flank with the pattern mirrored but the digits not).
 */
import { CanvasTexture, LinearMipmapLinearFilter, LinearFilter, SRGBColorSpace, type Texture } from 'three';
import type { Livery, QualityLevel } from '../core/contracts';

export interface LiveryLayout {
  zNose: number; // padded
  zTail: number; // padded
  yMax: number;
  halfW: number;
  /** door number roundel: centre z, y and radius (m) */
  door: { z: number; y: number; r: number };
  /** hood number: centre z, radius */
  hood: { z: number; r: number };
  /** roof number: centre z, size */
  roof?: { z: number; r: number };
  /** beltline height used by split patterns */
  belt: number;
  /**
   * The patterns below are drawn for a car about 1.3 m tall (a stripe at 29 cm, a split at 50 cm, a chevron band centred at 52 cm).
   * A taller body lifts them: a height `y` is drawn at `y * scale + shift`, an extent `h` at `h * scale`. Absent: drawn as they are.
   */
  rise?: { scale: number; shift: number };
  /** The z the door-relative patterns (the hoops, the chevrons) hang from; absent: the door roundel's z. */
  patternZ?: number;
  /** The z the hood arrow hangs from (its tail 0.3 behind, its tip 0.8 ahead); absent: the hood number's z. */
  hoodArrow?: number;
  /** Road dust on the lower panels, 0..1 (a tan haze of speckle from the sill up to a metre, heavier behind the wheels); absent: a clean car. */
  dust?: number;
}

export interface LiveryTextures {
  side: CanvasTexture;
  top: CanvasTexture;
  end: CanvasTexture;
  dispose(): void;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

function lum(hex: string): number {
  const c = parseInt(hex.slice(1), 16);
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export type LiveryTier = QualityLevel | 'ai';

export const LIVERY_SIZE: Record<LiveryTier, { side: [number, number]; top: [number, number]; end: [number, number] }> = {
  ai: { side: [2048, 256], top: [256, 512], end: [256, 128] },
  low: { side: [2048, 256], top: [256, 512], end: [256, 128] },
  medium: { side: [3072, 384], top: [384, 768], end: [384, 192] },
  high: { side: [4096, 512], top: [512, 1024], end: [512, 256] },
  ultra: { side: [4096, 512], top: [512, 1024], end: [512, 256] },
};

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function poly(ctx: Ctx, pts: Array<[number, number]>, fill: string): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
}

function mulberry(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundel(ctx: Ctx, cx: number, cy: number, r: number, plate: string, ink: string, n: number, ring: string): void {
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = plate;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  const txt = String(n);
  const size = r * (txt.length > 1 ? 1.25 : 1.5);
  ctx.fillStyle = ink;
  ctx.font = `900 ${size}px "Arial Black", Impact, "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(txt, cx, cy + size * 0.04, r * 1.7);
}

export function paintLivery(l: Livery, lay: LiveryLayout, q: LiveryTier, tex?: LiveryTextures): LiveryTextures {
  const sz = LIVERY_SIZE[q];
  const side = tex?.side ?? new CanvasTexture(makeCanvas(sz.side[0], sz.side[1]) as HTMLCanvasElement);
  const top = tex?.top ?? new CanvasTexture(makeCanvas(sz.top[0], sz.top[1]) as HTMLCanvasElement);
  const end = tex?.end ?? new CanvasTexture(makeCanvas(sz.end[0], sz.end[1]) as HTMLCanvasElement);
  const sc = side.image as HTMLCanvasElement, tc = top.image as HTMLCanvasElement, ec = end.image as HTMLCanvasElement;
  const sctx = sc.getContext('2d') as Ctx, tctx = tc.getContext('2d') as Ctx, ectx = ec.getContext('2d') as Ctx;

  const Lz = lay.zNose - lay.zTail;
  const SW = sc.width, SH = sc.height;
  const hw = SW / 2;
  // side projection helpers (half 0 = left flank, nose at the left; half 1 = right flank, nose at the right)
  const sx = (half: number, z: number): number => (half === 0 ? ((lay.zNose - z) / Lz) * hw : hw + ((z - lay.zTail) / Lz) * hw);
  const sy = (y: number): number => (1 - y / lay.yMax) * SH;
  const TW = tc.width, TH = tc.height;
  const tx = (x: number): number => (0.5 + x / (2 * lay.halfW)) * TW;
  const ty = (z: number): number => ((z - lay.zTail) / Lz) * TH;
  const EW = ec.width, EH = ec.height;
  const ex = (half: number, x: number): number => (half === 0 ? (0.5 + x / (2 * lay.halfW)) * (EW / 2) : EW / 2 + (0.5 - x / (2 * lay.halfW)) * (EW / 2));
  const ey = (y: number): number => (1 - y / lay.yMax) * EH;

  // pattern heights as drawn for a 1.3 m car, lifted onto this car's panels (the identity for every car without a `rise`)
  const rs = lay.rise;
  const hy = (y: number): number => (rs ? y * rs.scale + rs.shift : y);
  const hs = (h: number): number => (rs ? h * rs.scale : h);

  const P = l.primary, S = l.secondary, A = l.accent;
  for (const c of [sctx, tctx, ectx]) {
    c.fillStyle = P;
  }
  sctx.fillRect(0, 0, SW, SH);
  tctx.fillRect(0, 0, TW, TH);
  ectx.fillRect(0, 0, EW, EH);

  const both = (fn: (half: number) => void): void => {
    fn(0);
    fn(1);
  };

  switch (l.pattern) {
    case 'stripes': {
      // twin stripes over hood/roof/trunk with accent pin-lines
      const w = 0.2, gap = 0.035, pin = 0.012;
      for (const sgn of [-1, 1]) {
        const x0 = sgn * (gap / 2), x1 = sgn * (gap / 2 + w);
        tctx.fillStyle = S;
        tctx.fillRect(tx(Math.min(x0, x1)), 0, Math.abs(tx(x1) - tx(x0)), TH);
        tctx.fillStyle = A;
        const p0 = sgn * (gap / 2 + w + 0.018);
        tctx.fillRect(tx(Math.min(p0, p0 + sgn * pin)), 0, Math.abs(tx(p0 + sgn * pin) - tx(p0)), TH);
        // end faces
        for (let half = 0; half < 2; half++) {
          ectx.fillStyle = S;
          const xa = ex(half, x0), xb = ex(half, x1);
          ectx.fillRect(Math.min(xa, xb), 0, Math.abs(xb - xa), EH);
          ectx.fillStyle = A;
          const pa = ex(half, p0), pb = ex(half, p0 + sgn * pin);
          ectx.fillRect(Math.min(pa, pb), 0, Math.abs(pb - pa), EH);
        }
      }
      both((h) => {
        sctx.fillStyle = A;
        const x0 = sx(h, lay.zNose), x1 = sx(h, lay.zTail);
        sctx.fillRect(Math.min(x0, x1), sy(hy(0.3)), Math.abs(x1 - x0), sy(hy(0.288)) - sy(hy(0.3)));
      });
      break;
    }
    case 'split': {
      // lower body in the secondary colour, rising rearwards, accent line on the break
      both((h) => {
        const yA = hy(0.5), yB = lay.belt + 0.02;
        poly(sctx, [[sx(h, lay.zNose), sy(0)], [sx(h, lay.zNose), sy(yA)], [sx(h, lay.zTail), sy(yB)], [sx(h, lay.zTail), sy(0)]], S);
        const yA2 = yA + hs(0.014), yB2 = yB + hs(0.014);
        poly(sctx, [[sx(h, lay.zNose), sy(yA)], [sx(h, lay.zNose), sy(yA2)], [sx(h, lay.zTail), sy(yB2)], [sx(h, lay.zTail), sy(yB)]], A);
      });
      for (let half = 0; half < 2; half++) {
        ectx.fillStyle = S;
        const x0 = half === 0 ? 0 : EW / 2;
        ectx.fillRect(x0, ey(hy(0.5)), EW / 2, EH - ey(hy(0.5)));
        ectx.fillStyle = A;
        ectx.fillRect(x0, ey(hy(0.5) + hs(0.014)), EW / 2, ey(hy(0.5)) - ey(hy(0.5) + hs(0.014)));
      }
      break;
    }
    case 'arrow': {
      // three forward-pointing chevron bands along each flank, a bold arrow on the hood
      const chev = (h: number, zt: number, w: number, c: string): void => {
        const ym = hy(0.52), hh = hs(0.36), a = 0.5;
        poly(sctx, [[sx(h, zt), sy(ym)], [sx(h, zt - a), sy(ym + hh)], [sx(h, zt - a - w), sy(ym + hh)], [sx(h, zt - w), sy(ym)], [sx(h, zt - a - w), sy(ym - hh)], [sx(h, zt - a), sy(ym - hh)]], c);
      };
      both((h) => {
        const z0 = (lay.patternZ ?? lay.door.z) + 1.18;
        chev(h, z0, 0.13, S);
        chev(h, z0 - 0.3, 0.07, A);
        chev(h, z0 - 0.56, 0.13, S);
      });
      const hz = lay.hoodArrow ?? lay.hood.z;
      poly(tctx, [[tx(0), ty(hz + 0.8)], [tx(0.44), ty(hz - 0.3)], [tx(0.22), ty(hz - 0.3)], [tx(0), ty(hz + 0.22)], [tx(-0.22), ty(hz - 0.3)], [tx(-0.44), ty(hz - 0.3)]], S);
      poly(tctx, [[tx(0), ty(hz + 0.56)], [tx(0.24), ty(hz - 0.1)], [tx(0.14), ty(hz - 0.1)], [tx(0), ty(hz + 0.24)], [tx(-0.14), ty(hz - 0.1)], [tx(-0.24), ty(hz - 0.1)]], A);
      // roof + deck centre stripe
      tctx.fillStyle = S;
      tctx.fillRect(tx(-0.13), 0, tx(0.13) - tx(-0.13), ty(hz - 0.5));
      tctx.fillStyle = A;
      tctx.fillRect(tx(-0.02), 0, tx(0.02) - tx(-0.02), ty(hz - 0.5));
      break;
    }
    case 'hoops': {
      // bold transverse hoops: vertical bars on the flanks, bands across the roof/hood/deck
      const pz = lay.patternZ ?? lay.door.z;
      const zs = [pz + 0.95, pz - 0.05, pz - 1.05];
      zs.forEach((z, i) => {
        const w = 0.16;
        const c = i === 1 ? A : S;
        both((h) => {
          const x0 = sx(h, z + w / 2), x1 = sx(h, z - w / 2);
          sctx.fillStyle = c;
          sctx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), SH);
        });
        tctx.fillStyle = c;
        tctx.fillRect(0, ty(z - w / 2), TW, ty(z + w / 2) - ty(z - w / 2));
      });
      break;
    }
    case 'shards': {
      // forward-leaning speed shards flowing from the tail, layered; chevron bands across the top
      both((h) => {
        for (let i = 0; i < 9; i++) {
          const z0 = lay.zTail + 0.1 + i * 0.48;
          const L = 1.0 + 0.25 * (i % 3);
          const y0 = hy(0.14 + 0.07 * (i % 3));
          const H = hs(0.38 + 0.12 * ((i + 1) % 3));
          const c = i % 3 === 1 ? A : S;
          poly(sctx, [[sx(h, z0), sy(y0)], [sx(h, z0 + L), sy(y0 + hs(0.1))], [sx(h, z0 + L - 0.32), sy(y0 + H)], [sx(h, z0 - 0.32), sy(y0 + H - hs(0.1))]], c);
        }
      });
      for (let i = 0; i < 7; i++) {
        const z0 = lay.zTail + 0.25 + i * 0.62;
        const c = i % 3 === 1 ? A : S;
        const hwid = lay.halfW * 0.92;
        poly(tctx, [[tx(-hwid), ty(z0)], [tx(0), ty(z0 + 0.4)], [tx(hwid), ty(z0)], [tx(hwid), ty(z0 - 0.14)], [tx(0), ty(z0 + 0.26)], [tx(-hwid), ty(z0 - 0.14)]], c);
      }
      break;
    }
    default:
      break;
  }

  // road dust: speckle thrown up from the road, thick at the sill and thinning out up the doors (an overlander wears its trips)
  if (lay.dust) {
    const rnd = mulberry(4401);
    const dustCol = (a: number): string => `rgba(184,158,118,${a.toFixed(3)})`;
    const speckle = (ctx: Ctx, x0: number, x1: number, yTop: number, n: number, rMax: number, w: (u: number) => number, yOf: (y: number) => number): void => {
      for (let i = 0; i < n; i++) {
        const u = rnd();
        const x = x0 + (x1 - x0) * rnd();
        const y = yTop * u * u * u;
        if (rnd() > w(x)) continue;
        const r = (0.4 + 0.6 * rnd()) * rMax;
        ctx.fillStyle = dustCol((0.1 + 0.3 * rnd()) * lay.dust! * (1 - 0.55 * u));
        ctx.beginPath();
        ctx.ellipse(x, yOf(y), r, r * (0.7 + 0.5 * rnd()), 0, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    both((h) => {
      // a haze up to 55 cm, and the speckle on top of it
      const yTopPx = sy(0.55), yBotPx = sy(0);
      const gx0 = Math.min(sx(h, lay.zNose), sx(h, lay.zTail)), gx1 = Math.max(sx(h, lay.zNose), sx(h, lay.zTail));
      const g = sctx.createLinearGradient(0, yBotPx, 0, yTopPx);
      g.addColorStop(0, dustCol(0.5 * lay.dust!));
      g.addColorStop(1, dustCol(0));
      sctx.fillStyle = g;
      sctx.fillRect(gx0, yTopPx, gx1 - gx0, yBotPx - yTopPx);
      // heavier behind each wheel (the rooster tail), lighter ahead of it
      const wheelZ = [lay.zNose - 1.2, lay.zTail + 1.2];
      const weight = (x: number): number => {
        let k = 0.55;
        for (const wz of wheelZ) {
          const px = sx(h, wz);
          const behind = h === 0 ? x - px : px - x; // the nose is on the left in half 0, on the right in half 1
          if (behind > -SW * 0.0005 && behind < SW * 0.06) k = 1;
        }
        return k;
      };
      speckle(sctx, gx0, gx1, 1.0, 5200, SH * 0.012, weight, sy);
    });
    // the nose and the tail get the same haze (the bumpers are the first thing the road hits)
    for (let half = 0; half < 2; half++) {
      const x0 = half === 0 ? 0 : EW / 2;
      const g = ectx.createLinearGradient(0, ey(0), 0, ey(0.55));
      g.addColorStop(0, dustCol(0.42 * lay.dust));
      g.addColorStop(1, dustCol(0));
      ectx.fillStyle = g;
      ectx.fillRect(x0, ey(0.55), EW / 2, ey(0) - ey(0.55));
    }
  }

  // race numbers: plate colour from the body luminance
  const dark = lum(P) < 0.45;
  const plate = dark ? '#f4f5f7' : '#14151a';
  const ink = dark ? '#101114' : '#f4f5f7';
  both((h) => {
    const cx = sx(h, lay.door.z);
    const cy = sy(lay.door.y);
    const r = (lay.door.r / lay.yMax) * SH;
    roundel(sctx, cx, cy, r, plate, ink, l.number, A);
  });
  {
    const cx = tx(0), cy = ty(lay.hood.z);
    const r = (lay.hood.r / (2 * lay.halfW)) * TW;
    // the top map's v axis is stretched differently in x and z, draw into a squashed frame
    tctx.save();
    tctx.translate(cx, cy);
    tctx.scale(1, (TH / Lz) / (TW / (2 * lay.halfW)));
    roundel(tctx, 0, 0, r, plate, ink, l.number, A);
    tctx.restore();
  }

  side.colorSpace = SRGBColorSpace;
  top.colorSpace = SRGBColorSpace;
  end.colorSpace = SRGBColorSpace;
  for (const t of [side, top, end] as Texture[]) {
    t.generateMipmaps = true;
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
    t.anisotropy = 16;
    t.needsUpdate = true;
  }
  return (
    tex ?? {
      side,
      top,
      end,
      dispose() {
        side.dispose();
        top.dispose();
        end.dispose();
      },
    }
  );
}
