/**
 * The TV director's line of sight through a town: a building between a trackside camera and the car blocks it, one beside the
 * line, behind the car or below the sight line does not.
 */
import { describe, expect, it } from 'vitest';
import { blockedByBuildings } from '../src/render/cameraRig';

/** One occluder record: an axis-aligned w x d footprint centred on (x, z) with its roof at `top` (corners as the city stores them). */
function box(x: number, z: number, w: number, d: number, top: number): number[] {
  const hw = w / 2;
  const hd = d / 2;
  return [x, z, Math.hypot(hw, hd), top, x - hw, z - hd, x + hw, z - hd, x + hw, z + hd, x - hw, z + hd];
}
const occ = (...b: number[][]): Float32Array => new Float32Array(b.flat());

describe('TV line of sight through buildings', () => {
  // camera on a 9 m mast at the origin, the car 100 m down the x axis on the road
  const see = (o: Float32Array, ty = 0.6, cy = 9): boolean => !blockedByBuildings(o, 0, cy, 0, 100, ty, 0);

  it('is blocked by a building standing on the line', () => {
    expect(see(occ(box(50, 0, 12, 12, 15)))).toBe(false);
    // a low one near the car still hides it: the sight line is lowest at the car's end
    expect(see(occ(box(90, 0, 6, 6, 4)))).toBe(false);
  });

  it('is clear past a building beside the line, behind the car or behind the camera', () => {
    expect(see(occ(box(50, 20, 12, 12, 30)))).toBe(true);
    expect(see(occ(box(120, 0, 12, 12, 30)))).toBe(true);
    expect(see(occ(box(-15, 0, 12, 12, 30)))).toBe(true);
  });

  it('looks over a building lower than the sight line', () => {
    // near the camera the line is still high: a 6 m wall 10 m out is below it
    expect(see(occ(box(10, 0, 4, 4, 6)))).toBe(true);
    // a tall mast over a two-storey block further on
    expect(see(occ(box(40, 0, 8, 8, 6)), 0.6, 30)).toBe(true);
    expect(see(occ(box(40, 0, 8, 8, 6)), 0.6, 9)).toBe(false);
  });

  it('only grazing a corner does not count, and an empty town never blocks', () => {
    // the footprint ends 0.2 m short of the line
    expect(see(occ(box(50, 6.2, 12, 12, 30)))).toBe(true);
    expect(see(occ())).toBe(true);
    expect(blockedByBuildings(occ(box(0, 0, 4, 4, 30)), 5, 9, 5, 5, 0.6, 5)).toBe(false); // camera right over the car
  });

  it('works whichever way the footprint winds and for a rotated footprint', () => {
    const b = box(50, 0, 12, 12, 15);
    const rev = [...b.slice(0, 4), b[10], b[11], b[8], b[9], b[6], b[7], b[4], b[5]];
    expect(see(occ(rev))).toBe(false);
    // a diamond: corners on the axes
    const dia = [50, 0, 8, 15, 42, 0, 50, -8, 58, 0, 50, 8];
    expect(see(occ(dia))).toBe(false);
    const off = [50, 12, 8, 15, 42, 12, 50, 4.5, 58, 12, 50, 20];
    expect(see(occ(off))).toBe(true);
  });
});
