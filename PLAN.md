# Chromatic Ripple Avatars — Implementation Plan

Generative voice-avatar system. One WebGL2 fragment shader, seeded per voice, reactive to
TTS/mic audio, with a parameter playground and a calibration workbench.

---

## 0. Scope note on "exactly the same"

Two things are worth separating up front.

**Not achievable:** pixel-identical reproduction of those specific seven images. They are the
output of an unknown program with unknown seeds. Even with a correct algorithm family, the
seed→image mapping is not invertible, so "regenerate that exact artwork" has no solution.

**Achievable, and what this plan targets:** (a) the *visual language* reproduced closely enough
that a mixed set can't be sorted by eye, and (b) per-reference **calibrated presets** — a
`ref-05`, `ref-06`, `ref-07` preset hand-tuned and machine-fitted against each source image
until the perceptual difference is small. Phase 5 builds the tooling that makes (b) measurable
rather than a matter of opinion.

One flag, then it's your call: the references are Aleksei Ustinov's published works. Using them
as internal calibration targets for a style is ordinary practice. Shipping deliberate near-copies
of individually recognisable pieces inside a commercial product is a different risk profile —
worth a Legal/Brand check before the calibrated presets go to production. Recommendation: use
`ref-*` presets as internal ground truth for engine validation, then derive the shipped palettes
and structure ranges as a distinct Gnani visual language.

---

## 1. What the references are actually doing

The earlier analysis described smooth `sin(distance)` bands with post-hoc chromatic aberration.
Looking closely at images 3, 5, 6 and 7, that is not the mechanism. The evidence:

| Observation in the references | What it implies |
| --- | --- |
| Rings are **stroked outlines** with near-constant screen-space width, not filled sinusoidal bands | Isoline (contour) extraction of a scalar field, not `sin()` mapped straight to luminance |
| Centre regions show **rounded-square / superellipse cells** that elongate into capsules outward | Isolines of a **product** of two radial waves — `sin(a)·sin(b) = k` yields Lamé curves in the grid region and hyperbolic arcs away from it |
| The grid sits between two visual centres; arcs sweep away from it | Exactly **two dominant sources**; the fringe geometry is the classic two-source moiré hyperbola family |
| Dense regions fade to a **flat mid-tone** instead of aliasing into speckle | Line width defined in units of `fwidth(field)` — when field gradient exceeds pixel rate, coverage self-cancels |
| The base tone is a desaturated sage/tan **mid-value**, distinct from the warm off-white margin | Two separate colour fields: "paper" (field mid-tone) and "ink" (contours). The off-white is a frame, not the field |
| Contour hue drifts smoothly across the piece (cyan top-right → yellow centre → orange left in img 7) | Ink colour sampled from a **mesh gradient**, not per-ring constants |
| Adjacent contours in different hues, sometimes with pale/white cores where they coincide | N ink layers, each with its own frequency/phase/spatial offset, composited **additively** |
| Coarse RGB speckle visible in flat areas at roughly 1px scale | Independent per-channel noise at device-pixel scale, high amplitude (~8–15%) |

**Thesis.** The engine is:

```
warp coordinates (fBM domain warp)
  → 2–4 anisotropic radial wave sources
  → combine multiplicatively (moiré cells) ⟷ additively (soft beating)   [blendable]
  → extract isolines at 1–3 levels, width in fwidth() units             [self-antialiasing]
  → repeat per chromatic layer with offset freq/phase/position
  → colour each layer from an OKLab mesh gradient (ink field)
  → composite additively over a second mesh gradient (paper field)
  → fake lighting from dFdx/dFdy of the height field
  → per-channel grain (static paper + pigment + slow temporal)
  → SDF shape mask → tonemap
```

Everything in all seven references is reachable from that pipeline by parameter change alone,
including the navy panel in image 2 (dark paper field, low exposure) and the 16 blobs in image 4
(same field, small SDF masks, single-hue-family ink gradients).

### Key GLSL, in concrete terms

```glsl
// one anisotropic source ------------------------------------------------------
float sourceField(Source s, vec2 uv) {
  vec2 q = rot2(s.rot) * (uv - s.p) / s.scale;   // anisotropy → ellipse/stretch
  float r = pow(length(q), s.power);             // power>1 compresses centre → "tunnel"
  return s.amp * sin(r * s.freq + s.phase);
}

// interference: product gives cells, sum gives beats. Blend between them. -----
float field(vec2 uv) {
  float prod = 1.0, sum = 0.0;
  for (int i = 0; i < uSourceCount; i++) {
    float v = sourceField(uSrc[i], uv);
    prod *= v;  sum += v;
  }
  return mix(prod, sum / float(uSourceCount), uInterferenceBlend);
}

// isoline with analytic AA — this single line is why the refs degrade to flat
// tone rather than moiré speckle in dense regions.
float contour(float v, float level, float weight) {
  float d  = abs(v - level);
  float aa = fwidth(v) * 0.7071;
  return 1.0 - smoothstep(weight * aa, (weight + 1.0) * aa, d);
}
```

**Two non-obvious decisions that carry a lot of the quality:**

1. **Mesh gradients interpolate in OKLab, not sRGB.** An sRGB lerp between the cyan and orange
   attractors in image 7 produces grey mud at the midpoint; OKLab keeps the transition clean.
   This is a large, cheap quality win.
2. **Compute the domain warp once, before the chromatic layer loop.** Warping per layer costs
   `layers × octaves` noise evaluations (the dominant GPU cost) and is visually
   indistinguishable from warping once and applying the chroma offset after. ~4× saving.

---

## 2. Stack

| Choice | Decision | Why |
| --- | --- | --- |
| Renderer | **Raw WebGL2** + ~200 LOC wrapper | The scene is one fullscreen triangle. A 3D library's geometry/camera/scene-graph is 100% unused. Direct control matters for precision qualifiers, offscreen hi-res export FBOs, and shipping the production avatar small. If the team prefers less boilerplate, OGL (~8KB) is the fallback — no architectural change. |
| Fallback chain | WebGL2 → WebGL1 (reduced) → static bitmap | WebGPU is not yet Baseline across browsers; making it the foundation contradicts the broad-hardware requirement. Revisit as a fast path later. |
| Shell | Vite + React + TypeScript | Fast HMR; shader hot-reload via `vite-plugin-glsl` (gives `#include` for the GLSL library). |
| UI | Custom control components (~200 LOC) | The playground's look becomes product UI. `leva`/`tweakpane` would need replacing anyway. |
| State | Single `RippleParams` object + `useSyncExternalStore` | One source of truth shared by UI, uniform upload, seed genome, export, and preset serialisation. |
| Audio | Web Audio `AnalyserNode` | Time-domain + FFT is all that's needed. `AudioWorklet` only if pitch/phoneme work is added later. |

Uniform schema lives in **one** file (`engine/uniforms.ts`) and drives: the GLSL uniform block,
the TS `RippleParams` type, the control panel generation, and preset (de)serialisation. Avoids
the classic drift between shader and UI.

---

## 3. Structure

```
src/
  engine/
    Renderer.ts        WebGL2 context, program, VAO, uniform upload, RAF loop
    glContext.ts       capability detection, WebGL1 reduced path
    uniforms.ts        uniform schema — single source of truth
    params.ts          RippleParams type, defaults, ranges, quality tiers
    genome.ts          seed → RippleParams  (the identity mapping)
    prng.ts            mulberry32 + splitmix64
    palettes.ts        brand-constrained palette sets
    presets.ts         named presets incl. ref-01..ref-07 calibrations
    export.ts          offscreen FBO → readPixels → PNG/WebP at any size
    quality.ts         frame-time governor → quality tier
    shaders/
      ripple.vert
      ripple.frag
      lib/ prng · noise · warp · wavefield · contour · chroma ·
           surface · mesh · grain · sdf · tonemap  (.glsl)
  audio/
    AudioEngine.ts     mic | file | TTS <audio> → AnalyserNode (one interface)
    features.ts        RMS, 4 bands, transient detect, smoothing
    mapping.ts         features → uniform modulation
  avatar/
    RippleAvatar.tsx   shippable component — static by default, live on demand
    AvatarPool.ts      mount policy for lists (see §7)
    staticCache.ts     seed → cached bitmap
  app/
    App.tsx, panels/, controls/
    calibration/       overlay + difference view against reference images
  calibration/
    metrics.ts         histogram, radially-averaged power spectrum, gradient stats
    fit.ts             perceptual loss + hill-climb / CMA-ES parameter fitting
tools/
  batch-render.ts      headless contact-sheet generator (validates against image 1)
```

---

## 4. Phases

Each phase has a falsifiable exit criterion tied to a specific reference image.

> **Status:** Phases 0–4 built, plus Phase 5's seeded genome. Phase 1's exit
> criterion is met — the rounded-square grid appears between the two centres and
> elongates into capsule arcs, so the thesis in §1 holds. Phases 5 (automated
> fitting) and 6 (audio, pointer) are not started. Three corrections found during
> implementation are recorded in the README.

### Phase 0 — Harness
Vite + React + TS. WebGL2 context, fullscreen triangle, GLSL hot-reload, uniform plumbing from
the schema, one slider wired end to end.
**Exit:** slider changes a live gradient at 60fps; editing a `.glsl` file hot-reloads without
losing state.

### Phase 1 — Wave field core *(the crux)*
`wavefield.glsl`, `warp.glsl`, `contour.glsl`. Sources with position/anisotropy/rotation/
frequency/phase/power. Product↔sum interference blend. Multi-level isolines with `fwidth` AA.
**Exit:** greyscale reproduction of the *geometry* of images 6 and 7 — the rounded-square grid
between the two centres must appear and elongate into capsule arcs outward, and dense regions
must fade flat rather than alias. If this doesn't fall out naturally, the thesis in §1 is wrong
and we stop and re-derive before building anything on top.

### Phase 2 — Chromatic layers + colour fields
N ink layers with per-layer freq/phase/position offsets, additive composite. OKLab mesh gradient
for ink; second mesh gradient for paper. Exposure/contrast tonemap.
**Exit:** images 5, 6, 7 recognisable in colour side by side. Navy panel from image 2 reachable
by parameter change only (no code branch).

### Phase 3 — Surface + texture
Derivative normals → fake lighting (`Surface: Flat / Soft / Embossed / Glossy / Ink`). Contour
softness and bleed. Three-tier grain: static paper, pigment-in-colour, slow temporal.
**Exit:** blind side-by-side with a designer — the "printed" quality reads. Grain must not
strobe under animation.

### Phase 4 — Shape system
`sdf.glsl`: circle, superellipse, capsule, droplet, metaball, organic-distorted, full-bleed.
Mask applied to the composite, so ripple geometry is independent of silhouette.
**Exit:** contact sheet reproducing image 4's 16 blobs, including multi-lobe metaballs.

### Phase 5 — Identity + calibration *(the "exactly the same" phase)*
- `genome.ts`: `voiceId → hash → seed → RippleParams`. Structural randomness generated in JS
  and passed as uniforms — never derived GPU-side, since shader precision differs across
  hardware and would make avatars unstable per device.
- Brand-constrained palettes; structure families (Tunnel / Orbit / Interference / Vortex / Flow /
  Biomorphic) as named regions of parameter space, not separate shaders.
- **Calibration workbench:** reference image behind the canvas with opacity slider and
  difference blend mode.
- **Automated fitter:** perceptual loss = histogram distance + radially-averaged power spectrum
  distance + gradient-orientation histogram (not pixel L2 — L2 is meaningless against an
  unknown seed). Hill-climb, then CMA-ES on the ~40-dim parameter vector against a reference
  crop. This is what turns "looks close" into a number that can be driven down.
- `tools/batch-render.ts` contact sheets for eyeball validation against image 1.

**Exit:** `ref-05/06/07` presets converged; a 100-avatar contact sheet signed off as the same
family as image 1.

### Phase 6 — Motion, interaction, audio
Idle: very low-amplitude phase drift + breathing only. Pointer becomes an additional wave source
with damped-spring return (`Surface tension` parameter) — field deformation, not a hover
translate. Audio: Energy / Bass / Body / Presence + transient → global scale, wave displacement,
contour width, chroma split, emitted transient ripple. Audio *modulates* identity; it never
generates it. Honour `prefers-reduced-motion` (keep the avatar intact, drop continuous drift).

### Phase 7 — Productisation
`RippleAvatar` component; static-first mount policy (§7); quality governor; export (500² avatar,
2048² artwork, transparent variant); verification on real low-end Android Chrome and iOS Safari,
not just desktop throttling.

---

## 5. Performance budget

Per-pixel cost is dominated by the fBM warp, not the wave maths.

| Tier | Render res (upscaled to 500 CSS px) | Sources | Ink layers | Warp octaves | Grain |
| --- | --- | --- | --- | --- | --- |
| High | 640² | 4 | 5 | 4 | 3-tier |
| Balanced | 512² | 3 | 4 | 3 | 2-tier |
| Low | 384² | 2 | 3 | 2 | static only |

Deliberately **do not** multiply by `devicePixelRatio`. A 500 CSS-px avatar at DPR 3 would be
1500² — 9× the pixel work for no visible gain, since the grain masks resolution differences at
this art style. Quality tiers change cost, never design: an avatar must stay recognisably itself
across all three.

Governor: rolling frame-time median; step down a tier past threshold, step up only after a
sustained margin (hysteresis, to avoid oscillation).

---

## 6. Identity model

Random-per-session is the wrong product behaviour — an avatar that changes colour between
sessions stops functioning as identity. So:

- One **seed persisted per voice**, part of the voice configuration.
- "Randomise" generates a *new seed*, not new pixels; choosing one commits it.
- Every avatar is reproducible from `(seed, engineVersion)`.
- Engine version is stored with the seed. A shader change that shifts appearance must either
  be gated behind a version bump or explicitly accepted as a global restyle.

---

## 7. The real scaling constraint

Not the shader — the **number of simultaneously live canvases**. 40 animated WebGL canvases in a
voice library is wrong regardless of per-shader efficiency.

```
list item        → static seeded bitmap (rendered once, cached by seed)
hover / focus    → mount live renderer
selected voice   → full renderer + audio reaction
offscreen        → unmount, keep bitmap
```

This is also better design: motion becomes intentional rather than ambient. A shared-renderer /
scissor-rect approach is the alternative but costs materially more engineering for less clarity.

---

## 8. Open decisions

Answers to 1, 4 and 6 change Phase 5's parameter-space design, so they're worth settling before
that phase starts. Everything up to Phase 4 can proceed without them.

1. **Max avatars on screen at once** — 1, ~10 cards, or 30–50? Drives §7's policy aggressiveness.
2. **Brand-constrained palettes, or unconstrained RGB?** Recommendation: constrained. Unconstrained
   colour destroys visual consistency across a voice library within a dozen avatars.
3. **TTS-reactive, mic-reactive, or both?** Recommendation: TTS is the stronger product case —
   the avatar animating while the voice speaks. Same `AudioEngine` interface either way.
4. **Exports needed?** 500² runtime only, or also 2048² artwork / transparent variants?
5. **Oldest hardware that actually matters?** "Everything" isn't a budget. If low-end Android
   Chrome and iOS Safari are hard requirements, Phase 0 should include a device on the desk.
6. **Reference matching: internal ground truth, or shipped presets?** See §0 — affects the Legal
   question, not the engineering.

---

## 9. Fastest path to a go/no-go

Phases 0–2 are the whole technical risk. If the two-source interference + isoline thesis is
correct, images 5/6/7 will be visibly close by the end of Phase 2 with no surface shading, no
grain, and no shape masking. If it isn't correct, that shows up in Phase 1's greyscale exit
criterion — before any effort is spent on lighting, texture, identity, audio or productisation.

Suggested first milestone: **Phase 1 only.** Greyscale, one canvas, no UI beyond the sliders
needed to hunt for the geometry. Everything else is downstream of that answer.
