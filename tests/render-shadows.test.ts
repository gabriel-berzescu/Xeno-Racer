import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { xrCsmUniform } from '../src/render/shaderPatches';
import { SHADOW_OFF, SunShadows, shadowConfigFor } from '../src/render/shadows';

const sunDirs = [new Vector3(0.3, 0.9, 0.2), new Vector3(-0.9, 0.15, 0.4), new Vector3(0.2, 0.05, -0.97)].map((v) => v.normalize());

/** Same light-space basis as SunShadows (documented there). */
function basis(dir: Vector3): { ax: Vector3; ay: Vector3 } {
  const up = Math.abs(dir.y) > 0.985 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  const ax = new Vector3().crossVectors(up, dir).normalize();
  const ay = new Vector3().crossVectors(dir, ax).normalize();
  return { ax, ay };
}

describe('shadow configuration', () => {
  it('scales cascades with the shadows setting and quality', () => {
    expect(shadowConfigFor('off', 'ultra')).toBe(SHADOW_OFF);
    expect(shadowConfigFor('low', 'low').count).toBe(2);
    expect(shadowConfigFor('high', 'high').count).toBe(3);
    expect(shadowConfigFor('high', 'ultra').count).toBe(4);
    for (const s of ['low', 'high'] as const) {
      for (const q of ['low', 'medium', 'high', 'ultra'] as const) {
        const c = shadowConfigFor(s, q);
        expect(c.radii.length).toBe(c.count);
        for (let i = 1; i < c.count; i++) expect(c.radii[i]).toBeGreaterThan(c.radii[i - 1] * 2);
        expect(c.taps).toBeGreaterThanOrEqual(1);
        expect(c.taps).toBeLessThanOrEqual(8);
        // all shadow maps together stay well under 80 MB
        expect(c.mapSize * c.mapSize * 4 * c.count).toBeLessThan(80 * 1024 * 1024);
      }
    }
  });
});

describe('cascade fitting', () => {
  it('snaps every cascade centre to its own texel grid in light space', () => {
    for (const dir of sunDirs) {
      const sun = new SunShadows(true);
      sun.configure(shadowConfigFor('high', 'ultra'));
      sun.setDirection(dir);
      const { ax, ay } = basis(dir);
      for (let k = 0; k < 40; k++) {
        const f = new Vector3(Math.sin(k * 1.7) * 900, Math.cos(k * 0.3) * 4, Math.cos(k * 2.3) * 900);
        sun.update(f, 1000 + k * 7);
        for (let i = 0; i < sun.config.count; i++) {
          const texel = (2 * sun.config.radii[i]) / sun.config.mapSize;
          const t = sun.lights[i].target.position;
          const cx = t.dot(ax) / texel;
          const cy = t.dot(ay) / texel;
          expect(Math.abs(cx - Math.round(cx))).toBeLessThan(1e-3);
          expect(Math.abs(cy - Math.round(cy))).toBeLessThan(1e-3);
        }
      }
    }
  });

  it('does not move the cascade when the focus moves less than a texel (no shimmer)', () => {
    const dir = sunDirs[1];
    const sun = new SunShadows(true);
    sun.configure(shadowConfigFor('high', 'high'));
    sun.setDirection(dir);
    const { ax } = basis(dir);
    const texel0 = (2 * sun.config.radii[0]) / sun.config.mapSize;
    const f = new Vector3(120.0, 0, -35.0);
    // snapping rounds to the nearest grid point, so sit exactly on one: +-0.3 texel must keep the same point
    const cell = Math.round(f.dot(ax) / texel0);
    f.addScaledVector(ax, cell * texel0 - f.dot(ax));
    sun.update(f, 1);
    const base = sun.lights[0].target.position.clone();
    for (const d of [-0.3, -0.1, 0.2, 0.3]) {
      const g = f.clone().addScaledVector(ax, d * texel0);
      sun.update(g, 2);
      expect(sun.lights[0].target.position.distanceTo(base)).toBeLessThan(1e-6);
    }
  });

  it('refreshes far cascades on their interval and re-centres them only after real movement', () => {
    const sun = new SunShadows(true);
    sun.configure(shadowConfigFor('high', 'high')); // every = [1, 1, 3]
    sun.setDirection(sunDirs[0]);
    const f = new Vector3(10, 0, 10);
    sun.update(f, 0);
    const c2 = sun.lights[2].target.position.clone();
    const due: boolean[] = [];
    for (let frame = 1; frame <= 9; frame++) {
      for (const l of sun.lights) l.shadow.needsUpdate = false;
      f.x += 0.5; // 4.5 m in total: well under 12% of the 210 m cascade
      sun.update(f, frame);
      due.push(sun.lights[2].shadow.needsUpdate);
      expect(sun.lights[0].shadow.needsUpdate).toBe(true); // the near cascade refreshes every frame
    }
    expect(due.filter(Boolean).length).toBe(3); // 9 frames at interval 3
    expect(sun.lights[2].target.position.distanceTo(c2)).toBeLessThan(1e-6);
    // a big jump forces a re-centre on the next due frame
    const big = f.clone().add(new Vector3(200, 0, 0));
    for (let frame = 10; frame < 14; frame++) sun.update(big, frame);
    expect(sun.lights[2].target.position.distanceTo(c2)).toBeGreaterThan(50);
  });

  it('aims the lights along the sun direction and sizes the depth range for tall casters', () => {
    const dir = sunDirs[1]; // low sun
    const sun = new SunShadows(true);
    sun.configure(shadowConfigFor('high', 'high'));
    sun.setDirection(dir);
    sun.update(new Vector3(0, 0, 0), 0);
    for (let i = 0; i < 3; i++) {
      const l = sun.lights[i];
      const d = l.position.clone().sub(l.target.position).normalize();
      expect(d.distanceTo(dir)).toBeLessThan(1e-6);
      expect(l.shadow.camera.far).toBeGreaterThan(l.position.distanceTo(l.target.position));
    }
    // low sun: casters up to 35 m tall reach hundreds of metres, so the near plane sits far back
    expect(sun.lights[0].position.distanceTo(sun.lights[0].target.position)).toBeGreaterThan(100);
  });

  it('writes finite per-cascade receiving parameters', () => {
    const sun = new SunShadows(true);
    sun.configure(shadowConfigFor('high', 'ultra'));
    sun.setDirection(sunDirs[0]);
    sun.update(new Vector3(), 0);
    expect(Array.from(xrCsmUniform.value).every(Number.isFinite)).toBe(true);
    expect(xrCsmUniform.value[3]).toBe(8); // PCF taps
    for (let i = 0; i < 4; i++) {
      expect(xrCsmUniform.value[i * 4]).toBeGreaterThan(0); // plane-gradient clamp
      expect(xrCsmUniform.value[i * 4 + 1]).toBeGreaterThan(0); // z bias
    }
  });

  it('falls back to a single stock shadow light if the cascade patch is unavailable', () => {
    const sun = new SunShadows(false);
    sun.configure(shadowConfigFor('high', 'ultra'));
    expect(sun.cascadeCount).toBe(1);
    expect(sun.lights.filter((l) => l.castShadow).length).toBe(1);
  });

  it('turns shadows off cleanly', () => {
    const sun = new SunShadows(true);
    sun.configure(shadowConfigFor('off', 'high'));
    expect(sun.update(new Vector3(), 0)).toBe(false);
    expect(sun.lights.some((l) => l.castShadow)).toBe(false);
    expect(sun.lights[0].visible).toBe(true);
    expect(sun.lights.slice(1).some((l) => l.visible)).toBe(false);
  });
});
