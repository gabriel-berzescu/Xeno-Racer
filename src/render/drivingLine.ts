/**
 * The driving line (owner: render): the AI's racing line painted on the road in front of the car, coloured by what the driver should
 * be doing: green to keep going, amber to lift or brake soon, red to brake now (src/core/aids.ts has the arithmetic, src/ai/guide.ts the
 * racing line and the speeds). A ribbon with chevrons that point the way, coming out from under the car's nose and fading into the distance.
 *
 * How it sits in the picture. The ribbon is an ordinary transparent mesh of the scene, so it is drawn with the road before the
 * particles, the mirrors and the post chain, under the cars (they are opaque and write depth; the ribbon does not), and the road's
 * wet reflections see it. Three things keep it from fighting the road: it lies 2.5 cm above the road surface at the very point of
 * each of its vertices (pointAt, which follows the elevation and the banking), a polygon offset pulls it towards the camera by a few
 * depth steps (so it still wins at 150 m, where a depth step is centimetres), and it never writes depth. It is not lit: its colours
 * are the colours it is to have on the screen, divided by the exposure of the scene so that dusk and night show the same line as
 * noon (the grade multiplies them by it again), and kept below what the bloom picks up. Where it covers the road the wet-road
 * reflections are turned down in proportion (the alpha channel of the scene buffer is the road's gloss flag, and the ribbon pulls it
 * towards "not glossy" by how much of the road it covers), so a puddle does not wash the line out.
 *
 * Which view draws it. Each human's line lives on a camera layer of its own (LINE_LAYERS); the game turns that layer on for the
 * camera of that seat and for no other, so in a split screen every view shows its own driver's line and nothing else shows any: not
 * the mirrors, nor the TV camera of the replay (which does not have the layer), nor the other view.
 *
 * What it costs. A window of the line (up to 164 rows of 2 m, 328 vertices, fewer at low speed) is rewritten every frame from tables made when the line
 * was built: positions, colours and the along-the-road coordinate of the chevrons, 12 KB, a few tens of microseconds of CPU. The
 * program is one small shader, compiled with the rest of the scene before the race.
 */
import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  SrcAlphaFactor,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';
import { lineColor, lineFade, lineRange, lineShows, lineUrgency, LINE_FROM, type LineShape } from '../core/aids';
import type { LineMode, Seat, TrackRuntime } from '../core/contracts';

/** Camera layers of the two humans' lines. (Layer 0 is the scene's; the mirrors, the shadow cameras and the TV camera see layer 0 only.) */
export const LINE_LAYERS: readonly [number, number] = [5, 6];

/** What the painter needs to know of the guide. */
export interface LineSource {
  /** The speed the line asks of the car at track distance s (m/s). */
  targetAt(s: number): number;
  /** The deceleration (m/s^2) the line brakes at when the car is doing `speed` at track distance `s` (the ground under it matters on snow and ice), and the car's top speed. */
  brakeAt(speed: number, s?: number): number;
  readonly topSpeed: number;
  /** The racing line on a dry road and on a wet one (the same object when the weather cannot change), and where the line is between them (0..1). */
  readonly dry: LineShape;
  readonly wet: LineShape;
  readonly lineBlend: number;
}

export const LINE = {
  /** Half the width of the ribbon (m) and its height over the road (m). */
  halfWidth: 0.5,
  lift: 0.025,
  /** Metres between two rows of the ribbon. */
  rowStep: 2,
  /** How much of the road it covers where it is there at all (the alpha), and the brightness it is given on the screen (before the grade). */
  alpha: 0.66,
  /**
   * The same on a winter circuit. Snow is five times as bright as asphalt: where the headlights and the floodlights fall on it it is far
   * past what the screen can show, and a ribbon that lets a third of that through comes out a pale ghost of its colour. On the lake the
   * ice shows the sky in it, and the ribbon has the same trouble.
   */
  alphaWinter: 0.9,
  gain: 1,
  /** The share of the scene's haze the line takes. */
  fog: 0.4,
  /** Chevrons: metres from the tip of one to the tip of the next, how far back the wings sweep (m), how much of the period is stroke. */
  period: 3.4,
  sweep: 1.1,
  stroke: 0.42,
};

/** The most rows a window ever holds: from a row before the car to the furthest range (320 m), over the row step. */
const MAX_ROWS = Math.ceil(320 / LINE.rowStep) + 4;

const vertexShader = /* glsl */ `
attribute vec4 aColor;
attribute vec2 aInfo;
varying vec4 vColor;
varying vec2 vInfo;
#include <fog_pars_vertex>
void main() {
  vColor = aColor;
  vInfo = aInfo;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const fragmentShader = /* glsl */ `
uniform float uPeriod;
uniform float uSweep;
uniform float uStroke;
uniform float uFog;
varying vec4 vColor;
varying vec2 vInfo;
#include <fog_pars_fragment>
void main() {
  float across = abs( vInfo.x );
  // soft sides
  float edge = 1.0 - smoothstep( 0.5, 1.0, across );
  // chevrons pointing along the direction of travel: a stroke across the ribbon whose centre leads its sides
  float q = ( vInfo.y + across * uSweep ) / uPeriod;
  float f = fract( q );
  float aa = max( fwidth( q ), 1e-3 );
  float stroke = smoothstep( 0.0, aa, f ) * ( 1.0 - smoothstep( uStroke, uStroke + aa, f ) );
  // far away and at grazing angles the strokes are thinner than a pixel: they settle on their average, so nothing shimmers
  float detail = 1.0 - smoothstep( 0.2, 0.5, aa );
  float mark = mix( uStroke, stroke, detail );
  float a = vColor.a * edge * ( 0.5 + 0.5 * mark );
  gl_FragColor = vec4( vColor.rgb * ( 0.9 + 0.2 * mark ), a );
  // the haze (the scene's own, sky-matched fog) takes only a share of the line's colour: a line that melts into the haze at 80 m is no
  // use, and it fades out with distance on its own
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth - xrFog[ 0 ].z * vFogDepth );
      // (the haze in front of a hill that hides the sun has no sun in it: the line fades into that, as the scenery does)
      gl_FragColor.rgb = mix( gl_FragColor.rgb, xrFogColorLit( normalize( vFogDir ) ), fogFactor * uFog );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
      gl_FragColor.rgb = mix( gl_FragColor.rgb, xrFogColor( normalize( vFogDir ) ), fogFactor * uFog );
    #endif
  #endif
}
`;

export class DrivingLine {
  readonly mesh: Mesh;
  /** The window of the line that is drawn this frame, in rows. */
  rows = 0;
  private readonly track: TrackRuntime;
  private readonly src: LineSource;
  private readonly material: ShaderMaterial;
  private readonly geometry: BufferGeometry;
  private readonly position: BufferAttribute;
  private readonly color: BufferAttribute;
  private readonly info: BufferAttribute;
  /** One row every `ds` metres round the lap: the two edges (x, y, z each) of the dry line and of the wet one. */
  private readonly count: number;
  private readonly ds: number;
  private readonly dry: Float32Array;
  private readonly wet: Float32Array;
  private mode: LineMode = 'full';
  private readonly rgb = new Float32Array(3);
  /** How much of the road it covers (see LINE.alpha): more on the snow of a winter circuit. */
  private readonly alpha: number;

  constructor(track: TrackRuntime, src: LineSource, seat: Seat) {
    this.track = track;
    this.src = src;
    this.alpha = track.info.winter ? LINE.alphaWinter : LINE.alpha;
    this.count = Math.max(8, Math.round(track.length / LINE.rowStep));
    this.ds = track.length / this.count;
    this.dry = this.edges(src.dry);
    this.wet = src.wet === src.dry ? this.dry : this.edges(src.wet);

    const g = new BufferGeometry();
    this.position = new BufferAttribute(new Float32Array(MAX_ROWS * 6), 3);
    this.color = new BufferAttribute(new Float32Array(MAX_ROWS * 8), 4);
    this.info = new BufferAttribute(new Float32Array(MAX_ROWS * 4), 2);
    for (const a of [this.position, this.color, this.info]) a.setUsage(DynamicDrawUsage);
    g.setAttribute('position', this.position);
    g.setAttribute('aColor', this.color);
    g.setAttribute('aInfo', this.info);
    const idx = new Uint16Array((MAX_ROWS - 1) * 6);
    for (let r = 0; r < MAX_ROWS - 1; r++) {
      const v = r * 2;
      const o = r * 6;
      idx[o] = v;
      idx[o + 1] = v + 1;
      idx[o + 2] = v + 2;
      idx[o + 3] = v + 2;
      idx[o + 4] = v + 1;
      idx[o + 5] = v + 3;
    }
    g.setIndex(new BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;

    // (the chevrons' period is made to divide the lap, so that they line up where the lap closes)
    const period = track.length / Math.max(1, Math.round(track.length / LINE.period));
    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uPeriod: { value: period }, uSweep: { value: LINE.sweep }, uStroke: { value: LINE.stroke }, uFog: { value: LINE.fog } }]),
      vertexShader,
      fragmentShader,
      fog: true,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      // normal blending for the colour; the alpha channel of the scene buffer is the road's gloss flag (src/render/wet/ssr.ts), and
      // the ribbon moves it towards 1 ("not glossy") by how much of the road it covers
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: SrcAlphaFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -6,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.name = `xr.drivingline.${seat}`;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -4;
    this.mesh.layers.set(LINE_LAYERS[seat]);
    this.mesh.visible = false;
  }

  /** The two edges of a line at every row of the lap, on the road surface. */
  private edges(shape: LineShape): Float32Array {
    const out = new Float32Array(this.count * 6);
    const p = new Vector3();
    const n = shape.n;
    const L = this.track.length;
    for (let k = 0; k < this.count; k++) {
      const s = k * this.ds;
      const f = (s / L) * n;
      const i = Math.floor(f) % n;
      const t = f - Math.floor(f);
      const d = shape.d[i] * (1 - t) + shape.d[(i + 1) % n] * t;
      for (let e = 0; e < 2; e++) {
        this.track.pointAt(s, d + (e === 0 ? LINE.halfWidth : -LINE.halfWidth), p);
        out[k * 6 + e * 3] = p.x;
        out[k * 6 + e * 3 + 1] = p.y + LINE.lift;
        out[k * 6 + e * 3 + 2] = p.z;
      }
    }
    return out;
  }

  /** Off, only where the line asks for a lift or the brake, or all along. */
  setMode(mode: LineMode): void {
    this.mode = mode;
    if (mode === 'off') this.show(false);
  }

  /** Draw it (when the mode is not off) or leave it out. */
  show(on: boolean): void {
    this.mesh.visible = on && this.mode !== 'off';
  }

  /**
   * Rewrite the window of the line for a car `s` metres along the track doing `speed` m/s, in a scene whose exposure is `exposure`, for
   * a camera that wants the first `lead` metres of it left out and the ribbon a share `width` of its width (see lineLead). Nothing here
   * allocates.
   */
  update(s: number, speed: number, exposure: number, lead = 0, width = 1): void {
    if (!this.mesh.visible) return;
    const src = this.src;
    const ds = this.ds;
    const range = lineRange(speed);
    const first = Math.floor((s + LINE_FROM + lead) / ds) - 1;
    const rows = Math.min(MAX_ROWS, Math.ceil(range / ds) + 3);
    const blend = src.wet === src.dry ? 0 : src.lineBlend;
    const mix = blend * blend * (3 - 2 * blend);
    const pos = this.position.array as Float32Array;
    const col = this.color.array as Float32Array;
    const inf = this.info.array as Float32Array;
    const rgb = this.rgb;
    const gain = LINE.gain / Math.max(exposure, 1e-3);
    const brake = src.brakeAt(Math.max(speed, 0), s);
    const top = src.topSpeed;
    const n = this.count;
    for (let j = 0; j < rows; j++) {
      const k = first + j;
      const sRow = k * ds;
      const kk = (((k % n) + n) % n) * 6;
      const dist = sRow - s;
      const o = j * 6;
      if (mix <= 0) for (let e = 0; e < 6; e++) pos[o + e] = this.dry[kk + e];
      else for (let e = 0; e < 6; e++) pos[o + e] = this.dry[kk + e] + (this.wet[kk + e] - this.dry[kk + e]) * mix;
      if (width !== 1) {
        // (narrower: both edges move towards the middle of the row)
        for (let e = 0; e < 3; e++) {
          const mid = (pos[o + e] + pos[o + 3 + e]) * 0.5;
          pos[o + e] = mid + (pos[o + e] - mid) * width;
          pos[o + 3 + e] = mid + (pos[o + 3 + e] - mid) * width;
        }
      }
      const u = lineUrgency(speed, src.targetAt(sRow), dist, brake, top);
      lineColor(u, rgb);
      const a = this.alpha * lineFade(dist, range, lead) * lineShows(this.mode, u);
      const c = j * 8;
      col[c] = col[c + 4] = rgb[0] * gain;
      col[c + 1] = col[c + 5] = rgb[1] * gain;
      col[c + 2] = col[c + 6] = rgb[2] * gain;
      col[c + 3] = col[c + 7] = a;
      const i = j * 4;
      inf[i] = 1;
      inf[i + 2] = -1;
      // (the distance along the track, not wrapped: the chevrons are laid on the road, and their period divides the lap, so they line up at the line)
      inf[i + 1] = inf[i + 3] = sRow;
    }
    this.rows = rows;
    this.position.clearUpdateRanges();
    this.color.clearUpdateRanges();
    this.info.clearUpdateRanges();
    this.position.addUpdateRange(0, rows * 6);
    this.color.addUpdateRange(0, rows * 8);
    this.info.addUpdateRange(0, rows * 4);
    this.position.needsUpdate = true;
    this.color.needsUpdate = true;
    this.info.needsUpdate = true;
    this.geometry.setDrawRange(0, (rows - 1) * 6);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Make the driving line of the human in `seat`, for the guide `src`. Add `.mesh` to the scene. */
export function createDrivingLine(track: TrackRuntime, src: LineSource, seat: Seat): DrivingLine {
  return new DrivingLine(track, src, seat);
}
