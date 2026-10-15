/**
 * Cockpit wiper checks for the offline report (browser; the real worklet voice, graph and buses). Where the thunks land against
 * the schedule the picture's blade follows, how the wiper sits against the cabin rain and the engine, and what it costs.
 */
import { clickScore, hasNonFinite, peakAbs, rms } from '../../src/audio/analysis';
import { WiperVoice } from '../../src/audio/dsp/wiper-voice';
import { getCar } from '../../src/cars';
import { DEFAULT_VOLUMES, SR, renderScene, type SceneResult } from './harness';
import { Checks, db, mono } from './report-util';
import { followListener, steppedCar } from './scenarios';
import { simulateWiper, sweepTimes, type WiperSimResult } from './wiper-sim';

const CAR = getCar('vanta-gt');
const f1 = (x: number): string => x.toFixed(1);

function pct(a: number[], p: number): number {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

/** Flat RMS (dB) of the louder channel over 100 ms windows (hop 50 ms) between a and b seconds. */
function windows100(r: SceneResult, a: number, b: number): number[] {
  const w = Math.floor(0.1 * r.sr);
  const out: number[] = [];
  for (let s = Math.floor(a * r.sr); s + w <= Math.floor(b * r.sr); s += w >> 1) out.push(db(Math.max(rms(r.left, s, s + w), rms(r.right, s, s + w))));
  return out;
}

/**
 * Onset of the transient near `t` (s): the first instant in [t - 3 ms, t + 12 ms] at which a 0.5 ms RMS envelope jumps to more than
 * `ratio` times the level 5-30 ms before. NaN when there is none.
 */
function onsetNear(x: Float32Array, sr: number, t: number, ratio = 3): number {
  const w = Math.max(8, Math.floor(0.0005 * sr));
  const at = (i: number): number => rms(x, i, i + w);
  const i0 = Math.floor((t - 0.03) * sr);
  const quiet: number[] = [];
  for (let i = i0; i < Math.floor((t - 0.005) * sr); i += w) quiet.push(at(i));
  const ref = Math.max(pct(quiet, 0.5), 1e-7);
  for (let i = Math.floor((t - 0.003) * sr); i < Math.floor((t + 0.012) * sr); i++) if (at(i) > ratio * ref) return i / sr;
  return Number.NaN;
}

export interface WiperReport {
  timing: Record<string, number>;
  levels: Record<string, number>;
  variation: Record<string, number>;
  cpu: Record<string, number>;
}

export async function wiperChecks(checks: Checks): Promise<WiperReport> {
  const out: WiperReport = { timing: {}, levels: {}, variation: {}, cpu: {} };

  const sim = (rain: number, seconds: number, extra: Partial<Parameters<typeof simulateWiper>[0]> = {}): WiperSimResult =>
    simulateWiper({ seconds, rain, fps: 60, jitter: 0.3, seed: 4, plannerSeed: 3, ...extra });
  const wiperOnly = (s: WiperSimResult, seconds: number): Promise<SceneResult> => renderScene({ seconds, cars: [], wiper: { sweeps: s.sweeps }, raw: true, volumes: DEFAULT_VOLUMES });

  // ── A. where the thunks land ────────────────────────────────────────────────
  for (const [name, rain, secs] of [
    ['rain', 0.55, 20],
    ['storm', 1, 12],
  ] as const) {
    const s = sim(rain, secs + 1);
    const r = await wiperOnly(s, secs);
    const x = mono(r);
    const errs: number[] = [];
    let missed = 0;
    for (const c of s.sweeps) {
      const t = sweepTimes(c, SR);
      for (const tt of [t.reversal, t.park]) {
        if (tt < 0.1 || tt > secs - 0.2) continue;
        const o = onsetNear(x, SR, tt);
        if (Number.isNaN(o)) missed++;
        else errs.push((o - tt) * 1000);
      }
    }
    const worst = Math.max(...errs.map(Math.abs));
    out.timing[`${name}: thunks checked`] = errs.length;
    out.timing[`${name}: worst onset error ms`] = worst;
    out.timing[`${name}: mean onset error ms`] = errs.reduce((a, b) => a + b, 0) / errs.length;
    checks.add(`wiper ${name}: every thunk of the real worklet starts on the sample the planner scheduled (within 1.5 ms, none missed)`, errs.length >= (rain < 0.8 ? 8 : 18) && missed === 0 && worst < 1.5, `${errs.length} thunks, worst ${f1(worst)} ms, ${missed} missed`, '< 1.5 ms');
    // and it is the picture's blade the thunks are on: the plan itself is within 1 ms of the picture's clock reaching each end
    let planWorst = 0;
    for (const c of s.sweeps) planWorst = Math.max(planWorst, Math.abs(c.f0 / SR - s.wallAt(c.cs)), Math.abs((c.f0 + c.strokeN) / SR - s.wallAt(c.cs + 0.42)), Math.abs((c.f0 + 2 * c.strokeN) / SR - s.wallAt(c.cs + 0.84)));
    out.timing[`${name}: plan vs picture ms`] = planWorst * 1000;
    checks.add(`wiper ${name}: the planned sweeps start, turn and park when the picture's clock does (within 1 ms; jittery 60 fps frames)`, planWorst < 0.001, `${(planWorst * 1000).toFixed(2)} ms`, '< 1 ms');
    checks.add(`wiper ${name}: finite, nothing near full scale (peak < -15 dBFS)`, !hasNonFinite(r.left) && !hasNonFinite(r.right) && Math.max(peakAbs(r.left), peakAbs(r.right)) < 0.18, f1(db(Math.max(peakAbs(r.left), peakAbs(r.right)))), '< -15 dBFS');
  }

  // silence before the first sweep is joined and the context starts at frame 0: exact zeros until then
  {
    const s = sim(0.55, 12, { clock0: 1.0 }); // the blade starts in its pause: the first sweep is more than a second away
    const r = await wiperOnly(s, 6);
    const first = s.sweeps[0].f0 / SR;
    const quiet = db(Math.max(rms(r.left, 0, Math.floor((first - 0.02) * SR)), rms(r.right, 0, Math.floor((first - 0.02) * SR))));
    checks.add('wiper: silent (< -140 dBFS) until the first sweep, nothing leaks from the idle voice', quiet < -140, `${f1(quiet)} dBFS before ${first.toFixed(2)} s`, '< -140 dBFS');
    const click = clickScore(mono(r).subarray(Math.floor((first - 0.05) * SR), Math.floor((first + 0.5) * SR)), 96);
    checks.add('wiper: the first sweep starts without a click', click.score < 60, click.score, '< 60');
  }

  // ── B. against the cabin rain and the engine ───────────────────────────────
  for (const [name, rain, wet] of [
    ['rain', 0.55, 0.75],
    ['storm', 1, 1],
  ] as const) {
    const secs = 16;
    const s = sim(rain, secs + 1);
    const w = await wiperOnly(s, secs);
    const cabin = await renderScene({ seconds: secs, cars: [], weather: { rain, interior: 1, speed: 33 }, wetness: wet, raw: true, volumes: DEFAULT_VOLUMES });
    const wl = windows100(w, 3, secs);
    const rl = windows100(cabin, 3, secs);
    const wMax = Math.max(...wl);
    const rMed = pct(rl, 0.5);
    out.levels[`${name}: wiper loudest 100 ms dBFS`] = wMax;
    out.levels[`${name}: cabin rain median 100 ms dBFS`] = rMed;
    out.levels[`${name}: wiper under the cabin rain dB`] = rMed - wMax;
    checks.add(`wiper ${name}: sits under the cabin rain (its loudest 100 ms is >= 4 dB below the rain's median, and not lost: <= 14 dB below)`, wMax <= rMed - 4 && wMax >= rMed - 14, `${f1(wMax)} vs rain ${f1(rMed)} dBFS`, '4..14 dB under');

    // against the engine: cruising and lifting, cockpit view
    const cabinScene = (wiper: boolean): Promise<SceneResult> => {
      const eng = steppedCar(CAR, [
        { t: 0, rpm: 3400, throttle: 0.3, load: 0.3, speed: 33, gear: 4 },
        { t: 8, rpm: 3000, throttle: 0, load: 0, speed: 31, gear: 4 },
      ]);
      return renderScene({ seconds: secs, cars: [{ ...eng, interior: 1 }], listener: followListener(eng, 0, 1.0), weather: { rain, interior: 1, speed: 33 }, wetness: wet, wiper: wiper ? { sweeps: s.sweeps } : undefined, raw: true, volumes: DEFAULT_VOLUMES });
    };
    const mix = await cabinScene(true);
    const noWiper = await cabinScene(false);
    // the wiper changes the mix by a fraction of a dB (it sits under the rest)
    const lvl = (r: SceneResult, a: number, b: number): number => db(Math.max(rms(r.left, Math.floor(a * SR), Math.floor(b * SR)), rms(r.right, Math.floor(a * SR), Math.floor(b * SR))));
    const added = lvl(mix, 3, 7) - lvl(noWiper, 3, 7);
    out.levels[`${name}: the wiper adds to the cruising cabin mix dB`] = added;
    checks.add(`wiper ${name}: the cruising cabin mix (engine + rain + wet tires) grows by less than 0.8 dB when the wiper is on`, added >= -0.05 && added < 0.8, `+${added.toFixed(2)} dB`, '< 0.8 dB');
    checks.add(`wiper ${name}: with the wiper the mix is finite and well under full scale`, !hasNonFinite(mix.left) && Math.max(peakAbs(mix.left), peakAbs(mix.right)) < 0.9, f1(db(Math.max(peakAbs(mix.left), peakAbs(mix.right)))), '< -1 dBFS');
  }

  // ── C. never the same sweep twice ──────────────────────────────────────────
  {
    const s = sim(1, 16);
    const r = await wiperOnly(s, 14);
    const x = mono(r);
    const sw = s.sweeps.filter((c) => c.f0 / SR > 2 && (c.f0 + 2 * c.strokeN) / SR < 13);
    const lv = sw.map((c) => db(rms(x, c.f0, c.f0 + 2 * c.strokeN)));
    out.variation['storm: sweep level spread dB (max - min)'] = Math.max(...lv) - Math.min(...lv);
    checks.add('wiper storm: the sweeps differ in level (a spread of 0.4-6 dB over a dozen of them), so non-stop wiping is no loop', Math.max(...lv) - Math.min(...lv) > 0.4 && Math.max(...lv) - Math.min(...lv) < 6, f1(Math.max(...lv) - Math.min(...lv)), '0.4..6 dB');
    let worstCorr = 0;
    for (let i = 1; i < sw.length; i++) {
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      for (let k = 0; k < sw[i].strokeN; k++) {
        const a = r.left[sw[i - 1].f0 + k];
        const b = r.left[sw[i].f0 + k];
        sab += a * b;
        saa += a * a;
        sbb += b * b;
      }
      worstCorr = Math.max(worstCorr, Math.abs(sab / Math.sqrt(saa * sbb + 1e-30)));
    }
    out.variation['storm: worst waveform correlation of consecutive sweeps'] = worstCorr;
    checks.add('wiper storm: consecutive sweeps are different waveforms (|correlation| < 0.2)', worstCorr < 0.2, worstCorr.toFixed(3), '< 0.2');
  }

  // ── D. CPU ─────────────────────────────────────────────────────────────────
  {
    const budget = (128 / SR) * 1e6;
    const bestUs = (run: () => void, iters = 3000, reps = 5): number => {
      for (let i = 0; i < 1500; i++) run();
      let best = Infinity;
      for (let r = 0; r < reps; r++) {
        const t0 = performance.now();
        for (let i = 0; i < iters; i++) run();
        best = Math.min(best, ((performance.now() - t0) / iters) * 1000);
      }
      return best;
    };
    const base = sim(1, 1).sweeps[0];
    const mk = (playing: boolean): number => {
      const v = new WiperVoice(SR, 5);
      const l = new Float32Array(128);
      const r = new Float32Array(128);
      let frame = 0;
      if (playing) for (let i = 0; i < 400; i++) v.queueSweep({ ...base, id: i + 1, dwell: 0, f0: i * 40320 });
      return bestUs(() => {
        v.process(l, r, 128, frame);
        frame += 128;
      });
    };
    out.cpu['wiper voice, a sweep playing (us per quantum)'] = mk(true);
    out.cpu['wiper voice, asleep (us per quantum)'] = mk(false);
    out.cpu['budget (us per quantum)'] = budget;
    checks.add('cpu: the wiper voice costs under 6 % of the audio-thread budget while a sweep plays (DSP only)', out.cpu['wiper voice, a sweep playing (us per quantum)'] <= budget * 0.06, `${out.cpu['wiper voice, a sweep playing (us per quantum)'].toFixed(1)} us (${((out.cpu['wiper voice, a sweep playing (us per quantum)'] / budget) * 100).toFixed(2)} %)`, '<= 6 %');
    checks.add('cpu: asleep it is free (< 1.5 us per quantum)', out.cpu['wiper voice, asleep (us per quantum)'] < 1.5, out.cpu['wiper voice, asleep (us per quantum)'], '< 1.5 us');
  }
  return out;
}
