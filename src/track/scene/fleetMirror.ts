/**
 * The fleet in the water (fleet.ts): the image of every sail on the lagoon and the sea, and after dark the streaks of the riding
 * lights and the lanterns.
 *
 * The sea of an island circuit reflects its sky (the environment map), and the sky has no boats in it. So the images are drawn: a
 * small sheet a sail, a hull and a lamp, all of them one instanced draw call after the water. In the vertex shader a sheet's vertices are
 * put exactly where the eye sees the sail's outline in a level sea: where the line from the eye to the sail upside down under the
 * surface comes up through the surface. The sheet lies on the water, so the hull in front of it, the causeway and the beach hide it
 * as they hide the water, and nothing is rendered twice.
 *
 * An image is lit as its sail is. The material is the scene's lit one, given the sail's own normal and colour, so at every hour
 * the image has the colour the sail has (and the sun comes through it as it comes through the sail); it is weaker by what water
 * gives back at that angle (nearly everything seen from a car, next to nothing from the air: Fresnel), broken into slivers by the
 * ripples the farther it lies from the boat, and gone in the rain. A lamp's image is a streak, added to the water.
 */
import * as THREE from 'three';
import type { EnvironmentState } from '../../core/contracts';
import type { Ctx } from './ctx';
import { CLAW_HOLLOW } from './fleetBoats';
import { IMAGE, type Image, LAMP_RADIANCE } from './fleetKit';
import type { Berth } from './fleetPlan';

/** The rows of a sheet from the foot of a sail to its head (closer where a leaf's outline turns). */
const ROWS = [0, 0.1, 0.2, 0.3, 0.45, 0.6, 0.75, 0.9, 1];
/** A streak's share of its lamp's radiance where it is brightest, and the least it is drawn wide (radians of the view). */
const STREAK = 0.3;
const STREAK_MIN_ANGLE = 0.0018;

function mirrorMaterial(shared: { value: THREE.Vector4 }, mirror: { value: THREE.Vector4 }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0, envMapIntensity: 0.9, side: THREE.DoubleSide, transparent: true, depthWrite: false, premultipliedAlpha: true });
  m.name = 'fleetMirror';
  // (a sheet lies flat and is seen from one side or the other, never through itself: one pass, one program)
  m.forceSinglePass = true;
  // over the water: its colour times what is left, and the destination's alpha as it was (the wet-road pass keeps a flag there)
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneFactor;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFleet = shared;
    shader.uniforms.uMirror = mirror;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform vec4 uFleet;
uniform vec4 uMirror; // how strong the images are (0 in the rain), the level of the sea
attribute vec4 aLeafA; // the luff: its foot (x, y) and its head (x, y) in the boat's frame
attribute vec4 aLeafB; // the chord (m), the luff's bend, the kind of outline, the trim (rad)
attribute vec4 aLeafC; // the colour, how far the sail is furled
attribute vec4 aLeafD; // a crab claw's clew (x, y), how far to starboard of the keel
varying vec3 vMirCol;
varying vec3 vMirGlow;
varying vec4 vMir; // from the luff to the leech, from the foot to the head, what the water gives back, 1 for a lamp
varying vec2 vMirWater;
// (the outline of a leaf: fleetBoats.ts has it in its own words)
float mirLeaf(float t) {
	return t < 0.3 ? 0.8 + 0.2 * sin(t / 0.3 * 1.5707963) : 0.08 + 0.92 * sqrt(max(0.0, 1.0 - (t - 0.3) * (t - 0.3) / 0.49));
}`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `#include <beginnormal_vertex>
	float mU = position.x;
	float mT = position.y;
	float mKind = aLeafB.z;
	bool mLamp = mKind > 3.5;
	bool mHull = mKind > 2.5 && !mLamp;
	float mTrim = aLeafB.w;
	objectNormal = vec3(sin(mTrim), 0.0, cos(mTrim));`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
	float mLx = aLeafA.x + (aLeafA.z - aLeafA.x) * pow(max(mT, 1e-4), aLeafB.y);
	float mLy = aLeafA.y + (aLeafA.w - aLeafA.y) * mT;
	float mC = 0.0;
	if (mKind < 0.5) {
		mC = aLeafB.x * mirLeaf(mT);
	} else if (mKind < 1.5) {
		mC = aLeafB.x * pow(max(1.0 - mT, 0.0), 0.9);
	} else if (mKind < 2.5) {
		// a crab claw: from the upper spar aft to the boom, and over the boom's end to a hollow leech
		float mTb = (aLeafD.y - aLeafA.y) / (aLeafA.w - aLeafA.y);
		float mS = (mT - mTb) / (1.0 - mTb);
		mC = max(0.0, mT <= mTb ? mLx - (aLeafA.x + (aLeafD.x - aLeafA.x) * mT / mTb) : mLx - (aLeafD.x + (aLeafA.z - aLeafD.x) * mS + ${CLAW_HOLLOW.toFixed(2)} * sin(3.14159265 * mS)));
	} else if (mHull) {
		mC = aLeafB.x;
	}
	float mP = mU * mC * (1.0 - aLeafC.w);
	transformed = vec3(mLx - cos(mTrim) * mP, mLy, aLeafD.z + sin(mTrim) * mP);
	// the sail's own colour, as fleetKit.ts paints it: paler toward the head, a pale line down the luff
	vMirCol = mLamp ? vec3(0.0) : mHull ? aLeafC.rgb : mix(aLeafC.rgb, vec3(1.0), 0.03 + 0.4 * mT * mT + 0.25 * max(0.0, 1.0 - mU * 5.0)) * (1.0 - 0.07 * mU);
	vMirGlow = mLamp ? aLeafC.rgb * (uFleet.x * ${(LAMP_RADIANCE * STREAK).toFixed(2)}) : mHull ? vec3(0.0) : vMirCol * uFleet.z;`,
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
	vec4 mWorld = modelMatrix * mvPosition;
	// where the eye sees this point in a level sea: on the line to the point's image under the surface, where it meets the surface
	float mUp = max(mWorld.y - uMirror.y, 0.0);
	float mEye = max(cameraPosition.y - uMirror.y, 0.05);
	vec2 mOn = mix(cameraPosition.xz, mWorld.xz, mEye / (mEye + mUp));
	mvPosition = viewMatrix * vec4(mOn.x, uMirror.y + 0.03, mOn.y, 1.0);
	// (a lamp's streak: never narrower than a pixel or two, and not there while the lamp is off)
	if (mLamp) mvPosition.x += (mU - 0.5) * max(aLeafB.x, -mvPosition.z * ${STREAK_MIN_ANGLE.toFixed(4)}) * step(0.004, uFleet.x);
	gl_Position = projectionMatrix * mvPosition;
	float mCos = mEye / max(length(vec3(mOn.x - cameraPosition.x, mEye, mOn.y - cameraPosition.z)), 0.001);
	vMir = vec4(mU, mT, 0.02 + 0.98 * pow(1.0 - mCos, 5.0), mLamp ? 1.0 : 0.0);
	vMirWater = mOn;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uFleet;\nuniform vec4 uMirror;\nvarying vec3 vMirCol;\nvarying vec3 vMirGlow;\nvarying vec4 vMir;\nvarying vec2 vMirWater;')
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
	diffuseColor.rgb *= vMirCol;
	// the ripples: waves seen end on are bands across the view, so they are a function of how far from the eye the water is (and
	// a little of where along the band). They bend an image's edges and break it into slivers, the more the farther it lies from
	// the boat; too far off to tell them apart, their mean
	vec2 mRel = vMirWater - cameraPosition.xz;
	float mFar = length(mRel);
	float mAlong = mRel.x * 0.6 - mRel.y * 0.8;
	float mClock = uFleet.y;
	float mRip = (sin(mFar * 2.3 + mAlong * 0.31 + mClock * 1.6) + sin(mFar * 5.1 - mAlong * 0.47 - mClock * 2.3) + sin(mFar * 0.9 + mAlong * 0.13 + mClock * 0.7)) / 3.0;
	float mFine = smoothstep(0.35, 1.3, fwidth(mFar));
	float mWhole;
	float mEdge;
	if (vMir.w > 0.5) {
		// a lamp's streak: brightest under the lamp, running out toward the eye
		mWhole = mix(smoothstep(-0.15, 0.2, mRip + 0.05), 0.5, mFine) * smoothstep(0.0, 0.3, vMir.y) * (1.0 - smoothstep(0.38, 1.0, vMir.y));
		mEdge = 1.0 - abs(vMir.x * 2.0 - 1.0);
	} else {
		float mAway = 0.25 + vMir.y;
		float mBent = vMir.x + (1.0 - mFine) * 0.07 * mAway * (sin(mFar * 3.1 + mClock * 2.1) + 0.6 * sin(mFar * 7.3 - mClock * 3.4));
		mWhole = mix(smoothstep(-0.3, 0.3, mRip + 0.8 - 1.1 * vMir.y), clamp(0.95 - 0.55 * vMir.y, 0.0, 1.0), mFine);
		mEdge = smoothstep(0.0, 0.1, mBent) * smoothstep(0.0, 0.1, 1.0 - mBent);
	}
	float mBack = uMirror.x * min(0.74, vMir.z) * mWhole * mEdge;
	diffuseColor.a = vMir.w > 0.5 ? 0.0 : mBack;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
	// the sail's own normal, on the side of it the eye is on (the sheet lies flat: its own faces say nothing)
	normal = normalize(vNormal);
	if (dot(normal, vViewPosition) < 0.0) normal = -normal;
#if NUM_DIR_LIGHTS > 0
	if (dot(normal, directionalLights[0].direction) < 0.0) {
		normal = -normal;
		diffuseColor.rgb *= 0.4 + 0.5 * diffuseColor.rgb;
	}
#endif`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vMirGlow * (1.0 - vMir.w);')
      .replace(
        '#include <premultiplied_alpha_fragment>',
        /* glsl */ `#include <premultiplied_alpha_fragment>
	if (vMir.w > 0.5) {
		// light on the water is added to it, and the haze takes it toward nothing
		vec3 mStreak = vMirGlow * mBack;
#ifdef USE_FOG
	#ifdef FOG_EXP2
		mStreak *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
	#else
		mStreak *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
	#endif
#endif
		gl_FragColor.rgb += mStreak;
	}`,
      );
  };
  m.customProgramCacheKey = () => 'xr-fleet-mirror-v1';
  m.userData.noWet = true;
  return m;
}

/** A boat and what the water shows of it. */
export interface Mirrored {
  berth: Berth;
  images: Image[];
}

export interface Mirror {
  mesh: THREE.InstancedMesh;
  triangles: number;
  /** The first sheet of each boat, in the order they were given. */
  first: number[];
  /** A boat has moved: its sheets go with it, trimmed as its sails are. Call `flush` when all have. */
  move: (boat: number, matrix: THREE.Matrix4, trim: number) => void;
  flush: () => void;
}

export function buildMirror(ctx: Ctx, shared: { value: THREE.Vector4 }, level: number, boats: Mirrored[], moving: boolean): Mirror | null {
  const count = boats.reduce((s, b) => s + b.images.length, 0);
  if (!count) return null;
  // a sheet: two columns (the luff and the leech) by the rows
  const pos: number[] = [];
  const idx: number[] = [];
  ROWS.forEach((t, j) => {
    pos.push(0, t, 0, 1, t, 0);
    if (j > 0) idx.push(j * 2 - 2, j * 2 - 1, j * 2 + 1, j * 2 - 2, j * 2 + 1, j * 2);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // (the shader makes the normal; the attribute is there because a lit material asks for one)
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_v, i) => (i % 3 === 2 ? 1 : 0)), 3));
  geo.setIndex(idx);
  const a = new Float32Array(count * 4);
  const b = new Float32Array(count * 4);
  const c = new Float32Array(count * 4);
  const d = new Float32Array(count * 4);
  const mirror = { value: new THREE.Vector4(1, level, 0, 0) };
  const mat = mirrorMaterial(shared, mirror);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.name = 'fleet_mirror';
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sv = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const first: number[] = [];
  let k = 0;
  for (const boat of boats) {
    first.push(k);
    const s = boat.berth;
    q.setFromAxisAngle(UP, s.yaw);
    m4.compose(p.set(s.x, level, s.z), q, sv.setScalar(s.scale));
    for (const im of boat.images) {
      mesh.setMatrixAt(k, m4);
      a.set([im.foot[0], im.foot[1], im.head[0], im.head[1]], k * 4);
      const sails = im.kind < IMAGE.hull;
      b.set([im.c, im.bend, im.kind, sails ? s.trim : 0], k * 4);
      // a sail's colour is its boat's, a hull's its paint times its boat's hull colour, a lamp's its own
      const tint = im.kind === IMAGE.hull && !im.plain ? s.hull : null;
      c.set(im.col ? [im.col[0] * (tint ? tint[0] : 1), im.col[1] * (tint ? tint[1] : 1), im.col[2] * (tint ? tint[2] : 1), 0] : [s.sail[0], s.sail[1], s.sail[2], s.furl], k * 4);
      d.set([im.clew[0], im.clew[1], im.z, 0], k * 4);
      k++;
    }
  }
  const trimAttr = new THREE.InstancedBufferAttribute(b, 4);
  geo.setAttribute('aLeafA', new THREE.InstancedBufferAttribute(a, 4));
  geo.setAttribute('aLeafB', trimAttr);
  geo.setAttribute('aLeafC', new THREE.InstancedBufferAttribute(c, 4));
  geo.setAttribute('aLeafD', new THREE.InstancedBufferAttribute(d, 4));
  if (moving) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    trimAttr.setUsage(THREE.DynamicDrawUsage);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  // after the sea (water.ts draws it at 5)
  mesh.renderOrder = 6;
  ctx.disposables.push(geo, mat);
  ctx.envListeners.push((env: EnvironmentState) => {
    // rain takes the images away: a sea that is pocked all over gives back the sky and nothing else (the sheets are drawn all
    // the same, at nothing: their program is made with the scene, whatever the weather does later)
    mirror.value.x = 1 - Math.min(1, env.rain * 2.5);
  });
  return {
    mesh,
    triangles: (idx.length / 3) * count,
    first,
    move: (boat, matrix, trim) => {
      const n = boats[boat].images.length;
      for (let i = first[boat]; i < first[boat] + n; i++) {
        mesh.setMatrixAt(i, matrix);
        if (b[i * 4 + 2] < IMAGE.hull) b[i * 4 + 3] = trim;
      }
    },
    flush: () => {
      mesh.instanceMatrix.needsUpdate = true;
      trimAttr.needsUpdate = true;
    },
  };
}
