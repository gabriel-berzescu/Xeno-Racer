#!/usr/bin/env node
/**
 * Headless screenshot of a page served by the dev server, using the system Chrome with the GPU.
 *
 *   node scripts/shot.mjs <url-or-path> [--out shots/name.png] [--w 1600] [--h 900] [--wait 3000]
 *        --ready            wait until window.__READY__ === true (max 90 s) before the --wait delay
 *        --eval "<js>"      evaluate an expression after the wait, print its JSON result
 *        --keys "w:2000,a:500"   hold keys (keyboard.down/up) for ms, in sequence, after ready
 *        --port 5199        dev-server port when a bare path is given
 *        --log              also print console.log/info lines
 *
 * Prints page console errors/warnings. Exit code 1 if the page threw an uncaught error.
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const valued = new Set(['out', 'w', 'h', 'wait', 'eval', 'port', 'keys']);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (valued.has(k)) opts[k] = argv[++i];
    else opts[k] = true;
  } else positional.push(a);
}
let target = positional[0];
if (!target) {
  console.error('usage: node scripts/shot.mjs <url-or-path> [--out file.png] [--w 1600] [--h 900] [--wait ms] [--ready] [--eval js] [--keys k:ms,...]');
  process.exit(2);
}
const port = opts.port ?? '5199';
if (!/^https?:/.test(target)) target = `http://127.0.0.1:${port}/${target.replace(/^\//, '')}`;
const out = resolve(opts.out ?? `shots/shot-${Date.now()}.png`);
const w = +(opts.w ?? 1600);
const h = +(opts.h ?? 900);
const wait = +(opts.wait ?? 3000);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
let threw = false;
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') console.log(`[${t}] ${m.text()}`);
  else if (opts.log) console.log(`[${t}] ${m.text()}`);
});
page.on('pageerror', (e) => {
  threw = true;
  console.log(`[pageerror] ${e.message}\n${e.stack ?? ''}`);
});
const t0 = Date.now();
await page.goto(target, { waitUntil: 'load', timeout: 90000 });
if (opts.ready) {
  try {
    await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 90000, polling: 250 });
  } catch {
    console.log('[shot] window.__READY__ never became true (90 s)');
  }
}
if (opts.keys) {
  for (const step of String(opts.keys).split(',')) {
    const [key, ms] = step.split(':');
    await page.keyboard.down(key);
    await page.waitForTimeout(+ms || 500);
    await page.keyboard.up(key);
  }
}
await page.waitForTimeout(wait);
if (opts.eval) {
  try {
    console.log('[eval]', JSON.stringify(await page.evaluate(opts.eval), null, 1));
  } catch (e) {
    console.log('[eval error]', e.message);
  }
}
mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out });
const gl = await page.evaluate(() => {
  const c = document.createElement('canvas').getContext('webgl2');
  const d = c && c.getExtension('WEBGL_debug_renderer_info');
  return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'no webgl2';
});
console.log(`[shot] ${out}  (${Date.now() - t0} ms, GPU: ${gl})`);
await browser.close();
process.exit(threw ? 1 : 0);
