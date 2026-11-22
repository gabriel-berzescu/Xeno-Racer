/**
 * The Taccola against its brief, in numbers, beside the Vanta GT and the LMP-X it stands between: the standing start to 300 km/h and the
 * top speed with the wing working and fixed up, the grip at speed, the stops, the wet, cold tyres, loose ground, how it slides and is
 * caught, the wing coming up at speed, and the AI's laps with the tyres' temperatures. Prints a table per section and writes
 * .cache/taccola-probe.txt.
 *
 *   TACCOLA=drag,grip,brake,wet,cold,loose,slide,winter,wing,lap,temps  npx vitest run tests/probes/taccola-probe.test.ts --disable-console-intercept
 *   TACCOLA=all CAR=taccola,vanta-gt,lmp-x TRACKS=aurelia,kuroyama
 *
 * A change can be tried without editing the car: TAC names variants of the Taccola, each a list of paths into its definition,
 *   TAC="base|lowcg:physics.chassis.cgHeight=0.38|soft:physics.suspRear.antiRoll=20000,physics.suspFront.antiRoll=50000"
 * or TAC=@.cache/variants.txt, a file with a variant on each line (a line `*:pairs` is common to the lines after it)
 * (`base` is the car as it is; a list is written with semicolons, `physics.drivetrain.gears=[3;2;1.5]`; `tireFront.x` and `tireRear.x` may be written `tire.x` for both, `suspFront`/`suspRear` as `susp.x`).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { getCar } from '../../src/cars';
import type { Assists, CarDefinition } from '../../src/core/contracts';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { SteeringFilter } from '../../src/physics';
import { STRAIGHT_MODE_SPEED } from '../../src/physics/aero';
import { TRACKS } from '../../src/track';
import { DT, brakeRun, dragRun, freeRoll, gripAtSpeed, launch, setup, skidpad } from './car-metrics';
import { AI_AIDS, BARE, STANDARD, atSpeed, bend, bodySlip, drive, latAt, lapOf, liftOff, powerSlide, standingStart, stopFrom, wingUp } from './taccola-drives';

const SECTIONS = (process.env.TACCOLA ?? '').split(',').filter(Boolean);
const on = (s: string) => SECTIONS.includes('all') || SECTIONS.includes(s);
const f = (x: number | null, d = 2) => (x === null || !Number.isFinite(x) ? '  -  ' : x.toFixed(d));

/** A variant of a car: `path=value` pairs written into a copy of its definition. */
function variant(base: CarDefinition, spec: string): CarDefinition {
  const d = structuredClone(base);
  for (const pair of spec.split(',').filter(Boolean)) {
    const [path, raw] = pair.split('=');
    const value: unknown = raw.startsWith('[') ? JSON.parse(raw.replace(/;/g, ',')) : raw === 'null' ? null : raw === 'undefined' ? undefined : Number(raw);
    const paths = path.startsWith('physics.tire.') ? ['tireFront', 'tireRear'].map((t) => path.replace('physics.tire.', `physics.${t}.`)) : path.startsWith('physics.susp.') ? ['suspFront', 'suspRear'].map((t) => path.replace('physics.susp.', `physics.${t}.`)) : [path];
    for (const p of paths) {
      const keys = p.split('.');
      let o = d as unknown as Record<string, unknown>;
      for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
      const last = keys[keys.length - 1];
      if (value === undefined) delete o[last];
      else o[last] = value;
    }
  }
  return d;
}

/** The variants TAC names: the list itself, or with `@file` the lines of a file (a line `*:pairs` is put in front of every line after it; # starts a comment). */
function variantSpecs(tac: string): string[] {
  if (!tac.startsWith('@')) return tac.split('|');
  let common = '';
  const specs: string[] = [];
  const lines = readFileSync(tac.slice(1), 'utf8').split('\n').map((l) => l.replace(/#.*/, '').replace(/\s+/g, ''));
  for (const line of lines.filter(Boolean)) {
    if (line.startsWith('*:')) common = line.slice(2);
    else if (line === 'base' || !line.includes(':')) specs.push(line);
    else specs.push(`${line.slice(0, line.indexOf(':'))}:${[common, line.slice(line.indexOf(':') + 1)].filter(Boolean).join(',')}`);
  }
  return specs;
}

const names: string[] = [];
const cars: CarDefinition[] = [];
for (const id of (process.env.CAR ?? 'taccola,vanta-gt,lmp-x').split(',')) {
  const def = getCar(id);
  if (id === 'taccola' && process.env.TAC) {
    for (const v of variantSpecs(process.env.TAC)) {
      const [name, spec] = v.includes(':') ? [v.slice(0, v.indexOf(':')), v.slice(v.indexOf(':') + 1)] : [v, ''];
      names.push(name);
      cars.push(name === 'base' ? def : variant(def, spec));
    }
  } else {
    names.push(id);
    cars.push(def);
  }
}
const label = (i: number) => names[i].slice(0, 10).padEnd(10);

describe.skipIf(SECTIONS.length === 0)('Taccola probe', () => {
  it('measures', () => {
    const out: string[] = [];
    const say = (s: string) => {
      out.push(s);
      console.log(s);
    };
    if (on('drag')) {
      say('── standing start (the AI\'s aids): 0-100 / 200 / 300 km/h, from the idle and from a grid start; the top speed, with an active wing fixed up too ──');
      cars.forEach((c, i) => {
        const d = standingStart(c);
        const g = standingStart(c, true, 0, 16);
        const off = dragRun(c, 8, {}, 'off');
        let fixed = '';
        if (c.physics.aero.straightMode) {
          const up = variant(c, 'physics.aero.straightMode=undefined');
          fixed = ` | wing fixed up ${standingStart(up).vmax.toFixed(1)}`;
        }
        say(`${label(i)} 0-100 ${f(d.t100)} 0-200 ${f(d.t200)} 0-300 ${f(d.t300)} (grid ${f(g.t100)} ${f(g.t200)} ${f(g.t300)}; TCS off ${f(off.t100)}) burst ${d.burst.toFixed(2)} s | vmax ${d.vmax.toFixed(1)} km/h in ${d.gear} at ${d.rpm.toFixed(0)} rpm${fixed}`);
      });
    }
    if (on('launchlog')) {
      cars.forEach((c, i) => {
        say(`── launch log ${label(i)} ──`);
        const { world, car } = setup(c, {}, 0, { ...AI_AIDS });
        world.simulate(1);
        car.controls.throttle = 1;
        for (let k = 0; k < 60 * 5; k++) {
          world.step(DT);
          if (k % 6 === 0) {
            const s = car.state;
            const w = s.wheels;
            say(`t=${(k / 60).toFixed(2)} v=${(s.forwardSpeed * 3.6).toFixed(0).padStart(3)} g${s.gear} ${s.rpm.toFixed(0).padStart(5)}rpm thr=${s.throttle.toFixed(2)} clutch=${s.clutch.toFixed(2)} Frear=${((w[2].forceLong + w[3].forceLong) / 1000).toFixed(1).padStart(5)} k=${w[2].slipRatio.toFixed(2)}/${w[3].slipRatio.toFixed(2)} load=${w.map((x) => (x.load / 1000).toFixed(1)).join('/')} ax=${(s.localAccel.z / 9.81).toFixed(2)}g`);
          }
        }
      });
    }
    if (on('grip')) {
      say('── the skidpad (R60: g, km/h, front minus rear slip angle) and the lateral g held at a steady speed, no aids ──');
      cars.forEach((c, i) => {
        const p = skidpad(c);
        const cells = [60, 120, 150, 200, 250, 300].map((kmh) => `${kmh}: ${f(latAt(c, kmh), 3)}`);
        say(`${label(i)} pad ${p.latG.toFixed(3)} g @ ${p.speedKmh.toFixed(0)} bal ${p.balanceDeg.toFixed(2)} roll ${p.rollDeg.toFixed(1)} minload ${(p.minLoadShare * 100).toFixed(0)}% | ${cells.join('  ')} | gripAtSpeed 60 ${gripAtSpeed(c, 60).latG.toFixed(3)} 120 ${gripAtSpeed(c, 120).latG.toFixed(3)}`);
      });
    }
    if (on('brake')) {
      say('── stops with ABS: 100-0 and 200-0 (m), from 300 km/h after a second flat out (peak g, the most body slip, the drift off the line), the same with the Standard aids ──');
      cars.forEach((c, i) => {
        const b1 = brakeRun(c, true, {}, 100);
        const b2 = brakeRun(c, true, {}, 200);
        const lock = brakeRun(c, false, {}, 100);
        const s3 = stopFrom(c, 300);
        const s3s = stopFrom(c, 300, STANDARD);
        say(`${label(i)} 100-0 ${b1.distance.toFixed(1)} m (locked ${lock.distance.toFixed(1)}) 200-0 ${b2.distance.toFixed(1)} m | from 300: peak ${s3.peakG.toFixed(2)} g, ${s3.distance.toFixed(0)} m, slip ${s3.slipDeg.toFixed(1)} deg, drift ${s3.drift.toFixed(2)} m | Standard: ${s3s.peakG.toFixed(2)} g slip ${s3s.slipDeg.toFixed(1)} drift ${s3s.drift.toFixed(2)}`);
      });
    }
    if (on('wet')) {
      say('── the wet (0.75) and standing water (1): skidpad and its share of the dry, 100-0, lateral g at 120 / 200 km/h ──');
      cars.forEach((c, i) => {
        const dry = skidpad(c).latG;
        const cells = [0.75, 1].map((wetness) => {
          const p = skidpad(c, 60, { wetness });
          const b = brakeRun(c, true, { wetness }, 100);
          return `wet ${wetness}: pad ${p.latG.toFixed(3)} (${((p.latG / dry) * 100).toFixed(0)} %) 100-0 ${b.distance.toFixed(1)} m lat60 ${f(latAt(c, 60, { wetness }), 3)} lat120 ${f(latAt(c, 120, { wetness }), 3)} lat200 ${f(latAt(c, 200, { wetness }), 3)} lat250 ${f(latAt(c, 250, { wetness }), 3)}`;
        });
        say(`${label(i)} ${cells.join(' | ')}`);
      });
    }
    if (on('cold')) {
      say('── cold tyres (at the air\'s 24 C): lateral g at 100 km/h cold and warm, 100-0 cold, and the tread temperatures after 30 and 60 s of a skidpad ──');
      cars.forEach((c, i) => {
        const warm = latAt(c, 100);
        const cold = latAt(c, 100, {}, 0);
        const { world, car } = setup(c, {}, 100 / 3.6, { ...AI_AIDS });
        car.setTemperatures(0);
        car.controls.brake = 1;
        const z0 = car.p.z;
        while (car.state.forwardSpeed > 0.3) world.step(DT);
        say(`${label(i)} warm ${warm.toFixed(3)} g cold ${cold.toFixed(3)} g (${((cold / warm) * 100).toFixed(0)} %) | 100-0 cold ${(car.p.z - z0).toFixed(1)} m (warm ${brakeRun(c, true).distance.toFixed(1)}) | coldGrip ${c.physics.tireFront.coldGrip} window ${c.physics.tireFront.optimalTemp}±${c.physics.tireFront.tempWindow}`);
      });
    }
    if (on('loose')) {
      say('── loose ground: lateral g at 60 / 120 km/h, the stop from 60 / 120, rolling 3 s from 100, 0-20 from rest ──');
      for (const surface of ['grass', 'dirt', 'gravel', 'sand'] as const)
        for (const wetness of [0, 0.75]) {
          const cells = cars.map((c, i) => {
            const g = (kmh: number) => gripAtSpeed(c, kmh, { surface, wetness }).latG;
            const b = (kmh: number) => brakeRun(c, true, { surface, wetness }, kmh).distance;
            const kmhs = surface === 'sand' ? [40] : [60, 120];
            return `${label(i)} g ${kmhs.map((k) => g(k).toFixed(3)).join('/')} stop ${[60, 120].map((k) => b(k).toFixed(0)).join('/')} roll ${freeRoll(c, { surface, wetness }).toFixed(0)} 0-20 ${f(launch(c, { surface, wetness }, 20, 'low', 30), 1)}`;
          });
          say(`${surface.padEnd(6)} wet ${wetness} | ${cells.join(' | ')}`);
        }
    }
    if (on('slide')) {
      say('── how it slides, degrees of body slip (S = spun): the gamepad drives of tests/handling.test.ts dry and in standing water with the Standard aids / with none; a bend held flat out; a lift in a bend; a power slide without aids (s to 10 and 30 degrees, caught or not) ──');
      cars.forEach((c, i) => {
        const cell = (s: { slipDeg: number; spun: boolean }) => `${s.slipDeg.toFixed(0)}${s.spun ? 'S' : ''}`;
        for (const wetness of [0, 1]) {
          const g = { wetness };
          const both = (kmh: number, script: (t: number) => { steer: number; throttle: number; brake: number }, sec: number) => `${cell(drive(c, kmh, STANDARD, script, sec, g))}/${cell(drive(c, kmh, BARE, script, sec, g))}`;
          say(
            `${label(i)} wet ${wetness} | step150 ${both(150, (t) => ({ steer: t > 0.5 && t < 2.5 ? 1 : 0, throttle: 0.3, brake: 0 }), 5)} flick110 ${both(110, (t) => ({ steer: t < 0.6 ? -1 : t < 1.4 ? 1 : 0, throttle: t < 1.4 ? 0 : 1, brake: 0 }), 4)} exit60 ${both(60, (t) => ({ steer: t < 2 ? 0.7 : 0.2, throttle: t > 0.5 ? 1 : 0.2, brake: 0 }), 4)} panic130 ${both(130, (t) => ({ steer: t > 0.3 ? 0.8 : 0, throttle: 0, brake: t > 0.3 ? 1 : 0 }), 4)} panic250 ${both(250, (t) => ({ steer: t > 0.3 ? 0.8 : 0, throttle: 0, brake: t > 0.3 ? 1 : 0 }), 5)} lane80 ${both(80, (t) => ({ steer: t < 0.5 ? 0 : t < 1.2 ? 1 : t < 2.6 ? -1 : t < 3.3 ? 1 : 0, throttle: 1, brake: 0 }), 6)} lane120 ${both(120, (t) => ({ steer: t < 0.5 ? 0 : t < 1.2 ? 1 : t < 2.6 ? -1 : t < 3.3 ? 1 : 0, throttle: 1, brake: 0 }), 6)} lane240 ${both(240, (t) => ({ steer: t < 0.5 ? 0 : t < 1.2 ? 1 : t < 2.6 ? -1 : t < 3.3 ? 1 : 0, throttle: 1, brake: 0 }), 6)}`,
          );
          say(
            `${label(i)} wet ${wetness} | bend flat out (Standard) ${[60, 100, 150, 200, 250].map((k) => `${k}: ${cell(bend(c, k, 1, STANDARD, 0.5, g))}`).join(' ')} | (AI aids) ${[60, 100, 150, 200].map((k) => `${k}: ${cell(bend(c, k, 1, AI_AIDS, 0.5, g))}`).join(' ')} | lift (Standard/none) ${[80, 120, 160, 200, 250].map((k) => `${k}: ${cell(liftOff(c, k, STANDARD, 0.5, g))}/${cell(liftOff(c, k, BARE, 0.5, g))}`).join(' ')}`,
          );
        }
        const n = c.physics.drivetrain.gears.length;
        const slides = [[60, 2], [90, 2], [90, 3], [130, 3], [130, 4]].filter(([, gear]) => gear <= n).map(([kmh, gear]) => {
          const p = powerSlide(c, kmh, gear);
          return `${kmh} in ${gear}: ${f(p.t10)}→${f(p.t30)} s max ${p.slipDeg.toFixed(0)}${p.spun ? 'S' : ''} ${p.caught ? 'caught' : 'NOT caught'} at ${p.caughtDeg.toFixed(0)}`;
        });
        say(`${label(i)} power slide, no aids | ${slides.join(' | ')}`);
      });
    }
    if (on('winter')) {
      say('── on studs (tests/winter-handling.test.ts): the four drives on snow and ice with the Standard aids / none, and the power slide on snow (s from 10 to 30 degrees) ──');
      cars.forEach((c, i) => {
        const cell = (s: { slipDeg: number; spun: boolean }) => `${s.slipDeg.toFixed(0)}${s.spun ? 'S' : ''}`;
        for (const surface of ['snow', 'ice'] as const) {
          const g = { surface, winter: true };
          const run = (kmh: number, script: (t: number) => { steer: number; throttle: number; brake: number }, sec: number) => {
            // (as the test has it: placed at speed in first gear, the default settings' aids)
            const one = (aids: Assists) => {
              const { world, car } = setup(c, g, kmh / 3.6, aids);
              let slip = 0;
              const filter = new SteeringFilter();
              for (let k = 0; k < sec * 60; k++) {
                const s = script(k * DT);
                car.controls.steer = filter.update(s.steer, DT, car.state, car.def, DEFAULT_SETTINGS.controls);
                car.controls.throttle = s.throttle;
                car.controls.brake = s.brake;
                world.step(DT);
                if (car.state.speed > 5) slip = Math.max(slip, Math.abs(bodySlip(car)));
              }
              return { slipDeg: (slip * 180) / Math.PI, spun: slip > 1.2 };
            };
            return `${cell(one({ ...DEFAULT_SETTINGS.assists }))}/${cell(one(BARE))}`;
          };
          say(
            `${label(i)} ${surface.padEnd(4)} | step100 ${run(100, (t) => ({ steer: t > 0.5 && t < 2.5 ? 1 : 0, throttle: 0.3, brake: 0 }), 6)} flick80 ${run(80, (t) => ({ steer: t < 0.6 ? -1 : t < 1.4 ? 1 : 0, throttle: t < 1.4 ? 0 : 1, brake: 0 }), 5)} exit40 ${run(40, (t) => ({ steer: t < 2 ? 0.7 : 0.2, throttle: t > 0.5 ? 1 : 0.2, brake: 0 }), 5)} panic90 ${run(90, (t) => ({ steer: t > 0.3 ? 0.8 : 0, throttle: 0, brake: t > 0.3 ? 1 : 0 }), 5)}`,
          );
        }
        // the power slide on snow, as the test drives it
        const { world, car } = setup(c, { surface: 'snow' }, 50 / 3.6, { ...BARE });
        const filter = new SteeringFilter();
        let t10 = -1;
        let t30 = -1;
        for (let k = 0; k < 360; k++) {
          const t = k * DT;
          car.controls.steer = filter.update(t > 0.3 ? 0.6 : 0, DT, car.state, car.def, DEFAULT_SETTINGS.controls);
          car.controls.throttle = t > 1 ? 1 : 0.35;
          world.step(DT);
          const beta = (Math.abs(bodySlip(car)) * 180) / Math.PI;
          if (t10 < 0 && beta > 10 && t > 1) t10 = t;
          if (t30 < 0 && beta > 30 && t > 1) t30 = t;
        }
        say(`${label(i)} power slide on snow: 10 deg at ${t10.toFixed(2)} s, 30 at ${t30.toFixed(2)} s: ${(t30 - t10).toFixed(2)} s | 0-100 snow TCS low ${f(launch(c, { surface: 'snow' }, 100, 'low'), 1)} off ${f(launch(c, { surface: 'snow' }, 100, 'off'), 1)} | ice ${f(launch(c, { surface: 'ice' }, 100, 'low'), 1)} off ${f(launch(c, { surface: 'ice' }, 100, 'off'), 1)}`);
      });
    }
    if (on('wing')) {
      say('── the active wing: when it opens from 250 km/h flat out, and the car when it comes up at speed (seconds to close, body slip, yaw, sideways drift) ──');
      cars.forEach((c, i) => {
        if (!c.physics.aero.straightMode) return;
        const { world, car } = atSpeed(c, 250, AI_AIDS);
        car.controls.throttle = 1;
        let half = 0;
        let full = 0;
        for (let k = 0; k < 90; k++) {
          world.step(DT);
          if (!half && car.state.aeroOpen! >= 0.5) half = world.time;
          if (!full && car.state.aeroOpen! >= 1) full = world.time;
        }
        say(`${label(i)} opens: half ${half.toFixed(2)} s, full ${full.toFixed(2)} s (from ${(STRAIGHT_MODE_SPEED * 3.6).toFixed(0)} km/h)`);
        for (const wetness of [0, 1])
          for (const kmh of [200, 300, 370]) {
            const g = { wetness };
            const cell = (name: string, w: ReturnType<typeof wingUp>) => `${name}: ${f(w.closeTime)} s slip ${w.slipDeg.toFixed(1)} yaw ${w.yaw.toFixed(2)} drift ${w.drift.toFixed(1)}`;
            for (const [aidsName, aids] of [['Standard', STANDARD], ['none', BARE]] as const)
              say(
                `${label(i)} wet ${wetness} ${kmh} km/h ${aidsName.padEnd(8)} | ${cell('lift', wingUp(c, kmh, (v) => (v.controls.throttle = 0), aids, g))} | ${cell('brake', wingUp(c, kmh, (v) => ((v.controls.throttle = 0), (v.controls.brake = 1)), aids, g))} | ${cell('turn 0.1 flat', wingUp(c, kmh, (v) => (v.controls.steer = 0.1), aids, g))} | ${cell('lift+turn .15', wingUp(c, kmh, (v) => ((v.controls.throttle = 0), (v.controls.steer = 0.15)), aids, g))} | ${cell('brake+turn .15', wingUp(c, kmh, (v) => ((v.controls.throttle = 0), (v.controls.brake = 1), (v.controls.steer = 0.15)), aids, g))}`,
              );
          }
        // a fast bend in both modes: the wing fixed up, and fixed flat (the straight mode's areas as the car's own)
        const sm = c.physics.aero.straightMode;
        const up = variant(c, 'physics.aero.straightMode=undefined');
        const flat = variant(c, `physics.aero.straightMode=undefined,physics.aero.dragArea=${sm.dragArea},physics.aero.liftAreaFront=${sm.liftAreaFront},physics.aero.liftAreaRear=${sm.liftAreaRear}`);
        for (const [name, v] of [['wing up', up], ['wing flat', flat]] as const)
          say(`${label(i)} ${name}: lat g ${[150, 200, 250, 300].map((k) => `${k}: ${f(latAt(v, k), 3)}`).join(' ')} | bend flat out, Standard ${[200, 250, 300].map((k) => `${k}: ${bend(v, k).slipDeg.toFixed(1)}`).join(' ')} | no aids ${[200, 250, 300].map((k) => `${k}: ${bend(v, k, 1, BARE).slipDeg.toFixed(1)}`).join(' ')} | lift, no aids ${[200, 250, 300].map((k) => `${k}: ${liftOff(v, k, BARE).slipDeg.toFixed(1)}`).join(' ')}`);
      });
    }
    if (on('lap') || on('temps')) {
      const tracks = (process.env.TRACKS ?? TRACKS.map((t) => t.info.id).join(',')).split(',');
      const wets = (process.env.WET ?? '0,1').split(',').map(Number);
      say('── the AI (alien), alone: the lap after the first crossing, resets / impacts / floor / s past the edge, vmax, brake g; the tyres over the next lap (mean and range, front | rear), the hottest disc, s with the wing down ──');
      for (const trackId of tracks)
        for (const wetness of wets) {
          const laps = cars.map((c) => lapOf(trackId, c, wetness));
          cars.forEach((c, i) => {
            const r = laps[i];
            const vs = cars.map((_, k) => (k === i ? '' : `${((r.lap / laps[k].lap - 1) * 100).toFixed(1)}% vs ${names[k]}`)).filter(Boolean).join(', ');
            say(`${trackId.padEnd(9)} wet ${wetness} ${label(i)} ${r.lap.toFixed(2)} s (next ${r.next.toFixed(2)}) r${r.resets} h${r.impacts} f${r.floor} off ${r.offEdge.toFixed(1)} vmax ${r.vmax.toFixed(0)} brake ${r.brakeG.toFixed(2)} g | tyres F ${r.tempFront.map((x) => x.toFixed(0)).join('/')} R ${r.tempRear.map((x) => x.toFixed(0)).join('/')} disc ${r.disc.toFixed(0)} wing ${r.wingOpen.toFixed(1)} s | ${vs}`);
          });
        }
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync(process.env.TACCOLA_OUT ?? '.cache/taccola-probe.txt', out.join('\n') + '\n');
  }, 3600000);
});
