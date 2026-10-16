/** Crash damage on the car: the mesh-derived geometry, the uniform tables and the shader that must never change with them. */
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import { BLUEPRINTS } from '../src/carvis/bodies';
import { buildBody, type BodyData } from '../src/carvis/build';
import { DAMAGE_BAND, bodySurfacePoint, findGlass, findLamps, glassPointsOf, makeDamageGeometry, partBounds } from '../src/carvis/damageGeometry';
import { DMG_FRAG_PAINT, DMG_FRAG_PARS, DMG_VERT_NORMAL, DMG_VERT_PARS } from '../src/carvis/damageShader';
import { DENT_SETTLE_S, lampOutput, packDamage, settleDentDepth } from '../src/carvis/damageUniforms';
import { createBodyMaterials, createBodyUniforms } from '../src/carvis/materials';
import { BODY_FRAG_NORMAL, BODY_FRAG_ZONES, BODY_VERT_BEGIN, BODY_VERT_PARS } from '../src/carvis/shaders';
import { makeInterior } from '../src/carvis/interior';
import { CarDamage, MAX_CRACKS, MAX_DENTS, MAX_MARKS, hullOf, hullSurfaceDistance, type HitEvent, type V3 } from '../src/core/damage';

const bodies = new Map<string, BodyData>();
function body(id: string): BodyData {
  let b = bodies.get(id);
  if (!b) {
    const spec = CARS.find((c) => c.id === id)!.visual;
    b = buildBody(BLUEPRINTS[spec.style](spec), spec, { cell: 0.05, parts: true });
    bodies.set(id, b);
  }
  return b;
}

describe('damage geometry read off the sculpted body', () => {
  for (const def of CARS) {
    const spec = def.visual;
    const hull = hullOf(spec);

    it(`${def.id}: finds the four lamps, mirrored, on the nose and the tail`, () => {
      const b = body(def.id);
      const lamps = findLamps(b.vertices, b.stats.bodyVertices, spec);
      expect(lamps.length).toBe(4);
      const [hl, hr, tl, tr] = lamps;
      expect(hl.c[0]).toBeGreaterThan(0.3);
      expect(hr.c[0]).toBeLessThan(-0.3);
      expect(hl.c[0] + hr.c[0]).toBeCloseTo(0, 1);
      expect(tl.c[0]).toBeGreaterThan(0.2);
      expect(tr.c[0]).toBeLessThan(-0.2);
      // the headlights sit in the front quarter of the car, the tail lights in the rear quarter, above the bumper
      const zMid = (hull.front + hull.rear) / 2;
      const half = (hull.front - hull.rear) / 2;
      for (const l of [hl, hr]) expect((l.c[2] - zMid) / half).toBeGreaterThan(0.55);
      for (const l of [tl, tr]) expect((l.c[2] - zMid) / half).toBeLessThan(-0.55);
      for (const l of lamps) {
        expect(l.c[1]).toBeGreaterThan(0.3);
        expect(l.c[1]).toBeLessThan(spec.height * 0.9);
        expect(l.r).toBeGreaterThan(0.05);
        expect(l.r).toBeLessThan(0.6);
      }
    });

    it(`${def.id}: a barrier on the left touches the sculpted body where the surface faces it`, () => {
      const b = body(def.id);
      const n = b.stats.bodyVertices;
      const band: [number, number] = [DAMAGE_BAND[0] * spec.height, DAMAGE_BAND[1] * spec.height];
      for (const a of [20, 50, 85].map((d) => (d * Math.PI) / 180)) {
        const push: V3 = [-Math.cos(a), 0, -Math.sin(a)]; // from the barrier into the car
        const c = bodySurfacePoint(b.vertices, n, [hull.hw, hull.top, hull.front], push, band);
        // on the body, inside the collision box, in the damage band, towards the front left
        expect(c[0]).toBeGreaterThan(0.3 * hull.hw);
        expect(c[2]).toBeGreaterThan(hull.front * 0.35);
        expect(c[1]).toBeGreaterThanOrEqual(band[0] - 1e-6);
        expect(c[1]).toBeLessThanOrEqual(band[1] + 1e-6);
        expect(hullSurfaceDistance(c, hull)).toBeLessThan(0.4);
        // and nothing in reach of the contact sticks out further against the barrier
        const reach2 = 0.6 * 0.6;
        let best = -Infinity;
        for (let i = 0; i < n; i++) {
          const o = i * 22;
          const y = b.vertices[o + 1];
          if (y < band[0] || y > band[1]) continue;
          if ((b.vertices[o] - hull.hw) ** 2 + (b.vertices[o + 2] - hull.front) ** 2 > reach2) continue;
          best = Math.max(best, -(b.vertices[o] * push[0] + y * push[1] + b.vertices[o + 2] * push[2]));
        }
        expect(-(c[0] * push[0] + c[1] * push[1] + c[2] * push[2])).toBeGreaterThan(best - 0.036);
      }
    });

    it(`${def.id}: a corner hit dents the corner and breaks the lamp beside it, not the far one`, () => {
      const b = body(def.id);
      const d = new CarDamage(hull, makeDamageGeometry(b, spec));
      const ev: HitEvent = { type: 'hit', kind: 'car', strength: 14, p: [hull.hw, hull.top, hull.front], n: [0, 0, -1], slide: [0, 0, 5] };
      d.apply(ev);
      expect(d.dents.length).toBe(1);
      const c = d.dents[0].c;
      expect(c[0]).toBeGreaterThan(0.3 * hull.hw);
      expect(c[2]).toBeGreaterThan(hull.front - 0.9);
      expect(d.lamps[0].out).toBe(0); // the front left lamp
      expect(d.lamps[1].out).toBe(1);
      expect(d.lamps[2].out).toBe(1);
      expect(d.lamps[3].out).toBe(1);
    });

    it(`${def.id}: finds the glass, the windscreen ahead of the rear glass and a side window each side`, () => {
      const b = body(def.id);
      const g = findGlass(b.vertices, b.stats.bodyVertices);
      for (const k of ['front', 'rear', 'left', 'right'] as const) expect(g[k].pts.length, k).toBeGreaterThan(0);
      const meanZ = (pts: number[]): number => {
        let z = 0;
        for (let i = 0; i < pts.length; i += 6) z += pts[i + 2];
        return z / (pts.length / 6);
      };
      expect(meanZ(g.front.pts)).toBeGreaterThan(meanZ(g.rear.pts) + 0.3);
      expect(g.left.min[0]).toBeGreaterThan(0);
      expect(g.right.max[0]).toBeLessThan(0);
      // glass sits up in the cabin, inside the body's width, never down at the bumper
      for (const k of ['front', 'rear', 'left', 'right'] as const) {
        expect(g[k].min[1], k).toBeGreaterThan(0.5 * spec.height);
        expect(g[k].max[1], k).toBeLessThanOrEqual(spec.height);
        expect(Math.max(g[k].max[0], -g[k].min[0]), k).toBeLessThan(hull.hw);
      }
    });

    it(`${def.id}: a hit shakes the glass it points at and no other`, () => {
      const b = body(def.id);
      const g = findGlass(b.vertices, b.stats.bodyVertices);
      const mid = (hull.front + hull.rear) / 2;
      // from the front: the windscreen, on the side the hit came in, low down
      const front = glassPointsOf(g, [0.5, hull.top, hull.front], [0, 0, -1]);
      expect(front.map((s) => s.id)).toEqual([0]);
      expect(front[0].c[1]).toBeLessThan(g.front.min[1] + 0.6 * (g.front.max[1] - g.front.min[1]));
      expect(front[0].c[0]).toBeGreaterThan(-0.2);
      expect(front[0].n[1]).toBeGreaterThan(0);
      // from behind, the rear glass; beside the cabin, the glass of that side
      expect(glassPointsOf(g, [0, hull.top, hull.rear], [0, 0, 1]).map((s) => s.id)).toEqual([1]);
      const left = glassPointsOf(g, [hull.hw, 0.6, (g.left.min[2] + g.left.max[2]) / 2], [-1, 0, 0]);
      expect(left.map((s) => s.id)).toEqual([2]);
      expect(left[0].c[0]).toBeGreaterThan(0.3);
      expect(left[0].c[2]).toBeGreaterThanOrEqual(g.left.min[2]);
      expect(left[0].c[2]).toBeLessThanOrEqual(g.left.max[2]);
      expect(glassPointsOf(g, [-hull.hw, 0.6, (g.right.min[2] + g.right.max[2]) / 2], [1, 0, 0]).map((s) => s.id)).toEqual([3]);
      // a scrape at the nose pushes sideways far ahead of the cabin: nothing to crack
      expect(glassPointsOf(g, [hull.hw, hull.top, hull.front], [-0.95, 0, -0.3])).toEqual([]);
      // and the model turns it into a star of cracks on the glass, remembered where
      const d = new CarDamage(hull, makeDamageGeometry(b, spec));
      d.apply({ type: 'hit', kind: 'wall', strength: 14, p: [0, hull.top, hull.front], n: [0, 0, -1], slide: [0, 0, 4] });
      expect(d.cracks.map((c) => c.id)).toEqual([0]);
      expect(d.lastHit?.glass).toEqual(d.cracks[0].c);
      expect(mid).toBeLessThan(hull.front);
    });
  }

  it('measures the interior as a box the crushed sheet must not enter', () => {
    for (const def of CARS) {
      const [lo, hi] = partBounds(makeInterior(def.visual, 'low').cabin.vertices);
      const hull = hullOf(def.visual);
      expect(hi[0] - lo[0]).toBeGreaterThan(0.8);
      expect(hi[0]).toBeLessThan(hull.hw - 0.05); // inside the body's width
      expect(lo[0]).toBeGreaterThan(-hull.hw + 0.05);
      expect(hi[1]).toBeLessThan(def.visual.height);
    }
  });
});

describe('uniform tables', () => {
  const hull = hullOf(CARS[0].visual);
  const geom = { surfacePoint: (p: V3): V3 => [p[0], 0.5, p[2]], lamps: [{ c: [0.6, 0.65, 2.2] as V3, r: 0.2 }, { c: [-0.6, 0.65, 2.2] as V3, r: 0.2 }, { c: [0.5, 0.8, -2.2] as V3, r: 0.2 }, { c: [-0.5, 0.8, -2.2] as V3, r: 0.2 }] };
  const hit = (s: number, p: V3, n: V3, kind: 'wall' | 'car' = 'car', paint?: number): HitEvent => ({ type: 'hit', kind, strength: s, p, n, slide: [0.4, 0, 3], paint });

  it('is pristine until something happens, and mode off draws a hit car as pristine too', () => {
    const U = createBodyUniforms();
    const d = new CarDamage(hull, geom);
    packDamage(d, 'visual', U, 0);
    expect(U.uDentN.value).toBe(0);
    expect(U.uMarkN.value).toBe(0);
    expect(U.uLampOut.value.toArray()).toEqual([1, 1, 1, 1]);
    d.apply(hit(12, [0.6, 0.6, hull.front], [0, 0, -1], 'car', 0x2a62d0));
    packDamage(d, 'visual', U, 0);
    expect(U.uDentN.value).toBe(1);
    expect(U.uMarkN.value).toBe(3);
    expect(U.uLampOut.value.x).toBe(0);
    packDamage(d, 'off', U, 0);
    expect(U.uDentN.value).toBe(0);
    expect(U.uMarkN.value).toBe(0);
    expect(U.uLampOut.value.toArray()).toEqual([1, 1, 1, 1]);
    expect(U.uLampCrk.value.toArray()).toEqual([0, 0, 0, 0]);
  });

  it('lays each dent and mark out as three vec4s the shader reads', () => {
    const U = createBodyUniforms();
    const d = new CarDamage(hull, geom);
    d.apply(hit(10, [0.9, 0.6, hull.front], [0, 0, -1], 'car', 0x112233));
    packDamage(d, 'visual', U, 0);
    const dent = d.dents[0];
    const a = U.uDent.value;
    expect([a[0], a[1], a[2]]).toEqual(dent.c.map(Math.fround));
    expect(a[3]).toBeCloseTo(dent.r, 6);
    expect([a[4], a[5], a[6]]).toEqual(dent.d.map(Math.fround));
    expect(a[7]).toBeCloseTo(dent.depth, 6);
    expect([a[8], a[9], a[10]]).toEqual(dent.t.map(Math.fround));
    expect(a[11]).toBeCloseTo(dent.e, 6);
    const transfer = d.marks.findIndex((m) => m.kind === 3);
    const m = U.uMark.value;
    expect(m[transfer * 12 + 9]).toBe(3);
    expect(m[transfer * 12 + 10]).toBe(0x112233); // the other car's paint, exact in a float
    expect(U.uDent.value.length).toBe(MAX_DENTS * 12);
    expect(U.uMark.value.length).toBe(MAX_MARKS * 12);
  });

  it('lays each crack of the glass out as two vec4s, and draws a car in mode off without them', () => {
    const U = createBodyUniforms();
    const d = new CarDamage(hull, { ...geom, glassPoints: () => [{ id: 0, c: [0.1, 1.0, 0.2], n: [0, 0.5, 0.866] }] });
    expect(U.uCrack.value.length).toBe(MAX_CRACKS * 8);
    d.apply(hit(12, [0.3, 0.6, hull.front], [0, 0, -1], 'wall'));
    packDamage(d, 'visual', U, 0);
    expect(U.uCrackN.value).toBe(1);
    const k = d.cracks[0];
    const a = U.uCrack.value;
    expect([a[0], a[1], a[2]]).toEqual(k.c.map(Math.fround));
    expect(a[3]).toBeCloseTo(k.r, 6);
    expect([a[4], a[5], a[6]]).toEqual(k.n.map(Math.fround));
    expect(a[7]).toBeCloseTo(k.seed, 6);
    packDamage(d, 'off', U, 0);
    expect(U.uCrackN.value).toBe(0);
  });

  it('flickers a cracked lamp in irregular bursts and keeps a broken one dark and a good one lit', () => {
    const d = new CarDamage(hull, geom);
    d.apply(hit(6.5, [0.6, 0.65, hull.front], [0, 0, -1]));
    const cracked = d.lamps[0];
    expect(cracked.out).toBe(0.5);
    let on = 0;
    let off = 0;
    for (let t = 0; t < 20; t += 0.05) (lampOutput(cracked, 0, t) > 0.5 ? on++ : off++);
    expect(on).toBeGreaterThan(40);
    expect(off).toBeGreaterThan(10);
    expect(lampOutput({ out: 0, crack: 1, hit: [0, 0, 0] }, 0, 3)).toBe(0);
    expect(lampOutput({ out: 1, crack: 0, hit: [0, 0, 0] }, 0, 3)).toBe(1);
    // deterministic: the same instant gives the same answer
    expect(lampOutput(cracked, 0, 7.31)).toBe(lampOutput(cracked, 0, 7.31));
  });

  it('settles a fresh dent over a few frames and lands at once without time', () => {
    const d = new CarDamage(hull, geom);
    d.apply(hit(12, [0.6, 0.6, hull.front], [0, 0, -1]));
    const target = d.dents[0].depth;
    const shown = new Float32Array(MAX_DENTS);
    expect(settleDentDepth(d, shown, 1 / 60)).toBe(true);
    const first = shown[0];
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(target * 0.5);
    let frames = 1;
    while (settleDentDepth(d, shown, 1 / 60) && frames < 60) frames++;
    expect(shown[0]).toBeCloseTo(target, 3);
    expect(frames * (1 / 60)).toBeGreaterThan(DENT_SETTLE_S * 2);
    expect(frames * (1 / 60)).toBeLessThan(0.5);
    // no time (a warm-up frame): there at once
    const snap = new Float32Array(MAX_DENTS);
    expect(settleDentDepth(d, snap, 0)).toBe(true);
    expect(snap[0]).toBeCloseTo(target, 6);
    // a repaired car loses its dents at once
    d.reset();
    settleDentDepth(d, shown, 1 / 60);
    expect(shown[0]).toBe(0);
  });
});

describe('the body shader never changes with the damage', () => {
  it('has the damage code always in the program: no define toggles it, and a hit car compiles the same source', () => {
    for (const src of [DMG_VERT_PARS, DMG_VERT_NORMAL, DMG_FRAG_PARS, DMG_FRAG_PAINT]) {
      expect(src).not.toMatch(/#\s*(if|ifdef|ifndef|elif)\b[^\n]*(DMG|DAMAGE)/);
      expect(src).not.toMatch(/#\s*define\s+(DAMAGED|DMG_ON|DAMAGE)/);
    }
    const shaderOf = (U: ReturnType<typeof createBodyUniforms>, glass: boolean): { vertexShader: string; fragmentShader: string; key: string } => {
      const { paint, glass: gl } = createBodyMaterials(U);
      const m = glass ? gl : paint;
      const shader = {
        uniforms: {} as Record<string, unknown>,
        vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
        fragmentShader: '#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <normal_fragment_maps>\n#include <emissivemap_fragment>\n#include <lights_physical_fragment>\n#include <aomap_fragment>\n#include <opaque_fragment>',
      };
      m.onBeforeCompile(shader as never, null as never);
      return { vertexShader: shader.vertexShader, fragmentShader: shader.fragmentShader, key: m.customProgramCacheKey() };
    };
    const hull = hullOf(CARS[0].visual);
    const dmg = new CarDamage(hull, { surfacePoint: (p) => [p[0], 0.5, p[2]], lamps: [{ c: [0.6, 0.65, 2.2], r: 0.2 }, { c: [-0.6, 0.65, 2.2], r: 0.2 }, { c: [0.5, 0.8, -2.2], r: 0.2 }, { c: [-0.5, 0.8, -2.2], r: 0.2 }] });
    dmg.apply({ type: 'hit', kind: 'wall', strength: 25, p: [hull.hw, 0.6, hull.front], n: [-0.7, 0, -0.7], slide: [0, 0, 20] });
    for (const glass of [false, true]) {
      const pristine = createBodyUniforms();
      const hit = createBodyUniforms();
      packDamage(dmg, 'visual', hit, 1);
      expect(hit.uDentN.value).toBeGreaterThan(0);
      const a = shaderOf(pristine, glass);
      const b = shaderOf(hit, glass);
      expect(b.vertexShader).toBe(a.vertexShader);
      expect(b.fragmentShader).toBe(a.fragmentShader);
      expect(b.key).toBe(a.key);
    }
    // the paint and the glass are two programs, as before, and every car shares them
    const one = createBodyMaterials();
    const two = createBodyMaterials();
    expect(one.paint.customProgramCacheKey()).toBe(two.paint.customProgramCacheKey());
    expect(one.glass.customProgramCacheKey()).not.toBe(one.paint.customProgramCacheKey());
  });

  it('declares the tables at the sizes the model fills, in both stages, and uses them in the body shader', () => {
    for (const src of [DMG_VERT_PARS, DMG_FRAG_PARS]) {
      expect(src).toContain(`#define DMG_DENTS ${MAX_DENTS}`);
      expect(src).toMatch(/uniform vec4 uDent\[ DMG_DENTS \* 3 \];/);
      expect(src).toMatch(/uniform float uDentN;/);
    }
    expect(DMG_FRAG_PARS).toContain(`#define DMG_CRACKS ${MAX_CRACKS}`);
    expect(DMG_FRAG_PARS).toMatch(/uniform vec4 uCrack\[ DMG_CRACKS \* 2 \];/);
    expect(DMG_FRAG_PAINT).toMatch(/#ifdef GLASS_PASS[\s\S]*glassCracks\(/);
    expect(DMG_FRAG_PARS).toContain(`#define DMG_MARKS ${MAX_MARKS}`);
    expect(DMG_FRAG_PARS).toMatch(/uniform vec4 uMark\[ DMG_MARKS \* 3 \];/);
    expect(BODY_VERT_PARS).toContain('dentDisp');
    expect(BODY_VERT_BEGIN).toContain('transformed = dmgPos;');
    expect(BODY_FRAG_ZONES).toContain('lensDamage');
    expect(BODY_FRAG_ZONES).toContain('uLampOut');
    expect(BODY_FRAG_NORMAL).toContain('dmgRelief');
    // every lamp's emission is scaled by its output
    expect(BODY_FRAG_ZONES).toMatch(/\* hOut;/);
    expect(BODY_FRAG_ZONES).toMatch(/\* tOut;/);
  });

  it('keeps every loop over a table bounded by the same constants as the model', () => {
    for (const src of [DMG_VERT_PARS, DMG_FRAG_PARS]) {
      const loops = src.match(/for \(int i = 0; i < DMG_(DENTS|MARKS); i\+\+\)/g) ?? [];
      expect(loops.length).toBeGreaterThan(0);
    }
    expect(MAX_DENTS * 3).toBeLessThanOrEqual(64);
    expect(MAX_MARKS * 3).toBeLessThanOrEqual(64);
  });

  it('never takes pow() of an unclamped (1.0 - x), or the log of something that can reach zero', () => {
    for (const src of [DMG_VERT_PARS, DMG_FRAG_PARS, DMG_FRAG_PAINT]) {
      for (const bad of src.match(/pow\(\s*1\.0\s*-\s*[^,]+,/g) ?? []) expect(/clamp\(|max\(|saturate\(/.test(bad), bad).toBe(true);
      // every log is of a positive quantity (radius + 1)
      for (const m of src.matchAll(/log2\(([^)]*)\)/g)) expect(m[1], m[0]).toMatch(/\+ 1\.0$/);
    }
  });
});
