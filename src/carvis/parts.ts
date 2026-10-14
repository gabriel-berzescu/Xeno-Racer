/**
 * PartBuilder — small procedural mesh toolkit for the non-SDF parts of a car (wings, mirrors,
 * exhaust tips, splitters, wheel bits…). Pure numeric, worker-safe, no three.js.
 *
 * Every vertex carries a ZONE_STRIDE zone record so parts can be merged into the body mesh and use
 * the same material (the shader switches on `part` id).
 */
import { PART, ZONE_STRIDE } from './blueprint';

export type V3 = readonly [number, number, number];

export interface Frame {
  o: V3; // origin
  u: V3; // profile x axis (unit)
  v: V3; // profile y axis (unit)
}

export function cross(a: V3, b: V3): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function norm3(a: V3): [number, number, number] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
export function sub3(a: V3, b: V3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function add3(a: V3, b: V3): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function scale3(a: V3, s: number): [number, number, number] {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function dot3(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Frame whose u,v span the plane perpendicular to `axis` (axis = extrusion direction). */
export function frameFromAxis(o: V3, axis: V3, up: V3 = [0, 1, 0]): Frame {
  const w = norm3(axis);
  let u = cross(up, w);
  if (Math.hypot(u[0], u[1], u[2]) < 1e-6) u = cross([1, 0, 0], w);
  u = norm3(u);
  const v = norm3(cross(w, u));
  return { o, u, v };
}

/** Offset a closed 2D polygon inward (d>0) / outward (d<0) by moving each vertex along its miter. */
export function offsetPoly(poly: readonly number[], d: number): number[] {
  const n = poly.length >> 1;
  // winding
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
  }
  const s = area >= 0 ? 1 : -1; // +1 for CCW
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n, q = (i + 1) % n;
    let e1x = poly[i * 2] - poly[p * 2], e1y = poly[i * 2 + 1] - poly[p * 2 + 1];
    let e2x = poly[q * 2] - poly[i * 2], e2y = poly[q * 2 + 1] - poly[i * 2 + 1];
    const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
    e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2;
    // inward normals for CCW polygon: left of the edge direction
    const n1x = -e1y * s, n1y = e1x * s, n2x = -e2y * s, n2y = e2x * s;
    let mx = n1x + n2x, my = n1y + n2y;
    const lm = Math.hypot(mx, my) || 1;
    mx /= lm; my /= lm;
    const c = Math.max(0.3, mx * n1x + my * n1y);
    out.push(poly[i * 2] + (mx * d) / c, poly[i * 2 + 1] + (my * d) / c);
  }
  return out;
}

/** Ear-clipping triangulation of a simple polygon; returns index triples into the polygon. */
export function triangulate(poly: readonly number[]): number[] {
  const n = poly.length >> 1;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
  }
  if (area < 0) idx.reverse();
  const tris: number[] = [];
  const cr = (a: number, b: number, c: number): number =>
    (poly[b * 2] - poly[a * 2]) * (poly[c * 2 + 1] - poly[a * 2 + 1]) - (poly[b * 2 + 1] - poly[a * 2 + 1]) * (poly[c * 2] - poly[a * 2]);
  const inTri = (p: number, a: number, b: number, c: number): boolean => cr(a, b, p) >= -1e-12 && cr(b, c, p) >= -1e-12 && cr(c, a, p) >= -1e-12;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (cr(a, b, c) <= 1e-12) continue;
      let ok = true;
      for (let j = 0; j < idx.length; j++) {
        const p = idx[j];
        if (p === a || p === b || p === c) continue;
        if (inTri(p, a, b, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      tris.push(a, b, c);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  return tris;
}

export class PartBuilder {
  pos: number[] = [];
  nor: number[] = [];
  zon: number[] = [];
  idx: number[] = [];
  private part: number = PART.plastic;
  /** extra zone overrides applied to every new vertex (index into the 16-float record) */
  private zoneSet: Array<[number, number]> = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }
  get triangleCount(): number {
    return this.idx.length / 3;
  }

  /** Select the material part id for subsequently added geometry. */
  setPart(id: number): this {
    this.part = id;
    this.zoneSet = [];
    return this;
  }
  /** Force a zone channel for subsequent vertices (e.g. lamp channels). */
  setZone(channel: number, value: number): this {
    this.zoneSet.push([channel, value]);
    return this;
  }
  clearZones(): this {
    this.zoneSet = [];
    return this;
  }

  addVertex(p: V3, n: V3): number {
    const i = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    const z = new Array<number>(ZONE_STRIDE).fill(1);
    z[12] = 1; // ao
    z[13] = this.part;
    z[14] = 1;
    z[15] = 1;
    for (const [c, v] of this.zoneSet) z[c] = v;
    for (let k = 0; k < ZONE_STRIDE; k++) this.zon.push(z[k]);
    return i;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Flat-shaded polygon (convex or simple) from 3D points, normal given. */
  polygon3(pts: V3[], normal: V3): void {
    const base = this.vertexCount;
    for (const p of pts) this.addVertex(p, normal);
    for (let i = 1; i < pts.length - 1; i++) this.tri(base, base + i, base + i + 1);
  }

  /**
   * Loft between rings of equal point count (each ring a closed loop of 3D points). Smooth normals;
   * winding is auto-oriented so normals point away from the loft's axis.
   */
  loft(rings: V3[][], opts: { capStart?: boolean; capEnd?: boolean; smooth?: boolean } = {}): void {
    const nr = rings.length;
    const np = rings[0].length;
    const base = this.vertexCount;
    const acc = new Float64Array(nr * np * 3);
    const addN = (r: number, p: number, n: V3): void => {
      const k = (r * np + p) * 3;
      acc[k] += n[0];
      acc[k + 1] += n[1];
      acc[k + 2] += n[2];
    };
    for (let r = 0; r < nr - 1; r++) {
      for (let p = 0; p < np; p++) {
        const q = (p + 1) % np;
        const a = rings[r][p], b = rings[r][q], c = rings[r + 1][q], d = rings[r + 1][p];
        const n = cross(sub3(b, a), sub3(d, a));
        const n2 = cross(sub3(c, b), sub3(d, b));
        const f: V3 = [n[0] + n2[0], n[1] + n2[1], n[2] + n2[2]];
        addN(r, p, f);
        addN(r, q, f);
        addN(r + 1, q, f);
        addN(r + 1, p, f);
      }
    }
    // orientation: compare accumulated normal with outward direction from ring centroid
    let orient = 0;
    for (let r = 0; r < nr; r++) {
      let cx = 0, cy = 0, cz = 0;
      for (const p of rings[r]) {
        cx += p[0]; cy += p[1]; cz += p[2];
      }
      cx /= np; cy /= np; cz /= np;
      for (let p = 0; p < np; p++) {
        const k = (r * np + p) * 3;
        orient += acc[k] * (rings[r][p][0] - cx) + acc[k + 1] * (rings[r][p][1] - cy) + acc[k + 2] * (rings[r][p][2] - cz);
      }
    }
    const flip = orient < 0;
    for (let r = 0; r < nr; r++) {
      for (let p = 0; p < np; p++) {
        const k = (r * np + p) * 3;
        let nx = acc[k], ny = acc[k + 1], nz = acc[k + 2];
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        if (flip) { nx = -nx; ny = -ny; nz = -nz; }
        this.addVertex(rings[r][p], [nx, ny, nz]);
      }
    }
    for (let r = 0; r < nr - 1; r++) {
      for (let p = 0; p < np; p++) {
        const q = (p + 1) % np;
        const a = base + r * np + p, b = base + r * np + q, c = base + (r + 1) * np + q, d = base + (r + 1) * np + p;
        if (flip) {
          this.tri(a, d, c);
          this.tri(a, c, b);
        } else {
          this.tri(a, b, c);
          this.tri(a, c, d);
        }
      }
    }
    // caps (flat)
    const cap = (ring: V3[], outward: boolean): void => {
      let cx = 0, cy = 0, cz = 0;
      for (const p of ring) {
        cx += p[0]; cy += p[1]; cz += p[2];
      }
      cx /= np; cy /= np; cz /= np;
      // normal from first triangle of ring around centroid
      let n: V3 = [0, 0, 0];
      for (let p = 0; p < np; p++) {
        const a = sub3(ring[p], [cx, cy, cz]), b = sub3(ring[(p + 1) % np], [cx, cy, cz]);
        const c = cross(a, b);
        n = [n[0] + c[0], n[1] + c[1], n[2] + c[2]];
      }
      n = norm3(n);
      // choose direction: outward means away from the other end
      const other = outward ? rings[nr - 1] : rings[0];
      let ox = 0, oy = 0, oz = 0;
      for (const p of other) {
        ox += p[0]; oy += p[1]; oz += p[2];
      }
      ox /= np; oy /= np; oz /= np;
      const toOther = sub3([ox, oy, oz], [cx, cy, cz]);
      if (dot3(n, toOther) > 0) n = scale3(n, -1);
      const bc = this.addVertex([cx, cy, cz], n);
      const first = this.vertexCount;
      for (const p of ring) this.addVertex(p, n);
      // winding to face along n
      for (let p = 0; p < np; p++) {
        const a = first + p, b = first + ((p + 1) % np);
        const t = cross(sub3(ring[p], [cx, cy, cz]), sub3(ring[(p + 1) % np], [cx, cy, cz]));
        if (dot3(t, n) > 0) this.tri(bc, a, b);
        else this.tri(bc, b, a);
      }
    };
    if (opts.capStart) cap(rings[0], false);
    if (opts.capEnd) cap(rings[nr - 1], true);
  }

  /** Ring of 3D points from a 2D profile placed in a frame. */
  ring(profile: readonly number[], f: Frame, scaleU = 1, scaleV = 1): V3[] {
    const out: V3[] = [];
    for (let i = 0; i < profile.length; i += 2) {
      const a = profile[i] * scaleU, b = profile[i + 1] * scaleV;
      out.push([f.o[0] + f.u[0] * a + f.v[0] * b, f.o[1] + f.u[1] * a + f.v[1] * b, f.o[2] + f.u[2] * a + f.v[2] * b]);
    }
    return out;
  }

  /**
   * Extrude a 2D polygon along the frame normal (w = u × v) by `depth`, with a rounded bevel.
   * The polygon lives in the frame's (u,v) plane at w = 0..depth.
   */
  extrude(poly: readonly number[], f: Frame, depth: number, bevel = 0, bevelSteps = 3): void {
    const w = cross(f.u, f.v);
    const rings: V3[][] = [];
    const lay: Array<[number, number]> = [];
    if (bevel > 0) {
      for (let i = 0; i <= bevelSteps; i++) {
        const a = (i / bevelSteps) * (Math.PI / 2);
        lay.push([bevel * (1 - Math.sin(a)), bevel * (1 - Math.cos(a))]);
      }
    }
    const bottom: Array<[number, number]> = bevel > 0 ? lay.map(([ins, z]) => [ins, z] as [number, number]) : [[0, 0]];
    const top: Array<[number, number]> = bevel > 0 ? lay.map(([ins, z]) => [ins, depth - z] as [number, number]).reverse() : [[0, depth]];
    const all = bottom.concat(top);
    for (const [ins, z] of all) {
      const pl = ins > 0 ? offsetPoly(poly, ins) : poly.slice();
      const ring: V3[] = [];
      for (let i = 0; i < pl.length; i += 2) {
        ring.push([f.o[0] + f.u[0] * pl[i] + f.v[0] * pl[i + 1] + w[0] * z, f.o[1] + f.u[1] * pl[i] + f.v[1] * pl[i + 1] + w[1] * z, f.o[2] + f.u[2] * pl[i] + f.v[2] * pl[i + 1] + w[2] * z]);
      }
      rings.push(ring);
    }
    this.loft(rings, { capStart: false, capEnd: false });
    // caps via triangulation, flat normals
    const capPoly = bevel > 0 ? offsetPoly(poly, bevel) : poly;
    const tri = triangulate(capPoly);
    const wn = norm3(w);
    for (const [z, nn] of [[0, scale3(wn, -1)], [depth, wn]] as Array<[number, V3]>) {
      const base = this.vertexCount;
      for (let i = 0; i < capPoly.length; i += 2) {
        this.addVertex([f.o[0] + f.u[0] * capPoly[i] + f.v[0] * capPoly[i + 1] + w[0] * z, f.o[1] + f.u[1] * capPoly[i] + f.v[1] * capPoly[i + 1] + w[1] * z, f.o[2] + f.u[2] * capPoly[i] + f.v[2] * capPoly[i + 1] + w[2] * z], nn);
      }
      for (let t = 0; t < tri.length; t += 3) {
        // triangulate() returns CCW in (u,v); with w = u×v, CCW faces +w
        if (z === 0) this.tri(base + tri[t], base + tri[t + 2], base + tri[t + 1]);
        else this.tri(base + tri[t], base + tri[t + 1], base + tri[t + 2]);
      }
    }
  }

  /** Flat-shaded axis-aligned-in-frame box (center c, half sizes along frame u,v,w). */
  box(c: V3, hu: number, hv: number, hw: number, f: Frame | null = null): void {
    const fr: Frame = f ?? { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] };
    const w = cross(fr.u, fr.v);
    const P = (a: number, b: number, d: number): V3 => [
      c[0] + fr.u[0] * a * hu + fr.v[0] * b * hv + w[0] * d * hw,
      c[1] + fr.u[1] * a * hu + fr.v[1] * b * hv + w[1] * d * hw,
      c[2] + fr.u[2] * a * hu + fr.v[2] * b * hv + w[2] * d * hw,
    ];
    const faces: Array<[V3[], V3]> = [
      [[P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1)], fr.u],
      [[P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), P(-1, -1, -1)], scale3(fr.u, -1)],
      [[P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1)], fr.v],
      [[P(-1, -1, 1), P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1)], scale3(fr.v, -1)],
      [[P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)], w],
      [[P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)], scale3(w, -1)],
    ];
    for (const [pts, n] of faces) this.polygon3(pts, n);
  }

  /** Tapered cylinder / cone between two points (smooth sides, flat caps). */
  cylinder(a: V3, b: V3, ra: number, rb: number, segs = 20, caps = true): void {
    const axis = norm3(sub3(b, a));
    const fr = frameFromAxis(a, axis);
    const prof: number[] = [];
    for (let i = 0; i < segs; i++) {
      const t = (i / segs) * Math.PI * 2;
      prof.push(Math.cos(t), Math.sin(t));
    }
    const fb: Frame = { o: b, u: fr.u, v: fr.v };
    this.loft([this.ring(prof, fr, ra, ra), this.ring(prof, fb, rb, rb)], { capStart: caps, capEnd: caps });
  }

  /** Surface of revolution about the axis through `o` with direction `axis`; profile = [r, t, r, t...] (t along axis). */
  lathe(o: V3, axis: V3, profile: readonly number[], segs = 32, capEnds = false): void {
    const w = norm3(axis);
    const fr = frameFromAxis(o, w);
    const rings: V3[][] = [];
    const n = profile.length >> 1;
    for (let i = 0; i < n; i++) {
      const r = profile[i * 2], t = profile[i * 2 + 1];
      const ring: V3[] = [];
      for (let s = 0; s < segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const cu = Math.cos(a) * r, cv = Math.sin(a) * r;
        ring.push([o[0] + fr.u[0] * cu + fr.v[0] * cv + w[0] * t, o[1] + fr.u[1] * cu + fr.v[1] * cv + w[1] * t, o[2] + fr.u[2] * cu + fr.v[2] * cv + w[2] * t]);
      }
      rings.push(ring);
    }
    this.loft(rings, { capStart: capEnds, capEnd: capEnds });
  }

  /** Smooth ellipsoid. */
  ellipsoid(c: V3, rx: number, ry: number, rz: number, segs = 20, rings = 12): void {
    const rr: V3[][] = [];
    for (let i = 0; i <= rings; i++) {
      const t = (i / rings) * Math.PI;
      const ring: V3[] = [];
      const s = Math.max(Math.sin(t), 1e-3);
      for (let j = 0; j < segs; j++) {
        const a = (j / segs) * Math.PI * 2;
        ring.push([c[0] + Math.cos(a) * s * rx, c[1] + Math.cos(t) * ry, c[2] + Math.sin(a) * s * rz]);
      }
      rr.push(ring);
    }
    this.loft(rr);
  }

  /** Append everything from another builder. */
  append(o: PartBuilder): void {
    const base = this.vertexCount;
    for (const v of o.pos) this.pos.push(v);
    for (const v of o.nor) this.nor.push(v);
    for (const v of o.zon) this.zon.push(v);
    for (const i of o.idx) this.idx.push(i + base);
  }
}
