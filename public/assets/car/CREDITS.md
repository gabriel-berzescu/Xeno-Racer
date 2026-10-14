# Car visuals — assets and credits

`src/carvis` ships **no downloaded assets**. Everything is generated at load time:

- car bodies: signed-distance-field sculpts, polygonized in a Web Worker (`src/carvis/build.ts`);
- wheels, brake discs, calipers, aero parts, cabin, driver, steering wheel: procedural meshes;
- liveries, tyre lettering, carbon weave, dash screens: canvas / shader generated.

Real-car side/front photographs from Wikimedia Commons (CC-licensed) were used **only as private
proportion references while modelling** (overlaid in the sandbox); they are not part of the repo and no
pixels or geometry are copied from them. All car names, makers and logos in the game are fictional.

The sandbox studio lighting (`sandbox/car/studio.ts`) is a procedural emissive-panel room; no HDRI is used.
