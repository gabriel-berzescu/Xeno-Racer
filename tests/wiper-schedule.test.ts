/**
 * The cockpit wiper's schedule: the TypeScript mirror in render/wet/droplets.ts against the GLSL that draws the blade.
 *
 * The picture is the shader. The audio (and anything else) follows the same blade through `wiperState`, so the two must never
 * drift apart: these tests pull the schedule functions out of the real fragment shader, run them as JavaScript and compare them
 * with the mirror at thousands of (time, rain) points, the stroke boundaries included. They also pin down what the audio relies
 * on (the pass's feed: when the blade is on screen, which clock it runs on).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ShaderMaterial } from 'three';
import {
  DropletPass,
  WIPER,
  makeWiperFeed,
  makeWiperState,
  wiperDwell,
  wiperPeriod,
  wiperState,
  wiperStateInto,
} from '../src/render/wet/droplets';

// ── the GLSL schedule, run as JavaScript ─────────────────────────────────────────────────────────────────────────────

function shaderSource(): string {
  const p = new DropletPass();
  const src = (p as unknown as { material: ShaderMaterial }).material.fragmentShader;
  p.dispose();
  return src;
}

/** Body of `float name(...) { ... }` (balanced braces) and its parameter names. */
function glslFunction(src: string, name: string): { params: string[]; body: string } {
  const head = new RegExp(String.raw`float\s+${name}\s*\(([^)]*)\)\s*\{`).exec(src);
  if (!head) throw new Error(`GLSL function ${name} not found in the droplet shader`);
  let depth = 1;
  let i = head.index + head[0].length;
  const start = i;
  while (i < src.length && depth > 0) {
    const c = src[i++];
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  const params = head[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^float\s+/, ''));
  return { params, body: src.slice(start, i - 1) };
}

function glslConst(src: string, name: string): number {
  const m = new RegExp(String.raw`const\s+float\s+${name}\s*=\s*([0-9.eE+-]+)\s*;`).exec(src);
  if (!m) throw new Error(`GLSL constant ${name} not found in the droplet shader`);
  return Number(m[1]);
}

/** The shader's wiperDwell / wiperPeriod / wiperAngle, compiled from its own source text. */
function compileShaderSchedule(src: string): { dwell: (rain: number) => number; period: (rain: number) => number; angle: (t: number, rain: number) => number } {
  const consts = ['W_OUT', 'W_A0', 'W_A1'].map((n) => `const ${n} = ${glslConst(src, n)};`).join('\n');
  const toJs = (s: string): string =>
    s
      .replace(/\bfloat\s+(\w+)\s*=/g, 'const $1 =')
      .replace(/\bmod\(/g, 'glslMod(')
      .replace(/\bmix\(/g, 'glslMix(')
      .replace(/\bsmoothstep\(/g, 'glslSmoothstep(')
      .replace(/\bcos\(/g, 'Math.cos(');
  const fns = ['wiperDwell', 'wiperPeriod', 'wiperAngle']
    .map((n) => {
      const f = glslFunction(src, n);
      return `function ${n}(${f.params.join(', ')}) {${toJs(f.body)}}`;
    })
    .join('\n');
  // uRain is a uniform in the shader: here a variable the three functions close over
  const code = `${consts}\nlet uRain = 0;\n${fns}\nreturn { set(r) { uRain = r; }, wiperDwell, wiperPeriod, wiperAngle };`;
  const glslMod = (x: number, y: number): number => x - y * Math.floor(x / y);
  const glslMix = (a: number, b: number, t: number): number => a * (1 - t) + b * t;
  const glslSmoothstep = (e0: number, e1: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const mod = new Function('glslMod', 'glslMix', 'glslSmoothstep', code)(glslMod, glslMix, glslSmoothstep) as {
    set(r: number): void;
    wiperDwell(): number;
    wiperPeriod(): number;
    wiperAngle(t: number): number;
  };
  return {
    dwell: (rain) => (mod.set(rain), mod.wiperDwell()),
    period: (rain) => (mod.set(rain), mod.wiperPeriod()),
    angle: (t, rain) => (mod.set(rain), mod.wiperAngle(t)),
  };
}

const RAINS = [0, 0.02, 0.2, 0.55, 0.6, 0.65, 0.7, 0.775, 0.85, 0.9, 0.95, 0.99, 1];

/** Deterministic pseudo-random numbers in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('wiper schedule: TypeScript mirror vs the GLSL that draws the blade', () => {
  const src = shaderSource();
  const glsl = compileShaderSchedule(src);

  it('uses the shader\'s own constants', () => {
    expect(glslConst(src, 'W_OUT')).toBe(WIPER.OUT);
    expect(glslConst(src, 'W_A0')).toBe(WIPER.A0);
    expect(glslConst(src, 'W_A1')).toBe(WIPER.A1);
    // the dwell mix: mix(2.4, 0.12, smoothstep(0.6, 0.95, uRain))
    const m = /float\s+wiperDwell\s*\(\s*\)\s*\{\s*return\s+mix\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*smoothstep\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*uRain\s*\)\s*\)\s*;\s*\}/.exec(src);
    expect(m, 'wiperDwell has the expected shape').not.toBeNull();
    expect(Number(m![1])).toBe(WIPER.DWELL_LIGHT);
    expect(Number(m![2])).toBe(WIPER.DWELL_STORM);
    expect(Number(m![3])).toBe(WIPER.RAIN_LO);
    expect(Number(m![4])).toBe(WIPER.RAIN_HI);
  });

  it('dwell and period agree with the shader for every rain', () => {
    for (let r = 0; r <= 1.0001; r += 0.005) {
      expect(Math.abs(wiperDwell(r) - glsl.dwell(r))).toBeLessThan(1e-12);
      expect(Math.abs(wiperPeriod(r) - glsl.period(r))).toBeLessThan(1e-12);
    }
    // the numbers the sound design is built on: a pause of 2.4 s in the "rain" preset (0.55), 0.12 s in a storm (1)
    expect(wiperDwell(0.55)).toBeCloseTo(2.4, 12);
    expect(wiperPeriod(0.55)).toBeCloseTo(3.24, 12);
    expect(wiperDwell(1)).toBeCloseTo(0.12, 12);
    expect(wiperPeriod(1)).toBeCloseTo(0.96, 12);
  });

  it('blade angle agrees with the shader at thousands of (time, rain) points', () => {
    const rnd = lcg(12345);
    const s = makeWiperState();
    let worst = 0;
    let n = 0;
    for (const rain of RAINS) {
      for (let k = 0; k < 4000; k++) {
        const t = rnd() * 3600;
        wiperStateInto(s, t, rain);
        const d = Math.abs(s.angle - glsl.angle(t, rain));
        worst = Math.max(worst, d);
        n++;
      }
    }
    expect(n).toBeGreaterThan(50000);
    expect(worst).toBeLessThan(1e-9);
  });

  it('and exactly at the stroke boundaries and either side of them', () => {
    const s = makeWiperState();
    let worst = 0;
    for (const rain of RAINS) {
      const P = glsl.period(rain);
      for (const cycle of [0, 1, 2, 7, 100, 1000]) {
        for (const edge of [0, WIPER.OUT, 2 * WIPER.OUT, P]) {
          for (const eps of [-1e-3, -1e-6, 0, 1e-9, 1e-6, 1e-3]) {
            const t = cycle * P + edge + eps;
            if (t < 0) continue;
            wiperStateInto(s, t, rain);
            worst = Math.max(worst, Math.abs(s.angle - glsl.angle(t, rain)));
          }
        }
      }
    }
    expect(worst).toBeLessThan(1e-6); // a boundary can fall either side by float rounding; the angle is continuous across it
  });

  it('the GPU\'s float32 clock costs the sync well under a millisecond', () => {
    // uTime reaches the shader as a float32; at its worst (just under the 3600 s wrap) one ulp is 0.24 ms
    const rnd = lcg(777);
    const s = makeWiperState();
    const maxOmega = ((WIPER.A1 - WIPER.A0) * Math.PI) / (2 * WIPER.OUT); // rad/s at mid-stroke
    let worstSeconds = 0;
    for (let k = 0; k < 20000; k++) {
      const rain = RAINS[k % RAINS.length];
      const t = rnd() * 3600;
      wiperStateInto(s, t, rain);
      const gpu = glsl.angle(Math.fround(t), rain);
      worstSeconds = Math.max(worstSeconds, Math.abs(gpu - s.angle) / maxOmega);
    }
    expect(worstSeconds).toBeLessThan(0.0006);
  });
});

describe('wiperState', () => {
  it('walks out, back, parked and around again', () => {
    const rain = 0.55;
    const P = wiperPeriod(rain);
    const at = (t: number) => wiperState(t, rain);
    expect(at(0).stroke).toBe('out');
    expect(at(0.2).stroke).toBe('out');
    expect(at(WIPER.OUT - 1e-6).stroke).toBe('out');
    expect(at(WIPER.OUT).stroke).toBe('back');
    expect(at(0.6).stroke).toBe('back');
    expect(at(2 * WIPER.OUT - 1e-6).stroke).toBe('back');
    expect(at(2 * WIPER.OUT).stroke).toBe('parked');
    expect(at(2).stroke).toBe('parked');
    expect(at(P - 1e-6).stroke).toBe('parked');
    expect(at(P).stroke).toBe('out');
    expect(at(P * 5 + 0.1).stroke).toBe('out');
  });

  it('is parked at the park angle between sweeps, reaches the far end exactly at the turn', () => {
    const rain = 1;
    const a = wiperState(0, rain);
    expect(a.angle).toBeCloseTo(WIPER.A0, 12);
    expect(a.angle01).toBeCloseTo(0, 12);
    expect(a.speed01).toBeCloseTo(0, 12);
    const turn = wiperState(WIPER.OUT, rain);
    expect(turn.angle).toBeCloseTo(WIPER.A1, 12);
    expect(turn.angle01).toBeCloseTo(1, 12);
    expect(turn.speed01).toBeCloseTo(0, 6);
    const mid = wiperState(WIPER.OUT / 2, rain);
    expect(mid.speed01).toBeCloseTo(1, 9);
    expect(mid.angle01).toBeCloseTo(0.5, 7); // the shader's pi is 3.14159265
    const end = wiperState(2 * WIPER.OUT + 1e-9, rain);
    expect(end.stroke).toBe('parked');
    expect(end.angle).toBeCloseTo(WIPER.A0, 9);
    const rest = wiperState(2 * WIPER.OUT + 0.05, rain);
    expect(rest.angle).toBeCloseTo(WIPER.A0, 12);
    expect(rest.speed01).toBe(0);
    expect(rest.s).toBe(0);
  });

  it('the blade angle is continuous in time and its speed is sin(pi s)', () => {
    for (const rain of [0.2, 0.55, 0.8, 1]) {
      const P = wiperPeriod(rain);
      const dt = 1e-4;
      const omegaMax = ((WIPER.A1 - WIPER.A0) * Math.PI) / (2 * WIPER.OUT);
      let prev = wiperState(0, rain).angle;
      for (let t = dt; t < 3 * P; t += dt) {
        const s = wiperState(t, rain);
        // no jump anywhere (the park -> out, out -> back and back -> park boundaries included)
        expect(Math.abs(s.angle - prev)).toBeLessThan(omegaMax * dt * 1.02 + 1e-12);
        // |d angle / dt| = peak speed * speed01
        const measured = Math.abs(s.angle - prev) / dt;
        if (s.stroke !== 'parked') expect(Math.abs(measured - omegaMax * s.speed01)).toBeLessThan(omegaMax * 0.02 + 1e-3);
        prev = s.angle;
      }
    }
  });

  it('progress runs 0..1 through each stroke, and through the pause', () => {
    const rain = 0.55;
    expect(wiperState(0.105, rain).progress).toBeCloseTo(0.25, 9);
    expect(wiperState(WIPER.OUT + 0.21, rain).progress).toBeCloseTo(0.5, 9);
    const pause = wiperDwell(rain);
    expect(wiperState(2 * WIPER.OUT + pause * 0.75, rain).progress).toBeCloseTo(0.75, 9);
  });

  it('is sane for nonsense: negative, NaN and infinite input never throw and stay finite', () => {
    for (const [t, r] of [
      [-5, 0.5],
      [Number.NaN, 1],
      [10, Number.NaN],
      [Number.POSITIVE_INFINITY, 0.5],
      [3, -2],
    ] as const) {
      const s = wiperState(t, r);
      for (const k of ['phase', 'period', 'angle', 'angle01', 'speed01', 'progress'] as const) expect(Number.isFinite(s[k]), `${k} at (${t}, ${r})`).toBe(true);
    }
  });

  it('wiperStateInto fills the object it is given and allocates nothing', () => {
    const s = makeWiperState();
    const keys = Object.keys(s);
    const r = wiperStateInto(s, 0.3, 1);
    expect(r).toBe(s);
    expect(Object.keys(s)).toEqual(keys);
    expect(s.stroke).toBe('out');
  });
});

describe('DropletPass.wiperFeed: what the audio follows', () => {
  const feed = () => makeWiperFeed();

  it('says nothing is drawn until the pass runs', () => {
    const p = new DropletPass();
    expect(p.wiperFeed(feed()).drawn).toBe(false); // starts disabled
    p.dispose();
  });

  it('the blade is drawn exactly when the shader would draw it: pass on, windscreen variant, wiper on', () => {
    const p = new DropletPass();
    const f = feed();
    p.enabled = true;
    p.lens = false;
    p.wiper = true;
    expect(p.wiperFeed(f).drawn).toBe(true);
    p.lens = true; // hood / bumper
    expect(p.wiperFeed(f).drawn).toBe(false);
    p.lens = false;
    p.wiper = false;
    expect(p.wiperFeed(f).drawn).toBe(false);
    p.wiper = true;
    p.enabled = false; // dry, or the camera is outside
    expect(p.wiperFeed(f).drawn).toBe(false);
    p.enabled = true;
    for (const [lens, wiper] of [
      [false, true],
      [true, true],
      [false, false],
      [true, false],
    ] as const) {
      p.lens = lens;
      p.wiper = wiper;
      expect(p.wiperFeed(f).drawn).toBe(wiper && !lens);
    }
    p.dispose();
    // ... the same condition render() feeds the shader's uWiper with (the pass only draws while it is enabled)
    expect(readFileSync('src/render/wet/droplets.ts', 'utf8')).toContain('u.uWiper.value = this.wiper && !this.lens ? 1 : 0;');
  });

  it('carries the pass\'s own clock and rain, and the schedule computed from them', () => {
    const p = new DropletPass();
    const f = feed();
    p.enabled = true;
    p.rain = 0.55;
    expect(p.clock).toBe(0);
    for (let i = 0; i < 90; i++) p.tick(1 / 60);
    p.wiperFeed(f);
    expect(f.time).toBeCloseTo(1.5, 9);
    expect(f.time).toBe(p.clock);
    expect(f.rain).toBe(0.55);
    expect(f.state.period).toBeCloseTo(3.24, 12);
    expect(f.state.stroke).toBe('parked'); // 1.5 s: past the sweep (0.84 s), in the 2.4 s pause
    expect(f.state.phase).toBeCloseTo(1.5, 9);
    const ref = wiperState(f.time, f.rain);
    expect(f.state).toEqual(ref);
    p.rain = 1;
    p.wiperFeed(f);
    expect(f.state.period).toBeCloseTo(0.96, 12);
    expect(f.state).toEqual(wiperState(p.clock, 1));
    p.dispose();
  });

  it('refills the object it is given (no allocation per frame) and wraps with the pass\'s 3600 s clock', () => {
    const p = new DropletPass();
    const f = feed();
    const state = f.state;
    p.enabled = true;
    p.rain = 1;
    p.tick(3599.9);
    p.tick(0.2);
    expect(p.wiperFeed(f)).toBe(f);
    expect(f.state).toBe(state);
    expect(f.time).toBeCloseTo(0.1, 6); // wrapped
    expect(f.state).toEqual(wiperState(f.time, 1));
    p.dispose();
  });
});
