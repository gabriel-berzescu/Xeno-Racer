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
 *    opt out with the define XR_NO_LAMPS; XR_LAMP_SCALE (a GLSL expression) dims them for a material, e.g. a car's
 *    cabin, which only gets what comes in through the glass (there are no lamp shadows). Off (one uniform test)
 *    while xrLampCol.w is 0.
 *
 * 4. Terrain shade. The cascades only carry what casts into them, and the terrain casts nothing: a sun that has set behind a
 *    ridge two kilometres away would still light the road. So the sun (light 0) is multiplied, in every lit material, by the share
 *    of its disc that the terrain leaves visible at the fragment's world position (`xrSunVisAt`: one lookup in the sun
 *    visibility map, render/sunVisibility.ts, shared by all materials and the particles), and the haze is split into its sun
 *    in-scatter and its sky part, of which only the sunlit share of the view ray keeps the sun's (`xrFogColorLit`): a hill in
 *    front of a hidden sun is a dark hazy silhouette with the glow above it, not an orange wall. Off (one uniform test, the
 *    old code bit for bit) while xrSunVis[0].w is 0: no map, a sun that is seen from everywhere (noon), or no sun to speak of.
 *
 * All degrade to stock behaviour when their uniforms are never set (e.g. a custom ShaderMaterial).
 */
import { ClampToEdgeWrapping, FloatType, NearestFilter, RGBAFormat, ShaderChunk, ShaderLib, UniformsLib } from 'three';
import { SharedDataTexture } from './sharedTexture';

/**
 * vec4 xrFog[10]: [0] = (sunAz.x, sunAz.z, rain-haze extinction 1/m, mode: 0 off / 1 horizon table / 1 + d table + rain
 * deck, d = 0..1 how much of the sky is under the deck: 2 is all of it), [1..8] = horizon table rgb, [9] = rgb of the thick
 * rain deck overhead.
 */
export const xrFogUniform = { value: new Float32Array(4 * 10) };
/** vec4 xrCsm[4]: per cascade (planeGradientClamp, zBias, filterRadiusTexels, tapCount (cascade 0)). */
export const xrCsmUniform = { value: new Float32Array(4 * 4) };

export const MAX_CASCADES = 4;

/**
 * vec4 xrFogSun[8]: the part of the horizon table (xrFog[1..8]) that is the sun's own in-scatter (single scattering of the direct
 * sun, with its phase function: the glow toward the sun), rgb in the same units; what is left of the table is the sky's (multiple
 * scattering). The fog keeps the sky part whole and the sun part by the sunlit share of the view ray (SUNVIS_PARS).
 */
export const xrFogSunUniform = { value: new Float32Array(4 * 8) };

/**
 * vec4 xrSunVis[6]: the sun visibility map (sunVisMap.ts writes it, SUNVIS_PARS reads it).
 *   [0] = (sun azimuth x, z, reference height yRef, strength 0..1; 0 = off)
 *   [1] = fine grid:   (1/cell, -u0/cell, -v0/cell, 1/blend nodes; 1/cell = 0: no fine grid)
 *   [2] = fine grid:   (w - 1, h - 1, atlas x + 0.5, atlas y + 0.5)
 *   [3] = coarse grid: (1/cell, -u0/cell, -v0/cell, 0)
 *   [4] = coarse grid: (w - 1, h - 1, atlas x + 0.5, atlas y + 0.5)
 *   [5] = (1/atlas width, 1/atlas height, height bias, 1 = the whole disc is below the horizon)
 */
export const xrSunVisUniform = { value: new Float32Array(4 * 6) };

/**
 * The sun visibility atlas: RGBA32F (or RGBA16F where 32-bit floats do not filter) with the fine and the coarse grid one above the
 * other. One object for every material (SharedDataTexture); sunVisMap.ts replaces its data and, when the size changes, disposes it
 * (three makes the GPU texture again on the next use). Until a map is made it is one texel that says "no terrain": lit.
 */
export const sunVisTexture = new SharedDataTexture(new Float32Array([-1e4, -1e4, 1, 1]), 1, 1, RGBAFormat, FloatType);
sunVisTexture.magFilter = NearestFilter;
sunVisTexture.minFilter = NearestFilter;
sunVisTexture.wrapS = ClampToEdgeWrapping;
sunVisTexture.wrapT = ClampToEdgeWrapping;
sunVisTexture.generateMipmaps = false;
sunVisTexture.name = 'xr.sunVisibility';
sunVisTexture.needsUpdate = true;
export const xrSunVisTexUniform = { value: sunVisTexture as SharedDataTexture };

/** The two uniforms of the sun visibility map, for a ShaderMaterial of its own (the particles) that includes SUNVIS_PARS. */
export const sunVisUniforms = { xrSunVis: xrSunVisUniform, xrSunVisTex: xrSunVisTexUniform };

/** Street lamps that light every lit material (see installShaderPatches, 3.). */
export const XR_LAMPS = 8;
// The lamp uniforms are flat typed arrays, like xrFog and xrCsm: three copies a built-in material's uniforms when it builds
// it (UniformsUtils.cloneUniforms), cloning every Vector (and every array of them), so a Vector value would stay frozen in
// each material at whatever it held then, while a typed array is shared by reference and every update reaches them all.
/** vec4 xrLamp[XR_LAMPS]: lamp head in VIEW space (xyz) and reach in m (w; 0 = unused slot), 4 floats per lamp. */
export const xrLampUniform = { value: new Float32Array(4 * XR_LAMPS) };
/** vec4 xrLampCol: radiance of a lamp (rgb), w = 1 while any lamp is lit. */
export const xrLampColUniform = { value: new Float32Array(4) };
/** vec3 xrLampUp: world up in view space (the lamps shine down in a wide cone). */
export const xrLampUpUniform = { value: new Float32Array([0, 1, 0]) };

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
			#ifdef XR_LAMP_SCALE
				xrLight.color *= XR_LAMP_SCALE;
			#endif
			RE_Direct( xrLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		}
	}
#endif
`;

/**
 * GLSL for the sun visibility map (see sunVisibility.ts for what the numbers are), included once per program by whichever chunk comes
 * first (lights_pars_begin, fog_pars_fragment) and by the particle shaders (their vertex stage). `xrSunVisAt(p)` is the share (0..1)
 * of the sun's disc that a point at world position p sees past the terrain: 1 in the open, 0 behind a hill. Its twin on the CPU is
 * sampleSunVisibility; the two must agree.
 */
export const SUNVIS_PARS = /* glsl */ `
#ifndef XR_SUNVIS_PARS
#define XR_SUNVIS_PARS

uniform vec4 xrSunVis[ 6 ];
uniform sampler2D xrSunVisTex;

// the sun's share this fragment's light 0 keeps after the terrain (set by the lights block, read by whatever else needs the sun: the snow's glitter)
float xrSunVG = 1.0;

float xrSunVisAt( vec3 p ) {

	vec4 s0 = xrSunVis[ 0 ];
	if ( s0.w <= 0.0 ) return 1.0;
	// the whole disc is below the horizon: no sun anywhere
	if ( xrSunVis[ 5 ].w > 0.5 ) return 1.0 - s0.w;

	// the sun's frame: u toward the sun, v across; the grids are laid out in it
	vec2 uv = vec2( dot( p.xz, s0.xy ), dot( p.xz, vec2( - s0.y, s0.x ) ) );
	vec4 a = xrSunVis[ 1 ];
	vec2 ff = uv * a.x + a.yz;
	vec2 fe = min( ff, xrSunVis[ 2 ].xy - ff );
	float e = min( fe.x, fe.y );
	vec4 n;

	if ( a.x > 0.0 && e >= 0.0 ) {

		// inside the fine grid (around the circuit), fading to the coarse one over its last nodes
		n = textureLod( xrSunVisTex, ( ff + xrSunVis[ 2 ].zw ) * xrSunVis[ 5 ].xy, 0.0 );
		float wf = clamp( e * a.w, 0.0, 1.0 );
		if ( wf < 1.0 ) {
			vec2 fc = uv * xrSunVis[ 3 ].x + xrSunVis[ 3 ].yz;
			vec4 nc = textureLod( xrSunVisTex, ( fc + xrSunVis[ 4 ].zw ) * xrSunVis[ 5 ].xy, 0.0 );
			n = mix( nc, n, wf * wf * ( 3.0 - 2.0 * wf ) );
		}

	} else {

		vec4 b = xrSunVis[ 3 ];
		vec2 fc = uv * b.x + b.yz;
		vec2 ce = min( fc, xrSunVis[ 4 ].xy - fc );
		// beyond the terrain that is drawn there is nothing to hide the sun
		if ( min( ce.x, ce.y ) < 0.0 ) return 1.0;
		n = textureLod( xrSunVisTex, ( fc + xrSunVis[ 4 ].zw ) * xrSunVis[ 5 ].xy, 0.0 );

	}

	// n = ( H_lo - yRef, H_hi - yRef, 1 / ( u_lo dt ), 1 / ( u_hi dt ) ): the two horizon lines the disc's lower and upper limb are cut by
	float y = p.y + xrSunVis[ 5 ].z - s0.z;
	float q = max( ( n.x - y ) * n.z, 1.0 + ( n.y - y ) * n.w );
	float c = 1.0 - clamp( q, 0.0, 1.0 );
	return mix( 1.0, c * c * ( 3.0 - 2.0 * c ), s0.w );

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
	uniform vec4 xrFogSun[ 8 ];

	${SUNVIS_PARS}

	vec3 xrFogColor( vec3 dirN ) {

		if ( xrFog[ 0 ].w < 0.5 ) return fogColor;

		float hl = length( dirN.xz );
		vec2 hn = hl > 1e-4 ? dirN.xz / hl : vec2( 1.0, 0.0 );
		float cr = abs( hn.x * xrFog[ 0 ].y - hn.y * xrFog[ 0 ].x );
		float phi = atan( cr, dot( hn, xrFog[ 0 ].xy ) );
		float t = sqrt( phi / 3.14159265 ) * 7.0;
		int i = clamp( int( floor( t ) ), 0, 6 );
		vec3 c = mix( xrFog[ i + 1 ].rgb, xrFog[ i + 2 ].rgb, clamp( t - float( i ), 0.0, 1.0 ) );

		float deck = clamp( xrFog[ 0 ].w - 1.0, 0.0, 1.0 );

		if ( deck > 0.001 ) {

			// Under a rain deck the sky above the horizon haze is cooler and darker. Scenery that rises into it
			// (far mountain tops, tall trees) must fade into the sky behind it, not into the bright haze: the same
			// blend as the sky shader's, by the elevation of the view ray (and by how much of the sky the deck has
			// closed over, while a front passes).
			float y = max( dirN.y, 0.0 );
			float l = dot( c, vec3( 0.299, 0.587, 0.114 ) );
			c = mix( c, l * vec3( 0.96, 1.0, 1.05 ), 0.8 * smoothstep( 0.02, 0.35, y ) * deck );
			c = mix( c, xrFog[ 9 ].rgb, smoothstep( 0.015, 0.8, y ) * deck );

		}

		return c;

	}

	// the sun's own in-scatter in that colour (xrFogSun is the same table, single scattering of the direct sun only); under the rain
	// deck it fades with the deck's blend, as the rest of the colour is blended into the deck's
	vec3 xrFogSunPart( vec3 dirN ) {

		if ( xrFog[ 0 ].w < 0.5 ) return vec3( 0.0 );

		float hl = length( dirN.xz );
		vec2 hn = hl > 1e-4 ? dirN.xz / hl : vec2( 1.0, 0.0 );
		float cr = abs( hn.x * xrFog[ 0 ].y - hn.y * xrFog[ 0 ].x );
		float phi = atan( cr, dot( hn, xrFog[ 0 ].xy ) );
		float t = sqrt( phi / 3.14159265 ) * 7.0;
		int i = clamp( int( floor( t ) ), 0, 6 );
		vec3 c = mix( xrFogSun[ i ].rgb, xrFogSun[ i + 1 ].rgb, clamp( t - float( i ), 0.0, 1.0 ) );

		float deck = clamp( xrFog[ 0 ].w - 1.0, 0.0, 1.0 );

		if ( deck > 0.001 ) {

			float y = max( dirN.y, 0.0 );
			c *= ( 1.0 - 0.8 * smoothstep( 0.02, 0.35, y ) * deck ) * ( 1.0 - smoothstep( 0.015, 0.8, y ) * deck );

		}

		return c;

	}

	#ifdef FOG_EXP2

		// The share (0..1) of the sun's in-scatter along the view ray that is sunlit, from the sun visibility map: HAZE taps along the
		// ray, placed so that each carries the same share of the fog (equal steps of the fog factor F(z) = 1 - exp(-d^2 z^2 - rain z)
		// over the planar depth z are equal shares of the light the ray scatters toward the eye). The CPU twin is hazeSunShare.
		float xrSunHaze( vec3 dirN, float depth, float dist, float F ) {

			float d2 = fogDensity * fogDensity;
			float rain = xrFog[ 0 ].z;
			float stretch = dist / max( depth, 1e-4 );
			float sum = 0.0;
			for ( int k = 0; k < 5; k ++ ) {
				float q = min( 0.999, ( float( k ) + 0.5 ) * 0.2 * F );
				float l = - log( 1.0 - q );
				float z = d2 > 1e-12 ? ( - rain + sqrt( rain * rain + 4.0 * d2 * l ) ) / ( 2.0 * d2 ) : l / max( rain, 1e-6 );
				sum += xrSunVisAt( cameraPosition + dirN * ( z * stretch ) );
			}
			return sum * 0.2;

		}

		// xrFogColor with the sun's part of it scaled by the sunlit share of the ray: the old colour exactly where the ray is in the sun
		vec3 xrFogColorLit( vec3 dirN, float depth, float dist, float F ) {

			vec3 c = xrFogColor( dirN );
			if ( xrSunVis[ 0 ].w > 0.0 && F > 0.012 ) c = max( c - xrFogSunPart( dirN ) * ( 1.0 - xrSunHaze( dirN, depth, dist, F ) ), vec3( 0.0 ) );
			return c;

		}

	#endif

#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG

	#ifdef FOG_EXP2

		// exp2 haze plus the Beer-Lambert rain haze xrFog[0].z (0 when dry: identical to stock)
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth - xrFog[ 0 ].z * vFogDepth );

		gl_FragColor.rgb = mix( gl_FragColor.rgb, xrFogColorLit( normalize( vFogDir ), vFogDepth, length( vFogDir ), fogFactor ), fogFactor );

	#else

		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );

		gl_FragColor.rgb = mix( gl_FragColor.rgb, xrFogColor( normalize( vFogDir ) ), fogFactor );

	#endif

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

		// no sun to speak of (a rain deck): nothing to sample. The same for every fragment, so it costs nothing where the
		// intensity is up. A race whose weather changes keeps its cascades through the rain and fades this to 0.
		if ( directionalLightShadows[ 0 ].shadowIntensity < 0.004 ) return 1.0;

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

		// the terrain hides the sun here (xrSunVG, from the sun visibility map): nothing for the cascades to shade, and the taps are the
		// expensive part. (After the derivatives above: they need every fragment of the quad.)
		if ( xrSunVG < 0.002 ) return 1.0;

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

	// the share of the sun's disc the terrain leaves visible at this fragment (1 where no map is made: the old light exactly)
	xrSunVG = xrSunVisAt( cameraPosition + ( vec4( geometryPosition, 0.0 ) * viewMatrix ).xyz );

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

		#if defined( USE_SHADOWMAP ) && defined( XR_CSM ) && ( UNROLLED_LOOP_INDEX > 0 ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		#else

		directionalLight = directionalLights[ i ];

		getDirectionalLightInfo( directionalLight, directLight );

		#if UNROLLED_LOOP_INDEX == 0
		directLight.color *= xrSunVG;
		#endif

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
  /** The terrain's shade (the sun visibility map) is part of the lights and the fog. */
  sunVis: boolean;
}

let result: PatchResult | null = null;

/** Idempotent. Call before any material is compiled. */
export function installShaderPatches(): PatchResult {
  if (result) return result;
  const chunks = ShaderChunk as unknown as Record<string, string>;
  if ((chunks as Record<string, unknown>)[MARK]) {
    result = { csm: true, fog: true, sunVis: true };
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

  // ---- the terrain's shade -------------------------------------------------------------------
  // (the lights block, the cascade early-out and the fog already carry it; this is the part every lit program needs: the uniform
  // and the function, before the first of them is used, and a lit program that has no fog or no lamps still has it)
  let sunVis = false;
  if (csm && typeof chunks.lights_pars_begin === 'string' && fog) {
    chunks.lights_pars_begin = chunks.lights_pars_begin + '\n' + SUNVIS_PARS;
    sunVis = true;
  } else {
    console.warn('[render] terrain-shade patch skipped: the cascade or fog patch is missing');
  }

  // ---- uniforms: make them part of every built-in material's uniform table -----------------
  const lib = ShaderLib as unknown as Record<string, { uniforms?: Record<string, unknown> }>;
  for (const key of Object.keys(lib)) {
    const u = lib[key].uniforms;
    if (!u) continue;
    if (fog && 'fogColor' in u) {
      u.xrFog = xrFogUniform;
      u.xrFogSun = xrFogSunUniform;
      u.xrSunVis = xrSunVisUniform;
      u.xrSunVisTex = xrSunVisTexUniform;
    }
    if (sunVis && 'directionalLights' in u) {
      u.xrSunVis = xrSunVisUniform;
      u.xrSunVisTex = xrSunVisTexUniform;
    }
    if (csm && 'directionalShadowMatrix' in u) u.xrCsm = xrCsmUniform;
    if (lamps && 'directionalLights' in u) {
      u.xrLamp = xrLampUniform;
      u.xrLampCol = xrLampColUniform;
      u.xrLampUp = xrLampUpUniform;
    }
  }
  const libU = UniformsLib as unknown as Record<string, Record<string, unknown>>;
  if (fog && libU.fog) {
    libU.fog.xrFog = xrFogUniform;
    libU.fog.xrFogSun = xrFogSunUniform;
    libU.fog.xrSunVis = xrSunVisUniform;
    libU.fog.xrSunVisTex = xrSunVisTexUniform;
  }
  if (sunVis && libU.lights) {
    libU.lights.xrSunVis = xrSunVisUniform;
    libU.lights.xrSunVisTex = xrSunVisTexUniform;
  }
  if (csm && libU.lights) libU.lights.xrCsm = xrCsmUniform;
  if (lamps && libU.lights) {
    libU.lights.xrLamp = xrLampUniform;
    libU.lights.xrLampCol = xrLampColUniform;
    libU.lights.xrLampUp = xrLampUpUniform;
  }

  chunks[MARK] = '1';
  result = { csm, fog, sunVis };
  return result;
}
