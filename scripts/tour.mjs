#!/usr/bin/env node
/**
 * Scripted play-through: opens the game in the system Chrome (GPU), then runs a list of steps,
 * taking screenshots along the way. Used for visual QA of whole game flows.
 *
 *   node scripts/tour.mjs "<path?query>" --steps "<steps>" [--out shots/tour] [--w 1600] [--h 900] [--dpr 1] [--log]
 *
 * Steps are separated by ';':
 *   wait:<ms>            let the game run
 *   shot:<name>          screenshot to <out>/<name>.png
 *   key:<Key>[:<ms>]     press (or hold for ms) a key
 *   eval:<js>            evaluate in the page and print the JSON result
 *   evalfile:<path>      evaluate a JS file in the page (for scripts with ';')
 *   until:<js>[:<ms>]    poll until the expression is truthy (max ms, default 60000)
 *   perf:<label>         print the game's frame-time stats since the last perf step
 *   tap:<button>         tap a fake-pad button (needs --init scripts/fixtures/fake-pad.js)
 *
 * The game must expose window.__READY__ (always waited for first).
 */
import { launchChrome } from './chrome.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const valued = new Set(['out', 'w', 'h', 'steps', 'port', 'dpr', 'init']);
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
if (!target || !opts.steps) {
  console.error('usage: node scripts/tour.mjs <url-or-path> --steps "wait:3000;shot:a;key:Escape;..." [--out dir]');
  process.exit(2);
}
const port = opts.port ?? '5199';
if (!/^https?:/.test(target)) target = `http://127.0.0.1:${port}/${target.replace(/^\//, '')}`;
const outDir = resolve(opts.out ?? 'shots/tour');
mkdirSync(outDir, { recursive: true });

const browser = await launchChrome({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: +(opts.w ?? 1600), height: +(opts.h ?? 900) }, deviceScaleFactor: +(opts.dpr ?? 1) });
if (opts.init) await page.addInitScript({ path: resolve(opts.init) });
let threw = false;
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') console.log(`[${t}] ${m.text()}`);
  else if (opts.log) console.log(`[${t}] ${m.text()}`);
});
page.on('response', (r) => {
  if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`);
});
page.on('pageerror', (e) => {
  threw = true;
  console.log(`[pageerror] ${e.message}\n${e.stack ?? ''}`);
});

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
await page.goto(target, { waitUntil: 'load' });
await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 120000 });
console.log(`[${stamp()}] ready`);

for (const raw of opts.steps.split(';').map((s) => s.trim()).filter(Boolean)) {
  const i = raw.indexOf(':');
  const op = i < 0 ? raw : raw.slice(0, i);
  const arg = i < 0 ? '' : raw.slice(i + 1);
  if (op === 'wait') await page.waitForTimeout(+arg);
  else if (op === 'shot') {
    // shot:name -> PNG; shot:name.jpg -> JPEG (quality 88), for docs
    const jpg = arg.endsWith('.jpg');
    const file = resolve(outDir, jpg ? arg : `${arg}.png`);
    await page.screenshot(jpg ? { path: file, type: 'jpeg', quality: 88 } : { path: file });
    console.log(`[${stamp()}] shot ${file}`);
  } else if (op === 'key') {
    const [k, ms] = arg.split(':');
    if (ms) {
      await page.keyboard.down(k);
      await page.waitForTimeout(+ms);
      await page.keyboard.up(k);
    } else await page.keyboard.press(k);
  } else if (op === 'eval') {
    const r = await page.evaluate(arg);
    console.log(`[${stamp()}] eval ${JSON.stringify(r)}`);
  } else if (op === 'until') {
    const j = arg.lastIndexOf(':');
    const hasMs = j > 0 && /^\d+$/.test(arg.slice(j + 1));
    const expr = hasMs ? arg.slice(0, j) : arg;
    const ms = hasMs ? +arg.slice(j + 1) : 60000;
    try {
      await page.waitForFunction(expr, null, { timeout: ms, polling: 100 });
      console.log(`[${stamp()}] until ok: ${expr}`);
    } catch {
      console.log(`[${stamp()}] until TIMEOUT: ${expr}`);
    }
  } else if (op === 'evalfile') {
    const r = await page.evaluate(readFileSync(resolve(arg), 'utf8'));
    console.log(`[${stamp()}] eval ${JSON.stringify(r)}`);
  } else if (op === 'tap') {
    await page.evaluate((i) => window.__pad.btn(i, 1), +arg);
    await page.waitForTimeout(90);
    await page.evaluate((i) => window.__pad.btn(i, 0), +arg);
    await page.waitForTimeout(250);
  } else if (op === 'perf') {
    const r = await page.evaluate(() => window.__GAME__?.perfStats?.(true));
    console.log(`[${stamp()}] perf ${arg}: ${JSON.stringify(r)}`);
  } else console.log(`unknown step ${raw}`);
}
await browser.close();
process.exit(threw ? 1 : 0);
