/**
 * Album docs generator (on demand): rewrites every `<!-- gen:... -->` block of src/audio/album/README.md from the catalogue
 * (parameters, ranges, presets, effects, mixer tables, examples) and from the embedded source files (sandbox/album/example-track.ts,
 * sandbox/album/custom-instrument.ts), then regenerates sandbox/album/readme-snippets.ts, the typed file that holds all the code of
 * the README (its `ts run` blocks and the example of every instrument) so that `npx tsc --noEmit` checks it and the tests run it.
 *
 *   DOCS=1 npx vitest run tests/probes/album-docs.test.ts
 *
 * tests/album-engine.test.ts fails when the README or the snippets file is out of date, so run this after changing a parameter, a
 * preset, an example or the README.
 */
import { describe, expect, it } from 'vitest';
import { readReadme, readSnippets, renderReadme, renderSnippets, writeReadme, writeSnippets } from '../../sandbox/album/lab/readme';

describe.skipIf(process.env.DOCS !== '1')('album docs', () => {
  it('regenerates the README tables and the snippets file', () => {
    const before = readReadme();
    const after = renderReadme();
    if (after !== before) writeReadme(after);
    const snippets = renderSnippets(after);
    const snippetsBefore = readSnippets();
    if (snippets !== snippetsBefore) writeSnippets(snippets);
    process.stdout.write(`README ${after === before ? 'already up to date' : 'rewritten'} (${after.length} characters), readme-snippets.ts ${snippets === snippetsBefore ? 'already up to date' : 'rewritten'}\n`);
    expect(after.length).toBeGreaterThan(1000);
  });
});
