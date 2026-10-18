/**
 * Monophonic note tracking shared by the bass instruments: held-note stack (last note priority), slides (legato glide without
 * retriggering) and per-segment glide. Pure bookkeeping, no audio.
 */
import { FLAG } from '../instrument';

export class MonoTracker {
  /** Pitch currently targeted (MIDI). */
  note = 60;
  /** Pitch being rendered (glides towards `note`). */
  slideNote = 60;
  gate = false;
  /** The voice is sounding (gate on, or releasing). The instrument clears it when its envelope has ended. */
  active = false;
  vel = 1;
  /** Per-segment glide coefficient (1 = jump). */
  private glideK = 1;
  private readonly held: number[] = [];
  /** Counts samples since the last (re)trigger. */
  age = 0;
  constructor(private readonly sr: number) {}

  /**
   * Registers a note. `glide` is the portamento time (s) the instrument has set for plain legato playing; a slide-flagged note
   * glides for at least `slideTime`. Returns true when the envelopes should restart.
   */
  noteOn(note: number, vel: number, flags: number, glide: number, slideTime: number): boolean {
    const slide = (flags & FLAG.SLIDE) !== 0;
    if (slide) this.held.length = 0;
    const legato = slide && this.gate;
    this.held.push(note);
    if (this.held.length > 16) this.held.shift();
    this.vel = vel;
    this.note = note;
    this.gate = true;
    if (!this.active) {
      this.slideNote = note;
      this.glideK = 1;
    } else {
      const t = slide ? Math.max(glide, slideTime) : glide;
      if (t > 0 && (slide || glide > 0)) this.glideK = 1 - Math.exp(-1 / (Math.max(t, 0.003) * this.sr * 0.3));
      else {
        this.slideNote = note;
        this.glideK = 1;
      }
    }
    this.active = true;
    if (!legato) this.age = 0;
    return !legato;
  }

  /** Returns 'release' when the gate closes, 'fallback' when an older held key takes over, 'none' otherwise. */
  noteOff(note: number): 'release' | 'fallback' | 'none' {
    const i = this.held.lastIndexOf(note);
    if (i >= 0) this.held.splice(i, 1);
    if (!this.gate || note !== this.note) return 'none';
    if (this.held.length > 0) {
      this.note = this.held[this.held.length - 1];
      this.glideK = 1 - Math.exp(-1 / (0.02 * this.sr * 0.3));
      return 'fallback';
    }
    this.gate = false;
    return 'release';
  }

  /** Advances the glide by n samples. */
  advance(n: number): void {
    this.age += n;
    if (this.glideK < 1) {
      const k = 1 - Math.pow(1 - this.glideK, n);
      this.slideNote += (this.note - this.slideNote) * k;
      if (Math.abs(this.note - this.slideNote) < 1e-4) {
        this.slideNote = this.note;
        this.glideK = 1;
      }
    } else this.slideNote = this.note;
  }
}
