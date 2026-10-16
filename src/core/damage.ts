/**
 * Car damage: what a crash leaves on a car. Pure data and arithmetic, no three.js, so the look (src/carvis), the
 * replay recorder (src/game) and a later mechanical phase (src/physics) can all read the same record.
 *
 * The flow:
 *   VehicleState ──ImpactObserver──► DamageEvent (body frame) ──CarDamage.apply──► dents, marks, lamps, zones
 *
 * Everything is a deterministic fold over the ordered events, so a replay can rebuild the damage of any moment from the
 * events it recorded (CarDamage.syncTo). Body frame = the car visual's frame: origin on the ground between the axles,
 * +Z forward, +X left, +Y up.
 *
 * The same hits also feed the mechanical damage (src/core/mechanical.ts: bent suspension, lost downforce, a tired engine): each
 * CarDamage keeps it next to the dents, and the game puts it on the physics only in Settings: Damage, Full.
 *
 * Calibration (tests/damage-probe.test.ts measures it): `strength` is the closing speed along the contact normal in
 * m/s. A 4 degree graze of a barrier at 200 km/h reads 3 m/s, a 25 degree one 23 m/s, head on at 60 km/h 14 m/s and at
 * 200 km/h 56 m/s. The hits between AI cars in a pack race read 1.3 to 3.2 m/s.
 */
import type { CarVisualSpec, DamageMode, VehicleState } from './contracts';
import { MechState, axleShare, hitEnergy } from './mechanical';

export type V3 = [number, number, number];

export type { DamageMode };

export type DamageZone = 'front' | 'rear' | 'left' | 'right';
export const DAMAGE_ZONES: readonly DamageZone[] = ['front', 'rear', 'left', 'right'];

/** Slots the renderer has per car (a fixed uniform array: the shader never changes). */
export const MAX_DENTS = 8;
export const MAX_MARKS = 10;
export const MAX_CRACKS = 4;

export const DAMAGE_TUNING = {
  /** closing speed (m/s) below which an impact is ignored (the physics registers none under 1.0 for cars, 1.2 for walls) */
  hitMin: 1.0,
  /** closing speed that first leaves a dent; under it a hit only scuffs the paint */
  dentMin: 2.6,
  /** deepest crush (m) a single dent can reach, however hard or often it is hit */
  depthMax: 0.32,
  /** depth = depthMax * (1 - exp(-energy / energyRef)), energy = strength^2 summed over the merged hits: 9 m/s reaches 63 % */
  energyRef: 81,
  radiusMin: 0.3,
  radiusMax: 0.95,
  /** radius grows towards radiusMax as 1 - exp(-strength / radiusSpeed) */
  radiusSpeed: 18,
  /** a lamp is cracked (flickers) from this much hit intensity, and broken (dark) from lampDead */
  lampCrack: 4.5,
  lampDead: 8.5,
  /** closing speed from which a hit that reaches a window cracks it (a head-on bump at about 30 km/h) */
  glassCrack: 8,
  /** widest star of cracks (m): a window never shatters whole, it keeps its shape and its tint */
  glassRadiusMax: 0.4,
  /** hits closer than this many mean radii merge into one dent */
  mergeReach: 0.8,
  /** energy at which a zone counts as 63 % wrecked (how a zone looks; the mechanics have their own, gentler scale in src/core/mechanical.ts) */
  zoneEnergy: 120,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

/** One distinct impact, resolved into the car's body frame. */
export interface HitEvent {
  type: 'hit';
  kind: 'wall' | 'car';
  /** closing speed along the contact normal (m/s) */
  strength: number;
  /** contact point on the collision hull */
  p: V3;
  /** push direction: from the obstacle into the car (VehicleState.lastImpact.normal) */
  n: V3;
  /** the car's velocity along the obstacle's surface (m/s) */
  slide: V3;
  /** paint of the other car in a car-to-car contact, 0xRRGGBB */
  paint?: number;
}

/** Hard sliding along an obstacle: the scrape that follows a hit, or a graze too soft to register as one. */
export interface RubEvent {
  type: 'rub';
  kind: 'wall' | 'car';
  p: V3;
  n: V3;
  /** scrape pressure (0..1) times metres slid */
  amount: number;
  slide: V3;
  paint?: number;
}

export type DamageEvent = HitEvent | RubEvent;

/** An event on a replay's timeline: `f` is the replay frame it happened after (fractional: between two frames). */
export interface StampedEvent {
  f: number;
  e: DamageEvent;
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

/** A crumpled patch of bodywork. */
export interface Dent {
  /** centre on the body surface */
  c: V3;
  /** push direction, unit: the way the metal moved, into the car */
  d: V3;
  /** sliding axis in the dent's plane, unit, perpendicular to d */
  t: V3;
  /** radius across the slide (m) */
  r: number;
  /** stretch along the slide (>= 1): a graze leaves a long shallow crease, a head-on hit a round crater */
  e: number;
  /** crush depth (m), never above DAMAGE_TUNING.depthMax */
  depth: number;
  /** summed hit energy that made it */
  energy: number;
  seed: number;
}

/** 0 scuff, 1 scrape (primer, then bare metal), 2 tyre rubber, 3 paint of the other car */
export type MarkKind = 0 | 1 | 2 | 3;

/** A patch of scraped paint: a capsule along the slide direction. */
export interface Mark {
  kind: MarkKind;
  c: V3;
  t: V3;
  /** half length along t, half width across (m) */
  hl: number;
  hw: number;
  /** 0 light scratches, 0.5 down to primer, 1 bare metal */
  wear: number;
  /** transfer paint colour (kind 3), 0xRRGGBB */
  col: number;
  seed: number;
}

export type LampId = 'headL' | 'headR' | 'tailL' | 'tailR';
export const LAMP_IDS: readonly LampId[] = ['headL', 'headR', 'tailL', 'tailR'];

/** A lamp lens on the body, in the body frame. */
export interface LampSpot {
  c: V3;
  r: number;
}

export interface LampDamage {
  /** light output: 1 intact, 0.5 flickers (cracked lens, loose bulb), 0 dark */
  out: number;
  /** 0 clear lens .. 1 shattered */
  crack: number;
  /** where the lens was hit (body frame) */
  hit: V3;
}

export interface ZoneDamage {
  /** hits that landed mostly in this zone */
  hits: number;
  /** 0..1, 63 % = zoneEnergy of hit energy */
  severity: number;
  /** strongest closing speed (m/s) that landed mostly here */
  worst: number;
}

export type ZoneDamageMap = Record<DamageZone, ZoneDamage>;

/** The body of the car as the damage model needs to see it. */
export interface DamageGeometry {
  /** The point on the body surface where an obstacle pressing along -n touches, near `p`. Body frame. */
  surfacePoint(p: V3, n: V3): V3;
  /** headL, headR, tailL, tailR (x > 0 is the left side) */
  lamps: readonly LampSpot[];
  /** The windows a hit at `p` pushing along `d` shakes: the windscreen for a hit from the front, the rear glass from behind, the side glass beside the cabin. */
  glassPoints?(p: V3, d: V3): GlassSpot[];
}

/** A point on a window of the car: where a crash can crack it. */
export interface GlassSpot {
  /** which window: 0 front, 1 rear, 2 left, 3 right */
  id: number;
  c: V3;
  /** the glass's surface normal there, unit */
  n: V3;
}

/** A star of cracks in a window. */
export interface GlassCrack {
  id: number;
  c: V3;
  n: V3;
  /** how far the cracks reach (m) */
  r: number;
  seed: number;
}

export interface Hull {
  hw: number;
  front: number;
  rear: number;
  bottom: number;
  top: number;
  height: number;
  /** centre of mass in the body frame (0, cgH, cgZ) */
  cgH: number;
  cgZ: number;
  /** wheelbase: the axles are at z = +-wb/2 */
  wb: number;
}

/** The physics' collision box (src/cars: hullFromVisual), in the body frame. */
export function hullOf(v: CarVisualSpec): Hull {
  const front = v.wheelbase / 2 + v.frontOverhang;
  const rear = -(v.wheelbase / 2 + (v.length - v.wheelbase - v.frontOverhang));
  return { hw: v.width / 2, front, rear, bottom: v.rideHeight, top: v.height * 0.92, height: v.height, cgH: v.cgHeight, cgZ: v.cgToFrontAxle - v.wheelbase / 2, wb: v.wheelbase };
}

// ─────────────────────────────────────────────────────────────────────────────
// Small vector helpers
// ─────────────────────────────────────────────────────────────────────────────

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3, fallback: V3 = [0, 0, 1]): V3 => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [fallback[0], fallback[1], fallback[2]];
};
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Deterministic 0..1 from a few numbers (stands in for Math.random so a replay rebuilds the same damage). */
export function hash01(a: number, b = 0, c = 0, d = 0): number {
  let h = Math.imul(Math.round(a * 1000) | 0, 374761393) ^ Math.imul(Math.round(b * 1000) | 0, 668265263) ^ Math.imul(Math.round(c * 1000) | 0, 2147483647) ^ Math.imul(d | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

function rotate(q: Quat, v: V3): V3 {
  const tx = 2 * (q.y * v[2] - q.z * v[1]);
  const ty = 2 * (q.z * v[0] - q.x * v[2]);
  const tz = 2 * (q.x * v[1] - q.y * v[0]);
  return [v[0] + q.w * tx + (q.y * tz - q.z * ty), v[1] + q.w * ty + (q.z * tx - q.x * tz), v[2] + q.w * tz + (q.x * ty - q.y * tx)];
}
const rotateInv = (q: Quat, v: V3): V3 => rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);

// ─────────────────────────────────────────────────────────────────────────────
// Calibration
// ─────────────────────────────────────────────────────────────────────────────

/** Crush depth (m) of a dent that took `energy` (strength^2 summed). Saturates: a car never turns into a blob. */
export function depthForEnergy(energy: number): number {
  return DAMAGE_TUNING.depthMax * (1 - Math.exp(-Math.max(energy, 0) / DAMAGE_TUNING.energyRef));
}

/** Radius (m) of the crumpled patch for a hit of this closing speed. */
export function radiusForStrength(strength: number): number {
  const T = DAMAGE_TUNING;
  return T.radiusMin + (T.radiusMax - T.radiusMin) * (1 - Math.exp(-Math.max(strength, 0) / T.radiusSpeed));
}

export interface HitLook {
  /** crush depth of a fresh dent (m); 0 under dentMin */
  depth: number;
  radius: number;
  /** what happens to a lamp the hit lands on */
  lamp: 'intact' | 'cracked' | 'broken';
}

/** What a single hit of `strength` m/s does to a fresh car, dead centre on a lamp. For the calibration table and the tests. */
export function hitLook(strength: number): HitLook {
  const T = DAMAGE_TUNING;
  const lamp = strength >= T.lampDead ? 'broken' : strength >= T.lampCrack ? 'cracked' : 'intact';
  return { depth: strength >= T.dentMin ? depthForEnergy(strength * strength) : 0, radius: radiusForStrength(strength), lamp };
}

// ─────────────────────────────────────────────────────────────────────────────
// Zones
// ─────────────────────────────────────────────────────────────────────────────

/** How a hit at body-frame point p divides over the four zones (sums to 1). A corner hit counts for two zones. */
export function zoneWeights(p: V3, h: Hull): Record<DamageZone, number> {
  const zMid = (h.front + h.rear) / 2;
  const halfL = (h.front - h.rear) / 2;
  const x = p[0] / h.hw;
  const z = (p[2] - zMid) / halfL;
  const w: Record<DamageZone, number> = {
    front: smooth(0.1, 0.8, z),
    rear: smooth(0.1, 0.8, -z),
    left: smooth(0.55, 0.95, x),
    right: smooth(0.55, 0.95, -x),
  };
  let sum = w.front + w.rear + w.left + w.right;
  if (sum < 1e-6) {
    // the middle of the roof or the floor: the nearest edge
    const az = Math.abs(z), ax = Math.abs(x);
    if (az * 0.55 > ax) w[z > 0 ? 'front' : 'rear'] = 1;
    else w[x > 0 ? 'left' : 'right'] = 1;
    sum = 1;
  }
  w.front /= sum;
  w.rear /= sum;
  w.left /= sum;
  w.right /= sum;
  return w;
}

function freshZones(): ZoneDamageMap {
  return {
    front: { hits: 0, severity: 0, worst: 0 },
    rear: { hits: 0, severity: 0, worst: 0 },
    left: { hits: 0, severity: 0, worst: 0 },
    right: { hits: 0, severity: 0, worst: 0 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The model
// ─────────────────────────────────────────────────────────────────────────────

export class CarDamage {
  readonly dents: Dent[] = [];
  readonly marks: Mark[] = [];
  readonly lamps: LampDamage[] = LAMP_IDS.map(() => ({ out: 1, crack: 0, hit: [0, 0, 0] as V3 }));
  /** cracked windows: stars of cracks on the glass (at most MAX_CRACKS) */
  readonly cracks: GlassCrack[] = [];
  readonly zones: ZoneDamageMap = freshZones();
  /**
   * What the hits did to the mechanics: bent suspension, lost downforce, a tired engine (src/core/mechanical.ts). Kept in every
   * mode that records damage; only Settings: Damage, Full puts it on the physics. `mech.version` moves when it changes.
   */
  readonly mech = new MechState();
  /** increments on every change: the renderer refreshes its uniforms when it moves */
  version = 0;
  /** The newest hit: where it landed on the body and what it broke, for the debris thrown off around the car. */
  lastHit: { seq: number; kind: 'wall' | 'car'; strength: number; c: V3; n: V3; lamp: boolean; glass: V3 | null } | null = null;
  /** events applied since the last reset */
  applied = 0;
  private replayList: readonly StampedEvent[] | null = null;
  private replayCursor = 0;

  constructor(
    readonly hull: Hull,
    readonly geom: DamageGeometry,
  ) {}

  /** Back to a pristine car. */
  reset(): void {
    this.dents.length = 0;
    this.marks.length = 0;
    this.cracks.length = 0;
    for (const l of this.lamps) {
      l.out = 1;
      l.crack = 0;
      l.hit = [0, 0, 0];
    }
    const z = freshZones();
    for (const k of DAMAGE_ZONES) Object.assign(this.zones[k], z[k]);
    this.mech.reset();
    this.applied = 0;
    this.lastHit = null;
    this.replayList = null;
    this.replayCursor = 0;
    this.version++;
  }

  /** 0..1 over the whole car: the worst zone, with the others adding a little. */
  get severity(): number {
    const s = DAMAGE_ZONES.map((k) => this.zones[k].severity).sort((a, b) => b - a);
    return clamp(s[0] + 0.25 * (s[1] + s[2] + s[3]), 0, 1);
  }

  /** Nothing to show: no dents, no marks, every lamp intact. */
  get pristine(): boolean {
    return this.dents.length === 0 && this.marks.length === 0 && this.cracks.length === 0 && this.lamps.every((l) => l.out === 1 && l.crack === 0);
  }

  apply(e: DamageEvent): void {
    this.applied++;
    this.version++;
    if (e.type === 'hit') this.applyHit(e);
    else this.applyRub(e);
  }

  /**
   * Replay: show the damage after the events up to `frame` of a recorded timeline. Moving forward applies the new
   * events; moving back (a seek, or the loop at the end) rebuilds from the start, so the result never depends on the
   * path taken to get there.
   */
  syncTo(list: readonly StampedEvent[], frame: number): void {
    const n = countUpTo(list, frame);
    if (list !== this.replayList || n < this.replayCursor) {
      this.reset();
      this.replayList = list;
    }
    while (this.replayCursor < n) this.apply(list[this.replayCursor++].e);
  }

  // ── hits ───────────────────────────────────────────────────────────────────

  private applyHit(e: HitEvent): void {
    const T = DAMAGE_TUNING;
    const s = e.strength;
    if (!(s >= T.hitMin)) return;
    const energy = s * s;

    const w = zoneWeights(e.p, this.hull);
    for (const k of DAMAGE_ZONES) {
      const z = this.zones[k];
      z.severity = 1 - (1 - z.severity) * Math.exp(-(w[k] * energy) / T.zoneEnergy);
      if (w[k] >= 0.25) {
        z.hits++;
        z.worst = Math.max(z.worst, s);
      }
    }
    // the mechanics: only a hit from the dent threshold up counts, shared out over the nose, the tail and the wheels along the flanks
    this.mech.add(hitEnergy(s), w.front, w.rear, w.left, w.right, axleShare(e.p[2], this.hull.wb));

    // push direction: horizontal walls and car sides, so the dent sinks into the car rather than up or down
    const d = unit([e.n[0], e.n[1] * 0.35, e.n[2]], [0, 0, 1]);
    const c = this.geom.surfacePoint(e.p, d);
    const sl = sub(e.slide, [d[0] * dot(e.slide, d), d[1] * dot(e.slide, d), d[2] * dot(e.slide, d)]);
    const slideSpeed = len(sl);
    const t = slideSpeed > 0.5 ? unit(sl) : fallbackTangent(d);

    const radius = radiusForStrength(s);
    if (s >= T.dentMin) {
      const frac = slideSpeed / (slideSpeed + 2.5 * s);
      const elong = 1 + 1.6 * smooth(0.25, 0.9, frac);
      this.addDent(c, d, t, radius, elong, energy);
    }

    // paint: a wall scrapes it away, another car leaves rubber and some of its own colour
    // (a light touch still leaves a mark you can see from the chase camera: a palm-sized smear at the least)
    const wear = clamp(1 - Math.exp(-(0.8 * s + 0.06 * slideSpeed) / 6), 0.25, 0.95);
    const hl = clamp(0.12 + 0.02 * slideSpeed + 0.02 * s, 0.12, 0.35 + 0.07 * s);
    const hwid = clamp(0.06 + 0.008 * s + 0.002 * slideSpeed, 0.06, 0.22);
    const seed = hash01(c[0], c[1], c[2], this.applied);
    if (e.kind === 'wall') {
      this.addMark({ kind: s >= 2.4 || slideSpeed >= 8 ? 1 : 0, c, t, hl, hw: hwid, wear, col: 0, seed });
    } else {
      this.addMark({ kind: 2, c, t, hl: hl * 0.9, hw: hwid * 0.8, wear: clamp(wear * 1.3, 0.55, 1), col: 0, seed });
      if (e.paint !== undefined) this.addMark({ kind: 3, c: shift(c, t, 0.06), t, hl: hl, hw: hwid * 0.9, wear: clamp(wear * 1.4, 0.6, 1), col: e.paint, seed: seed * 0.37 + 0.11 });
      this.addMark({ kind: 0, c, t, hl: hl * 1.2, hw: hwid * 1.4, wear: clamp(wear * 0.9, 0.2, 0.8), col: 0, seed: seed * 0.71 + 0.2 });
    }

    const broke = this.hitLamps(c, s, radius);
    const glass = this.hitGlass(c, d, s);
    this.lastHit = { seq: this.applied, kind: e.kind, strength: s, c, n: d, lamp: broke, glass };
  }

  private applyRub(e: RubEvent): void {
    const amount = e.amount;
    if (!(amount > 0.02)) return;
    const d = unit([e.n[0], e.n[1] * 0.35, e.n[2]], [0, 0, 1]);
    const c = this.geom.surfacePoint(e.p, d);
    const sl = sub(e.slide, [d[0] * dot(e.slide, d), d[1] * dot(e.slide, d), d[2] * dot(e.slide, d)]);
    const t = len(sl) > 0.5 ? unit(sl) : fallbackTangent(d);
    const hl = clamp(0.12 + amount * 0.45, 0.14, 0.9);
    const wear = clamp(0.2 + 0.7 * (1 - Math.exp(-amount / 3)), 0.2, 0.9);
    this.addMark({ kind: 1, c, t, hl, hw: clamp(0.05 + 0.02 * amount, 0.05, 0.16), wear, col: 0, seed: hash01(c[0], c[1], c[2], this.applied) });
    // a hard rub on its own is not a hit: it dulls lamps only through the paint it takes off
  }

  // ── dents ──────────────────────────────────────────────────────────────────

  private addDent(c: V3, d: V3, t: V3, r: number, e: number, energy: number): void {
    const T = DAMAGE_TUNING;
    // merge into a dent already there when the new one lands inside its reach and pushes the same way
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < this.dents.length; i++) {
      const o = this.dents[i];
      const reach = T.mergeReach * 0.5 * (o.r + r);
      const dist = len(sub(o.c, c));
      if (dist < reach && dot(o.d, d) > 0.4 && dist < bestScore) {
        best = i;
        bestScore = dist;
      }
    }
    if (best < 0 && this.dents.length >= MAX_DENTS) {
      // table full: the new hit joins the nearest dent, or replaces the weakest if it is the bigger of the two
      let nearest = 0;
      let nd = Infinity;
      let weakest = 0;
      for (let i = 0; i < this.dents.length; i++) {
        const dist = len(sub(this.dents[i].c, c));
        if (dist < nd) {
          nd = dist;
          nearest = i;
        }
        if (this.dents[i].energy < this.dents[weakest].energy) weakest = i;
      }
      if (energy > this.dents[weakest].energy * 1.5 && nd > 0.5 * r) {
        this.dents[weakest] = this.makeDent(c, d, t, r, e, energy);
        return;
      }
      best = nearest;
    }
    if (best < 0) {
      this.dents.push(this.makeDent(c, d, t, r, e, energy));
      return;
    }
    const o = this.dents[best];
    const total = o.energy + energy;
    const wa = o.energy / total;
    const wb = energy / total;
    const nc: V3 = [o.c[0] * wa + c[0] * wb, o.c[1] * wa + c[1] * wb, o.c[2] * wa + c[2] * wb];
    const nd2 = unit([o.d[0] * wa + d[0] * wb, o.d[1] * wa + d[1] * wb, o.d[2] * wa + d[2] * wb], d);
    const sep = len(sub(o.c, c));
    o.c = this.geom.surfacePoint(nc, nd2);
    o.d = nd2;
    o.t = unit(sub(o.t, [nd2[0] * dot(o.t, nd2), nd2[1] * dot(o.t, nd2), nd2[2] * dot(o.t, nd2)]), t);
    // the patch grows to cover both, a little more each time
    o.r = Math.min(T.radiusMax, Math.max(o.r, r) * 1.04 + 0.35 * sep);
    o.e = Math.min(2.6, Math.max(o.e, e));
    o.energy = total;
    o.depth = depthForEnergy(total);
  }

  private makeDent(c: V3, d: V3, t: V3, r: number, e: number, energy: number): Dent {
    return { c, d, t, r, e, depth: depthForEnergy(energy), energy, seed: hash01(c[0], c[1], c[2], this.applied) };
  }

  // ── paint marks ────────────────────────────────────────────────────────────

  private addMark(m: Mark): void {
    // a mark of the same kind lying along the same line, close enough, grows instead of piling up
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.marks.length; i++) {
      const o = this.marks[i];
      if (o.kind !== m.kind || (m.kind === 3 && o.col !== m.col)) continue;
      if (Math.abs(dot(o.t, m.t)) < 0.8) continue;
      const rel = sub(m.c, o.c);
      const along = Math.abs(dot(rel, o.t));
      const across = len(sub(rel, [o.t[0] * dot(rel, o.t), o.t[1] * dot(rel, o.t), o.t[2] * dot(rel, o.t)]));
      if (across < o.hw + m.hw + 0.05 && along < o.hl + m.hl + 0.08) {
        const dist = len(rel);
        if (dist < bestD) {
          bestD = dist;
          best = i;
        }
      }
    }
    if (best >= 0) {
      const o = this.marks[best];
      // union along the shared axis
      const a0 = Math.min(-o.hl, dot(sub(m.c, o.c), o.t) - m.hl);
      const a1 = Math.max(o.hl, dot(sub(m.c, o.c), o.t) + m.hl);
      const mid = (a0 + a1) / 2;
      o.c = shift(o.c, o.t, mid);
      o.hl = Math.min(1.9, (a1 - a0) / 2);
      o.hw = Math.min(0.45, Math.max(o.hw, m.hw) * 1.04);
      o.wear = Math.min(1, Math.max(o.wear, m.wear) + 0.2 * Math.min(o.wear, m.wear));
      return;
    }
    if (this.marks.length >= MAX_MARKS) {
      // full: join the closest mark, or drop the faintest if the new one is stronger
      let faint = 0;
      let near = 0;
      let nd = Infinity;
      for (let i = 0; i < this.marks.length; i++) {
        if (this.marks[i].wear < this.marks[faint].wear) faint = i;
        const dist = len(sub(this.marks[i].c, m.c));
        if (dist < nd) {
          nd = dist;
          near = i;
        }
      }
      if (m.wear > this.marks[faint].wear) this.marks[faint] = m;
      else {
        const o = this.marks[near];
        o.wear = Math.min(1, o.wear + 0.15 * m.wear);
      }
      return;
    }
    this.marks.push(m);
  }

  // ── lamps ──────────────────────────────────────────────────────────────────

  /** True when the hit cracked or broke a lamp. */
  private hitLamps(c: V3, s: number, radius: number): boolean {
    const T = DAMAGE_TUNING;
    let broke = false;
    for (let i = 0; i < this.geom.lamps.length && i < this.lamps.length; i++) {
      const spot = this.geom.lamps[i];
      const dist = len(sub(c, spot.c));
      const reach = 0.7 * radius + spot.r;
      if (dist >= reach) continue;
      // nearer the lamp is harder on it; a little deterministic scatter so equal hits do not break equal lamps
      const jitter = 0.88 + 0.24 * hash01(c[0], c[2], i, this.applied);
      const intensity = s * (1 - 0.55 * (dist / reach)) * jitter;
      const l = this.lamps[i];
      if (intensity >= T.lampDead) {
        l.out = 0;
        l.crack = 1;
      } else if (intensity >= T.lampCrack) {
        l.out = Math.min(l.out, 0.5);
        l.crack = Math.max(l.crack, clamp(0.3 + (intensity - T.lampCrack) / 6, 0.3, 0.9));
      } else continue;
      broke = true;
      // the crack spreads from where the hit landed, kept on the lens
      const toHit = sub(c, spot.c);
      const k = Math.min(1, spot.r / Math.max(len(toHit), 1e-6));
      l.hit = [spot.c[0] + toHit[0] * k, spot.c[1] + toHit[1] * k, spot.c[2] + toHit[2] * k];
    }
    return broke;
  }

  // ── glass ──────────────────────────────────────────────────────────────────

  /** Where the hit cracked a window (the first of them), or null. A harder hit makes a wider star; a second one nearby grows the star that is there. */
  private hitGlass(c: V3, d: V3, s: number): V3 | null {
    const T = DAMAGE_TUNING;
    if (s < T.glassCrack || !this.geom.glassPoints) return null;
    let cracked: V3 | null = null;
    for (const spot of this.geom.glassPoints(c, d)) {
      const r = crackRadius(s);
      cracked ??= spot.c;
      let near = -1;
      for (let i = 0; i < this.cracks.length; i++) {
        const o = this.cracks[i];
        if (o.id === spot.id && len(sub(o.c, spot.c)) < 0.6 * (o.r + r) + 0.08) near = i;
      }
      if (near >= 0) {
        const o = this.cracks[near];
        o.r = Math.min(T.glassRadiusMax, Math.max(o.r, r) * 1.12 + 0.3 * len(sub(o.c, spot.c)));
        continue;
      }
      const star: GlassCrack = { id: spot.id, c: spot.c, n: spot.n, r, seed: hash01(spot.c[0], spot.c[1], spot.c[2], this.applied) };
      if (this.cracks.length < MAX_CRACKS) this.cracks.push(star);
      else {
        // full: the smallest star gives way to a bigger one
        let small = 0;
        for (let i = 1; i < this.cracks.length; i++) if (this.cracks[i].r < this.cracks[small].r) small = i;
        if (r > this.cracks[small].r) this.cracks[small] = star;
      }
    }
    return cracked;
  }
}

/** How far the cracks of a hit of this closing speed reach on the glass (m). */
export function crackRadius(strength: number): number {
  const T = DAMAGE_TUNING;
  return Math.min(T.glassRadiusMax, 0.09 + 0.31 * (1 - Math.exp(-Math.max(strength - 6, 0) / 10)));
}

function shift(c: V3, t: V3, a: number): V3 {
  return [c[0] + t[0] * a, c[1] + t[1] * a, c[2] + t[2] * a];
}

/** A direction in the surface plane when there is no slide to give one: along the car for sides, across for ends. */
function fallbackTangent(d: V3): V3 {
  const up: V3 = [0, 1, 0];
  const t = cross(up, d);
  return len(t) > 1e-6 ? unit(t) : [1, 0, 0];
}

/** Number of events at or before `frame` (the list is in time order). */
export function countUpTo(list: readonly StampedEvent[], frame: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].f <= frame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ─────────────────────────────────────────────────────────────────────────────
// From VehicleState to events
// ─────────────────────────────────────────────────────────────────────────────

/** Where the physics can say an impact is: the 8 corners and 4 side midpoints of the collision box (src/physics/vehicle.ts). */
export function hullCandidates(h: Hull): V3[] {
  const midY = (h.top + h.bottom) / 2;
  const midZ = (h.front + h.rear) / 2;
  const out: V3[] = [];
  for (const sx of [-1, 1]) for (const y of [h.bottom, h.top]) for (const z of [h.rear, h.front]) out.push([sx * h.hw, y, z]);
  out.push([h.hw, midY, midZ], [-h.hw, midY, midZ], [0, midY, h.front], [0, midY, h.rear]);
  return out;
}

/** Distance from p to the surface of the collision box. */
export function hullSurfaceDistance(p: V3, h: Hull): number {
  const cy = (h.top + h.bottom) / 2;
  const cz = (h.front + h.rear) / 2;
  const qx = Math.abs(p[0]) - h.hw;
  const qy = Math.abs(p[1] - cy) - (h.top - h.bottom) / 2;
  const qz = Math.abs(p[2] - cz) - (h.front - h.rear) / 2;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return Math.abs(outside + Math.min(Math.max(qx, qy, qz), 0));
}

/** What the damage model needs to know of the other car in a car-to-car contact. */
export interface ContactOther {
  /** its body colour, 0xRRGGBB */
  paint: number;
  /** its velocity in the world (m/s): the slide of a contact is the velocity relative to it */
  vx: number;
  vy: number;
  vz: number;
}

const RUB_MIN_SCRAPE = 0.1;
const RUB_STEP = 0.6;
const RUB_FLUSH_S = 0.3;

/**
 * Turns a car's VehicleState into damage events, frame by frame: a new impactCount is a hit, sustained `scrape` is a rub.
 * The physics reports a contact point on the collision box in world space, read a frame (up to ~1 m at racing speed)
 * after it happened; the pose of the previous frame is used to put it back where it landed.
 */
export class ImpactObserver {
  private seen = -1;
  private havePrev = false;
  private pp: V3 = [0, 0, 0];
  private pq: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private rubAmount = 0;
  private rubTime = 0;
  private rubP: V3 | null = null;
  private rubN: V3 = [0, 0, 1];
  private rubSlide: V3 = [0, 0, 0];
  private readonly cands: V3[];
  /** Finds the other car at a world point (in a car-to-car contact). Set by whoever knows the grid. */
  otherAt: ((x: number, y: number, z: number) => ContactOther | undefined) | null = null;

  constructor(readonly hull: Hull) {
    this.cands = hullCandidates(hull);
  }

  /** Forget everything (the car was put back on a fresh grid). */
  reset(): void {
    this.seen = -1;
    this.havePrev = false;
    this.rubAmount = 0;
    this.rubP = null;
  }

  /**
   * Call once per frame with the car's state. Allocation-free while nothing happens: a hit or a scrape builds its event (the
   * rare path).
   */
  update(st: VehicleState, dt: number, emit: (e: DamageEvent) => void): void {
    if (this.seen < 0) this.seen = st.impactCount;
    else if (st.impactCount !== this.seen) {
      this.seen = st.impactCount;
      const li = st.lastImpact;
      if (li.kind !== 'ground' && li.strength >= DAMAGE_TUNING.hitMin) {
        const pos: V3 = [st.position.x, st.position.y, st.position.z];
        const q: Quat = { x: st.quaternion.x, y: st.quaternion.y, z: st.quaternion.z, w: st.quaternion.w };
        // (a snowbank marks a car like a wall does, only its strength is already a third of the closing speed: see Vehicle.resolveBank)
        const kind: 'wall' | 'car' = li.kind === 'car' ? 'car' : 'wall';
        const loc = this.locate(pos, q, [li.point.x, li.point.y, li.point.z], [li.normal.x, li.normal.y, li.normal.z], kind === 'wall');
        const other = kind === 'car' ? this.otherAt?.(li.point.x, li.point.y, li.point.z) : undefined;
        const slide = this.slideOf(st, q, [li.normal.x, li.normal.y, li.normal.z], other);
        const ev: HitEvent = { type: 'hit', kind, strength: li.strength, p: loc.p, n: loc.n, slide };
        if (other) ev.paint = other.paint;
        emit(ev);
      }
    }
    if (this.rubAmount > 0 || (st.scrape > RUB_MIN_SCRAPE && st.speed > 3)) this.rub(st, dt, emit);
    this.pp[0] = st.position.x;
    this.pp[1] = st.position.y;
    this.pp[2] = st.position.z;
    this.pq.x = st.quaternion.x;
    this.pq.y = st.quaternion.y;
    this.pq.z = st.quaternion.z;
    this.pq.w = st.quaternion.w;
    this.havePrev = true;
  }

  /** The car's velocity along the obstacle, relative to the other car if there is one (a wall stands still), in the body frame. */
  private slideOf(st: VehicleState, q: Quat, nWorld: V3, other?: ContactOther): V3 {
    const v: V3 = other ? [st.velocity.x - other.vx, st.velocity.y - other.vy, st.velocity.z - other.vz] : [st.velocity.x, st.velocity.y, st.velocity.z];
    const vn = dot(v, nWorld);
    return rotateInv(q, [v[0] - nWorld[0] * vn, v[1] - nWorld[1] * vn, v[2] - nWorld[2] * vn]);
  }

  private bodyPoint(pos: V3, q: Quat, w: V3): V3 {
    const b = rotateInv(q, sub(w, pos));
    return [b[0], b[1] + this.hull.cgH, b[2] + this.hull.cgZ];
  }

  /** Resolve a world-space contact into the body frame at the pose it most plausibly happened in. */
  private locate(pos: V3, q: Quat, pw: V3, nw: V3, wall: boolean): { p: V3; n: V3 } {
    const steps = this.havePrev ? [1, 0.75, 0.5, 0.25, 0] : [1];
    let bestScore = Infinity;
    let best: { p: V3; n: V3 } = { p: this.bodyPoint(pos, q, pw), n: rotateInv(q, nw) };
    for (const a of steps) {
      const pa: V3 = [this.pp[0] + (pos[0] - this.pp[0]) * a, this.pp[1] + (pos[1] - this.pp[1]) * a, this.pp[2] + (pos[2] - this.pp[2]) * a];
      const qa = a === 1 || !this.havePrev ? q : nlerp(this.pq, q, a);
      const pb = this.bodyPoint(pa, qa, pw);
      const nb = unit(rotateInv(qa, nw));
      if (wall) {
        // a wall is touched by one of the box's corners or side midpoints, on the side facing the wall
        for (const c of this.cands) {
          const facing = -(c[0] * nb[0] + (c[2] - (this.hull.front + this.hull.rear) / 2) * nb[2]);
          if (facing < 0.05) continue;
          const dist = len(sub(c, pb));
          if (dist < bestScore) {
            bestScore = dist;
            best = { p: c, n: nb };
          }
        }
      } else {
        const dist = hullSurfaceDistance(pb, this.hull);
        if (dist < bestScore) {
          bestScore = dist;
          best = { p: pb, n: nb };
        }
      }
    }
    return best;
  }

  // ── rubbing ────────────────────────────────────────────────────────────────

  private rub(st: VehicleState, dt: number, emit: (e: DamageEvent) => void): void {
    const scraping = st.scrape > RUB_MIN_SCRAPE && st.speed > 3;
    if (scraping) {
      const pos: V3 = [st.position.x, st.position.y, st.position.z];
      const q: Quat = { x: st.quaternion.x, y: st.quaternion.y, z: st.quaternion.z, w: st.quaternion.w };
      const sw: V3 = [st.scrapePoint.x, st.scrapePoint.y, st.scrapePoint.z];
      const pb = this.bodyPoint(pos, q, sw);
      // underbody and roof scrapes (ground contacts) are not on a side of the box
      const sideways = Math.abs(pb[0]) > this.hull.hw - 0.2;
      const midZ = (this.hull.front + this.hull.rear) / 2;
      const endwise = Math.abs(pb[2] - midZ) > (this.hull.front - this.hull.rear) / 2 - 0.2;
      if (sideways || endwise) {
        const v: V3 = [st.velocity.x, 0, st.velocity.z];
        const vl = Math.hypot(v[0], v[2]);
        if (vl > 1) {
          // the wall runs along the direction of travel; its normal points from the wall to the car
          let nw: V3 = [-v[2] / vl, 0, v[0] / vl];
          const rel = rotateInv(q, nw);
          const toPoint: V3 = [pb[0], 0, pb[2] - midZ];
          if (rel[0] * toPoint[0] + rel[2] * toPoint[2] > 0) nw = [-nw[0], 0, -nw[2]];
          const nb = unit(rotateInv(q, nw));
          const loc = this.locate(pos, q, sw, nw, true);
          if (this.rubP === null) this.rubP = loc.p;
          else this.rubP = [(this.rubP[0] + loc.p[0]) / 2, (this.rubP[1] + loc.p[1]) / 2, (this.rubP[2] + loc.p[2]) / 2];
          this.rubN = nb;
          this.rubSlide = rotateInv(q, v);
          this.rubAmount += st.scrape * st.speed * dt;
          this.rubTime += dt;
        }
      }
    }
    if (this.rubAmount > 0 && (!scraping || this.rubAmount >= RUB_STEP || this.rubTime >= RUB_FLUSH_S)) {
      if (this.rubP && this.rubAmount > 0.05) {
        emit({ type: 'rub', kind: 'wall', p: this.rubP, n: this.rubN, amount: this.rubAmount, slide: this.rubSlide });
      }
      this.rubAmount = 0;
      this.rubTime = 0;
      this.rubP = null;
    }
  }
}

function nlerp(a: Quat, b: Quat, t: number): Quat {
  const d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = d < 0 ? -1 : 1;
  const x = a.x + (b.x * s - a.x) * t;
  const y = a.y + (b.y * s - a.y) * t;
  const z = a.z + (b.z * s - a.z) * t;
  const w = a.w + (b.w * s - a.w) * t;
  const l = Math.hypot(x, y, z, w) || 1;
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}

// ─────────────────────────────────────────────────────────────────────────────
// What a car visual exposes
// ─────────────────────────────────────────────────────────────────────────────

/** The damage handle of a CarVisual. */
export interface CarDamageControl {
  readonly mode: DamageMode;
  /** the live record: zones, dents, marks, lamps (read-only for everyone but the visual) */
  readonly state: CarDamage;
  setMode(m: DamageMode): void;
  /** Called with every event the car takes in live play (the replay recorder listens). */
  onEvent: ((e: DamageEvent) => void) | null;
  /** The other car at a world point (its paint and velocity), for car-to-car contacts. */
  otherAt: ((x: number, y: number, z: number) => ContactOther | undefined) | null;
  /** Light output right now of headL, headR, tailL, tailR (0..1, flicker included): what the lights and effects around the car follow. */
  readonly lamps: Readonly<Float32Array>;
  /** The car's body colour, 0xRRGGBB (the debris of a hit is painted with it). */
  readonly paint: number;
  /** Put the car back to pristine. */
  repair(): void;
  /** Replay: show the damage of a recorded timeline at `frame` (null leaves replay mode and restores the race's damage). */
  replay(list: readonly StampedEvent[] | null, frame: number): void;
}
