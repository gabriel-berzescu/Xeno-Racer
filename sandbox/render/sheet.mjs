#!/usr/bin/env node
/**
 * Contact sheet: tile several PNGs into one labelled image so a whole set can be judged at once.
 *
 *   node sandbox/render/sheet.mjs --out shots/render/sheet.png --cols 3 --w 640 a.png b.png label=c.png
 *
 * Uses the system Chrome through playwright-core (same as scripts/shot.mjs). Owner: render.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opts = { cols: 3, w: 640, out: 'shots/render/sheet.png', crop: null };
const items = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--cols') opts.cols = +argv[++i];
  else if (a === '--w') opts.w = +argv[++i];
  else if (a === '--out') opts.out = argv[++i];
  else if (a === '--crop') opts.crop = argv[++i].split(',').map(Number); // x,y,w,h in source pixels
  else {
    const eq = a.indexOf('=');
    const hasLabel = eq > 0 && !/^[a-zA-Z]:/.test(a.slice(0, eq + 1));
    const path = resolve(hasLabel ? a.slice(eq + 1) : a);
    items.push({ label: hasLabel ? a.slice(0, eq) : basename(a, '.png'), path });
  }
}
if (items.length === 0) {
  console.error('usage: node sandbox/render/sheet.mjs --out out.png --cols 3 --w 640 [label=]a.png ...');
  process.exit(2);
}

const cells = items
  .map((it) => {
    const src = pathToFileURL(it.path).href;
    if (!opts.crop) return `<figure><img src="${src}" /><figcaption>${it.label}</figcaption></figure>`;
    const [cx, cy, cw, ch] = opts.crop;
    const k = opts.w / cw;
    // scale the whole image so the crop window fits the cell width, then offset
    return `<figure style="width:${opts.w}px;height:${Math.round(ch * k)}px;overflow:hidden"><img src="${src}" style="position:absolute;width:auto;height:auto;transform-origin:0 0;transform:scale(${k}) translate(${-cx}px,${-cy}px);max-width:none" /><figcaption>${it.label}</figcaption></figure>`;
  })
  .join('');
const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#111;display:grid;grid-template-columns:repeat(${opts.cols},${opts.w}px);gap:4px;font:13px system-ui;color:#eee}
  figure{margin:0;position:relative}
  img{display:block}
  figure:not([style]) img{width:${opts.w}px}
  figcaption{position:absolute;left:6px;top:4px;padding:2px 6px;background:rgba(0,0,0,.55);border-radius:3px}
</style>${cells}`;
const dir = mkdtempSync(join(tmpdir(), 'xr-sheet-'));
const file = join(dir, 'sheet.html');
writeFileSync(file, html);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const rows = Math.ceil(items.length / opts.cols);
const cellH = opts.crop ? Math.round(opts.crop[3] * (opts.w / opts.crop[2])) : Math.round(opts.w * 0.5625);
const page = await browser.newPage({ viewport: { width: opts.cols * (opts.w + 4), height: rows * (cellH + 4) } });
await page.goto(pathToFileURL(file).href);
await page.waitForFunction(() => [...document.images].every((i) => i.complete));
mkdirSync(dirname(resolve(opts.out)), { recursive: true });
await page.screenshot({ path: resolve(opts.out), fullPage: true });
await browser.close();
console.log(`[sheet] ${resolve(opts.out)} (${items.length} images)`);
