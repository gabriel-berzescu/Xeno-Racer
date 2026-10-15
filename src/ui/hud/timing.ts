/**
 * Top-left position / lap block and the top-right timing panel (lap timer, last, best, live delta with a
 * centered bar, three sector cells).
 */
import type { HudState } from '../../core/contracts';
import { Bar, ClassSlot, h, Txt } from '../dom';
import { formatDelta, formatLapTime } from '../format';
import { deltaBar, deltaClass, sectorState, type SectorState } from '../hudlogic';

const SEC_CLASS: Record<SectorState, string> = {
  pending: 'sec pending', active: 'sec active', good: 'sec good', bad: 'sec bad', even: 'sec even', set: 'sec set',
};

export class PosLap {
  readonly el: HTMLElement;
  private readonly posBlock: HTMLElement;
  private readonly pos: Txt;
  private readonly posOf: Txt;
  private readonly lapBlock: HTMLElement;
  private readonly lap: Txt;
  private readonly lapOf: Txt;
  private readonly lapOfEl: HTMLElement;
  private lastPos = -1;
  private lastLap = -1;
  private lastTotal = -1;
  private flip = 0;
  private lastMode = '';
  /** "ROUND 2/4": hangs off the right of the block during a championship round. */
  private readonly roundBlock: HTMLElement;
  private readonly roundTxt: Txt;
  private readonly roundOfTxt: Txt;
  private lastRound = -1;
  private lastRounds = -1;

  constructor(parent: HTMLElement) {
    const posN = h('span', 'pl-n');
    const posOf = h('span', 'pl-of');
    const lapN = h('span', 'pl-n');
    this.lapOfEl = h('span', 'pl-of');
    this.posBlock = h('div', 'pl-pos', h('span', 'k', 'POSITION'), h('div', 'pl-val', h('span', 'pl-p', 'P'), posN, posOf));
    this.lapBlock = h('div', 'pl-lap', h('span', 'k', 'LAP'), h('div', 'pl-val', lapN, this.lapOfEl));
    this.pos = new Txt(posN, '1');
    this.posOf = new Txt(posOf, '/1');
    this.lap = new Txt(lapN, '1');
    this.lapOf = new Txt(this.lapOfEl, '');
    const roundN = h('span', 'pl-n');
    const roundOf = h('span', 'pl-of');
    this.roundBlock = h('div', 'pl-round', h('span', 'k', 'ROUND'), h('div', 'pl-val', roundN, roundOf));
    this.roundBlock.style.display = 'none';
    this.roundTxt = new Txt(roundN, '');
    this.roundOfTxt = new Txt(roundOf, '');
    this.el = h('div', 'hud-poslap', this.posBlock, this.lapBlock, this.roundBlock);
    parent.appendChild(this.el);
  }

  update(s: HudState): void {
    if (s.mode !== this.lastMode) {
      this.lastMode = s.mode;
      this.posBlock.style.display = s.mode === 'race' ? '' : 'none';
      this.el.classList.toggle('solo', s.mode !== 'race');
    }
    if (s.position !== this.lastPos) {
      const gained = this.lastPos > 0 && s.position < this.lastPos;
      const lost = this.lastPos > 0 && s.position > this.lastPos;
      this.lastPos = s.position;
      this.pos.set(String(s.position));
      this.posOf.set('/' + s.totalCars);
      if (gained || lost) {
        // alternate between two identical animations so it restarts without forcing a reflow
        this.flip ^= 1;
        this.posBlock.setAttribute('data-flash', (gained ? 'up' : 'down') + this.flip);
      }
    }
    if (s.lap !== this.lastLap) {
      this.lastLap = s.lap;
      this.lap.set(String(s.lap));
    }
    if (s.totalLaps !== this.lastTotal) {
      this.lastTotal = s.totalLaps;
      this.lapOf.set(s.totalLaps > 0 ? '/' + s.totalLaps : '');
    }
    const ch = s.championship;
    const round = ch ? ch.round : 0;
    const rounds = ch ? ch.rounds : 0;
    if (round !== this.lastRound || rounds !== this.lastRounds) {
      this.lastRound = round;
      this.lastRounds = rounds;
      this.roundBlock.style.display = ch ? '' : 'none';
      this.roundTxt.set(ch ? String(round) : '');
      this.roundOfTxt.set(ch ? '/' + rounds : '');
    }
  }
}

export class TimingPanel {
  readonly el: HTMLElement;
  private readonly lapTime: Txt;
  private readonly last: Txt;
  private readonly best: Txt;
  private readonly delta: Txt;
  private readonly deltaEl = h('span', 'dv');
  private readonly deltaCls: ClassSlot;
  private readonly neg: Bar;
  private readonly pos: Bar;
  private readonly secs: { cls: ClassSlot; txt: Txt; st: SectorState | ''; d: number }[] = [];
  private lastLap = -9;
  private lastLast: number | null | undefined = undefined;
  private lastBest: number | null | undefined = undefined;
  private lastDelta = -999;
  private lastDeltaNull = false;
  private readonly lapEl = h('span', 'tm-lapv');

  constructor(parent: HTMLElement) {
    const lastV = h('span', 'v');
    const bestV = h('span', 'v');
    const negFill = h('i', 'neg');
    const posFill = h('i', 'pos');
    this.neg = new Bar(negFill, 'X', 0.01);
    this.pos = new Bar(posFill, 'X', 0.01);
    this.lapTime = new Txt(this.lapEl, '0:00.000');
    this.last = new Txt(lastV, '-:--.---');
    this.best = new Txt(bestV, '-:--.---');
    this.delta = new Txt(this.deltaEl, '-.---');
    this.deltaCls = new ClassSlot(this.deltaEl);
    const secs = h('div', 'tm-sectors');
    for (let i = 0; i < 3; i++) {
      const v = h('span', 'sv');
      const cell = h('div', 'sec', h('span', 'sk', 'S' + (i + 1)), v);
      secs.appendChild(cell);
      this.secs.push({ cls: new ClassSlot(cell), txt: new Txt(v, ''), st: '', d: -1e9 });
    }
    this.el = h(
      'div',
      'hud-timing',
      h('div', 'tm-lap', h('span', 'k', 'LAP TIME'), this.lapEl),
      h('div', 'tm-row', h('div', 'tm-cell', h('span', 'k', 'LAST'), lastV), h('div', 'tm-cell best', h('span', 'k', 'BEST'), bestV)),
      h('div', 'tm-delta', h('span', 'k', 'DELTA'), h('div', 'dbar', negFill, posFill, h('b')), this.deltaEl),
      secs,
    );
    parent.appendChild(this.el);
  }

  update(s: HudState): void {
    // the running lap time changes every frame: compare at ms resolution before building the string
    const ms = Math.round(s.lapTime * 1000);
    if (ms !== this.lastLap) {
      this.lastLap = ms;
      this.lapTime.set(formatLapTime(s.lapTime));
    }
    if (s.lastLap !== this.lastLast) {
      this.lastLast = s.lastLap;
      this.last.set(formatLapTime(s.lastLap));
    }
    if (s.bestLap !== this.lastBest) {
      this.lastBest = s.bestLap;
      this.best.set(formatLapTime(s.bestLap));
    }

    const d = s.delta;
    const isNull = d === null;
    const dq = isNull ? 0 : Math.round(d * 1000);
    if (isNull !== this.lastDeltaNull || dq !== this.lastDelta) {
      this.lastDeltaNull = isNull;
      this.lastDelta = dq;
      this.delta.set(formatDelta(d));
      const bar = deltaBar(d);
      this.neg.set(bar < 0 ? -bar : 0);
      this.pos.set(bar > 0 ? bar : 0);
      this.deltaCls.set('dv ' + deltaClass(d));
    }

    for (let i = 0; i < 3; i++) {
      const st = sectorState(i, s.sector, s.sectorDeltas);
      const cell = this.secs[i];
      const sd = s.sectorDeltas[i];
      const dq = sd === null || sd === undefined ? -1e9 : Math.round(sd * 1000);
      if (st === cell.st && dq === cell.d) continue;
      cell.st = st;
      cell.d = dq;
      cell.cls.set(SEC_CLASS[st]);
      cell.txt.set(st === 'pending' || st === 'active' || sd === null || sd === undefined ? '' : formatDelta(sd).replace(/0$/, ''));
    }
  }
}
