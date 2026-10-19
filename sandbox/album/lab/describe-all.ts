// Prints the arrangement listing (with its warnings) of the Sound Check, the worked example and the example tracks.
//   node sandbox/album/run.mjs sandbox/album/lab/describe-all.ts
import soundCheck from '../../../src/audio/album/sound-check';
import example from '../example-track';
import darksynth from '../examples/darksynth';
import punk from '../examples/punk';

for (const def of [soundCheck, example, darksynth, punk]) {
  const song = def.build(48000);
  process.stdout.write(`=== ${def.info.id}\n${song.describe()}\n\n`);
}
