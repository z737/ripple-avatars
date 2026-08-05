# Ripple Avatars

Generative chromatic-ripple avatars for voice identities. One WebGL2 fragment
shader, seeded per voice, with a parameter playground.

```bash
npm install
npm run dev
```

See [PLAN.md](PLAN.md) for the full architecture and the analysis of how the
reference artworks actually work (§1) — that analysis is what the shader
implements, and it's worth reading before changing the pipeline.

## Two pages

Hash routing, no router dependency (`src/Router.tsx`):

| Route | Page | Purpose |
| --- | --- | --- |
| `#/` | Avatars | the seeded avatar generator and contact sheet |
| `#/playground` | Chromatic Ripple Playground | 500×500 exploration surface: draggable origins, water, audio |

The playground is a **second engine** under `src/playground/`, and a different
rendering model from the avatar page. The avatar page draws isolines of a wave
field. The playground treats the waves as a **height field**: one continuous
mesh-gradient material, embossed by additive and multiplicative wave
interference, revealed by a directional light through analytic surface normals,
with normal-driven chromatic refraction. Nothing maps a wave value to a colour.
See [PLAYGROUND.md](PLAYGROUND.md).

## What's built

Phases 0–4 of the plan, plus the seeded identity model from Phase 5.

| Area | Status |
| --- | --- |
| WebGL2 renderer, fullscreen-triangle single pass | done |
| Wave field: 1–4 anisotropic sources, product↔sum interference | done |
| Isoline contouring with `fwidth` antialiasing | done |
| Chromatic layers with per-layer offset + OKLab mesh gradient | done |
| Derivative-based fake surface lighting | done |
| Three-tier per-channel grain | done |
| SDF shape masks (full / circle / square / capsule / drop) | done |
| Seeded genome, palettes, reference presets | done |
| Contact sheet, static-bitmap mount policy | done |
| 2048px PNG export | done |
| Audio reactivity (mic / TTS), pointer interaction | not started — Phase 6 |
| Automated perceptual fitting against references | not started — Phase 5 |

## Layout

```
src/engine/     avatar renderer, shader, params, genome, palettes, export
src/playground/ playground engine: height-field shader, genome, validator, audio, tiering
src/pages/      PlaygroundPage
src/ui/         controls, canvases, contact sheet
src/Router.tsx  hash routing
src/index.css   design tokens
```

The uniform list in `engine/Renderer.ts` and the `RippleParams` type in
`engine/params.ts` must stay in step with `engine/ripple.frag.glsl`. Adding a
control means touching those three plus `RANGES`.

## Design tokens

Colours, typography, spacing and component styling come from the Vachana
Playground Figma variables, resolved into CSS custom properties in
`src/index.css`. Components mirror that file's set: Buttons/Secondary,
Horizontal tabs, Input dropdown, Featured icon. Layout is this app's own.

## Three things that are easy to get wrong

**Line width is resolution-scaled.** Cell spacing scales with render resolution
but a pixel line width does not, so a fixed width covers far more of each cell
in a 384px thumbnail than in a 2048px export — same parameters, different
artwork. `scaledLineWidth()` in the shader keeps ink coverage consistent.
Removing it makes thumbnails and exports diverge from the preview.

**Chromatic split is divided by density.** As an absolute offset it exceeds a
whole cell at high density and floods the paper.

**Ink hue uses a sharpened weight, not a mean.** Averaging overlapping layers'
hues turns saturated strokes into pastel mush. `m*m*m` weighting lets the
dominant layer win.

## Identity

`paramsFromSeed(seed)` is the whole identity mapping. Persist one seed per
voice — it is not a cache, it's the avatar. "Randomise" mints a new seed rather
than new pixels, so every avatar stays reproducible from `(seed, engineVersion)`.

Structural randomness is generated in JS and uploaded as uniforms, never derived
GPU-side: shader float precision differs across hardware, and an avatar must
look the same on every device.
