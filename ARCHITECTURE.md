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
| `src/core/*` (other) | lead | settings, small shared helpers |
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
