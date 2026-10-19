import { describe, expect, it } from 'vitest';
import { PART, ZONE_STRIDE } from '../src/carvis/blueprint';
import { BLUEPRINTS } from '../src/carvis/bodies';
import { DMG_VERT_PARS } from '../src/carvis/damageShader';
import { computeLayout, eyePoint, wheelLook } from '../src/carvis/layouts';
import { makeInterior } from '../src/carvis/interior';
import { PartBuilder } from '../src/carvis/parts';
import { BODY_FRAG_ZONES } from '../src/carvis/shaders';
import { buildWheel, styleForBody, wheelLayout, type WheelParams } from '../src/carvis/wheels';
import { CARS, getCar } from '../src/cars';

/** The Mammoth's own look: a body of its own, parts that stay rigid, a light bar that lights, side pipes where the flames are, lugs. */
const mammoth = getCar('mammoth');
const spec = mammoth.visual;
const zTail = -(spec.wheelbase / 2 + (spec.length - spec.wheelbase - spec.frontOverhang));
const zNose = spec.wheelbase / 2 + spec.frontOverhang;

/** The static parts of the body, as the vertices of each part id: [x, y, z, ...] */
function partsOf(): { byPart: Map<number, number[][]>; flagged: number[][]; pb: PartBuilder } {
  const bp = BLUEPRINTS.suv(spec);
  const pb = new PartBuilder();
  bp.parts!(pb);
  const byPart = new Map<number, number[][]>();
  const flagged: number[][] = [];
  for (let i = 0; i < pb.vertexCount; i++) {
    const id = Math.round(pb.zon[i * ZONE_STRIDE + 13]);
    const v = [pb.pos[i * 3], pb.pos[i * 3 + 1], pb.pos[i * 3 + 2]];
    if (!byPart.has(id)) byPart.set(id, []);
    byPart.get(id)!.push(v);
    if (pb.zon[i * ZONE_STRIDE + 14] < 0) flagged.push(v);
  }
  return { byPart, flagged, pb };
}

describe('Mammoth body', () => {
  it('has a body of its own, not the hatch it borrowed first', () => {
    expect(BLUEPRINTS.suv).not.toBe(BLUEPRINTS.hatch);
    expect(typeof BLUEPRINTS.suv(spec).parts).toBe('function');
  });

  it('keeps its static parts finite, inside the polygonization bounds, and under a triangle budget', () => {
    const { pb } = partsOf();
    const b = BLUEPRINTS.suv(spec).bounds;
    expect(pb.pos.every(Number.isFinite)).toBe(true);
    expect(pb.nor.every(Number.isFinite)).toBe(true);
    expect(pb.idx.every((i) => i >= 0 && i < pb.vertexCount)).toBe(true);
    // (a part outside the bounds is outside the culling sphere of the mesh and pops out of view at the screen's edge)
    for (let i = 0; i < pb.vertexCount; i++) {
      for (let k = 0; k < 3; k++) {
        expect(pb.pos[i * 3 + k]).toBeGreaterThan(b.min[k] - 0.02);
        expect(pb.pos[i * 3 + k]).toBeLessThan(b.max[k] + 0.02);
      }
    }
    expect(pb.triangleCount).toBeLessThan(16000);
  });

  it('carries the LED light bar across the front of the roof, its lens flagged for the shader', () => {
    const { byPart, flagged } = partsOf();
    // (the bumper's two LED pods are the same part: the bar is what stands over the roof)
    const lit = byPart.get(PART.lightBar) ?? [];
    const bar = lit.filter((v) => v[1] > 1.5);
    expect(bar.length).toBeGreaterThan(100);
    const xs = bar.map((v) => v[0]);
    expect(Math.min(...xs)).toBeLessThan(-0.6);
    expect(Math.max(...xs)).toBeGreaterThan(0.6);
    // above the roof, in the front half of the cabin, inside the body's width
    for (const v of bar) {
      expect(v[1]).toBeGreaterThan(spec.height - 0.01);
      expect(v[2]).toBeGreaterThan(0.2);
      expect(v[2]).toBeLessThan(0.7);
      expect(Math.abs(v[0])).toBeLessThan(spec.width / 2);
    }
    // the lens is the flagged part of it, and faces forward
    const lens = flagged.filter((v) => v[1] > 1.5);
    expect(lens.length).toBeGreaterThan(8);
    expect(Math.max(...lens.map((v) => v[2]))).toBeGreaterThanOrEqual(Math.max(...bar.map((v) => v[2])) - 0.015);
    // and a pod in each corner of the front bumper lights with it
    for (const sg of [-1, 1]) {
      const pod = lit.filter((v) => v[1] < 1 && v[0] * sg > 0.6 && v[2] > zNose - 0.05);
      expect(pod.length, 'LED pod on side ' + sg).toBeGreaterThan(8);
      expect(flagged.some((v) => v[1] < 1 && v[0] * sg > 0.6)).toBe(true);
    }
  });

  it('lights the bar with the headlamps in the shader, and keeps its new parts out of the paint', () => {
    // the lens glows with uHead (the headlamps), and goes dark when both headlamps are broken (uLampOut)
    const branch = BODY_FRAG_ZONES.match(/zPart == 13\) \{[\s\S]*?\} else if \(zPart == 14\)/)?.[0] ?? '';
    expect(branch).toContain('uHead');
    expect(branch).toContain('uLampOut');
    for (const id of [PART.lightBar, PART.rugged, PART.signal]) expect(BODY_FRAG_ZONES).toMatch(new RegExp(`zPart == ${id}\\) *\\{`));
    const notPaint = BODY_FRAG_ZONES.match(/if \(zPart == 1 \|\| [^\n]*\) zIsPaint = 0\.0;/)?.[0] ?? '';
    for (const id of [PART.lightBar, PART.rugged, PART.signal]) expect(notPaint).toContain(`zPart == ${id}`);
  });

  it('keeps flares, hooks, bars and the light bar rigid in a crash: only body, carbon, accent and dark paint crumple', () => {
    expect(DMG_VERT_PARS).toMatch(/\(pr < 0\.5 \|\| pr == 1\.0 \|\| pr == 5\.0 \|\| pr == 10\.0\) \? 1\.0 : 0\.0/);
    const { byPart } = partsOf();
    // the orange recovery hooks are the signal colour (rigid), at both ends of the car
    const signal = byPart.get(PART.signal) ?? [];
    expect(signal.some((v) => v[2] > zNose - 0.1 && Math.abs(v[0] - 0.56) < 0.08)).toBe(true);
    expect(signal.some((v) => v[2] > zNose - 0.1 && Math.abs(v[0] + 0.56) < 0.08)).toBe(true);
    expect(signal.some((v) => v[2] < zTail + 0.1 && Math.abs(v[0] - 0.56) < 0.08)).toBe(true);
    expect(signal.some((v) => v[2] < zTail + 0.1 && Math.abs(v[0] + 0.56) < 0.08)).toBe(true);
    // and the flares stand proud of the door skin on both sides of both wheels
    const rugged = byPart.get(PART.rugged) ?? [];
    for (const [x, z] of [[1, spec.wheelbase / 2], [-1, spec.wheelbase / 2], [1, -spec.wheelbase / 2], [-1, -spec.wheelbase / 2]]) {
      expect(rugged.some((v) => v[0] * x > spec.width / 2 && Math.abs(v[2] - z) < 0.6 && v[1] > 0.9)).toBe(true);
    }
  });

  it('puts a snorkel up the right A-pillar (the passenger side, -x), over the roof line', () => {
    const { byPart } = partsOf();
    const tall = (byPart.get(PART.rugged) ?? []).filter((v) => v[1] > spec.height + 0.04 && Math.abs(v[0]) > 0.85);
    expect(tall.length).toBeGreaterThan(20);
    for (const v of tall) expect(v[0]).toBeLessThan(0);
  });

  it('draws the side-exit pipes where the exhaust effects blow their flames', () => {
    // src/render/effects.ts buildTips: side tips at x = +-(width/2 - 0.02), z = -wheelbase/2 + 0.6, y = rideHeight + 0.2
    const { byPart } = partsOf();
    const tipY = spec.rideHeight + 0.2;
    const tipZ = -spec.wheelbase / 2 + 0.6;
    const rim = byPart.get(PART.chrome) ?? [];
    for (const sg of [-1, 1]) {
      const tip: [number, number, number] = [sg * (spec.width / 2 - 0.02), tipY, tipZ];
      const near = rim.filter((v) => Math.hypot(v[0] - tip[0], v[1] - tip[1], v[2] - tip[2]) < 0.06);
      expect(near.length, `pipe rim on side ${sg}`).toBeGreaterThan(8);
    }
  });
});

describe('Mammoth running gear and cabin', () => {
  const wheel = (quality: WheelParams['quality']): PartBuilder =>
    buildWheel({ R: spec.wheelRadiusFront, W: spec.tireWidthFront, rimR: spec.rimRadiusFront, style: styleForBody(spec.style), quality });

  it('rides on beadlock wheels with a treaded tyre, and the other four keep their own', () => {
    expect(styleForBody('suv')).toBe('beadlock');
    expect(styleForBody('gt')).toBe('multi');
    expect(styleForBody('hatch')).toBe('split5');
    expect(styleForBody('coupe')).toBe('six');
    expect(styleForBody('prototype')).toBe('centerlock');
    const look = wheelLook('suv');
    expect(look.slick).toBe(0);
    expect(look.tread).toBe(1);
    expect(wheelLayout({ R: 0.43, W: 0.315, rimR: 0.254, style: 'beadlock', quality: 'high' }).xOut).toBeLessThan(0.43 * 0.315);
  });

  it('cuts the tyre like a saw: lugs stand at least 12 mm over the floor of the grooves, round the whole wheel', () => {
    const pb = wheel('high');
    const R = spec.wheelRadiusFront;
    // the tread's centre line: every vertex within 2 cm of the middle of the tyre, as a radius
    const radii: number[] = [];
    let lugVerts = 0;
    for (let i = 0; i < pb.vertexCount; i++) {
      const id = Math.round(pb.zon[i * ZONE_STRIDE + 13]);
      if (id !== 20 && id !== 21) continue;
      if (id === 21) lugVerts++;
      if (Math.abs(pb.pos[i * 3]) < 0.02) radii.push(Math.hypot(pb.pos[i * 3 + 1], pb.pos[i * 3 + 2]));
    }
    expect(lugVerts).toBeGreaterThan(1000);
    expect(Math.max(...radii)).toBeGreaterThan(R - 0.003);
    expect(Math.max(...radii)).toBeLessThan(R + 0.003);
    expect(Math.min(...radii)).toBeLessThan(R - 0.012);
    // no vertex of the tyre or its lugs is outside the nominal radius by more than 3 mm
    for (let i = 0; i < pb.vertexCount; i++) {
      const id = Math.round(pb.zon[i * ZONE_STRIDE + 13]);
      if (id === 20 || id === 21) expect(Math.hypot(pb.pos[i * 3 + 1], pb.pos[i * 3 + 2])).toBeLessThan(R + 0.003);
    }
  });

  it('stays inside the wheel triangle budget at every quality', () => {
    for (const q of ['low', 'medium', 'high', 'ultra'] as const) expect(wheel(q).triangleCount, q).toBeLessThan(11500);
  });

  it('sits its driver high and upright: a raised cabin, the eye well under the roof, a big round wheel', () => {
    const eye = eyePoint(spec);
    expect(eye[1]).toBeGreaterThan(1.35);
    expect(eye[1]).toBeLessThan(spec.height - 0.2);
    const it = makeInterior(spec, 'low');
    let maxY = 0, maxX = 0;
    for (let i = 0; i < it.cabin.vertices.length; i += 22) {
      maxY = Math.max(maxY, it.cabin.vertices[i + 1]);
      maxX = Math.max(maxX, Math.abs(it.cabin.vertices[i]));
    }
    expect(maxY).toBeGreaterThan(1.1);
    expect(maxY).toBeLessThan(spec.height - 0.1);
    expect(maxX).toBeLessThan(spec.width / 2 - 0.05);
    // the steering wheel: 41 cm round rim (the others are 35-36 cm)
    let wheelR = 0;
    for (let i = 0; i < it.wheel.vertices.length; i += 22) wheelR = Math.max(wheelR, Math.hypot(it.wheel.vertices[i], it.wheel.vertices[i + 1]));
    expect(wheelR).toBeGreaterThan(0.2);
    // (and the head stays inside the cabin)
    expect(it.head[1]).toBeLessThan(spec.height - 0.15);
  });

  it('lifts the livery patterns onto the 4x4 and leaves the other cars exactly as they were drawn', () => {
    const own = computeLayout(spec).livery;
    expect(own.rise).toBeDefined();
    expect(own.rise!.scale).toBeGreaterThan(1);
    expect(own.door.y).toBeGreaterThan(0.85);
    for (const c of CARS.filter((c) => c.id !== 'mammoth')) {
      const lay = computeLayout(c.visual).livery;
      expect(lay.rise, c.id).toBeUndefined();
      expect(lay.patternZ, c.id).toBeUndefined();
      expect(lay.hoodArrow, c.id).toBeUndefined();
    }
  });
});
