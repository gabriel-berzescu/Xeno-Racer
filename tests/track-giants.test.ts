/**
 * The old wood and the sea rocks of Halcyon Ring (src/track/scene/giants*.ts), headless: where the giants may stand, what one is
 * made of, that the shade's stand-in casters cast where the trees would, where the arch stands and that it is open, and what it all
 * costs. Run: npx vitest run tests/track-giants.test.ts
 */
import { describe, expect, it } from 'vitest';
import { TRACKS, loadTrackRuntime } from '../src/track';
import type { TrackRuntimeImpl } from '../src/track';
import { barkPixels } from '../src/track/scene/giantsMat';
import { lampMasts, placeGiants, placeLogs, placeUnder, roadSide, ROOT_REACH, woodDensity, type Blocked } from '../src/track/scene/giantsPlace';
import { archFootprint, archSize, emitArch, emitBoulder, placeBoulders, RockBuf } from '../src/track/scene/giantsRocks';
import { NO_PROBE, PROXY_HEIGHT, ShadeModel, slideToSun } from '../src/track/scene/giantsShade';
import { emitGiant, emitLog, GBuf, GIANT_LODS, trunkShape } from '../src/track/scene/giantsTree';

const rt = loadTrackRuntime('halcyon') as TrackRuntimeImpl;
rt.ensureField();
const def = rt.def.scenery!.giants!;
const wood = def.wood!;
const sea = rt.terrain.lakeLevel!;
const open: Blocked = { ground: () => false, view: () => false };
const giants = placeGiants(rt, def, open);
const logs = placeLogs(rt, def, giants, open);
const under = placeUnder(rt, def, giants, open, 1, logs);
const mark = (name: string): number => rt.plan.marks.get(name)!;

describe("Halcyon Ring's old wood", () => {
  it('belongs to this circuit alone', () => {
    for (const t of TRACKS) {
      if (t.info.id === 'halcyon') continue;
      expect((loadTrackRuntime(t.info.id) as TrackRuntimeImpl).def.scenery?.giants, t.info.id).toBeUndefined();
    }
  });

  it('is two hundred giants or so, 88 to 132 m tall and 6 to 11 m through, none in the sea, on the road or in a glade', () => {
    expect(giants.length).toBeGreaterThanOrEqual(170);
    expect(giants.length).toBeLessThanOrEqual(300);
    expect(giants.filter((g) => g.kind === 'row').length).toBeGreaterThanOrEqual(50);
    expect(giants.filter((g) => g.kind === 'lone').length).toBe(def.lone!.length);
    for (const g of giants) {
      const at = `giant at ${g.x.toFixed(0)}, ${g.z.toFixed(0)}`;
      expect(g.h, at).toBeGreaterThanOrEqual(88);
      expect(g.h, at).toBeLessThanOrEqual(132);
      expect(g.r * 2, at).toBeGreaterThanOrEqual(6);
      expect(g.r * 2, at).toBeLessThanOrEqual(11);
      expect(g.y, at).toBeGreaterThan(sea + 1.5);
      expect(g.root).toBeCloseTo(g.r * ROOT_REACH, 9);
      if (g.kind === 'lone') continue;
      // the tips of the roots are behind the barrier's face, with a metre to spare
      expect(g.back - g.root, at).toBeGreaterThan(0.85);
      expect(woodDensity(wood, g.x, g.z), at).toBeGreaterThan(0.05);
      for (const gl of wood.glades!) expect(Math.hypot(g.x - gl.x, g.z - gl.z), at).toBeGreaterThan(gl.r * 0.85);
    }
  });

  it('keeps its trunks apart, and off the floodlight masts', () => {
    for (let i = 0; i < giants.length; i++) {
      for (let j = i + 1; j < giants.length; j++) {
        const a = giants[i];
        const b = giants[j];
        expect(Math.hypot(a.x - b.x, a.z - b.z), `${i} and ${j}`).toBeGreaterThan(a.r + b.r + 3);
      }
    }
    const masts = lampMasts(rt);
    expect(masts.length).toBeGreaterThan(100);
    for (const g of giants) {
      if (g.kind === 'lone') continue;
      for (let i = 0; i < masts.length; i += 2) expect(Math.hypot(g.x - masts[i], g.z - masts[i + 1]), `giant at ${g.x.toFixed(0)}, ${g.z.toFixed(0)}`).toBeGreaterThan(g.root + 0.5);
    }
  });

  it('lines the three Jackdaw bends with trunks on both sides: one every 70 m or closer, within 16 m of the barrier', () => {
    const from = mark('Jackdaw1') - 60;
    const to = mark('Jackdaw3/e');
    for (const sgn of [1, -1]) {
      const along: number[] = [];
      for (const g of giants) {
        const i = rt.nearestSample(g.x, g.z);
        const left = (g.x - rt.X[i]) * rt.HLX[i] + (g.z - rt.Z[i]) * rt.HLZ[i] > 0;
        if (left === sgn > 0 && g.back < 16) along.push(i * rt.spacing);
      }
      along.sort((a, b) => a - b);
      const inWood = along.filter((s) => s >= from - 70 && s <= to + 70);
      expect(inWood.length).toBeGreaterThanOrEqual(12);
      for (let i = 1; i < inWood.length; i++) expect(inWood[i] - inWood[i - 1], `${sgn > 0 ? 'left' : 'right'} of the road at s ${inWood[i].toFixed(0)}`).toBeLessThan(70);
      expect(inWood[0]).toBeLessThan(from + 70);
      expect(inWood[inWood.length - 1]).toBeGreaterThan(to - 70);
    }
  });

  it('leaves the outside of Osprey open, and thins out toward Heron', () => {
    const k = Math.round(mark('Osprey/m') / rt.spacing);
    // the cliff top: nothing within 120 m of the road's outside there
    const ox = rt.X[k] + rt.HLX[k] * 45;
    const oz = rt.Z[k] + rt.HLZ[k] * 45;
    for (const g of giants) expect(Math.hypot(g.x - ox, g.z - oz)).toBeGreaterThan(40);
    const near = (name: string): number => {
      const i = Math.round(mark(name) / rt.spacing);
      return giants.filter((g) => Math.hypot(g.x - rt.X[i], g.z - rt.Z[i]) < 120).length;
    };
    expect(near('Jackdaw2/m')).toBeGreaterThan(near('Heron/m') * 2);
    expect(near('Heron/m')).toBeGreaterThanOrEqual(2);
  });

  it("stands nothing where another builder has claimed the ground or a TV camera's line of sight", () => {
    // a camera's corridor straight across the wood, and a claimed disc in the middle of it
    const ax = 700;
    const az = 1440;
    const bx = 250;
    const bz = 1000;
    const corridor = (x: number, z: number, m: number): boolean => {
      const t = Math.min(1, Math.max(0, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2)));
      return Math.hypot(x - ax - (bx - ax) * t, z - az - (bz - az) * t) < 2.5 + m;
    };
    const claimed = (x: number, z: number, m: number): boolean => Math.hypot(x - 520, z - 1330) < 30 + m;
    const shy = placeGiants(rt, def, { ground: claimed, view: corridor });
    expect(shy.length).toBeGreaterThan(120);
    for (const g of shy) {
      if (g.kind === 'lone') continue;
      expect(corridor(g.x, g.z, g.r), `giant at ${g.x.toFixed(0)}, ${g.z.toFixed(0)}`).toBe(false);
      expect(claimed(g.x, g.z, g.r)).toBe(false);
    }
  });

  it('has young trees and ferns under it, and a few fallen giants, all behind the barriers', () => {
    expect(under.young.length).toBeGreaterThan(120);
    expect(under.ferns.length).toBeGreaterThan(800);
    for (const y of under.young) {
      expect(y.s).toBeGreaterThanOrEqual(9);
      expect(y.s).toBeLessThanOrEqual(28);
      expect(roadSide(rt, y.x, y.z).back).toBeGreaterThan(3 + y.s * 0.3);
      for (const g of giants) expect(Math.hypot(g.x - y.x, g.z - y.z)).toBeGreaterThan(g.root + 2);
    }
    for (const f of under.ferns) expect(roadSide(rt, f.x, f.z).back).toBeGreaterThan(0.8);
    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const l of logs) {
      for (let k = 0; k <= 10; k++) {
        const x = l.x + (Math.cos(l.yaw) * l.len * k) / 10;
        const z = l.z + (Math.sin(l.yaw) * l.len * k) / 10;
        expect(roadSide(rt, x, z).back).toBeGreaterThan(l.r + 4);
        for (const g of giants) expect(Math.hypot(g.x - x, g.z - z)).toBeGreaterThan(g.root + l.r);
      }
    }
  });

  it('thins out with the quality tier, the rows last', () => {
    const low = placeGiants(rt, def, open, 0.5);
    expect(low.length).toBeLessThan(giants.length * 0.9);
    expect(low.filter((g) => g.kind === 'row').length).toBe(giants.filter((g) => g.kind === 'row').length);
  });
});

describe('a giant', () => {
  it('has no bough for its first 30 to 46 m, and roots that reach no further than the ground it was given', () => {
    for (const g of giants) {
      const sh = trunkShape(g);
      expect(sh.first).toBeGreaterThanOrEqual(30);
      expect(sh.first).toBeLessThanOrEqual(46);
      expect(sh.top).toBeGreaterThan(g.h * 0.85);
      for (let a = 0; a < 6.28; a += 0.1) {
        expect(sh.rho(a, 0), `giant at ${g.x.toFixed(0)}, ${g.z.toFixed(0)}`).toBeLessThan(g.root + 0.12 * g.r);
        // above the flare it is the column it was said to be
        expect(sh.rho(a, 12)).toBeGreaterThan(g.r * 0.7);
        expect(sh.rho(a, 12)).toBeLessThan(g.r * 1.2);
      }
    }
  });

  it('is built whole in each of its three sizes, every vertex with its sunlight accounted for', () => {
    const g = giants.find((t) => t.kind === 'row')!;
    let last = Infinity;
    GIANT_LODS.forEach((_lod, li) => {
      const bark = new GBuf();
      const leaf = new GBuf();
      const shade = new ShadeModel();
      emitGiant(g, li, bark, leaf, shade, 0);
      for (const b of [bark, leaf]) {
        expect(b.pos.length).toBe(b.n * 3);
        expect(b.probe.length).toBe(b.n);
        for (const v of b.pos) expect(Number.isFinite(v)).toBe(true);
        for (const v of b.nor) expect(Number.isFinite(v)).toBe(true);
        for (const i of b.idx) expect(i).toBeLessThan(b.n);
        for (const p of b.probe) expect(p === NO_PROBE || (p >= 0 && p < shade.probeCount)).toBe(true);
      }
      // the top of the tree is where it should be, and the crown is as wide as a crown
      let top = -Infinity;
      let reach = 0;
      for (let i = 0; i < leaf.n; i++) {
        top = Math.max(top, leaf.pos[i * 3 + 1] - g.y);
        reach = Math.max(reach, Math.hypot(leaf.pos[i * 3] - g.x, leaf.pos[i * 3 + 2] - g.z));
      }
      expect(top).toBeGreaterThan(g.h * 0.85);
      expect(top).toBeLessThan(g.h + 12);
      expect(reach).toBeGreaterThan(12);
      expect(reach).toBeLessThan(45);
      // what is under 14 m is left to the shadow maps
      for (let i = 0; i < bark.n; i++) if (bark.pos[i * 3 + 1] - g.y < 13.9) expect(bark.probe[i]).toBe(NO_PROBE);
      const tris = bark.tris + leaf.tris;
      expect(tris).toBeLessThan(last);
      last = tris;
    });
    expect(last).toBeLessThan(700);
  });

  it('costs, the whole wood at High: under 300 000 triangles, and under 30 000 in its stand-in casters', () => {
    const bark = new GBuf();
    const leaf = new GBuf();
    const shade = new ShadeModel();
    giants.forEach((g, i) => emitGiant(g, g.kind === 'lone' ? 0 : g.road < 48 ? 0 : g.road < 112 ? 1 : 2, bark, leaf, shade, i));
    for (const l of logs) emitLog(bark, l, 12);
    const c = shade.casters();
    expect(bark.tris + leaf.tris + under.ferns.length * 4).toBeLessThan(300_000);
    expect(c.idx.length / 3).toBeLessThan(30_000);
    expect(shade.probeCount).toBeLessThan(20_000);
  });
});

describe("the wood's shade", () => {
  const bark = new GBuf();
  const leaf = new GBuf();
  const shade = new ShadeModel();
  const some = giants.filter((g) => g.kind !== 'lone').slice(0, 60);
  some.forEach((g, i) => emitGiant(g, 1, bark, leaf, shade, i));

  it('gives every probe a share of the sun between none and all: all of it to the tops under a high sun, less to the trunks under a low one', () => {
    const noon = shade.solve(0, 1, 0);
    expect(noon.length).toBe(shade.probeCount * 2);
    for (const v of noon) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // the highest probe of all has nothing over it
    let hi = 0;
    for (let i = 0; i < shade.probeCount; i++) if (shade.probes[i * 6 + 1] > shade.probes[hi * 6 + 1]) hi = i;
    expect(noon[hi * 2]).toBeGreaterThan(0.6);
    // a sun eight degrees up, as at the golden hour: the trunks' rings see less of it than under the high sun, on the whole
    const el = (8.5 * Math.PI) / 180;
    const low = shade.solve(-0.39 * Math.cos(el), Math.sin(el), -0.92 * Math.cos(el));
    let nRing = 0;
    let sumLow = 0;
    let dark = 0;
    for (let i = 0; i < shade.probeCount; i++) {
      if (shade.probes[i * 6 + 3] <= 0) continue;
      nRing++;
      sumLow += low[i * 2] + low[i * 2 + 1];
      if (low[i * 2] < 0.05 && low[i * 2 + 1] < 0.05) dark++;
    }
    expect(nRing).toBeGreaterThan(200);
    expect(sumLow / (2 * nRing)).toBeLessThan(0.8);
    expect(dark).toBeGreaterThan(nRing * 0.1);
    expect(dark).toBeLessThan(nRing * 0.97);
    // painted onto the vertices: 1 where the shadow maps do the work, the probes' share elsewhere
    const out = new Float32Array(bark.n);
    shade.paint(bark.pos, bark.probe, low, -0.39, -0.92, out);
    for (let i = 0; i < bark.n; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(0);
      expect(out[i]).toBeLessThanOrEqual(1);
      if (bark.probe[i] === NO_PROBE) expect(out[i]).toBe(1);
    }
  });

  it("slides its stand-in casters down the sun's own ray to twenty metres over the ground: each casts where the tree would", () => {
    const c = shade.casters();
    const out = new Float32Array(c.pos.length);
    const ground = (x: number, z: number): number => Math.max(sea, rt.drawnHeight(x, z));
    for (const elDeg of [8.5, 30, 66.6]) {
      const el = (elDeg * Math.PI) / 180;
      const s = [-0.39 * Math.cos(el), Math.sin(el), -0.92 * Math.cos(el)];
      const l = Math.hypot(s[0], s[1], s[2]);
      const sx = s[0] / l;
      const sy = s[1] / l;
      const sz = s[2] / l;
      slideToSun(c.pos, out, sx, sy, sz, ground);
      let moved = 0;
      for (let i = 0; i < out.length; i += 3) {
        const dx = c.pos[i] - out[i];
        const dy = c.pos[i + 1] - out[i + 1];
        const dz = c.pos[i + 2] - out[i + 2];
        const t = dx * sx + dy * sy + dz * sz;
        // moved along the ray and nowhere else, and only downward
        expect(t).toBeGreaterThanOrEqual(-1e-3);
        expect(Math.hypot(dx - sx * t, dy - sy * t, dz - sz * t)).toBeLessThan(0.02 + t * 1e-5);
        if (t > 0.01) moved++;
        // inside the cascades (35 m of casters over the car, less the ground's own rise and fall) and well over a car and a barrier:
        // within a few metres of the height asked for (at a cliff's edge the ground steps, and the answer with it)
        const over = out[i + 1] - ground(out[i], out[i + 2]);
        if (c.pos[i + 1] - ground(c.pos[i], c.pos[i + 2]) > PROXY_HEIGHT) {
          expect(over, `sun at ${elDeg} degrees`).toBeGreaterThan(PROXY_HEIGHT - 9);
          expect(over, `sun at ${elDeg} degrees`).toBeLessThan(PROXY_HEIGHT + 9);
        }
      }
      expect(moved).toBeGreaterThan(out.length / 3 / 2);
    }
  });
});

describe('the sea rocks', () => {
  const arch = def.arch!;
  const size = archSize(arch);

  it('stand an arch in the sea north of the headland, due north of the last of the climb to Osprey', () => {
    expect(rt.fieldHeight(arch.x, arch.z)).toBeLessThan(sea - 1);
    // 200 to 400 m off the road, and the line of sight due north from the road goes through the opening
    let best = Infinity;
    let off = Infinity;
    for (let s = mark('Petrel/e'); s < mark('Osprey/a'); s += 5) {
      const k = Math.round(s / rt.spacing);
      if (Math.abs(rt.X[k] - arch.x) < Math.abs(off)) {
        off = rt.X[k] - arch.x;
        best = arch.z - rt.Z[k];
      }
    }
    expect(Math.abs(off)).toBeLessThan(arch.span / 2 - 5);
    expect(best).toBeGreaterThan(200);
    expect(best).toBeLessThan(400);
    expect(arch.bearing ?? 0).toBe(0);
    // taller than the cliff the road is on: from up there the arch of the world shows through it
    expect(arch.rise).toBeGreaterThan(rt.bounds.maxY + 20);
    expect(size.height).toBeLessThan(90);
  });

  it('is rock all round an opening that is open', () => {
    const b = new RockBuf();
    emitArch(b, arch, def.seed ?? 1, 1);
    expect(b.idx.length / 3).toBeGreaterThan(2000);
    expect(b.idx.length / 3).toBeLessThan(9000);
    let top = -Infinity;
    for (let i = 0; i < b.n; i++) {
      const x = b.pos[i * 3];
      const y = b.pos[i * 3 + 1];
      const z = b.pos[i * 3 + 2];
      expect(Number.isFinite(x + y + z)).toBe(true);
      top = Math.max(top, y);
      // (bearing 0: the fin lies along x, the line of sight along z)
      const along = x - arch.x;
      const across = z - arch.z;
      expect(Math.abs(across)).toBeLessThan(size.thick / 2 + 8);
      expect(along).toBeGreaterThan(size.from - 1);
      expect(along).toBeLessThan(size.to + 1);
      // nothing in the middle of the opening between the sea and three quarters of its height
      if (Math.abs(along) < arch.span * 0.3) expect(y < -1 || y > arch.rise * 0.75, `vertex at ${along.toFixed(1)}, ${y.toFixed(1)}`).toBe(true);
      expect(archFootprint(arch, x, z, 6)).toBe(true);
    }
    expect(top).toBeGreaterThan(arch.rise + 8);
    expect(top).toBeLessThan(size.height + 8);
  });

  it('lay boulders in the shallows and on the shore, none on high ground', () => {
    let n = 0;
    def.boulders!.forEach((f, i) => {
      const list = placeBoulders(rt, f, 100 + i);
      n += list.length;
      for (const p of list) {
        expect(Math.hypot(p.x - f.x, p.z - f.z)).toBeLessThanOrEqual(f.r + 1e-6);
        const bed = rt.fieldHeight(p.x, p.z);
        expect(bed).toBeGreaterThanOrEqual(sea - 5);
        expect(bed).toBeLessThanOrEqual(sea + 3);
        // (awash or dry, never sunk out of sight)
        expect(p.y + p.size * 0.45).toBeGreaterThan(sea);
      }
    });
    expect(n).toBeGreaterThanOrEqual(12);
    const b = new RockBuf();
    emitBoulder(b, 0, 0, 0, 4, 7);
    expect(b.idx.length / 3).toBe(32);
    expect(b.n).toBe(18);
  });
});

describe('the bark', () => {
  it('is a tile that repeats: opaque, and no seam at its edges', () => {
    const px = barkPixels(64, 128);
    expect(px.color.length).toBe(64 * 128 * 4);
    let seam = 0;
    let inner = 0;
    for (let j = 0; j < 128; j++) {
      expect(px.color[(j * 64 + 5) * 4 + 3]).toBe(255);
      seam += Math.abs(px.color[(j * 64 + 63) * 4] - px.color[j * 64 * 4]);
      inner += Math.abs(px.color[(j * 64 + 31) * 4] - px.color[(j * 64 + 32) * 4]);
    }
    // the step across the edge is of the same kind as the step between any two neighbours
    expect(seam).toBeLessThan(inner * 2.5 + 128 * 4);
  });
});
