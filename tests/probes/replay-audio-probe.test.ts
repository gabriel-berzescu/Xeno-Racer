/**
 * Replay sound probe (on demand): a headless AI race is recorded the way the game records it, then the same cars are voiced twice
 * through the real control mapping (CarFrame): once live, from the physics states, and once from a ReplayPlayer playing the
 * recording back. Every one-shot trigger the worklet would act on (shift clunk, backfire pop, suspension thump, impact, limiter)
 * is counted per car and per second in both passes. (Result: shifts, backfires and hits come out one for one; a replay has no
 * suspension thumps at all, the recording not having the suspension's velocity. The loud "pac" of a replay was not a trigger but
 * the engine voices' lite to full promotion: see tests/audio-replay.test.ts.)
 *
 *   R1=1 [TRACK=aurelia] [SECS=100] [N=8] [AFTER=8] npx vitest run tests/probes/replay-audio-probe.test.ts
 */
import { writeFileSync } from 'node:fs';
import { PerspectiveCamera } from 'three';
import { it } from 'vitest';
import { AIDriver } from '../../src/ai';
import { CarFrame } from '../../src/audio/carsound';
import { CTL } from '../../src/audio/controls';
import { listenerFromMatrix, makeListener } from '../../src/audio/spatial';
import { CARS } from '../../src/cars';
import { ReplayPlayer, ReplayRecorder } from '../../src/game/replay';
import { PhysicsWorld } from '../../src/physics';
import { loadTrackRuntime } from '../../src/track';

const DT = 1 / 60;

interface Ev {
  t: number;
  car: number;
  kind: string;
  val: number;
}

function counters(v: Float32Array) {
  return { shift: v[CTL.SHIFT_COUNT], bf: v[CTL.BACKFIRE_COUNT], thump: v[CTL.THUMP_COUNT], imp: v[CTL.IMPACT_COUNT], lim: v[CTL.LIMITER] };
}

it.skipIf(!process.env.R1)('replay vs live: one-shot sound triggers', () => {
  const trackId = process.env.TRACK ?? 'aurelia';
  const secs = +(process.env.SECS ?? 100);
  const n = +(process.env.N ?? 8);
  const after = +(process.env.AFTER ?? 8);
  const track = loadTrackRuntime(trackId);
  const world = new PhysicsWorld(track);
  const cars: { v: ReturnType<PhysicsWorld['addVehicle']>; ai: AIDriver }[] = [];
  for (let i = 0; i < n; i++) {
    const def = CARS[i % CARS.length];
    const v = world.addVehicle(def);
    v.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
    const g = track.grid[Math.min(i, track.grid.length - 1)];
    v.placeOnGround(g.position, g.quaternion, 0);
    v.setTemperatures(0.8);
    v.holdOnGrid = true;
    cars.push({ v, ai: new AIDriver(track, def, { difficulty: 'pro', seed: v.id * 17 + i }) });
  }
  const states = world.states;
  const rec = new ReplayRecorder(n, 6);
  const listener = makeListener();
  const cam = new PerspectiveCamera();
  cam.position.set(0, 3, 0);
  cam.updateMatrixWorld();
  listenerFromMatrix(cam.matrixWorld.elements, 0, 0, 0, listener);

  // ── live pass ──
  const live: Ev[] = [];
  const frames = cars.map((_, i) => new CarFrame(i === 0));
  const prevLive: ReturnType<typeof counters>[] = [];
  let racing = false;
  const limit = 6 + secs;
  const flagAt = limit;
  while (world.time < flagAt + after) {
    if (!racing && world.time >= 6) {
      racing = true;
      for (const c of cars) c.v.holdOnGrid = false;
    }
    for (const c of cars) c.ai.update(DT, c.v.state, states, c.v.controls, racing);
    world.step(DT);
    if (world.time <= flagAt && racing) rec.capture(world.time - rec.t0, states);
    for (let i = 0; i < n; i++) {
      frames[i].compute(states[i], DT, listener, 0, 2, false, 0);
      const c = counters(frames[i].vec);
      const p = prevLive[i];
      const t = world.time - 6;
      if (p && t >= 0 && world.time <= flagAt) {
        if (c.shift !== p.shift) live.push({ t, car: i, kind: 'shift', val: c.shift });
        if (c.bf !== p.bf) live.push({ t, car: i, kind: 'backfire', val: c.bf });
        if (c.thump !== p.thump) live.push({ t, car: i, kind: 'thump', val: frames[i].vec[CTL.THUMP_STRENGTH] });
        if (c.imp !== p.imp) live.push({ t, car: i, kind: 'impact', val: frames[i].vec[CTL.IMPACT_STRENGTH] });
        if (c.lim > 0.5 && p.lim <= 0.5) live.push({ t, car: i, kind: 'limiter', val: 1 });
      }
      prevLive[i] = c;
    }
  }
  // ── what the replay is built from at this moment: world.states, as the game does when "Watch replay" is pressed ──
  const player = new ReplayPlayer(rec, world.states);
  // (the recording has no suspension velocity: the template's, frozen in the stand-ins, would be a kerb hit over and over)
  const staleSv = world.states.map((s) => s.wheels.map((w) => +w.suspensionVelocity.toFixed(2)));
  console.log('replay frames', rec.frames, 'duration', rec.duration.toFixed(1), 'template suspensionVelocity per car at replay start', JSON.stringify(staleSv), 'stand-ins', JSON.stringify(player.states.map((s) => s.wheels.map((w) => w.suspensionVelocity))));

  // ── replay pass ──
  const rep: Ev[] = [];
  const rframes = cars.map((_, i) => new CarFrame(i === 0));
  const prevRep: ReturnType<typeof counters>[] = [];
  // (the live frames' mappers carry on into the replay in the game: the same CarSoundImpl; here too, so the jump at the start shows)
  for (let i = 0; i < n; i++) prevRep[i] = counters(frames[i].vec);
  let t = 0;
  const startEv: Ev[] = [];
  while (t <= rec.duration) {
    player.apply(t);
    for (let i = 0; i < n; i++) {
      frames[i].compute(player.states[i], DT, listener, 0, 2, false, 0);
      const c = counters(frames[i].vec);
      const p = prevRep[i];
      const push = (kind: string, val: number): void => {
        (t < 0.1 ? startEv : rep).push({ t, car: i, kind, val });
      };
      if (c.shift !== p.shift) push('shift', c.shift);
      if (c.bf !== p.bf) push('backfire', c.bf);
      if (c.thump !== p.thump) push('thump', frames[i].vec[CTL.THUMP_STRENGTH]);
      if (c.imp !== p.imp) push('impact', frames[i].vec[CTL.IMPACT_STRENGTH]);
      if (c.lim > 0.5 && p.lim <= 0.5) push('limiter', 1);
      prevRep[i] = c;
    }
    t += DT;
  }
  const dur = rec.duration;
  const lines: string[] = [];
  for (const kind of ['shift', 'backfire', 'thump', 'impact', 'limiter']) {
    for (let i = 0; i < n; i++) {
      const l = live.filter((e) => e.kind === kind && e.car === i).length;
      const r = rep.filter((e) => e.kind === kind && e.car === i).length;
      lines.push(`${kind.padEnd(9)} car${i} live ${String(l).padStart(4)} (${(l / dur).toFixed(2)}/s)  replay ${String(r).padStart(4)} (${(r / dur).toFixed(2)}/s)`);
    }
  }
  console.log(lines.join('\n'));
  console.log('events at the very start of the replay (t < 0.1 s):', JSON.stringify(startEv.map((e) => `${e.kind}@car${e.car}=${e.val.toFixed(2)}`)));
  writeFileSync('.cache/qa/logs/r1-vitest-probe.json', JSON.stringify({ live, rep, startEv, staleSv, dur }));
}, 600000);
