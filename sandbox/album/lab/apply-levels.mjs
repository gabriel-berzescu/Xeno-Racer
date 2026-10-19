#!/usr/bin/env node
/**
 * Applies the level trims measured by levels.ts (a JSON of "type:preset" -> dB) to the preset tables in the source: each preset's
 * `level` option becomes old + trim, rounded to 0.5 dB. Idempotent in spirit: measure again after applying and the trims shrink.
 *
 *   node sandbox/album/lab/apply-levels.mjs .cache/album-lab/levels.json [--dry] [--max 40] [--min 0.75]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const jsonPath = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry');
const maxI = args.indexOf('--max');
const MAX = maxI >= 0 ? Number(args[maxI + 1]) : 40;
const minI = args.indexOf('--min');
const MIN = minI >= 0 ? Number(args[minI + 1]) : 0;
const root = resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const dir = resolve(root, 'src/audio/album/instruments');

const MAP = {
  kick: ['drums.ts', 'DRUM_PRESETS'],
  snare: ['drums.ts', 'DRUM_PRESETS'],
  clap: ['drums.ts', 'DRUM_PRESETS'],
  hat: ['drums.ts', 'DRUM_PRESETS'],
  tom: ['drums.ts', 'DRUM_PRESETS'],
  cymbal: ['drums.ts', 'DRUM_PRESETS'],
  perc: ['drums.ts', 'DRUM_PRESETS'],
  synth: ['synth.ts', 'SYNTH_PRESETS'],
  dark: ['bass.ts', 'DARK_PRESETS'],
  reese: ['bass.ts', 'REESE_PRESETS'],
  growl: ['bass.ts', 'GROWL_PRESETS'],
  acid: ['bass.ts', 'ACID_PRESETS'],
  sub: ['bass.ts', 'SUB_PRESETS'],
  riser: ['sfx.ts', 'RISER_PRESETS'],
  impact: ['sfx.ts', 'IMPACT_PRESETS'],
  zap: ['sfx.ts', 'ZAP_PRESETS'],
  'acoustic-kit': ['acoustic-kit.ts', 'AKIT_PRESETS'],
  guitar: ['guitar.ts', 'GUITAR_PRESETS'],
  bassguitar: ['guitar.ts', 'BASSG_PRESETS'],
};

const trims = JSON.parse(readFileSync(resolve(jsonPath), 'utf8'));
const files = new Map();
const text = (f) => {
  if (!files.has(f)) files.set(f, readFileSync(resolve(dir, f), 'utf8'));
  return files.get(f);
};

/** index of the matching close brace for the open brace at `open` (strings are skipped) */
function matchBrace(s, open) {
  let depth = 0;
  let q = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced');
}

let changed = 0;
for (const [key, trim] of Object.entries(trims)) {
  if (Number.isFinite(trim) && Math.abs(trim) < MIN) continue;
  if (!Number.isFinite(trim) || Math.abs(trim) > MAX) {
    console.log(`skip ${key}: trim ${trim}`);
    continue;
  }
  const [type, ...rest] = key.split(':');
  const name = rest.join(':');
  const m = MAP[type];
  if (!m) throw new Error(`no mapping for ${type}`);
  const [file, table] = m;
  let s = text(file);
  const t0 = s.indexOf(`const ${table}`);
  if (t0 < 0) throw new Error(`${file}: no table ${table}`);
  const tEnd = s.indexOf('\n};', t0) + 3;
  const slice = s.slice(t0, tEnd);
  const re = new RegExp(`\\n\\s*(?:'${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'|${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}):\\s*\\{`);
  const em = re.exec(slice);
  if (!em) throw new Error(`${file}/${table}: preset ${name} not found`);
  const entryOpen = t0 + em.index + em[0].length - 1;
  const entryClose = matchBrace(s, entryOpen);
  const entry = s.slice(entryOpen, entryClose + 1);
  const om = /opts:\s*\{/.exec(entry);
  if (!om) throw new Error(`${name}: no opts`);
  const optsOpen = entryOpen + om.index + om[0].length - 1;
  const optsClose = matchBrace(s, optsOpen);
  const opts = s.slice(optsOpen, optsClose + 1);
  // find a top-level `level:`
  let depth = 0;
  let found = -1;
  for (let i = 0; i < opts.length; i++) {
    const c = opts[i];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (depth === 1 && opts.startsWith('level:', i) && /[\s,{]/.test(opts[i - 1])) {
      found = i;
      break;
    }
  }
  let newOpts;
  let oldLevel = 0;
  if (found >= 0) {
    const lm = /^level:\s*(-?\d+(?:\.\d+)?)/.exec(opts.slice(found));
    oldLevel = Number(lm[1]);
    const nl = Math.round((oldLevel + trim) * 2) / 2;
    newOpts = opts.slice(0, found) + `level: ${nl}` + opts.slice(found + lm[0].length);
    console.log(`${key.padEnd(34)} level ${oldLevel} -> ${nl}`);
  } else {
    const nl = Math.round(trim * 2) / 2;
    const inner = opts.slice(1, -1).trim();
    newOpts = inner ? `{ level: ${nl}, ${inner} }` : `{ level: ${nl} }`;
    console.log(`${key.padEnd(34)} level (none) -> ${nl}`);
  }
  s = s.slice(0, optsOpen) + newOpts + s.slice(optsClose + 1);
  files.set(file, s);
  changed++;
}
if (!dry) for (const [f, s] of files) writeFileSync(resolve(dir, f), s);
console.log(`${changed} presets ${dry ? 'would change (dry run)' : 'updated'}`);
