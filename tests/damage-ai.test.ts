/**
 * The AI and the mechanical damage (Damage: Full): a driver whose car is bent drives the car it has, in a lap alone and in a pack,
 * and a sound car is driven exactly as before. The long comparisons are in tests/probes/damage-race.test.ts and damage-calib.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { AIDriver, damageFactors, profileLapTime } from '../src/ai';
import { getCar } from '../src/cars';
import { MechState, mechanicalEffects, neutralEffects } from '../src/core/mechanical';
import { loadTrackRuntime } from '../src/track';
import { damagedLaps } from './probes/damage-lap';
import { runPack } from './probes/pack-race';

const wreck = (parts: { front?: number; rear?: number; wheels?: [number, number, number, number] }) => {
  const m = new MechState();
  const e = (w: number): number => -Math.log(1 - Math.min(w, 0.999999));
  m.front = e(parts.front ?? 0);
  m.rear = e(parts.rear ?? 0);
  for (let i = 0; i < 4; i++) m.wheel[i] = e((parts.wheels ?? [0, 0, 0, 0])[i]);
  return mechanicalEffects(m);
};
const EVERYTHING = wreck({ front: 1, rear: 1, wheels: [1, 1, 1, 1] });

describe('a driver that learns of damage', () => {
  it('asks nothing of a sound car, and gives back exactly its old speed profile when the car is repaired', () => {
    const track = loadTrackRuntime('aurelia');
    for (const id of ['vanta-gt', 'lmp-x']) {
      const def = getCar(id);
      const sound = new AIDriver(track, def, { difficulty: 'pro', seed: 3 });
      const before = Float32Array.from(sound.profile.v);
      sound.setDamage(null);
      sound.setDamage(neutralEffects());
      expect(Float32Array.from(sound.profile.v)).toEqual(before);
      // the damage of a few taps is too little to make a driver work out its speeds again
      sound.setDamage(wreck({ front: 0.01, wheels: [0.01, 0, 0, 0] }), 0);
      expect(Float32Array.from(sound.profile.v)).toEqual(before);
      sound.setDamage(EVERYTHING, 0);
      expect(Float32Array.from(sound.profile.v)).not.toEqual(before);
      sound.setDamage(null, 0);
      expect(Float32Array.from(sound.profile.v)).toEqual(before);
    }
    expect(damageFactors(null)).toEqual({ grip: 1, aero: 1 });
    expect(damageFactors(neutralEffects())).toEqual({ grip: 1, aero: 1 });
  });

  it('brakes earlier and carries less speed where the downforce carried it, and gives up nothing it does not have to', () => {
    const track = loadTrackRuntime('aurelia');
    const def = getCar('lmp-x');
    const sound = new AIDriver(track, def, { difficulty: 'alien', seed: 1 });
    const hurt = new AIDriver(track, def, { difficulty: 'alien', seed: 1 });
    const v0 = Float32Array.from(sound.profile.v);
    hurt.setDamage(wreck({ front: 1, rear: 1, wheels: [1, 1, 1, 1] }), 0);
    const v1 = hurt.profile.v;
    let slower = 0;
    for (let i = 0; i < v0.length; i++) {
      expect(v1[i]).toBeLessThanOrEqual(v0[i] + 1e-4);
      if (v1[i] < v0[i] - 0.5) slower++;
    }
    expect(slower).toBeGreaterThan(v0.length * 0.1); // the fast corners
    expect(slower).toBeLessThan(v0.length * 0.9); // not the whole lap
    const lap0 = profileLapTime(sound.line, sound.profile);
    const lap1 = profileLapTime(hurt.line, hurt.profile);
    expect(lap1).toBeGreaterThan(lap0 * 1.002);
    expect(lap1).toBeLessThan(lap0 * 1.06);
    // the factors it works with: a part of the grip and the downforce the damage takes (the power is the car's own business)
    const f = damageFactors(EVERYTHING);
    expect(f.grip).toBeLessThan(1);
    expect(f.grip).toBeGreaterThan(0.97);
    expect(f.aero).toBeLessThan(1);
    expect(f.aero).toBeGreaterThan(0.85);
    const lighter = damageFactors(wreck({ front: 0.3, wheels: [0.3, 0, 0, 0] }));
    expect(lighter.aero).toBeGreaterThan(f.aero);
    expect(lighter.grip).toBeGreaterThanOrEqual(f.grip);
  });
});

describe('a damaged AI car on the circuits', () => {
  // Alone on the road, the physics costs a prototype up to a few percent of a lap and a road car one or two, the driver that
  // knows costs a little more, and neither goes off the road, hits a wall or needs a reset (4 circuits, 2 cars; see the probe).
  const cases: [string, string][] = [
    ['aurelia', 'lmp-x'],
    ['portovela', 'vanta-gt'],
  ];
  for (const [trackId, carId] of cases)
    it(`laps ${trackId} cleanly in the ${carId} with everything bent`, () => {
      const sound = damagedLaps(trackId, carId, null, { laps: 2 });
      const knows = damagedLaps(trackId, carId, EVERYTHING, { laps: 2 });
      const blind = damagedLaps(trackId, carId, EVERYTHING, { laps: 2, adapt: false });
      for (const r of [sound, knows, blind]) {
        expect(r.lapTimes.length).toBe(2);
        expect(r.resets).toBe(0);
        expect(r.walls).toBe(0);
        expect(r.off).toBeLessThan(1);
      }
      const lap = (r: typeof sound): number => r.lapTimes[1];
      // slower, but by a few percent, not tens of percent
      expect(lap(blind)).toBeGreaterThan(lap(sound) * 1.005);
      expect(lap(knows)).toBeGreaterThan(lap(sound) * 1.005);
      expect(lap(knows)).toBeLessThan(lap(sound) * 1.1);
      expect(lap(blind)).toBeLessThan(lap(sound) * 1.1);
    }, 300000);
});

describe('a pack with damage in it', () => {
  it('stays on the road with half the field bent and the drivers told so', () => {
    const half = (i: number) => {
      if (i % 2) return null;
      const m = new MechState();
      m.front = 1.4;
      m.wheel[i % 4 === 0 ? 0 : 1] = 1.5;
      m.wheel[2 + (i % 3 === 0 ? 0 : 1)] = 0.8;
      m.rear = 0.7;
      return m;
    };
    const sound = runPack('aurelia', 'mixed', 'pro', 12, 1, false, { seed: 1 });
    const bent = runPack('aurelia', 'mixed', 'pro', 12, 1, false, { seed: 1, initial: half });
    expect(bent.finished).toBe(12);
    expect(bent.resets).toBe(0);
    expect(bent.walls).toBeLessThanOrEqual(sound.walls + 2);
    expect(bent.offTrack).toBeLessThan(sound.offTrack + 4);
    expect(bent.worstWear!).toBeGreaterThan(0.6); // the damage was there all race
  }, 300000);

  it('races as cleanly with Full as with Visual: the bumps of a pack do not bend anything', () => {
    const visual = runPack('aurelia', 'mixed', 'pro', 12, 1, false, { seed: 2 });
    const full = runPack('aurelia', 'mixed', 'pro', 12, 1, false, { seed: 2, full: true });
    expect(full.finished).toBe(12);
    expect(full.resets).toBe(visual.resets);
    expect(full.walls).toBeLessThanOrEqual(visual.walls + 1);
    expect(full.offTrack).toBeLessThan(visual.offTrack + 2);
    // whatever the hits of this race did to the mechanics was too little to see or to feel
    expect(full.worstWear!).toBeLessThan(0.2);
    expect(Math.abs(full.winnerTime - visual.winnerTime)).toBeLessThan(2);
  }, 300000);
});
