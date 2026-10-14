# Audio credits

**No third-party audio assets are used.** Every sound in Xeno-Racer is synthesised at runtime:

| Sound | How |
|---|---|
| Engines (4-12 cylinders, flat / crossplane / boxer, turbo) | physically-structured model in an AudioWorklet: crank-angle clock, per-cylinder blowdown pulses, waveguide exhaust (headers, collectors, muffler, tailpipe), intake, valvetrain, turbo, gear whine (`src/audio/dsp/engine-voice.ts`) |
| Tires, road / surface noise, curbs, wind, thumps, scrape, impacts | filtered noise, stick-slip oscillators and modal synthesis (`src/audio/dsp/chassis-voice.ts`) |
| UI sounds | FM bells and enveloped oscillators (`src/audio/ui-sounds.ts`) |
| Menu music | generative A-minor synthwave built from oscillators, filters and a procedurally generated reverb (`src/audio/music.ts`) |

`previews/*.wav` are renders of the above made by `node sandbox/audio/render-previews.mjs` (they are
generated files, safe to delete and re-create; nothing in the game loads them).
