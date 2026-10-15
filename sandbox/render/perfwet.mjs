#!/usr/bin/env node
/**
 * Wet-weather frame cost in the real game (owner: render).
 *
 *   node sandbox/render/perfwet.mjs [--q high,low] [--weather clear,rain,storm] [--tod noon,night]
 *        [--track aurelia] [--opp 7] [--w 1600] [--h 900] [--warm 26] [--secs 20] [--cam chase]
 *
 * For every combination: starts a quick race with the autopilot, lets the pack get going (--warm seconds), then
 * samples the GPU frame time (EXT_disjoint_timer_query, raw per-frame value) ten times a second for --secs seconds
 * and prints median / p95 / max plus the frame-interval stats of the game loop (frameMax = worst hitch).
 * One combination at a time: the GPU is shared, so parallel runs would distort the numbers.
 */
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const opt = { q: 'high', weather: 'clear,rain,storm', tod: 'noon', track: 'aurelia', opp: 7, w: 1600, h: 900, warm: 26, secs: 20, cam: 'chase', port: 5199, car: 'vanta-gt' };
for (let i = 0; i < argv.length; i += 2) opt[argv[i].slice(2)] = argv[i + 1];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu', '--enable-webgl-developer-extensions', '--autoplay-policy=no-user-gesture-required'],
});

const pct = (a, q) => {
  const b = a.slice().sort((x, y) => x - y);
  return b.length ? b[Math.min(b.length - 1, Math.floor(q * b.length))] : 0;
};

console.log('quality weather tod     gpu med  p95   max | frame p50  p95   max   | calls   tris');
for (const quality of String(opt.q).split(',')) {
  for (const tod of String(opt.tod).split(',')) {
    for (const weather of String(opt.weather).split(',')) {
      const page = await browser.newPage({ viewport: { width: +opt.w, height: +opt.h } });
      page.on('pageerror', (e) => console.log('[pageerror]', e.message));
      const url = `http://127.0.0.1:${opt.port}/?quick=race&track=${opt.track}&car=${opt.car}&opp=${opt.opp}&tod=${tod}&weather=${weather}&cam=${opt.cam}&autopilot=1&ui=0&quality=${quality}`;
      await page.goto(url, { waitUntil: 'load', timeout: 120000 });
      await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 120000, polling: 250 });
      await page.waitForTimeout(+opt.warm * 1000);
      await page.evaluate(() => window.__GAME__.perfStats(true));
      const gpu = [];
      const n = Math.round(+opt.secs * 10);
      for (let i = 0; i < n; i++) {
        gpu.push(await page.evaluate(() => window.__GAME__.render.stats.gpuMsRaw));
        await page.waitForTimeout(100);
      }
      const ps = await page.evaluate(() => window.__GAME__.perfStats(false));
      const f = (x) => x.toFixed(2).padStart(5);
      console.log(
        `${quality.padEnd(7)} ${weather.padEnd(7)} ${tod.padEnd(7)} ${f(pct(gpu, 0.5))} ${f(pct(gpu, 0.95))} ${f(Math.max(...gpu))} | ${f(ps.frameP50)} ${f(ps.frameP95)} ${f(ps.frameMax)} | ${String(ps.calls).padStart(5)} ${String(ps.tris).padStart(8)}`,
      );
      await page.close();
    }
  }
}
await browser.close();
