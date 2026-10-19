# Xeno-Racer — architecture

A realistic racing game for the browser, built to be played with a gamepad (Logitech F310 in
XInput mode → Chrome's `standard` mapping). TypeScript + Vite + three.js (WebGL2), with a custom
vehicle-dynamics engine running at a fixed 1000 Hz.

Target machine: Windows 11 laptop, **RTX 3050 6 GB Laptop GPU**, i5-12600HX, 16 GB RAM, Chrome.
Budget at 1920×1080 on the `high` preset: **60 fps**, ≤ 700 draw calls, ≤ 2.5 M triangles on
screen, ≤ 1.2 GB GPU memory. `low` must hold 60 fps on the Intel UHD iGPU at 1280×720.

## Art direction

Photoreal motorsport at golden hour: the look of a Gran Turismo / Forza photo mode. Warm, low sun,
long soft shadows, atmospheric haze, lush grass and trees, clean modern circuit infrastructure,
deep glossy car paint with clearcoat reflections. Natural, filmic tone mapping (AgX or ACES) —
never oversaturated, never "gamey" neon. The "Xeno" brand shows only in the UI, liveries and
signage: teal `#16e0bd`, hot pink `#ff2e63`, near-black `#0b0c10`, off-white `#eef0f3`.

## Layout and ownership

| Path | Owner | What |
|---|---|---|
| `src/core/contracts.ts`, `src/core/systems.ts` | lead | Shared types + subsystem APIs. **Do not edit**; ask the lead. |
| `src/core/*` (other) | lead | settings, small shared helpers; `split.ts`: the split-screen geometry, lens, HUD scale and grid slots (pure, shared by render, UI and game) |
| `src/physics/` | lead | rigid body, tires, suspension, drivetrain, aero, collisions, assists |
| `src/cars/` | lead | car roster (`CARS`, `getCar`) — physics + visual + sound specs |
| `src/game/`, `src/main.ts` | lead | game loop, race logic, timing, ghosts, championship (`championship.ts`: pure scoring, standings and persistence), weather that changes during a race (`weather.ts`: the plan, the timeline and the director, pure; the rules of a legal forecast are in `src/core/forecast.ts`), integration |
| `src/track/` | track | track definitions, spline/runtime queries, road/terrain/scenery meshes |
| `src/render/` | render | renderer, post-processing, sky/sun/env map, cameras, particle FX, skidmarks |
| `src/carvis/` | carvis | procedural car models, wheels, lights, liveries, cockpit |
| `src/audio/` | audio | engine synthesis, tires, wind, impacts, UI sounds, music |
| `src/input/` | ui | gamepad + keyboard → `InputFrame` |
| `src/ui/` | ui | HUD, menus, settings screens (DOM/CSS overlay in `#ui`) |
| `src/ai/` | ai | racing line, AI drivers |
| `sandbox/<owner>.html` + `sandbox/<owner>/*` | each owner | standalone dev page for the subsystem |
| `public/assets/<owner>/` | each owner | downloaded assets + `CREDITS.md` |
| `tests/<owner>*.test.ts` | each owner | vitest (headless) tests |

Each module exposes its public API from `src/<module>/index.ts`, matching `src/core/systems.ts`
exactly. Modules never import each other's internals — only `core/*`, `cars`, and other
modules' `index.ts` where `systems.ts` says so.

## Data flow per frame

```
InputSystem.poll ─► game (steering filter, assists) ─► CarControls ─► physics (1000 Hz substeps)
                                                                         │
                                         VehicleState[] ◄────────────────┘
        ┌───────────────┬────────────────┬───────────────┬──────────────┐
   CarVisual.update  EffectsSystem   CarSound.update   CameraRig      HudState → UI
        └───────────────┴──── RenderSystem.render(camera) ┘
```

Split screen (two humans, one canvas) has the same flow with the camera-dependent half done twice: see below.

Crash damage (Settings: Damage, Off / Visual / Full) is a deterministic fold over the impacts of a car, kept by the car's
visual (it watches `VehicleState.impactCount`) and rebuilt by replays from the events they stamped:

```
VehicleState ─ImpactObserver─► DamageEvent ─CarDamage─► dents, marks, lamps, glass, zones      src/core/damage.ts  (how it looks)
                                                   └─► MechState ─mechanicalEffects─► MechEffects  src/core/mechanical.ts  (how it drives)
                                                          ├─► Vehicle.setDamage     toe and camber per wheel, downforce per axle, torque
                                                          ├─► AIDriver.setDamage    the driver works with the car it has
                                                          ├─► the wheels the car visual draws, and HudDamage → src/ui/hud/damage.ts
```

`MechLink` (src/game/mechsync.ts) puts a car's record on its physics and its driver whenever it changes, in Full only, and
takes it off again outside it. Cars are rebuilt for a restart or a round (repaired); a reset to the track touches nothing.

Track: `loadTrackRuntime(id)` is headless (physics/AI/tests use it); `buildTrackScene()` makes the
visible world. Physics asks the track `groundAt()` for every wheel every substep and `project()`
for barrier collisions — they must be fast and allocation-free.

## Split screen

Two humans on one screen (races and free roam, `RaceConfig.player2`). The simulation is the same, once per frame; what is doubled
is everything that belongs to a view.

- **Who is who:** `Game.drivers` holds one `Driver` per human in seat order (seat 0 is player 1): their car, their `CameraRig`,
  steering filter, banners, spotter state and the lap they are on. A single-player race has one driver and runs the same code with
  the same numbers as before.
- **Input:** `XenoInputSystem.bindPlayers(a, b)` gives each seat a device (a pad index, or the keyboard). `poll()` still returns the
  one merged frame the menus use, whose navigation is the union of the devices (or only the pad that paused a race: `menuOwner`);
  `players[seat]` are the drivers' own frames and read their own device only. The join step (`beginJoin`, `takeJoiner`) binds the
  first other pad that presses A, or the keyboard's Enter. A seat whose pad is unplugged is reported by `missingSeat()` and the game
  pauses.
- **Render:** `setSplit(layout)` cuts the canvas into two views (`src/core/split.ts`: a 4 px gap, rows or columns). The post chain
  (one `EffectComposer`) works at the size of a view and `renderViews()` runs it twice a frame, each time into its own viewport, so
  bloom, AO, SMAA, motion blur, sun shafts, wet-road reflections and windscreen droplets are the 1P passes. A view has its own
  camera, the rain on its glass and its wiper clock (`ViewState`), its blur history, the street lamps nearest its car, and a **set of
  sun cascades of its own** (`SunShadows.sets`: two sets of lights, one in the scene at a time, so the number of lights and every lit
  shader are the same as in 1P; the far cascade of the second set refreshes a frame after the first's, so no frame redraws both). Just before a view is drawn the game's `prepare(i)` points everything else that depends on the camera
  at it: `TrackScene.update(dt, camera)`, `EffectsSystem.view()` (the rain box, the nearest lights, the sort of smoke and spray), and
  which car shows its cockpit and its real headlight beams (`CarVisual.setBeams`; the other human's car has the soft glow an opponent
  has). The first view's draw updates the scene's matrices and the second skips it. Mirrors are off. While the screen is split the
  graphics are run as `splitGraphics()` says (Ultra's 1.25 supersampling at 1.0; the saved settings are not touched).
- **No shader after the start:** a split frame has the same lights, passes and buffer size for both views, so every program is built
  behind the loading screen (`precompile()` with the first view's lights, then one hidden `renderViewsNow()` through both views) and
  `renderer.info.programs` does not grow once the lights go out.
- **Audio:** WebAudio has one listener. A human's car is placed from their own camera and moved into player 1's listener frame (a
  small left/right swing tells the two engines apart), opponents are heard from the nearer human, and each human's gains are trimmed
  so that two player voices are not twice as loud (`src/audio/spatial.ts`).
- **UI:** `UISystem.setSplit(layout)` shows one HUD per seat in a pane over its view (`src/ui/hud/panes.ts`) and a divider;
  `updateHud(state, seat)` feeds each. `PlayersInfo` tells the setup's join card and the pause menu who plays on what.
- **Aids:** each seat has a set of its own (`Settings.assists` for seat 0, `Settings.assists2` for seat 1: the gearbox, ABS, TCS, ESC, the steering assist, the
  driving line and the braking assist), given to the car of that seat when it is built and whenever the settings change (`assistsOfSeat`, `carAssists`); see
  Driving aids below. An old save that has only `assists` starts player 2 with a copy of it.
- **Session:** `Entrant.seat` marks the humans. Each has their own lap reference, stored best and results row, and `RaceResults.duel`
  says who beat whom.

## Winter circuits

A circuit with `TrackInfo.winter` (Isvik: packed snow, a frozen lake, snowbanks for walls) is one flag that every system reads for its own
purpose. Nothing else changes for the other four circuits: a road circuit gets the very same objects, numbers and shaders as before.

- **Surfaces** (`src/physics/surfaces.ts`): `snow` (packed road, 0.50 of dry asphalt), `ice` (the studded lake, 0.40) and `deepsnow` (beside
  the road, 0.32, with ploughing drag and a heavy rolling term). `SurfaceProps.fresh` is the grip kept under a heavy fall of fresh snow: on a
  winter circuit the world's `wetness` *is* that snow (`wetGripFactor`), so no water film, no aquaplaning and no wet-tyre window.
- **Tyres** (`src/physics/compound.ts`): `fitCar(def, track)` returns the car itself on a road circuit and a copy on studded winter tyres on
  a winter one; `PhysicsWorld.addVehicle`, `AIDriver` and the steering filter all read the fitted car, so physics, AI and aids agree. A studded
  tyre peaks later (10 degrees, slip ratio 0.16), falls off gently (`slideRatio` 0.9) and hardly minds load: the car slides without letting go.
  The thermal model runs in air at -6 degrees (`WINTER_AMBIENT_C`). The stick is scaled to the grip of the snow or the ice under the front
  wheels (`SteeringFilter`): full stick asks for what the tyres can use there, not what they could on asphalt.
- **Soft barriers:** `BarrierKind` `snowbank` sets `TrackPoint.softLeft/softRight`. `Vehicle.resolveBank` is a spring and a damper that
  stiffens with depth, gives back a fifth of what it took and drags the flank along it, with a hard stop at 3.5 m (the frozen ground under
  it). The hit is an `ImpactKind` `snow` at a third of its closing speed (`damage.ts` counts it as a wall hit of that strength).
- **Track** (`src/track/defs/isvik.ts`): laid out with `turtleVerts` (corner deflection, radius, edge length; two free edges close the loop).
  `TrackDef.winter` picks the road and the ground surface and the patches of ice; the runtime keeps them as per-sample channels (`roadSurf`,
  `farSurf`) next to the bands, and `terrain.frozen` makes a level lake with a shore and bakes the ice into a mask the lake shader reads.
- **Scene** (`src/track/scene/{snow,winter,winterProps,winterDetail}.ts`): the snow ground, the packed road with its polished lane and the
  ice are patched `MeshStandardMaterial`s (sparkle from the light list, a bump from screen-space derivatives, blue shadows from the ground
  bounce); the snowbanks are extruded from the road's own wall line, lumpy with noise; spruce, pine and birch are the instanced trees with
  snow on their planes. Red cabins, the paddock, the poles on the ice, the reeds and the crowds are instanced and keep clear of each other.
  The conifers and birches do not cast their shadows from their needle cards: `shadowProxy` in `trees.ts` draws a hull (five tiers of seven
  sides, about 70 triangles, with a 16 by 16 noise cut at the alpha test for the gaps between the sprays) or a bare trunk with the very same
  instance matrices, and the cards cast nothing. In the picture the proxy is a program that puts its vertices outside the view, so it is
  free there. A forest of alpha-tested cards, drawn again into every cascade of the sun, was two thirds of the shadows' GPU time: over a
  whole lap at 1920x1080 High the split screen went from 13.5 ms (p95 17.6) to 10.1 ms (p95 11.9) and one view from 8.4 (10.6) to 7.5 (8.7)
  (`sandbox/render/perfab.mjs` switches one thing of the scene off at a time, interleaved with the rest, and says what it saves).
- **Light and weather** (`src/render/presets.ts`, `environment.ts`): `TOD_WINTER` (a low sun, a blue hour) and `WEATHER_WINTER`
  (`rain` is a snowfall, `storm` a blizzard; the clear, cloudy and overcast skies are the ordinary ones), a ground albedo of 0.8 for the
  bounce, and an aurora in the sky shader (two curtains, a few texture reads, only on a clear winter night). `wet/snowfall.ts` is the
  `RainField`'s twin: flakes as capsules in the same camera-local box. `effects.ts` throws powder (the mist pool, lit by the whole sky), a
  burst for a snowbank, and the exhaust plumes of the cold. The snow reaches the windscreen as a seventh of the rain, the headlights and
  the floodlights are dimmed (snow gives back five times the light of asphalt). The weather pipeline (`WeatherState`, the forecast, the
  HUD chip) is unchanged: only its words (`ui/format.ts`, `game/weather.ts`) and icons say snow.
- **AI** (`src/ai`): `lineSurfaces` gives the speed profile the grip under every point of the line (the ice is slower than the snow); a
  winter driver is always in the cautious mode of a wet road and keeps off the snowbanks; lane changes move at the speed the surface's grip
  allows, the throttle is limited to what the friction circle leaves the driven axle, and a car that has let go points its wheels where it is
  travelling and lifts. `tests/probes/winter-laps.test.ts` and the pack probes measure all of it.
- **Audio** (`src/audio`): snow and ice are two more surface voices of the chassis (a crunch that follows the speed; the ratchet of studs),
  a sliding tyre on snow hisses where asphalt squeals, a snowbank is a low whump, and the weather node's `WCTL.SNOW` turns the rain bed into
  a wind (no drops, no thunder).
- **Driving guide** (`src/ai/guide.ts`, the driving line and the braking assist): the winter driver's line and profile for the human's car: the studded tyres
  (`fitCar`), the grip under each point of the line (`ProfileJob.surfaceFactor`: packed snow, the ice of the lake, the fresh snow lying on it as the road's
  "water"), the line that keeps off the snowbanks. What the car can brake at is that of the ground it is on (`DrivingGuide.brakeAt(speed, s)`,
  `brakeGripAt`), so the colours go amber and red where a car on snow or ice has to brake, not where one on asphalt would. The ribbon itself is more opaque on a
  winter circuit (`LINE.alphaWinter`, 0.9 against 0.66): snow in the headlights is far brighter than asphalt, and a thinner ribbon came out a pale ghost of its colour.

## Driving aids: the driving line and the braking assist

Two aids live above the physics, per human (Settings: `assists` for player 1 and `assists2` for player 2, both `PlayerAssists`: the car's six aids that the
physics reads, plus `line` and `brakeAssist`). They share one source, the speed the AI's racing line asks of the player's own car:

```
computeRacingLine + ProfileJob ─► DrivingGuide (src/ai/guide.ts) ─┬─► DriverAids (src/game/driveraids.ts) ─► BrakeAssist ─► CarControls (brake, lifted throttle) ─► HudState.brakeAssist
 (src/ai/racing-line.ts)          line (dry, wet), speeds, brake     │      finds the car on the track          (src/core/aids.ts)
                                  model, refresh for rain and damage  └─► DrivingLine (src/render/drivingLine.ts): the ribbon, coloured by lineUrgency (src/core/aids.ts)
```

- **The numbers are pure** (`src/core/aids.ts`, tests/aids.test.ts): `neededDecel` and `lineUrgency` (the deceleration that brings the car to the line's speed
  by a point, over what the car brakes at), `lineColor`, `lineFade`, `brakeDemand` and the `BrakeAssist` pedal (smoothed: quick to rise, slow to fall; it
  only adds to the driver's pedal, and lifts the throttle as the car goes over the line's speed), and the presets (`ASSIST_PRESETS`, Pro / Standard / Beginner).
- **The guide** (`src/ai/guide.ts`) takes the AI's racing line and speed profile for the player's car (a driver's share of the grip, 0.84, and of the brakes,
  0.8) and the water on the road. A change in the water (or in the car's damage) is worked out in slices of a few hundred microseconds by `ProfileJob` (the profile
  of the AI, in the same arithmetic, resumable) and the old speeds blend into the new over 1.5 s; the line moves from the dry racing line to the wet one over 2 s.
  `DriverAids` (`src/game/driveraids.ts`) is what the game updates every frame: it keeps the guide current, finds the car on the track and runs the assist.
  It runs headless, so tests/probes/brake-assist.test.ts drives a car round every circuit with the same code.
- **The ribbon** (`src/render/drivingLine.ts`) is one transparent mesh per human, a window of up to 164 rows of 2 m rewritten every frame from tables made when
  it was built (12 KB, microseconds of CPU). It lies 2.5 cm over the road at the point of each vertex, with a polygon offset, no depth write and no lighting;
  its colours are divided by the scene's exposure so that the grade gives the same line at noon and at night; and where it covers the road it pulls the
  wet-road reflection flag (the alpha of the scene buffer) towards "not glossy". Its program is built with the rest of the scene: the mesh is made before
  `warmUp`, hidden when the setting is off, so switching the line on in the middle of a race builds nothing.
- **Which view draws it:** a human's line sits on a camera layer of its own (`LINE_LAYERS`), and the game turns that layer on for the camera of that seat only.
  So in a split screen each view shows its own driver's line, and the mirrors, the shadow cameras and nothing else see any. Whether it is drawn at all
  (`paintLines()` in game.ts) follows the setting, the camera mode (`lineShownIn`: chase, far chase, hood, bumper, cockpit), the HUD (the photo mode hides it)
  and the phase (not in a replay or behind the results). The attract race behind the menus has no drivers, so no line.
- **Records and results do not know about the aids:** a lap set with the braking assist or the line counts like any other.

## Nitro

Every car has two shots a lap (`src/core/nitro.ts`: `NitroTank`, pure; `NITRO_PER_LAP`, `NITRO_SECONDS`, `NITRO_POWER`, `NITRO_THRUST_G`).

```
InputFrame.nitro (E / B) ─┐                                  ┌─► Vehicle.nitro: torque x (1 + NITRO_POWER), a push along the car, both x throttle
AIDriver.wantNitro ───────┴─► NitroTank.fire ─► .level 0..1 ─┤   (src/physics/vehicle.ts) ─► VehicleState.nitro ─► flames (effects.ts), FOV (cameraRig.ts), replay
session crossings ─► NitroTank.update (a new lap fills it)   └─► HudState.nitro ─► the NITRO gauge (src/ui/hud/nitro.ts)
```

- **The game** (`game.ts`) keeps one tank per `RaceCar`, updates it every frame with the car's line crossings (a count above any seen before is a
  new lap; backing over the line and across it again fills nothing) and puts its level on the physics. A reset to the track puts a burning shot out.
  The press that closes the pause menu does not fire one.
- **The AI** (`src/ai/driver.ts`) is told `nitroReady` / `nitroOn` and asks with `wantNitro`: flat out on the road, above a speed (higher in the wet
  and on snow, where the extra torque spins a driven axle in the low gears), with no corner it would have to brake for within the reach of the boosted
  car (`straightAhead`), no car alongside and none ahead in its lane within 150 m (`nitroClear`), after a short delay of its own. The speed profile is
  capped by the car's own power, so while a shot burns, and after it until the car is back down to the profile, the driver's target speed is what the
  corners ahead and its brakes allow (`cornerBrakeSpeed`, aquaplaning included); the traffic caps still apply. Its random draws come from a stream of
  their own, so a driver without nitro (the tests, the guide, a dev autopilot) behaves exactly as before.

## Rules for everyone

- Conventions are in the header of `src/core/contracts.ts`. **+Z forward, +X left, +Y up.**
- Stay inside your paths. Do not touch `package.json`, configs, or other owners' files. If you need
  a contract change or a new dependency, say so in your final report — do not do it yourself.
  Installed: `three` (0.186), `postprocessing`, `n8ao`, `vite`, `vitest`, `typescript`, `playwright-core`.
  Three.js addons import as `three/addons/...` (e.g. `three/addons/csm/CSM.js`).
- Do not run git commands that change state (no commit, checkout, stash, reset). The lead commits.
- Strict TypeScript. `npx tsc --noEmit` must show no errors in your paths (ignore others').
- No allocations in per-frame / per-substep hot paths (reuse vectors; no closures in loops).
- Assets: only CC0 sources — Poly Haven (`api.polyhaven.com`, `dl.polyhaven.org`) and ambientCG.
  Prefer 1k–2k JPG/PNG. Your area's total under 40 MB. Record each asset in
  `public/assets/<owner>/CREDITS.md`. Everything must also *work* (degraded) if an asset fails.
- Fonts: self-host OFL fonts in `public/assets/ui/fonts/`.
- Everything must run with `npm run dev` (Vite, port 5199) and `npm run build`.

## Seeing your work

A dev server runs at `http://127.0.0.1:5199` (if it is down: `npx vite --port 5199 --strictPort`
in the background). Screenshot any page headlessly with the real GPU:

```
node scripts/shot.mjs sandbox/track.html --out shots/track-01.png --ready --wait 1500
node scripts/shot.mjs sandbox/car.html --out shots/car.png --ready --eval "window.__STATS__"
```

Set `window.__READY__ = true` when your page has finished loading. Then **look at the PNG**
(read the image file) and iterate until it is genuinely beautiful. `shots/` is gitignored.
