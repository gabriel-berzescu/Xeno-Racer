#!/usr/bin/env node
/**
 * Picture parity between two dev servers (owner: render): proves a change did not alter a look.
 *
 *   node sandbox/render/parity.mjs --a http://127.0.0.1:5199 --b http://127.0.0.1:5198 \
 *        --base "track=aurelia&cam=chase&t=3&s=40&freeze=1&quality=high&v=40" \
 *        --vary weather=clear,cloudy,overcast --vary tod=dawn,noon,dusk,night
 *
 * `b` is typically a second Vite server running an untouched copy of the previous commit (git archive HEAD into
 * a temp folder, junction its node_modules, `vite --port 5198`). Every combination is rendered on both servers
 * through sandbox/render.html and the pictures are compared in the browser: mean absolute difference per channel
 * (0..255) and the share of pixels that differ by more than 2 levels (dither noise is 1 level, so a clean
 * match shows ~0.00% above 2). Exit code 1 if any combination differs by more than the thresholds.
 */
import { launchChrome } from '../../scripts/chrome.mjs';

const argv = process.argv.slice(2);
const opt = { a: 'http://127.0.0.1:5199', b: 'http://127.0.0.1:5198', base: 'track=aurelia&cam=chase&t=3&s=40&freeze=1&quality=high&v=40', w: 800, h: 450, page: 'sandbox/render.html', meanMax: 0.25, shareMax: 0.05 };
const vary = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--vary') {
    const [k, v] = argv[++i].split('=');
    vary.push([k, v.split(',')]);
  } else if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i];
}
let combos = [[]];
for (const [k, vals] of vary) combos = combos.flatMap((c) => vals.map((v) => [...c, [k, v]]));

const browser = await launchChrome({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu'],
});

async function shoot(origin, query) {
  const page = await browser.newPage({ viewport: { width: +opt.w, height: +opt.h } });
  await page.goto(`${origin}/${opt.page}?${query}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 120000, polling: 200 });
  await page.waitForTimeout(500);
  const png = await page.screenshot();
  await page.close();
  return png.toString('base64');
}

const diffPage = await browser.newPage();
await diffPage.setContent('<canvas id="a"></canvas><canvas id="b"></canvas>');
async function compare(a64, b64) {
  return diffPage.evaluate(
    async ([x, y]) => {
      const load = (b64) =>
        new Promise((res) => {
          const im = new Image();
          im.onload = () => res(im);
          im.src = 'data:image/png;base64,' + b64;
        });
      const [ia, ib] = await Promise.all([load(x), load(y)]);
      const w = ia.width, h = ia.height;
      const ca = document.getElementById('a'), cb = document.getElementById('b');
      ca.width = cb.width = w;
      ca.height = cb.height = h;
      const ga = ca.getContext('2d'), gb = cb.getContext('2d');
      ga.drawImage(ia, 0, 0);
      gb.drawImage(ib, 0, 0);
      const da = ga.getImageData(0, 0, w, h).data, db = gb.getImageData(0, 0, w, h).data;
      let sum = 0, over = 0, max = 0;
      for (let i = 0; i < da.length; i += 4) {
        let m = 0;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(da[i + c] - db[i + c]);
          sum += d;
          if (d > m) m = d;
        }
        if (m > 2) over++;
        if (m > max) max = m;
      }
      return { mean: sum / (w * h * 3), share: (100 * over) / (w * h), max };
    },
    [a64, b64],
  );
}

let bad = 0;
for (const combo of combos) {
  const q = [opt.base, ...combo.map(([k, v]) => `${k}=${v}`)].filter(Boolean).join('&');
  const [a, b] = await Promise.all([shoot(opt.a, q), shoot(opt.b, q)]);
  const r = await compare(a, b);
  const ok = r.mean <= +opt.meanMax && r.share <= +opt.shareMax;
  if (!ok) bad++;
  console.log(`${ok ? 'same ' : 'DIFF '} ${combo.map(([, v]) => v).join(' ').padEnd(24)} mean ${r.mean.toFixed(3)}  >2 levels ${r.share.toFixed(3)}%  max ${r.max}`);
}
await browser.close();
process.exit(bad ? 1 : 0);
