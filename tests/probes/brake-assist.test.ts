/**
 * The braking assist, on the road: a lone car whose "driver" only steers along the line, with the throttle flat out all the way
 * round and the brake never touched, laps every circuit. With the assist off such a car goes into the first hairpin at full speed
 * and into the wall; with it on the car must lap, and stay on the asphalt.
 *
 *   BRAKEASSIST=1 npx vitest run tests/probes/brake-assist.test.ts
 *
 * Choices through the environment: TRACKS=aurelia,kuroyama CARS=vanta-gt WET=0,0.75 LAPS=2 AIDS=beginner|standard|pro (the aids of
 * the car; the braking assist is on whichever they are, as is the guide) STEER=alien|amateur|pad (who steers: the AI's path follower at
 * that skill, or a stick through the steering filter) ASSIST=0 (switch it off, for a control run) AI=1 (the AI works the pedals too: the
 * same circuit, driven by the AI alone, by the same measures). The table goes to .cache/line/brake-assist.txt (BRAKEASSIST_OUT overrides).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { CARS } from '../../src/cars';
import { ASSIST, type AssistPreset } from '../../src/core/aids';
import type { Difficulty } from '../../src/core/contracts';
import { TRACKS } from '../../src/track';
import { assistedLaps, describeLap } from './assist-lap';

it.skipIf(!process.env.BRAKEASSIST)('braking assist: every circuit, steering only, throttle flat out', () => {
  // (for experiments: ASSIST_TUNE='{"cutOver":0.35}' changes the assist's constants for the run)
  Object.assign(ASSIST, JSON.parse(process.env.ASSIST_TUNE ?? '{}'));
  const out = process.env.BRAKEASSIST_OUT ?? '.cache/line/brake-assist.txt';
  mkdirSync('.cache/line', { recursive: true });
  writeFileSync(out, '');
  const tracks = (process.env.TRACKS ?? TRACKS.map((t) => t.info.id).join(',')).split(',');
  const cars = (process.env.CARS ?? CARS.map((c) => c.id).join(',')).split(',');
  const wets = (process.env.WET ?? '0,0.75').split(',').map(Number);
  const laps = +(process.env.LAPS ?? 2);
  const aids = (process.env.AIDS ?? 'beginner') as AssistPreset;
  const steer = (process.env.STEER === 'pad' ? 'alien' : process.env.STEER ?? 'alien') as Difficulty;
  const assist = process.env.ASSIST !== '0';
  const gripUse = process.env.GRIP ? +process.env.GRIP : undefined;
  const brakeUse = process.env.BRAKE ? +process.env.BRAKE : undefined;
  for (const t of tracks) for (const c of cars) for (const w of wets) {
    const r = assistedLaps(t, c, { laps, wetness: w, aids, steer, assist, gripUse, brakeUse, ai: process.env.AI === '1', pad: process.env.STEER === 'pad' });
    appendFileSync(out, describeLap(`${t} ${c} wet ${w}`, r) + '\n');
  }
});
