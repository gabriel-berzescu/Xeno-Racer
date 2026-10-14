#!/usr/bin/env node
/**
 * Offline DSP lab runner (Node, no browser): bundles a TypeScript lab script with rolldown and runs it.
 *
 *   node sandbox/audio/lab/run.mjs engine-lab.ts --car lmp-x --scenario run3
 *
 * Outputs (WAV + spectrogram PNG + metrics) go to .cache/audio-lab/ (git-ignored).
 */
import { rolldown } from 'rolldown';
import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const [, , entryArg, ...rest] = process.argv;
if (!entryArg) {
  console.error('usage: node sandbox/audio/lab/run.mjs <lab-script.ts> [args...]');
  process.exit(2);
}
const entry = resolve(here, entryArg);
const outDir = resolve(root, '.cache/audio-lab');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, `${basename(entry, '.ts')}.bundle.mjs`);
const bundle = await rolldown({
  input: entry,
  platform: 'node',
  external: ['three', /^node:/],
  logLevel: 'warn',
});
await bundle.write({ file: outFile, format: 'esm' });
await bundle.close();
process.argv = [process.argv[0], outFile, ...rest];
await import(pathToFileURL(outFile).href);
