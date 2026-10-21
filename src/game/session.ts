/**
 * Race session: start lights, lap counting, sectors, standings, live delta to the best lap,
 * finish order and results. Headless — it only reads vehicle states and the track.
 */
import { Vector3 } from 'three';
import type { RaceConfig, RaceResultEntry, RaceResults, Seat, SplitDuel, TrackPoint, TrackRuntime, VehicleState } from '../core/contracts';

export interface Entrant {
  id: number; // == VehicleState.id
  name: string;
  color: string;
  carId: string;
  isPlayer: boolean;
  state: VehicleState;
  /** Split screen: which of the two humans this is (0 = player 1). Absent for an opponent, and for the one player of a single-player race. */
  seat?: Seat;
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

/** One human's best lap so far, the reference of the live delta: elapsed time at every TRACE_STEP meters, and the sector splits. */
interface LapRef {
  trace: Float32Array | null;
  sectors: number[] | null;
  /** The lap under way. */
  cur: Float32Array;
}

const _fwd = new Vector3();
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
  /** Each human's best-lap reference (live delta, sector deltas). */
  private readonly refs = new Map<EntrantProgress, LapRef>();
  /** Stored best laps, in seat order (one in a single-player session). */
  private readonly storedBests: (number | null)[];
  readonly unlimited: boolean;
  private finishedCount = 0;
  private now = 0;

  constructor(
    readonly track: TrackRuntime,
    readonly config: RaceConfig,
    entrants: Entrant[],
    /**
     * Stored best lap (s) for the player's track+car — triggers PB detection. In a split-screen session one per human in seat order
     * (each drives a car of their own, with its own record).
     */
    storedBestIn: number | null | readonly (number | null)[],
    /** Random 0..1 used for the lights-out delay. */
    rand: number,
  ) {
    this.storedBests = Array.isArray(storedBestIn) ? [...(storedBestIn as readonly (number | null)[])] : [storedBestIn as number | null];
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
    for (const p of this.progress) {
      if (p.entrant.isPlayer) this.refs.set(p, { trace: null, sectors: null, cur: new Float32Array(Math.ceil(track.length / TRACE_STEP) + 2).fill(-1) });
      this.locate(p, true);
    }
  }

  /** The stored best lap of player 1 (the one player's, in a single-player session). */
  get storedBest(): number | null {
    return this.storedBests[0] ?? null;
  }

  /** The stored best lap of the track and car a seat drives. */
  storedBestFor(seat: Seat): number | null {
    return this.storedBests[seat] ?? null;
  }

  /** The first human: the one player of a single-player session, player 1 of a split-screen one. */
  get player(): EntrantProgress | undefined {
    return this.playerAt(0);
  }

  /** The human in a seat, if there is one (seat 0 also answers for the one player of a single-player session, who has no seat). */
  playerAt(seat: Seat): EntrantProgress | undefined {
    let unseated: EntrantProgress | undefined;
    for (const p of this.progress) {
      if (!p.entrant.isPlayer) continue;
      if (p.entrant.seat === seat) return p;
      if (p.entrant.seat === undefined) unseated ??= p;
    }
    return seat === 0 ? unseated : undefined;
  }

  /** Every human, in seat order. */
  players(): EntrantProgress[] {
    const out: EntrantProgress[] = [];
    const a = this.playerAt(0);
    const b = this.playerAt(1);
    if (a) out.push(a);
    if (b) out.push(b);
    return out;
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
    // wrong way: driving against the track, moving and facing that way (reversing out of a gravel trap is not)
    const vt = st.velocity.x * _tp.tx + st.velocity.z * _tp.tz;
    _fwd.set(0, 0, 1).applyQuaternion(st.quaternion);
    const facing = _fwd.x * _tp.tx + _fwd.z * _tp.tz;
    p.wrongWayTime = vt < -2 && facing < 0 ? p.wrongWayTime + 1 / 60 : 0;
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
        const ref = this.refs.get(p);
        if (p.entrant.isPlayer && ref) {
          const stored = this.storedBestFor(p.entrant.seat ?? 0);
          // the record to beat is the one the race began with, lowered by this human's own laps since: a lap slower than an
          // earlier one of the race is no record, even with none stored (the first race of a car on a track)
          personalBest = best && (stored === null || lap < stored);
          if (best) {
            ref.trace = ref.cur.slice();
            ref.sectors = p.sectorTimes.map((x) => x ?? 0);
          }
          ref.cur.fill(-1);
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
    const sectors = this.refs.get(p)?.sectors;
    if (p.entrant.isPlayer && sectors) delta = t - sectors[k];
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
      // each human's trace for the live delta
      if (p.entrant.isPlayer && p.crossings >= 1) {
        const cur = this.refs.get(p)?.cur;
        const i = Math.floor(p.s / TRACE_STEP);
        if (cur && i >= 0 && i < cur.length && cur[i] < 0) cur[i] = now - p.lapStart;
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

  /** Live delta (s) of a human's current lap against their best lap (player 1's without a seat), or null. */
  liveDelta(seat: Seat = 0): number | null {
    const p = this.playerAt(seat);
    const trace = p ? this.refs.get(p)?.trace : null;
    if (!p || !trace || this.phase !== 'racing' || p.crossings < 1) return null;
    const i = Math.floor(p.s / TRACE_STEP);
    const ref = trace[i];
    if (ref === undefined || ref < 0) return null;
    // interpolate within the step
    const next = trace[i + 1];
    const f = (p.s - i * TRACE_STEP) / TRACE_STEP;
    const r = next !== undefined && next >= 0 ? ref + (next - ref) * f : ref;
    return this.now - p.lapStart - r;
  }

  /** Sector deltas of a human's current lap vs best (null until each sector closes). */
  sectorDeltas(seat: Seat = 0): (number | null)[] {
    const p = this.playerAt(seat);
    const sectors = p ? this.refs.get(p)?.sectors : null;
    if (!p || !sectors) return [null, null, null];
    return p.sectorTimes.map((t, k) => (t === null ? null : t - sectors[k]));
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

  /**
   * The results. `personalBest`: player 1 set a new best lap for the track and car (in a split-screen session one flag per human,
   * in seat order).
   */
  results(personalBest: boolean | readonly [boolean, boolean]): RaceResults {
    const pbs: readonly [boolean, boolean] = typeof personalBest === 'boolean' ? [personalBest, false] : personalBest;
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
      ...(p.entrant.isPlayer && p.entrant.seat !== undefined ? { seat: p.entrant.seat } : {}),
    }));
    const pl = this.player;
    const duel = this.duel(pbs);
    return { config: this.config, entries, playerLapTimes: pl ? pl.lapTimes.slice() : [], personalBest: pbs[0], ...(duel ? { duel } : {}) };
  }

  /** The two humans of a split-screen race against each other (undefined when it is not one). */
  private duel(pbs: readonly [boolean, boolean]): SplitDuel | undefined {
    const a = this.playerAt(0);
    const b = this.playerAt(1);
    if (!a || !b || a.entrant.seat === undefined || b.entrant.seat === undefined) return undefined;
    // a human with no time at all (never classified) loses to one with a time; two of them have no winner
    let winner: Seat | null = null;
    if (a.finishTime !== null && b.finishTime !== null) winner = a.position < b.position ? 0 : 1;
    else if (a.finishTime !== null) winner = 0;
    else if (b.finishTime !== null) winner = 1;
    let gap = '';
    if (winner !== null) {
      const w = winner === 0 ? a : b;
      const l = winner === 0 ? b : a;
      const laps = l.lapsDown - w.lapsDown;
      if (laps >= 1) gap = `+${laps} LAP${laps > 1 ? 'S' : ''}`;
      else if (w.finishTime !== null && l.finishTime !== null) gap = `+${Math.max(0, l.finishTime - w.finishTime).toFixed(3)}`;
    }
    return {
      names: [a.entrant.name, b.entrant.name],
      winner,
      gap,
      positions: [a.position, b.position],
      lapTimes: [a.lapTimes.slice(), b.lapTimes.slice()],
      bestLap: [a.bestLap, b.bestLap],
      personalBest: [pbs[0], pbs[1]],
      carIds: [a.entrant.carId, b.entrant.carId],
    };
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
