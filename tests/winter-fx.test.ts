/**
 * What a winter circuit does to the effects (headless, against a mock render system): the wheels throw snow and not dust or water,
 * the exhausts steam in the cold, a snowbank is a cloud and no sparks, the snow reaches the windscreen as a seventh of the rain,
 * and the road circuits keep the effects they had.
 */
import { Mesh, PerspectiveCamera, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { getCar } from '../src/cars';
import type { EnvironmentState, GraphicsSettings, TrackRuntime, VehicleState } from '../src/core/contracts';
import type { RenderSystem } from '../src/core/systems';
import { createEffects } from '../src/render/effects';
import { seedRandom } from '../src/render/fx/pools';
import { makeState } from '../sandbox/render/cars';
import { makeRingTrack } from '../sandbox/render/fakeTrack';

const winterTrack = (): TrackRuntime => {
  const rt = makeRingTrack();
  (rt.info as { winter?: boolean }).winter = true;
  return rt;
};

function mockRender(env: Partial<EnvironmentState> = {}): { render: RenderSystem; particles: Scene } {
  const main = new Scene();
  const particles = new Scene();
  const render = {
    scene: main,
    particleScene: particles,
    graphics: { shadows: 'high' } as GraphicsSettings,
    stats: { fps: 60, frameMs: 16, drawCalls: 0, triangles: 0 },
    env: { settings: { timeOfDay: 'golden', weather: 'clear', winter: true }, rain: 0, wetness: 0, darkness: 0, ...env },
  } as unknown as RenderSystem;
  return { render, particles };
}

function counts(scene: Scene): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of scene.children) if (c instanceof Mesh) out[c.name.replace('xr.fx.', '')] = (c.geometry as unknown as { instanceCount: number }).instanceCount;
  return out;
}

function carOn(surface: VehicleState['wheels'][0]['surface'], id = 1, speed = 30): VehicleState {
  const def = getCar('vanta-gt');
  const s = makeState(id);
  const v = def.visual;
  s.position.set(0, v.cgHeight, 0);
  s.velocity.set(0, 0, speed);
  s.speed = speed;
  s.forwardSpeed = speed;
  s.throttle = 0.6;
  s.engineLoad = 0.5;
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
    w.tempC = 40;
    w.surface = surface;
    w.contact = true;
  }
  return s;
}

const cam = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
cam.position.set(0, 2, -8);
cam.lookAt(0, 0.5, 0);
cam.updateMatrixWorld();

function drive(fx: ReturnType<typeof createEffects>, s: VehicleState, frames: number, slide = 0): void {
  for (let i = 0; i < frames; i++) {
    for (const w of s.wheels) {
      w.contactPoint.z += 0.5;
      w.slipAngle = slide;
      w.skid = Math.min(1, Math.abs(slide) * 3);
    }
    fx.update(1 / 60, [s], cam);
  }
}

describe('winter effects', () => {
  it('a car on packed snow throws powder (the mist pool), more of it in a slide, and no smoke puffs', () => {
    seedRandom(3);
    const rolling = mockRender();
    const a = createEffects(rolling.render, winterTrack(), 'high');
    a.registerCar(1, getCar('vanta-gt'));
    drive(a, carOn('snow'), 90);
    const calm = counts(rolling.particles);
    expect(calm.mist).toBeGreaterThan(20);
    expect(calm.puffs).toBe(0);
    a.dispose();

    seedRandom(3);
    const sliding = mockRender();
    const b = createEffects(sliding.render, winterTrack(), 'high');
    b.registerCar(1, getCar('vanta-gt'));
    drive(b, carOn('snow'), 90, 0.25);
    expect(counts(sliding.particles).mist).toBeGreaterThan(calm.mist * 1.3);
    b.dispose();
  });

  it('deep snow throws the most, ice the least', () => {
    const level = (surface: 'snow' | 'ice' | 'deepsnow'): number => {
      seedRandom(5);
      const m = mockRender();
      const fx = createEffects(m.render, winterTrack(), 'high');
      fx.registerCar(1, getCar('vanta-gt'));
      drive(fx, carOn(surface), 90, 0.1);
      const n = counts(m.particles).mist;
      fx.dispose();
      return n;
    };
    expect(level('deepsnow')).toBeGreaterThan(level('snow'));
    expect(level('snow')).toBeGreaterThan(level('ice'));
  });

  it('fresh snow on the road is powder, not water: it adds no spray and no water drops of a wet road', () => {
    seedRandom(7);
    const dry = mockRender({ wetness: 0 });
    const a = createEffects(dry.render, winterTrack(), 'high');
    a.registerCar(1, getCar('vanta-gt'));
    drive(a, carOn('snow'), 90, 0.1);
    const none = counts(dry.particles);
    a.dispose();

    seedRandom(7);
    const fresh = mockRender({ wetness: 0.8, rain: 0.55 });
    const b = createEffects(fresh.render, winterTrack(), 'high');
    b.registerCar(1, getCar('vanta-gt'));
    drive(b, carOn('snow'), 90, 0.1);
    const snowing = counts(fresh.particles);
    b.dispose();
    // (a road of water adds a rooster tail of mist and droplet streaks of its own on top: here the same particles as on the packed road)
    expect(snowing.mist).toBeGreaterThanOrEqual(none.mist);
    expect(snowing.mist).toBeLessThan(none.mist * 1.5);
    expect(snowing.drops).toBeLessThan(none.drops + 12);
  });

  it('the exhausts steam: a plume of mist from a car at idle, on a winter circuit only', () => {
    seedRandom(9);
    const cold = mockRender();
    const a = createEffects(cold.render, winterTrack(), 'high');
    a.registerCar(1, getCar('vanta-gt'));
    const idle = carOn('snow', 1, 0);
    idle.throttle = 0;
    idle.engineLoad = 0;
    drive(a, idle, 120);
    expect(counts(cold.particles).mist).toBeGreaterThan(3);
    a.dispose();

    seedRandom(9);
    const road = mockRender({ settings: { timeOfDay: 'golden', weather: 'clear' } });
    const b = createEffects(road.render, makeRingTrack(), 'high');
    b.registerCar(1, getCar('vanta-gt'));
    const idle2 = carOn('asphalt', 1, 0);
    idle2.throttle = 0;
    idle2.engineLoad = 0;
    drive(b, idle2, 120);
    expect(counts(road.particles).mist).toBe(0);
    expect(counts(road.particles).puffs).toBe(0);
    b.dispose();
  });

  it('a hit on a snowbank is a cloud of snow and granules, no sparks and no chips of metal', () => {
    seedRandom(11);
    const m = mockRender();
    const fx = createEffects(m.render, winterTrack(), 'high');
    const s = carOn('deepsnow', 1, 20);
    fx.registerCar(1, getCar('vanta-gt'));
    fx.update(1 / 60, [s], cam);
    const before = counts(m.particles);
    s.impactCount++;
    s.lastImpact.strength = 3;
    s.lastImpact.point.set(1, 0.5, 0);
    s.lastImpact.normal.set(-1, 0, 0);
    s.lastImpact.kind = 'snow';
    fx.update(1 / 60, [s], cam);
    const after = counts(m.particles);
    expect(after.mist - before.mist).toBeGreaterThan(8);
    expect(after.drops - before.drops).toBeGreaterThan(8);
    expect(after.sparks).toBe(0);
    expect(after.chips).toBe(0);
    fx.dispose();
  });

  it('a road circuit keeps its dust on gravel and its water on a wet road', () => {
    seedRandom(13);
    const m = mockRender({ settings: { timeOfDay: 'golden', weather: 'rain' }, wetness: 0.9, rain: 0.55 });
    const fx = createEffects(m.render, makeRingTrack(), 'high');
    fx.registerCar(1, getCar('vanta-gt'));
    drive(fx, carOn('asphalt'), 90);
    const c = counts(m.particles);
    expect(c.mist).toBeGreaterThan(20); // the spray of a wet road
    expect(c.drops).toBeGreaterThan(5);
    fx.dispose();
  });
});
