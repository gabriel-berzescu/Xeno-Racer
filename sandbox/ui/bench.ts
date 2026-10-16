/**
 * HUD micro-benchmark used from the browser console / scripts: `window.__bench(frames)` feeds
 * pre-generated HudStates to `ui.updateHud` and reports the time per call.
 */
import type { HudState } from '../../src/core/contracts';
import type { XenoUI } from '../../src/ui';
import type { MockRace } from './mock';

export interface BenchResult {
  frames: number;
  avgMs: number;
  p95Ms: number;
  worstMs: number;
}

export function benchHud(ui: XenoUI, race: MockRace, frames = 600, t0 = 12): BenchResult {
  const states: HudState[] = [];
  for (let i = 0; i < frames; i++) states.push(race.state(t0 + i / 60));
  // warm up (JIT, font load, canvas allocation)
  for (let i = 0; i < 60; i++) ui.updateHud(states[i % frames]);
  const times: number[] = [];
  for (let i = 0; i < frames; i++) {
    const a = performance.now();
    ui.updateHud(states[i]);
    times.push(performance.now() - a);
  }
  times.sort((x, y) => x - y);
  const sum = times.reduce((x, y) => x + y, 0);
  return { frames, avgMs: sum / frames, p95Ms: times[Math.floor(frames * 0.95)], worstMs: times[frames - 1] };
}

/**
 * The same for a split screen: both seats' HUDs are updated for every frame (`state(seat, i)` makes each frame's states). With `flush`
 * the style and layout work the updates cause is forced inside the timing too (the paint is not).
 */
export function benchSplit(ui: XenoUI, race: MockRace, state: (s: HudState, seat: 0 | 1) => HudState, frames = 600, flush = true, t0 = 12): BenchResult {
  const a: HudState[] = [];
  const b: HudState[] = [];
  for (let i = 0; i < frames; i++) {
    const base = race.state(t0 + i / 60);
    a.push(state(base, 0));
    b.push(state(race.state(t0 + 4 + i / 60), 1));
  }
  const root = ui.root;
  for (let i = 0; i < 60; i++) {
    ui.updateHud(a[i % frames], 0);
    ui.updateHud(b[i % frames], 1);
  }
  const times: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t = performance.now();
    ui.updateHud(a[i], 0);
    ui.updateHud(b[i], 1);
    if (flush) void root.offsetHeight;
    times.push(performance.now() - t);
  }
  times.sort((x, y) => x - y);
  const sum = times.reduce((x, y) => x + y, 0);
  return { frames, avgMs: sum / frames, p95Ms: times[Math.floor(frames * 0.95)], worstMs: times[frames - 1] };
}
