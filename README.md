# Xeno-Racer

A realistic racing game for the browser, built for a gamepad. A from-scratch vehicle simulation
running at 1000 Hz, AI drivers that race wheel to wheel, two hand-built circuits, procedurally
sculpted cars, synthesized engine sound, and a TV director that films the race.

![Racing up Kuroyama Pass](docs/img/kuroyama.jpg)

## Play

**Windows:** double-click **`play.bat`**. It needs [Node.js](https://nodejs.org) 20+ and Google Chrome.
On the first run it installs dependencies and builds the game, which takes about a minute. It then
opens Xeno-Racer full-screen in its own Chrome window, on the dedicated GPU. Close the window to quit.

- Plug in the gamepad and press any button. On a **Logitech F310**, set the switch on the back to **X** (XInput).
- `play.bat --window` plays in a window, `play.bat --build` forces a rebuild, `play.bat --dev` runs from the dev server with hot reload, and `play.bat --serve` only serves the game (open the printed address yourself).

**Any platform:** run `npm install`, then `npm run dev`, and open http://localhost:5199 in Chrome.

## Controls

| | Gamepad (Xbox layout) | Keyboard |
|---|---|---|
| Steer | Left stick | A / D or ← / → |
| Throttle / brake | RT / LT (analog) | W / S or ↑ / ↓ |
| Handbrake | A | Space |
| Shift up / down | RB or B / LB or X (manual gearbox) | E / Q |
| Camera | Y | C |
| Look around / look back | Right stick / click right stick | I J K L / V |
| Reset car to track | Back | R |
| Pause | Start | Esc |
| HUD / telemetry | D-pad up / D-pad down | H / T |

Menus use the D-pad or left stick: A confirms, B goes back, and LB/RB step between setup pages.
During a replay, LB/RB switch cars, Y changes the camera and B exits. Rumble responds to
kerbs, wheelspin and impacts.

## Modes

- **Race:** up to 11 AI opponents in four skill levels (rookie, amateur, pro, alien). Start-light countdown, pole/middle/back grid slot, 1–50 laps, time of day and weather. Results come with a full replay.
- **Time trial:** a rolling start, sector splits, and a live delta to your best lap, raced against the ghost of your personal best. Best laps and ghosts are saved per track and car.
- **Free roam:** the track to yourself.

Opponents drive the same car as you, so the racing is about driving, not horsepower.

## Cars

All four are original designs, and their figures are measured in the simulation, not just quoted:

| | Layout | Power | Weight | 0–100 km/h | Top speed | Skidpad |
|---|---|---|---|---|---|---|
| **Vanta GT**: twin-turbo V8 grand tourer | Front-mid engine, RWD | 610 hp | 1480 kg | 4.6 s | 340 km/h | 1.08 g |
| **Kestrel R**: turbo hot hatch | FWD | 320 hp | 1320 kg | 5.6 s | 270 km/h | 1.01 g |
| **Ronin 86**: naturally aspirated boxer coupé | RWD | 240 hp | 1200 kg | 6.6 s | 254 km/h | 0.99 g |
| **LMP-X**: V10 prototype with real downforce | Mid-engine, RWD | 690 hp | 950 kg | 2.6 s | 318 km/h | 1.92 g |

## Tracks

- **Aurelia Ring** (4.79 km, 14 corners) is a grand-prix circuit around a lake. It has a 940 m main straight into a hairpin, flowing esses, a banked carousel, a chicane and a downhill braking zone. Floodlit at night.
- **Kuroyama Pass** (5.25 km) is a mountain road climbing 140 m through twelve switchback hairpins, with a ridge section, a tunnel and a fast descent. The road is narrow and guard-railed.

Six times of day (dawn to night) and three weather presets, all lit by a physically based sky.

![Kuroyama hairpin from a TV camera](docs/img/hairpin.jpg)
![Aurelia at night](docs/img/night.jpg)

## Under the hood

- **Vehicle physics** (`src/physics`) is written from scratch and steps at 1000 Hz:
  - **Tires:** combined-slip tire model with relaxation length, load sensitivity, and tread and brake temperatures.
  - **Suspension:** raycast suspension with anti-roll bars.
  - **Drivetrain:** engine torque curves with turbo lag, a clutch and gearbox solved implicitly, and a limited-slip differential.
  - **Aero:** drag, downforce and slipstream.
  - **Driver aids:** ABS, traction control and stability control, plus a speed-sensitive steering filter tuned for a thumbstick.
  - **Collisions:** car-to-car and car-to-wall, with sparks and scrapes.
  - **Cost:** twelve cars cost about 0.6 ms per frame.
- **AI** (`src/ai`) works in four layers:
  - A minimum-curvature racing line, with a speed profile from the friction circle, downforce and banking.
  - A path-tracking steering controller.
  - A traffic planner that holds its lane alongside other cars, commits to passes, leaves room, and follows at a safe gap when it can't get by.
  - Measured over 10 benchmark races: no resets, almost no time off the track, and around 200 overtakes.
- **Rendering** (`src/render`, `src/carvis`, `src/track`) is three.js on WebGL2:
  - **Lighting and post:** cascaded sun shadows, ambient occlusion, bloom, sun shafts, motion blur and AgX tone mapping.
  - **Cars:** sculpted from signed distance fields, with liveries, working lights, interiors, and a driver who turns the wheel.
  - **Tracks:** terrain, trees and props are all procedural, plus CC0 surface textures.
  - **Performance:** the high preset renders 1080p in about 8 ms on an RTX 3050 laptop GPU.
- **Audio** (`src/audio`) synthesizes engines in AudioWorklets, with intake, exhaust, turbo whistle, backfires, tire squeal, wind, impacts and 3D positioning.

![TV camera](docs/img/tv.jpg)
![Car select](docs/img/showroom.jpg)

## Development

```
npm run dev        # dev server on :5199
npm run build      # type-check + production build into dist/
npm test           # vitest: physics, AI, handling, tracks, session, UI, audio, render
npm run typecheck
```

- [`ARCHITECTURE.md`](ARCHITECTURE.md) describes the subsystems and the shared contracts in `src/core`.
- `sandbox/*.html` holds standalone labs for the car models, tracks, rendering, audio and UI.
- `scripts/tour.mjs` scripts a play-through in headless Chrome. It can wait, press keys, take screenshots, evaluate code and collect perf stats. With `--init scripts/fixtures/fake-pad.js` it drives a fake F310.
- `tests/probes/` holds diagnostics that only run on demand. For example, `PACKSET=1 npx vitest run tests/probes/pack.test.ts` runs the AI pack-racing benchmark.

Dev URL flags: `?quick=race|timeTrial|freeRoam&track=aurelia|kuroyama&car=vanta-gt&opp=7&laps=3&tod=night&cam=tv&quality=low|medium|high|ultra&autopilot=1&ui=0`.

## Credits

Surface textures are CC0 from [Poly Haven](https://polyhaven.com) (see `public/assets/track/CREDITS.md`).
Everything else is generated in code: cars, terrain, trees, buildings, signage, sky, engine sound and music.

Built by Claude (Anthropic) for Gabriel.
