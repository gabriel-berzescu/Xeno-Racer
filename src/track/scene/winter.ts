/**
 * The dressing of a winter circuit: the snowbanks that are its barriers, the poles that mark the lane across the ice, the reeds of the
 * shore, and (further down this file) the red wooden cabins of the paddock and the village. The snow, the ice and the road are
 * materials (snow.ts); this is geometry. Everything stands on the ground the runtime gives (`heightSD`), and keeps clear of the
 * physics: the bank's front face is on the wall line, where a car meets it.
 */
import * as THREE from 'three';
import { Noise2, mulberry32 } from '../math';
import { BAR_CODE } from '../types';
import type { SideArrays, TrackRuntimeImpl } from '../runtime';
import type { Ctx } from './ctx';
import { buildBuildings } from './winterProps';
import { buildCrowds, buildPoles, buildReeds } from './winterDetail';

const CHUNK = 120;

// ─────────────────────────────────────────────────────────────────────────────
// Snowbanks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The cross-section of a ploughed bank, outward from its front face at q = 0 (the wall line), as (q, share of the crest height): a steep
 * front that the cars meet, a rounded crest 1 m back, a long soft back slope. The toe in front sits on the deep snow at the foot.
 */
const PROFILE: [number, number][] = [
  [-0.7, 0],
  [-0.3, 0.3],
  [0.1, 0.68],
  [0.55, 0.95],
  [1.1, 1.0],
  [1.8, 0.88],
  [2.7, 0.58],
  [3.7, 0.28],
  [4.6, 0.08],
  [5.4, 0],
];

/** Snowbanks along both sides wherever the barrier is a snowbank: one mesh per chunk of road, lumpy (noise along the road changes the height, the width and the line of the crest). */
export function buildSnowbanks(ctx: Ctx, mat: THREE.Material): THREE.Group {
  const rt = ctx.rt;
  const N = rt.count;
  const group = new THREE.Group();
  group.name = 'snowbanks';
  const noise = new Noise2(rt.def.seed + 71);
  const rnd = mulberry32(rt.def.seed ^ 0x51ee);
  const cols = PROFILE.length;
  const p = new THREE.Vector3();
  for (const sgn of [1, -1] as const) {
    const S: SideArrays = sgn > 0 ? rt.L : rt.R;
    const isBank = (i: number) => S.barrier[((i % N) + N) % N] === BAR_CODE.snowbank;
    let i = 0;
    while (i < N) {
      if (!isBank(i)) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < N && isBank(j + 1)) j++;
      for (let a = i; a < j; a += CHUNK) {
        const b = Math.min(j, a + CHUNK);
        const rows = b - a + 1;
        const pos = new Float32Array(rows * cols * 3);
        const col = new Float32Array(rows * cols * 3);
        for (let r = 0; r < rows; r++) {
          const k = a + r;
          const s = k * rt.spacing;
          const wall = S.wall[k];
          const ox = sgn * rt.HLX[k];
          const oz = sgn * rt.HLZ[k];
          // lumps: height 1.0-1.55 m, breadth 0.85-1.25, the crest drifting 0.3 m
          const nh = noise.noise(s / 23, sgn * 3.1);
          const nw = noise.noise(s / 37 + 11, sgn * 7.7);
          const nc = noise.noise(s / 17 + 5, sgn * 1.3);
          const h = 1.25 + 0.38 * nh + 0.05 * (rnd() - 0.5);
          const wide = 1 + 0.2 * nw;
          const drift = 0.32 * nc;
          for (let c = 0; c < cols; c++) {
            const q = PROFILE[c][0] * (PROFILE[c][0] > 0 ? wide : 1) + drift * Math.sin((c / (cols - 1)) * Math.PI);
            const d = sgn * (wall + q);
            rt.pointAt(s, d, p);
            const y = rt.heightSD(s, d) + h * PROFILE[c][1];
            const o = (r * cols + c) * 3;
            pos[o] = rt.X[k] + ox * (wall + q);
            pos[o + 1] = y;
            pos[o + 2] = rt.Z[k] + oz * (wall + q);
            // the toe in the deep snow and the back are a touch dimmer
            const shade = 0.86 + 0.14 * Math.min(1, PROFILE[c][1] * 2.2);
            col[o] = col[o + 1] = col[o + 2] = shade;
          }
        }
        // normals from the grid
        const nor = new Float32Array(pos.length);
        const at = (r: number, c: number, out: THREE.Vector3) => {
          const o = (Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))) * 3;
          return out.set(pos[o], pos[o + 1], pos[o + 2]);
        };
        const u = new THREE.Vector3();
        const v = new THREE.Vector3();
        const w = new THREE.Vector3();
        const t = new THREE.Vector3();
        const n = new THREE.Vector3();
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            at(r + 1, c, u).sub(at(r - 1, c, w));
            at(r, c + 1, v).sub(at(r, c - 1, t));
            // (q grows outward: for the left side the road runs along +u and outward is +v: n = v x u points up on the left, u x v on the right)
            n.crossVectors(sgn > 0 ? v : u, sgn > 0 ? u : v).normalize();
            if (n.y < 0) n.negate();
            const o = (r * cols + c) * 3;
            nor[o] = n.x;
            nor[o + 1] = n.y;
            nor[o + 2] = n.z;
          }
        }
        const idx: number[] = [];
        for (let r = 0; r + 1 < rows; r++) {
          for (let c = 0; c + 1 < cols; c++) {
            const q0 = r * cols + c;
            const q1 = q0 + 1;
            const q2 = q0 + cols + 1;
            const q3 = q0 + cols;
            // wound so that the face points up on either side (forward x outward is up on the left, down on the right)
            if (sgn > 0) idx.push(q0, q3, q2, q0, q2, q1);
            else idx.push(q0, q1, q2, q0, q2, q3);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(rows * cols * 2), 2));
        g.setAttribute('aSurf', new THREE.BufferAttribute(new Float32Array(rows * cols), 1));
        g.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(rows * cols).fill(-1), 1));
        g.setIndex(idx);
        g.computeBoundingSphere();
        g.computeBoundingBox();
        const mesh = new THREE.Mesh(g, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = `snowbank_${sgn > 0 ? 'L' : 'R'}_${a}`;
        group.add(mesh);
        ctx.disposables.push(g);
      }
      i = j + 1;
    }
  }
  return group;
}

/** Everything a winter circuit adds to the world beyond its materials: the snowbanks, the buildings, the poles on the ice, the reeds, the crowds. */
export function buildWinterScenery(ctx: Ctx, ground: THREE.Material): THREE.Group {
  const root = new THREE.Group();
  root.name = 'winter';
  root.add(buildSnowbanks(ctx, ground));
  const sc = ctx.rt.def.scenery?.winter;
  if (!sc) return root;
  // (buildings first: they reserve their ground, and the reeds and the crowds keep clear of it)
  root.add(buildBuildings(ctx, sc));
  const poles = buildPoles(ctx, sc.poleEvery ?? 22);
  if (poles) root.add(poles);
  const reeds = buildReeds(ctx, sc.reeds ?? 0);
  if (reeds) root.add(reeds);
  if (sc.crowds?.length) {
    const crowds = buildCrowds(ctx, sc.crowds);
    if (crowds) root.add(crowds);
  }
  return root;
}
