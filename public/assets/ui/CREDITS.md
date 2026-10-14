# UI assets (owner: ui)

All fonts are SIL Open Font License 1.1 (full text next to each family in `fonts/OFL-*.txt`),
downloaded from the Google Fonts GitHub repository (`github.com/google/fonts`, `ofl/` directory),
then subset to Latin / Latin-1 / Latin Extended-A / general punctuation and converted to WOFF2
(`fontTools.subset`, no glyph or outline changes; OpenType features kept).

| File(s) in `fonts/` | Family | Copyright | Used for |
|---|---|---|---|
| `BarlowCondensed-{500,600,700}.woff2`, `BarlowCondensed-{700,800,900}-italic.woff2` | Barlow Condensed | Copyright 2017 The Barlow Project Authors (https://github.com/jpt/barlow) | display, labels, menus, speed readout (`tnum` for tabular figures) |
| `Barlow-{500,600}.woff2` | Barlow | Copyright 2017 The Barlow Project Authors (https://github.com/jpt/barlow) | body copy and descriptions |
| `Oxanium-var.woff2` (variable, wght 200-800) | Oxanium | Copyright 2019 The Oxanium Project Authors (https://github.com/sevmeyer/oxanium) | timing and telemetry numerals (fixed-width digits) |

## Sandbox-only image

| File | Source | License |
|---|---|---|
| `backdrop.jpg` | "Goegap Road" HDRI by Greg Zaal (backplates by James Ray Cock), Poly Haven, https://polyhaven.com/a/goegap_road. Re-projected from the 8k tonemapped JPG to a 3600x1440 rectilinear view (yaw 14 deg, pitch -4 deg, 84 deg hfov) and re-encoded as JPEG. | CC0 |

Only `sandbox/ui.html` uses `backdrop.jpg` (a stand-in for the 3D scene the game renders behind the UI).
The game itself does not load it.
