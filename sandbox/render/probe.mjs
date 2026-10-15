#!/usr/bin/env node
/**
 * Black-frame / NaN detector for the render sandbox (owner: render).
 *
 *   node sandbox/render/probe.mjs --query "track=aurelia&tod=night&weather=storm&cam=chase&v=45" [--n 400] [--gap 20]
 *
 * Loads sandbox/render.html (simulation running), then calls window.__PROBE__() n times (each renders one frame
 * and reads back a 24x14 grid of pixels straight from the drawing buffer, so the screenshot compositor cannot fake
 * a black frame) and reports how many frames came back completely black. One NaN in the HDR pipeline smears over
 * the whole frame through the bloom blur, so any count above zero is a bug.
 */
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const opt = { query: 'track=aurelia&tod=night&weather=storm&cam=chase&v=45', n: 400, gap: 20, w: 1280, h: 720, port: 5199, quality: 'high' };
for (let i = 0; i < argv.length; i += 2) opt[argv[i].slice(2)] = argv[i + 1];
opt.n = +opt.n;
opt.gap = +opt.gap;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu'],
});
const page = await browser.newPage({ viewport: { width: +opt.w, height: +opt.h } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${opt.port}/sandbox/render.html?quality=${opt.quality}&${opt.query}`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 120000, polling: 250 });
await page.waitForTimeout(3000);
const res = await page.evaluate(
  async ({ n, gap }) => {
    const out = { frames: 0, black: 0, firstBlack: -1, samples: [] };
    for (let i = 0; i < n; i++) {
      const r = window.__PROBE__();
      out.frames++;
      const lit = r.r + r.g + r.b;
      if (r.blackPixels >= r.of || lit < 0.5) {
        out.black++;
        if (out.firstBlack < 0) out.firstBlack = i;
      }
      if (i % 100 === 0) out.samples.push(r);
      await new Promise((res) => setTimeout(res, gap));
    }
    return out;
  },
  { n: opt.n, gap: opt.gap },
);
console.log(JSON.stringify(res));
await browser.close();
