/**
 * Mountain-road structures: rock cut faces along the uphill side of the road, and tunnels (arched tube with
 * lamp strips + concrete portals).
 */
import * as THREE from 'three';
import { BAR_CODE } from '../types';
import { Noise2 } from '../math';
import type { Ctx } from './ctx';
import { GeoBuf } from './geom';

export interface RockCutFlags {
  L: Uint8Array;
  R: Uint8Array;
}

function rockMaterial(ctx: Ctx): THREE.MeshStandardMaterial {
  const r = ctx.tex.rock;
  const make = (t: THREE.Texture) => {
    const c = t.clone();
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.repeat.set(1 / 5.5, 1 / 5.5);
    c.needsUpdate = true;
    ctx.disposables.push(c);
    return c;
  };
  const mat = new THREE.MeshStandardMaterial({ map: make(r.diff), normalMap: make(r.nor), roughnessMap: make(r.rough), roughness: 1, color: 0xa39b90, envMapIntensity: 0.5 });
  mat.name = 'rockcut';
  ctx.disposables.push(mat);
  return mat;
}

/** Find where the ground rises steeply behind the barrier and stand a rock face on the wall line there. */
export function buildRockCuts(ctx: Ctx): { group: THREE.Group; flags: RockCutFlags } {
  const rt = ctx.rt;
  const N = rt.count;
  const h = rt.spacing;
  const group = new THREE.Group();
  group.name = 'rockcuts';
  const flags: RockCutFlags = { L: new Uint8Array(N + 1), R: new Uint8Array(N + 1) };
  const noise = new Noise2(rt.def.seed + 99);
  const mat = rockMaterial(ctx);
  const topY = (s: number, sgn: 1 | -1, wall: number) => rt.heightSD(s, sgn * (wall + 3.2));
  for (const sgn of [1, -1] as const) {
    const S = sgn > 0 ? rt.L : rt.R;
    const F = sgn > 0 ? flags.L : flags.R;
    const rise = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const s = i * h;
      const w = S.wall[i];
      rise[i] = topY(s, sgn, w) - rt.heightSD(s, sgn * w);
    }
    // runs where the ground behind the barrier is clearly higher than the road
    let i = 0;
    while (i < N) {
      if (rise[i] < 1.7) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < N && rise[j + 1] >= 1.0) j++;
      if (j - i >= 10) {
        for (let k = i; k <= j; k++) F[k] = 1;
        // chunk the run
        for (let a = i; a <= j; a += 90) {
          const b = Math.min(j, a + 90);
          const buf = new GeoBuf();
          const rowsN = b - a + 1;
          const NV = 6;
          for (let k = a; k <= b; k++) {
            const s = k * h;
            const w = S.wall[k];
            const ox = sgn * rt.HLX[k];
            const oz = sgn * rt.HLZ[k];
            const x0 = rt.X[k] + ox * w;
            const z0 = rt.Z[k] + oz * w;
            const y0 = rt.heightSD(s, sgn * w);
            const taper = Math.min(1, (k - i) / 8, (j - k) / 8);
            const yTop = Math.max(y0 + 1.2, topY(s, sgn, w) - 0.15) * taper + (y0 + 0.4) * (1 - taper);
            for (let m = 0; m < NV; m++) {
              const t = m / (NV - 1);
              const y = y0 - 0.3 + (yTop - y0 + 0.3) * t;
              const bumps = noise.noise(s * 0.33, y * 0.45) * 0.4 + noise.noise(s * 0.9 + 7, y * 1.1) * 0.12;
              const q = 0.05 + 0.6 * t + (m === 0 ? 0 : bumps) * Math.min(1, t * 3);
              buf.v(x0 + ox * q, y, z0 + oz * q, -ox, 0.3, -oz, s / 5.5, y / 5.5);
            }
          }
          for (let r = 0; r + 1 < rowsN; r++) {
            for (let m = 0; m + 1 < NV; m++) {
              const A = r * NV + m;
              const B = A + 1;
              const C = (r + 1) * NV + m + 1;
              const D = (r + 1) * NV + m;
              // winding: faces the road (-outward); fix by sign of the side
              if (sgn > 0) buf.quad(A, B, C, D);
              else buf.quad(A, D, C, B);
            }
          }
          const geo = buf.build();
          geo.computeVertexNormals();
          const mesh = new THREE.Mesh(geo, mat);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.name = `rock_${sgn > 0 ? 'L' : 'R'}_${a}`;
          group.add(mesh);
        }
      }
      i = j + 1;
    }
  }
  return { group, flags };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tunnels
// ─────────────────────────────────────────────────────────────────────────────

function lampTexture(): THREE.CanvasTexture {
  // u around the ring (0 = left wall base .. 0.5 = roof apex .. 1 = right wall base), v along the tunnel (8 m per
  // repeat). Tiled walls, darker roof, ring joints, and two rows of lamp strips on the upper haunches with a warm halo.
  const W = 128;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const rnd = (() => {
    let a = 0x2f6e2b1;
    return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  })();
  g.fillStyle = '#585c60';
  g.fillRect(0, 0, W, H);
  // wall tiles (lighter, with joints) up to the haunch, soot band near the floor
  for (const [x0, x1] of [
    [0, W * 0.2],
    [W * 0.8, W],
  ]) {
    g.fillStyle = '#8d9296';
    g.fillRect(x0, 0, x1 - x0, H);
    g.fillStyle = 'rgba(40,42,44,0.55)';
    g.fillRect(x0, 0, x1 - x0, H);
    g.fillStyle = '#8d9296';
    g.fillRect(x0, 0, x1 - x0, H);
    g.strokeStyle = 'rgba(60,64,68,0.45)';
    g.lineWidth = 1;
    for (let k = 0; k <= H; k += 16) {
      g.beginPath();
      g.moveTo(x0, k + 0.5);
      g.lineTo(x1, k + 0.5);
      g.stroke();
    }
  }
  const soot = g.createLinearGradient(0, 0, W, 0);
  soot.addColorStop(0, 'rgba(18,18,20,0.75)');
  soot.addColorStop(0.07, 'rgba(18,18,20,0.05)');
  soot.addColorStop(0.93, 'rgba(18,18,20,0.05)');
  soot.addColorStop(1, 'rgba(18,18,20,0.75)');
  g.fillStyle = soot;
  g.fillRect(0, 0, W, H);
  // concrete grain
  for (let k = 0; k < 2600; k++) {
    const v = 90 + rnd() * 70;
    g.fillStyle = `rgba(${v},${v},${v + 4},0.10)`;
    g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  // roof panel seams every 4 m
  g.fillStyle = 'rgba(30,32,34,0.55)';
  g.fillRect(0, 0, W, 2);
  g.fillRect(0, H / 2, W, 1);
  // lamp strips on the haunches (u = 0.3 and 0.7): halo, then the bright bar
  for (const u of [0.3, 0.7]) {
    for (const vy of [64, 192]) {
      const halo = g.createRadialGradient(W * u, vy, 2, W * u, vy, 62);
      halo.addColorStop(0, 'rgba(255,210,150,0.55)');
      halo.addColorStop(0.35, 'rgba(255,200,140,0.20)');
      halo.addColorStop(1, 'rgba(255,190,120,0)');
      g.fillStyle = halo;
      g.fillRect(0, vy - 64, W, 128);
      g.fillStyle = '#fff6e2';
      g.fillRect(W * u - 4, vy - 24, 8, 48);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function buildTunnels(ctx: Ctx, portalMaterial: THREE.Material, terrainMaterial: THREE.Material): THREE.Group | null {
  const rt = ctx.rt;
  const defs = rt.def.tunnels;
  if (!defs?.length) return null;
  const group = new THREE.Group();
  group.name = 'tunnels';
  const lamp = lampTexture();
  ctx.disposables.push(lamp);
  const NR = 18;
  for (const td of defs) {
    // unlit (the sun must not reach inside): the lamp strips and a dim lining colour are painted into the map
    const lining = new THREE.MeshBasicMaterial({ map: lamp, color: td.lining ?? 0xffffff, side: THREE.DoubleSide });
    // weathered portal concrete: darker than the barrier concrete, with sooty vertex colours around the opening
    const portalMat = (portalMaterial as THREE.MeshStandardMaterial).clone();
    portalMat.color.setHex(td.portal ?? 0x8e8f8c);
    portalMat.vertexColors = true;
    portalMat.name = 'portal';
    ctx.disposables.push(lining, portalMat);
    if (td.portal !== undefined) {
      portalMat.emissive.setHex(td.portal);
      portalMat.emissiveIntensity = 0.06;
      ctx.envListeners.push((env) => {
        portalMat.emissiveIntensity = 0.06 + 0.3 * env.darkness;
      });
    }
    const i0 = Math.round(((rt.plan.marks.get(typeof td.from === 'string' ? td.from : td.from[0]) ?? 0) + (typeof td.from === 'string' ? 0 : td.from[1])) / rt.spacing);
    const i1 = Math.round(((rt.plan.marks.get(typeof td.to === 'string' ? td.to : td.to[0]) ?? 0) + (typeof td.to === 'string' ? 0 : td.to[1])) / rt.spacing);
    const buf = new GeoBuf();
    const rows = i1 - i0 + 1;
    const ringV = NR + 1;
    const frames: { cx: number; cy: number; cz: number; lx: number; lz: number; a: number }[] = [];
    for (let i = i0; i <= i1; i++) {
      const k = ((i % rt.count) + rt.count) % rt.count;
      const a = (rt.L.wall[k] + rt.R.wall[k]) / 2 + (rt.L.W[k] - rt.R.W[k]) * 0;
      const dMid = (rt.L.wall[k] - rt.R.wall[k]) / 2;
      const p = new THREE.Vector3();
      rt.pointAt(i * rt.spacing, dMid, p);
      // use the lowest road edge height so the lining reaches the floor on banked ground
      frames.push({ cx: p.x, cy: p.y, cz: p.z, lx: rt.HLX[k], lz: rt.HLZ[k], a });
    }
    for (let r = 0; r < rows; r++) {
      const f = frames[r];
      for (let k = 0; k <= NR; k++) {
        const t = k / NR;
        const ang = Math.PI * t; // 0 (left) .. pi (right)
        const cx = Math.cos(ang);
        const sy = Math.sin(ang);
        const x = cx * f.a; // + = left
        const y = k === 0 || k === NR ? 0 : 2.1 + 3.5 * sy;
        const nxl = -cx;
        const nyl = -sy * 0.9;
        const nl = Math.hypot(nxl, nyl) || 1;
        buf.v(f.cx + f.lx * x, f.cy + y - (k === 0 || k === NR ? 0.2 : 0), f.cz + f.lz * x, (f.lx * nxl) / nl, nyl / nl, (f.lz * nxl) / nl, t, ((i0 + r) * rt.spacing) / 8);
      }
    }
    for (let r = 0; r + 1 < rows; r++) {
      for (let k = 0; k < NR; k++) {
        const A = r * ringV + k;
        const B = A + 1;
        const C = (r + 1) * ringV + k + 1;
        const D = (r + 1) * ringV + k;
        buf.quad(A, D, C, B);
      }
    }
    const mesh = new THREE.Mesh(buf.build(), lining);
    mesh.name = 'tunnel_tube';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    // earth cap over the tunnel: the hill surface, blending into the surrounding terrain
    let capFront = 0;
    let capBack = 0;
    {
      const cb = new GeoBuf();
      const KL = 16;
      const rowsC: number[] = [];
      for (let i = i0; i <= i1; i += 2) rowsC.push(i);
      if (rowsC[rowsC.length - 1] !== i1) rowsC.push(i1);
      const tmp = new THREE.Vector3();
      rowsC.forEach((i, ri) => {
        const k = ((i % rt.count) + rt.count) % rt.count;
        const wl = rt.L.wall[k] + 12.5;
        const wr = rt.R.wall[k] + 12.5;
        const dMid = (rt.L.wall[k] - rt.R.wall[k]) / 2;
        const a = (rt.L.wall[k] + rt.R.wall[k]) / 2;
        const roadY = rt.py[k];
        for (let c = 0; c <= KL; c++) {
          const d = -wr + ((wl + wr) * c) / KL;
          rt.pointAt(i * rt.spacing, d, tmp);
          const base = rt.fieldHeight(tmp.x, tmp.z);
          const u = Math.abs(d - dMid);
          const sm = Math.min(1, Math.max(0, (u - (a + 0.5)) / 8.5));
          // an irregular crown (not a flat loaf): low-frequency variation along and across the tunnel
          const crown =
            td.cover !== undefined
              ? td.cover + 0.7 * Math.sin(i * rt.spacing * 0.117 + d * 0.21) + 0.5 * Math.sin(d * 0.37 + i * 0.05)
              : 8.8 + 2.6 * Math.sin(i * rt.spacing * 0.043 + 1.3) + 1.7 * Math.sin(i * rt.spacing * 0.117 + d * 0.21) + 0.9 * Math.sin(d * 0.37 + i * 0.05);
          const lift = Math.max(0, roadY + crown - base) * (1 - sm * sm * (3 - 2 * sm));
          // (half a metre under the lift: where the cap only meets the ground it hides under it instead of fighting it)
          const y = base + lift - 0.5;
          if (ri === 0 && Math.abs(d - dMid) < a) capFront = Math.max(capFront, y - roadY);
          if (ri === rowsC.length - 1 && Math.abs(d - dMid) < a) capBack = Math.max(capBack, y - roadY);
          cb.v(tmp.x, y, tmp.z, 0, 1, 0, tmp.x, tmp.z);
          cb.color(1, 1, 1);
        }
      });
      for (let r = 0; r + 1 < rowsC.length; r++) {
        for (let c = 0; c < KL; c++) {
          const A = r * (KL + 1) + c;
          const B = A + 1;
          const C = A + KL + 2;
          const D = A + KL + 1;
          cb.quad(A, D, C, B);
        }
      }
      const cg = cb.build();
      cg.computeVertexNormals();
      const cm = new THREE.Mesh(cg, terrainMaterial);
      cm.receiveShadow = true;
      cm.name = 'tunnel_cap';
      group.add(cm);
    }
    // portals: a wall around the arch, at both ends, with a protruding arch ring (rim) and sooty concrete
    portalMat.side = THREE.DoubleSide;
    for (const end of [0, 1]) {
      const f = frames[end ? rows - 1 : 0];
      const pb = new GeoBuf();
      const outerW = f.a + 12.5;
      const outerH = Math.max(9.5, (end ? capBack : capFront) + 0.7);
      const ti = (end ? i1 : i0) % rt.count;
      const tk = (ti + rt.count) % rt.count;
      const fx = end ? rt.HTX[tk] : -rt.HTX[tk];
      const fz = end ? rt.HTZ[tk] : -rt.HTZ[tk];
      const W = 0.8; // rim width
      const D = 0.55; // rim protrusion
      const P = (x: number, y: number, z = 0): [number, number, number] => [f.cx + f.lx * x + fx * z, f.cy + y, f.cz + f.lz * x + fz * z];
      const vtx = (x: number, y: number, z: number, nx: number, ny: number, nzv: number, shade: number): number => {
        const [px, py, pz] = P(x, y, z);
        // normal given in face space: (nx along left, ny up, nzv outward)
        const idx = pb.v(px, py, pz, f.lx * nx + fx * nzv, ny, f.lz * nx + fz * nzv, x, y);
        pb.color(shade, shade, shade);
        return idx;
      };
      const arch = (k: number, grow: number): [number, number] => {
        const t = k / NR;
        const ang = Math.PI * t;
        const cx = Math.cos(ang);
        const sy = Math.sin(ang);
        return [cx * (f.a + grow), k === 0 || k === NR ? 0 : 2.1 + (3.5 + grow) * sy];
      };
      const inner0: number[] = []; // opening edge at depth 0 (inside the tunnel mouth)
      const innerF: number[] = []; // opening edge at the rim front
      const rimF: number[] = []; // rim outer edge at the rim front
      const rim0: number[] = []; // rim outer edge at depth 0
      const outer: number[] = [];
      for (let k = 0; k <= NR; k++) {
        const t = k / NR;
        const ang = Math.PI * t;
        const rx = Math.cos(ang);
        const ry = Math.sin(ang);
        const [ax, ay] = arch(k, 0);
        const [bx, by] = arch(k, W);
        inner0.push(vtx(ax, ay, 0, -rx, -ry, 0, 0.42));
        innerF.push(vtx(ax, ay, D, -rx, -ry, 0, 0.5));
        rimF.push(vtx(bx, by, D, 0, 0, 1, 0.62));
        rim0.push(vtx(bx, by, 0, rx, ry, 0, 0.7));
        // outer point: project the rim point radially onto the rectangle
        const dx = bx;
        const dy = by + 0.001 - 3.0;
        const sc = Math.min(Math.abs(dx) > 1e-4 ? outerW / Math.abs(dx) : 1e9, dy > 1e-4 ? (outerH - 3.0) / dy : 1e9);
        outer.push(vtx(dx * sc, Math.max(-0.5, 3.0 + dy * sc), 0, 0, 0, 1, 0.95));
      }
      for (let k = 0; k < NR; k++) {
        pb.quad(rim0[k], rim0[k + 1], outer[k + 1], outer[k]); // main wall face
        pb.quad(rimF[k], rimF[k + 1], rim0[k + 1], rim0[k]); // rim outer side
        pb.quad(innerF[k], innerF[k + 1], rimF[k + 1], rimF[k]); // rim front face
        pb.quad(inner0[k], inner0[k + 1], innerF[k + 1], innerF[k]); // opening reveal
      }
      // close the corners down to the road on both sides
      const cL = vtx(outerW, -0.5, 0, 0, 0, 1, 0.95);
      const cR = vtx(-outerW, -0.5, 0, 0, 0, 1, 0.95);
      pb.tri(rim0[0], outer[0], cL);
      pb.tri(rim0[NR], cR, outer[NR]);
      // foundation skirt: carry the wall down to the ground where the hillside falls away from the road
      for (const side of [1, -1]) {
        const x0 = f.a + W;
        let prevTop = -1;
        let prevBot = -1;
        for (let j = 0; j <= 8; j++) {
          const x = side * (x0 + ((outerW - x0) * j) / 8);
          const [wx, , wz] = P(x, 0, 0);
          const gy = rt.fieldHeight(wx, wz) - f.cy;
          const yb = Math.min(-0.5, gy - 1.2);
          const top = vtx(x, -0.5, 0, 0, 0, 1, 0.9);
          const bot = vtx(x, yb, 0, 0, 0, 1, 0.72);
          if (prevTop >= 0) {
            pb.quad(prevTop, prevBot, bot, top);
            pb.quad(prevTop, top, bot, prevBot);
          }
          prevTop = top;
          prevBot = bot;
        }
      }
      const pm = new THREE.Mesh(pb.build(), portalMat);
      pm.castShadow = true;
      pm.receiveShadow = true;
      pm.name = 'tunnel_portal';
      group.add(pm);
    }
  }
  void BAR_CODE;
  return group;
}
