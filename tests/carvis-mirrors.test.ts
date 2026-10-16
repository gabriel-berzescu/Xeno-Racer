import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { PART, ZONE_STRIDE } from '../src/carvis/blueprint';
import { CARS } from '../src/cars';
import { eyePoint } from '../src/carvis/layouts';
import { glassOutline, mirrorLayout, type MirrorPose, type V3 } from '../src/carvis/mirrorLayout';
import { addDoorMirrors, GLASS_INSET, inGlassFrame } from '../src/carvis/mirrorParts';
import { createMirrorRig } from '../src/carvis/mirrors';
import { PartBuilder } from '../src/carvis/parts';

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3): V3 => {
  const l = len(a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The direction a viewer at `eye` sees in the middle of the glass: the eye ray reflected in the glass. */
function seen(m: MirrorPose, eye: V3): V3 {
  const d = norm(sub(m.pos, eye));
  const k = 2 * dot(d, m.normal);
  return [d[0] - k * m.normal[0], d[1] - k * m.normal[1], d[2] - k * m.normal[2]];
}

describe.each(CARS.map((c) => [c.id, c.visual] as const))('mirror layout: %s', (_id, spec) => {
  const L = mirrorLayout(spec);
  const eye = eyePoint(spec);
  const poses: Array<[string, MirrorPose]> = [['left', L.left], ['right', L.right]];
  if (L.interior) poses.push(['interior', L.interior]);
  if (L.screen) poses.push(['screen', L.screen]);

  it('has glass with a proper frame (unit axes, right x up = normal)', () => {
    for (const [name, m] of poses) {
      expect(len(m.right), name).toBeCloseTo(1, 9);
      expect(len(m.up), name).toBeCloseTo(1, 9);
      expect(len(m.normal), name).toBeCloseTo(1, 9);
      expect(dot(m.right, m.up), name).toBeCloseTo(0, 9);
      expect(dot(m.right, m.normal), name).toBeCloseTo(0, 9);
      const c: V3 = [m.right[1] * m.up[2] - m.right[2] * m.up[1], m.right[2] * m.up[0] - m.right[0] * m.up[2], m.right[0] * m.up[1] - m.right[1] * m.up[0]];
      expect(c[0], name).toBeCloseTo(m.normal[0], 9);
      expect(c[1], name).toBeCloseTo(m.normal[1], 9);
      expect(c[2], name).toBeCloseTo(m.normal[2], 9);
      // upright: the glass's up leans toward the world's up
      expect(m.up[1], name).toBeGreaterThan(0.9);
    }
  });

  it('faces the driver', () => {
    for (const [name, m] of poses) expect(dot(m.normal, norm(sub(eye, m.pos))), name).toBeGreaterThan(0.7);
  });

  it('is set like a driver would: the door mirrors look back and a little outboard, the rear-view mirror straight back', () => {
    const l = seen(L.left, eye);
    expect(l[2]).toBeLessThan(-0.95);
    expect(l[0]).toBeGreaterThan(0.1); // outboard of the left side is +X
    expect(l[0]).toBeLessThan(0.3);
    const r = seen(L.right, eye);
    expect(r[0]).toBeLessThan(-0.1);
    expect(r[0]).toBeGreaterThan(-0.3);
    // the two door mirrors mirror each other
    expect(l[0]).toBeCloseTo(-r[0], 9);
    expect(l[1]).toBeCloseTo(r[1], 9);
    if (L.interior) {
      const i = seen(L.interior, eye);
      expect(Math.abs(i[0])).toBeLessThan(1e-6);
      expect(i[2]).toBeLessThan(-0.99);
    }
  });

  it('puts the driver-side mirror and the rear-view mirror (or the display) inside the default cockpit view', () => {
    // vertical field 62 + 10 degrees on a 16:9 screen: +-52 degrees across, +-36 up
    const az = (m: MirrorPose): number => (Math.atan2(m.pos[0] - eye[0], m.pos[2] - eye[2]) * 180) / Math.PI;
    const el = (m: MirrorPose): number => (Math.atan2(m.pos[1] - eye[1], Math.hypot(m.pos[0] - eye[0], m.pos[2] - eye[2])) * 180) / Math.PI;
    expect(Math.abs(az(L.left))).toBeLessThan(52);
    expect(Math.abs(el(L.left))).toBeLessThan(36);
    const centre = L.interior ?? L.screen!;
    expect(Math.abs(az(centre))).toBeLessThan(40);
    expect(Math.abs(el(centre))).toBeLessThan(30);
    // and the passenger-side mirror is on the other side of the car
    expect(L.right.pos[0]).toBeLessThan(0);
    expect(L.left.pos[0]).toBeGreaterThan(0);
  });

  it('keeps a rear-view mirror a sensible size on screen (a 15..25 degree wide glass), and a real door mirror size', () => {
    if (L.interior) {
      const d = len(sub(L.interior.pos, eye));
      const angle = (2 * Math.atan(L.interior.halfW / d) * 180) / Math.PI;
      expect(angle).toBeGreaterThan(14);
      expect(angle).toBeLessThan(26);
    }
    expect(L.left.halfW * 2).toBeGreaterThan(0.11);
    expect(L.left.halfW * 2).toBeLessThan(0.2);
    expect(L.left.convex).toBeGreaterThan(1);
    expect(L.left.convexY).toBeGreaterThan(1);
  });

  it('puts the rear camera on the car, at its tail, on the centreline, looking out of it', () => {
    const zTail = -(spec.wheelbase / 2 + (spec.length - spec.wheelbase - spec.frontOverhang));
    expect(L.rear.pos[0]).toBe(0);
    expect(L.rear.pos[2]).toBeGreaterThan(zTail);
    expect(L.rear.pos[2]).toBeLessThan(0);
    expect(L.rear.pos[1]).toBeGreaterThan(0.8);
    expect(L.rear.pitchDown).toBeGreaterThan(0);
    expect(L.rear.pitchDown).toBeLessThan(0.1);
  });

  it('has a prototype display and no rear-view mirror, road cars the other way round', () => {
    expect(!!L.interior).toBe(spec.style !== 'prototype');
    expect(!!L.screen).toBe(spec.style === 'prototype');
  });
});

describe('door mirror parts', () => {
  it('builds a housing, a frame, the glass face and a stalk, all finite', () => {
    for (const c of CARS) {
      const b = new PartBuilder();
      addDoorMirrors(b, c.visual);
      expect(b.vertexCount, c.id).toBeGreaterThan(100);
      expect(b.pos.every(Number.isFinite), c.id).toBe(true);
      expect(b.nor.every(Number.isFinite), c.id).toBe(true);
      expect(b.idx.every((i) => i >= 0 && i < b.vertexCount), c.id).toBe(true);
    }
  });

  it('draws the glass face on the same plane and in the same outline the live glass uses', () => {
    for (const c of CARS) {
      const L = mirrorLayout(c.visual);
      const b = new PartBuilder();
      addDoorMirrors(b, c.visual);
      // the vertices whose part id is mirror glass, per side
      const glass: V3[][] = [[], []];
      for (let v = 0; v < b.vertexCount; v++) {
        if (Math.round(b.zon[v * ZONE_STRIDE + 13]) === PART.mirrorGlass) glass[b.pos[v * 3] > 0 ? 0 : 1].push([b.pos[v * 3], b.pos[v * 3 + 1], b.pos[v * 3 + 2]]);
      }
      for (const [side, m] of [[0, L.left], [1, L.right]] as Array<[number, MirrorPose]>) {
        const pts = glass[side];
        // one fan: the outline's points
        expect(pts.length, c.id).toBe(glassOutline(1, 1, 28, 3.4).length);
        for (const p of pts) {
          // on the face plane, 1.6 mm in front of the glass centre plane
          expect(dot(sub(p, m.pos), m.normal), c.id).toBeCloseTo(0.0016, 6);
          // inside the inset outline
          const a = dot(sub(p, m.pos), m.right) / (m.halfW * GLASS_INSET);
          const u = dot(sub(p, m.pos), m.up) / (m.halfH * GLASS_INSET);
          expect(Math.abs(a), c.id).toBeLessThanOrEqual(1 + 1e-6);
          expect(Math.abs(u), c.id).toBeLessThanOrEqual(1 + 1e-6);
        }
      }
    }
  });

  it('stands in the glass frame helper the same way for the render side', () => {
    const m = mirrorLayout(CARS[0].visual).left;
    const p = inGlassFrame(m, 0, 0, 0);
    expect(p).toEqual(m.pos);
    const q = inGlassFrame(m, 0, 0, 1);
    expect(q[0]).toBeCloseTo(m.pos[0] + m.normal[0], 12);
  });
});

describe('glass outline', () => {
  it('is a rounded rectangle inside its box, symmetric, counter-clockwise', () => {
    const o = glassOutline(0.1, 0.05, 28, 3.4);
    expect(o.length).toBe(28);
    let area = 0;
    for (let i = 0; i < o.length; i++) {
      const [x, y] = o[i];
      expect(Math.abs(x)).toBeLessThanOrEqual(0.1 + 1e-12);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.05 + 1e-12);
      const [x2, y2] = o[(i + 1) % o.length];
      area += x * y2 - x2 * y;
    }
    expect(area).toBeGreaterThan(0); // counter-clockwise
    // fuller than an ellipse (pi/4 of the box) and short of the whole box
    const share = area / 2 / (0.2 * 0.1);
    expect(share).toBeGreaterThan(0.8);
    expect(share).toBeLessThan(0.99);
    // symmetric left-right and up-down
    const has = (x: number, y: number): boolean => o.some(([a, b]) => Math.abs(a - x) < 1e-9 && Math.abs(b - y) < 1e-9);
    for (const [x, y] of o) {
      expect(has(-x, y)).toBe(true);
      expect(has(x, -y)).toBe(true);
    }
    expect(o[0][0]).toBeCloseTo(0.1, 9);
  });
});

describe('mirror rig', () => {
  it('gives road cars a left, a right and a rear-view mirror, the prototype two mirrors and a display', () => {
    for (const c of CARS) {
      const rig = createMirrorRig(c.visual);
      const kinds = rig.api.glass.map((g) => g.kind + ':' + g.mesh.name.replace('mirror.', ''));
      if (c.visual.style === 'prototype') expect(kinds, c.id).toEqual(['reflect:left', 'reflect:right', 'camera:screen']);
      else expect(kinds, c.id).toEqual(['reflect:left', 'reflect:right', 'reflect:interior']);
      expect(rig.api.rearCamera).toBeTruthy();
      expect(rig.api.live).toBe(false);
      expect(rig.api.hide).toEqual([]);
      rig.dispose();
    }
  });

  it('keeps the glass hidden until the cockpit view is on and the mirrors are live, and shows a still mirror otherwise', () => {
    const rig = createMirrorRig(CARS[0].visual);
    const vis = (): boolean[] => rig.api.glass.map((g) => g.mesh.visible);
    const still = (): boolean[] => rig.group.children.filter((o) => o.name.endsWith('.still')).map((o) => o.visible);
    expect(still().length).toBe(rig.api.glass.length);
    expect(vis().every((v) => !v)).toBe(true);
    // nothing draws into the glass yet: the cockpit has still mirrors
    rig.setCockpit(true);
    expect(vis().every((v) => !v)).toBe(true);
    expect(still().every((v) => v)).toBe(true);
    rig.api.live = true;
    rig.setCockpit(true);
    expect(vis().every((v) => v)).toBe(true);
    expect(still().every((v) => !v)).toBe(true);
    rig.setCockpit(false);
    expect(vis().every((v) => !v)).toBe(true);
    expect(still().every((v) => !v)).toBe(true);
  });

  it('puts each glass mesh where the layout says, facing the way it says, a hair in front of the baked glass face', () => {
    for (const c of CARS) {
      const L = mirrorLayout(c.visual);
      const rig = createMirrorRig(c.visual);
      const poses = [L.left, L.right, L.interior ?? L.screen!];
      rig.api.glass.forEach((g, i) => {
        const m = poses[i];
        const mat: Matrix4 = g.mesh.matrix;
        const e = mat.elements;
        const nrm = new Vector3(e[8], e[9], e[10]);
        expect(nrm.x, c.id).toBeCloseTo(m.normal[0], 9);
        expect(nrm.y, c.id).toBeCloseTo(m.normal[1], 9);
        expect(nrm.z, c.id).toBeCloseTo(m.normal[2], 9);
        const pos = new Vector3(e[12], e[13], e[14]);
        expect(dot([pos.x - m.pos[0], pos.y - m.pos[1], pos.z - m.pos[2]], m.normal), c.id).toBeCloseTo(0.0022, 6);
        expect(g.halfW, c.id).toBeCloseTo(m.halfW * GLASS_INSET, 9);
        expect(g.convex, c.id).toBe(m.convex);
        expect(g.convexY, c.id).toBe(m.convexY);
      });
      rig.dispose();
    }
  });
});
