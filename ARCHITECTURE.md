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
                                                          ├─► Vehicle.setDamage     toe and camber per wheel, downforce per axle that has some, torque
                                                          ├─► AIDriver.setDamage    the driver works with the car it has
                                                          ├─► the wheels the car visual draws, and HudDamage → src/ui/hud/damage.ts
```

`MechLink` (src/game/mechsync.ts) puts a car's record on its physics and its driver whenever it changes, in Full only, and
takes it off again outside it. Cars are rebuilt for a restart or a round (repaired); a reset to the track touches nothing.

A car is only hurt in the ways it has. What a hit can take from it is read off the car (`mechanicalProfile(def)`, from its own lift areas, mass and
engine position) and kept with its record (`MechState.profile`; a record made without a car is one that has everything). `mechanicalEffects` (the
physics, the AI, the drawn wheels) and `mechanicalReport` (the HUD) both read it, so they cannot disagree: a part of the indicator lights exactly when
the hit changed how that car drives. `Vehicle.setDamage` also refuses to scale a lift area that is not downforce, whatever it is handed.

| the nose and tail can lose | Vanta GT | Kestrel R | Ronin 86 | LMP-X | Mammoth |
|---|---|---|---|---|---|
| front and rear downforce (to 60 %) | yes | no: a lip and a ducktail | no: the same | yes, a great deal | no: its aero is lift |
| engine power (up to 10 %, heavy nose hits) | yes | yes | yes | no: radiators in the side pods | yes |
| the rear wheels pushed out of line (a trace, tail hits) | yes | yes | yes | yes | yes |

The wheels are every car's (toe and camber, from the hits along the flank). The indicator shows a nose by its downforce where the car has any and by its
engine where not (so a Mammoth's stays dark until a hit reaches the radiator), and a tail by its downforce or by the trace of toe (never worse than Light).
It draws the car in the outline of its body style (`HudDamage.style`, from `CarVisualSpec.style`): a teardrop for the road cars, a brick with flared arches
for the Mammoth, a prototype with its front and rear wings for the LMP-X, each with its own wheels and zone splits (`SHAPES` in `src/ui/hud/damage.ts`).

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

## Terrain shade: where the hills hide the sun

The sun's cascades (`shadows.ts`) reach a few hundred metres and carry what casts into them; the terrain casts into nothing. A low sun that had
set behind a ridge two kilometres away still glinted on the cars, lit the grass, threw long shadows of the trees and coloured the haze in front of
the hill. The **sun visibility map** answers the question the cascades cannot, for the whole height field, with one texture lookup per fragment.
Where the hills leave a circuit in the sun (every circuit at its morning and its noon) no map is put to use, every lit program takes the old branch
and the picture is the old one to the pixel. Physics wins: no circuit's sun direction or time of day was moved to make a place look right.

- **What is stored** (`src/render/sunVisibility.ts`, pure maths): the horizon height `H(x, z) = max over u > 0 of T(p + u a) - u tan E`, a running
  maximum along the sun's azimuth `a`, so a point is lit when `y >= H`. One 2D texture holds the answer for every height (a road, a car roof, a hilltop,
  the air along a view ray). The grid is laid out in the sun's frame (u toward the sun, v across) so the sweep is a plain scan of rows with no interpolation
  between them. The sun is a disc: the sweeps run once for the lower limb and once for the upper one (the drawn disc's radius, `SUN_ANGULAR_RADIUS`) and also
  keep the *distance* to the ground that sets each horizon, which is the slope of the horizon line in height. Four floats per node, `[H_lo - yRef, H_hi - yRef,
  1/(u_lo dt), 1/(u_hi dt)]`, give `q = max((H_lo - y)/(u_lo dt), 1 + (H_hi - y)/(u_hi dt))` and the visible share of the disc is `smoothstep(1 - clamp(q))`:
  the penumbra comes out of the geometry (27 m of height behind a ridge a kilometre away, half a metre behind an embankment at 20 m), and a near bank
  with a far mountain behind it is two lines, not one blur (a plain "between two heights" model got that badly wrong).
- **Two grids in one atlas** (`src/render/sunVisMap.ts`): a coarse grid (40 m) over all the terrain that is drawn (nothing beyond it hides the sun) and a fine
  one (4 m, grown to fit: 5 m on the largest circuit) around the circuit and 140 m of margin, whose rows start where the coarse map left off. One RGBA32F
  `DataTexture` (3 to 9 MB; half floats where the GPU cannot filter 32-bit ones), fine block above coarse. three clones the textures in `ShaderLib` uniforms
  for every material, so the texture is a `SharedDataTexture` (`clone()` returns itself): one object, one upload, whatever the number of programs. The CPU's grids
  read the atlas in place (`readGrid` with `base` and `rowStride`), so `SunVisMap.visibilityAt` is the GLSL's twin on the same bytes.
- **Made** while the track loads, in slices of 25 ms with a yield to the browser between them: `Game.ensureTrack` hands the scene's `TrackScene.terrain`
  (a `TerrainSource`: the drawn height, the drawn extent, the circuit's bounds) to `RenderSystem.setTerrain`, which starts the map and does not wait for it;
  `precompile()` does, in the seconds the shader compiler takes and the page spends waiting (so the map costs the load nothing). Deterministic, keyed by
  (circuit, sun): the same pair is not made twice, another hour on a kept scene is made again, a newer call overtakes an older one, and a map that cannot be made is
  logged and leaves the picture as it was (a refinement is no reason for a race not to start). `TrackRuntimeImpl.drawnHeight` is the height as it is drawn: the road's carve
  inside its corridor (a cheap test of the spatial grid's cells), the baked terrain field everywhere else (the field alone is wrong inside the corridor, where a cut looked like a wall).
- **Active** only where the sun does not reach at least `ACTIVE_SHADE` (0.5 %) of the circuit's surroundings (the fine grid's nodes inside its bounds), or when the
  sun is altogether below the horizon (the shader answers "dark" without a lookup): the far side of some mountain is no reason to touch a noon. Inactive: `xrSunVis[0].w`
  (the strength) is 0, the shaders return 1 at the first line, nothing else of the picture changes. The strength is the weather's own `shadowIntensity`: a rain deck casts no shade for a hill to take away.
  At night the light-casting body is the moon (42 degrees up): the same map is made for its direction at no cost, and no hill is high enough to hide it, so it is idle.
- **Where it is applied** (`src/render/shaderPatches.ts`, GLSL `SUNVIS_PARS`: `xrSunVisAt(world position)`): the lights block scales light 0 (the sun) by the share the fragment sees,
  diffuse *and* specular, outside the `receiveShadow` test (so the grass, the trees, the cars, the barriers, the buildings, the water and the snow's sparkle all agree; `xrSunVG` is the
  per-fragment value the rest read). Also the particles' vertex stage (`fx/particleShaders.ts`: puffs, mist, chips and the snowfall), the trees'
  translucency (`track/scene/trees.ts`), the snow's glitter (`track/scene/snow.ts`) and the driving line's fog (`drivingLine.ts`). The lookup has no branch that depends on the fragment (both grids are read,
  the one the point is not in clamped to its block's edge and weighted 0): a version with three paths through it made the shader compiler take 0.7 s longer over the programs of a race.
  The cascades themselves stay as they are, but where the terrain hides the sun from everything a view's cascades cover (`coveredByShade`: the focus and a ring of 8 points at 0.8 of the far cascade's radius,
  all at the height of the tallest caster, nothing above a hundredth of the disc) `RenderSystem.fitSun` stops drawing them (`shadowsLive`, per view) and sets their shadow intensity to 0
  (`SunShadows.setDark`), which every shadow-receiving program already answers with a uniform early-out, before the taps: in the shade the frame is shorter than it was (Aurelia at golden hour
  4.5 ms of GPU against 3.6, Kuroyama 7.6 against 5.1).
- **Haze** (`atmosphere.ts`, `environment.ts`, the fog chunks): the atmosphere model keeps the sun's single-scattering part of every fog-table entry apart from the sky's
  (`SkyModel.fogTableSun`, 60 to 94 % of the horizon's luminance; `EnvSolution.fogTableSun` goes through the same desaturation, scaling and deck flattening, clamped below the total).
  The sunlit share of the view ray (`xrSunHaze`: five taps of the coarse grid, at equal fog factor, placed by the closed form of `F = 1 - exp(-d^2 z^2 - rain z)`) is worked out at the vertices
  (`fog_pars_vertex`/`fog_vertex`, varying `vFogSun`: it varies over kilometres of air, and five reads per fragment made the programs a second slower to build and the frame slower to draw), and
  `xrFogColorLit` scales the sun part of the colour by it, keeping `SHADE_HAZE_GLOW` (a quarter) of it: the air in the shade of a hill is lit from the side by the bright sky above the ridge, so a hidden
  sun leaves a hazy silhouette with a glow above it, not a dead teal. The sky itself keeps its glow; a ray in the sun gets the old colour bit for bit (`sunlitHaze` and `hazeSunShare` are the CPU twins, tested for it).
- **The shade fill** (`src/render/shadeFill.ts`): the light of a circuit with the sun behind a ridge is the sky's alone, dimmer and bluer than the look was set for, and the shade read dark, flat
  and teal. `shadeFill` is a diffuse-only `HemisphereLight` (no glints; always in the scene, at intensity 0 while no map is on, so that the programs of a race do not depend on what the map makes of it) whose
  axis points at the sun, a little up; its sky side is the colour of the horizon's glow there (35 % toward the sun's own, 25 % toward grey), its ground side the same hue, a quarter as strong. It gives back `fillGain` (1.1) of the sun
  a surface at a typical slant loses (`sunSlant(sin elevation)`: the ground catches sin(elevation) of the sun, what stands on it a quarter, so a sun 3 degrees up has hardly anything to give back and one at
  8 degrees a little). Its intensity per view is the shade the view's car is in (`1 - visibilityAt(focus)`, smoothed over half a second so that a long penumbra shows no step) times how much the camera looks toward
  the sun (`fillViewScale`: all of it facing the glow, where the road, the trees and the car are backlit and the picture needs it, 0.45 of it looking away, where the same surfaces face the glow
  and with all of it the grass of a shaded straight would be brighter than the sun ever made it). `render.fillGain` and `render.sunVis.hazeGlow` are the dials.
- **Cost** (high, 1600 x 900, vsync off; GPU ms per frame): on a spot in the sun while a map is on (Aurelia, golden hour) the map costs +0.2 (4.7 with the strength at 0, 4.9 at 1, in alternating blocks of one session:
  most of it is the haze at the vertices, +0.15); at noon, where no map is put to use, nothing measurable; in the shade less than before, because the cascades are not drawn (Aurelia 4.6 against 3.7, Kuroyama 7.5 against
  4.8, against the commit this branch started from). The map takes 0.1 to 0.6 s of CPU in slices (3 to 9 MB), hidden in the compile; a race loads in the time it did (8.5 s against 8.2 on Aurelia, within the noise).
  A lit program has one more sampler (14 of the 16 units on the terrain's on High, 15 on Ultra).
- **Parity.** A branch against the commit it started from, five circuits at morning and noon, three spots a lap, chase and cockpit, 1280x720 with SMAA, the car and the camera posed by hand (its state rounded, so
  that two builds pose it by the same numbers) and the frame counter that seeds the film grain pinned: 57 of the 60 pictures identical to the bit but for a few speckles on the car's silhouette, the other 3 within
  0.05 levels of the mean (leaves). Without the rounding the pictures differ by up to 0.17 levels at the edges of thin things, as much as two runs of one build do.
- **Probes and tests:** `tests/render-sunvis.test.ts` (a synthetic ridge: behind it dark, above its shadow line lit, a penumbra that grows with distance and rises monotonically, the sun overhead lights everything,
  two occluders against a march), `render-sunvis-gpu.test.ts` (the GLSL emulated in TS against the CPU twin and against a fresh independent field), `render-sunvis-haze.test.ts` (the sun's part never above the total, a fully
  shadowed ray keeps only the sky's and the glow, a fully lit one is the old colour, the shape of the patches), `render-sunvismap.test.ts` (the map of a race: caching, overtaking, a failing terrain, the weather, half floats),
  `render-shadows-dark.test.ts`, `render-shadefill.test.ts`, `track-drawn-height.test.ts`; `tests/probes/sunvis-probe.test.ts` (`SUNVIS_PROBE=1`) prints the map's verdict along every circuit's centreline against a march of the same ground.

## Winter circuits

A circuit with `TrackInfo.winter` (Isvik: packed snow, a frozen lake, snowbanks for walls) is one flag that every system reads for its own
purpose. Nothing else changes for the other four circuits: a road circuit gets the very same objects, numbers and shaders as before.

- **Surfaces** (`src/physics/surfaces.ts`): `snow` (packed road, 0.50 of dry asphalt), `ice` (the studded lake, 0.40) and `deepsnow` (beside
  the road, 0.32, with ploughing drag and a heavy rolling term). `SurfaceProps.fresh` is the grip kept under a heavy fall of fresh snow: on a
  winter circuit the world's `wetness` *is* that snow (`wetGripFactor`), so no water film, no aquaplaning and no wet-tyre window.
- **Tyres** (`src/physics/compound.ts`): `fitCar(def, track)` returns the car itself on a road circuit and a copy on studded winter tyres on
  a winter one; `PhysicsWorld.addVehicle`, `AIDriver` and the steering filter all read the fitted car, so physics, AI and aids agree. A studded
  tyre peaks later (10 degrees, slip ratio 0.16), falls off gently (`slideRatio` 0.9) and hardly minds load: the car slides without letting go.
  The studded tyre keeps the all-terrain trait of the tyre it replaces (the Mammoth's) and drops the slick one (the LMP-X's), see below. The thermal model runs in air at -6 degrees (`WINTER_AMBIENT_C`). The stick is scaled to the grip of the snow or the ice under the front
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

## The Mammoth: all-wheel drive and the all-terrain tyre

`CARS[4]`, class `SUV`: 2.45 t, 710 hp, 8 speeds, 4x4 on 315/55R20 all-terrain tyres. It is the one car with all-wheel drive and with an all-terrain tyre, and the numbers
it is held to are in `tests/mammoth.test.ts` (the table in `tests/probes/mammoth-probe.test.ts`). The other four cars are bit for bit what they were: `tests/probes/four-cars.test.ts`
(`FOURCARS=record|compare`) drives them through open-loop drives on every surface, AI laps and packs and writes the whole state, and the two files must be equal.

- **Drivetrain** (`Vehicle.solveDrivetrain`): the gearbox output is divided `frontSplit : 1 - frontSplit` between the axles (a planetary centre) and the centre differential (open, a
  clutch pack with preload and power/coast lock, or locked) moves torque between the axles until their *output shafts* turn alike. The shafts are the axles' mean wheel speeds times a
  ratio that makes them equal when the car rolls (`centerRatioF/R`: the tyre radii; both exactly 1 for equal tyres), so unequal tyres do not wind a locked centre up. The handbrake lets the centre go
  (it acts on the rear wheels only). The front axle has its own differential (`frontDiff`, open) and the rear one `diff`. Traction control watches every driven wheel.
- **The all-terrain tyre** (`TireSpec.offroad`, `src/physics/surfaces.ts`): each wheel holds the table of surfaces its tyre meets (`tireSurfaces`): `SURFACES` itself, the same object, for a road
  tyre, and for an all-terrain one a table in which grass, dirt, gravel, sand and deep snow give back a share of the grip a road tyre loses (`grip + (1 - grip) K`, `OFFROAD_GAIN`), grass
  and dirt are less treacherous wet, and gravel, sand and deep snow cost a third less rolling and ploughing drag (it floats). Asphalt, kerb, concrete, packed snow and ice are the same for every tyre,
  so its price on the road is its lower `mu`. On a winter circuit the studded tyre keeps the trait (`compound.ts`): it acts on the deep snow beside the road and nowhere else.
- **Heat** (`TireSpec.heatScale`): the tread warms by the work of the tyre divided by its thermal size; the Mammoth's tyres, twice the rubber under twice the force, run at 70 C like a sports car's.
- **The AI** (`src/ai`): the throttle governor watches every driven wheel (`frontDriven`/`rearDriven`); the share of its weight an AWD car can put to work is `awdTractionShare`
  (`src/physics/traction.ts`: the front split, the weight distribution, the height of the centre of gravity and how far the centre differential can move the drive; 1 for the Mammoth's clutch pack);
  the speed profile and the driver read the grip of the ground from the car's own table (`carSurfaces`, `carLineGrip`), the per-track caches (`lineSurfaces`, the edge hazards) staying the track's.
- **Rolling over**: a wall, a snowbank and loose ground do not tip it in this model (the tyres hold 1.05 g, a rollover takes 1.2; `tests/probes/rollover-probe.test.ts`), and a hard flick lifts an inner wheel
  for a moment (the suspension leans 5 degrees at the limit). No automatic reset is needed.

## The racing slick: the LMP-X on loose ground

The LMP-X is the one car on racing slicks (`TireSpec.slick`): smooth, soft rubber with no tread, the stickiest tyre in the game on asphalt, kerb and concrete and the weakest on anything else. It is the other end of
the scale from the Mammoth's all-terrain tyre, and the numbers it is held to are in `tests/slicks.test.ts` (the tables in `tests/probes/slick-probe.test.ts`).

- **One scale** (`treadOf`, `src/physics/surfaces.ts`): a tyre's place between the slick (-1) and the all-terrain tyre (+1) is `offroad` - `slick`; a road tyre is 0, and so is a tyre with both traits. `tireSurfaces`
  works one table out per value (`SURFACES` itself at 0, so every road tyre is untouched to the bit), `carSurfaces` gives a car the table of its worse axle, and everything that reads the grip of the ground per
  car reads that table: the wheels (so the ESC's yaw limit too), the AI's speed profile (`ProfileJob`) and its driver (`carLineGrip`, `surfGrip`), the driving line and the braking assist (`DrivingGuide`). The per-track
  caches keep their meaning: the edge hazards ask which ground beside the road is slippery in the wet (kerb, grass, gravel, sand: yes; tarmac and concrete: no), and a slick answers as a road tyre does.
- **The table** (`SLICK_LOSS`): a slick grips by adhesion on a clean, hard road, and that is all of its lead (a peak mu of 1.6-1.9 on dry asphalt against a road tyre's 1.0-1.1). Loose ground has nothing for that
  to work on and the slick no tread to key into it: the real peak figures, a road tyre against a slick, are 0.45 / 0.30 on dry grass, 0.25 / 0.10 on wet grass, 0.60 / 0.40 on dry dirt, 0.50 / 0.30 on gravel and
  0.40 / 0.30 on dry sand, 0.6-0.75 of a road tyre's where it has 1.5 times on asphalt. The model's shares are of the tyre's own asphalt grip and the LMP-X's mu is 1.4-1.6 times a road tyre's, which is 0.45 of the
  table's grip, and the downforce that presses a slick into soft ground gives less back than the model credits it, so grass, dirt and gravel keep **0.40**, sand 0.42, deep snow 0.45. Wet turf and wet dirt keep 0.7
  of their wet factor (a smooth tyre aquaplanes on turf), gravel and sand drain and keep theirs, and a wide smooth tyre digs in: rolling x1.2 and ploughing x1.3 in gravel, x1.15 and x1.25 in sand, x1.1 in turf and dirt.
  Asphalt, kerb, concrete, packed snow and ice are the very same objects in every table, so on a road the LMP-X is bit for bit what it was.
- **Winter**: `winterTire` drops the trait (the studded tyre has a tread of its own; the Mammoth's all-terrain trait is kept), so Isvik is unchanged for every car.
- **What it comes to** on a flat plane (lateral g held at 60 / 120 km/h; the stop from 60 / 120 km/h with ABS; the LMP-X before the rule in brackets): dry grass 0.40 / 0.43 g (0.92 / 1.17) against the road cars' 0.55-0.63 and the
  Mammoth's 0.71-0.74, and 31 / 106 m (13 / 46) against 20-22 / 76-86; wet grass 0.18 / 0.15 g (0.55 / 0.65) against 0.36-0.38, and 63 / 204 m against 33 / 124-128; gravel 0.29 / 0.25 g (0.95 / 1.17) against 0.52-0.62.
  The order Mammoth > road cars > LMP-X holds on every loose surface, dry and wet, in lateral g and in the stop. It is beached, not stuck, on turf, dirt and gravel (20 km/h from a standstill in 2-8 s), and bogged down in sand, where a
  road car is nearly too. The AI keeps its racecraft: in a pack at Brennwald the LMP-X has a wheel on loose ground for a fifth of the lap, yet its solo laps change by under half a percent (no reset, no hit), and in 48 races
  of twelve on Aurelia, Kuroyama and Brennwald, dry and wet, no car hit a wall or needed a reset, with the slicks as without them.

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
  The press that closes the pause menu does not fire one. With `Settings.nitro` off (Settings, Gameplay) every tank is updated as not running, so
  none is ever ready (a press and the AI fire nothing, a burning shot goes out), and the HUD gets no gauge; B and E stay unbound.
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
