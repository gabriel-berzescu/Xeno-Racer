#!/usr/bin/env node
/**
 * Renders the audio preview WAVs headlessly: opens sandbox/audio.html?render=1 in Chrome (the real
 * worklet / graph / master chain run inside an OfflineAudioContext) and writes the results to
 * previews/audio/.
 *
 *   node sandbox/audio/render-previews.mjs [--port 5199] [--out previews/audio] [--only wiper]
 *
 * Point --port at a `vite preview` server to render from the production build instead.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const port = opt('port', '5199');
const outDir = resolve(opt('out', 'previews/audio'));
const only = opt('only', '');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300));
});
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/sandbox/audio.html?render=1${only ? `&only=${only}` : ''}`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 300000, polling: 500 });
const names = await page.evaluate(() => Object.keys(window.__AUDIO_WAVS__));
let total = 0;
const rows = [];
for (const name of names) {
  const w = await page.evaluate((n) => window.__AUDIO_WAVS__[n], name);
  const bytes = Buffer.from(w.base64, 'base64');
  writeFileSync(resolve(outDir, `${name}.wav`), bytes);
  total += bytes.length;
  rows.push({ file: `${name}.wav`, s: +w.seconds.toFixed(2), ch: w.channels, kB: Math.round(bytes.length / 1024), peak: +w.peakDb.toFixed(1), rms: +w.rmsDb.toFixed(1), note: w.note });
}
await browser.close();
console.table(rows.map(({ note, ...r }) => r));
for (const r of rows) console.log(`${r.file}: ${r.note}`);
console.log(`\n${rows.length} files, ${(total / 1048576).toFixed(2)} MB total -> ${outDir}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
