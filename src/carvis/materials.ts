/**
 * Shader-patched materials for the car. All patch MeshPhysicalMaterial so they inherit three's
 * clearcoat / IBL / shadow handling.
 */
import {
  Color,
  CustomBlending,
  DoubleSide,
  FrontSide,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Vector3,
  Vector4,
  type IUniform,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import {
  BODY_FRAG_AO,
  BODY_FRAG_EMISSIVE,
  BODY_FRAG_METAL,
  BODY_FRAG_NORMAL,
  BODY_FRAG_PARS,
  BODY_FRAG_PHYS,
  BODY_FRAG_ROUGH,
  BODY_FRAG_ZONES,
  BODY_VERT_BEGIN,
  BODY_VERT_PARS,
  FAR_FRAG_PARS,
  GLASS_OPAQUE,
} from './shaders';

export interface BodyUniforms {
  [k: string]: IUniform;
  uSide: IUniform<Texture | null>;
  uTop: IUniform<Texture | null>;
  uEnd: IUniform<Texture | null>;
  uRange: IUniform<Vector4>;
  uPrimary: IUniform<Color>;
  uSecond: IUniform<Color>;
  uAccent: IUniform<Color>;
  uFlake: IUniform<number>;
  uFinish: IUniform<number>;
  uBrake: IUniform<number>;
  uTail: IUniform<number>;
  uHead: IUniform<number>;
  uDrl: IUniform<number>;
  uRev: IUniform<number>;
  uInterior: IUniform<number>;
  uInteriorCarbon: IUniform<number>;
  uGlassAlpha: IUniform<number>;
  uGlassTint: IUniform<Color>;
  uProj: IUniform<Vector4>;
  uTrimTint: IUniform<Color>;
  uDbg: IUniform<number>;
}

export function createBodyUniforms(): BodyUniforms {
  return {
    uSide: { value: null },
    uTop: { value: null },
    uEnd: { value: null },
    uRange: { value: new Vector4(2.4, -2.4, 1.5, 1) },
    uPrimary: { value: new Color('#888888') },
    uSecond: { value: new Color('#ffffff') },
    uAccent: { value: new Color('#ff0000') },
    uFlake: { value: 0 },
    uFinish: { value: 0 },
    uBrake: { value: 0 },
    uTail: { value: 0.1 },
    uHead: { value: 0 },
    uDrl: { value: 1 },
    uRev: { value: 0 },
    uInterior: { value: 0.35 },
    uInteriorCarbon: { value: 0 },
    uGlassAlpha: { value: 0.88 },
    uGlassTint: { value: new Color(0.004, 0.005, 0.007) },
    uProj: { value: new Vector4(0.6, 0.6, 2.2, 0.03) },
    uTrimTint: { value: new Color(0.012, 0.012, 0.014) },
    uDbg: { value: 0 },
  };
}

function patchBody(mat: MeshPhysicalMaterial, uniforms: BodyUniforms, glass: boolean): void {
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + BODY_VERT_PARS).replace('#include <begin_vertex>', BODY_VERT_BEGIN);
    let f = shader.fragmentShader;
    f = f.replace('#include <common>', '#include <common>\n' + (glass ? '#define GLASS_PASS\n' : '') + BODY_FRAG_PARS);
    f = f.replace('#include <color_fragment>', '#include <color_fragment>\n' + BODY_FRAG_ZONES);
    f = f.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + BODY_FRAG_ROUGH);
    f = f.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + BODY_FRAG_METAL);
    f = f.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + BODY_FRAG_NORMAL);
    f = f.replace('#include <emissivemap_fragment>', BODY_FRAG_EMISSIVE);
    f = f.replace('#include <lights_physical_fragment>', BODY_FRAG_PHYS);
    f = f.replace('#include <aomap_fragment>', BODY_FRAG_AO);
    if (glass) f = f.replace('#include <opaque_fragment>', GLASS_OPAQUE);
    shader.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => (glass ? 'xr-carbody-glass-v1' : 'xr-carbody-paint-v1');
}

export interface BodyMaterials {
  paint: MeshPhysicalMaterial;
  glass: MeshPhysicalMaterial;
  uniforms: BodyUniforms;
}

export function createBodyMaterials(uniforms: BodyUniforms = createBodyUniforms()): BodyMaterials {
  const paint = new MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.03, side: DoubleSide });
  patchBody(paint, uniforms, false);
  const glass = new MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.03,
    clearcoat: 0,
    transparent: true,
    depthWrite: false,
    side: FrontSide,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  });
  patchBody(glass, uniforms, true);
  return { paint, glass, uniforms };
}

export { Vector3 };

/** Cheap far-LOD material: vertex-colour shading plus the livery projected from the shared textures. */
export function createFarMaterial(uniforms: BodyUniforms): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.34, metalness: 0.2 });
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uSide = uniforms.uSide;
    shader.uniforms.uTop = uniforms.uTop;
    shader.uniforms.uEnd = uniforms.uEnd;
    shader.uniforms.uRange = uniforms.uRange;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;\nvObjNrm = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FAR_FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= liveryColor();');
  };
  mat.customProgramCacheKey = () => 'xr-carfar-v1';
  return mat;
}
