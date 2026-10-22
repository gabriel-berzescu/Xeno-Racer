import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { getCar, CARS } from '../src/cars';
import { PART, ZONE_STRIDE } from '../src/carvis/blueprint';
import { BLUEPRINTS } from '../src/carvis/bodies';
import { haloPath } from '../src/carvis/bodies/formulaParts';
import { makePrototype } from '../src/carvis/bodies/prototype';
import { sideX, topY } from '../src/carvis/bodies/probe';
import { buildCarData, VERTEX_STRIDE, type CarData } from '../src/carvis/build';
import { poseMoving, steeringLock } from '../src/carvis/car';
import { makeDamageGeometry } from '../src/carvis/damageGeometry';
import { DENT_PARTS, DMG_VERT_PARS } from '../src/carvis/damageShader';
import { IPART, makeInterior, YOKE } from '../src/carvis/interior';
import { computeLayout, eyePoint, formulaPoints, wheelLook } from '../src/carvis/layouts';
import { createBodyUniforms, createPillarMaterial } from '../src/carvis/materials';
import { mirrorLayout } from '../src/carvis/mirrorLayout';
import { PartBuilder } from '../src/carvis/parts';
import { BODY_FRAG_ZONES } from '../src/carvis/shaders';
import { buildCaliper, buildWheel, styleForBody, type WheelParams } from '../src/carvis/wheels';

/** The Volta's own look: a 2026 single-seater with its wings, halo, floor and suspension as parts, flaps that open, closed wheels, its lamps. */
const volta = getCar('volta');
const spec = volta.visual;
const zF = spec.wheelbase / 2;
const zR = -spec.wheelbase / 2;
const zNose = zF + spec.frontOverhang;
const zTail = -(spec.wheelbase / 2 + (spec.length - spec.wheelbase - spec.frontOverhang));
const bp = BLUEPRINTS.formula(spec);
const pts = formulaPoints(spec);

type V = [number, number, number];
/** The static parts as the vertices of each part id, and the vertices flagged with zone channel 14 < 0. */
function partsOf(build: (b: PartBuilder) => void): { byPart: Map<number, V[]>; flagged: V[]; pb: PartBuilder } {
  const pb = new PartBuilder();
  build(pb);
  const byPart = new Map<number, V[]>();
  const flagged: V[] = [];
  for (let i = 0; i < pb.vertexCount; i++) {
    const id = Math.round(pb.zon[i * ZONE_STRIDE + 13]);
    const v: V = [pb.pos[i * 3], pb.pos[i * 3 + 1], pb.pos[i * 3 + 2]];
    if (!byPart.has(id)) byPart.set(id, []);
    byPart.get(id)!.push(v);
    if (pb.zon[i * ZONE_STRIDE + 14] < 0) flagged.push(v);
  }
  return { byPart, flagged, pb };
}
const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

let dataHigh: Promise<CarData> | null = null;
const high = (): Promise<CarData> => (dataHigh ??= buildCarData(spec, 'high'));

describe('Volta body', () => {
  it('has a body of its own, not the prototype it borrowed first, with parts, far parts and moving parts', () => {
    expect(BLUEPRINTS.formula).not.toBe(makePrototype);
    expect(typeof bp.parts).toBe('function');
    expect(typeof bp.farParts).toBe('function');
    expect(bp.moving?.map((m) => m.name)).toEqual(['frontFlaps', 'rearFlaps']);
    // (and no other body has either hook: their far LODs and their meshes are what they were)
    for (const c of CARS.filter((c) => c.visual.style !== 'formula')) {
      const other = BLUEPRINTS[c.visual.style](c.visual);
      expect(other.farParts, c.id).toBeUndefined();
      expect(other.moving, c.id).toBeUndefined();
      expect(other.info?.lamps, c.id).toBeUndefined();
    }
  });

  it('keeps its static parts finite, inside the polygonization bounds, and under a triangle budget', () => {
    const { pb } = partsOf((b) => bp.parts!(b));
    expect(pb.pos.every(Number.isFinite)).toBe(true);
    expect(pb.nor.every(Number.isFinite)).toBe(true);
    expect(pb.idx.every((i) => i >= 0 && i < pb.vertexCount)).toBe(true);
    for (let i = 0; i < pb.vertexCount; i++) {
      for (let k = 0; k < 3; k++) {
        expect(pb.pos[i * 3 + k]).toBeGreaterThan(bp.bounds.min[k] - 0.02);
        expect(pb.pos[i * 3 + k]).toBeLessThan(bp.bounds.max[k] + 0.02);
      }
    }
    expect(pb.triangleCount).toBeLessThan(12000);
  });

  it('has the 2026 look: a front wing near the ground ahead of the front tyres, a rear wing over the crash structure and no beam wing', () => {
    const { byPart } = partsOf((b) => bp.parts!(b));
    const carbon = byPart.get(PART.carbon)!;
    // the front wing: a mainplane across the car, low (8-13 cm), its endplates out at the tyres' outer faces, all of it ahead of the tyres
    const fw = carbon.filter((v) => v[2] > zF + spec.wheelRadiusFront + 0.05);
    expect(Math.max(...fw.map((v) => v[0]))).toBeGreaterThan(0.85);
    expect(Math.max(...fw.map((v) => v[0]))).toBeLessThan(spec.trackFront / 2 + spec.tireWidthFront / 2);
    expect(Math.min(...fw.map((v) => v[1]))).toBeLessThan(0.07);
    expect(Math.max(...fw.filter((v) => Math.abs(v[0]) < 0.6).map((v) => v[1]))).toBeLessThan(0.2);
    // the rear wing's mainplane spans about a metre at 0.75-0.8 m, behind the rear axle; between it and the floor only the two pylons
    // stand (no beam wing): nothing carbon is wider than 20 cm between 0.5 and 0.7 m up behind the gearbox
    const rw = carbon.filter((v) => v[2] < zTail + 0.4 && v[1] > 0.7);
    expect(Math.max(...rw.map((v) => v[0]))).toBeGreaterThan(0.5);
    expect(Math.max(...rw.map((v) => v[0]))).toBeLessThan(0.55);
    const beam = carbon.filter((v) => v[2] < zR - 0.4 && v[1] > 0.5 && v[1] < 0.7);
    expect(Math.max(...beam.map((v) => Math.abs(v[0])))).toBeLessThan(0.1);
    // the floor: a flat plate between the wheels, its underside 2 mm over the ride height
    const floor = carbon.filter((v) => v[1] < spec.rideHeight + 0.02 && Math.abs(v[2]) < 0.5);
    expect(Math.max(...floor.map((v) => v[0]))).toBeGreaterThan(0.6);
    expect(Math.min(...floor.map((v) => v[1]))).toBeGreaterThan(spec.rideHeight);
  });

  it('puts the halo over the driver: the eye inside its hoop, the hoop 8-12 cm over the eye, at least 15 cm from every tube, its pillar flagged', () => {
    const eye = eyePoint(spec);
    const { hoop, pillar } = haloPath(spec);
    // in plan, the eye is inside the hoop's horseshoe (closed across its feet)
    let inside = false;
    for (let i = 0, j = hoop.length - 1; i < hoop.length; j = i++) {
      const [xi, zi] = [hoop[i][0], hoop[i][2]];
      const [xj, zj] = [hoop[j][0], hoop[j][2]];
      if (zi > eye[2] !== zj > eye[2] && eye[0] < ((xj - xi) * (eye[2] - zi)) / (zj - zi) + xi) inside = !inside;
    }
    expect(inside).toBe(true);
    const top = Math.max(...hoop.map((p) => p[1]));
    expect(top - eye[1]).toBeGreaterThan(0.08);
    expect(top - eye[1]).toBeLessThan(0.12);
    // (the camera moves the head 5 cm each way: no tube may come near it)
    const segs: Array<[V, V]> = [];
    for (let i = 0; i < hoop.length - 1; i++) segs.push([hoop[i] as V, hoop[i + 1] as V]);
    segs.push([pillar[0] as V, pillar[1] as V]);
    let near = Infinity;
    for (const [a, b] of segs) {
      for (let t = 0; t <= 1; t += 0.05) near = Math.min(near, dist(eye, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]) - 0.03);
    }
    expect(near).toBeGreaterThan(0.15);
    // the halo is painted (its own part id, rigid in a crash); its pillar is the only part of it flagged, and stands on the chassis
    const { byPart, flagged } = partsOf((b) => bp.parts!(b));
    const halo = byPart.get(PART.halo)!;
    expect(halo.length).toBeGreaterThan(200);
    const pillarVerts = flagged.filter((v) => Math.abs(v[0]) < 0.04 && v[1] > 0.6);
    expect(pillarVerts.length).toBeGreaterThan(20);
    for (const v of pillarVerts) expect(halo.some((h) => dist(h, v) < 1e-9)).toBe(true);
    expect(bp.body(pillar[1][0], pillar[1][1], pillar[1][2])).toBeLessThan(0);
    // its feet stand on the tub beside the headrest
    expect(bp.body(hoop[0][0], hoop[0][1], hoop[0][2])).toBeLessThan(0);
  });

  it('opens its wing flaps with the active aero: the rear flap lifts its leading edge round a hinge at its trailing edge, the front flaps flatten', async () => {
    const data = await high();
    const moving = data.moving!;
    expect(moving.map((m) => [m.name, m.drive])).toEqual([['frontFlaps', 'aero'], ['rearFlaps', 'aero']]);
    const m4 = new Matrix4();
    // closed: the parts as built
    expect(poseMoving(moving[1], 0, m4).equals(new Matrix4())).toBe(true);
    const lift = (i: number, open: number): number => {
      const m = moving[i];
      const v = m.data.vertices;
      // the flap's foremost vertex: how far it rises when open
      let best = -1;
      for (let k = 0; k < v.length; k += VERTEX_STRIDE) if (best < 0 || v[k + 2] > v[best + 2]) best = k;
      const p = new Vector3(v[best], v[best + 1], v[best + 2]).applyMatrix4(poseMoving(m, open, m4));
      return p.y - v[best + 1];
    };
    expect(lift(1, 1)).toBeGreaterThan(0.06);
    expect(lift(1, 1)).toBeLessThan(0.15);
    expect(lift(0, 1)).toBeGreaterThan(0.01);
    expect(lift(0, 1)).toBeLessThan(0.05);
    // half open is about half the lift, and beyond 1 it opens no further
    expect(lift(1, 0.5)).toBeGreaterThan(0.4 * lift(1, 1));
    expect(lift(1, 0.5)).toBeLessThan(0.6 * lift(1, 1));
    expect(lift(1, 1.5)).toBeCloseTo(lift(1, 1), 9);
    // the hinge stays where it is
    const pv = new Vector3(...moving[1].pivot).applyMatrix4(poseMoving(moving[1], 1, m4));
    expect(pv.distanceTo(new Vector3(...moving[1].pivot))).toBeLessThan(1e-9);
    // the flaps are painted or carbon (they crumple with the wing in a crash)
    for (const m of moving) {
      for (let k = 0; k < m.data.vertices.length; k += VERTEX_STRIDE) expect([PART.body, PART.carbon, PART.accent]).toContain(Math.round(m.data.vertices[k + 6 + 13]));
    }
  });

  it('keeps its wings, halo and helmet in the far LOD (and so in the shadow an AI car casts), coloured by the paint they wear', async () => {
    const data = await high();
    const far = data.lod2;
    const nb = far.stats.bodyVertices;
    const n = far.vertices.length / VERTEX_STRIDE;
    expect(n - nb).toBeGreaterThan(200);
    let frontWing = 0, rearWing = 0, halo = 0, helmet = 0, pylon = 0, pylonFoot = 1;
    const eye = eyePoint(spec);
    for (let i = nb; i < n; i++) {
      const o = i * VERTEX_STRIDE;
      const x = far.vertices[o], y = far.vertices[o + 1], z = far.vertices[o + 2];
      const part = Math.round(far.vertices[o + 6 + 13]);
      if (z > zF + 0.4 && y < 0.35 && Math.abs(x) > 0.7) frontWing++;
      if (z < zTail + 0.45 && y > 0.7 && Math.abs(x) > 0.45) rearWing++;
      // the pylon that holds the rear wing up off the gearbox
      if (part === PART.carbon && Math.abs(x) < 0.02 && z > zTail + 0.2 && z < zTail + 0.45 && y < 0.7) {
        pylon++;
        pylonFoot = Math.min(pylonFoot, y);
      }
      if (part === PART.halo) halo++;
      if (part === PART.body && dist([x, y, z], [eye[0], eye[1] - 0.03, eye[2] - 0.07]) < 0.2) helmet++;
      // the baked colour: the livery for the paint (the halo, the helmet), dark for carbon
      expect(far.colors![i * 3]).toBeCloseTo(part === PART.body || part === PART.halo ? 1 : 0.05, 6);
    }
    expect(frontWing).toBeGreaterThan(8);
    expect(rearWing).toBeGreaterThan(8);
    // its foot inside the gearbox: side-on, no gap under the wing
    expect(pylon).toBeGreaterThan(4);
    expect(bp.body(0, pylonFoot + 0.01, zTail + 0.32)).toBeLessThan(0);
    expect(halo).toBeGreaterThan(20);
    expect(helmet).toBeGreaterThan(20);
    // the other cars' far LODs have no parts at all
    for (const c of CARS.filter((c) => c.visual.style !== 'formula')) {
      const d = await buildCarData(c.visual, 'low');
      expect(d.lod2.vertices.length / VERTEX_STRIDE, c.id).toBe(d.lod2.stats.bodyVertices);
      expect(d.moving, c.id).toBeUndefined();
    }
  }, 120000);

  it('gives the damage model its four lamps, each on a lamp: the LED headlamps in the nose, the LED strips on the rear wing', async () => {
    const data = await high();
    const lamps = makeDamageGeometry(data.lod0, spec).lamps;
    expect(lamps.length).toBe(4);
    const v = data.lod0.vertices;
    const nb = data.lod0.stats.bodyVertices;
    const n = v.length / VERTEX_STRIDE;
    const zb = new Float32Array(ZONE_STRIDE);
    for (const [i, side] of [[0, 1], [1, -1]] as const) {
      const l = lamps[i];
      expect(Math.sign(l.c[0])).toBe(side);
      // on the sculpted surface, in its head-lamp zone (z1.x < 0), and the body's vertices round it carry the zone's field (the lens is
      // smaller than two cells: the shader draws it from the field across the triangles)
      expect(Math.abs(bp.body(l.c[0], l.c[1], l.c[2]))).toBeLessThan(0.01);
      zb.fill(1);
      bp.zones(l.c[0], l.c[1], l.c[2], 0, 0, 1, zb, 0);
      expect(zb[4]).toBeLessThan(0);
      let near = 0;
      for (let k = 0; k < nb; k++) {
        const o = k * VERTEX_STRIDE;
        if (v[o + 6 + 4] < 0.03 && dist([v[o], v[o + 1], v[o + 2]], l.c) < l.r) near++;
      }
      expect(near).toBeGreaterThan(4);
    }
    for (const [i, side] of [[2, 1], [3, -1]] as const) {
      const l = lamps[i];
      expect(Math.sign(l.c[0])).toBe(side);
      let led = 0;
      for (let k = nb; k < n; k++) {
        const o = k * VERTEX_STRIDE;
        if (Math.round(v[o + 6 + 13]) === PART.ledRed && dist([v[o], v[o + 1], v[o + 2]], l.c) < l.r) led++;
      }
      expect(led).toBeGreaterThan(8);
    }
    // the headlamp spots shine the lamps' way from the tip of the nose, ahead of the lamps (lighting the road, not the car's own nose)
    const hl = computeLayout(spec).headlight;
    expect(hl[0]).toBeCloseTo(lamps[0].c[0], 6);
    expect(hl[1]).toBeCloseTo(lamps[0].c[1], 6);
    expect(hl[2]).toBeGreaterThan(zNose);
    expect(bp.body(hl[0], hl[1], hl[2])).toBeGreaterThan(0.01);
  });

  it('carries a rain light on the crash structure\'s tip and its tailpipe where the exhaust effects blow the flames', () => {
    const { byPart } = partsOf((b) => bp.parts!(b));
    // src/render/effects.ts buildTips: the one tip, 41 cm over the ride height, half a metre behind the rear axle, on the centre line
    expect(pts.exhaust).toEqual([0, spec.rideHeight + 0.41, -spec.wheelbase / 2 - 0.5]);
    const pipe = (byPart.get(PART.titanium) ?? []).filter((v) => dist(v, pts.exhaust) < 0.06);
    expect(pipe.length).toBeGreaterThan(10);
    // the end of the pipe stands in the air, the engine cover it comes out of ahead of it
    expect(bp.body(...pts.exhaust)).toBeGreaterThan(0);
    expect(bp.body(0, pts.exhaust[1], pts.exhaust[2] + 0.2)).toBeLessThan(0);
    // the rain light: a red lamp block on the tip of the crash structure, about 300 mm up
    const rain = (byPart.get(PART.rainLight) ?? []).filter((v) => dist(v, pts.rainLight) < 0.05);
    expect(rain.length).toBeGreaterThan(8);
    expect(pts.rainLight[1]).toBeGreaterThan(0.25);
    expect(pts.rainLight[1]).toBeLessThan(0.35);
    expect(bp.body(0, pts.rainLight[1], zTail + 0.02)).toBeLessThan(0);
  });

  it('crumples its lamps with what carries them: the rain light with the crash structure, the LED strips with the endplates', () => {
    // the dents move both lamps with the sheet; no other car carries either, and the other cars' lamp blocks stay rigid
    expect(DENT_PARTS).toContain(PART.rainLight);
    expect(DENT_PARTS).toContain(PART.ledRed);
    expect(DENT_PARTS).not.toContain(PART.lampRed);
    for (const id of DENT_PARTS) expect(DMG_VERT_PARS).toContain(`pr == ${id}.0`);
    for (const c of CARS.filter((c) => c.visual.style !== 'formula')) {
      const { byPart } = partsOf((b) => BLUEPRINTS[c.visual.style](c.visual).parts?.(b));
      expect(byPart.has(PART.rainLight) || byPart.has(PART.ledRed), c.id).toBe(false);
    }
    // the rain light lies on the crash structure's tip, no vertex of it more than 1.2 cm out: a dent pushes the sheet 0.85 cm less for
    // every centimetre further in (dentPush), so the two move within a centimetre of each other and the lamp never hangs behind the tail
    const { byPart } = partsOf((b) => bp.parts!(b));
    const rain = byPart.get(PART.rainLight) ?? [];
    expect(rain.length).toBeGreaterThan(8);
    for (const v of rain) expect(bp.body(...v)).toBeLessThan(0.012);
    // its lens dims with the two tail lamps (the endplate LEDs), as its light on the road does (render/effects.ts)
    const branch = BODY_FRAG_ZONES.match(/zPart == 18\) \{[\s\S]*?\n {4}\}/)?.[0] ?? '';
    expect(branch).toContain('uLampOut.z + uLampOut.w');
    const notPaint = BODY_FRAG_ZONES.match(/if \(zPart == 1 \|\| [^\n]*\) zIsPaint = 0\.0;/)?.[0] ?? '';
    expect(notPaint).toContain('zPart == 18');
  });

  it('keeps its wings, floor and suspension clear of the tyres, the front ones steered to the lock and beyond', () => {
    const { pb } = partsOf((b) => bp.parts!(b));
    const lock = volta.physics.chassis.maxSteer * 1.15;
    const wheels: Array<[number, number, number, number, number, number]> = [
      // x, z, R, W, rim radius, steer
      [spec.trackFront / 2, zF, spec.wheelRadiusFront, spec.tireWidthFront, spec.rimRadiusFront, lock],
      [spec.trackRear / 2, zR, spec.wheelRadiusRear, spec.tireWidthRear, spec.rimRadiusRear, 0],
    ];
    for (const [wx, wz, R, W, rimR, steer] of wheels) {
      for (const a of steer ? [-steer, 0, steer] : [0]) {
        const c = Math.cos(a), s = Math.sin(a);
        let hits = 0;
        for (let i = 0; i < pb.vertexCount; i++) {
          const dx = pb.pos[i * 3] - wx, dy = pb.pos[i * 3 + 1] - R, dz = pb.pos[i * 3 + 2] - wz;
          // into the wheel's own frame (turned by the steer about the vertical)
          const lx = dx * c - dz * s, lz = dx * s + dz * c;
          const r = Math.hypot(dy, lz);
          // inside the tyre's rubber (the arms end inside the rim, at the drum that closes the wheel)
          if (Math.abs(lx) < W / 2 + 0.005 && r > rimR && r < R + 0.01) hits++;
        }
        expect(hits, `wheel at z ${wz}, steer ${a.toFixed(2)}`).toBe(0);
        // and the sculpted body is clear of the tread at that steer
        let worst = Infinity;
        for (let k = 0; k < 48; k++) {
          const t = (k / 48) * Math.PI * 2;
          for (const lx of [-W / 2, 0, W / 2]) {
            const ly = Math.sin(t) * R, lz = Math.cos(t) * R;
            worst = Math.min(worst, bp.body(wx + lx * c + lz * s, R + ly, wz - lx * s + lz * c));
          }
        }
        expect(worst).toBeGreaterThan(0.02);
      }
    }
  });

  it('stands its mirrors on stalks from the chassis, out past the halo', () => {
    const L = mirrorLayout(spec);
    expect(L.interior).toBeNull();
    expect(L.screen).toBeNull();
    const root = L.housing.stalk!;
    expect(bp.body(root[0], root[1], root[2])).toBeLessThan(0);
    expect(bp.body(-root[0], root[1], root[2])).toBeLessThan(0);
    // the glass is out in the air, beyond the chassis and the halo, 19 x 5 cm
    expect(bp.body(...L.left.pos)).toBeGreaterThan(0.1);
    expect(L.left.pos[0]).toBeGreaterThan(Math.max(...haloPath(spec).hoop.map((p) => p[0])) + 0.15);
    expect(L.left.halfW * 2).toBeCloseTo(0.19, 6);
    expect(L.left.halfH * 2).toBeCloseTo(0.05, 6);
  });

  it('lays its livery out on its own panels: the roundel on the sidepod, the number on the nose, carbon under the paint', () => {
    const lay = computeLayout(spec).livery;
    // the roundel on the sidepod's flank: the body's side there faces out, wider than the roundel is tall
    expect(sideX(bp.body, lay.door.y, lay.door.z)).toBeGreaterThan(0.4);
    expect(sideX(bp.body, lay.door.y + lay.door.r, lay.door.z)).toBeGreaterThan(0.35);
    expect(sideX(bp.body, lay.door.y - lay.door.r, lay.door.z)).toBeGreaterThan(0.35);
    // the number on the top of the nose, which is wider there than the number
    const top = topY(bp.body, 0, lay.hood.z);
    expect(top).toBeGreaterThan(0.45);
    expect(sideX(bp.body, top - 0.03, lay.hood.z)).toBeGreaterThan(lay.hood.r);
    expect(lay.belt).toBe(0.5);
    expect(lay.trueRound).toBe(true);
    // (no pattern lift, no dust: the patterns are drawn as they are)
    expect(lay.rise).toBeUndefined();
    expect(lay.patternZ).toBeUndefined();
    expect(lay.hoodArrow).toBeUndefined();
  });
});

describe('Volta wheels', () => {
  const wheel = (q: WheelParams['quality'], rear = false): WheelParams => ({
    R: rear ? spec.wheelRadiusRear : spec.wheelRadiusFront,
    W: rear ? spec.tireWidthRear : spec.tireWidthFront,
    rimR: rear ? spec.rimRadiusRear : spec.rimRadiusFront,
    style: styleForBody(spec.style),
    quality: q,
  });

  it('rides on 18 inch rims closed by panels, slicks on them, no spokes to see or blur', () => {
    expect(styleForBody('formula')).toBe('formula');
    expect(Math.round((spec.rimRadiusFront * 2) / 0.0254)).toBe(18);
    expect(Math.round((spec.rimRadiusRear * 2) / 0.0254)).toBe(18);
    const look = wheelLook('formula');
    expect(look.slick).toBe(1);
    expect(look.tread).toBe(0);
    const pb = buildWheel(wheel('high'));
    const ids = new Set<number>();
    let panel = 0;
    let panelR = 0;
    for (let i = 0; i < pb.vertexCount; i++) {
      const id = Math.round(pb.zon[i * ZONE_STRIDE + 13]);
      ids.add(id);
      if (id === PART.discHat) {
        panel++;
        panelR = Math.max(panelR, Math.hypot(pb.pos[i * 3 + 1], pb.pos[i * 3 + 2]));
      }
    }
    // the closing panel reaches out to the rim's lip; there is no blur disc (part 26) and no brake disc behind it
    expect(panel).toBeGreaterThan(100);
    expect(panelR).toBeGreaterThan(spec.rimRadiusFront - 0.01);
    expect(ids.has(PART.blurDisc)).toBe(false);
    expect(ids.has(PART.disc)).toBe(false);
    expect(ids.has(PART.nut)).toBe(true);
  });

  it('closes the rim on its inboard side too, round the brake, out to the tyre\'s bead', () => {
    for (const rear of [false, true]) {
      const p = wheel('high', rear);
      const pb = buildCaliper(p, true);
      let maxR = 0;
      let inboard = Infinity;
      for (let i = 0; i < pb.vertexCount; i++) {
        expect(Math.round(pb.zon[i * ZONE_STRIDE + 13])).toBe(PART.shield);
        maxR = Math.max(maxR, Math.hypot(pb.pos[i * 3 + 1], pb.pos[i * 3 + 2]));
        inboard = Math.min(inboard, pb.pos[i * 3]);
      }
      expect(maxR).toBeGreaterThan(p.rimR);
      expect(inboard).toBeLessThan(-0.43 * p.W - 0.03);
      expect(pb.triangleCount).toBeLessThan(1500);
    }
  });

  it('stays inside the wheel triangle budget at every quality, and finishes the tyre\'s inner sidewall as finely as the outer one', () => {
    for (const q of ['low', 'medium', 'high', 'ultra'] as const) {
      for (const rear of [false, true]) expect(buildWheel(wheel(q, rear)).triangleCount, q).toBeLessThan(11500);
    }
    // the sidewall rings on each side of the tyre
    const pb = buildWheel(wheel('high'));
    const sides = { in: new Set<number>(), out: new Set<number>() };
    for (let i = 0; i < pb.vertexCount; i++) {
      if (Math.round(pb.zon[i * ZONE_STRIDE + 13]) !== PART.tire || pb.zon[i * ZONE_STRIDE + 2] < 0.5) continue;
      const x = pb.pos[i * 3];
      (x < 0 ? sides.in : sides.out).add(Math.round(Math.hypot(pb.pos[i * 3 + 1], pb.pos[i * 3 + 2]) * 1e4));
    }
    expect(sides.in.size).toBe(sides.out.size);
  });
});

describe('Volta triangle budgets', () => {
  it('stays inside the budgets at every quality: near body, AI body, far body', async () => {
    for (const q of ['low', 'medium', 'high', 'ultra'] as const) {
      const d = await buildCarData(spec, q);
      const tri = (n: number): number => n / 3;
      const moving = (d.moving ?? []).reduce((s, m) => s + tri(m.data.index.length), 0);
      expect(tri(d.lod0.paintIndex.length) + moving, q).toBeLessThan(110000);
      expect(tri(d.lod1.paintIndex.length) + moving, q).toBeLessThan(60000);
      expect(tri(d.lod2.index.length), q).toBeLessThan(10000);
      expect(d.lod0.glassIndex.length, q).toBe(0);
    }
  }, 120000);
});

describe('Volta cockpit', () => {
  const eye = eyePoint(spec);
  const lay = computeLayout(spec);
  const inside = makeInterior(spec, 'high');
  const { hoop, pillar } = haloPath(spec);
  /** A point of the steering wheel's own frame (+x the driver's right, the driver looking at +z) in the body frame, the wheel straight. */
  const onWheel = (p: V): V => {
    const t = Math.atan2(inside.wheelNormal[1], -inside.wheelNormal[2]);
    const c = Math.cos(t), s = Math.sin(t);
    const w = inside.wheelPos;
    return [w[0] - p[0], w[1] + p[1] * c + p[2] * s, w[2] + p[1] * s - p[2] * c];
  };
  /** The vertices of a mesh, with their part ids and zone channel 14. */
  const verts = (d: { vertices: Float32Array }): Array<{ p: V; part: number; z14: number }> => {
    const out: Array<{ p: V; part: number; z14: number }> = [];
    for (let o = 0; o < d.vertices.length; o += VERTEX_STRIDE) {
      out.push({ p: [d.vertices[o], d.vertices[o + 1], d.vertices[o + 2]], part: Math.round(d.vertices[o + 6 + 13]), z14: d.vertices[o + 6 + 14] });
    }
    return out;
  };
  /** How close the segment a..b comes to the halo's tubes (to their surface: negative when it goes through one). */
  const haloClearance = (a: V, b: V): number => {
    const tubes: Array<[V, V, number]> = [];
    for (let i = 0; i < hoop.length - 1; i++) tubes.push([hoop[i] as V, hoop[i + 1] as V, 0.024]);
    tubes.push([pillar[0] as V, pillar[1] as V, 0.03]);
    let near = Infinity;
    for (let k = 0; k <= 200; k++) {
      const t = k / 200;
      const p: V = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      for (const [u, v, r] of tubes) {
        const d: V = [v[0] - u[0], v[1] - u[1], v[2] - u[2]];
        const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        const s = Math.max(0, Math.min(1, ((p[0] - u[0]) * d[0] + (p[1] - u[1]) * d[1] + (p[2] - u[2]) * d[2]) / l2));
        near = Math.min(near, dist(p, [u[0] + d[0] * s, u[1] + d[1] * s, u[2] + d[2] * s]) - r);
      }
    }
    return near;
  };
  /** The body's field along the segment from a to b, short of its last `stop` metres (the thing looked at), at its lowest. */
  const bodyClearance = (a: V, b: V, stop: number): number => {
    const L = dist(a, b);
    let low = Infinity;
    for (let k = 0; k <= 200; k++) {
      const t = (k / 200) * (1 - stop / L);
      low = Math.min(low, bp.body(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t));
    }
    return low;
  };

  it("holds an F1 yoke 28 cm across, its display and its fifteen shift lights live parts of their own, the driver's hands on its grips", () => {
    const w = verts(inside.wheel);
    const display = w.filter((v) => v.part === IPART.wheelDisplay);
    const lights = w.filter((v) => v.part === IPART.shiftLights);
    expect(display.length).toBeGreaterThan(0);
    // (the display's corners are where the shader draws it from: YOKE)
    for (const v of display) {
      expect(Math.abs(v.p[0] - YOKE.display.x)).toBeLessThanOrEqual(YOKE.display.hw + 1e-6);
      expect(Math.abs(v.p[1] - YOKE.display.y)).toBeLessThanOrEqual(YOKE.display.hh + 1e-6);
    }
    // fifteen lights, each where the shader's count puts it
    const slot = (x: number): number => Math.round((x - YOKE.lights.x0) / YOKE.lights.step);
    expect([...new Set(lights.map((v) => slot(v.p[0])))].sort((a, b) => a - b)).toEqual(Array.from({ length: YOKE.lights.n }, (_, i) => i));
    for (const v of lights) expect(Math.abs(v.p[0] - YOKE.lights.x0 - slot(v.p[0]) * YOKE.lights.step)).toBeLessThan(0.004);
    // the wheel (its gloves aside) is 28 cm across and 16 cm tall; no other car has these parts
    const bare = w.filter((v) => v.part !== IPART.glove);
    const span = (k: 0 | 1): number => Math.max(...bare.map((v) => v.p[k])) - Math.min(...bare.map((v) => v.p[k]));
    expect(span(0)).toBeGreaterThan(0.26);
    expect(span(0)).toBeLessThan(0.3);
    expect(span(1)).toBeLessThan(0.18);
    for (const c of CARS.filter((c) => c.visual.style !== 'formula')) {
      expect(verts(makeInterior(c.visual, 'low').wheel).some((v) => v.part === IPART.wheelDisplay || v.part === IPART.shiftLights), c.id).toBe(false);
    }
    // the driver's hands (seen from outside, on the T-camera) are on the grips, where the wheel's own gloves are
    const gloves = verts(inside.driver).filter((v) => v.part === IPART.glove);
    for (const sg of [1, -1]) {
      const g = gloves.filter((v) => Math.sign(v.p[0]) === sg);
      expect(g.length).toBeGreaterThan(5);
      const mx = g.reduce((s, v) => s + Math.abs(v.p[0]), 0) / g.length;
      expect(Math.abs(mx - YOKE.gripX)).toBeLessThan(0.03);
    }
  });

  it('turns its yoke to the lock either way (120 degrees) with its grips and gloves clear of the chassis', () => {
    const lock = steeringLock(volta);
    expect(lock).toBeCloseTo((120 * Math.PI) / 180, 2);
    const w = inside.wheel.vertices;
    for (const a of [-lock, -lock / 2, 0, lock / 2, lock]) {
      let into = 0;
      for (let o = 0; o < w.length; o += VERTEX_STRIDE) {
        const x = w[o] * Math.cos(a) - w[o + 1] * Math.sin(a);
        const y = w[o] * Math.sin(a) + w[o + 1] * Math.cos(a);
        if (bp.body(...onWheel([x, y, w[o + 2]])) < -0.001) into++;
      }
      expect(into, `turned ${a.toFixed(2)} rad`).toBe(0);
    }
  });

  it("shows the driver the display, the shift lights and both mirrors past the cockpit's rim, the halo and its pillar", () => {
    for (const [name, p] of [['display', onWheel([YOKE.display.x, YOKE.display.y, 0.014])], ['lights', onWheel([0, YOKE.lights.y, 0.015])]] as Array<[string, V]>) {
      expect(bodyClearance(eye, p, 0.02), name).toBeGreaterThan(0);
      expect(haloClearance(eye, p), name).toBeGreaterThan(0.02);
      // in the default cockpit view (+-36 degrees up and down)
      expect(Math.atan2(p[1] - eye[1], p[2] - eye[2]), name).toBeGreaterThan(-34 * (Math.PI / 180));
    }
    const L = mirrorLayout(spec);
    for (const m of [L.left, L.right]) {
      expect(bodyClearance(eye, m.pos, 0.02)).toBeGreaterThan(0.01);
      expect(haloClearance(eye, m.pos)).toBeGreaterThan(0.02);
    }
  });

  it("keeps its cabin in the tub: inside the chassis, or in the cockpit's opening under the helmet's centre (the headrest on the rim)", () => {
    const base = bp.debug!.base;
    const well = bp.debug!.well;
    let out = 0;
    for (const v of verts(inside.cabin)) {
      const [x, y, z] = v.p;
      if (base(x, y, z) < 0.005) continue;
      if (well(x, 0.6, z) < 0 && y < inside.head[1]) continue;
      out++;
    }
    expect(out).toBe(0);
    // and no cluster: the display is the yoke's (no cabin vertex is on the cluster's face)
    for (let o = 0; o < inside.cabin.vertices.length; o += VERTEX_STRIDE) expect(inside.cabin.vertices[o + 6 + 1]).toBe(1);
  });

  it("draws the helmet as a zone, its rim round the neck cut smooth, on the single-seater's driver only", () => {
    const d = verts(inside.driver);
    expect(d.some((v) => v.part === IPART.helmet)).toBe(false);
    const helmet = d.filter((v) => v.z14 < 0);
    expect(helmet.length).toBeGreaterThan(100);
    for (const v of helmet) {
      expect(dist(v.p, inside.head)).toBeLessThan(0.2);
      // (its rim is level, 12.5 cm under the helmet's centre)
      expect(v.p[1]).toBeGreaterThan(inside.head[1] - 0.126);
    }
    for (const c of CARS.filter((c) => c.visual.style !== 'formula')) {
      const o = verts(makeInterior(c.visual, 'low').driver);
      expect(o.every((v) => v.z14 === 1), c.id).toBe(true);
      expect(o.some((v) => v.part === IPART.helmet), c.id).toBe(true);
    }
  });

  it('films it from clear of the body: the T-camera over the airbox, the nose camera ahead of the front axle, the look back from behind the T-camera', () => {
    // the T-camera's pod on the roll hoop (formulaParts.ts), and the look back's camera, 14 cm over the chase anchor (render/cameraRig.ts)
    const pod: V = [0, spec.height + 0.02, eye[2] - 0.05 - 0.52];
    const back: V = [lay.chase[0], lay.chase[1] + 0.14, lay.chase[2]];
    expect(lay.hood[1]).toBeGreaterThan(topY(bp.body, 0, lay.hood[2]) + 0.06);
    expect(bp.body(...lay.hood)).toBeGreaterThan(0.06);
    expect(lay.bumper[2]).toBeGreaterThan(spec.wheelbase / 2 + 0.3);
    // (the bumper camera's near plane is 12 cm: nothing of the nose that close in front of it)
    expect(bp.body(...lay.bumper)).toBeGreaterThan(0.09);
    expect(bp.body(lay.bumper[0], lay.bumper[1], lay.bumper[2] + 0.12)).toBeGreaterThan(0.09);
    expect(bp.body(...back)).toBeGreaterThan(0.12);
    expect(back[2]).toBeLessThan(pod[2] - 0.05 - 0.04);
    // the chase anchor is also the roof the cameras size the car by
    expect(lay.chase[1]).toBe(spec.height);
    // the eye: in the cockpit, under the halo (the halo's test above), clear of the body
    expect(bp.body(...eye)).toBeGreaterThan(0.08);
  });

  it("draws the halo's pillar faint in the cockpit view: a see-through copy over the body, which leaves the pillar out meanwhile", () => {
    const U = createBodyUniforms();
    const m = createPillarMaterial(U, 0.35);
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBe(0.35);
    expect(m.depthWrite).toBe(false);
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
      fragmentShader:
        '#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <normal_fragment_maps>\n#include <emissivemap_fragment>\n#include <lights_physical_fragment>\n#include <aomap_fragment>',
    };
    m.onBeforeCompile(shader as never, null as never);
    // the copy shares the car's uniforms (dents, livery, wet) but never leaves the pillar out; the body's switch starts off
    expect(shader.uniforms.uPrimary).toBe(U.uPrimary);
    expect(shader.uniforms.uPillarGhost).not.toBe(U.uPillarGhost);
    expect(shader.uniforms.uPillarGhost.value).toBe(0);
    expect(U.uPillarGhost.value).toBe(0);
    expect(shader.fragmentShader).toContain('if (uPillarGhost > 0.5 && zPart == 16 && vZ3.z < 0.0) discard;');
  });
});
