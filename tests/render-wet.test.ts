import { readFileSync } from 'node:fs';
import { Color, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, ShaderMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { getCar } from '../src/cars';
import type { EnvironmentState, GraphicsSettings, VehicleState } from '../src/core/contracts';
import type { EffectsSystem, RenderSystem } from '../src/core/systems';
import { createEffects } from '../src/render/effects';
import { seedRandom } from '../src/render/fx/pools';
import { MAX_LIGHTS, LightCollector, lightUniforms } from '../src/render/wet/lights';
import { DropletPass } from '../src/render/wet/droplets';
import { RainField } from '../src/render/wet/rain';
import { applyWetTints, createWetUniforms, registerTint, WET_HELPERS_GLSL, WET_LAMPS, WET_UNIFORMS_GLSL } from '../src/track/scene/wet';
import type { Ctx } from '../src/track/scene/ctx';
import { makeState } from '../sandbox/render/cars';
import { makeRingTrack } from '../sandbox/render/fakeTrack';

// ── track scene: wet tint ───────────────────────────────────────────────────────────────────────

describe('wet tint of plain materials', () => {
  const ctx = () => ({ wetTints: [] }) as unknown as Ctx;

  it('darkens and glosses with wetness and restores the dry values exactly at 0', () => {
    const c = ctx();
    const m = new MeshStandardMaterial({ color: new Color(0.8, 0.7, 0.6), roughness: 0.9, envMapIntensity: 1 });
    registerTint(c, m);
    expect(c.wetTints.length).toBe(1);
    applyWetTints(c.wetTints, 1);
    expect(m.color.r).toBeLessThan(0.8);
    expect(m.color.g).toBeLessThan(0.7);
    expect(m.roughness).toBeLessThan(0.9);
    expect(m.envMapIntensity).toBeGreaterThan(1);
    applyWetTints(c.wetTints, 0.5);
    const half = m.color.r;
    applyWetTints(c.wetTints, 1);
    expect(m.color.r).toBeLessThan(half);
    applyWetTints(c.wetTints, 0);
    expect(m.color.r).toBeCloseTo(0.8, 6);
    expect(m.color.b).toBeCloseTo(0.6, 6);
    expect(m.roughness).toBeCloseTo(0.9, 6);
    expect(m.envMapIntensity).toBeCloseTo(1, 6);
  });

  it('ignores materials that opt out or handle wetness themselves, and double registration', () => {
    const c = ctx();
    const a = new MeshStandardMaterial();
    a.userData.noWet = true;
    const b = new MeshStandardMaterial();
    b.userData.wetShader = true;
    const d = new MeshStandardMaterial();
    registerTint(c, a);
    registerTint(c, b);
    registerTint(c, d);
    registerTint(c, d);
    expect(c.wetTints.length).toBe(1);
  });
});

describe('wet GLSL for the track shaders', () => {
  it('declares exactly the uniforms the scene feeds', () => {
    const u = createWetUniforms();
    for (const key of Object.keys(u)) expect(WET_UNIFORMS_GLSL, key).toMatch(new RegExp(`uniform\\s+\\w+\\s+${key}\\b`));
    expect(u.uLamp.value.length).toBe(WET_LAMPS);
    expect(WET_UNIFORMS_GLSL).toContain(`uLamp[${WET_LAMPS}]`);
  });

  it('ships the ripple, tunnel and lamp helpers', () => {
    for (const fn of ['wRipple', 'wTunnelDry', 'roadLamps', 'wHash12']) expect(WET_HELPERS_GLSL).toContain(fn);
  });

  it('never takes pow() of an unclamped (1.0 - x): a negative base is NaN and one NaN pixel blacks out the frame', () => {
    const files = [
      'src/render/wet/beams.ts',
      'src/render/wet/ssr.ts',
      'src/render/wet/rain.ts',
      'src/render/wet/droplets.ts',
      'src/track/scene/wet.ts',
      'src/track/scene/materials.ts',
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const bad = src.match(/pow\(\s*1\.0\s*-\s*[^,]+,/g) ?? [];
      for (const b of bad) expect(/clamp\(|max\(|saturate\(/.test(b), `${f}: ${b}`).toBe(true);
    }
  });
});

// ── lights, rain ────────────────────────────────────────────────────────────────────────────────

describe('light collector', () => {
  it('keeps the closest, brightest sources and clears the unused slots', () => {
    const lc = new LightCollector();
    lc.begin();
    for (let i = 0; i < 40; i++) lc.add(i * 10, 0, 0, 30, 1, 1, 1);
    lc.commit(0, 0, 0);
    const P = lightUniforms.uLP.value;
    const xs = P.map((p) => p.x).sort((a, b) => a - b);
    expect(xs).toEqual(Array.from({ length: MAX_LIGHTS }, (_, i) => i * 10));
    expect(P.every((p) => p.w === 30)).toBe(true);
    // fewer sources next frame: the rest of the slots are switched off (reach 0)
    lc.begin();
    lc.add(5, 0, 0, 20, 1, 0, 0, 0, 0, 1, 0.8, 0.1);
    lc.commit(0, 0, 0);
    expect(P.filter((p) => p.w > 0).length).toBe(1);
    expect(lightUniforms.uLC.value.find((c, i) => P[i].w > 0)!.w).toBeCloseTo(0.8, 6);
  });

  it('prefers a bright far light to a dim near one when it matters more', () => {
    const lc = new LightCollector();
    lc.begin();
    for (let i = 0; i < MAX_LIGHTS; i++) lc.add(10 + i, 0, 0, 20, 0.05, 0.05, 0.05);
    lc.add(60, 0, 0, 60, 5, 5, 5);
    lc.commit(0, 0, 0);
    expect(lightUniforms.uLP.value.some((p) => p.x === 60)).toBe(true);
  });
});

describe('rain field', () => {
  it('scales with the rain, vanishes when dry or sheltered and sits ahead of the camera', () => {
    const rf = new RainField(1000);
    const count = () => (rf.mesh.geometry as unknown as { instanceCount: number }).instanceCount;
    rf.update(1 / 60, 0, 2, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0);
    expect(rf.mesh.visible).toBe(false);
    expect(count()).toBe(0);
    rf.update(1 / 60, 0, 2, 0, 0, 1, 0, 0, 0, 0.5, 1, 0, 0, 0);
    expect(rf.mesh.visible).toBe(true);
    expect(count()).toBe(500);
    rf.update(1 / 60, 0, 2, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0);
    expect(count()).toBe(1000);
    // half under a roof: half the rain
    rf.update(1 / 60, 0, 2, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0.5, 0);
    expect(count()).toBe(500);
    rf.update(1 / 60, 0, 2, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0);
    expect(rf.mesh.visible).toBe(false);
    // the box is centred ahead of a camera looking down +z
    rf.update(1 / 60, 10, 2, 20, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0);
    const u = (rf.mesh.material as ShaderMaterial).uniforms;
    const min = u.uBoxMin.value as Vector3;
    const size = u.uBoxSize.value as Vector3;
    const centre = new Vector3().copy(min).addScaledVector(size, 0.5);
    expect(centre.z).toBeGreaterThan(20 + 5);
    expect(Math.abs(centre.x - 10)).toBeLessThan(1);
    rf.dispose();
  });

  it('scatters its drops deterministically', () => {
    const a = new RainField(64);
    const b = new RainField(64);
    const sa = a.mesh.geometry.getAttribute('aSeed').array as Float32Array;
    const sb = b.mesh.geometry.getAttribute('aSeed').array as Float32Array;
    expect(Array.from(sa)).toEqual(Array.from(sb));
    expect(Array.from(sa).every((v) => v >= 0 && v < 1)).toBe(true);
    a.dispose();
    b.dispose();
  });
});

// ── effects in the wet ──────────────────────────────────────────────────────────────────────────

type WetFx = EffectsSystem & { debug: () => Record<string, number> };

function mockWet(wet: number, rain: number, darkness = 0): { render: RenderSystem; main: Scene; particles: Scene; env: EnvironmentState } {
  const main = new Scene();
  const particles = new Scene();
  const env = { wetness: wet, rain, darkness } as EnvironmentState;
  const render = {
    scene: main,
    particleScene: particles,
    env,
    graphics: { shadows: 'high' } as GraphicsSettings,
    stats: { fps: 60, frameMs: 16, drawCalls: 0, triangles: 0, cascades: 3 },
  } as unknown as RenderSystem;
  return { render, main, particles, env };
}

function carAt(id: number, x: number, z: number, speed: number): VehicleState {
  const def = getCar('vanta-gt');
  const v = def.visual;
  const s = makeState(id);
  s.position.set(x, v.cgHeight, z);
  s.velocity.set(0, 0, speed);
  s.speed = speed;
  s.forwardSpeed = speed;
  const half = v.wheelbase / 2;
  const pos = [
    [v.trackFront / 2, half],
    [-v.trackFront / 2, half],
    [v.trackRear / 2, -half],
    [-v.trackRear / 2, -half],
  ];
  for (let i = 0; i < 4; i++) {
    const w = s.wheels[i];
    w.contactPoint.set(x + pos[i][0], 0, z + pos[i][1]);
    w.radius = 0.34;
    w.width = 0.28;
    w.tempC = 90;
    w.surface = 'asphalt';
    w.contact = true;
  }
  return s;
}

const cam = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
cam.position.set(0, 2, -8);
cam.lookAt(0, 0.5, 0);
cam.updateMatrixWorld();

function drive(fx: EffectsSystem, s: VehicleState, frames: number, speed: number, skid = 0): void {
  for (let i = 0; i < frames; i++) {
    s.velocity.set(0, 0, speed);
    s.speed = speed;
    for (let k = 0; k < 4; k++) {
      s.wheels[k].contactPoint.z += speed / 60;
      s.wheels[k].skid = k >= 2 ? skid : 0;
    }
    s.position.z += speed / 60;
    fx.update(1 / 60, [s], cam);
  }
}

describe('effects on a wet road', () => {
  it('throws spray, not smoke or rubber, when the tyres slide on a wet road', () => {
    seedRandom(3);
    const { render, main } = mockWet(0.75, 0.55);
    const fx = createEffects(render, makeRingTrack(), 'high') as WetFx;
    fx.registerCar(1, getCar('vanta-gt'));
    const s = carAt(1, 0, 0, 40);
    drive(fx, s, 90, 40, 1);
    const d = fx.debug();
    expect(d.puffs).toBe(0); // no tyre smoke
    const skid = main.children.find((c) => c.name === 'xr.fx.skidmarks') as Mesh;
    expect(skid.geometry.drawRange.count).toBe(0); // no marks
    expect(d.mist).toBeGreaterThan(20);
    expect(d.drops).toBeGreaterThan(5);
    fx.dispose();
  });

  it('keeps the dry behaviour dry: smoke and marks, no spray', () => {
    seedRandom(3);
    const { render, main } = mockWet(0, 0);
    const fx = createEffects(render, makeRingTrack(), 'high') as WetFx;
    fx.registerCar(1, getCar('vanta-gt'));
    const s = carAt(1, 0, 0, 40);
    drive(fx, s, 90, 40, 1);
    const d = fx.debug();
    expect(d.puffs).toBeGreaterThan(30);
    expect(d.mist).toBe(0);
    expect(d.drops).toBe(0);
    expect(d.rain).toBe(0);
    const skid = main.children.find((c) => c.name === 'xr.fx.skidmarks') as Mesh;
    expect(skid.geometry.drawRange.count).toBeGreaterThan(0);
    fx.dispose();
  });

  it('sprays more the faster the car goes, and not at a crawl', () => {
    const run = (speed: number): number => {
      seedRandom(8);
      const { render } = mockWet(1, 1);
      const fx = createEffects(render, makeRingTrack(), 'high') as WetFx;
      fx.registerCar(1, getCar('vanta-gt'));
      drive(fx, carAt(1, 0, 0, speed), 40, speed);
      const m = fx.debug().mist;
      fx.dispose();
      return m;
    };
    expect(run(2)).toBe(0);
    expect(run(25)).toBeGreaterThan(5);
    expect(run(70)).toBeGreaterThan(run(25));
  });

  it('streams rain by intensity and stops it under a tunnel roof, along with the spray', () => {
    const track = Object.assign(makeRingTrack(), { tunnelSpans: [[0, 600]] as [number, number][] });
    // the camera and the car are on the ring road (x = 140), inside the tunnel's span
    const tcam = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
    tcam.position.set(140, 2, 6);
    tcam.lookAt(140, 0.5, 20);
    tcam.updateMatrixWorld();
    const build = (spans: boolean) => {
      seedRandom(4);
      const { render } = mockWet(1, 1);
      const fx = createEffects(render, spans ? track : makeRingTrack(), 'high') as WetFx;
      fx.registerCar(1, getCar('vanta-gt'));
      const s = carAt(1, 140, 14, 60);
      // (the car stays within ~20 m of the ring's tangent point, inside the road corridor)
      for (let i = 0; i < 30; i++) {
        s.velocity.set(0, 0, 60);
        s.speed = 60;
        for (const w of s.wheels) w.contactPoint.z += 0.6;
        s.position.z += 0.6;
        fx.update(1 / 60, [s], tcam);
      }
      const d = fx.debug();
      fx.dispose();
      return d;
    };
    const open = build(false);
    const roofed = build(true);
    expect(open.rain).toBe(22000);
    expect(open.mist).toBeGreaterThan(20);
    expect(roofed.rain).toBe(0);
    expect(roofed.mist).toBe(0);
    expect(roofed.drops).toBe(0);
  });

  it('lets damp dust settle: far fainter puffs on wet gravel', () => {
    const alphaSum = (wet: number): number => {
      seedRandom(6);
      const { render, particles } = mockWet(wet, wet);
      const fx = createEffects(render, makeRingTrack(), 'high') as WetFx;
      fx.registerCar(1, getCar('vanta-gt'));
      const s = carAt(1, 0, 0, 35);
      for (const w of s.wheels) w.surface = 'gravel';
      drive(fx, s, 60, 35, 0.8);
      const puffs = particles.children.find((c) => c.name === 'xr.fx.puffs') as Mesh;
      const B = puffs.geometry.getAttribute('aB').array as Float32Array;
      const n = (puffs.geometry as unknown as { instanceCount: number }).instanceCount;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += B[i * 4 + 1];
      fx.dispose();
      return sum;
    };
    expect(alphaSum(1)).toBeLessThan(alphaSum(0) * 0.4);
  });

  it('never produces NaN with a wild fast car in the rain', () => {
    seedRandom(2);
    const { render, particles } = mockWet(1, 1, 1);
    const fx = createEffects(render, makeRingTrack(), 'ultra') as WetFx;
    fx.registerCar(5, getCar('lmp-x'));
    const s = carAt(5, 0, 0, 90);
    s.quaternion.set(0.5, 0.5, 0.5, 0.5);
    s.velocity.set(300, 100, -250);
    s.speed = 400;
    s.brake = 1;
    for (let i = 0; i < 90; i++) {
      for (const w of s.wheels) w.skid = 1;
      fx.update(i % 7 === 0 ? 0.0005 : 1 / 60, [s], cam);
    }
    for (const c of particles.children) {
      const g = (c as Mesh).geometry;
      for (const name of Object.keys(g.attributes)) {
        const arr = g.getAttribute(name).array as Float32Array;
        expect(Array.from(arr).every(Number.isFinite), `${c.name}.${name}`).toBe(true);
      }
    }
    fx.dispose();
  });

  it('removes everything it added on dispose', () => {
    const { render, main, particles } = mockWet(1, 1, 1);
    const fx = createEffects(render, makeRingTrack(), 'high');
    fx.dispose();
    expect(main.children.some((c) => c.name.startsWith('xr.fx'))).toBe(false);
    expect(particles.children.length).toBe(0);
  });
});

// ── windscreen / lens drops ─────────────────────────────────────────────────────────────────────

describe('droplet pass', () => {
  it('starts switched off and feeds exactly the uniforms its shader declares', () => {
    const p = new DropletPass();
    expect(p.enabled).toBe(false);
    expect(p.rain).toBe(0);
    const m = (p as unknown as { material: ShaderMaterial }).material;
    for (const key of Object.keys(m.uniforms)) {
      if (key === 'tScene' || key === 'tDepth') continue;
      expect(m.fragmentShader, key).toMatch(new RegExp(String.raw`uniform\s+\w+\s+${key}\b`));
    }
    p.dispose();
  });

  it('keeps the drop grids inside their cells so a drop is never clipped by a neighbour', () => {
    const src = readFileSync('src/render/wet/droplets.ts', 'utf8');
    // the centre range is built from the biggest possible radius
    expect(src).toContain('vec2 c = rHi + (1.0 - 2.0 * rHi) * n.yz;');
    // and the hash input is wrapped so a creeping pattern never feeds huge numbers to the hash
    expect(src).toContain('mod(id.y, 251.0)');
  });
});
