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

## Three versions

One platform — **Avatar Playground** — with a version picker in the navbar. Hash
routing, no router dependency (`src/Router.tsx`); versions are declared once in
`src/versions.ts`.

| Route | Version | Purpose |
| --- | --- | --- |
| `#/v1` | Isoline avatars | the original seeded generator and contact sheet |
| `#/v2` | Chromatic ripple | 500×500 surface: analytic, medium, ink and heatmap engines, draggable origins, pointer and mic interaction |
| `#/v3` | Tile mark | **default.** Sixteen components, one hue, gooey hover. Three layouts: Square, Circle, Abstract |

Landing without a version normalises the URL to `#/v3` via `replaceState`, so the
address bar always names what is on screen without adding a history entry.

v3 shares only the seed system and the design tokens — no waves at all. Its three
layouts place the same sixteen components differently: a 4×4 grid, a polar disc of
1 + 5 + 10, and **Abstract**, where each component is a cluster of small squares
grown on a 16/32/64 grid and fused into an organic blob. See
[v3 in three notes](#v3-in-three-notes).

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
src/engine/     v1 avatar renderer, shader, params, genome, palettes, export
src/playground/ v2 engine: height-field shader, genome, validator, audio, tiering
src/v3/         v3 engine: tile SDF shader, abstract mask generator, OKLCH shades
src/pages/      PlaygroundPage (v2), TilesPage (v3)
src/ui/         controls, canvases, contact sheet
src/versions.ts version registry
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

## v3 in three notes

**The goo is a smooth minimum, not a blur.** The usual web gooey effect blurs the
shapes and pushes the result through a contrast curve to snap the edge back. In a
distance field, `smin` does it directly: where two fields come within `k` they
blend with a fillet, and that fillet *is* the goo. No offscreen pass, no fill-rate
cost per frame, and the corner radii stay sharp everywhere the merge is not
happening. The blend factor also drives the colour mix, so a merged neck reads as
a gradient between its two components rather than one colour winning.

**Abstract needs two fillet radii, not one.** A cluster only stops looking like
the squares it was cut from once the fillet is roughly a whole cell wide — but the
channel left between two unbonded clusters is about one cell wide too. One radius
for everything welds the whole disc together and `Bonding` controls nothing
(measured: 13 clusters collapsing to 2 islands). So the mask carries a
**cluster id** alongside the component id, and the shader smooth-mins within a
cluster and hard-mins between them. A hard min never bulges, so the channels stay
exactly as wide as the geometry makes them, and the hover fillet is the only thing
that crosses — which is the interaction.

**Abstract's cost is flat in grid resolution.** 64×64 is 4096 cells, far past any
uniform array, so the mask lives in an `RG8UI` texture and each fragment only
evaluates the cells that can actually reach it. That bound is exact rather than a
guess: `sminBlend` clamps its blend factor, so a field further than `k` away
contributes precisely zero. Nine texel fetches at rest and twenty-five under
hover, whether the grid is 16 or 64.

## Identity

`paramsFromSeed(seed)` is the whole identity mapping. Persist one seed per
voice — it is not a cache, it's the avatar. "Randomise" mints a new seed rather
than new pixels, so every avatar stays reproducible from `(seed, engineVersion)`.

Structural randomness is generated in JS and uploaded as uniforms, never derived
GPU-side: shader float precision differs across hardware, and an avatar must
look the same on every device.
