/**
 * Global three.js shader-chunk patches (owner: render).
 *
 * Why global: every lit material in the game (track, cars, scenery from other modules) must get
 * cascaded sun shadows and sky-matched fog without any per-material setup. three compiles materials
 * from the mutable `ShaderChunk` / `ShaderLib` tables, so patching those once, before the first
 * material compiles, covers everything.
 *
 * 1. Cascaded shadows. The sun is N directional lights, each with its own (nested, texel-snapped,
 *    focus-centred) shadow map. The patched `lights_fragment_begin` evaluates light 0 only and picks
 *    the finest cascade that contains the fragment, blending to the next one near the cascade edge
 *    (outermost fades to "lit"). Filtering is a Vogel-disk PCF with receiver-plane depth bias, which
 *    removes acne on grazing golden-hour surfaces without peter-panning. With a single shadow-casting
 *    directional light everything behaves exactly like stock three.js.
 * 2. Fog. Same exp2 falloff as stock, but the fog colour is looked up per view direction in a small
 *    horizon table (azimuth relative to the sun), so distant geometry fades into the actual sky colour
 *    (warm glow toward the sun, cool haze away from it) instead of one flat colour.
 *
 * 3. Street lamps. After dark, the lamps nearest to the camera light every lit material (cars, barriers, stands,
 *    verges) through the material's own BRDF, so a car's clearcoat catches the floodlights as it passes under
 *    them. Materials that light themselves from the lamps (the road, with its painted pools and wet reflections)
 *    opt out with the define XR_NO_LAMPS. Off (one uniform test) while xrLampCol.w is 0.
 *
 * Both degrade to stock behaviour when their uniforms are never set (e.g. a custom ShaderMaterial).
 */
import { ShaderChunk, ShaderLib, UniformsLib, Vector3, Vector4 } from 'three';

/**
 * vec4 xrFog[10]: [0] = (sunAz.x, sunAz.z, rain-haze extinction 1/m, mode: 0 off / 1 horizon table / 2 table + rain
 * deck), [1..8] = horizon table rgb, [9] = rgb of the thick rain deck overhead.
 */
export const xrFogUniform = { value: new Float32Array(4 * 10) };
/** vec4 xrCsm[4]: per cascade (planeGradientClamp, zBias, filterRadiusTexels, tapCount (cascade 0)). */
export const xrCsmUniform = { value: new Float32Array(4 * 4) };

export const MAX_CASCADES = 4;

/** Street lamps that light every lit material (see installShaderPatches, 3.). */
export const XR_LAMPS = 8;
/** vec4 xrLamp[XR_LAMPS]: lamp head in VIEW space (xyz) and reach in m (w; 0 = unused slot). */
export const xrLampUniform = { value: Array.from({ length: XR_LAMPS }, () => new Vector4()) };
/** vec4 xrLampCol: radiance of a lamp (rgb), w = 1 while any lamp is lit. */
export const xrLampColUniform = { value: new Vector4() };
/** vec3 xrLampUp: world up in view space (the lamps shine down in a wide cone). */
export const xrLampUpUniform = { value: new Vector3(0, 1, 0) };

const LAMP_PARS = /* glsl */ `
uniform vec4 xrLamp[ ${XR_LAMPS} ];
uniform vec4 xrLampCol;
uniform vec3 xrLampUp;
`;

const LAMP_LIGHTS = /* glsl */ `
#if defined( RE_Direct ) && ! defined( XR_NO_LAMPS )
	if ( xrLampCol.w > 0.5 ) {
		IncidentLight xrLight;
		xrLight.visible = true;
		for ( int i = 0; i < ${XR_LAMPS}; i ++ ) {
			vec4 lp = xrLamp[ i ];
			if ( lp.w <= 0.0 ) continue;
			vec3 lv = lp.xyz - geometryPosition;
			float d2 = dot( lv, lv );
			if ( d2 > lp.w * lp.w ) continue;
			float d = sqrt( d2 );
			xrLight.direction = lv / d;
			// same fall-off and cone as the wet road's lamps (track/scene/wet.ts roadLamps)
			float att = 1.0 / ( 1.0 + d2 / ( lp.w * lp.w * 0.08 ) ) * ( 1.0 - smoothstep( 0.55 * lp.w, lp.w, d ) );
			float cone = smoothstep( 0.2, 0.65, dot( xrLight.direction, xrLampUp ) );
			xrLight.color = xrLampCol.rgb * ( att * cone );
			RE_Direct( xrLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		}
	}
#endif
`;

const MARK = '__xrPatched';

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG

	varying float vFogDepth;
	varying vec3 vFogDir;

#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG

	vFogDepth = - mvPosition.z;
	vFogDir = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;

#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG

	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogDir;

	#ifdef FOG_EXP2

		uniform float fogDensity;

	#else

		uniform float fogNear;
		uniform float fogFar;

	#endif

	uniform vec4 xrFog[ 10 ];

	vec3 xrFogColor( vec3 dirN ) {

		if ( xrFog[ 0 ].w < 0.5 ) return fogColor;

		float hl = length( dirN.xz );
		vec2 hn = hl > 1e-4 ? dirN.xz / hl : vec2( 1.0, 0.0 );
		float cr = abs( hn.x * xrFog[ 0 ].y - hn.y * xrFog[ 0 ].x );
		float phi = atan( cr, dot( hn, xrFog[ 0 ].xy ) );
		float t = sqrt( phi / 3.14159265 ) * 7.0;
		int i = clamp( int( floor( t ) ), 0, 6 );
		vec3 c = mix( xrFog[ i + 1 ].rgb, xrFog[ i + 2 ].rgb, clamp( t - float( i ), 0.0, 1.0 ) );

		if ( xrFog[ 0 ].w > 1.5 ) {

			// Under a rain deck the sky above the horizon haze is cooler and darker. Scenery that rises into it
			// (far mountain tops, tall trees) must fade into the sky behind it, not into the bright haze: the same
			// blend as the sky shader's, by the elevation of the view ray.
			float y = max( dirN.y, 0.0 );
			float l = dot( c, vec3( 0.299, 0.587, 0.114 ) );
			c = mix( c, l * vec3( 0.96, 1.0, 1.05 ), 0.8 * smoothstep( 0.02, 0.35, y ) );
			c = mix( c, xrFog[ 9 ].rgb, smoothstep( 0.015, 0.8, y ) );

		}

		return c;

	}

#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG

	#ifdef FOG_EXP2

		// exp2 haze plus the Beer-Lambert rain haze xrFog[0].z (0 when dry: identical to stock)
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth - xrFog[ 0 ].z * vFogDepth );

	#else

		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );

	#endif

	gl_FragColor.rgb = mix( gl_FragColor.rgb, xrFogColor( normalize( vFogDir ) ), fogFactor );

#endif
`;

/** Appended to shadowmap_pars_fragment (inside its #ifdef USE_SHADOWMAP). */
const CSM_FUNCTIONS = /* glsl */ `

	#if NUM_DIR_LIGHT_SHADOWS > 1 && defined( SHADOWMAP_TYPE_PCF )

	#define XR_CSM 1

	uniform vec4 xrCsm[ 4 ];

	float xrCascadeWeight( vec3 s, float fade ) {

		if ( s.z > 1.0 ) return 0.0;
		float e = min( min( s.x, 1.0 - s.x ), min( s.y, 1.0 - s.y ) );
		return smoothstep( 0.0, fade, e );

	}

	// receiver-plane depth gradient (z per uv) from screen-space derivatives of the shadow coordinate
	vec2 xrPlaneGradient( vec3 sx, vec3 sy, float clampTo ) {

		float det = sx.x * sy.y - sx.y * sy.x;
		vec2 g = vec2( 0.0 );
		if ( abs( det ) > 1e-14 ) {
			g = vec2( sy.y * sx.z - sx.y * sy.z, sx.x * sy.z - sy.x * sx.z ) / det;
			g = clamp( g, vec2( - clampTo ), vec2( clampTo ) );
		}
		return g;

	}

	float xrCascadeTap( sampler2DShadow map, vec3 s, vec2 g, vec4 prm, vec2 mapSize ) {

		vec2 texel = 1.0 / mapSize;
		float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
		int taps = int( xrCsm[ 0 ].w );
		if ( taps <= 0 ) return 1.0;
		float sum = 0.0;
		for ( int i = 0; i < 8; i ++ ) {
			if ( i >= taps ) break;
			vec2 o = vogelDiskSample( i, taps, phi ) * prm.z * texel;
			sum += textureLod( map, vec3( s.xy + o, s.z - prm.y + dot( g, o ) ), 0.0 );
		}
		return sum / float( taps );

	}

	float xrCascadeShadow() {

		vec4 c0 = vDirectionalShadowCoord[ 0 ];
		vec3 s0 = c0.xyz / c0.w;
		vec2 g0 = xrPlaneGradient( dFdx( s0 ), dFdy( s0 ), xrCsm[ 0 ].x );
		#if NUM_DIR_LIGHT_SHADOWS > 1
		vec4 c1 = vDirectionalShadowCoord[ 1 ];
		vec3 s1 = c1.xyz / c1.w;
		vec2 g1 = xrPlaneGradient( dFdx( s1 ), dFdy( s1 ), xrCsm[ 1 ].x );
		#endif
		#if NUM_DIR_LIGHT_SHADOWS > 2
		vec4 c2 = vDirectionalShadowCoord[ 2 ];
		vec3 s2 = c2.xyz / c2.w;
		vec2 g2 = xrPlaneGradient( dFdx( s2 ), dFdy( s2 ), xrCsm[ 2 ].x );
		#endif
		#if NUM_DIR_LIGHT_SHADOWS > 3
		vec4 c3 = vDirectionalShadowCoord[ 3 ];
		vec3 s3 = c3.xyz / c3.w;
		vec2 g3 = xrPlaneGradient( dFdx( s3 ), dFdy( s3 ), xrCsm[ 3 ].x );
		#endif

		float result = 0.0;
		float remaining = 1.0;
		float w = xrCascadeWeight( s0, 0.08 );
		if ( w > 0.0 ) {
			result += remaining * w * xrCascadeTap( directionalShadowMap[ 0 ], s0, g0, xrCsm[ 0 ], directionalLightShadows[ 0 ].shadowMapSize );
			remaining *= 1.0 - w;
		}
		#if NUM_DIR_LIGHT_SHADOWS > 1
		if ( remaining > 0.004 ) {
			w = xrCascadeWeight( s1, 0.08 );
			if ( w > 0.0 ) {
				result += remaining * w * xrCascadeTap( directionalShadowMap[ 1 ], s1, g1, xrCsm[ 1 ], directionalLightShadows[ 1 ].shadowMapSize );
				remaining *= 1.0 - w;
			}
		}
		#endif
		#if NUM_DIR_LIGHT_SHADOWS > 2
		if ( remaining > 0.004 ) {
			w = xrCascadeWeight( s2, 0.08 );
			if ( w > 0.0 ) {
				result += remaining * w * xrCascadeTap( directionalShadowMap[ 2 ], s2, g2, xrCsm[ 2 ], directionalLightShadows[ 2 ].shadowMapSize );
				remaining *= 1.0 - w;
			}
		}
		#endif
		#if NUM_DIR_LIGHT_SHADOWS > 3
		if ( remaining > 0.004 ) {
			w = xrCascadeWeight( s3, 0.08 );
			if ( w > 0.0 ) {
				result += remaining * w * xrCascadeTap( directionalShadowMap[ 3 ], s3, g3, xrCsm[ 3 ], directionalLightShadows[ 3 ].shadowMapSize );
				remaining *= 1.0 - w;
			}
		}
		#endif
		result += remaining;
		return mix( 1.0, result, directionalLightShadows[ 0 ].shadowIntensity );

	}

	#endif
`;

const DIR_LIGHT_BLOCK = /* glsl */ `#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

		#if defined( USE_SHADOWMAP ) && defined( XR_CSM ) && ( UNROLLED_LOOP_INDEX > 0 ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		#else

		directionalLight = directionalLights[ i ];

		getDirectionalLightInfo( directionalLight, directLight );

		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		#if defined( XR_CSM )
		directLight.color *= ( directLight.visible && receiveShadow ) ? xrCascadeShadow() : 1.0;
		#else
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		#endif

		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

		#endif

	}
	#pragma unroll_loop_end

#endif`;

export interface PatchResult {
  csm: boolean;
  fog: boolean;
}

let result: PatchResult | null = null;

/** Idempotent. Call before any material is compiled. */
export function installShaderPatches(): PatchResult {
  if (result) return result;
  const chunks = ShaderChunk as unknown as Record<string, string>;
  if ((chunks as Record<string, unknown>)[MARK]) {
    result = { csm: true, fog: true };
    return result;
  }

  let csm = false;
  let fog = false;

  // ---- cascaded shadows -------------------------------------------------------------------
  const pars = chunks.shadowmap_pars_fragment;
  const begin = chunks.lights_fragment_begin;
  const blockRe = /#if \( NUM_DIR_LIGHTS > 0 \) && defined\( RE_Direct \)[\s\S]*?#pragma unroll_loop_end\s*#endif/;
  const lastEndif = typeof pars === 'string' ? pars.lastIndexOf('#endif') : -1;
  if (typeof begin === 'string' && blockRe.test(begin) && lastEndif > 0) {
    chunks.lights_fragment_begin = begin.replace(blockRe, DIR_LIGHT_BLOCK);
    chunks.shadowmap_pars_fragment = pars.slice(0, lastEndif) + CSM_FUNCTIONS + '\n' + pars.slice(lastEndif);
    csm = true;
  } else {
    console.warn('[render] cascaded shadow patch skipped: three.js shader chunks differ from the expected layout');
  }

  // ---- fog --------------------------------------------------------------------------------
  if (
    typeof chunks.fog_vertex === 'string' &&
    chunks.fog_vertex.includes('vFogDepth') &&
    typeof chunks.fog_fragment === 'string' &&
    chunks.fog_fragment.includes('fogColor')
  ) {
    chunks.fog_pars_vertex = FOG_PARS_VERTEX;
    chunks.fog_vertex = FOG_VERTEX;
    chunks.fog_pars_fragment = FOG_PARS_FRAGMENT;
    chunks.fog_fragment = FOG_FRAGMENT;
    fog = true;
  } else {
    console.warn('[render] fog patch skipped: unexpected fog chunks');
  }

  // ---- street lamps -------------------------------------------------------------------------
  let lamps = false;
  if (typeof chunks.lights_pars_begin === 'string' && typeof chunks.lights_fragment_maps === 'string' && chunks.lights_fragment_begin.includes('geometryClearcoatNormal')) {
    chunks.lights_pars_begin = chunks.lights_pars_begin + '\n' + LAMP_PARS;
    chunks.lights_fragment_maps = LAMP_LIGHTS + '\n' + chunks.lights_fragment_maps;
    lamps = true;
  } else {
    console.warn('[render] street-lamp patch skipped: unexpected light chunks');
  }

  // ---- uniforms: make them part of every built-in material's uniform table -----------------
  const lib = ShaderLib as unknown as Record<string, { uniforms?: Record<string, unknown> }>;
  for (const key of Object.keys(lib)) {
    const u = lib[key].uniforms;
    if (!u) continue;
    if (fog && 'fogColor' in u) u.xrFog = xrFogUniform;
    if (csm && 'directionalShadowMatrix' in u) u.xrCsm = xrCsmUniform;
    if (lamps && 'directionalLights' in u) {
      u.xrLamp = xrLampUniform;
      u.xrLampCol = xrLampColUniform;
      u.xrLampUp = xrLampUpUniform;
    }
  }
  const libU = UniformsLib as unknown as Record<string, Record<string, unknown>>;
  if (fog && libU.fog) libU.fog.xrFog = xrFogUniform;
  if (csm && libU.lights) libU.lights.xrCsm = xrCsmUniform;
  if (lamps && libU.lights) {
    libU.lights.xrLamp = xrLampUniform;
    libU.lights.xrLampCol = xrLampColUniform;
    libU.lights.xrLampUp = xrLampUpUniform;
  }

  chunks[MARK] = '1';
  result = { csm, fog };
  return result;
}
