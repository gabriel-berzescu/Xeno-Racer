/**
 * Headless smoke test of the interactive bench: drives the real UI (cycle mode, opponents, car switch,
 * impacts, UI sounds, music, cameras, custom profile) and prints the live output level after each step.
 *
 *   node sandbox/audio/bench-smoke.mjs [http://127.0.0.1:5199/sandbox/audio.html]
 */
import { chromium } from 'playwright-core';
const url = process.argv[2] ?? 'http://127.0.0.1:5199/sandbox/audio.html';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__READY__ === true);
const lvl = async (label) => {
  const r = await page.evaluate(async () => {
    const b = window.__BENCH__;
    const an = b.sys.ctx.createAnalyser(); an.fftSize = 4096; b.sys.graph.limiter.connect(an);
    await new Promise((r) => setTimeout(r, 120));
    const d = new Float32Array(4096); an.getFloatTimeDomainData(d);
    let s = 0, p = 0; for (const v of d) { s += v * v; p = Math.max(p, Math.abs(v)); }
    an.disconnect();
    return { rms: 10 * Math.log10(s / d.length + 1e-12), peak: 20 * Math.log10(p + 1e-9), t: b.sys.ctx.currentTime };
  });
  console.log(label.padEnd(34), `rms ${r.rms.toFixed(1)} dB  peak ${r.peak.toFixed(1)} dB  t=${r.t.toFixed(1)}s`);
};
await page.keyboard.press('x'); // unlock
await page.waitForTimeout(400);
await lvl('idle manual (throttle 0)');
await page.locator('select').nth(1).selectOption('cycle');
await page.waitForTimeout(2500);
await lvl('cycle mode, ~2.5 s in');
await page.waitForTimeout(3000);
await lvl('cycle mode, ~5.5 s in');
// opponents slider
const opp = page.locator('label.row', { hasText: 'opponents around you' }).locator('input');
await opp.fill('11'); await opp.dispatchEvent('input');
await page.waitForTimeout(2500);
await lvl('with 11 opponents');
await page.locator('select').nth(0).selectOption('lmp-x');
await page.waitForTimeout(1500);
await lvl('car -> lmp-x');
await page.getByRole('button', { name: 'wall heavy' }).click();
await page.waitForTimeout(300);
await lvl('after heavy wall impact');
await page.getByRole('button', { name: 'go', exact: true }).click();
await page.waitForTimeout(150);
await lvl('go sound');
await page.locator('label.chk', { hasText: 'menu music' }).locator('input').check();
await page.waitForTimeout(2500);
await lvl('music on');
await page.locator('select').nth(2).selectOption('cockpit');
await page.waitForTimeout(800);
await lvl('cockpit camera');
await page.locator('select').nth(2).selectOption('trackside');
await page.waitForTimeout(800);
await lvl('trackside camera');
// weather: presets, thunder, back to dry (rain follows the camera: trackside = open air)
await page.locator('select').nth(2).selectOption('cockpit');
await page.getByRole('button', { name: 'rain (0.55 / 0.75)' }).click();
await page.waitForTimeout(4000);
await lvl('rain preset (cockpit)');
await page.getByRole('button', { name: 'storm (1 / 1)' }).click();
await page.waitForTimeout(4000);
await lvl('storm preset (cockpit)');
await page.getByRole('button', { name: 'thunder: near (3 km)' }).click();
await page.waitForTimeout(2500);
await lvl('thunder near');
await page.locator('select').nth(2).selectOption('chase');
await page.waitForTimeout(1200);
await lvl('storm (chase)');
await page.getByRole('button', { name: 'dry (0 / 0)' }).click();
await page.waitForTimeout(6500);
await lvl('dry again');
// custom profile: crossplane V8
await page.locator('label.row', { hasText: 'crank' }).locator('select').selectOption('crossplane');
await page.waitForTimeout(1200);
await lvl('custom crossplane');
console.log('errors:', errors.length ? errors.join('\n') : 'none');
await page.screenshot({ path: 'shots/audio-bench-run.png' });
await browser.close();
