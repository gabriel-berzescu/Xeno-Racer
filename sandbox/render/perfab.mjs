#!/usr/bin/env node
/**
 * Where does the GPU time go? Interleaved A/B of the GPU frame time in the real game (owner: render).
 *
 *   node sandbox/render/perfab.mjs --port 5199 [--track isvik] [--tod golden] [--weather clear] [--split 1] [--w 1920] [--h 1080]
 *        [--variants base,noTreeShadow,noShadows,noTerrain] [--cycles 24] [--win 900] [--warm 14]
 *
 * Starts a quick race with the autopilot and, once the pack has got going, switches one thing of the scene off for a window, on again, and
 * on to the next, round and round, sampling the GPU frame time (EXT_disjoint_timer_query, raw per frame) all the while. Every variant is
 * measured over the same stretches of the lap, which a run of one variant after another is not: the cost of a scene depends on where
 * on the lap the cars are. Prints the median and p95 of each and what it saves against the first (the base).
 *
 * Variants (switch off): noShadows (nothing casts into the sun's cascades), noTreeShadow, noBankShadow, noCarShadow, noTerrain, noRoad,
 * noBanks, noProps, noCars. (Hiding the trees, `^tree*`, does not hold: the tree system shows them again every frame.)
 * One run at a time: the GPU is shared. Needs the page's `window.__GAME__` and a browser with the developer extensions on.
 */
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const opt = { port: 5199, track: 'isvik', tod: 'golden', weather: 'clear', split: '0', w: 1920, h: 1080, variants: 'base,noTreeShadow,noShadows,noTerrain', cycles: 24, win: 900, warm: 14, q: 'high', car: 'vanta-gt', opp: 7 };
for (let i = 0; i < argv.length; i += 2) opt[argv[i].slice(2)] = argv[i + 1];
const variants = String(opt.variants).split(',');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu', '--enable-webgl-developer-extensions', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: +opt.w, height: +opt.h } });
if (opt.split === '1') await page.addInitScript({ path: fileURLToPath(new URL('../../scripts/fixtures/fake-pad.js', import.meta.url)) });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const url = `http://127.0.0.1:${opt.port}/?quick=race&track=${opt.track}&car=${opt.car}&opp=${opt.opp}&tod=${opt.tod}&weather=${opt.weather}&cam=chase&autopilot=1&ui=0&quality=${opt.q}${opt.split === '1' ? '&players=2&pad2=1' : ''}`;
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 120000, polling: 250 });
await page.waitForTimeout(+opt.warm * 1000);

await page.evaluate(() => {
  const G = window.__GAME__;
  const scene = G.render.scene;
  const list = (re) => {
    const out = [];
    scene.traverse((o) => {
      if ((o.isMesh || o.isPoints) && re.test(o.name || '')) out.push(o);
    });
    return out;
  };
  const underCar = () => {
    const out = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      for (let p = o; p; p = p.parent) {
        if (/^car:/.test(p.name || '')) {
          out.push(o);
          break;
        }
      }
    });
    return out;
  };
  const allMeshes = () => {
    const out = [];
    scene.traverse((o) => {
      if (o.isMesh) out.push(o);
    });
    return out;
  };
  // (castShadow is a getter that says no while a variant is on: the systems that set it every frame cannot take it back)
  const noCast = (objs) => {
    for (const o of objs) {
      if (o.userData.__cs === undefined) o.userData.__cs = o.castShadow;
      Object.defineProperty(o, 'castShadow', { configurable: true, enumerable: true, get: () => false, set: () => {} });
    }
  };
  const castAgain = (objs) => {
    for (const o of objs) if (o.userData.__cs !== undefined) Object.defineProperty(o, 'castShadow', { configurable: true, enumerable: true, writable: true, value: o.userData.__cs });
  };
  const hide = (objs) => {
    for (const o of objs) {
      if (o.userData.__vis === undefined) o.userData.__vis = o.visible;
      o.visible = false;
    }
  };
  const show = (objs) => {
    for (const o of objs) if (o.userData.__vis !== undefined) o.visible = o.userData.__vis;
  };
  const sets = {
    noTreeShadow: [() => list(/^tree/), noCast, castAgain],
    noBankShadow: [() => list(/^snowbank/), noCast, castAgain],
    noCarShadow: [underCar, noCast, castAgain],
    noShadows: [allMeshes, noCast, castAgain],
    noTerrain: [() => list(/^(tile|terrainStrip)/), hide, show],
    noRoad: [() => list(/^(asphalt|backing)/), hide, show],
    noBanks: [() => list(/^snowbank/), hide, show],
    noProps: [() => list(/^(reeds|icePoles|props|crowds|flags|winter_|prop_)/), hide, show],
    noCars: [underCar, hide, show],
  };
  window.__ab = {
    on: (name) => {
      const s = sets[name];
      if (s) s[1](s[0]());
    },
    off: (name) => {
      const s = sets[name];
      if (s) s[2](s[0]());
    },
  };
});

const pct = (xs, q) => {
  const b = xs.slice().sort((x, y) => x - y);
  return b.length ? b[Math.min(b.length - 1, Math.floor(q * b.length))] : 0;
};
const gpu = Object.fromEntries(variants.map((v) => [v, []]));
const sum = Object.fromEntries(variants.map((v) => [v, { calls: 0, tris: 0, n: 0 }]));
for (let c = 0; c < +opt.cycles; c++) {
  for (const v of variants) {
    await page.evaluate((v) => window.__ab.on(v), v);
    await page.waitForTimeout(150);
    const t0 = Date.now();
    while (Date.now() - t0 < +opt.win) {
      const r = await page.evaluate(() => {
        const G = window.__GAME__;
        return { gpu: G.render.stats.gpuMsRaw, calls: G.render.renderer.info.render.calls, tris: G.render.renderer.info.render.triangles };
      });
      gpu[v].push(r.gpu);
      sum[v].calls += r.calls;
      sum[v].tris += r.tris;
      sum[v].n++;
      await page.waitForTimeout(50);
    }
    await page.evaluate((v) => window.__ab.off(v), v);
  }
}
const f = (x) => x.toFixed(2).padStart(6);
const baseMed = pct(gpu[variants[0]], 0.5);
const baseP95 = pct(gpu[variants[0]], 0.95);
console.log(`${opt.track} ${opt.tod} ${opt.weather} ${opt.split === '1' ? 'split screen' : 'one view'} ${opt.w}x${opt.h} ${opt.q}: ${opt.cycles} cycles of ${variants.length} variants, ${opt.win} ms each`);
for (const v of variants) {
  const m = pct(gpu[v], 0.5);
  const p = pct(gpu[v], 0.95);
  const e = sum[v];
  console.log(`${v.padEnd(14)} med ${f(m)}  p95 ${f(p)}  (n ${String(gpu[v].length).padStart(4)})  saves med ${f(baseMed - m)}  p95 ${f(baseP95 - p)}   calls ${Math.round(e.calls / Math.max(1, e.n))} tris ${Math.round(e.tris / Math.max(1, e.n))}`);
}
await browser.close();
