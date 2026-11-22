import { describe, expect, it } from 'vitest';
import { PART, ZONE_STRIDE } from '../src/carvis/blueprint';
import { BLUEPRINTS } from '../src/carvis/bodies';
import { hyperFlank, hyperFrame, hyperGroove, hyperPoints, hyperWing } from '../src/carvis/bodies/hyperParts';
import { frontZ, rearZ, sideX, topY } from '../src/carvis/bodies/probe';
import { buildCarData, VERTEX_STRIDE } from '../src/carvis/build';
import { computeLayout, eyePoint, wheelLook } from '../src/carvis/layouts';
import { mirrorLayout } from '../src/carvis/mirrorLayout';
import { PartBuilder } from '../src/carvis/parts';
import { polygonize } from '../src/carvis/polygonize';
import { styleForBody } from '../src/carvis/wheels';
import { CARS, getCar } from '../src/cars';

/** The Taccola's own look: a body of its own, its nose, its spine, the scallop down its flank, its glass, its wing, and a mesh with edges. */
const taccola = getCar('taccola');
const spec = taccola.visual;
const { zF, zR, zNose, zTail } = hyperFrame(spec);
const bp = BLUEPRINTS.hyper(spec);
const body = bp.body;

/** The zone fields at the point of the surface above (x, z). */
function zonesOnTop(x: number, z: number): { y: number; z: Float32Array } {
  const y = topY(body, x, z);
  const out = new Float32Array(ZONE_STRIDE).fill(1);
  bp.zones(x, y, z, 0, 1, 0, out, 0);
  return { y, z: out };
}

describe('Taccola body', () => {
  it('is the only hypercar, with a body of its own: parts, a wing that moves and is kept in the far LOD, and a mesh with hard edges', () => {
    expect(CARS.filter((c) => c.visual.style === 'hyper').map((c) => c.id)).toEqual(['taccola']);
    expect(typeof bp.parts).toBe('function');
    expect(typeof bp.farParts).toBe('function');
    expect(bp.moving?.map((m) => [m.name, m.drive])).toEqual([['wing', 'aero']]);
    expect(bp.sharp).toBe(true);
    // (no other body asks the mesher for hard edges: their meshes are what they were)
    for (const c of CARS) if (c !== taccola) expect(BLUEPRINTS[c.visual.style](c.visual).sharp, c.id).toBeUndefined();
  });

  it('is as long, as wide and as tall as its sheet says: 1.12 m to the roof and 1.17 to the top of its scoop', () => {
    expect(frontZ(body, 0, 0.3)).toBeGreaterThan(zNose - 0.06);
    expect(frontZ(body, 0, 0.3)).toBeLessThan(zNose + 0.01);
    // (low on the corner, beside the diffuser: the tail is raked, and the fascia between is set 10 cm in)
    expect(rearZ(body, 0.8, 0.3)).toBeLessThan(zTail + 0.06);
    expect(rearZ(body, 0.8, 0.3)).toBeGreaterThan(zTail - 0.01);
    // (just ahead of the rear wheel's arch, where the flank is at its widest but for the arch itself)
    expect(sideX(body, 0.5, zR + 0.5)).toBeGreaterThan(spec.width / 2 - 0.04);
    expect(sideX(body, 0.5, zR + 0.5)).toBeLessThan(spec.width / 2 + 0.005);
    // the roof beside the scoop, and the scoop over it
    expect(topY(body, 0.2, 0.2)).toBeGreaterThan(1.09);
    expect(topY(body, 0.2, 0.2)).toBeLessThan(1.13);
    let top = 0;
    for (let z = -1.2; z <= 0.2; z += 0.05) top = Math.max(top, topY(body, 0, z));
    expect(top).toBeGreaterThan(1.15);
    expect(top).toBeLessThan(spec.height + 0.03);
  });

  it('has a beak between two pontoons with an open channel each side, and a spine between two haunches with a valley each side', () => {
    // 40 cm ahead of the front axle: the channel's floor well under the beak, the pontoon well over it
    const z = zF + 0.4;
    const beak = topY(body, 0, z), channel = topY(body, 0.42, z), pontoon = topY(body, 0.78, z);
    expect(beak - channel).toBeGreaterThan(0.2);
    expect(pontoon - beak).toBeGreaterThan(0.08);
    // the pontoon peaks over the axle, over its tyre
    expect(topY(body, 0.79, zF)).toBeGreaterThan(spec.wheelRadiusFront * 2 + 0.05);
    // behind the cabin: the spine, the valley, the haunch over the rear tyre
    const spine = topY(body, 0, zR), valley = topY(body, 0.42, zR), haunch = topY(body, 0.79, zR);
    expect(spine - valley).toBeGreaterThan(0.15);
    expect(haunch - valley).toBeGreaterThan(0.1);
    expect(haunch).toBeGreaterThan(spec.wheelRadiusRear * 2 + 0.08);
    // and the wheels fill their arches: nothing of the body where the tyres are
    expect(body(spec.trackFront / 2, spec.wheelRadiusFront, zF)).toBeGreaterThan(0);
    expect(body(spec.trackRear / 2, spec.wheelRadiusRear, zR)).toBeGreaterThan(0);
  });

  it('has a scallop down each flank: an undercut lip over a hollow that deepens to the intake, cut from the flank itself', () => {
    const flank = hyperFlank(spec);
    const g = hyperGroove(spec);
    for (const z of [0.6, 0.0, -0.4]) {
      const side = flank.at(z);
      expect(g.sideAt(z)).toBe(side);
      // above the lip the flank is the flank; just under it the body is cut well in; 25 cm further down it is the flank again
      const lip = 0.52 - 0.04 * z;
      expect(sideX(body, lip + 0.03, z)).toBeGreaterThan(side - 0.01);
      const cut = side - sideX(body, lip - 0.04, z);
      expect(cut, `z ${z}`).toBeGreaterThan(0.05);
      expect(side - sideX(body, lip - 0.27, z)).toBeLessThan(0.012);
    }
    // deeper to the rear: 18 cm where it ends
    expect(flank.at(-0.4) - sideX(body, 0.52 + 0.016 - 0.06, -0.4)).toBeGreaterThan(flank.at(0.6) - sideX(body, 0.52 - 0.024 - 0.06, 0.6) + 0.05);
    // it ends in the wall ahead of the rear wheel, and is not cut ahead of the front one
    expect(sideX(body, 0.45, -0.8)).toBeGreaterThan(flank.at(-0.8) - 0.01);
    expect(sideX(body, 0.45, zF + 0.5)).toBeGreaterThan(0.9);
    // the intake's mesh is a part in that wall, on each side, and the flames' tailpipes are where hyperPoints says
    const pb = new PartBuilder();
    bp.parts!(pb);
    let meshL = 0, meshR = 0, pipes = 0;
    const P = hyperPoints(spec);
    for (let i = 0; i < pb.vertexCount; i++) {
      const x = pb.pos[i * 3], y = pb.pos[i * 3 + 1], zz = pb.pos[i * 3 + 2];
      const part = Math.round(pb.zon[i * ZONE_STRIDE + 13]);
      if (part === PART.body && pb.zon[i * ZONE_STRIDE + 3] < 0) {
        expect(Math.abs(zz - g.wallZ(y))).toBeLessThan(0.02);
        if (x > 0) meshL++;
        else meshR++;
      }
      if (part === PART.titanium) {
        pipes++;
        expect(Math.min(...P.exhausts.map((e) => Math.hypot(x - e[0], y - e[1])))).toBeLessThan(0.06);
      }
    }
    expect(meshL).toBeGreaterThan(10);
    expect(meshR).toBe(meshL);
    expect(pipes).toBeGreaterThan(40);
    expect(P.exhausts.map((e) => e[0])).toEqual([-0.225, -0.075, 0.075, 0.225]);
  });

  it('is glass from the belt up, with a slim pillar well to the left of the driver and a carbon roof', () => {
    const eye = eyePoint(spec);
    expect(eye[0]).toBeCloseTo(spec.seat.x, 6);
    // straight ahead of the eye the windscreen is glass, all the way from its foot to the header
    for (const z of [0.5, 0.8, 1.05]) expect(zonesOnTop(eye[0], z).z[0], `z ${z}`).toBeLessThan(0);
    // the pillar: paint, 5.6 cm of it, along a line from 57 cm out at the foot to 42 at the header
    for (const z of [0.5, 0.8, 1.05]) {
      const px = 0.42 + 0.197 * (z - 0.36);
      expect(zonesOnTop(px, z).z[0], `z ${z}`).toBeGreaterThan(0);
      expect(zonesOnTop(px - 0.05, z).z[0], `z ${z}`).toBeLessThan(0);
      expect(px - eye[0]).toBeGreaterThan(0.12);
    }
    // beside it the glass goes on round the side; over the driver the roof is carbon, not glass
    const side = new Float32Array(ZONE_STRIDE).fill(1);
    bp.zones(sideX(body, 0.85, 0.4), 0.85, 0.4, 1, 0, 0, side, 0);
    expect(side[0]).toBeLessThan(0);
    const roof = zonesOnTop(0.15, -0.1).z;
    expect(roof[0]).toBeGreaterThan(0);
    expect(roof[2]).toBeLessThan(0);
    // the cameras and the mirrors are the hypercar's own: a display of the rear camera, no mirror in the cabin
    const L = mirrorLayout(spec);
    expect(L.interior).toBeNull();
    expect(L.screen).not.toBeNull();
    expect(L.left.pos[0]).toBeGreaterThan(spec.width / 2 - 0.06);
    const lay = computeLayout(spec);
    expect(lay.headlight[2]).toBeGreaterThan(zF + 0.6);
    expect(lay.livery.door.y + lay.livery.door.r).toBeLessThan(0.5);
  });

  it('carries a wing on two arms that stands pitched in corner mode and lies down flat over the tail in straight mode', () => {
    const w = hyperWing(spec);
    const m = bp.moving![0];
    expect(m.pivot).toEqual(w.pivot);
    expect(m.axis).toEqual([1, 0, 0]);
    expect(m.angle).toBe(w.swing);
    const pb = new PartBuilder();
    m.build(pb);
    // the blade's own vertices: the carbon ones out past the arms
    const blade: number[][] = [];
    for (let i = 0; i < pb.vertexCount; i++) {
      if (Math.round(pb.zon[i * ZONE_STRIDE + 13]) !== PART.carbon) continue;
      const x = pb.pos[i * 3];
      if (Math.abs(x) > w.armX + 0.1) blade.push([x, pb.pos[i * 3 + 1], pb.pos[i * 3 + 2]]);
    }
    expect(blade.length).toBeGreaterThan(40);
    const ends = (pts: number[][]): { le: number[]; te: number[] } => ({ le: pts.reduce((a, b) => (b[2] > a[2] ? b : a)), te: pts.reduce((a, b) => (b[2] < a[2] ? b : a)) });
    const rest = ends(blade);
    // corner mode: the trailing edge well above the leading edge, the blade clear over the haunches, inside the car's length
    expect(rest.te[1] - rest.le[1]).toBeGreaterThan(0.06);
    expect(rest.le[1]).toBeGreaterThan(topY(body, 0.79, zR) + 0.03);
    expect(rest.te[2]).toBeGreaterThan(zTail - 0.06);
    expect(Math.max(...blade.map((p) => Math.abs(p[0])))).toBeLessThan(spec.width / 2);
    // straight mode: turned about the hinge by the swing
    const c = Math.cos(w.swing), s = Math.sin(w.swing);
    const down = blade.map((p) => {
      const y = p[1] - w.pivot[1], z = p[2] - w.pivot[2];
      return [p[0], w.pivot[1] + y * c - z * s, w.pivot[2] + y * s + z * c];
    });
    const flat = ends(down);
    expect(Math.abs(flat.te[1] - flat.le[1])).toBeLessThan(0.03);
    expect(rest.le[1] - flat.le[1]).toBeGreaterThan(0.08);
    // (it comes down onto the tail, not into it: still over the deck's valleys, where its arms are)
    for (const p of down) expect(body(p[0], p[1], p[2])).toBeGreaterThan(0);
    // the far LOD keeps it as a slab
    const far = new PartBuilder();
    bp.farParts!(far);
    expect(far.vertexCount).toBeGreaterThan(20);
    let farTop = 0;
    for (let i = 0; i < far.vertexCount; i++) farTop = Math.max(farTop, far.pos[i * 3 + 1]);
    expect(farTop).toBeGreaterThan(w.at[1] - 0.03);
  });

  it('meshes with its edges where they are: the mesh lies on the field, within the budgets, and the wheels are its own', async () => {
    const m = polygonize({ min: bp.bounds.min, max: bp.bounds.max, cell: 0.027, field: body, lipschitz: 1.35, sharp: true });
    const p = m.positions;
    let off = 0;
    for (let v = 0; v < p.length; v += 3) off = Math.max(off, Math.abs(body(p[v], p[v + 1], p[v + 2])));
    expect(off).toBeLessThan(0.004);
    let stray = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3;
      if (Math.abs(body((p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3)) > 0.004) stray++;
    }
    // (surface nets leave about 2 % of the triangles more than 4 mm off this field, across its creases)
    expect(stray / (m.indices.length / 3)).toBeLessThan(0.004);
    // every normal is a unit vector
    for (let v = 0; v < m.normals.length; v += 3) expect(Math.hypot(m.normals[v], m.normals[v + 1], m.normals[v + 2])).toBeCloseTo(1, 3);
    const d = await buildCarData(spec, 'high');
    expect(d.lod0.stats.triangles).toBeLessThan(125000);
    expect(d.lod2.stats.triangles).toBeLessThan(12000);
    expect(d.moving?.map((x) => x.name)).toEqual(['wing']);
    expect(d.lod2.vertices.length / VERTEX_STRIDE).toBeGreaterThan(d.lod2.stats.bodyVertices);
    // nine blades round a centre lock, and a semi-slick: a smooth face with two grooves a side
    expect(styleForBody(spec.style)).toBe('blade');
    const look = wheelLook(spec.style);
    expect([look.slick, look.tread]).toEqual([1, 0]);
    expect(look.grooves).toEqual([0.035, 0.1, 0.006, 0.003]);
    for (const W of [spec.tireWidthFront, spec.tireWidthRear]) expect(look.grooves![1] + look.grooves![2]).toBeLessThan(W / 2 - 0.02);
  }, 120000);
});
