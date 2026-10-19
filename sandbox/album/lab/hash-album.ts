/**
 * Hashes the audio of everything that already exists: every track of the album and the Sound Check are rendered start to end (the
 * way the player does) and the SHA-256 of their samples (the 32-bit floats of the left channel, then of the right) is printed.
 * Run it before and after a change to the engine: with every new feature switched off, no hash may move.
 *
 *   node sandbox/album/run.mjs sandbox/album/lab/hash-album.ts [--sr 48000[,44100]] [--only id,id] [--save before.json] [--check before.json]
 *
 * `--save file` writes the hashes as JSON, `--check file` compares against such a file (exit code 1 when one differs).
 * A new track in tracks/ has to be added to the imports and to TRACKS below (the script warns when a file is missing from the list).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { TrackDef } from '../../../src/audio/album/song';
import soundCheck from '../../../src/audio/album/sound-check';
import blackIceCircuit from '../../../src/audio/album/tracks/black-ice-circuit';
import flatOut from '../../../src/audio/album/tracks/flat-out';
import redlineProtocol from '../../../src/audio/album/tracks/redline-protocol';
import slipstream from '../../../src/audio/album/tracks/slipstream';
import thirdEyeHighway from '../../../src/audio/album/tracks/third-eye-highway';
import { renderAll } from './tools';

const TRACKS: [string, TrackDef][] = [
  ['black-ice-circuit', blackIceCircuit],
  ['flat-out', flatOut],
  ['redline-protocol', redlineProtocol],
  ['slipstream', slipstream],
  ['third-eye-highway', thirdEyeHighway],
  ['sound-check', soundCheck],
];

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const rates = (arg('sr') ?? '48000').split(',').map(Number);
const only = arg('only')?.split(',');
const save = arg('save');
const check = arg('check');

// a track file that is not in the list above would go unchecked
const listed = new Set(TRACKS.map(([id]) => id));
const dir = 'src/audio/album/tracks';
if (existsSync(dir)) {
  for (const f of readdirSync(dir)) {
    const id = f.replace(/\.ts$/, '');
    if (f.endsWith('.ts') && !listed.has(id)) process.stdout.write(`warning: ${dir}/${f} is not in the TRACKS list of hash-album.ts, so it is not hashed\n`);
  }
}

const hashes: Record<string, { frames: number; sha256: string }> = {};
for (const sr of rates) {
  for (const [id, def] of TRACKS) {
    if (only && !only.includes(id)) continue;
    const t0 = performance.now();
    const r = def.build(sr).toRenderer();
    const [l, rr] = renderAll(r, 4096);
    const h = createHash('sha256');
    h.update(new Uint8Array(l.buffer, l.byteOffset, l.byteLength));
    h.update(new Uint8Array(rr.buffer, rr.byteOffset, rr.byteLength));
    const key = `${id}@${sr}`;
    hashes[key] = { frames: l.length, sha256: h.digest('hex') };
    process.stdout.write(`${key.padEnd(28)} ${String(l.length).padStart(9)} frames  ${hashes[key].sha256}  (${((performance.now() - t0) / 1000).toFixed(1)} s)\n`);
  }
}

if (save) {
  writeFileSync(save, `${JSON.stringify(hashes, null, 2)}\n`);
  process.stdout.write(`saved ${Object.keys(hashes).length} hashes to ${save}\n`);
}
if (check) {
  const want = JSON.parse(readFileSync(check, 'utf8')) as typeof hashes;
  let bad = 0;
  for (const [k, v] of Object.entries(hashes)) {
    const w = want[k];
    const ok = !!w && w.sha256 === v.sha256 && w.frames === v.frames;
    if (!ok) bad++;
    process.stdout.write(`${ok ? 'same     ' : w ? 'DIFFERENT' : 'not in the file'} ${k}\n`);
  }
  process.stdout.write(bad === 0 ? `all ${Object.keys(hashes).length} hashes match ${check}\n` : `${bad} of ${Object.keys(hashes).length} hashes differ from ${check}\n`);
  if (bad > 0) process.exitCode = 1;
}
