import { describe, expect, it } from 'vitest';
import { shadowConfigFor, SunShadows } from '../src/render/shadows';

describe('the cascades where the terrain hides the sun', () => {
  const make = (): SunShadows => {
    const sun = new SunShadows(true);
    sun.configure(shadowConfigFor('high', 'high'));
    return sun;
  };
  const intensities = (sun: SunShadows, set: 0 | 1): number[] => sun.sets[set].map((l) => l.shadow.intensity);

  it('take no sun from a view whose cascades cover only shade: the intensity is 0 until the shade ends, whatever the weather says meanwhile', () => {
    const sun = make();
    sun.setShadowIntensity(0.8);
    expect(intensities(sun, 0).every((v) => v === 0.8)).toBe(true);
    sun.setDark(0, true);
    // (every light of the set: the shader reads the first, the others are the cascades')
    expect(intensities(sun, 0).every((v) => v === 0)).toBe(true);
    // the other view's set is its own
    expect(intensities(sun, 1).every((v) => v === 0.8)).toBe(true);
    // the weather changes under the shade: the shade keeps the sun out, and the new strength is what comes back
    sun.setShadowIntensity(0.5);
    expect(intensities(sun, 0).every((v) => v === 0)).toBe(true);
    expect(intensities(sun, 1).every((v) => v === 0.5)).toBe(true);
    sun.setDark(0, false);
    expect(intensities(sun, 0).every((v) => v === 0.5)).toBe(true);
  });

  it('keep the shade across a change of the shadow settings, and a split screen has a shade for each view', () => {
    const sun = make();
    sun.setDark(1, true);
    sun.configure(shadowConfigFor('low', 'medium'));
    expect(intensities(sun, 1).every((v) => v === 0)).toBe(true);
    expect(sun.sets[0][0].shadow.intensity).toBe(1);
    sun.setDark(1, false);
    sun.setDark(0, true);
    expect(intensities(sun, 0).every((v) => v === 0)).toBe(true);
    expect(intensities(sun, 1).every((v) => v === 1)).toBe(true);
    // (asking for what is already so is nothing)
    sun.setDark(0, true);
    expect(intensities(sun, 0).every((v) => v === 0)).toBe(true);
  });
});
