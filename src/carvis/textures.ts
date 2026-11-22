/**
 * Small procedural textures for the car (canvas based, main thread only).
 */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, ClampToEdgeWrapping } from 'three';
import type { CarVisualSpec } from '../core/contracts';
import { isFormula04 } from './layouts';

const tireCache = new Map<string, { tex: CanvasTexture; refs: number }>();

/** Shared (ref-counted) tyre lettering texture. */
export function acquireTireTextTexture(spec: CarVisualSpec, slick: boolean, accent: string): { tex: CanvasTexture; release(): void } {
  const key = `${spec.style}|${spec.tireWidthFront}|${spec.wheelRadiusFront}|${spec.rimRadiusFront}|${slick}|${slick ? accent : ''}${isFormula04(spec) ? '|2004' : ''}`;
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
  if (spec.style === 'suv') {
    // all-terrain: the brand big and heavy, the size, the mountain-and-snowflake mark (the lugs take the shoulder, so the lettering sits low)
    const ink = '#ffffff';
    for (const x0 of [16, 1040]) {
      drawText('XENO', x0, 0.4, 50, '900', ink);
      drawText('TERRAIN A/T', x0 + 185, 0.4, 44, '800', ink);
      drawText(size, x0 + 505, 0.4, 26, '700', ink);
      drawText('ALL TERRAIN  •  M+S', x0 + 690, 0.4, 22, '600', ink);
      // a mountain with a snowflake over it
      g.fillStyle = ink;
      g.beginPath();
      g.moveTo(x0 + 950, H * 0.64);
      g.lineTo(x0 + 974, H * 0.3);
      g.lineTo(x0 + 986, H * 0.44);
      g.lineTo(x0 + 998, H * 0.35);
      g.lineTo(x0 + 1022, H * 0.64);
      g.closePath();
      g.fill();
    }
  } else if (isFormula04(spec)) {
    // the 2004 single-seater's grooved dry tyre: the brand big and white twice round the sidewall, as the tyres of the time had it, the
    // size and what the tyre is between (no coloured ring: the compounds were not marked then)
    for (const x0 of [40, 1064]) {
      drawText('XENO', x0, 0.6, 60, '900', '#ffffff');
      drawText('RACING', x0 + 200, 0.6, 60, '700', '#ffffff');
      drawText(size, x0 + 470, 0.52, 28, '600', '#ffffff');
      drawText('GROOVED  •  DRY', x0 + 640, 0.52, 28, '600', '#ffffff');
    }
  } else if (spec.style === 'hyper') {
    // the hypercar's semi-slick: a road tyre's markings (it is road legal) under a track tyre's name
    drawText('XENO', 60, 0.6, 52, '900', '#ffffff');
    drawText('CORSA R', 250, 0.6, 52, '700', '#ffffff');
    drawText(size + ' ZR', 560, 0.56, 34, '600', '#ffffff');
    drawText('TREADWEAR 60 • TRACTION AA • TEMPERATURE A', 830, 0.46, 22, '500', '#ffffff');
    drawText('XENO', 1380, 0.6, 52, '900', '#ffffff');
    drawText('CORSA R', 1570, 0.6, 52, '700', '#ffffff');
  } else if (slick) {
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
