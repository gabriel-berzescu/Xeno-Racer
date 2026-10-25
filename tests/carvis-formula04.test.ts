import { describe, expect, it } from 'vitest';
import { getCar, CARS } from '../src/cars';
import { PART, ZONE_STRIDE } from '../src/carvis/blueprint';
import { BLUEPRINTS } from '../src/carvis/bodies';
import { makeFormula } from '../src/carvis/bodies/formula';
import { chimney04, periscopeMouth04 } from '../src/carvis/bodies/formula04Parts';
import { frontZ, sideX, topY } from '../src/carvis/bodies/probe';
import { buildCarData, VERTEX_STRIDE, type CarData } from '../src/carvis/build';
import { steeringLock } from '../src/carvis/car';
import { makeDamageGeometry } from '../src/carvis/damageGeometry';
import { DENT_PARTS } from '../src/carvis/damageShader';
import { IPART, makeInterior, WHEEL04, YOKE } from '../src/carvis/interior';
import { computeLayout, eyePoint, formula04Points, formulaCockpit, isFormula04, wheelLook } from '../src/carvis/layouts';
import { glassOutline, mirrorLayout } from '../src/carvis/mirrorLayout';
import { inGlassFrame } from '../src/carvis/mirrorParts';
import { PartBuilder } from '../src/carvis/parts';
import { buildCaliper, buildWheel, styleForBody, type WheelParams } from '../src/carvis/wheels';
import { createWheelMaterial } from '../src/carvis/wheelMaterial';
import { opponentLivery } from '../src/game/liveries';

/** The Dieci's own look: a 2004 single-seater with a high nose, the front wing hung under it, periscopes, a beam wing, 13-inch grooved wheels. */
const dieci = getCar('dieci');
const spec = dieci.visual;
const zF = spec.wheelbase / 2;
const zR = -spec.wheelbase / 2;
const zNose = zF + spec.frontOverhang;
const zTail = -(spec.wheelbase / 2 + (spec.length - spec.wheelbase - spec.frontOverhang));
const bp = BLUEPRINTS.formula(spec);
const pts = formula04Points(spec);

type V = [number, number, number];
/** The static parts as the vertices of each part id. */
function partsOf(build: (b: PartBuilder) => void): { byPart: Map<number, V[]>; pb: PartBuilder } {
  const pb = new PartBuilder();
  build(pb);
  const byPart = new Map<number, V[]>();
  for (let i = 0; i < pb.vertexCount; i++) {
    const id = Math.round(pb.zon[i * ZONE_STRIDE + 13]);
    if (!byPart.has(id)) byPart.set(id, []);
    byPart.get(id)!.push([pb.pos[i * 3], pb.pos[i * 3 + 1], pb.pos[i * 3 + 2]]);
  }
  return { byPart, pb };
}
const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const all = (m: Map<number, V[]>): V[] => [...m.values()].flat();

let dataHigh: Promise<CarData> | null = null;
const high = (): Promise<CarData> => (dataHigh ??= buildCarData(spec, 'high'));

describe('Dieci body', () => {
  it("has a 2004 body of its own from the single-seater's blueprint, with parts, far parts and its lamps, and nothing that moves", () => {
    expect(isFormula04(spec)).toBe(true);
    // (the era is the Dieci's alone: the Volta, with none, keeps the body it had)
    for (const c of CARS) expect(isFormula04(c.visual), c.id).toBe(c.id === 'dieci');
    expect(BLUEPRINTS.formula(getCar('volta').visual).moving?.map((m) => m.name)).toEqual(['frontFlaps', 'rearFlaps']);
    expect(Object.keys(bp.info!)).toEqual(Object.keys(makeFormula(getCar('volta').visual).info!));
    expect(typeof bp.parts).toBe('function');
    expect(typeof bp.farParts).toBe('function');
    expect(bp.info?.lamps?.length).toBe(4);
    // no flaps open in 2004: the wings are static parts
    expect(bp.moving).toBeUndefined();
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

  it("has the 2004 build sheet's silhouette: the high nose's tip, the airbox, the engine cover falling to the rear axle", () => {
    // the tip of the nose about 0.97 m ahead of the front axle, 29-38 cm off the ground
    expect(frontZ(bp.body, 0, 0.33) - zF).toBeGreaterThan(0.93);
    expect(frontZ(bp.body, 0, 0.33) - zF).toBeLessThan(spec.frontOverhang + 0.01);
    expect(frontZ(bp.body, 0, 0.27)).toBeLessThan(zF);
    expect(frontZ(bp.body, 0, 0.29) - zF).toBeGreaterThan(0.9);
    expect(frontZ(bp.body, 0, 0.38) - zF).toBeGreaterThan(0.9);
    expect(frontZ(bp.body, 0, 0.41)).toBeLessThan(zNose - 0.08);
    // the top of the nose 0.58 m over the front axle; the airbox 0.95 m, and the engine cover 0.70-0.75 at 2.6 m behind the front axle
    // and 0.55 over the rear axle
    expect(topY(bp.body, 0, zF)).toBeCloseTo(0.585, 1);
    let top = 0;
    for (let z = zR; z < zF; z += 0.02) top = Math.max(top, topY(bp.body, 0, z));
    expect(top).toBeGreaterThan(spec.height - 0.01);
    expect(top).toBeLessThan(spec.height + 0.01);
    expect(topY(bp.body, 0, zF - 2.6)).toBeGreaterThan(0.68);
    expect(topY(bp.body, 0, zF - 2.6)).toBeLessThan(0.76);
    expect(topY(bp.body, 0, zR)).toBeCloseTo(0.555, 1);
    // the cockpit's rim under the driver's eye, beside the helmet and at the front of the opening
    const eye = eyePoint(spec);
    expect(eye[1] - topY(bp.body, 0.22, eye[2])).toBeGreaterThan(0.05);
    expect(eye[1] - topY(bp.body, 0.22, eye[2])).toBeLessThan(0.12);
  });

  it('hangs the front wing under the nose on two pylons, its middle dipped into a spoon, and stands the rear wing over a beam wing', () => {
    const { byPart } = partsOf((b) => bp.parts!(b));
    const carbon = byPart.get(PART.carbon)!;
    const wing = all(byPart).filter((v) => v[2] > zF + spec.wheelRadiusFront + 0.05 && v[1] < 0.36);
    // 1.40 m across, its endplates' outer faces 70 cm out, ahead of the tyres' outer faces
    expect(Math.max(...wing.map((v) => v[0]))).toBeCloseTo(0.7, 2);
    // the outer mainplane 10-30 cm over the floor (the rules of 2004, over a 5 cm ride height), the spoon in the middle lower
    const outer = carbon.filter((v) => v[2] > zF + 0.45 && Math.abs(v[0]) > 0.32 && Math.abs(v[0]) < 0.6 && v[1] < 0.2);
    const spoon = carbon.filter((v) => v[2] > zF + 0.45 && Math.abs(v[0]) < 0.04 && v[1] < 0.2);
    expect(Math.min(...outer.map((v) => v[1]))).toBeGreaterThan(0.1);
    expect(Math.min(...spoon.map((v) => v[1]))).toBeLessThan(Math.min(...outer.map((v) => v[1])) - 0.04);
    expect(Math.max(...wing.map((v) => v[1]))).toBeLessThan(spec.rideHeight + 0.31);
    // the two pylons: carbon plates either side of the centre line, their feet in the spoon and their tops in the nose's underside
    const pylon = carbon.filter((v) => v[2] > zNose - 0.26 && Math.abs(Math.abs(v[0]) - 0.065) < 0.006);
    for (const sg of [1, -1]) {
      const side = pylon.filter((v) => Math.sign(v[0]) === sg);
      expect(Math.min(...side.map((v) => v[1]))).toBeLessThan(0.1);
      expect(Math.max(...side.map((v) => v[1]))).toBeGreaterThan(0.3);
    }
    for (const v of pylon.filter((p) => p[1] > 0.3)) expect(bp.body(...v)).toBeLessThan(0.002);
    // the rear wing: a metre across, its flap's top 83 cm up under its endplates' 84.5, its trailing edge no more than half a metre behind
    // the rear axle
    const rw = all(byPart).filter((v) => v[2] < zR - 0.05 && v[1] > 0.6 && Math.abs(v[0]) < 0.49);
    expect(Math.max(...rw.map((v) => v[1]))).toBeGreaterThan(0.82);
    expect(Math.max(...rw.map((v) => v[1]))).toBeLessThan(0.845);
    expect(Math.min(...rw.map((v) => v[2]))).toBeGreaterThan(zR - 0.5);
    // (the bodywork behind the rear axle no wider than a metre: the wing's elements and its endplates)
    const behind = [...(byPart.get(PART.body) ?? []), ...(byPart.get(PART.accent) ?? []), ...carbon.filter((v) => v[1] > 0.6)].filter((v) => v[2] < zR - 0.05);
    expect(Math.max(...behind.map((v) => Math.abs(v[0])))).toBeLessThan(0.51);
    // the beam wing: carbon nearly a metre across 38-48 cm up behind the rear axle (the Volta has none)
    const beam = carbon.filter((v) => v[2] < zR - 0.02 && v[2] > zR - 0.3 && v[1] > 0.38 && v[1] < 0.48);
    expect(Math.max(...beam.map((v) => Math.abs(v[0])))).toBeGreaterThan(0.45);
  });

  it('has no halo, no fin on the engine cover, no LED strips and no moving flaps, and builds its periscopes into the bodywork', () => {
    const { byPart } = partsOf((b) => bp.parts!(b));
    expect(byPart.has(PART.halo)).toBe(false);
    expect(byPart.has(PART.ledRed)).toBe(false);
    expect(byPart.has(PART.titanium)).toBe(false);
    // no fin: nothing painted stands on the centre line over the engine cover behind the airbox
    const fin = (byPart.get(PART.body) ?? []).filter((v) => Math.abs(v[0]) < 0.02 && v[2] < eyePoint(spec)[2] - 0.6 && v[2] > zR);
    expect(fin.length).toBe(0);
  });

  it('sculpts the periscopes on the sidepods, their mouths where the exhaust effects blow the flames, facing up and back, each an open pipe', () => {
    const { at, dir } = pts.periscope;
    // on the surface, the stack under it solid, the air over it clear
    expect(Math.abs(bp.body(...at))).toBeLessThan(0.006);
    expect(bp.body(at[0] - dir[0] * 0.05, at[1] - dir[1] * 0.05, at[2] - dir[2] * 0.05)).toBeLessThan(-0.02);
    expect(bp.body(at[0] + dir[0] * 0.05, at[1] + dir[1] * 0.05, at[2] + dir[2] * 0.05)).toBeGreaterThan(0.03);
    expect(bp.body(-at[0], at[1] - dir[1] * 0.05, at[2] - dir[2] * 0.05)).toBeLessThan(-0.02);
    // up and 40 degrees back from the vertical, a little outward; on the sidepod's top beside the engine cover, 60 cm ahead of the axle
    expect(Math.hypot(...dir)).toBeCloseTo(1, 9);
    expect((Math.acos(dir[1]) * 180) / Math.PI).toBeGreaterThan(35);
    expect((Math.acos(dir[1]) * 180) / Math.PI).toBeLessThan(45);
    expect(dir[2]).toBeLessThan(0);
    expect(dir[0]).toBeGreaterThan(0);
    expect(at[2] - zR).toBeCloseTo(0.6, 6);
    // the mouth an oval 10 x 7 cm round that point, its long axis along the car, square to the axis
    const m = periscopeMouth04(spec);
    expect(m.at).toEqual(at);
    expect(m.dir).toEqual(dir);
    expect([m.a * 2, m.b * 2]).toEqual([0.1, 0.07]);
    for (const w of [m.u, m.v]) {
      expect(Math.hypot(...w)).toBeCloseTo(1, 9);
      expect(w[0] * dir[0] + w[1] * dir[1] + w[2] * dir[2]).toBeCloseTo(0, 9);
    }
    expect(m.v[2]).toBeGreaterThan(0.75);
    // black inside, the pipe, and in the 14 mm of soot round the lip; no grille (the mouths of the cooling vents have it)
    const zoneAt = (p: readonly number[]): Float32Array => {
      const zb = new Float32Array(ZONE_STRIDE).fill(1);
      bp.zones(p[0], p[1], p[2], dir[0], dir[1], dir[2], zb, 0);
      return zb;
    };
    const across = (r: number): V => [at[0] + m.u[0] * r, at[1] + m.u[1] * r, at[2] + m.u[2] * r];
    for (const r of [0, 0.02, m.b + 0.008]) {
      expect(zoneAt(across(r))[1], `${r} m across`).toBeLessThan(0);
      expect(zoneAt(across(r))[3], `${r} m across`).toBeGreaterThan(0);
    }
    expect(zoneAt(across(m.b + 0.03))[1]).toBeGreaterThan(0);
    // the lip: carbon round the mouth, from inside the stack to 12 mm over its top, on both periscopes
    const { byPart } = partsOf((b) => bp.parts!(b));
    const lip = byPart.get(PART.carbon)!.filter((p) => dist([Math.abs(p[0]), p[1], p[2]], at) < m.a + 0.005);
    const t = (p: V): number => (Math.abs(p[0]) - at[0]) * dir[0] + (p[1] - at[1]) * dir[1] + (p[2] - at[2]) * dir[2];
    for (const sg of [1, -1]) {
      const side = lip.filter((p) => Math.sign(p[0]) === sg);
      expect(side.length).toBeGreaterThan(100);
      expect(Math.max(...side.map(t))).toBeCloseTo(0.012, 6);
      expect(Math.min(...side.map(t))).toBeLessThan(-0.02);
      for (const p of side.filter((q) => t(q) < -0.02)) expect(bp.body(...p)).toBeLessThan(-0.005);
    }
  });

  it("stands a chimney on each sidepod's shoulder: a part painted with the sidepod, rising out of it, open at the top over a grille", () => {
    const m = chimney04(spec);
    const { pb } = partsOf((b) => bp.parts!(b));
    // (the sculpted body has none: the air 3 cm under the mouth)
    expect(bp.body(m.at[0] - m.dir[0] * 0.03, m.at[1] - m.dir[1] * 0.03, m.at[2] - m.dir[2] * 0.03)).toBeGreaterThan(0.01);
    // up, out and a little back, 55 cm behind the cockpit's reference (5 cm behind the eye) and 40 cm out
    expect(m.at[2]).toBeCloseTo(eyePoint(spec)[2] - 0.6, 6);
    expect(m.at[0]).toBeCloseTo(0.405, 6);
    expect(m.dir[1]).toBeGreaterThan(0.9);
    expect(m.dir[0]).toBeGreaterThan(0.25);
    expect(m.dir[2]).toBeLessThan(0);
    for (const sg of [1, -1]) {
      const near: { p: V; part: number; grille: number }[] = [];
      for (let i = 0; i < pb.vertexCount; i++) {
        const p: V = [pb.pos[i * 3], pb.pos[i * 3 + 1], pb.pos[i * 3 + 2]];
        if (Math.sign(p[0]) === sg && dist([Math.abs(p[0]), p[1], p[2]], m.at) < 0.11) near.push({ p, part: pb.zon[i * ZONE_STRIDE + 13], grille: pb.zon[i * ZONE_STRIDE + 3] });
      }
      const t = (p: V): number => (Math.abs(p[0]) - m.at[0]) * m.dir[0] + (p[1] - m.at[1]) * m.dir[1] + (p[2] - m.at[2]) * m.dir[2];
      const stack = near.filter((v) => v.part === PART.body);
      expect(stack.length).toBeGreaterThan(100);
      // its foot inside the sidepod, its top at the mouth, clear of the sidepod by more than 4 cm there
      for (const v of stack.filter((q) => t(q.p) < -0.08)) expect(bp.body(...v.p)).toBeLessThan(-0.01);
      expect(Math.max(...stack.map((v) => t(v.p)))).toBeCloseTo(0, 6);
      expect(bp.body(sg * m.at[0], m.at[1], m.at[2])).toBeGreaterThan(0.04);
      // the grille: a disc 15 mm down inside the lip, 6.8 cm across
      const grille = stack.filter((v) => v.grille < 0);
      expect(grille.length).toBeGreaterThan(20);
      for (const v of grille) expect(t(v.p)).toBeCloseTo(-0.015, 6);
      const r = Math.max(...grille.map((v) => dist([Math.abs(v.p[0]), v.p[1], v.p[2]], m.at)));
      expect(r).toBeGreaterThan(0.033);
      expect(r).toBeLessThan(0.038);
    }
  });

  it('keeps its wings, its far LOD and the helmet in the far LOD (and so in the shadow an AI car casts), coloured by the paint they wear', async () => {
    const data = await high();
    const far = data.lod2;
    const nb = far.stats.bodyVertices;
    const n = far.vertices.length / VERTEX_STRIDE;
    expect(n - nb).toBeGreaterThan(150);
    let frontWing = 0, rearWing = 0, beam = 0, helmet = 0, halo = 0, pylonTop = 0;
    const eye = eyePoint(spec);
    for (let i = nb; i < n; i++) {
      const o = i * VERTEX_STRIDE;
      const x = far.vertices[o], y = far.vertices[o + 1], z = far.vertices[o + 2];
      const part = Math.round(far.vertices[o + 6 + 13]);
      if (z > zF + 0.4 && y < 0.35 && Math.abs(x) > 0.6) frontWing++;
      if (z < zR - 0.05 && y > 0.6 && Math.abs(x) > 0.45) rearWing++;
      if (z < zR && y > 0.38 && y < 0.48 && Math.abs(x) > 0.4) beam++;
      // the pylon that holds the front wing up to the nose: its top inside the nose
      if (part === PART.carbon && Math.abs(x) < 0.02 && z > zNose - 0.32 && y > 0.29) {
        pylonTop++;
        expect(bp.body(x, y - 0.002, z)).toBeLessThan(0.01);
      }
      if (part === PART.halo) halo++;
      if (part === PART.body && dist([x, y, z], [eye[0], eye[1] - 0.03, eye[2] - 0.07]) < 0.2) helmet++;
      expect(far.colors![i * 3]).toBeCloseTo(part === PART.body ? 1 : 0.05, 6);
    }
    expect(frontWing).toBeGreaterThan(8);
    expect(rearWing).toBeGreaterThan(8);
    expect(beam).toBeGreaterThan(4);
    expect(pylonTop).toBeGreaterThan(2);
    expect(halo).toBe(0);
    expect(helmet).toBeGreaterThan(20);
  }, 120000);

  it("gives the damage model its four lamps: the LEDs in the nose's tip, and the rain light's two halves for its tail lamps", async () => {
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
      // on the sculpted tip of the nose, in its head-lamp zone (z1.x < 0), the body's vertices round it carrying the zone's field
      expect(Math.abs(bp.body(l.c[0], l.c[1], l.c[2]))).toBeLessThan(0.01);
      expect(l.c[2]).toBeGreaterThan(zNose - 0.07);
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
    // the rain light: within 10 cm of the centre line, at least 35 cm over the floor and 45 cm behind the rear axle (the rules of the time),
    // its block on PART.rainLight, the two tail lamps its halves
    expect(Math.abs(pts.rainLight[0])).toBeLessThan(0.1);
    expect(pts.rainLight[1]).toBeGreaterThanOrEqual(spec.rideHeight + 0.35);
    expect(zR - pts.rainLight[2]).toBeGreaterThanOrEqual(0.45);
    for (const [i, side] of [[2, 1], [3, -1]] as const) {
      const l = lamps[i];
      expect(Math.sign(l.c[0])).toBe(side);
      expect(dist(l.c, pts.rainLight)).toBeLessThan(0.04);
      let lit = 0;
      for (let k = nb; k < n; k++) {
        const o = k * VERTEX_STRIDE;
        if (Math.round(v[o + 6 + 13]) === PART.rainLight && dist([v[o], v[o + 1], v[o + 2]], l.c) < l.r + 0.03) lit++;
      }
      expect(lit).toBeGreaterThan(8);
    }
    // the headlamp spots shine from just ahead of the nose's tip, at the LEDs' height, clear of the car; the tail light is the rain light
    const lay = computeLayout(spec);
    expect(lay.headlight[0]).toBeCloseTo(lamps[0].c[0], 6);
    expect(lay.headlight[1]).toBeCloseTo(lamps[0].c[1], 6);
    expect(lay.headlight[2]).toBeGreaterThan(zNose);
    expect(bp.body(lay.headlight[0], lay.headlight[1], lay.headlight[2])).toBeGreaterThan(0.01);
    expect(lay.taillight).toEqual(pts.rainLight);
  });

  it('crumples its lamps and its wings with what carries them, the rain light lying on the tip of the crash structure', () => {
    const { byPart } = partsOf((b) => bp.parts!(b));
    // (everything on it but the stalks, the suspension's driveshafts and the T-camera dents with the body: carbon, the livery's paint, the rain light)
    for (const id of byPart.keys()) {
      if (id === PART.plastic || id === PART.mirrorGlass) continue;
      expect(DENT_PARTS, `part ${id}`).toContain(id === PART.body ? PART.accent : id);
    }
    const rain = byPart.get(PART.rainLight)!;
    expect(rain.length).toBeGreaterThan(8);
    for (const v of rain) expect(bp.body(...v)).toBeLessThan(0.012);
    // an upright block, taller than it is wide
    const w = Math.max(...rain.map((v) => v[0])) - Math.min(...rain.map((v) => v[0]));
    const h = Math.max(...rain.map((v) => v[1])) - Math.min(...rain.map((v) => v[1]));
    expect(h).toBeGreaterThan(w);
  });

  it('keeps its wings, floor and suspension clear of the tyres, the front ones steered to the lock and beyond', () => {
    const { pb } = partsOf((b) => bp.parts!(b));
    const lock = dieci.physics.chassis.maxSteer * 1.15;
    const wheels: Array<[number, number, number, number, number, number]> = [
      [spec.trackFront / 2, zF, spec.wheelRadiusFront, spec.tireWidthFront, spec.rimRadiusFront, lock],
      [spec.trackRear / 2, zR, spec.wheelRadiusRear, spec.tireWidthRear, spec.rimRadiusRear, 0],
    ];
    for (const [wx, wz, R, W, rimR, steer] of wheels) {
      for (const a of steer ? [-steer, 0, steer] : [0]) {
        const c = Math.cos(a), s = Math.sin(a);
        let hits = 0;
        for (let i = 0; i < pb.vertexCount; i++) {
          const dx = pb.pos[i * 3] - wx, dy = pb.pos[i * 3 + 1] - R, dz = pb.pos[i * 3 + 2] - wz;
          const lx = dx * c - dz * s, lz = dx * s + dz * c;
          const r = Math.hypot(dy, lz);
          if (Math.abs(lx) < W / 2 + 0.005 && r > rimR && r < R + 0.01) hits++;
        }
        expect(hits, `wheel at z ${wz}, steer ${a.toFixed(2)}`).toBe(0);
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

  it("stands its mirrors on stalks from the front of the sidepods, the glass where the Volta's is on the screen", () => {
    const L = mirrorLayout(spec);
    const eye = eyePoint(spec);
    expect(L.interior).toBeNull();
    expect(L.screen).toBeNull();
    const root = L.housing.stalk!;
    expect(bp.body(root[0], root[1], root[2])).toBeLessThan(0);
    expect(bp.body(-root[0], root[1], root[2])).toBeLessThan(0);
    // the root on the sidepod, ahead of the cockpit's rim
    expect(root[0]).toBeGreaterThan(0.33);
    // the housing and its glass out in the air, 7 cm clear of the sidepod's lip under them at their nearest (the half egg behind the
    // glass, mirrorParts.ts); the glass 15 x 5 cm (the rules of the time: at least 12 x 5), 40 degrees off the driver's line of sight, 8
    // under it
    let near = Infinity;
    for (let i = 0; i <= 8; i++) {
      const phi = (i / 8) * (Math.PI / 2);
      for (const [gx, gy] of glassOutline(1.07 * L.left.halfW * Math.cos(phi), 1.14 * L.left.halfH * Math.cos(phi))) {
        near = Math.min(near, bp.body(...inGlassFrame(L.left, gx, gy, -L.housing.depth * Math.sin(phi))));
      }
    }
    expect(near).toBeGreaterThan(0.07);
    expect(L.left.halfW * 2).toBeCloseTo(0.15, 6);
    expect(L.left.halfH * 2).toBeCloseTo(0.05, 6);
    const az = (Math.atan2(L.left.pos[0] - eye[0], L.left.pos[2] - eye[2]) * 180) / Math.PI;
    const el = (Math.atan2(L.left.pos[1] - eye[1], Math.hypot(L.left.pos[0] - eye[0], L.left.pos[2] - eye[2])) * 180) / Math.PI;
    expect(az).toBeGreaterThan(38);
    expect(az).toBeLessThan(42);
    expect(el).toBeGreaterThan(-9);
    expect(el).toBeLessThan(-7);
    // the rear camera over the rear wing and its endplates
    expect(L.rear.pos[1]).toBeGreaterThan(0.845 + 0.08);
  });

  it('lays its livery out on its own panels: the roundel on the sidepod, the number on the high nose; a default livery no opponent copies', () => {
    const lay = computeLayout(spec).livery;
    expect(sideX(bp.body, lay.door.y, lay.door.z)).toBeGreaterThan(0.4);
    expect(sideX(bp.body, lay.door.y + lay.door.r, lay.door.z)).toBeGreaterThan(0.35);
    expect(sideX(bp.body, lay.door.y - lay.door.r, lay.door.z)).toBeGreaterThan(0.35);
    const top = topY(bp.body, 0, lay.hood.z);
    expect(top).toBeGreaterThan(0.45);
    expect(sideX(bp.body, top - 0.03, lay.hood.z)).toBeGreaterThan(lay.hood.r);
    expect(lay.belt).toBe(0.5);
    expect(lay.trueRound).toBe(true);
    // no opponent wears its pattern in a colour near its own (a split in orange and black once nearly copied it)
    const hex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const mine = dieci.defaultLivery;
    for (let i = 0; i < 12; i++) {
      const o = opponentLivery(i, dieci);
      if (o.pattern !== mine.pattern) continue;
      expect(dist(hex(o.primary), hex(mine.primary)), o.primary).toBeGreaterThan(120);
    }
  });

  it('films it from clear of the body: the T-camera on the airbox over the helmet, the nose camera over the high nose, the look back behind the T-camera', () => {
    const lay = computeLayout(spec);
    const back: V = [lay.chase[0], lay.chase[1] + 0.14, lay.chase[2]];
    // the T-camera's pod: black, on top of the airbox, and the hood camera just ahead of it
    const { byPart } = partsOf((b) => bp.parts!(b));
    const pod = (byPart.get(PART.plastic) ?? []).filter((v) => v[1] > spec.height);
    expect(pod.length).toBeGreaterThan(8);
    const podZ = Math.max(...pod.map((v) => v[2]));
    expect(lay.hood[2]).toBeGreaterThan(podZ);
    expect(lay.hood[1]).toBeGreaterThan(Math.max(...pod.map((v) => v[1])));
    expect(bp.body(...lay.hood)).toBeGreaterThan(0.06);
    expect(lay.hood[2]).toBeLessThan(eyePoint(spec)[2] - 0.2);
    // the nose camera ahead of the front axle over the nose (its near plane is 12 cm: nothing of the nose that close in front of it)
    expect(lay.bumper[2]).toBeGreaterThan(zF + 0.3);
    expect(bp.body(...lay.bumper)).toBeGreaterThan(0.09);
    expect(bp.body(lay.bumper[0], lay.bumper[1], lay.bumper[2] + 0.12)).toBeGreaterThan(0.09);
    expect(bp.body(...back)).toBeGreaterThan(0.12);
    expect(back[2]).toBeLessThan(podZ - 0.1);
    expect(lay.chase[1]).toBe(spec.height);
    expect(bp.body(...eyePoint(spec))).toBeGreaterThan(0.08);
  });
});

describe('Dieci cockpit', () => {
  const eye = eyePoint(spec);
  const inside = makeInterior(spec, 'high');
  const L = WHEEL04.lights;
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
  /** The body's field along the segment from a to b, short of its last `stop` metres (the thing looked at), at its lowest. */
  const bodyClearance = (a: V, b: V, stop: number): number => {
    const len = dist(a, b);
    let low = Infinity;
    for (let k = 0; k <= 200; k++) {
      const t = (k / 200) * (1 - stop / len);
      low = Math.min(low, bp.body(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t));
    }
    return low;
  };

  it("seats the driver as the build sheet has it: the eye 73 cm up and 1.42 m behind the front axle, just over the cockpit's sides, on the centre line", () => {
    expect(eye[1]).toBeCloseTo(0.73, 6);
    expect(zF - eye[2]).toBeCloseTo(1.42, 6);
    // (a seat on the centre line: looking back, the camera rig cuts to the rear camera over the car, render/cameraRig.ts)
    expect(Math.abs(computeLayout(spec).eye[0])).toBeLessThan(0.05);
    expect(spec.openCockpit).toBe(true);
    // the helmet's top 80-85 cm up, the rim beside it 62-68 cm (the build sheet's)
    expect(inside.head[1] + 0.138).toBeGreaterThan(0.8);
    expect(inside.head[1] + 0.138).toBeLessThan(0.85);
    expect(topY(bp.body, 0.22, eye[2])).toBeGreaterThan(0.62);
    expect(topY(bp.body, 0.22, eye[2])).toBeLessThan(0.68);
    // the cockpit is its era's: the 2004 wheel and its own posture, where the Volta keeps its 2026 numbers
    const c = formulaCockpit(spec);
    expect(c.wheel.kind).toBe('wheel04');
    const v = formulaCockpit(getCar('volta').visual);
    expect(v.wheel.kind).toBe('yoke');
    expect(v.seatTilt).toBe(1.05);
    expect(v.eye[1] - getCar('volta').visual.seat.y).toBeCloseTo(0.55, 9);
  });

  it("holds a 2004 butterfly wheel 27 cm across, its display, its ten shift lights along the top edge and its buttons live parts of their own, the driver's hands on its grips", () => {
    const w = verts(inside.wheel);
    const D = WHEEL04.display;
    const display = w.filter((v) => v.part === IPART.wheelDisplay04);
    expect(display.length).toBeGreaterThan(0);
    // (the display's corners are where the shader draws it from: WHEEL04)
    for (const v of display) {
      expect(Math.abs(v.p[0] - D.x)).toBeLessThanOrEqual(D.hw + 1e-6);
      expect(Math.abs(v.p[1] - D.y)).toBeLessThanOrEqual(D.hh + 1e-6);
    }
    // ten round lights, each where the shader's count puts it, along the top edge (its ends higher than its middle)
    const lights = w.filter((v) => v.part === IPART.shiftLights04);
    const slot = (x: number): number => Math.round((x - L.x0) / L.step);
    expect([...new Set(lights.map((v) => slot(v.p[0])))].sort((a, b) => a - b)).toEqual(Array.from({ length: L.n }, (_, i) => i));
    for (const v of lights) {
      const x = L.x0 + slot(v.p[0]) * L.step;
      expect(Math.abs(v.p[0] - x)).toBeLessThan(0.005);
      expect(Math.abs(v.p[1] - (L.y + L.rise * (x / L.x0) ** 2))).toBeLessThan(0.005);
    }
    const top = Math.max(...w.filter((v) => v.part !== IPART.glove).map((v) => v.p[1]));
    for (const v of lights) expect(v.p[1]).toBeGreaterThan(D.y + D.hh);
    expect(top - Math.max(...lights.map((v) => v.p[1]))).toBeLessThan(0.03);
    // every button and pointer near one of the buttons or rotary switches the shader colours, and every one of those there
    const buttons = w.filter((v) => v.part === IPART.wheelButtons04);
    const coloured = [...WHEEL04.buttons, ...WHEEL04.rotaries];
    for (const v of buttons) expect(Math.min(...coloured.map(([x, y]) => Math.hypot(v.p[0] - x, v.p[1] - y)))).toBeLessThan(0.0085);
    for (const [x, y] of coloured) expect(buttons.some((v) => Math.hypot(v.p[0] - x, v.p[1] - y) < 0.0085)).toBe(true);
    // the wheel (its gloves aside) is 26-28 cm across and under 18 cm tall; no yoke on it, and no other car has these parts
    const bare = w.filter((v) => v.part !== IPART.glove);
    const span = (k: 0 | 1): number => Math.max(...bare.map((v) => v.p[k])) - Math.min(...bare.map((v) => v.p[k]));
    expect(span(0)).toBeGreaterThan(0.26);
    expect(span(0)).toBeLessThan(0.28);
    expect(span(1)).toBeLessThan(0.18);
    expect(w.some((v) => v.part === IPART.wheelDisplay || v.part === IPART.shiftLights)).toBe(false);
    const mine = [IPART.wheelDisplay04, IPART.shiftLights04, IPART.wheelButtons04] as number[];
    for (const c of CARS.filter((c) => c.id !== 'dieci')) {
      expect(verts(makeInterior(c.visual, 'low').wheel).some((v) => mine.includes(v.part)), c.id).toBe(false);
    }
    // the driver's hands (seen from outside, on the T-camera) are on the grips, where the wheel's own gloves are
    const gloves = verts(inside.driver).filter((v) => v.part === IPART.glove);
    for (const sg of [1, -1]) {
      const g = gloves.filter((v) => Math.sign(v.p[0]) === sg);
      expect(g.length).toBeGreaterThan(5);
      const mx = g.reduce((s, v) => s + Math.abs(v.p[0]), 0) / g.length;
      expect(Math.abs(mx - WHEEL04.gripX)).toBeLessThan(0.03);
      expect(Math.abs(mx - YOKE.gripX)).toBeGreaterThan(0.005);
    }
  });

  it("lights the last shift light before the Dieci's upshift, the first in its last 3000 rpm", () => {
    const lim = dieci.physics.engine.limiterRpm;
    const up = dieci.physics.drivetrain.upshiftRpm;
    expect((L.on0 + (L.n - 1) * L.onStep) * lim).toBeLessThan(up);
    expect(L.on0 * lim).toBeGreaterThan(up - 3000);
  });

  it('turns its wheel to the lock either way (120 degrees) with its grips and gloves clear of the chassis', () => {
    const lock = steeringLock(dieci);
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

  it("shows the driver the display, the shift lights and both mirrors past the cockpit's rim, in the default cockpit view", () => {
    for (const [name, p] of [['display', onWheel([WHEEL04.display.x, WHEEL04.display.y, 0.014])], ['lights', onWheel([0, L.y, 0.015])]] as Array<[string, V]>) {
      expect(bodyClearance(eye, p, 0.02), name).toBeGreaterThan(0);
      // in the default cockpit view (+-36 degrees up and down)
      expect(Math.atan2(p[1] - eye[1], p[2] - eye[2]), name).toBeGreaterThan(-34 * (Math.PI / 180));
    }
    const M = mirrorLayout(spec);
    for (const m of [M.left, M.right]) expect(bodyClearance(eye, m.pos, 0.02)).toBeGreaterThan(0.01);
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
    // and no cluster: the display is the wheel's (no cabin vertex is on the cluster's face)
    for (let o = 0; o < inside.cabin.vertices.length; o += VERTEX_STRIDE) expect(inside.cabin.vertices[o + 6 + 1]).toBe(1);
  });

  it("draws the helmet as a zone over the cockpit's rim, its own rim round the neck cut smooth, the shoulders under the cockpit's", () => {
    const d = verts(inside.driver);
    expect(d.some((v) => v.part === IPART.helmet)).toBe(false);
    const helmet = d.filter((v) => v.z14 < 0);
    expect(helmet.length).toBeGreaterThan(100);
    for (const v of helmet) {
      expect(dist(v.p, inside.head)).toBeLessThan(0.2);
      expect(v.p[1]).toBeGreaterThan(inside.head[1] - 0.126);
    }
    // nothing of the suit over the cockpit's rim beside the helmet (only the helmet shows over it, as the period's photos have it)
    for (const v of d.filter((v) => v.z14 >= 0 && v.part === IPART.suit && Math.abs(v.p[0]) > 0.2 && Math.abs(v.p[0]) < 0.28)) {
      expect(v.p[1]).toBeLessThan(topY(bp.body, Math.abs(v.p[0]), v.p[2]) + 0.005);
    }
  });

  it('has no halo and so no faint pillar in the cockpit view', async () => {
    const data = await high();
    const v = data.lod0.vertices;
    for (let o = 0; o < v.length; o += VERTEX_STRIDE) expect(Math.round(v[o + 6 + 13])).not.toBe(PART.halo);
  }, 120000);
});

describe('Dieci wheels', () => {
  const wheel = (q: WheelParams['quality'], rear = false): WheelParams => ({
    R: rear ? spec.wheelRadiusRear : spec.wheelRadiusFront,
    W: rear ? spec.tireWidthRear : spec.tireWidthFront,
    rimR: rear ? spec.rimRadiusRear : spec.rimRadiusFront,
    style: styleForBody(spec.style, spec.formulaEra),
    quality: q,
  });

  it('rides on 13-inch forged rims with twelve spokes that blur, a centre-lock nut and the tall sidewall of a 660 mm tyre', () => {
    expect(styleForBody('formula', 2004)).toBe('formula04');
    expect(styleForBody('formula')).toBe('formula');
    expect(Math.round((spec.rimRadiusFront * 2) / 0.0254)).toBe(13);
    expect(Math.round((spec.rimRadiusRear * 2) / 0.0254)).toBe(13);
    expect(spec.wheelRadiusFront - spec.rimRadiusFront).toBeCloseTo(0.165, 3);
    const pb = buildWheel(wheel('high'));
    const ids = new Set<number>();
    // the spokes: the rim face's vertices between the hub and the lip, counted by their angle round the axle
    const spokeAt = new Set<number>();
    for (let i = 0; i < pb.vertexCount; i++) {
      const id = Math.round(pb.zon[i * ZONE_STRIDE + 13]);
      ids.add(id);
      const r = Math.hypot(pb.pos[i * 3 + 1], pb.pos[i * 3 + 2]);
      if (id === PART.rimFace && r > 0.09 && r < 0.12) spokeAt.add(Math.round((Math.atan2(pb.pos[i * 3 + 2], pb.pos[i * 3 + 1]) / (2 * Math.PI)) * 12 + 12) % 12);
    }
    expect(spokeAt.size).toBe(12);
    expect(ids.has(PART.blurDisc)).toBe(true);
    expect(ids.has(PART.nut)).toBe(true);
    expect(ids.has(PART.discHat)).toBe(false);
    expect(ids.has(PART.disc)).toBe(false);
  });

  it("closes the rim on its inboard side with the brake duct's drum, out to the tyre's bead", () => {
    for (const rear of [false, true]) {
      const p = wheel('high', rear);
      const pb = buildCaliper(p, true);
      let maxR = 0;
      for (let i = 0; i < pb.vertexCount; i++) {
        expect(Math.round(pb.zon[i * ZONE_STRIDE + 13])).toBe(PART.shield);
        maxR = Math.max(maxR, Math.hypot(pb.pos[i * 3 + 1], pb.pos[i * 3 + 2]));
      }
      expect(maxR).toBeGreaterThan(p.rimR);
      expect(pb.triangleCount).toBeLessThan(1500);
    }
  });

  it('has grooved dry tyres, four grooves 14 mm wide and 50 mm apart, white lettering, and no other car has grooves', () => {
    const look = wheelLook(spec.style, spec.formulaEra);
    expect(look.grooves).toEqual([0.025, 0.075, 0.007, 0.0025]);
    expect(look.slick).toBe(1);
    expect(look.tread).toBe(0);
    for (const c of CARS) if (c.id !== 'dieci') expect(wheelLook(c.visual.style, c.visual.formulaEra).grooves, c.id).toBeUndefined();
    // inside the tread of both tyres
    for (const W of [spec.tireWidthFront, spec.tireWidthRear]) expect(look.grooves![1] + look.grooves![2]).toBeLessThan(0.3 * W);
  });

  it("draws the grooves, and the lettering of the inboard sidewall the right way round, with a wheel material of its own: every other car's wheel program is what it was, word for word", () => {
    const compile = (grooves: boolean): { vs: string; fs: string; key: string } => {
      const { material } = createWheelMaterial(undefined, grooves ? { grooves: true } : undefined);
      const shader = {
        uniforms: {} as Record<string, { value: unknown }>,
        vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
        fragmentShader:
          '#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <normal_fragment_maps>\n#include <emissivemap_fragment>\n#include <lights_physical_fragment>\n#include <aomap_fragment>',
      };
      material.onBeforeCompile(shader as never, null as never);
      return { vs: shader.vertexShader, fs: shader.fragmentShader, key: material.customProgramCacheKey() };
    };
    const plain = compile(false), grooved = compile(true);
    expect(plain.key).toBe('xr-wheel-v3');
    expect(grooved.key).not.toBe(plain.key);
    expect(plain.fs).not.toContain('uGrooves');
    expect(grooved.fs).toContain('uniform vec4 uGrooves;');
    expect(grooved.vs).toBe(plain.vs);
    // the grooved program mirrors the sidewall's lettering on the inboard face (object -x), right after the line that maps it round the
    // tyre, so that it reads the right way round from the cockpit; the plain one maps it the same way on both faces
    const ang = '    float ang = atan(vObjPos.y, vObjPos.z) * 0.15915494 + 0.5;\n';
    const flip = '    if (vObjPos.x < 0.0) ang = 1.0 - ang;\n';
    expect(plain.fs.split(ang).length).toBe(2);
    expect(plain.fs).not.toContain(flip);
    expect(grooved.fs.split(ang + flip).length).toBe(2);
    // the grooved program is the plain one with the uniform, the grooves' block after the road tyre's tread and that line added, and
    // nothing else
    const added = grooved.fs.replace('uniform vec4 uGrooves;\n', '').replace(ang + flip, ang);
    const at = added.indexOf('wRough = mix(wRough, 0.95, tread * uTread * 0.5);\n') + 'wRough = mix(wRough, 0.95, tread * uTread * 0.5);\n'.length;
    const end = added.indexOf('\n    }\n', at) + '\n    }\n'.length;
    expect(added.slice(0, at) + added.slice(end)).toBe(plain.fs);
    expect(added.slice(at, end)).toContain('uGrooves.w');
  });

  it("stays inside the wheel triangle budget at every quality, and finishes the tyre's inner sidewall as finely as the outer one", () => {
    for (const q of ['low', 'medium', 'high', 'ultra'] as const) {
      for (const rear of [false, true]) expect(buildWheel(wheel(q, rear)).triangleCount, q).toBeLessThan(11000);
    }
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

describe('Dieci triangle budgets', () => {
  it('stays inside the budgets at every quality: near body, AI body, far body', async () => {
    for (const q of ['low', 'medium', 'high', 'ultra'] as const) {
      const d = await buildCarData(spec, q);
      const tri = (n: number): number => n / 3;
      expect(d.moving, q).toBeUndefined();
      expect(tri(d.lod0.paintIndex.length), q).toBeLessThan(110000);
      expect(tri(d.lod1.paintIndex.length), q).toBeLessThan(60000);
      expect(tri(d.lod2.index.length), q).toBeLessThan(10000);
      expect(d.lod0.glassIndex.length, q).toBe(0);
    }
  }, 120000);
});
