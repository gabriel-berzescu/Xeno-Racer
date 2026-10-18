#!/usr/bin/env node
/**
 * Runs a TypeScript lab script for the album engine in plain Node (no vitest, no browser): bundles it with rolldown and imports it.
 *
 *   node sandbox/album/run.mjs sandbox/album/lab/instrument-lab.ts kick-darksynth
 *   node sandbox/album/run.mjs .cache/album-scratch/anything.ts
 *
 * The bundle goes to .cache/album-lab/ (git-ignored). Extra arguments are passed to the script via process.argv.
 */
import { rolldown } from 'rolldown';
import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const [, , entryArg, ...rest] = process.argv;
if (!entryArg) {
  console.error('usage: node sandbox/album/run.mjs <script.ts> [args...]');
  process.exit(2);
}
const entry = resolve(process.cwd(), entryArg);
const outDir = resolve(root, '.cache/album-lab');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, `${basename(entry, '.ts')}.bundle.mjs`);
const bundle = await rolldown({ input: entry, platform: 'node', external: [/^node:/], logLevel: 'warn' });
await bundle.write({ file: outFile, format: 'esm' });
await bundle.close();
process.argv = [process.argv[0], outFile, ...rest];
await import(pathToFileURL(outFile).href);
