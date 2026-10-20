/**
 * Headless Chrome for the dev scripts (screenshots, tours, benches, QA), without locking the Windows account.
 *
 * Why: on Windows, Chrome checks once per profile whether the user's Windows password is blank, by trying to sign the user in with
 * an empty password (a failed interactive logon, Security event 4625 from chrome.exe). It remembers the answer in the profile. Playwright's
 * `chromium.launch()` starts every run with a brand-new temporary profile, so EVERY launch was one failed sign-in, and ten launches in ten
 * minutes (a batch of screenshots) hit the account lockout policy: on 2026-10-20 the owner was locked out of his own laptop, again and again.
 *
 * So every launch here gets a fresh, empty profile of its own (no storage carried between runs: tests still start clean) seeded with the
 * two settings files of a template profile, where Chrome has already done that check once (.cache/chrome-profile/template: made on first
 * use, which costs that one failed sign-in, ever). Measured: a fresh profile +1 on the account's bad-password count, a seeded one +0.
 *
 * Use it like `chromium.launch()`: `const browser = await launchChrome({ channel: 'chrome', headless: true, args })`, then
 * `browser.newPage(contextOptions)` or `browser.newContext(contextOptions)` and `browser.close()`. Each page or context is a persistent
 * context of its own (a Chrome process each), which is what the scripts used anyway: one page, or two side by side.
 */
import { chromium } from 'playwright-core';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, '.cache', 'chrome-profile', 'template');
const SEEDS = ['Local State', join('Default', 'Preferences')];

/** The template profile, made once: Chrome runs its blank-password check there and writes the answer into these files. */
async function template(launchOptions) {
  if (SEEDS.every((f) => existsSync(join(TEMPLATE, f)))) return;
  mkdirSync(TEMPLATE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(TEMPLATE, { channel: launchOptions.channel ?? 'chrome', headless: true });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('about:blank');
  // (the check runs a moment after start-up; give it time before the settings are written on close)
  await new Promise((r) => setTimeout(r, 6000));
  await ctx.close();
}

/** A fresh profile directory seeded from the template. */
function seededProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'xr-chrome-'));
  mkdirSync(join(dir, 'Default'), { recursive: true });
  for (const f of SEEDS) if (existsSync(join(TEMPLATE, f))) copyFileSync(join(TEMPLATE, f), join(dir, f));
  return dir;
}

/** `chromium.launch()` with seeded profiles: see the header. */
export async function launchChrome(launchOptions = {}) {
  await template(launchOptions);
  const opened = [];
  const open = async (contextOptions = {}) => {
    const dir = seededProfile();
    const ctx = await chromium.launchPersistentContext(dir, { ...launchOptions, ...contextOptions });
    opened.push({ ctx, dir });
    return ctx;
  };
  return {
    async newContext(contextOptions) {
      return open(contextOptions);
    },
    async newPage(contextOptions) {
      const ctx = await open(contextOptions);
      return ctx.pages()[0] ?? ctx.newPage();
    },
    contexts: () => opened.map((o) => o.ctx),
    async close() {
      for (const { ctx, dir } of opened.splice(0)) {
        try {
          await ctx.close();
        } catch {
          /* already gone */
        }
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
          /* a file Chrome still holds: the temp folder is cleaned by Windows */
        }
      }
    },
  };
}
