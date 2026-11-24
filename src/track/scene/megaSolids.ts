/**
 * The megacity's solids (megacity.ts, megaLandmarks.ts): footprints and what is done to them, prisms and roofs, slabs with a lit
 * face, and the styles the shader (cyberFacade.ts) reads.
 */
import { CityBuf, type Style } from './cityBuf';
import type { Pt } from './cityLots';
import { ACCENTS, CYBER_KIND, SIGN_MODE } from './cyberFacade';

/** A seed for the shader from a random number: the middle of a step of 1 / 1024 (see cSeed in cyberFacade.ts). */
export function seedOf(r: number): number {
  return (Math.floor(r * 1000) + 12.5) / 1024;
}

/** How often each light is a sign's (teal, pink, violet, cold white, amber). */
const SIGN_W = [3, 3, 2.2, 1.1, 1];

export function pickWeighted(w: readonly number[], r: number): number {
  let total = 0;
  for (const x of w) total += x;
  let t = r * total;
  for (let i = 0; i < w.length; i++) {
    t -= w[i];
    if (t <= 0) return i;
  }
  return 0;
}

// ── footprints ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function centroid(q: Pt[]): Pt {
  let x = 0;
  let z = 0;
  for (const p of q) {
    x += p[0] / q.length;
    z += p[1] / q.length;
  }
  return [x, z];
}

/** A convex polygon with every edge moved `d` m inward (mitred corners); never by more than a quarter of its shortest edge. */
export function inset(q: Pt[], d: number): Pt[] {
  const n = q.length;
  const c = centroid(q);
  let shortest = Infinity;
  const nrm: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = q[i];
    const b = q[(i + 1) % n];
    let nx = -(b[1] - a[1]);
    let nz = b[0] - a[0];
    const l = Math.hypot(nx, nz) || 1;
    shortest = Math.min(shortest, l);
    nx /= l;
    nz /= l;
    if ((c[0] - a[0]) * nx + (c[1] - a[1]) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    nrm.push([nx, nz]);
  }
  const dd = Math.min(d, shortest * 0.25);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const n1 = nrm[(i + n - 1) % n];
    const n2 = nrm[i];
    const k = dd / Math.max(0.35, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
    out.push([q[i][0] + (n1[0] + n2[0]) * k, q[i][1] + (n1[1] + n2[1]) * k]);
  }
  return out;
}

/** A polygon scaled about its centroid. */
export function scaled(q: Pt[], k: number): Pt[] {
  const c = centroid(q);
  return q.map((p) => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k] as Pt);
}

// ── solids ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The walls of a prism from the polygon q0 at y0 to q1 at y1 (the same polygon, or a smaller one: a taper). u runs along each wall
 * in metres, v is the height above `yRef`; the style's `w` and `floors` are set to the wall's width and to its top above the datum.
 */
export function walls(buf: CityBuf, q0: Pt[], q1: Pt[], y0: number, y1: number, yRef: number, st: Style, kind: number): void {
  const n = q0.length;
  const c = centroid(q0);
  for (let k = 0; k < n; k++) {
    const a = q0[k];
    const b = q0[(k + 1) % n];
    const a1 = q1[k];
    const b1 = q1[(k + 1) % n];
    const tx = b[0] - a[0];
    const tz = b[1] - a[1];
    const tl = Math.hypot(tx, tz);
    if (tl < 0.05) continue;
    let nx = -tz / tl;
    let nz = tx / tl;
    if ((a[0] - c[0]) * nx + (a[1] - c[1]) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    // a wall that leans in faces a little upward
    const lean = ((a[0] - a1[0] + b[0] - b1[0]) * nx + (a[1] - a1[1] + b[1] - b1[1]) * nz) / 2;
    const hgt = y1 - y0;
    const nl = Math.hypot(hgt, lean) || 1;
    buf.quad(
      [[a[0], y0, a[1]], [b[0], y0, b[1]], [b1[0], y1, b1[1]], [a1[0], y1, a1[1]]],
      [[0, y0 - yRef], [tl, y0 - yRef], [tl, y1 - yRef], [0, y1 - yRef]],
      [(nx * hgt) / nl, lean / nl, (nz * hgt) / nl],
      { ...st, w: tl, floors: y1 - yRef },
      kind,
    );
  }
}

/**
 * A wedge on top of a quad's prism: the roof falls `drop` m from the quad's first edge (at `yHigh`) to the opposite one. The tall
 * wall and the two triangular ones carry on the walls below (v from `yRef`); the slope is glazed like them.
 */
export function wedge(buf: CityBuf, q: Pt[], yHigh: number, drop: number, yRef: number, st: Style, kind: number): void {
  const yLow = yHigh - drop;
  const c = centroid(q);
  const out = (k: number): [number, number, number] => {
    const a = q[k];
    const b = q[(k + 1) % 4];
    const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let nx = -(b[1] - a[1]) / tl;
    let nz = (b[0] - a[0]) / tl;
    if ((a[0] - c[0]) * nx + (a[1] - c[1]) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    return [nx, nz, tl];
  };
  const [n0x, n0z, l0] = out(0);
  const s0: Style = { ...st, w: l0, floors: yHigh - yRef };
  buf.quad([[q[0][0], yLow, q[0][1]], [q[1][0], yLow, q[1][1]], [q[1][0], yHigh, q[1][1]], [q[0][0], yHigh, q[0][1]]], [[0, yLow - yRef], [l0, yLow - yRef], [l0, yHigh - yRef], [0, yHigh - yRef]], [n0x, 0, n0z], s0, kind);
  const [n1x, n1z, l1] = out(1);
  buf.tri([[q[1][0], yLow, q[1][1]], [q[2][0], yLow, q[2][1]], [q[1][0], yHigh, q[1][1]]], [[0, yLow - yRef], [l1, yLow - yRef], [0, yHigh - yRef]], [n1x, 0, n1z], { ...st, w: l1, floors: 1e4 }, kind);
  const [n3x, n3z, l3] = out(3);
  buf.tri([[q[3][0], yLow, q[3][1]], [q[0][0], yLow, q[0][1]], [q[0][0], yHigh, q[0][1]]], [[0, yLow - yRef], [l3, yLow - yRef], [l3, yHigh - yRef]], [n3x, 0, n3z], { ...st, w: l3, floors: 1e4 }, kind);
  // the slope: it faces away from the tall wall, and up
  const run = (l1 + l3) / 2;
  const sl = Math.hypot(run, drop) || 1;
  buf.quad(
    [[q[3][0], yLow, q[3][1]], [q[2][0], yLow, q[2][1]], [q[1][0], yHigh, q[1][1]], [q[0][0], yHigh, q[0][1]]],
    [[0, 0], [l0, 0], [l0, sl], [0, sl]],
    [(-n0x * drop) / sl, run / sl, (-n0z * drop) / sl],
    { ...st, w: l0, floors: 1e4, gH: 0 },
    kind,
  );
}

/** A flat roof over a polygon (a quad gets its parapet; anything else is a fan). */
export function roof(buf: CityBuf, q: Pt[], y: number, st: Style): void {
  if (q.length === 4) {
    const w = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
    const d = Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]);
    buf.quad([[q[0][0], y, q[0][1]], [q[1][0], y, q[1][1]], [q[2][0], y, q[2][1]], [q[3][0], y, q[3][1]]], [[0, 0], [w, 0], [w, d], [0, d]], [0, 1, 0], { ...st, w, floors: d }, CYBER_KIND.roof);
    return;
  }
  const c = centroid(q);
  const s2: Style = { ...st, w: 0, floors: 0 };
  for (let k = 0; k < q.length; k++) {
    const a = q[k];
    const b = q[(k + 1) % q.length];
    buf.tri([[c[0], y, c[1]], [a[0], y, a[1]], [b[0], y, b[1]]], [[c[0], c[1]], [a[0], a[1]], [b[0], b[1]]], [0, 1, 0], s2, CYBER_KIND.roof);
  }
}

/** A parapet round a flat roof: `h` high, `t` thick, standing on the roof's edge. */
export function parapet(buf: CityBuf, q: Pt[], y: number, st: Style, h = 0.9, t = 0.35): void {
  const qi = inset(q, t);
  const c = centroid(q);
  for (let k = 0; k < q.length; k++) {
    const a = q[k];
    const b = q[(k + 1) % q.length];
    const ai = qi[k];
    const bi = qi[(k + 1) % q.length];
    const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let nx = -(b[1] - a[1]) / tl;
    let nz = (b[0] - a[0]) / tl;
    if ((a[0] - c[0]) * nx + (a[1] - c[1]) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    buf.quad([[a[0], y, a[1]], [b[0], y, b[1]], [b[0], y + h, b[1]], [a[0], y + h, a[1]]], [[0, 0], [tl, 0], [tl, h], [0, h]], [nx, 0, nz], st, CYBER_KIND.plain);
    buf.quad([[a[0], y + h, a[1]], [b[0], y + h, b[1]], [bi[0], y + h, bi[1]], [ai[0], y + h, ai[1]]], [[0, 0], [tl, 0], [tl, t], [0, t]], [0, 1, 0], st, CYBER_KIND.plain);
    buf.quad([[ai[0], y, ai[1]], [bi[0], y, bi[1]], [bi[0], y + h, bi[1]], [ai[0], y + h, ai[1]]], [[0, 0], [tl, 0], [tl, h], [0, h]], [-nx, 0, -nz], st, CYBER_KIND.plain);
  }
}

const DARK: [number, number, number] = [0.028, 0.03, 0.034];

/** Painted metal (plant, frames, masts): `metal` 0..1. */
export function plainStyle(col: [number, number, number] = DARK, metal = 0.5): Style {
  return { col, seed: 0.5, floors: 0, gH: 0, w: 1, lit: metal };
}

/** A strip or a lamp of the light `col`; `mode` 0 steady, 1 an aircraft warning light, 2 breathing. */
export function lightStyle(col: readonly [number, number, number], strength: number, mode = 0, seed = 0.5): Style {
  return { col: [col[0], col[1], col[2]], seed, floors: 0, gH: 0, w: 1, lit: strength, a: mode };
}

/**
 * A slab standing in the air: centre (cx, cy, cz), `w` wide along the horizontal unit vector (ux, uz), `h` high, `depth` thick. Its
 * face toward (nx, nz) carries `front`; the other one `back` (or dark metal), and the four edges are dark metal.
 */
export function slab(buf: CityBuf, cx: number, cy: number, cz: number, ux: number, uz: number, w: number, h: number, nx: number, nz: number, depth: number, front: Style, kind: number, back?: Style): void {
  const hw = w / 2;
  const hh = h / 2;
  const hd = depth / 2;
  const edge = plainStyle();
  for (const sgn of [1, -1]) {
    const st = sgn > 0 ? front : back;
    const ox = nx * hd * sgn;
    const oz = nz * hd * sgn;
    // (u runs to the right for someone facing the slab, so that a column is not mirrored between its two faces)
    const rx = ux * sgn;
    const rz = uz * sgn;
    buf.quad(
      [
        [cx + ox - rx * hw, cy - hh, cz + oz - rz * hw],
        [cx + ox + rx * hw, cy - hh, cz + oz + rz * hw],
        [cx + ox + rx * hw, cy + hh, cz + oz + rz * hw],
        [cx + ox - rx * hw, cy + hh, cz + oz - rz * hw],
      ],
      [[0, 0], [w, 0], [w, h], [0, h]],
      [nx * sgn, 0, nz * sgn],
      st ? { ...st, w, floors: h } : edge,
      st ? kind : CYBER_KIND.plain,
    );
  }
  for (const sgn of [1, -1]) {
    const ex = cx + ux * hw * sgn;
    const ez = cz + uz * hw * sgn;
    buf.quad(
      [[ex - nx * hd, cy - hh, ez - nz * hd], [ex + nx * hd, cy - hh, ez + nz * hd], [ex + nx * hd, cy + hh, ez + nz * hd], [ex - nx * hd, cy + hh, ez - nz * hd]],
      [[0, 0], [depth, 0], [depth, h], [0, h]],
      [ux * sgn, 0, uz * sgn],
      edge,
      CYBER_KIND.plain,
    );
    const ey = cy + hh * sgn;
    buf.quad(
      [[cx - ux * hw - nx * hd, ey, cz - uz * hw - nz * hd], [cx + ux * hw - nx * hd, ey, cz + uz * hw - nz * hd], [cx + ux * hw + nx * hd, ey, cz + uz * hw + nz * hd], [cx - ux * hw + nx * hd, ey, cz - uz * hw + nz * hd]],
      [[0, 0], [w, 0], [w, depth], [0, depth]],
      [0, sgn, 0],
      edge,
      CYBER_KIND.plain,
    );
  }
}

/** A vertical cylinder (a tank). */
export function tank(buf: CityBuf, x: number, z: number, y0: number, y1: number, r: number, st: Style): void {
  const segs = 10;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    buf.quad(
      [[x + Math.cos(a0) * r, y0, z + Math.sin(a0) * r], [x + Math.cos(a1) * r, y0, z + Math.sin(a1) * r], [x + Math.cos(a1) * r, y1, z + Math.sin(a1) * r], [x + Math.cos(a0) * r, y1, z + Math.sin(a0) * r]],
      [[a0 * r, 0], [a1 * r, 0], [a1 * r, y1 - y0], [a0 * r, y1 - y0]],
      [Math.cos(am), 0, Math.sin(am)],
      st,
      CYBER_KIND.plain,
    );
    buf.tri([[x, y1, z], [x + Math.cos(a0) * r, y1, z + Math.sin(a0) * r], [x + Math.cos(a1) * r, y1, z + Math.sin(a1) * r]], [[0, 0], [1, 0], [1, 1]], [0, 1, 0], st, CYBER_KIND.plain);
  }
}

// ── signs ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a sign of w x h metres shows, and in which light. */
export function signStyle(w: number, h: number, rnd: () => number, want?: number): Style {
  const c = ACCENTS[pickWeighted(SIGN_W, rnd())];
  const mrg = Math.min(0.1 * Math.min(w, h), 0.5);
  const r = rnd();
  let mode: number;
  let gs: number;
  if (want !== undefined) mode = want;
  else if (h > 2.2 * w) mode = SIGN_MODE.column;
  else if (w * h >= 60 && r < 0.3) mode = SIGN_MODE.screen;
  else if (w < 2.4 * h && r < 0.62) mode = SIGN_MODE.mark;
  else if (h > 4 && r > 0.85) mode = SIGN_MODE.scroll;
  else mode = SIGN_MODE.lines;
  if (mode === SIGN_MODE.column) gs = ((w - 2 * mrg) / 0.667) * 0.86;
  else {
    // whole lines between the margins
    const rows = mode === SIGN_MODE.scroll ? Math.max(3, Math.round(h / 1.6)) : h < 3 ? 1 : h < 6.5 ? 2 : 3 + Math.floor(rnd() * 2);
    gs = (h - 2 * mrg) / (1.5 * rows);
  }
  return { col: [c[0], c[1], c[2]], seed: seedOf(rnd()), floors: h, gH: gs, w, lit: 0, a: mode, b: mode !== SIGN_MODE.screen && rnd() < 0.2 ? 1 : 0 };
}
