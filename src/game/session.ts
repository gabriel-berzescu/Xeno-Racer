/**
 * Race session: start lights, lap counting, sectors, standings, live delta to the best lap,
 * finish order and results. Headless — it only reads vehicle states and the track.
 */
import type { RaceConfig, RaceResultEntry, RaceResults, TrackPoint, TrackRuntime, VehicleState } from '../core/contracts';

export interface Entrant {
  id: number; // == VehicleState.id
  name: string;
  color: string;
  carId: string;
  isPlayer: boolean;
  state: VehicleState;
}

export interface EntrantProgress {
  entrant: Entrant;
  hint: number;
  s: number;
  d: number;
  /** Line crossings since the start (the grid is behind the line, so the first crossing starts lap 1). */
  crossings: number;
  /**
   * Backward crossings not yet driven back over: the next forward crossing only returns the car to the lap it was on
   * (a reset that drops it just behind the line, a spin or reversing must not complete a lap).
   */
  recross: number;
  /** Continuous race distance (m) — used for positions. */
  distance: number;
  lapStart: number;
  lapTimes: number[];
  bestLap: number | null;
  sector: number;
  sectorStart: number;
  sectorTimes: (number | null)[]; // current lap
  finished: boolean;
  finishTime: number | null;
  position: number;
  wrongWayTime: number;
  /** Classified at the end without crossing the line: finish time projected from race pace. */
  projected: boolean;
  /** Laps behind the winner at the flag (classified cars only). */
  lapsDown: number;
}

export type SessionEvent =
  | { type: 'light'; n: number }
  | { type: 'go' }
  | { type: 'lap'; entrant: Entrant; time: number; best: boolean; personalBest: boolean }
  | { type: 'finalLap'; entrant: Entrant }
  | { type: 'finish'; entrant: Entrant; position: number }
  | { type: 'sector'; entrant: Entrant; sector: number; time: number; delta: number | null };

const _tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };

/** Reference lap for the live delta: elapsed time at every TRACE_STEP meters. */
const TRACE_STEP = 5;

export class RaceSession {
  readonly progress: EntrantProgress[];
  phase: 'grid' | 'countdown' | 'racing' | 'finished' = 'grid';
  /** 0..5 red lights, 6 = lights out, null = hidden. */
  lights: number | null = null;
  /** Simulation time of the GO signal. */
  startTime = 0;
  private countdownT = 0;
  private goAt = 0;
  private readonly events: SessionEvent[] = [];
  /** Best lap reference trace (player) and its sector splits. */
  private refTrace: Float32Array | null = null;
  private refSectors: number[] | null = null;
  private curTrace: Float32Array;
  readonly unlimited: boolean;
  private finishedCount = 0;
  private now = 0;

  constructor(
    readonly track: TrackRuntime,
    readonly config: RaceConfig,
    entrants: Entrant[],
    /** Stored best lap (s) for the player's track+car — triggers PB detection. */
    readonly storedBest: number | null,
    /** Random 0..1 used for the lights-out delay. */
    rand: number,
  ) {
    this.unlimited = config.mode !== 'race';
    this.progress = entrants.map((e) => ({
      entrant: e,
      hint: -1,
      s: 0,
      d: 0,
      crossings: 0,
      recross: 0,
      distance: 0,
      lapStart: 0,
      lapTimes: [],
      bestLap: null,
      sector: 0,
      sectorStart: 0,
      sectorTimes: [null, null, null],
      finished: false,
      finishTime: null,
      position: 1,
      wrongWayTime: 0,
      projected: false,
      lapsDown: 0,
    }));
    this.goAt = 5 + 0.5 + rand * 1.8;
    this.curTrace = new Float32Array(Math.ceil(track.length / TRACE_STEP) + 2).fill(-1);
    for (const p of this.progress) this.locate(p, true);
  }

  get player(): EntrantProgress | undefined {
    return this.progress.find((p) => p.entrant.isPlayer);
  }

  /** Start the light sequence (race mode) or go immediately (time trial / free roam). */
  startCountdown(now: number, withLights: boolean): void {
    this.now = now;
    if (withLights) {
      this.phase = 'countdown';
      this.countdownT = 0;
      this.lights = 0;
    } else {
      this.go(now);
    }
  }

  drainEvents(): SessionEvent[] {
    return this.events.splice(0, this.events.length);
  }

  private go(now: number): void {
    this.phase = 'racing';
    this.startTime = now;
    this.lights = 6;
    for (const p of this.progress) {
      p.lapStart = now;
      p.sectorStart = now;
    }
    this.events.push({ type: 'go' });
  }

  /** Track position update; on the first call the crossing state is initialized. */
  private locate(p: EntrantProgress, init = false): void {
    const st = p.entrant.state;
    const prevS = p.s;
    p.hint = this.track.project(st.position.x, st.position.z, _tp, p.hint);
    p.s = _tp.s;
    p.d = _tp.d;
    const L = this.track.length;
    if (init) {
      // cars on the grid sit just behind the line: count them as "before lap 1"
      p.distance = p.s > L / 2 ? p.s - L : p.s;
      return;
    }
    let ds = p.s - prevS;
    if (ds < -L / 2) {
      ds += L;
      this.onCross(p, +1);
    } else if (ds > L / 2) {
      ds -= L;
      this.onCross(p, -1);
    }
    // wrong way: moving against the tangent
    const vt = st.velocity.x * _tp.tx + st.velocity.z * _tp.tz;
    p.wrongWayTime = vt < -2 ? p.wrongWayTime + 1 / 60 : 0;
    p.distance = (p.crossings - 1) * L + p.s;
  }

  private onCross(p: EntrantProgress, dir: 1 | -1): void {
    if (dir < 0) {
      p.crossings--;
      p.recross++;
      return;
    }
    p.crossings++;
    if (p.recross > 0) {
      // back over the line it reversed across: still the same lap, timed from where it really began
      p.recross--;
      return;
    }
    if (this.phase !== 'racing' || p.finished) return;
    const now = this.now;
    if (p.crossings >= 2) {
      const lap = now - p.lapStart;
      // a lap must be at least a third of the track at 400 km/h — guards against line-dancing
      if (lap > this.track.length / 111 / 3) {
        p.lapTimes.push(lap);
        const best = p.bestLap === null || lap < p.bestLap;
        if (best) p.bestLap = lap;
        // sector 3 closes on the line
        if (p.sector === 2) this.closeSector(p, 2, now);
        let personalBest = false;
        if (p.entrant.isPlayer) {
          personalBest = this.storedBest === null || lap < this.storedBest;
          if (best) {
            this.refTrace = this.curTrace.slice();
            this.refSectors = p.sectorTimes.map((x) => x ?? 0);
          }
          this.curTrace.fill(-1);
        }
        this.events.push({ type: 'lap', entrant: p.entrant, time: lap, best, personalBest });
      }
    }
    // In a race lap 1 is timed from lights-out (the grid sits behind the line); otherwise the
    // first crossing of a rolling start begins the lap.
    const keepStart = p.crossings === 1 && this.config.mode === 'race';
    if (!keepStart) {
      p.lapStart = now;
      p.sectorStart = now;
    }
    p.sector = 0;
    p.sectorTimes = [null, null, null];
    if (!this.unlimited) {
      const total = this.config.laps;
      if (p.crossings === total) this.events.push({ type: 'finalLap', entrant: p.entrant });
      if (p.crossings > total) {
        p.finished = true;
        p.finishTime = now - this.startTime;
        this.finishedCount++;
        this.events.push({ type: 'finish', entrant: p.entrant, position: this.finishedCount });
        if (this.finishedCount === this.progress.length) this.phase = 'finished';
      }
    }
  }

  private closeSector(p: EntrantProgress, k: number, now: number): void {
    const t = now - p.sectorStart;
    p.sectorTimes[k] = t;
    p.sectorStart = now;
    let delta: number | null = null;
    if (p.entrant.isPlayer && this.refSectors) delta = t - this.refSectors[k];
    this.events.push({ type: 'sector', entrant: p.entrant, sector: k, time: t, delta });
  }

  update(dt: number, now: number): void {
    this.now = now;
    if (this.phase === 'countdown') {
      this.countdownT += dt;
      const n = Math.min(5, Math.floor(this.countdownT));
      if (n !== this.lights && this.countdownT < this.goAt) {
        this.lights = n;
        if (n > 0) this.events.push({ type: 'light', n });
      }
      if (this.countdownT >= this.goAt) this.go(now);
    }
    for (const p of this.progress) {
      this.locate(p);
      if (this.phase !== 'racing' || p.finished) continue;
      // sectors
      const [s1, s2] = this.track.sectors;
      if (p.crossings >= 1) {
        if (p.sector === 0 && p.s >= s1 && p.s < s2) {
          this.closeSector(p, 0, now);
          p.sector = 1;
        } else if (p.sector === 1 && p.s >= s2) {
          this.closeSector(p, 1, now);
          p.sector = 2;
        }
      }
      // player trace for the live delta
      if (p.entrant.isPlayer && p.crossings >= 1) {
        const i = Math.floor(p.s / TRACE_STEP);
        if (i >= 0 && i < this.curTrace.length && this.curTrace[i] < 0) this.curTrace[i] = now - p.lapStart;
      }
    }
    this.rank();
  }

  /** Positions: finished cars by laps down then finish time, then the rest by distance. */
  private rank(): void {
    const order = this.progress.slice().sort((a, b) => {
      if (a.finished && b.finished) return a.lapsDown - b.lapsDown || (a.finishTime ?? 0) - (b.finishTime ?? 0);
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.distance - a.distance;
    });
    order.forEach((p, i) => (p.position = i + 1));
  }

  /** Live delta (s) of the player's current lap against their best lap, or null. */
  liveDelta(): number | null {
    const p = this.player;
    if (!p || !this.refTrace || this.phase !== 'racing' || p.crossings < 1) return null;
    const i = Math.floor(p.s / TRACE_STEP);
    const ref = this.refTrace[i];
    if (ref === undefined || ref < 0) return null;
    // interpolate within the step
    const next = this.refTrace[i + 1];
    const f = (p.s - i * TRACE_STEP) / TRACE_STEP;
    const r = next !== undefined && next >= 0 ? ref + (next - ref) * f : ref;
    return this.now - p.lapStart - r;
  }

  /** Sector deltas of the player's current lap vs best (null until each sector closes). */
  sectorDeltas(): (number | null)[] {
    const p = this.player;
    if (!p || !this.refSectors) return [null, null, null];
    return p.sectorTimes.map((t, k) => (t === null ? null : t - this.refSectors![k]));
  }

  /** Ordered standings. */
  ordered(): EntrantProgress[] {
    return this.progress.slice().sort((a, b) => a.position - b.position);
  }

  /** Gap of `p` to the car ahead/leader as a display string. */
  gapString(p: EntrantProgress, leader: EntrantProgress): string {
    if (p === leader) return 'LEADER';
    if (p.finished && leader.finished && p.finishTime !== null && leader.finishTime !== null) return `+${(p.finishTime - leader.finishTime).toFixed(3)}`;
    const laps = Math.floor((leader.distance - p.distance) / this.track.length);
    if (laps >= 1) return `+${laps}L`;
    // estimate time gap from distance and the leader's average speed
    const elapsed = Math.max(1, this.now - this.startTime);
    const avg = Math.max(10, leader.distance / elapsed);
    return `+${((leader.distance - p.distance) / avg).toFixed(1)}`;
  }

  results(personalBest: boolean): RaceResults {
    const order = this.ordered();
    const leader = order[0];
    const entries: RaceResultEntry[] = order.map((p) => ({
      position: p.position,
      name: p.entrant.name,
      carId: p.entrant.carId,
      isPlayer: p.entrant.isPlayer,
      totalTime: p.finishTime,
      bestLap: p.bestLap,
      gap: p === leader ? 'WINNER' : p.lapsDown > 0 ? `+${p.lapsDown} LAP${p.lapsDown > 1 ? 'S' : ''}` : p.finished ? this.gapString(p, leader) : 'DNF',
      laps: p.projected ? this.config.laps - p.lapsDown : Math.max(0, p.crossings - 1),
    }));
    const pl = this.player;
    return { config: this.config, entries, playerLapTimes: pl ? pl.lapTimes.slice() : [], personalBest };
  }

  /**
   * End of the race for cars still running: classify them the way a timing system would — a car
   * on its final lap gets the finish time its race pace projects to the line, a car further back
   * is classified laps down.
   */
  closeRace(): void {
    const L = this.track.length;
    const elapsed = Math.max(1, this.now - this.startTime);
    for (const p of this.progress) {
      if (p.finished) continue;
      p.finished = true;
      p.projected = true;
      p.lapsDown = this.unlimited ? 0 : Math.max(0, this.config.laps - p.crossings);
      const avg = Math.max(5, p.distance / elapsed);
      const toLine = Math.max(0, p.crossings * L - p.distance);
      p.finishTime = elapsed + toLine / avg;
    }
    this.phase = 'finished';
    this.rank();
  }
}
