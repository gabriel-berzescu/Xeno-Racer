/**
 * Small procedural textures for the car (canvas based, main thread only).
 */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, ClampToEdgeWrapping } from 'three';
import type { CarVisualSpec } from '../core/contracts';

const tireCache = new Map<string, { tex: CanvasTexture; refs: number }>();

/** Shared (ref-counted) tyre lettering texture. */
export function acquireTireTextTexture(spec: CarVisualSpec, slick: boolean, accent: string): { tex: CanvasTexture; release(): void } {
  const key = `${spec.style}|${spec.tireWidthFront}|${spec.wheelRadiusFront}|${spec.rimRadiusFront}|${slick}|${slick ? accent : ''}`;
  let e = tireCache.get(key);
  if (!e) {
    e = { tex: createTireTextTexture(spec, slick, accent), refs: 0 };
    tireCache.set(key, e);
  }
  e.refs++;
  const entry = e;
  let released = false;
  return {
    tex: entry.tex,
    release(): void {
      if (released) return;
      released = true;
      if (--entry.refs <= 0) {
        entry.tex.dispose();
        tireCache.delete(key);
      }
    },
  };
}

/** Tyre sidewall lettering: alpha mask, u = angle around the wheel, v = radial position (0 bead .. 1 shoulder). */
export function createTireTextTexture(spec: CarVisualSpec, slick: boolean, accent: string): CanvasTexture {
  const W = 2048, H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  const size = `${Math.round(spec.tireWidthFront * 1000)}/${Math.round(((spec.wheelRadiusFront - spec.rimRadiusFront) / spec.tireWidthFront) * 100)} R${Math.round((spec.rimRadiusFront * 2) / 0.0254)}`;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  const drawText = (txt: string, x: number, yFrac: number, px: number, weight: string, fill: string): void => {
    g.font = `${weight} ${px}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
    g.fillStyle = fill;
    g.fillText(txt, x, H * (1 - yFrac));
  };
  if (slick) {
    // racing slick: big brand + a coloured ring
    g.fillStyle = accent;
    g.fillRect(0, H * (1 - 0.34), W, 5);
    drawText('XENO', 120, 0.62, 56, '900', '#ffffff');
    drawText('RACING', 330, 0.62, 56, '700', '#ffffff');
    drawText(size, 640, 0.5, 30, '600', '#ffffff');
    drawText('XENO', 1280, 0.62, 56, '900', '#ffffff');
    drawText('SLICK  •  MEDIUM', 1500, 0.5, 30, '600', '#ffffff');
  } else {
    drawText('XENO SPORT', 60, 0.58, 46, '800', '#ffffff');
    drawText(size + 'W', 440, 0.58, 40, '600', '#ffffff');
    drawText('TREADWEAR 280 • TRACTION AA • TEMPERATURE A', 700, 0.46, 24, '500', '#ffffff');
    drawText('XENO SPORT', 1270, 0.58, 46, '800', '#ffffff');
    drawText(size + 'W', 1650, 0.58, 40, '600', '#ffffff');
  }
  const t = new CanvasTexture(c);
  t.wrapS = RepeatWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 8;
  return t;
}
