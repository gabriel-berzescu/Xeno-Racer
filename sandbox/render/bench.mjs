#!/usr/bin/env node
/**
 * Frame-cost benchmark for the render sandbox (owner: render).
 *
 *   node sandbox/render/bench.mjs [--w 1920] [--h 1080] [--scene drift] [--tod golden] [--q low,medium,high,ultra]
 *
 * Runs sandbox/render.html?bench=1 once per quality preset in headless Chrome on the real GPU and
 * prints the unthrottled frame time (wall clock per frame with gl.finish, i.e. what the machine can
 * sustain, so fps is the achievable rate, not the vsync-capped one), GPU time (EXT_disjoint_timer_query: median and minimum of 300 frames; the GPU is shared with
 * whatever else runs on the machine, so the median is the honest number and the minimum is the
 * uncontended cost), CPU time inside render(), draw calls and triangles
 * (all passes: shadow cascades, scene, AO, post), the internal resolution and an estimate of
 * render-target + shadow-map memory. Headless Chrome is vsync-capped, so frame interval is not the
 * metric: the unthrottled numbers are.
 */
import { launchChrome } from '../../scripts/chrome.mjs';

const argv = process.argv.slice(2);
const opt = { w: 1920, h: 1080, scene: 'drift', tod: 'golden', q: 'low,medium,high,ultra', port: 5199, extra: '' };
for (let i = 0; i < argv.length; i += 2) opt[argv[i].slice(2)] = argv[i + 1];
opt.w = +opt.w;
opt.h = +opt.h;

const browser = await launchChrome({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu', '--enable-webgl-developer-extensions'],
});
const rows = [];
for (const q of opt.q.split(',')) {
  const page = await browser.newPage({ viewport: { width: opt.w, height: opt.h } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  // extra params come first so they win over the defaults (URLSearchParams.get returns the first match)
  const url = `http://127.0.0.1:${opt.port}/sandbox/render.html?${opt.extra}&bench=1&quality=${q}&scene=${opt.scene}&tod=${opt.tod}&view=hero&viewAz=60&dist=11&camY=1.0&t=4`;
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 120000, polling: 250 });
  rows.push(await page.evaluate(() => window.__BENCH__));
  await page.close();
}
await browser.close();
console.log(`\nviewport ${opt.w}x${opt.h}  scene=${opt.scene}  tod=${opt.tod}`);
if (rows.some((r) => r.passMs && Object.keys(r.passMs).length)) {
  console.log('per-pass GPU ms (profile=1, vsync-paced so the queries resolve):');
  for (const r of rows) console.log(`  ${r.quality.padEnd(7)} ` + Object.entries(r.passMs).map(([k, v]) => `${k} ${v}`).join('   '));
}
console.log('quality  internal     frame ms  fps    gpu med  gpu min  cpu ms  calls   tris      cascades  mem MB');
for (const r of rows) {
  console.log(
    `${r.quality.padEnd(8)} ${r.internal.padEnd(12)} ${String(r.frameMs).padStart(8)} ${String(Math.round(1000 / r.frameMs)).padStart(5)} ${String(r.gpuMs).padStart(7)} ${String(r.gpuMsMin).padStart(8)} ${String(r.cpuMs).padStart(7)} ${String(r.drawCalls).padStart(6)} ${String(r.triangles).padStart(8)} ${String(r.cascades).padStart(8)} ${String(r.gpuMemMB).padStart(8)}`,
  );
}
