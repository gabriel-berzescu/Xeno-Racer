import { Mesh, PerspectiveCamera, Scene, ShaderMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { getCar } from '../src/cars';
import type { GraphicsSettings, VehicleState } from '../src/core/contracts';
import type { RenderSystem } from '../src/core/systems';
import { createEffects } from '../src/render/effects';
import { ContactShadows } from '../src/render/fx/contactShadow';
import { ChipPool, FlamePool, makePuffSpec, PuffPool, SparkPool, seedRandom } from '../src/render/fx/pools';
import { makeTrail, SkidMarks } from '../src/render/fx/skidmarks';
import { makeState } from '../sandbox/render/cars';
import { makeRingTrack } from '../sandbox/render/fakeTrack';

const mat = () => new ShaderMaterial();

describe('puff pool', () => {
  it('expires particles, reuses the ring and never exceeds its capacity', () => {
    seedRandom(7);
    const pool = new PuffPool(64, mat(), true);
    const sp = makePuffSpec();
    sp.life = 1;
    for (let i = 0; i < 100; i++) pool.spawn(sp);
    expect(pool.liveCount).toBe(64);
    pool.update(0.5, 0, 0);
    expect(pool.liveCount).toBe(64);
    pool.update(0.6, 0, 0);
    expect(pool.liveCount).toBe(0);
  });

  it('fills the instance buffers far to near and stays finite', () => {
    seedRandom(11);
    const pool = new PuffPool(200, mat(), true);
    const sp = makePuffSpec();
    sp.vx = sp.vy = sp.vz = 0;
    for (let i = 0; i < 150; i++) {
      sp.x = (Math.sin(i * 12.9) * 0.5) * 6;
      sp.y = 1;
      sp.z = 5 + ((i * 37) % 150); // depth along +z
      pool.spawn(sp);
    }
    pool.update(0.1, 0, 0);
    const n = pool.fill(0, 1, 0, 0, 0, 1);
    expect(n).toBe(150);
    const arr = pool.mesh.geometry.getAttribute('aA').array as Float32Array;
    expect(Array.from(arr.slice(0, n * 4)).every(Number.isFinite)).toBe(true);
    // depth (z) is non-increasing up to one sort bucket (150 m / 128 buckets)
    const bucket = 150 / 127 + 1e-3;
    for (let i = 1; i < n; i++) expect(arr[i * 4 + 2]).toBeLessThanOrEqual(arr[(i - 1) * 4 + 2] + bucket);
    expect((pool.mesh.geometry as unknown as { instanceCount: number }).instanceCount).toBe(n);
  });

  it('grows, rises and fades over its life', () => {
    const pool = new PuffPool(8, mat(), false);
    const sp = makePuffSpec();
    sp.x = sp.y = sp.z = 0;
    sp.vx = sp.vz = 0;
    sp.vy = 0.5;
    sp.r0 = 0.3;
    sp.r1 = 2;
    sp.life = 2;
    sp.alpha = 0.5;
    pool.spawn(sp);
    const read = () => {
      pool.fill(0, 0, -10, 0, 0, 1);
      const A = pool.mesh.geometry.getAttribute('aA').array as Float32Array;
      const B = pool.mesh.geometry.getAttribute('aB').array as Float32Array;
      return { r: A[3], y: A[1], alpha: B[1], age: B[2] };
    };
    pool.update(0.05, 0, 0);
    const early = read();
    pool.update(0.9, 0, 0);
    const mid = read();
    pool.update(0.9, 0, 0);
    const late = read();
    expect(mid.r).toBeGreaterThan(early.r);
    expect(late.r).toBeGreaterThan(mid.r);
    expect(mid.y).toBeGreaterThan(early.y);
    expect(early.alpha).toBeLessThan(mid.alpha);
    expect(late.alpha).toBeLessThan(mid.alpha);
    expect(late.age).toBeGreaterThan(mid.age);
  });
});

describe('spark, flame and chip pools', () => {
  it('sparks bounce off the ground plane and die', () => {
    const pool = new SparkPool(32, mat());
    pool.spawn(0, 0.6, 0, 3, -2, 0, 1.5, 0.02, 10, 0);
    let minY = 1e9;
    for (let i = 0; i < 100; i++) {
      pool.update(1 / 60);
      pool.fill();
      minY = Math.min(minY, (pool.mesh.geometry.getAttribute('aP').array as Float32Array)[1]);
    }
    expect(minY).toBeGreaterThanOrEqual(0);
    expect(pool.liveCount).toBe(0);
  });

  it('flames ride along with the car and expire quickly', () => {
    const pool = new FlamePool(8, mat());
    pool.spawn(0, 1, 0, 0, 0, -1, 1, 0.1, 0.12, 8, 1, 0, 0, 30);
    pool.update(0.05);
    pool.fill();
    expect((pool.mesh.geometry.getAttribute('aP').array as Float32Array)[2]).toBeCloseTo(1.5, 3);
    pool.update(0.2);
    expect(pool.liveCount).toBe(0);
  });

  it('chips settle on the ground', () => {
    const pool = new ChipPool(16, mat());
    pool.spawn(0, 0.5, 0, 1, 2, 0, 3, 0.03, 0.5, 0.5, 0.5, 0);
    for (let i = 0; i < 120; i++) pool.update(1 / 60);
    pool.fill();
    expect((pool.mesh.geometry.getAttribute('aA').array as Float32Array)[1]).toBeGreaterThanOrEqual(0);
  });
});

describe('skidmarks', () => {
  const N = new Vector3(0, 1, 0);

  it('joins consecutive segments into a gap-free ribbon that fades in', () => {
    const sm = new SkidMarks(100);
    const t = makeTrail();
    sm.beginFrame();
    for (let i = 0; i < 12; i++) sm.addPoint(t, 0, 0, i * 0.5, N.x, N.y, N.z, 0.3, 0, 0, 0, 0.8);
    sm.endFrame();
    expect(sm.segments).toBe(11); // the first point only starts the trail
    const P = sm.mesh.geometry.getAttribute('position').array as Float32Array;
    const C = sm.mesh.geometry.getAttribute('color').array as Float32Array;
    // segment k's start edge equals segment k-1's end edge
    for (let s = 1; s < sm.segments; s++) {
      for (let c = 0; c < 6; c++) expect(P[s * 12 + c]).toBeCloseTo(P[(s - 1) * 12 + 6 + c], 5);
    }
    // alpha ramps in from zero on the first segment and then holds
    expect(C[3]).toBe(0);
    expect(C[11]).toBeCloseTo(0.8, 5);
    expect(C[16 + 3]).toBeCloseTo(0.8, 5);
    // ribbon width and lift
    expect(Math.abs(P[0] - P[3])).toBeCloseTo(0.3, 5);
    expect(P[1]).toBeGreaterThan(0);
    expect(P[1]).toBeLessThan(0.05);
  });

  it('restarts the trail after a teleport instead of drawing a streak', () => {
    const sm = new SkidMarks(100);
    const t = makeTrail();
    sm.beginFrame();
    sm.addPoint(t, 0, 0, 0, 0, 1, 0, 0.3, 0, 0, 0, 1);
    sm.addPoint(t, 0, 0, 1, 0, 1, 0, 0.3, 0, 0, 0, 1);
    sm.addPoint(t, 0, 0, 500, 0, 1, 0, 0.3, 0, 0, 0, 1); // jump
    sm.addPoint(t, 0, 0, 501, 0, 1, 0, 0.3, 0, 0, 0, 1);
    sm.endFrame();
    expect(sm.segments).toBe(2);
    const P = sm.mesh.geometry.getAttribute('position').array as Float32Array;
    // second segment starts at the new location, not at z = 1
    expect(P[12 + 2]).toBeGreaterThan(400);
  });

  it('recycles the oldest segments (ring buffer) and only uploads what changed', () => {
    const sm = new SkidMarks(10);
    const t = makeTrail();
    for (let frame = 0; frame < 6; frame++) {
      sm.beginFrame();
      for (let i = 0; i < 4; i++) sm.addPoint(t, 0, 0, frame * 2 + i * 0.5, 0, 1, 0, 0.3, 0, 0, 0, 1);
      sm.endFrame();
    }
    expect(sm.segments).toBe(10);
    const pos = sm.mesh.geometry.getAttribute('position') as unknown as { updateRanges: { start: number; count: number }[] };
    expect(pos.updateRanges.length).toBeGreaterThan(0);
    const total = pos.updateRanges.reduce((a: number, r: { start: number; count: number }) => a + r.count, 0);
    expect(total).toBeLessThanOrEqual(10 * 12);
    sm.clear();
    expect(sm.segments).toBe(0);
  });

  it('ends a trail cleanly and starts a new one', () => {
    const sm = new SkidMarks(20);
    const t = makeTrail();
    sm.beginFrame();
    sm.addPoint(t, 0, 0, 0, 0, 1, 0, 0.3, 0, 0, 0, 1);
    sm.addPoint(t, 0, 0, 1, 0, 1, 0, 0.3, 0, 0, 0, 1);
    sm.endTrail(t);
    expect(t.active).toBe(false);
    sm.addPoint(t, 5, 0, 0, 0, 1, 0, 0.3, 0, 0, 0, 1);
    sm.addPoint(t, 5, 0, 1, 0, 1, 0, 0.3, 0, 0, 0, 1);
    sm.endFrame();
    expect(sm.segments).toBe(2);
  });
});

describe('contact shadows', () => {
  it('hands out slots and hides released cars', () => {
    const cs = new ContactShadows(4);
    const a = cs.slotFor(10);
    const b = cs.slotFor(11);
    expect(a).not.toBe(b);
    expect(cs.slotFor(10)).toBe(a);
    cs.release(10);
    const op = cs.mesh.geometry.getAttribute('aOpacity').array as Float32Array;
    for (let k = 0; k < 5; k++) expect(op[a * 5 + k]).toBe(0);
  });
});

// ── the whole effects system against a mock render system ─────────────────────────────────────

function mockRender(): { render: RenderSystem; main: Scene; particles: Scene } {
  const main = new Scene();
  const particles = new Scene();
  const render = {
    scene: main,
    particleScene: particles,
    graphics: { shadows: 'high' } as GraphicsSettings,
    stats: { fps: 60, frameMs: 16, drawCalls: 0, triangles: 0 },
  } as unknown as RenderSystem;
  return { render, main, particles };
}

function instanceCounts(scene: Scene): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of scene.children) {
    if (c instanceof Mesh) out[c.name.replace('xr.fx.', '')] = (c.geometry as unknown as { instanceCount: number }).instanceCount;
  }
  return out;
}

function stateOnAsphalt(id: number, def = getCar('vanta-gt')): VehicleState {
  const s = makeState(id);
  const v = def.visual;
  s.position.set(0, v.cgHeight, 0);
  s.velocity.set(0, 0, 30);
  s.speed = 30;
  s.forwardSpeed = 30;
  const half = v.wheelbase / 2;
  const pos = [
    [v.trackFront / 2, half],
    [-v.trackFront / 2, half],
    [v.trackRear / 2, -half],
    [-v.trackRear / 2, -half],
  ];
  for (let i = 0; i < 4; i++) {
    const w = s.wheels[i];
    w.contactPoint.set(pos[i][0], 0, pos[i][1]);
    w.radius = 0.34;
    w.width = 0.28;
    w.tempC = 90;
  }
  return s;
}

describe('createEffects', () => {
  const cam = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  cam.position.set(0, 2, -8);
  cam.lookAt(0, 0.5, 0);
  cam.updateMatrixWorld();

  it('emits tyre smoke and skidmarks only while tyres slide on hard ground', () => {
    seedRandom(5);
    const { render, main, particles } = mockRender();
    const fx = createEffects(render, makeRingTrack(), 'high');
    const s = stateOnAsphalt(1);
    fx.registerCar(1, getCar('vanta-gt'));
    // rolling, no slip: nothing
    for (let i = 0; i < 30; i++) {
      for (const w of s.wheels) {
        w.skid = 0;
        w.contactPoint.z += 0.5;
      }
      fx.update(1 / 60, [s], cam);
    }
    expect(instanceCounts(particles).puffs).toBe(0);
    const skid = main.children.find((c) => c.name === 'xr.fx.skidmarks') as Mesh;
    expect(skid.geometry.drawRange.count).toBe(0);
    // rear wheels slide hard
    for (let i = 0; i < 90; i++) {
      s.wheels[2].skid = s.wheels[3].skid = 1;
      for (const w of s.wheels) w.contactPoint.z += 0.5;
      fx.update(1 / 60, [s], cam);
    }
    expect(instanceCounts(particles).puffs).toBeGreaterThan(40);
    expect(skid.geometry.drawRange.count).toBeGreaterThan(6 * 50);
    // marks persist after the slide ends; smoke dies out
    for (let i = 0; i < 400; i++) {
      s.wheels[2].skid = s.wheels[3].skid = 0;
      for (const w of s.wheels) w.contactPoint.z += 0.5;
      fx.update(1 / 60, [s], cam);
    }
    expect(instanceCounts(particles).puffs).toBe(0);
    expect(skid.geometry.drawRange.count).toBeGreaterThan(6 * 50);
    fx.dispose();
    expect(main.children.some((c) => c.name.startsWith('xr.fx'))).toBe(false);
    expect(particles.children.length).toBe(0);
  });

  it('kicks up dust on gravel and draws a faint track', () => {
    const { render, main, particles } = mockRender();
    const fx = createEffects(render, makeRingTrack(), 'high');
    const s = stateOnAsphalt(2);
    for (const w of s.wheels) w.surface = 'gravel';
    fx.registerCar(2, getCar('kestrel-r'));
    for (let i = 0; i < 90; i++) {
      for (const w of s.wheels) w.contactPoint.z += 0.5;
      fx.update(1 / 60, [s], cam);
    }
    const counts = instanceCounts(particles);
    expect(counts.puffs).toBeGreaterThan(10);
    expect(counts.chips).toBeGreaterThan(0);
    const skid = main.children.find((c) => c.name === 'xr.fx.skidmarks') as Mesh;
    expect(skid.geometry.drawRange.count).toBeGreaterThan(0);
    fx.dispose();
  });

  it('sparks on scrape, bursts on impact, flames on backfire', () => {
    seedRandom(9);
    const { render, particles } = mockRender();
    const fx = createEffects(render, makeRingTrack(), 'ultra');
    const s = stateOnAsphalt(3, getCar('lmp-x'));
    fx.registerCar(3, getCar('lmp-x'));
    fx.update(1 / 60, [s], cam); // first frame latches counters
    expect(instanceCounts(particles).sparks).toBe(0);
    s.scrape = 0.9;
    s.scrapePoint.set(0.9, 0.3, 0);
    for (let i = 0; i < 30; i++) fx.update(1 / 60, [s], cam);
    expect(instanceCounts(particles).sparks).toBeGreaterThan(20);
    expect(instanceCounts(particles).glows).toBeGreaterThan(0); // hot flare at the scrape point
    s.scrape = 0;
    for (let i = 0; i < 200; i++) fx.update(1 / 60, [s], cam);
    expect(instanceCounts(particles).sparks).toBe(0);

    s.impactCount++;
    s.lastImpact.strength = 1;
    s.lastImpact.point.set(1, 0.5, 0);
    s.lastImpact.normal.set(-1, 0, 0);
    s.lastImpact.kind = 'wall';
    fx.update(1 / 60, [s], cam);
    const burst = instanceCounts(particles);
    expect(burst.sparks).toBeGreaterThan(50);
    expect(burst.chips).toBeGreaterThan(10);
    expect(burst.puffs).toBeGreaterThan(2);

    for (let i = 0; i < 300; i++) fx.update(1 / 60, [s], cam);
    expect(instanceCounts(particles).sparks).toBe(0);
    // three backfires: the first tip always flames, a second one most times (now and then it stays dark)
    for (let k = 0; k < 3; k++) {
      s.backfireCount++;
      fx.update(1 / 60, [s], cam);
    }
    const bang = instanceCounts(particles);
    expect(bang.flames).toBeGreaterThanOrEqual(4);
    expect(bang.glows).toBeGreaterThanOrEqual(4); // and a round flash per flame
    expect(bang.sparks).toBe(0); // a flame, not sparks: those read as the car grinding on something
    fx.dispose();
  });

  it('survives resets, unknown cars, zero and huge dt and clear()', () => {
    const { render, particles } = mockRender();
    const fx = createEffects(render, makeRingTrack(), 'low');
    const s = stateOnAsphalt(4);
    s.wheels[2].skid = 1;
    fx.registerCar(4, getCar('ronin-86'));
    const stranger = stateOnAsphalt(99);
    expect(() => {
      fx.update(0, [s], cam);
      fx.update(5, [s, stranger], cam);
      fx.update(1 / 144, [s], cam);
      fx.unregisterCar(4);
      fx.update(1 / 60, [s], cam);
      fx.clear();
    }).not.toThrow();
    expect(instanceCounts(particles).puffs).toBe(0);
    fx.dispose();
  });

  it('never produces NaN even for an airborne, rotated, fast car', () => {
    const { render, particles } = mockRender();
    const fx = createEffects(render, makeRingTrack(), 'high');
    const s = stateOnAsphalt(5);
    fx.registerCar(5, getCar('vanta-gt'));
    s.airborne = true;
    for (const w of s.wheels) {
      w.contact = false;
      w.skid = 1;
    }
    s.quaternion.set(0.5, 0.5, 0.5, 0.5);
    s.speed = 400;
    s.velocity.set(300, 100, -250);
    for (let i = 0; i < 60; i++) fx.update(1 / 60, [s], cam);
    const puffs = particles.children[0] as Mesh;
    const arr = puffs.geometry.getAttribute('aA').array as Float32Array;
    expect(Array.from(arr).every(Number.isFinite)).toBe(true);
    fx.dispose();
  });
});
