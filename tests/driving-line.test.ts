/**
 * The driving line as the render system draws it (src/render/drivingLine.ts), headless: the ribbon's vertices, colours and alpha for a
 * car at a place on the lap, with no WebGL (three's geometry and material objects need none until something is drawn).
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { DrivingGuide } from '../src/ai';
import { getCar } from '../src/cars';
import { lineRange } from '../src/core/aids';
import type { GroundSample } from '../src/core/contracts';
import { createDrivingLine, LINE_LAYERS, type LineSource } from '../src/render';
import { loadTrackRuntime } from '../src/track';
import { LINE } from '../src/render/drivingLine';

const track = loadTrackRuntime('aurelia');
const guide = new DrivingGuide(track, getCar('vanta-gt'), { weatherMayChange: true });

/** A line source with a speed of its own to ask for, on the real racing line. */
function source(target: (s: number) => number, blend = 0): LineSource {
  return { targetAt: target, brakeAt: () => 10, topSpeed: guide.topSpeed, dry: guide.dry, wet: guide.wet, lineBlend: blend };
}

function attr(line: ReturnType<typeof createDrivingLine>, name: string): Float32Array {
  return line.mesh.geometry.getAttribute(name).array as Float32Array;
}

/** The window the line holds after an update: [rows][2 edges] of alpha (the 4th float of a colour). */
function alphas(line: ReturnType<typeof createDrivingLine>): number[] {
  const col = attr(line, 'aColor');
  const out: number[] = [];
  for (let j = 0; j < line.rows; j++) out.push(col[j * 8 + 3]);
  return out;
}

const green = (c: Float32Array, v: number): boolean => c[v * 4 + 1] > c[v * 4] * 3;

describe('the driving line mesh', () => {
  it('lives on a camera layer of its own, one for each human, and is out of the picture until it is shown', () => {
    const a = createDrivingLine(track, guide, 0);
    const b = createDrivingLine(track, guide, 1);
    expect(a.mesh.layers.isEnabled(LINE_LAYERS[0])).toBe(true);
    expect(a.mesh.layers.isEnabled(LINE_LAYERS[1])).toBe(false);
    expect(a.mesh.layers.isEnabled(0)).toBe(false);
    expect(b.mesh.layers.isEnabled(LINE_LAYERS[1])).toBe(true);
    expect(b.mesh.layers.isEnabled(0)).toBe(false);
    expect(LINE_LAYERS[0]).not.toBe(LINE_LAYERS[1]);
    expect(a.mesh.visible).toBe(false);
    a.setMode('full');
    a.show(true);
    expect(a.mesh.visible).toBe(true);
    a.show(false);
    expect(a.mesh.visible).toBe(false);
    // off stays off, whatever it is told
    a.setMode('off');
    a.show(true);
    expect(a.mesh.visible).toBe(false);
    a.dispose();
    b.dispose();
  });

  it('is a transparent, unlit ribbon that does not write depth and is drawn after the road, under the cars', () => {
    const l = createDrivingLine(track, guide, 0);
    const m = l.mesh.material as import('three').ShaderMaterial;
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.depthTest).toBe(true);
    expect(m.polygonOffset).toBe(true);
    expect(m.polygonOffsetUnits).toBeLessThan(0);
    expect(m.lights).toBe(false);
    expect(l.mesh.castShadow).toBe(false);
    expect(l.mesh.frustumCulled).toBe(false);
    // (drawn with the transparent things of the scene, before the particles; the skid marks, at -5, go first)
    expect(l.mesh.renderOrder).toBeLessThan(0);
  });

  it('holds a window of the line from the car\'s nose out to its range, and no more', () => {
    const l = createDrivingLine(track, source(() => 60), 0);
    l.setMode('full');
    l.show(true);
    for (const speed of [0, 30, 80]) {
      l.update(1000, speed, 1);
      expect(l.rows).toBeGreaterThan(Math.floor(lineRange(speed) / LINE.rowStep) - 1);
      expect(l.rows).toBeLessThan(lineRange(speed) / LINE.rowStep + 6);
      expect(l.mesh.geometry.drawRange.count).toBe((l.rows - 1) * 6);
    }
    // it does no work while it is out of the picture: the window is left as it was (another place on the lap changes nothing)
    l.update(1000, 50, 1);
    const kept = Array.from(attr(l, 'position').slice(0, l.rows * 6));
    l.show(false);
    l.update(2000, 50, 1);
    expect(Array.from(attr(l, 'position').slice(0, l.rows * 6))).toEqual(kept);
  });

  it('lies on the road of every circuit: every vertex is a couple of centimetres above the surface, banking and elevation included, and on asphalt (never on a kerb)', () => {
    const g: GroundSample = { height: 0, normal: new Vector3(), surface: 'asphalt' };
    let checked = 0;
    for (const id of ['aurelia', 'kuroyama', 'brennwald', 'portovela']) {
      const t = loadTrackRuntime(id);
      const own = new DrivingGuide(t, getCar('vanta-gt'), { weatherMayChange: true });
      // (both racing lines: the dry one and the wet one, which keeps further from the kerbs)
      for (const blend of [0, 1]) {
        const l = createDrivingLine(t, { targetAt: () => 60, brakeAt: () => 10, topSpeed: own.topSpeed, dry: own.dry, wet: own.wet, lineBlend: blend }, 0);
        l.setMode('full');
        l.show(true);
        // (round the whole lap, in steps that move the window over every part of it)
        for (let s = 0; s < t.length; s += 150) {
          l.update(s, 40, 1);
          const pos = attr(l, 'position');
          for (let v = 0; v < l.rows * 2; v += 7) {
            t.groundAt(pos[v * 3], pos[v * 3 + 2], g);
            expect(pos[v * 3 + 1] - g.height).toBeGreaterThan(0.02);
            expect(pos[v * 3 + 1] - g.height).toBeLessThan(0.03);
            expect(g.surface).toBe('asphalt');
            checked++;
          }
        }
        l.dispose();
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('keeps to the racing line: the middle of the ribbon is where the line is, and the edges a half width to either side', () => {
    const l = createDrivingLine(track, source(() => 60), 0);
    l.setMode('full');
    l.show(true);
    l.update(1500, 50, 1);
    const pos = attr(l, 'position');
    const p = new Vector3();
    for (let j = 2; j < l.rows - 2; j += 9) {
      const a = new Vector3(pos[j * 6], pos[j * 6 + 1], pos[j * 6 + 2]);
      const b = new Vector3(pos[j * 6 + 3], pos[j * 6 + 4], pos[j * 6 + 5]);
      expect(a.distanceTo(b)).toBeGreaterThan(LINE.halfWidth * 2 - 0.1);
      expect(a.distanceTo(b)).toBeLessThan(LINE.halfWidth * 2 + 0.1);
      // the middle projects onto the track at the lateral offset the guide says
      const mid = a.add(b).multiplyScalar(0.5);
      const tp = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
      track.project(mid.x, mid.z, tp, -1);
      expect(tp.d).toBeCloseTo(guide.offsetAt(tp.s), 0);
      p.copy(mid);
    }
    expect(p.length()).toBeGreaterThan(0);
  });

  it('has no gap and no jump where the lap closes', () => {
    const l = createDrivingLine(track, source(() => 60), 0);
    l.setMode('full');
    l.show(true);
    l.update(track.length - 30, 60, 1);
    const pos = attr(l, 'position');
    const inf = attr(l, 'aInfo');
    let worst = 0;
    for (let j = 1; j < l.rows; j++) {
      const d = Math.hypot(pos[j * 6] - pos[(j - 1) * 6], pos[j * 6 + 1] - pos[(j - 1) * 6 + 1], pos[j * 6 + 2] - pos[(j - 1) * 6 + 2]);
      worst = Math.max(worst, d);
      // (the distance along the road, for the chevrons, runs on through the line)
      expect(inf[j * 4 + 1]).toBeGreaterThan(inf[(j - 1) * 4 + 1]);
    }
    expect(worst).toBeLessThan(LINE.rowStep + 1.5);
    // the window really does cross the line (it reaches past the lap's length)
    expect(inf[(l.rows - 1) * 4 + 1]).toBeGreaterThan(track.length);
  });

  it('fades in from the car\'s nose and out into the distance: nothing behind it, nothing beyond its range', () => {
    const l = createDrivingLine(track, source(() => 60), 0);
    l.setMode('full');
    l.show(true);
    l.update(1000, 50, 1);
    const a = alphas(l);
    expect(a[0]).toBe(0);
    expect(a[a.length - 1]).toBe(0);
    expect(Math.max(...a)).toBeCloseTo(LINE.alpha, 6);
    const peak = a.indexOf(Math.max(...a));
    // rises to the peak and falls from it
    for (let j = 1; j < peak; j++) expect(a[j]).toBeGreaterThanOrEqual(a[j - 1] - 1e-9);
    expect(a[peak + 5]).toBeGreaterThan(0.5 * LINE.alpha);
    expect(a[a.length - 4]).toBeLessThan(0.1 * LINE.alpha);
  });

  it('leaves the first metres out for a camera that asks for it', () => {
    const l = createDrivingLine(track, source(() => 60), 0);
    l.setMode('full');
    l.show(true);
    // (where along the track the first row that shows is: the window is aimed from the car's nose, or a lead further out)
    const firstShown = (lead: number): number => {
      l.update(1000, 50, 1, lead);
      const a = alphas(l);
      return attr(l, 'aInfo')[a.findIndex((v) => v > 0.05) * 4 + 1];
    };
    const at0 = firstShown(0);
    const at8 = firstShown(8);
    expect(at0).toBeGreaterThan(1000);
    expect(at0).toBeLessThan(1010);
    expect(at8 - at0).toBeGreaterThan(6);
    expect(at8 - at0).toBeLessThan(10);
  });

  it('is drawn narrower when asked to: both edges move in towards the middle of the row', () => {
    const l = createDrivingLine(track, source(() => 60), 0);
    l.setMode('full');
    l.show(true);
    l.update(1000, 50, 1, 0, 1);
    const pos = attr(l, 'position');
    const whole = pos.slice(0, l.rows * 6);
    l.update(1000, 50, 1, 0, 0.5);
    const half = attr(l, 'position').slice(0, l.rows * 6);
    for (let j = 3; j < l.rows - 3; j += 11) {
      const w = (a: Float32Array): number => Math.hypot(a[j * 6] - a[j * 6 + 3], a[j * 6 + 1] - a[j * 6 + 4], a[j * 6 + 2] - a[j * 6 + 5]);
      expect(w(half)).toBeCloseTo(w(whole) * 0.5, 3);
      // (the middle of the row has not moved)
      for (let k = 0; k < 3; k++) expect((half[j * 6 + k] + half[j * 6 + 3 + k]) / 2).toBeCloseTo((whole[j * 6 + k] + whole[j * 6 + 3 + k]) / 2, 3);
    }
  });

  it('is green where the car is no faster than the line, and red where it is far too fast', () => {
    const slow = createDrivingLine(track, source(() => 80), 0);
    slow.setMode('full');
    slow.show(true);
    slow.update(1000, 30, 1);
    const sc = attr(slow, 'aColor');
    for (let j = 8; j < slow.rows - 20; j += 6) expect(green(sc, j * 2)).toBe(true);
    // the line asks 15 m/s at 120 m ahead; the car is doing 70
    const fast = createDrivingLine(track, source((s) => (s > 1120 ? 15 : 90)), 0);
    fast.setMode('full');
    fast.show(true);
    fast.update(1000, 70, 1);
    const fc = attr(fast, 'aColor');
    const at = (metres: number): number => Math.round((metres + 1.5) / LINE.rowStep) * 2;
    // (a row of the window is a row step: the first is a step or two before the car; 130 m ahead is well into the corner)
    expect(fc[at(130) * 4]).toBeGreaterThan(fc[at(130) * 4 + 1] * 5);
    expect(green(fc, at(40))).toBe(true);
  });

  it('shows only the stretches that ask for a lift or the brake in Braking zones', () => {
    const l = createDrivingLine(track, source((s) => (s > 1120 ? 15 : 90)), 0);
    l.setMode('braking');
    l.show(true);
    // slowly: nothing to brake for, nothing to see
    l.update(1000, 20, 1);
    expect(Math.max(...alphas(l))).toBe(0);
    // fast: the stretch the car must brake for is there, and the stretch before it is not
    l.update(1000, 70, 1);
    const a = alphas(l);
    expect(Math.max(...a)).toBeGreaterThan(0.3);
    expect(a[a.findIndex((v) => v > 0)]).toBeGreaterThan(0);
    expect(a.slice(0, 20).every((v) => v === 0)).toBe(true);
  });

  it('is as bright on the screen at night as at noon: its colours are divided by the exposure the grade will multiply them by', () => {
    const day = createDrivingLine(track, source(() => 80), 0);
    const night = createDrivingLine(track, source(() => 80), 0);
    for (const l of [day, night]) {
      l.setMode('full');
      l.show(true);
    }
    day.update(1000, 30, 1);
    night.update(1000, 30, 8);
    const d = attr(day, 'aColor');
    const n = attr(night, 'aColor');
    for (let v = 20; v < 60; v += 8) {
      for (let k = 0; k < 3; k++) expect(n[v * 4 + k] * 8).toBeCloseTo(d[v * 4 + k], 5);
    }
    // and stays under what the bloom picks up (1.6 in the scene before the exposure) at any exposure
    night.update(1000, 70, 0.3);
    const dark = attr(night, 'aColor');
    for (let v = 0; v < night.rows * 2; v++) for (let k = 0; k < 3; k++) expect(dark[v * 4 + k] * 0.3).toBeLessThan(1.6);
  });

  it('moves from the dry racing line to the wet one as the guide says', () => {
    // (the source is read every frame: the blend between the lines is the guide's)
    const src: { lineBlend: number } & LineSource = { ...source(() => 60), lineBlend: 0 };
    const l = createDrivingLine(track, src, 0);
    l.setMode('full');
    l.show(true);
    const rows = (s: number, blend: number): Float32Array => {
      src.lineBlend = blend;
      l.update(s, 40, 1);
      return attr(l, 'position').slice(0, l.rows * 6);
    };
    let moved = 0;
    let between = 0;
    for (const s of [300, 900, 2000, 3100]) {
      const dry = rows(s, 0);
      const half = rows(s, 0.5);
      const wet = rows(s, 1);
      for (let i = 0; i < dry.length; i++) {
        // the wet line keeps the wheels off the kerbs: it is up to half a metre or so from the dry one, never further
        expect(Math.abs(wet[i] - dry[i])).toBeLessThan(1.2);
        if (Math.abs(wet[i] - dry[i]) > 0.1) {
          moved++;
          const lo = Math.min(dry[i], wet[i]) - 1e-4;
          const hi = Math.max(dry[i], wet[i]) + 1e-4;
          if (half[i] >= lo && half[i] <= hi) between++;
        }
      }
    }
    expect(moved).toBeGreaterThan(20);
    expect(between).toBe(moved);
  });
});
