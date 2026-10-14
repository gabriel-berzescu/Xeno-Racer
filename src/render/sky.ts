/**
 * Sky dome (owner: render): the mesh, material and uniform plumbing around skyShader.ts.
 */
import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LessEqualDepth,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  RGBAFormat,
  RepeatWrapping,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three';
import { LUT_E0 } from './atmosphere';
import type { EnvSolution } from './environment';
import { makeCloudNoise } from './noise';
import { skyFragmentShader, skyVertexShader } from './skyShader';

/** Angular radius of the drawn sun disc (rad). The real sun is 0.0093; a little larger reads better on a monitor. */
const SUN_ANGULAR_RADIUS = 0.0135;

export class SkyDome {
  readonly mesh: Mesh;
  readonly envMesh: Mesh;
  readonly material: ShaderMaterial;
  private lutTexture: DataTexture | null = null;
  private readonly noiseTexture: DataTexture;
  private time = 0;

  constructor() {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));

    const noise = makeCloudNoise(256);
    this.noiseTexture = new DataTexture(noise, 256, 256, RGBAFormat, UnsignedByteType);
    this.noiseTexture.wrapS = RepeatWrapping;
    this.noiseTexture.wrapT = RepeatWrapping;
    this.noiseTexture.magFilter = LinearFilter;
    this.noiseTexture.minFilter = LinearMipmapLinearFilter;
    this.noiseTexture.generateMipmaps = true;
    this.noiseTexture.anisotropy = 4;
    this.noiseTexture.needsUpdate = true;
    this.noiseTexture.name = 'xr.cloudNoise';

    this.material = new ShaderMaterial({
      name: 'xr.sky',
      uniforms: {
        uLut: { value: null },
        uNoise: { value: this.noiseTexture },
        uSunDir: { value: new Vector3(0, 1, 0) },
        uSunAz: { value: new Vector2(1, 0) },
        uLutE0: { value: LUT_E0 },
        uSkyScale: { value: 1 },
        uSunRadiance: { value: new Vector3() },
        uSunRadius: { value: Math.sin(SUN_ANGULAR_RADIUS) },
        uGround: { value: new Vector3(0.05, 0.05, 0.04) },
        uOvercast: { value: 0 },
        uShowSun: { value: 1 },
        uCloudLight: { value: new Vector3() },
        uCloudAmb: { value: new Vector3() },
        uHaze: { value: new Vector3() },
        uCoverage: { value: 0.3 },
        uSoft: { value: 0.1 },
        uCloudDark: { value: 0.4 },
        uCirrus: { value: 0.5 },
        uTime: { value: 0 },
        uWind: { value: new Vector2(0.0042, 0.0016) },
        uStars: { value: 0 },
        uMoonDir: { value: new Vector3(0, 1, 0) },
        uMoonVis: { value: 0 },
        uTrueSunDir: { value: new Vector3(0, -1, 0) },
        uMoonLight: { value: new Vector3() },
        uQuality: { value: 1 },
      },
      vertexShader: skyVertexShader,
      fragmentShader: skyFragmentShader,
      depthWrite: false,
      depthTest: true,
      depthFunc: LessEqualDepth,
      toneMapped: false,
      fog: false,
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'xr.sky';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 100000;
    // Second mesh sharing everything, used for the PMREM capture scene.
    this.envMesh = new Mesh(geometry, this.material);
    this.envMesh.frustumCulled = false;
    this.envMesh.matrixAutoUpdate = false;
  }

  setQuality(high: boolean): void {
    this.material.uniforms.uQuality.value = high ? 1 : 0;
  }

  setShowSun(on: boolean): void {
    this.material.uniforms.uShowSun.value = on ? 1 : 0;
  }

  apply(sol: EnvSolution): void {
    const u = this.material.uniforms;
    // LUT -> half float texture
    const m = sol.model;
    const half = new Uint16Array(m.lut.length);
    for (let i = 0; i < m.lut.length; i++) half[i] = DataUtils.toHalfFloat(Math.min(m.lut[i], 65000));
    const tex = new DataTexture(half, m.width, m.height, RGBAFormat, HalfFloatType);
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearFilter;
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    tex.name = 'xr.skyLut';
    this.lutTexture?.dispose();
    this.lutTexture = tex;
    u.uLut.value = tex;

    const sd = sol.sunDir;
    (u.uSunDir.value as Vector3).set(sd[0], sd[1], sd[2]);
    const hl = Math.hypot(sd[0], sd[2]);
    (u.uSunAz.value as Vector2).set(hl > 1e-5 ? sd[0] / hl : 1, hl > 1e-5 ? sd[2] / hl : 0);
    u.uSkyScale.value = sol.skyScale;
    (u.uSunRadiance.value as Vector3).set(sol.sunRadiance[0], sol.sunRadiance[1], sol.sunRadiance[2]);
    (u.uGround.value as Vector3).set(sol.ground[0], sol.ground[1], sol.ground[2]);
    u.uOvercast.value = sol.weather.overcast;
    (u.uCloudLight.value as Vector3).set(sol.cloudLight[0], sol.cloudLight[1], sol.cloudLight[2]);
    (u.uCloudAmb.value as Vector3).set(sol.cloudAmbient[0], sol.cloudAmbient[1], sol.cloudAmbient[2]);
    (u.uHaze.value as Vector3).set(sol.haze[0], sol.haze[1], sol.haze[2]);
    u.uCoverage.value = sol.weather.coverage;
    u.uSoft.value = sol.weather.soft;
    u.uCloudDark.value = sol.weather.dark;
    u.uCirrus.value = sol.weather.cirrus;
    u.uStars.value = sol.stars;
    u.uMoonVis.value = sol.tod.moon ? 1 - sol.weather.overcast * 0.85 : 0;
    (u.uMoonDir.value as Vector3).set(sd[0], sd[1], sd[2]);
    const ts = sol.trueSunDir;
    (u.uTrueSunDir.value as Vector3).set(ts[0], ts[1], ts[2]);
    (u.uMoonLight.value as Vector3).set(sol.moonLight[0] * sol.skyScale * 0.9, sol.moonLight[1] * sol.skyScale * 0.9, sol.moonLight[2] * sol.skyScale * 0.9);
  }

  /** Advance cloud drift. */
  update(dt: number): void {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
  }

  setTime(t: number): void {
    this.time = t;
    this.material.uniforms.uTime.value = t;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.lutTexture?.dispose();
    this.noiseTexture.dispose();
  }
}
