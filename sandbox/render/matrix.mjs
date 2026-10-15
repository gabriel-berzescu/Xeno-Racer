#!/usr/bin/env node
/**
 * Screenshot matrix for the render sandbox (owner: render): renders the cartesian product of query
 * parameters, one PNG per combination, and tiles them into a labelled contact sheet.
 *
 *   node sandbox/render/matrix.mjs --out shots/wet/sky \
 *        --base "track=aurelia&cam=chase&t=10&freeze=1&quality=high" \
 *        --vary tod=dawn,morning,noon,golden,dusk,night --vary weather=rain,storm \
 *        [--page sandbox/render.html] [--w 800 --h 450] [--par 3] [--cols 3] [--wait 600]
 *
 * Files are named from the varied values (noon_rain.png). The sheet is <out>/sheet.png. Rows follow the
 * LAST --vary list varying fastest. Needs the dev server (port 5199).
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = { out: 'shots/wet/matrix', base: '', page: 'sandbox/render.html', w: 800, h: 450, par: 3, cols: 0, wait: 600, port: 5199, nosheet: false, eval: '' };
const vary = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--vary') {
    const [k, v] = argv[++i].split('=');
    vary.push([k, v.split(',')]);
  } else if (a === '--nosheet') opt.nosheet = true;
  else if (a.startsWith('--')) opt[a.slice(2)] = argv[++i];
}
opt.w = +opt.w;
opt.h = +opt.h;
opt.par = +opt.par;
opt.wait = +opt.wait;
const outDir = resolve(opt.out);
mkdirSync(outDir, { recursive: true });

let combos = [[]];
for (const [k, vals] of vary) combos = combos.flatMap((c) => vals.map((v) => [...c, [k, v]]));
if (!vary.length) combos = [[]];
opt.cols = +opt.cols || (vary.length ? vary[vary.length - 1][1].length : 1);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu', '--enable-webgl-developer-extensions'],
});
const files = new Array(combos.length);
let next = 0;
async function worker() {
  for (;;) {
    const idx = next++;
    if (idx >= combos.length) return;
    const combo = combos[idx];
    const name = combo.map(([, v]) => v).join('_') || 'shot';
    const q = [opt.base, ...combo.map(([k, v]) => `${k}=${v}`)].filter(Boolean).join('&');
    const url = `http://127.0.0.1:${opt.port}/${opt.page}?${q}`;
    const page = await browser.newPage({ viewport: { width: opt.w, height: opt.h } });
    page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${name}] error`, m.text().slice(0, 300));
    });
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 120000 });
      await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 120000, polling: 200 });
      await page.waitForTimeout(opt.wait);
      if (opt.eval) {
        const r = await page.evaluate(opt.eval);
        console.log(`[${name}] eval`, JSON.stringify(r));
      }
      const file = resolve(outDir, `${name}.png`);
      await page.screenshot({ path: file });
      files[idx] = `${name}=${file}`;
      console.log(`shot ${name}`);
    } catch (e) {
      console.log(`[${name}] FAILED`, e.message);
    }
    await page.close();
  }
}
await Promise.all(Array.from({ length: Math.max(1, opt.par) }, worker));
await browser.close();

if (!opt.nosheet) {
  const ok = files.filter(Boolean);
  const r = spawnSync('node', ['sandbox/render/sheet.mjs', '--out', resolve(outDir, 'sheet.png'), '--cols', String(opt.cols), '--w', String(opt.w), ...ok], { stdio: 'inherit' });
  if (r.status !== 0) console.log('sheet failed');
  else console.log(`sheet -> ${resolve(outDir, 'sheet.png')}`);
}
