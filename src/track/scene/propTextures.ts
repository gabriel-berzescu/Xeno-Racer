/**
 * Procedural canvas textures for trackside props (tires, catch fence, ad boards, crowd, flags). Foliage textures live in foliage.ts.
 * Brand names are fictional.
 */
import * as THREE from 'three';
import { mulberry32 } from '../math';

const FONT = '"Arial Black", "Segoe UI Black", Impact, "Helvetica Neue", Arial, sans-serif';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function finish(c: HTMLCanvasElement, srgb: boolean, repeat = true, aniso = 8): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

// ── tires ────────────────────────────────────────────────────────────────────────

/** 4x4 grid of tires seen from the front (hole facing the driver); returns albedo + bump. */
export function makeTireTextures(): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const S = 512;
  const [c, g] = canvas(S, S);
  const [cb, gb] = canvas(S, S);
  g.fillStyle = '#070707';
  g.fillRect(0, 0, S, S);
  gb.fillStyle = '#202020';
  gb.fillRect(0, 0, S, S);
  const rnd = mulberry32(99);
  const cell = S / 4;
  const paints = ['#e8e8e6', '#d8c21a', '#d02a2a', '#2a5fd0'];
  for (let ry = 0; ry < 4; ry++) {
    for (let rx = 0; rx < 4; rx++) {
      const off = ry % 2 ? cell / 2 : 0;
      const cx = rx * cell + cell / 2 + off;
      const cy = ry * cell + cell / 2;
      for (const dx of [0, -S, S]) {
        const x = cx + dx;
        if (x < -cell || x > S + cell) continue;
        const R = cell * 0.5 * 0.96;
        // tire body
        const grd = g.createRadialGradient(x, cy, R * 0.25, x, cy, R);
        grd.addColorStop(0, '#050505');
        grd.addColorStop(0.35, '#151515');
        grd.addColorStop(0.62, '#262626');
        grd.addColorStop(0.92, '#1a1a1a');
        grd.addColorStop(1, '#0c0c0c');
        g.fillStyle = grd;
        g.beginPath();
        g.arc(x, cy, R, 0, Math.PI * 2);
        g.fill();
        // rim hole
        g.fillStyle = '#020202';
        g.beginPath();
        g.arc(x, cy, R * 0.34, 0, Math.PI * 2);
        g.fill();
        // painted band on a few tires
        if (rnd() < 0.18) {
          g.strokeStyle = paints[Math.floor(rnd() * paints.length)];
          g.globalAlpha = 0.85;
          g.lineWidth = R * 0.16;
          g.beginPath();
          g.arc(x, cy, R * 0.68, 0.2, Math.PI * 1.7);
          g.stroke();
          g.globalAlpha = 1;
        }
        // bump: raised sidewall ring
        const gr2 = gb.createRadialGradient(x, cy, R * 0.34, x, cy, R);
        gr2.addColorStop(0, '#101010');
        gr2.addColorStop(0.25, '#f0f0f0');
        gr2.addColorStop(0.7, '#c8c8c8');
        gr2.addColorStop(1, '#303030');
        gb.fillStyle = gr2;
        gb.beginPath();
        gb.arc(x, cy, R, 0, Math.PI * 2);
        gb.fill();
        gb.fillStyle = '#050505';
        gb.beginPath();
        gb.arc(x, cy, R * 0.34, 0, Math.PI * 2);
        gb.fill();
      }
    }
  }
  // dust / scuffs
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(110,100,90,${0.02 + rnd() * 0.05})`;
    g.fillRect(rnd() * S, rnd() * S, 2 + rnd() * 5, 2 + rnd() * 5);
  }
  return { map: finish(c, true), bump: finish(cb, false) };
}

// ── catch fence ──────────────────────────────────────────────────────────────────

export function makeFenceTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.lineWidth = 3;
  g.lineCap = 'round';
  // diamond lattice, tileable
  const n = 4;
  const s = 128 / n;
  g.beginPath();
  for (let i = -n; i <= n * 2; i++) {
    g.moveTo(i * s, 0);
    g.lineTo(i * s + 128, 128);
    g.moveTo(i * s, 128);
    g.lineTo(i * s + 128, 0);
  }
  g.stroke();
  const t = finish(c, true, true, 8);
  return t;
}

// ── ad boards ────────────────────────────────────────────────────────────────────

export interface AdAtlas {
  map: THREE.CanvasTexture;
  cols: number;
  rows: number;
  count: number;
}

interface Brand {
  text: string;
  bg: string;
  fg: string;
  accent: string;
  style: 'plain' | 'stripe' | 'slash' | 'box';
  sub?: string;
}

const BRANDS: Brand[] = [
  { text: 'XENO', bg: '#0b0c10', fg: '#16e0bd', accent: '#ff2e63', style: 'slash', sub: 'RACING' },
  { text: 'AURELIA', bg: '#eef0f3', fg: '#0b0c10', accent: '#16e0bd', style: 'stripe', sub: 'RING' },
  { text: 'VANTA', bg: '#1c2c5a', fg: '#eef0f3', accent: '#ff6a1a', style: 'plain', sub: 'GRAND TOURER' },
  { text: 'KESTREL', bg: '#d0102b', fg: '#ffffff', accent: '#15161a', style: 'slash', sub: 'MOTORWORKS' },
  { text: 'RONIN', bg: '#f2c200', fg: '#121316', accent: '#ffffff', style: 'box', sub: 'COUPE 86' },
  { text: 'NOVA', bg: '#101820', fg: '#7fe9ff', accent: '#ffffff', style: 'stripe', sub: 'LUBRICANTS' },
  { text: 'HELIX', bg: '#ffffff', fg: '#222831', accent: '#ff2e63', style: 'slash', sub: 'TYRES' },
  { text: 'ARC-7', bg: '#ff2e63', fg: '#ffffff', accent: '#0b0c10', style: 'box', sub: 'FUELS' },
  { text: 'ZENITH', bg: '#0f3d3a', fg: '#e7fff7', accent: '#16e0bd', style: 'plain', sub: 'TIMING' },
  { text: 'LUMEN', bg: '#222831', fg: '#ffd369', accent: '#eeeeee', style: 'stripe', sub: 'LIGHTING' },
  { text: 'ORBIT', bg: '#3a0ca3', fg: '#f1f1f1', accent: '#4cc9f0', style: 'slash', sub: 'TELECOM' },
  { text: 'TERRA', bg: '#2d6a4f', fg: '#f1faee', accent: '#e9c46a', style: 'plain', sub: 'OUTDOOR' },
];

export function makeAdAtlas(): AdAtlas {
  const cols = 2;
  const rows = BRANDS.length / cols;
  const W = 1024;
  const H = 256; // each panel: 4:1
  const [c, g] = canvas(W * cols, H * rows);
  BRANDS.forEach((b, i) => {
    const cx = (i % cols) * W;
    const cy = Math.floor(i / cols) * H;
    g.save();
    g.beginPath();
    g.rect(cx, cy, W, H);
    g.clip();
    g.fillStyle = b.bg;
    g.fillRect(cx, cy, W, H);
    // accent graphics
    g.fillStyle = b.accent;
    if (b.style === 'slash') {
      g.beginPath();
      g.moveTo(cx + W * 0.74, cy);
      g.lineTo(cx + W * 0.84, cy);
      g.lineTo(cx + W * 0.7, cy + H);
      g.lineTo(cx + W * 0.6, cy + H);
      g.fill();
      g.beginPath();
      g.moveTo(cx + W * 0.88, cy);
      g.lineTo(cx + W * 0.92, cy);
      g.lineTo(cx + W * 0.78, cy + H);
      g.lineTo(cx + W * 0.74, cy + H);
      g.fill();
    } else if (b.style === 'stripe') {
      g.fillRect(cx, cy + H * 0.86, W, H * 0.14);
      g.fillRect(cx, cy, W, H * 0.06);
    } else if (b.style === 'box') {
      g.fillRect(cx + W * 0.04, cy + H * 0.12, W * 0.02, H * 0.76);
    }
    g.fillStyle = b.fg;
    g.font = `900 ${H * 0.58}px ${FONT}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const tx = cx + W * 0.09;
    g.fillText(b.text, tx, cy + H * (b.sub ? 0.43 : 0.5), W * 0.58);
    if (b.sub) {
      g.font = `700 ${H * 0.16}px ${FONT}`;
      g.fillText(b.sub, tx + 4, cy + H * 0.8, W * 0.55);
    }
    g.restore();
  });
  return { map: finish(c, true, false, 8), cols, rows, count: BRANDS.length };
}

// ── crowd (stands) ────────────────────────────────────────────────────────────────

/** One row of spectators (head + shoulders, ~8 m long, tileable) on a transparent background. */
export function makeCrowdTexture(variant = 0): THREE.CanvasTexture {
  const W = 1024;
  const H = 160;
  const [c, g] = canvas(W, H);
  g.clearRect(0, 0, W, H);
  const rnd = mulberry32(5150 + variant * 77);
  const shirts = ['#d0102b', '#eef0f3', '#16e0bd', '#ff6a1a', '#2459d0', '#f2c200', '#1c2c5a', '#ff2e63', '#8bd450', '#444a52', '#e9e9e9', '#b02080', '#1a1a1d', '#c9d6de'];
  const skins = ['#f1c9a5', '#d9a77d', '#b9835a', '#8d5a3b', '#5e3a26', '#f4d6bf'];
  const n = 15;
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * (W / n) + (rnd() - 0.5) * 18;
    const sh = shirts[Math.floor(rnd() * shirts.length)];
    const sk = skins[Math.floor(rnd() * skins.length)];
    const pw = (W / n) * (0.78 + rnd() * 0.14);
    const bob = rnd() * 10;
    // torso
    g.fillStyle = sh;
    g.beginPath();
    g.moveTo(x - pw * 0.5, H);
    g.quadraticCurveTo(x - pw * 0.52, H * 0.55 + bob, x - pw * 0.2, H * 0.48 + bob);
    g.lineTo(x + pw * 0.2, H * 0.48 + bob);
    g.quadraticCurveTo(x + pw * 0.52, H * 0.55 + bob, x + pw * 0.5, H);
    g.closePath();
    g.fill();
    // darker bottom (shadow of the row in front)
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.fillRect(x - pw * 0.5, H * 0.86, pw, H * 0.14);
    // neck + head
    g.fillStyle = sk;
    g.fillRect(x - pw * 0.06, H * 0.4 + bob, pw * 0.12, H * 0.1);
    g.beginPath();
    g.ellipse(x, H * 0.28 + bob, pw * 0.17, H * 0.17, 0, 0, Math.PI * 2);
    g.fill();
    // hair / cap
    if (rnd() < 0.7) {
      g.fillStyle = rnd() < 0.45 ? '#1a1410' : rnd() < 0.5 ? '#5a3a1e' : shirts[Math.floor(rnd() * shirts.length)];
      g.beginPath();
      g.ellipse(x, H * 0.22 + bob, pw * 0.18, H * 0.12, 0, Math.PI, 0);
      g.fill();
    }
    // raised arm / flag occasionally
    if (rnd() < 0.09) {
      g.strokeStyle = sk;
      g.lineWidth = pw * 0.1;
      g.beginPath();
      g.moveTo(x + pw * 0.3, H * 0.55 + bob);
      g.lineTo(x + pw * 0.46, H * 0.1);
      g.stroke();
      if (rnd() < 0.5) {
        g.fillStyle = shirts[Math.floor(rnd() * shirts.length)];
        g.fillRect(x + pw * 0.46, H * 0.02, pw * 0.34, H * 0.2);
      }
    }
  }
  const t = finish(c, true, true, 8);
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Stand seating pattern (tileable): blocks of seats in team colours. */
export function makeSeatTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 64);
  g.fillStyle = '#20242b';
  g.fillRect(0, 0, 256, 64);
  const cols = ['#16e0bd', '#eef0f3', '#2459d0', '#ff2e63'];
  for (let i = 0; i < 16; i++) {
    const col = cols[Math.floor(i / 4) % cols.length];
    g.fillStyle = col;
    g.globalAlpha = 0.85;
    g.fillRect(i * 16 + 1.5, 6, 13, 40);
    g.globalAlpha = 0.5;
    g.fillStyle = '#000';
    g.fillRect(i * 16 + 1.5, 36, 13, 10);
    g.globalAlpha = 1;
  }
  return finish(c, true, true, 8);
}

/** Pit-building facade for one 12 m bay: garage door below, glazing above (repeat horizontally). */
export function makeFacadeTexture(): THREE.CanvasTexture {
  const W = 512;
  const H = 512;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#c9cbcc';
  g.fillRect(0, 0, W, H);
  // upper band: glazing
  const gr = g.createLinearGradient(0, 0, 0, H * 0.42);
  gr.addColorStop(0, '#4d6b86');
  gr.addColorStop(0.55, '#26394a');
  gr.addColorStop(1, '#1a2733');
  g.fillStyle = gr;
  g.fillRect(14, 14, W - 28, H * 0.4);
  g.strokeStyle = '#b8bcbf';
  g.lineWidth = 6;
  for (let i = 0; i <= 4; i++) {
    g.beginPath();
    g.moveTo(14 + (i * (W - 28)) / 4, 14);
    g.lineTo(14 + (i * (W - 28)) / 4, 14 + H * 0.4);
    g.stroke();
  }
  // reflections
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.beginPath();
  g.moveTo(60, 14);
  g.lineTo(150, 14);
  g.lineTo(60 + 40, 14 + H * 0.4);
  g.lineTo(0 + 40, 14 + H * 0.4);
  g.fill();
  // garage door
  const dy = H * 0.5;
  g.fillStyle = '#2b2f36';
  g.fillRect(28, dy, W - 56, H - dy - 10);
  g.strokeStyle = '#3d424b';
  g.lineWidth = 3;
  for (let y = dy + 14; y < H - 14; y += 16) {
    g.beginPath();
    g.moveTo(28, y);
    g.lineTo(W - 28, y);
    g.stroke();
  }
  // accent stripe + bay light
  g.fillStyle = '#16e0bd';
  g.fillRect(28, dy, W - 56, 8);
  g.fillStyle = '#ff2e63';
  g.fillRect(28, dy + 8, W - 56, 3);
  g.fillStyle = '#e9e9e9';
  g.fillRect(W / 2 - 36, dy + 30, 72, 28);
  g.fillStyle = '#0b0c10';
  g.font = `900 22px ${FONT}`;
  g.textAlign = 'center';
  g.fillText('XENO', W / 2, dy + 52);
  return finish(c, true, true, 8);
}

/** Braking / distance board: a number on a dark board with red-white edge stripes. */
export function makeBoardTexture(text: string, bg = '#101114'): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#e9e9e9';
  g.font = `900 130px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 118);
  g.fillStyle = '#d0102b';
  for (let i = 0; i < 3; i++) g.fillRect(34 + i * 72, 196, 52, 28);
  g.fillStyle = '#e9e9e9';
  for (let i = 0; i < 3; i++) g.fillRect(34 + i * 72 - 36, 196, 20, 28);
  return finish(c, true, false, 8);
}

/**
 * Curtain-wall facade, 2 bays x 2 floors per tile (7.8 m): white spandrels and mullions, tinted glass with sky
 * reflections. The emissive twin has randomly lit windows for the night.
 */
export function makeTowerTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const S = 512;
  const [c, g] = canvas(S, S);
  const [e, ge] = canvas(S, S);
  g.fillStyle = '#dcdfe0';
  g.fillRect(0, 0, S, S);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, S, S);
  const rnd = mulberry32(2718);
  for (let fy = 0; fy < 2; fy++) {
    for (let bx = 0; bx < 2; bx++) {
      const x0 = bx * 256;
      const y0 = fy * 256;
      // glass pane area inside the bay: 10..246 x 56..250 (spandrel on top)
      for (let px = 0; px < 2; px++) {
        const gx = x0 + 12 + px * 119;
        const gw = 113;
        const gy = y0 + 58;
        const gh = 188;
        const gr = g.createLinearGradient(0, gy, 0, gy + gh);
        const lite = rnd() * 0.12;
        gr.addColorStop(0, `rgb(${Math.round(108 + lite * 200)},${Math.round(142 + lite * 180)},${Math.round(168 + lite * 150)})`);
        gr.addColorStop(0.5, '#3b546a');
        gr.addColorStop(1, '#1d2c3a');
        g.fillStyle = gr;
        g.fillRect(gx, gy, gw, gh);
        // reflection streak
        g.fillStyle = 'rgba(255,255,255,0.10)';
        g.beginPath();
        g.moveTo(gx + 10, gy);
        g.lineTo(gx + 44, gy);
        g.lineTo(gx + 14, gy + gh);
        g.lineTo(gx - 20, gy + gh);
        g.fill();
        // transom
        g.fillStyle = '#c6cacc';
        g.fillRect(gx, gy + gh * 0.58, gw, 4);
        // lit window (night): about 55 %
        if (rnd() < 0.55) {
          const k = 0.55 + rnd() * 0.45;
          ge.fillStyle = `rgb(${Math.round(255 * k)},${Math.round(214 * k)},${Math.round(150 * k)})`;
          ge.fillRect(gx + 3, gy + 3, gw - 6, gh * 0.58 - 4);
          if (rnd() < 0.5) ge.fillRect(gx + 3, gy + gh * 0.58 + 6, gw - 6, gh * 0.42 - 9);
        }
      }
      // spandrel panel shadow line
      g.fillStyle = 'rgba(60,66,70,0.35)';
      g.fillRect(x0, y0 + 54, 256, 4);
    }
  }
  const map = finish(c, true, true, 8);
  const emissive = finish(e, true, true, 4);
  return { map, emissive };
}

/** Yellow alignment (chevron) board; the arrow points toward the bend, as seen by the driver (dir +1 = left). */
export function makeChevronTexture(dir: 1 | -1): THREE.CanvasTexture {
  const [c, g] = canvas(256, 192);
  g.fillStyle = '#111';
  g.fillRect(0, 0, 256, 192);
  g.fillStyle = '#f2c500';
  g.fillRect(8, 8, 240, 176);
  g.fillStyle = '#111';
  g.save();
  g.translate(128, 96);
  g.scale(dir, 1); // the path below points to -x (left): dir +1 keeps it, -1 mirrors it
  for (const o of [-34, 34]) {
    g.beginPath();
    g.moveTo(o + 46, -72);
    g.lineTo(o - 8, 0);
    g.lineTo(o + 46, 72);
    g.lineTo(o + 20, 72);
    g.lineTo(o - 34, 0);
    g.lineTo(o + 20, -72);
    g.closePath();
    g.fill();
  }
  g.restore();
  return finish(c, true, false, 8);
}

/** Red-bordered warning triangle with a hairpin (double bend) pictogram. Transparent outside the triangle. */
export function makeWarnTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.clearRect(0, 0, 256, 256);
  const tri = (inset: number, fill: string) => {
    g.fillStyle = fill;
    g.beginPath();
    g.moveTo(128, 10 + inset * 1.7);
    g.lineTo(246 - inset * 1.7, 232 - inset);
    g.lineTo(10 + inset * 1.7, 232 - inset);
    g.closePath();
    g.fill();
  };
  tri(0, '#d0102b');
  tri(26, '#f4f4f0');
  g.strokeStyle = '#111';
  g.lineWidth = 15;
  g.lineCap = 'butt';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(92, 206);
  g.lineTo(92, 150);
  g.bezierCurveTo(92, 120, 150, 120, 150, 150);
  g.bezierCurveTo(150, 178, 112, 168, 112, 140);
  g.stroke();
  g.fillStyle = '#111';
  g.beginPath();
  g.moveTo(112, 112);
  g.lineTo(88, 142);
  g.lineTo(136, 142);
  g.closePath();
  g.fill();
  return finish(c, true, false, 8);
}

/** Wide sign for the start gantry / buildings. */
export function makeSignTexture(title: string, sub: string): THREE.CanvasTexture {
  const [c, g] = canvas(1024, 192);
  g.fillStyle = '#0b0c10';
  g.fillRect(0, 0, 1024, 192);
  g.fillStyle = '#16e0bd';
  g.fillRect(0, 0, 1024, 8);
  g.fillStyle = '#ff2e63';
  g.fillRect(0, 184, 1024, 8);
  g.fillStyle = '#eef0f3';
  g.font = `900 112px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(title.toUpperCase(), 512, 86, 940);
  g.fillStyle = '#16e0bd';
  g.font = `700 34px ${FONT}`;
  g.fillText(sub.toUpperCase(), 512, 160, 900);
  return finish(c, true, false, 8);
}

// ── flags ────────────────────────────────────────────────────────────────────────

export function makeFlagTexture(kind: 'xeno' | 'checker' | 'teal' | 'pink'): THREE.CanvasTexture {
  const [c, g] = canvas(256, 160);
  if (kind === 'checker') {
    const s = 20;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 13; x++) {
      g.fillStyle = (x + y) % 2 ? '#f4f4f4' : '#0a0a0a';
      g.fillRect(x * s, y * s, s, s);
    }
  } else {
    g.fillStyle = kind === 'pink' ? '#ff2e63' : kind === 'teal' ? '#16e0bd' : '#0b0c10';
    g.fillRect(0, 0, 256, 160);
    if (kind === 'xeno') {
      g.fillStyle = '#16e0bd';
      g.beginPath();
      g.moveTo(30, 20);
      g.lineTo(80, 20);
      g.lineTo(226, 140);
      g.lineTo(176, 140);
      g.fill();
      g.fillStyle = '#ff2e63';
      g.beginPath();
      g.moveTo(176, 20);
      g.lineTo(226, 20);
      g.lineTo(80, 140);
      g.lineTo(30, 140);
      g.fill();
    }
  }
  return finish(c, true, false, 4);
}

// ── water ────────────────────────────────────────────────────────────────────────

/** Wave normal map for the lake (tileable). */
export function makeWaterNormal(size = 512): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const rnd = mulberry32(31337);
  const waves: { kx: number; kz: number; amp: number; ph: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const kx = Math.round((rnd() * 2 - 1) * 9);
    const kz = Math.round((rnd() * 2 - 1) * 9);
    if (!kx && !kz) continue;
    waves.push({ kx, kz, amp: 1 / (1 + Math.hypot(kx, kz) * 0.55), ph: rnd() * Math.PI * 2 });
  }
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const w of waves) v += w.amp * Math.sin(((x * w.kx + y * w.kz) / size) * Math.PI * 2 + w.ph);
      h[y * size + x] = v;
    }
  }
  const k = 0.85;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hx = (h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)]) * k;
      const hy = (h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x]) * k;
      const inv = 1 / Math.sqrt(hx * hx + hy * hy + 1);
      const o = (y * size + x) * 4;
      data[o] = Math.round((-hx * inv * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((-hy * inv * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}
