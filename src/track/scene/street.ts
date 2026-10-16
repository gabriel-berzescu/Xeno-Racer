/**
 * Street furniture, kept sparse: traffic-light poles (switched off, as on a closed circuit) at the zebra crossings, bollards beside
 * them, kiosks on the quay promenade and in the squares, and bunting strung across the road between poles.
 */
import * as THREE from 'three';
import { mulberry32 } from '../math';
import { resolveMark } from '../plan';
import type { Ctx } from './ctx';

const lin = (hex: number): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

/** A flat-shaded mesh builder with vertex colours. */
class Flat {
  pos: number[] = [];
  col: number[] = [];
  quad(a: number[], b: number[], c: number[], d: number[], col: [number, number, number]): void {
    for (const p of [a, b, c, a, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(col[0], col[1], col[2]);
    }
  }
  tri(a: number[], b: number[], c: number[], col: [number, number, number]): void {
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(col[0], col[1], col[2]);
    }
  }
  /** An oriented box: centre, half extents along (t, up, o), t horizontal unit. */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, tx: number, tz: number, col: [number, number, number]): void {
    const ox = -tz;
    const oz = tx;
    const P = (sx: number, sy: number, sz: number): number[] => [cx + tx * hx * sx + ox * hz * sz, cy + hy * sy, cz + tz * hx * sx + oz * hz * sz];
    const f = (k: number): [number, number, number] => [col[0] * k, col[1] * k, col[2] * k];
    this.quad(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), f(0.85));
    this.quad(P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), P(-1, -1, -1), f(0.85));
    this.quad(P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), f(1));
    this.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), f(0.92));
    this.quad(P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), f(0.78));
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

export function buildStreet(ctx: Ctx): THREE.Group | null {
  const rt = ctx.rt;
  const sc = rt.def.scenery;
  if (!sc?.city) return null;
  const group = new THREE.Group();
  group.name = 'street';
  const rnd = mulberry32(rt.def.seed ^ 0x6a09e667);
  const v = new THREE.Vector3();
  const blocked = (x: number, z: number, m: number): boolean => ctx.reserved.some((r) => r(x, z, m));
  const wallAt = (sgn: 1 | -1, s: number): number => {
    const i = Math.round(rt.wrapS(s) / rt.spacing) % rt.count;
    return sgn > 0 ? rt.L.wall[i] : rt.R.wall[i];
  };
  const place = (s: number, sgn: 1 | -1, gap: number): { x: number; y: number; z: number; ox: number; oz: number; tx: number; tz: number } => {
    const i = Math.round(rt.wrapS(s) / rt.spacing) % rt.count;
    rt.pointAt(s, sgn * (wallAt(sgn, s) + gap), v);
    return { x: v.x, y: v.y, z: v.z, ox: sgn * rt.HLX[i], oz: sgn * rt.HLZ[i], tx: rt.HTX[i], tz: rt.HTZ[i] };
  };

  // ── traffic lights and bollards at the crossings ─────────────────────────────────────────────────────
  const zebras = (sc.markings ?? []).filter((m) => m.kind === 'zebra').map((m) => resolveMark(rt.plan.marks, rt.length, m.at));
  {
    const f = new Flat();
    const metal = lin(0x2b2e33);
    const black = lin(0x0c0d0f);
    // a pole with a signal head (three dark lenses) and a pedestrian box: local +x points at the road
    f.box(0, 1.7, 0, 0.055, 1.7, 0.055, 1, 0, metal);
    f.box(0.12, 3.1, 0, 0.14, 0.45, 0.1, 1, 0, black);
    for (const [y, c] of [[3.4, 0x3a0808], [3.1, 0x3a2a05], [2.8, 0x06280c]] as const) f.box(0.27, y, 0, 0.02, 0.09, 0.09, 1, 0, lin(c));
    f.box(0.11, 2.3, 0, 0.1, 0.16, 0.08, 1, 0, black);
    f.box(0.0, 1.2, 0, 0.1, 0.12, 0.08, 1, 0, black);
    const geo = f.build();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 });
    ctx.disposables.push(geo, mat);
    const list: { x: number; y: number; z: number; ox: number; oz: number }[] = [];
    for (const s of zebras) {
      for (const sgn of [1, -1] as const) {
        for (const ds of [-2.4, 2.4]) {
          const p = place(s + ds, sgn, 0.9);
          if (blocked(p.x, p.z, 0.3)) continue;
          list.push(p);
        }
      }
    }
    if (list.length) {
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      list.forEach((p, i) => {
        q.setFromAxisAngle(up, Math.atan2(p.oz, -p.ox));
        m4.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(1, 1, 1));
        mesh.setMatrixAt(i, m4);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      group.add(mesh);
    }
    // bollards: a short row on each side of the crossing
    const bg = new THREE.CylinderGeometry(0.13, 0.15, 0.85, 8);
    bg.translate(0, 0.43, 0);
    const bm = new THREE.MeshStandardMaterial({ color: 0x353a40, roughness: 0.5, metalness: 0.4 });
    const spots: { x: number; y: number; z: number }[] = [];
    for (const s of zebras) {
      for (const sgn of [1, -1] as const) {
        for (const ds of [-1.6, -0.8, 0.8, 1.6]) {
          const p = place(s + ds, sgn, 0.55);
          if (!blocked(p.x, p.z, 0.2)) spots.push(p);
        }
      }
    }
    if (spots.length) {
      const bmesh = new THREE.InstancedMesh(bg, bm, spots.length);
      const m4 = new THREE.Matrix4();
      spots.forEach((p, i) => {
        m4.makeTranslation(p.x, p.y, p.z);
        bmesh.setMatrixAt(i, m4);
      });
      bmesh.instanceMatrix.needsUpdate = true;
      bmesh.computeBoundingSphere();
      bmesh.castShadow = true;
      group.add(bmesh);
    }
    ctx.disposables.push(bg, bm);
  }

  // ── kiosks: on the quay promenade and in the squares ────────────────────────────────────────────────
  {
    const f = new Flat();
    const body = lin(0xe9e4d6);
    const roof = lin(0x2f6f6a);
    const dark = lin(0x15171a);
    const accent = lin(0xd9a21b);
    f.box(0, 1.2, 0, 1.2, 1.2, 1.0, 1, 0, body);
    f.box(0, 2.55, 0, 1.45, 0.12, 1.3, 1, 0, roof);
    f.box(0, 2.78, 0, 0.9, 0.1, 0.8, 1, 0, roof);
    f.box(1.02, 1.45, 0, 0.18, 0.55, 0.82, 1, 0, dark);
    f.box(1.0, 2.2, 0, 0.02, 0.18, 0.95, 1, 0, accent);
    f.box(1.3, 1.0, 0, 0.35, 0.05, 0.9, 1, 0, lin(0x8c8a82));
    const geo = f.build();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 });
    ctx.disposables.push(geo, mat);
    // on the quay: along the first straight, between the stands and the water; and at the squares
    const spots: { x: number; y: number; z: number; yaw: number }[] = [];
    for (let s = 90; s < 640; s += 130 + rnd() * 40) {
      // beyond the stand (13 m gap + ~19 m of rows) toward the water
      const p = place(s, -1, 46 + rnd() * 6);
      spots.push({ x: p.x, y: p.y, z: p.z, yaw: Math.atan2(p.oz, -p.ox) });
    }
    for (const m of [{ at: 'Praca1', off: 12, sgn: 1 }, { at: 'Doca', off: 40, sgn: -1 }] as const) {
      const s = rt.plan.marks.get(m.at);
      if (s === undefined) continue;
      const p = place(s + m.off, m.sgn, 9);
      if (!blocked(p.x, p.z, 1.5)) spots.push({ x: p.x, y: p.y, z: p.z, yaw: Math.atan2(p.oz, -p.ox) });
    }
    const ok = spots.filter((p) => !blocked(p.x, p.z, 0.5) && rt.terrain.seaDistance(p.x, p.z) > 6);
    if (ok.length) {
      const mesh = new THREE.InstancedMesh(geo, mat, ok.length);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      ok.forEach((p, i) => {
        q.setFromAxisAngle(up, p.yaw);
        m4.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(1, 1, 1));
        mesh.setMatrixAt(i, m4);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      group.add(mesh);
    }
  }

  // ── bunting across the road ────────────────────────────────────────────────────────────────────────
  if (sc.city.bunting?.length) {
    const f = new Flat();
    const pole = lin(0x8a8f94);
    const colours = [lin(0x16e0bd), lin(0xff2e63), lin(0xf3efe6), lin(0xe8b84a), lin(0x2459d0)];
    for (const mk of sc.city.bunting) {
      const s = resolveMark(rt.plan.marks, rt.length, mk);
      const l = place(s, 1, 1.0);
      const r = place(s, -1, 1.0);
      const topL = [l.x, l.y + 9.2, l.z];
      const topR = [r.x, r.y + 9.2, r.z];
      // two thin poles
      for (const p of [l, r]) f.box(p.x, p.y + 4.6, p.z, 0.07, 4.6, 0.07, 1, 0, pole);
      const span = Math.hypot(topR[0] - topL[0], topR[2] - topL[2]);
      const n = Math.max(8, Math.round(span / 0.95));
      const sag = 1.5;
      const cord = (t: number): number[] => [topL[0] + (topR[0] - topL[0]) * t, topL[1] + (topR[1] - topL[1]) * t - sag * 4 * t * (1 - t), topL[2] + (topR[2] - topL[2]) * t];
      for (let k = 0; k < n; k++) {
        const t0 = (k + 0.15) / n;
        const t1 = (k + 0.85) / n;
        const a = cord(t0);
        const b = cord(t1);
        const mid = cord((t0 + t1) / 2);
        const c = colours[(k + Math.floor(s)) % colours.length];
        // a triangular pennant hanging from the cord, both sides visible
        const hang = [mid[0], mid[1] - 0.75, mid[2]];
        f.tri(a, b, hang, c);
        f.tri(a, hang, b, c);
      }
      // the cord itself
      for (let k = 0; k < n; k++) {
        const a = cord(k / n);
        const b = cord((k + 1) / n);
        f.tri(a, b, [b[0], b[1] - 0.03, b[2]], pole);
        f.tri(a, [b[0], b[1] - 0.03, b[2]], b, pole);
      }
    }
    const geo = f.build();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
    ctx.disposables.push(geo, mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.frustumCulled = true;
    group.add(mesh);
  }
  return group;
}
