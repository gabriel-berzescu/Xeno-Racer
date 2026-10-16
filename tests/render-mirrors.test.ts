import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FinalEffect, GRADE_GLSL } from '../src/render/effects-post';
import { stripFragment } from '../src/render/mirrorGlass';
import { mirrorTier, SPRAY } from '../src/render/mirrors';
import { particleCommon, mistFragment, puffFragment } from '../src/render/fx/particleShaders';
import { flareFragment, flareVertex, LampFlares, MAX_FLARES } from '../src/render/mirrorFlares';
import { HEADLAMPS } from '../src/game/headlamps';
import { particleUniforms } from '../src/render/post';
import {
  applyWindowView,
  drawsOnFrame,
  eyeDistance,
  makeQuad,
  makeWindowView,
  MIN_EYE_DISTANCE,
  quadFromMatrix,
  quadPixelSize,
  quadSeenBy,
  rearCameraQuaternion,
  reflectPoint,
  sizeStillFits,
  targetSize,
  windowView,
  type MirrorQuad,
} from '../src/render/mirrorMath';

/** A glass at the origin facing +Z (the face the viewer sees), 0.2 x 0.1 m. */
function glass(): MirrorQuad {
  const q = makeQuad();
  q.halfW = 0.1;
  q.halfH = 0.05;
  return q;
}

/** NDC of a world point seen by a camera. */
function ndc(cam: PerspectiveCamera, p: Vector3): Vector3 {
  return p.clone().applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
}

describe('mirror geometry', () => {
  it('reflects points in the glass plane', () => {
    const c = new Vector3(0, 0, 1);
    const n = new Vector3(0, 0, 1);
    expect(reflectPoint(new Vector3(2, 3, 4), c, n, new Vector3()).toArray()).toEqual([2, 3, -2]);
    // a tilted plane: normal along (1, 0, 1)/sqrt2 through the origin swaps x and z with a sign
    const t = new Vector3(1, 0, 1).normalize();
    const r = reflectPoint(new Vector3(1, 0, 0), new Vector3(), t, new Vector3());
    expect(r.x).toBeCloseTo(0, 12);
    expect(r.z).toBeCloseTo(-1, 12);
  });

  it('reads a glass pose from a world matrix', () => {
    const m = new Matrix4().compose(new Vector3(1, 2, 3), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2), new Vector3(1, 1, 1));
    const q = quadFromMatrix(m, 0.1, 0.05, makeQuad());
    expect(q.center.toArray()).toEqual([1, 2, 3]);
    // a quarter turn about Y: the face now looks along +X and the glass's right along -Z
    expect(q.normal.x).toBeCloseTo(1, 12);
    expect(q.right.z).toBeCloseTo(-1, 12);
    expect(q.up.y).toBeCloseTo(1, 12);
  });

  it('has no window for a viewer behind the glass or edge-on to it', () => {
    const q = glass();
    const v = makeWindowView();
    expect(windowView(new Vector3(0, 0, -1), q, 1, 500, v)).toBe(false);
    expect(windowView(new Vector3(1, 0, 0), q, 1, 500, v)).toBe(false);
    expect(windowView(new Vector3(0, 0, MIN_EYE_DISTANCE * 0.5), q, 1, 500, v)).toBe(false);
    expect(windowView(new Vector3(0.2, 0.1, 0.8), q, 1, 500, v)).toBe(true);
    expect(eyeDistance(new Vector3(0.2, 0.1, 0.8), q)).toBeCloseTo(0.8, 12);
  });

  it('looks from the mirrored eye through the glass, out of its front face', () => {
    const q = glass();
    const v = makeWindowView();
    const eye = new Vector3(0.3, 0.1, 1.2);
    expect(windowView(eye, q, 1, 500, v)).toBe(true);
    expect(v.eye.toArray()).toEqual([0.3, 0.1, -1.2]);
    // the camera looks down its own -Z: that must be the glass's +normal
    expect(v.zAxis.clone().negate().toArray()).toEqual([0, 0, 1]);
    // a proper rotation (no mirrored handedness, so triangle winding is untouched)
    const x = v.xAxis.clone();
    expect(x.cross(v.yAxis).dot(v.zAxis)).toBeCloseTo(1, 12);
    // the near plane is just in front of the glass plane, 1.2 away from the mirrored eye
    expect(v.near).toBeGreaterThan(1.2);
    expect(v.near).toBeLessThan(1.21);
  });

  it('frames the glass outline exactly (off-axis frustum)', () => {
    const q = glass();
    const v = makeWindowView();
    const eye = new Vector3(0.3, 0.1, 1.2);
    windowView(eye, q, 1, 500, v);
    const cam = new PerspectiveCamera();
    applyWindowView(cam, v);
    const corners: Array<[number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (const [sx, sy] of corners) {
      const p = new Vector3(sx * q.halfW, sy * q.halfH, 0);
      const n = ndc(cam, p);
      // seen from behind, the glass's right is the camera's left
      expect(n.x).toBeCloseTo(-sx, 6);
      expect(n.y).toBeCloseTo(sy, 6);
    }
  });

  it('puts what a real mirror shows at (1 - u, v) of the render target', () => {
    const q = glass();
    const v = makeWindowView();
    const eye = new Vector3(0.35, -0.08, 0.9);
    windowView(eye, q, 1, 500, v);
    const cam = new PerspectiveCamera();
    applyWindowView(cam, v);
    // a few world points in front of the glass, on the viewer's side, that the mirror can show
    const pts = [new Vector3(-0.5, 0.2, 6), new Vector3(1.2, -0.3, 9), new Vector3(0.1, 0.05, 14), new Vector3(-2, 0.5, 20)];
    for (const w of pts) {
      // the image of w in the mirror is where the sight line from the eye to w's reflection crosses the glass plane
      const wr = reflectPoint(w, q.center, q.normal, new Vector3());
      const dir = wr.clone().sub(eye);
      const t = (q.center.z - eye.z) / dir.z;
      const hit = eye.clone().addScaledVector(dir, t);
      const u = 0.5 + hit.x / (2 * q.halfW);
      const vv = 0.5 + hit.y / (2 * q.halfH);
      if (u < 0 || u > 1 || vv < 0 || vv > 1) continue; // outside the glass: not in the mirror
      const n = ndc(cam, w);
      expect(n.x * 0.5 + 0.5).toBeCloseTo(1 - u, 5);
      expect(n.y * 0.5 + 0.5).toBeCloseTo(vv, 5);
    }
  });

  it('follows the head: the same world point moves across the glass as the eye moves', () => {
    const q = glass();
    const v = makeWindowView();
    const w = new Vector3(0, 0, 10);
    const at = (ex: number): number => {
      windowView(new Vector3(ex, 0, 0.8), q, 1, 500, v);
      const cam = new PerspectiveCamera();
      applyWindowView(cam, v);
      return 1 - (ndc(cam, w).x * 0.5 + 0.5);
    };
    // eye to the right of the mirror: the point straight behind it appears right of centre... and moves with the eye
    expect(at(0.3)).toBeGreaterThan(at(0));
    expect(at(0)).toBeGreaterThan(at(-0.3));
    expect(at(0)).toBeCloseTo(0.5, 6);
  });

  it('a convex mirror shows a wider field: the glass edges land on the edges of the widened window', () => {
    const q = glass();
    const v = makeWindowView();
    const eye = new Vector3(0, 0, 0.8);
    windowView(eye, q, 1.4, 500, v);
    const cam = new PerspectiveCamera();
    applyWindowView(cam, v);
    // the window is 1.4 x the glass: the glass outline itself covers only the middle 1/1.4 of the target
    const n = ndc(cam, new Vector3(q.halfW, q.halfH, 0));
    expect(Math.abs(n.x)).toBeCloseTo(1 / 1.4, 6);
    expect(Math.abs(n.y)).toBeCloseTo(1 / 1.4, 6);
    // and the horizontal field of view at the mirrored eye is wider than a flat mirror's by the same factor (tangent)
    const flat = makeWindowView();
    windowView(eye, q, 1, 500, flat);
    expect((v.right - v.left) / v.near).toBeCloseTo(1.4 * ((flat.right - flat.left) / flat.near), 6);
  });

  it('reads the pose of a tilted, offset glass the same way', () => {
    // a door-mirror-like pose: rotated inward about Y, tilted a little, off to the side of the eye
    const quat = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI + 0.33).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.05));
    const q = quadFromMatrix(new Matrix4().compose(new Vector3(0.98, 0.99, 0.3), quat, new Vector3(1, 1, 1)), 0.085, 0.052, makeQuad());
    const eye = new Vector3(0.36, 1.04, -0.25);
    expect(eyeDistance(eye, q)).toBeGreaterThan(0.3);
    const v = makeWindowView();
    expect(windowView(eye, q, 1.3, 4000, v)).toBe(true);
    const cam = new PerspectiveCamera();
    applyWindowView(cam, v);
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as Array<[number, number]>) {
      const p = q.center.clone().addScaledVector(q.right, sx * q.halfW).addScaledVector(q.up, sy * q.halfH);
      const n = ndc(cam, p);
      expect(n.x).toBeCloseTo(-sx / 1.3, 6);
      expect(n.y).toBeCloseTo(sy / 1.3, 6);
    }
    // the mirrored eye really is on the far side of the glass plane
    expect(eyeDistance(v.eye, q)).toBeCloseTo(-eyeDistance(eye, q), 9);
  });
});

describe('mirror visibility and sizing', () => {
  const main = (): PerspectiveCamera => {
    const c = new PerspectiveCamera(72, 16 / 9, 0.05, 1000);
    c.position.set(0, 0, 1);
    c.updateMatrixWorld(true);
    return c;
  };

  it('sees glass in front of the camera and facing it, not behind or turned away', () => {
    const cam = main();
    const q = glass();
    expect(quadSeenBy(cam, q)).toBe(true); // glass at the origin, camera at z = 1 looking down -Z
    const away = glass();
    away.normal.set(0, 0, -1);
    away.right.set(-1, 0, 0);
    expect(quadSeenBy(cam, away)).toBe(false);
    const far = glass();
    far.center.set(30, 0, 0);
    expect(quadSeenBy(cam, far)).toBe(false);
    const behind = glass();
    behind.center.set(0, 0, 8);
    expect(quadSeenBy(cam, behind)).toBe(false);
  });

  it('measures the glass in screen pixels', () => {
    const cam = main();
    const q = glass();
    const s = quadPixelSize(cam, q, 1080, { w: 0, h: 0 });
    // 0.2 m wide at 1 m with a 72 degree vertical lens on 1080 px: 0.2 / (2 tan 36deg) * 1080 = 148.6 px tall per metre of view
    const pxPerM = 1080 / (2 * Math.tan((72 * Math.PI) / 360));
    expect(s.w).toBeCloseTo(0.2 * pxPerM, 0);
    expect(s.h).toBeCloseTo(0.1 * pxPerM, 0);
    // twice as far, half as big
    cam.position.set(0, 0, 2);
    cam.updateMatrixWorld(true);
    const far = quadPixelSize(cam, q, 1080, { w: 0, h: 0 });
    expect(far.w).toBeCloseTo(s.w / 2, 0);
    // glass behind the camera has no size
    const behind = glass();
    behind.center.set(0, 0, 5);
    expect(quadPixelSize(cam, behind, 1080, { w: 1, h: 1 })).toEqual({ w: 0, h: 0 });
  });

  it('sizes a render target in 8 px steps within limits, and only resizes for a clear change', () => {
    expect(targetSize(300, 90, 1, 32, 512, { w: 0, h: 0 })).toEqual({ w: 304, h: 88 });
    expect(targetSize(3000, 20, 1, 32, 512, { w: 0, h: 0 })).toEqual({ w: 512, h: 32 });
    expect(targetSize(300, 90, 0.5, 32, 512, { w: 0, h: 0 })).toEqual({ w: 152, h: 48 });
    expect(sizeStillFits(304, 296)).toBe(true);
    expect(sizeStillFits(304, 400)).toBe(true);
    expect(sizeStillFits(304, 420)).toBe(false);
    expect(sizeStillFits(304, 200)).toBe(false);
    expect(sizeStillFits(0, 100)).toBe(false);
  });

  it('staggers the redraws of mirrors on a reduced rate', () => {
    for (let f = 0; f < 6; f++) expect(drawsOnFrame(f, 1, 0)).toBe(true);
    const a = [0, 1, 2, 3, 4, 5].map((f) => drawsOnFrame(f, 2, 0));
    const b = [0, 1, 2, 3, 4, 5].map((f) => drawsOnFrame(f, 2, 1));
    expect(a).toEqual([true, false, true, false, true, false]);
    expect(b).toEqual([false, true, false, true, false, true]);
    const third = [0, 1, 2, 3, 4, 5, 6].filter((f) => drawsOnFrame(f, 3, 2));
    expect(third).toEqual([1, 4]);
  });
});

describe('rear camera', () => {
  it('looks out of the tail, tipped down by the pitch', () => {
    const fwd = (q: Quaternion): Vector3 => new Vector3(0, 0, -1).applyQuaternion(q);
    const level = rearCameraQuaternion(new Quaternion(), 0, new Quaternion());
    expect(fwd(level).toArray().map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0, 0, -1]);
    const down = rearCameraQuaternion(new Quaternion(), 0.1, new Quaternion());
    expect(fwd(down).y).toBeLessThan(-0.09);
    expect(fwd(down).z).toBeLessThan(-0.99);
    // follows the car: a car turned to face +X has its tail toward -X
    const turned = rearCameraQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2), 0, new Quaternion());
    expect(fwd(turned).x).toBeCloseTo(-1, 6);
  });
});

describe('mirror quality tiers', () => {
  const tiers = (['low', 'medium', 'high', 'ultra'] as const).map((q) => mirrorTier(q));

  it('draw less often, smaller and with fewer extras on lower presets', () => {
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i].rate, 'rate').toBeLessThanOrEqual(tiers[i - 1].rate);
      expect(tiers[i].doorRate, 'door rate').toBeLessThanOrEqual(tiers[i - 1].doorRate);
      expect(tiers[i].scale, 'scale').toBeGreaterThanOrEqual(tiers[i - 1].scale);
      expect(tiers[i].maxPx, 'size cap').toBeGreaterThanOrEqual(tiers[i - 1].maxPx);
    }
    // the door mirrors (small, off to the side) never draw more often than the rear-view mirror
    for (const t of tiers) expect(t.doorRate).toBeGreaterThanOrEqual(t.rate);
  });

  it('keeps the top preset at full rate and the bottom at a fraction, with the spray only where it is affordable', () => {
    expect(mirrorTier('ultra').rate).toBe(1);
    expect(mirrorTier('ultra').doorRate).toBe(1);
    expect(mirrorTier('low').rate).toBeGreaterThan(1);
    expect(mirrorTier('low').particles).toBe(false);
    expect(mirrorTier('high').particles).toBe(true);
  });

  it('draws at most one group of mirrors on any frame at the rates of the default preset (the group phases are 0 and 1)', () => {
    const t = mirrorTier('high');
    expect(t.rate).toBe(2);
    expect(t.doorRate).toBe(2);
    for (let f = 0; f < 8; f++) {
      const rear = drawsOnFrame(f, t.rate, 0);
      const doors = drawsOnFrame(f, t.doorRate, 1);
      expect(rear && doors, 'frame ' + f).toBe(false);
      expect(rear || doors, 'frame ' + f).toBe(true);
    }
  });
});

describe('the HUD mirror shares the grade of the picture', () => {
  const uniforms = ['exposure', 'tmMode', 'saturation', 'lookPower', 'lookSat', 'contrast', 'tint', 'night'];

  it('runs the same exposure, tone mapping and grade code as the final effect', () => {
    expect(GRADE_GLSL).toContain('vec3 xrGrade(vec3 scene)');
    expect(GRADE_GLSL).toContain('vec3 agxTonemap(vec3 c)');
    expect(GRADE_GLSL).toContain('vec3 srgbEncode(vec3 c)');
    expect(new FinalEffect().getFragmentShader()).toContain('xrGrade(inputColor.rgb)');
    expect(stripFragment).toContain('xrGrade(scene)');
    expect(stripFragment).toContain('vec3 xrGrade(vec3 scene)');
  });

  it('can bind every uniform the grade reads from the final effect', () => {
    const fx = new FinalEffect();
    for (const name of uniforms) {
      expect(GRADE_GLSL, name).toMatch(new RegExp('uniform (float|vec3) ' + name + ';'));
      expect(fx.uniforms.has(name), name).toBe(true);
    }
  });
});

describe('spray in a mirror', () => {
  it('leaves the smoke and spray of the main picture as they were: the particle uniforms default to the old near fade and full opacity', () => {
    expect(particleUniforms.uNearFade.value.x).toBeCloseTo(0.3, 6);
    expect(particleUniforms.uNearFade.value.y).toBeCloseTo(3.6, 6);
    expect(particleUniforms.uAlphaMul.value).toBe(1);
  });

  it('reads both knobs in the smoke and the spray shaders', () => {
    expect(particleCommon).toContain('uniform vec2 uNearFade;');
    expect(particleCommon).toContain('uniform float uAlphaMul;');
    for (const frag of [puffFragment, mistFragment]) {
      expect(frag).toContain('smoothstep(uNearFade.x, uNearFade.y, depthV) * uAlphaMul');
      expect(frag).not.toContain('smoothstep(0.3, 3.6, depthV)');
    }
  });

  it('thins and pushes back the plume in a mirror, never thickens it', () => {
    expect(SPRAY.nearFrom).toBeGreaterThan(particleUniforms.uNearFade.value.y);
    expect(SPRAY.nearTo).toBeGreaterThan(SPRAY.nearFrom);
    expect(SPRAY.alpha).toBeGreaterThan(0);
    expect(SPRAY.alpha).toBeLessThanOrEqual(1);
    expect(SPRAY.light).toBeGreaterThan(0);
    expect(SPRAY.light).toBeLessThanOrEqual(1);
  });
});

describe('headlamp glare in a mirror', () => {
  it('holds as many lamps as the game can list', () => {
    expect(MAX_FLARES).toBe(HEADLAMPS.max);
  });

  it('draws what it is given, never more than it can hold, and nothing when emptied', () => {
    const f = new LampFlares();
    expect(f.n).toBe(0);
    const data = new Float32Array(40 * 4).fill(0.5);
    f.set(data, 6);
    expect(f.n).toBe(6);
    f.set(data, 40);
    expect(f.n).toBe(MAX_FLARES);
    f.set(null, 5);
    expect(f.n).toBe(0);
    f.set(data, -3);
    expect(f.n).toBe(0);
    f.dispose();
  });

  it('keeps the shader to a sprite of at least a few pixels of the target, out of the lens, depth-tested', () => {
    expect(flareVertex).toContain('attribute vec4 aLamp');
    expect(flareVertex).toContain('uMinPx');
    expect(flareVertex).toContain('uRes');
    expect(flareVertex).toContain('cameraPosition');
    expect(flareFragment).toContain('uFogDensity');
    const f = new LampFlares();
    const mesh = f.scene.children[0] as unknown as { material: { depthTest: boolean; depthWrite: boolean; toneMapped: boolean } };
    expect(mesh.material.depthTest).toBe(true);
    expect(mesh.material.depthWrite).toBe(false);
    expect(mesh.material.toneMapped).toBe(false);
    f.dispose();
  });
});
