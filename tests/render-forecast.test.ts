/**
 * The look of weather that changes (headless, Node): the two ends of a forecast blended into every frame between them. The blend
 * has to be exactly the preset at either end, move one way and smoothly in between (no frame may step), keep the haze of the rain
 * with the rain and the clouds with the sky, and cost nothing but arithmetic.
 */
import { describe, expect, it } from 'vitest';
import { WEATHER_WATER, type TimeOfDay, type Weather } from '../src/core/contracts';
import { blendInto, cloneSolution, rainFogFor, skyCurves, solveEnvironment, type EnvSolution } from '../src/render/environment';
import { WEATHER } from '../src/render/presets';
import { skyFragmentShader } from '../src/render/skyShader';
import { SkyDome } from '../src/render/sky';
import { casterKinds } from '../src/render/casters';
import { SHADOW_OFF, shadowConfigFor, SunShadows } from '../src/render/shadows';
import { installShaderPatches } from '../src/render/shaderPatches';
import { BoxGeometry, Color, DoubleSide, Group, InstancedMesh, Mesh, MeshBasicMaterial, MeshStandardMaterial, ShaderChunk, Texture } from 'three';
import { readFileSync } from 'node:fs';

const TODS: TimeOfDay[] = ['dawn', 'noon', 'golden', 'dusk', 'night'];
const PAIRS: [Weather, Weather][] = [
  ['clear', 'rain'],
  ['cloudy', 'storm'],
  ['overcast', 'rain'],
];

/** Every number the shaders and the light rig read, as name -> flat numbers. */
function numbers(s: EnvSolution): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'settings' || k === 'tod' || k === 'model') continue;
    if (k === 'weather') {
      for (const [wk, wv] of Object.entries(v as unknown as Record<string, number>)) out['weather.' + wk] = [wv];
    } else if (typeof v === 'number') out[k] = [v];
    else out[k] = Array.from(v as ArrayLike<number>);
  }
  return out;
}

const solved = new Map<string, EnvSolution>();
async function solve(timeOfDay: TimeOfDay, weather: Weather): Promise<EnvSolution> {
  const key = `${timeOfDay}/${weather}`;
  let s = solved.get(key);
  if (!s) {
    s = await solveEnvironment({ timeOfDay, weather });
    solved.set(key, s);
  }
  return s;
}

describe('the sky curves', () => {
  it('start at nothing, end at everything, and only ever rise', () => {
    const c0 = skyCurves(0);
    const c1 = skyCurves(1);
    for (const k of ['sun', 'amb', 'cloud', 'deck'] as const) {
      expect(c0[k], k).toBe(0);
      expect(c1[k], k).toBe(1);
    }
    const prev = { sun: 0, amb: 0, cloud: 0, deck: 0 };
    for (let s = 0; s <= 1.0001; s += 0.01) {
      const c = skyCurves(s);
      for (const k of ['sun', 'amb', 'cloud', 'deck'] as const) {
        expect(c[k], k).toBeGreaterThanOrEqual(prev[k] - 1e-12);
        prev[k] = c[k];
      }
    }
    // the sun is shut out before the deck comes in, and the deck is the last to arrive
    const mid = skyCurves(0.4);
    expect(mid.sun).toBeGreaterThan(mid.deck);
    expect(mid.cloud).toBeGreaterThan(mid.deck);
    // out-of-range input is clamped
    expect(skyCurves(-3).deck).toBe(0);
    expect(skyCurves(7).sun).toBe(1);
  });
});

describe('the rain haze', () => {
  it('is the presets own at their rain, nothing when dry, and grows with the rain', () => {
    expect(rainFogFor(0)).toBe(0);
    expect(rainFogFor(WEATHER_WATER.rain.rain)).toBeCloseTo(WEATHER.rain.rainFog, 12);
    expect(rainFogFor(WEATHER_WATER.storm.rain)).toBeCloseTo(WEATHER.storm.rainFog, 12);
    let prev = 0;
    for (let r = 0; r <= 1.0001; r += 0.01) {
      expect(rainFogFor(r)).toBeGreaterThanOrEqual(prev);
      prev = rainFogFor(r);
    }
    expect(rainFogFor(-1)).toBe(0);
    expect(rainFogFor(5)).toBeCloseTo(WEATHER.storm.rainFog, 12);
  });
});

describe('blending the two ends of a forecast', () => {
  it('is exactly the dry preset at the dry end and exactly the wet one at the wet end, for every light', async () => {
    for (const tod of TODS) {
      for (const [dryW, wetW] of PAIRS) {
        const dry = await solve(tod, dryW);
        const wet = await solve(tod, wetW);
        const out = cloneSolution(dry);
        const a = numbers(blendInto(out, dry, wet, 0, 0));
        const da = numbers(dry);
        const b = numbers(blendInto(out, dry, wet, 1, WEATHER_WATER[wetW].rain));
        const wb = numbers(wet);
        for (const k of Object.keys(da)) {
          if (k === 'weather.rainFog') continue; // the preset's own rain haze is carried by the rain, not the sky (checked below)
          for (let i = 0; i < da[k].length; i++) {
            expect(a[k][i], `${tod} ${dryW}->${wetW} dry end ${k}[${i}]`).toBeCloseTo(da[k][i], 9);
            expect(b[k][i], `${tod} ${dryW}->${wetW} wet end ${k}[${i}]`).toBeCloseTo(wb[k][i], 9);
          }
        }
        expect(a['weather.rainFog'][0]).toBe(0);
        expect(b['weather.rainFog'][0]).toBeCloseTo(wb['weather.rainFog'][0], 12);
        expect(out.model).toBe(dry.model);
      }
    }
  }, 120000);

  it('moves every quantity one way from the dry end to the wet one, with no step the size of a pop between two frames', async () => {
    const steps = 200;
    for (const tod of TODS) {
      for (const [dryW, wetW] of PAIRS) {
        const dry = await solve(tod, dryW);
        const wet = await solve(tod, wetW);
        const out = cloneSolution(dry);
        const frames: Record<string, number[]>[] = [];
        for (let i = 0; i <= steps; i++) frames.push(numbers(blendInto(out, dry, wet, i / steps, WEATHER_WATER[wetW].rain * (i / steps))));
        for (const k of Object.keys(frames[0])) {
          for (let c = 0; c < frames[0][k].length; c++) {
            const v = frames.map((f) => f[k][c]);
            const range = v[steps] - v[0];
            const span = Math.max(...v) - Math.min(...v);
            const tag = `${tod} ${dryW}->${wetW} ${k}[${c}]`;
            for (const x of v) expect(Number.isFinite(x), tag).toBe(true);
            if (span < 1e-12) continue;
            // monotone: it never turns round (a hair of rounding allowed)
            const dir = Math.sign(range) || 1;
            for (let i = 1; i <= steps; i++) expect((v[i] - v[i - 1]) * dir, `${tag} @${i}`).toBeGreaterThanOrEqual(-1e-9 * span);
            // smooth: no frame carries more than 3 % of the whole change (the quickest curve moves ~1.4 % per 1/200)
            for (let i = 1; i <= steps; i++) expect(Math.abs(v[i] - v[i - 1]) / span, `${tag} @${i}`).toBeLessThan(0.03);
          }
        }
      }
    }
  }, 240000);

  it('the picture does not pump: the light a surface sees changes smoothly, and in the end is darker', async () => {
    // what a grey ground sees: sun on it (at its elevation) plus the sky's light, times the exposure the picture is made at
    const seen = (s: EnvSolution): number => s.exposure * (s.lightIntensity * Math.max(0.15, s.sunDir[1]) / Math.PI + (s.skyAmbient[0] * 0.2126 + s.skyAmbient[1] * 0.7152 + s.skyAmbient[2] * 0.0722));
    for (const tod of ['noon', 'golden', 'dusk'] as TimeOfDay[]) {
      const dry = await solve(tod, 'clear');
      const wet = await solve(tod, 'storm');
      const out = cloneSolution(dry);
      const v: number[] = [];
      for (let i = 0; i <= 200; i++) v.push(seen(blendInto(out, dry, wet, i / 200, i / 200)));
      expect(v[200], tod).toBeLessThan(v[0]);
      // no frame changes the exposed brightness by more than 6 % of what it was (a pop would be a jump of tens of %)
      for (let i = 1; i <= 200; i++) expect(Math.abs(v[i] - v[i - 1]) / v[i - 1], `${tod} @${i}`).toBeLessThan(0.06);
    }
  }, 120000);

  it('the deck of cloud follows the sky and the haze of the rain follows the rain, each on its own', async () => {
    const dry = await solve('noon', 'clear');
    const wet = await solve('noon', 'rain');
    const out = cloneSolution(dry);
    blendInto(out, dry, wet, 0.9, 0);
    expect(out.deck).toBeGreaterThan(0.7);
    expect(out.rainFog).toBe(0);
    blendInto(out, dry, wet, 0, 0.55);
    expect(out.deck).toBe(0);
    expect(out.rainFog).toBeGreaterThan(0);
    // the same rain gives the same haze whatever the sky
    const a = blendInto(out, dry, wet, 0.3, 0.4).rainFog;
    const b = blendInto(out, dry, wet, 0.8, 0.4).rainFog;
    expect(a).toBe(b);
  });

  it('writes into the target and leaves both ends alone; a clone owns its arrays', async () => {
    const dry = await solve('golden', 'clear');
    const wet = await solve('golden', 'rain');
    const dryBefore = JSON.stringify(numbers(dry));
    const wetBefore = JSON.stringify(numbers(wet));
    const out = cloneSolution(dry);
    expect(out.fogTable).not.toBe(dry.fogTable);
    expect(out.lightColor).not.toBe(dry.lightColor);
    expect(out.weather).not.toBe(dry.weather);
    expect(out.settings).not.toBe(dry.settings);
    for (let i = 0; i <= 20; i++) blendInto(out, dry, wet, i / 20, i / 40);
    expect(JSON.stringify(numbers(dry))).toBe(dryBefore);
    expect(JSON.stringify(numbers(wet))).toBe(wetBefore);
    expect(blendInto(out, dry, wet, 0.5, 0.3)).toBe(out);
  });

  it('is cheap: a frame of it is a few microseconds of arithmetic and allocates nothing it keeps', async () => {
    const dry = await solve('dusk', 'cloudy');
    const wet = await solve('dusk', 'storm');
    const out = cloneSolution(dry);
    for (let i = 0; i < 2000; i++) blendInto(out, dry, wet, (i % 100) / 100, 0.5);
    const t0 = performance.now();
    const n = 20000;
    for (let i = 0; i < n; i++) blendInto(out, dry, wet, (i % 100) / 100, 0.5);
    const per = (performance.now() - t0) / n;
    expect(per).toBeLessThan(0.05); // ms
  });

  it('the moon shows by night: the whole disc in a clear sky, a glow behind the deck, nothing by day', async () => {
    const day = await solve('noon', 'clear');
    expect(day.moonVis).toBe(0);
    const clear = await solve('night', 'clear');
    const rain = await solve('night', 'rain');
    expect(clear.moonVis).toBeCloseTo(1, 9);
    expect(rain.moonVis).toBeCloseTo(0.6, 9);
    const out = cloneSolution(clear);
    blendInto(out, clear, rain, 0.5, 0);
    expect(out.moonVis).toBeGreaterThan(0.6);
    expect(out.moonVis).toBeLessThan(1);
  });
});

describe('the sky dome through a change', () => {
  it('keeps its LUT texture while the sky model stays the same, and takes a new one with a new model', async () => {
    const dry = await solve('noon', 'clear');
    const wet = await solve('noon', 'rain');
    const dome = new SkyDome();
    dome.apply(dry);
    const lut = dome.material.uniforms.uLut.value;
    expect(lut).not.toBeNull();
    // every frame of a changing weather applies a blend that shares the dry model: nothing is converted or uploaded again
    const out = cloneSolution(dry);
    for (let i = 0; i <= 10; i++) {
      dome.apply(blendInto(out, dry, wet, i / 10, i / 20));
      expect(dome.material.uniforms.uLut.value).toBe(lut);
    }
    // and what it does take from the blend is the cloud: the deck, the cover, the overcast, the moon
    const u = dome.material.uniforms;
    dome.apply(blendInto(out, dry, wet, 0.5, 0));
    expect(u.uDeck.value).toBeGreaterThan(0);
    expect(u.uDeck.value).toBeLessThan(1);
    expect(u.uCoverage.value).toBeGreaterThan(dry.weather.coverage);
    expect(u.uOvercast.value).toBeGreaterThan(0);
    dome.apply(blendInto(out, dry, wet, 1, 0.55));
    expect(u.uDeck.value).toBe(1);
    expect(u.uOvercast.value).toBeCloseTo(wet.weather.overcast, 9);
    // a different model is a different texture
    dome.apply(wet);
    expect(u.uLut.value).not.toBe(lut);
    dome.dispose();
  });
});

describe('the shadow cascades of a changing weather', () => {
  it('knows when every cascade has its map: the shadow pass has to have run once before anything that samples a map is drawn', () => {
    const sun = new SunShadows(true);
    sun.configure(shadowConfigFor('high', 'high'));
    expect(sun.cascadeCount).toBe(3);
    expect(sun.mapsReady).toBe(false);
    const fakeMap = (): { dispose(): void } => ({ dispose() {} });
    for (let i = 0; i < 2; i++) (sun.lights[i].shadow as unknown as { map: unknown }).map = fakeMap();
    expect(sun.mapsReady).toBe(false);
    (sun.lights[2].shadow as unknown as { map: unknown }).map = fakeMap();
    expect(sun.mapsReady).toBe(true);
    // no cascades, no maps to wait for
    sun.configure(SHADOW_OFF);
    expect(sun.mapsReady).toBe(true);
  });
});

describe('the shaders that carry the change', () => {
  it('the sky closes a deck over the open sky in patches, exactly nothing at 0 and exactly all of it at 1', () => {
    expect(skyFragmentShader).toContain('float deckCover(vec3 d)');
    expect(skyFragmentShader).toContain('if (uDeck >= 0.999)');
    expect(skyFragmentShader).toContain('if (uDeck > 0.001) col = mix(col, deckSky(d, mu), deckCover(d));');
    // the patch edge is 0 whatever the noise says when uDeck is 0, and 1 when it is 1: check the constants in the shader
    const m = /float edge = uDeck \* ([\d.]+) - ([\d.]+) \+ \(0\.5 - n\) \* ([\d.]+) \+ side \* ([\d.]+) \* \(1\.0 - y\);\s*return smoothstep\(0\.0, ([\d.]+), edge\);/.exec(skyFragmentShader);
    expect(m).not.toBeNull();
    const [, gain, bias, nAmp, sAmp, width] = m!.map(Number);
    // worst cases of the noise n in [0, 1] and the side term in [-1, 1]
    const worstOpen = 0 * gain - bias + 0.5 * nAmp + sAmp; // uDeck 0, the patchiest noise
    const worstClosed = 1 * gain - bias - 0.5 * nAmp - sAmp; // uDeck 1
    expect(worstOpen).toBeLessThanOrEqual(0);
    expect(worstClosed).toBeGreaterThanOrEqual(width);
  });

  it('the sun shadow is not sampled at all once the intensity is nothing, so a race can keep its cascades through the rain', () => {
    installShaderPatches();
    const pars = (ShaderChunk as unknown as Record<string, string>).shadowmap_pars_fragment;
    expect(pars).toContain('if ( directionalLightShadows[ 0 ].shadowIntensity < 0.004 ) return 1.0;');
    // and the sampling comes after it
    expect(pars.indexOf('shadowIntensity < 0.004')).toBeLessThan(pars.indexOf('vec4 c0 = vDirectionalShadowCoord[ 0 ];'));
  });

  it('the first drops on the glass grow from nothing: no drop is born at full size, and none appears at all in a trace of rain', () => {
    const src = readFileSync('src/render/wet/droplets.ts', 'utf8');
    expect(src).toContain('float on = smoothstep(0.0, 1.0, (live - n.x) / max(0.35 * live, 1e-5));');
    expect(src).toContain('float r = mix(rLo, rHi, m.y) * grow * on;');
    expect(src).toContain('smoothstep(0.0, 0.14, uGlass)');
    expect(src).toContain('uGlass < 0.004');
    // a few big drops come first, and are gone (to exactly nothing) from a rain of 0.22 up
    expect(src).toContain('float first = smoothstep(0.004, 0.03, uGlass) * (1.0 - smoothstep(0.03, 0.22, uGlass))');
    // the wiper's schedule stays on uRain (a setting that changes only while the blade is parked), the glass is uGlass
    expect(src).toContain('float wiperDwell() { return mix(2.4, 0.12, smoothstep(0.6, 0.95, uRain)); }');
    // the wiper's flag is still what switches the blade (the wiper tests read this line)
    expect(src).toContain('u.uWiper.value = this.wiper && !this.lens ? 1 : 0;');
  });
});

describe('the warm-up of the shadow depth programs', () => {
  const box = new BoxGeometry();
  const casts = <T extends Mesh>(m: T): T => {
    m.castShadow = true;
    return m;
  };

  it('picks one caster of every kind of depth program, wherever it stands, and none that casts no shadow or is hidden', () => {
    const scene = new Group();
    const plain = casts(new Mesh(box, new MeshStandardMaterial()));
    // another kind of material, the same depth program, a long way off: not a kind of its own
    const sameKind = casts(new Mesh(box, new MeshBasicMaterial()));
    sameKind.position.set(900, 0, 0);
    // a fence: two-sided and alpha-tested through a map, further from the grid than the cascades reach
    const fence = casts(new Mesh(box, new MeshStandardMaterial({ map: new Texture(), alphaTest: 0.35, side: DoubleSide })));
    fence.position.set(4000, 0, 0);
    const trees = casts(new InstancedMesh(box, new MeshStandardMaterial(), 4));
    // instances with a colour each are another program
    const colourful = casts(new InstancedMesh(box, new MeshStandardMaterial(), 4));
    colourful.setColorAt(0, new Color(1, 0, 0));
    const noShadow = new Mesh(box, new MeshStandardMaterial({ map: new Texture(), alphaTest: 0.5 }));
    const hidden = casts(new Mesh(box, new MeshStandardMaterial({ side: DoubleSide, alphaTest: 0.2 })));
    hidden.visible = false;
    const room = new Group();
    room.visible = false;
    room.add(casts(new Mesh(box, new MeshStandardMaterial({ alphaMap: new Texture(), alphaTest: 0.5 }))));
    scene.add(plain, sameKind, fence, trees, colourful, noShadow, hidden, room);
    expect(casterKinds(scene)).toEqual([plain, fence, trees, colourful]);
  });

  it('takes the first of a kind in the order of the scene, and a mesh with several materials once for each kind it brings', () => {
    const scene = new Group();
    const a = casts(new Mesh(box, new MeshStandardMaterial()));
    const b = casts(new Mesh(box, new MeshStandardMaterial()));
    const two = casts(new Mesh(box, [new MeshStandardMaterial(), new MeshStandardMaterial({ map: new Texture(), alphaTest: 0.5 })]));
    scene.add(a, b, two);
    // (the plain material of the third mesh is a kind already taken; its alpha-tested one is new)
    expect(casterKinds(scene)).toEqual([a, two]);
    expect(casterKinds(new Group())).toEqual([]);
  });
});
