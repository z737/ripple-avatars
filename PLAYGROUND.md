# Chromatic Ripple Playground

`#/playground` — a 500 × 500 exploration surface for the ripple family.

The rule the renderer is built around:

> **Do not draw the ripples. Build a virtual surface from the ripples.**

Nothing in the shader maps a wave value to a colour. The palette supplies one
continuous sheet of pigment; the waves displace a virtual surface; a directional
light reveals it. Set Chromatic and Grain to zero and the image is still fully
dimensional — that is the test, and it passes.

## Pipeline

```
seed → 2–4 permanent origins
     → analytic warp (exact Jacobian)
     + up to 4 transient ripples, as a DISPLACEMENT of these coordinates
     → additive field   A = Σwᵢ / n
     + multiplicative   M = Πwᵢ · √2ⁿ        ← the moiré term
     → H = mix(A, M, interference)
     → profile remap (thickness)
     → ∇H (analytic, closed form)  →  surface normal
     → directional light: diffuse + signed-slope highlight / shadow + specular
     → normal-driven chromatic refraction of the pigment
     → restrained self-reflection → tonemap → grain → SDF shape mask
```

One fragment shader, one pass, no render targets.

## What the two references contributed

**Moiré Interference** — per-source frequency offsets are what create the beats
(`×1.07`, `×0.93`, `×1.13` there; a spread/tuned ratio pair here), `r0*r1*r2*r3`
for the moiré term against `(r0+r1+r2+r3)*0.25` for the additive one, and the
slow "breathing" of ring spacing that keeps a static composition alive.

**Moonlit Ripple** — height and its analytic derivative accumulated in the same
loop, then `normalize(vec3(-dh.x, 1.0, -dh.y))`; and the pointer ripple as a
radial wave differentiated by the chain rule, `(delta/r) * cos(phase) * freq`,
so the disturbance changes the *normals* rather than being drawn on top.

## Seven things that are load-bearing

**Interference blends two fields, as height.** A sum of sines is physical
superposition — concentric rings stay readable. A *product* generates sum and
difference frequencies, which is what turns overlapping rings into cells,
capsules and hollow repeating intersections. The product is normalised by
`√2ⁿ` because a product of n sines has RMS `(1/√2)ⁿ`; without it the surface
would flatten every time a wave was added.

**Derivatives are analytic, never `dFdx`.** Screen-space derivatives quantise to
the pixel grid and fall apart exactly where the interference gets tight, and
they cannot be evaluated at the three offset positions chromatic refraction
needs. The product rule is applied exactly; so is the warp's Jacobian.

**The warp is sinusoidal, not fbm.** Four low-frequency sinusoids have a closed
form Jacobian, so `∇H` is transformed back into unwarped space exactly. With an
fbm warp the normals would describe the *unwarped* surface and the lighting
would disagree with the geometry precisely where the warp is strongest.

**Wave Depth is a slope, not a contrast.** Because the gradient is divided by the
base frequency, `waveDepthToScale` *is* the surface's typical slope. Past about
1.0 every flank saturates the highlight and shadow terms and the material stops
reading as relief and starts reading as black-and-white stripes. It is also why
Density no longer changes how hard the light hits: denser means proportionally
smaller ripples, not ever-steeper walls.

**Lighting is normalised so flat returns the pigment unchanged.** `lambert` is
divided by the light's own elevation and the flat base sits at 0.82, leaving
headroom for highlights. Without that the pigment clips to white and the mesh
gradient the material is made of stops being visible. Highlights keep the hue of
the pigment beneath them; shadows are darker pigment, never black.

**Chromatic refraction needs a big offset.** The pigment is a very smooth
gradient, so the classic ±8% channel ratios sample three near-identical colours
and nothing separates. The separation comes from sampling far enough apart to
actually cross the gradient — hence a 0.2 UV offset scaled by `normal.xz` with
1.4 / 1.0 / 0.6 ratios. Flat areas have no normal deflection, so they get no
separation at all; the fringes appear only on slopes.

**Disturbances displace, they do not add.** A ripple does not contribute height.
It displaces the coordinates the permanent waves are read at, so the existing
waveform bulges, compresses and flows as the front passes — the way a reflection
deforms on rippled water — instead of a second set of concentric rings appearing
over the top. Its Jacobian goes into the same chain rule as the warp's; without
that the normals would describe the undisturbed surface and the light would
slide over the deformation without registering it.

Displacement is capped just under the fold: the map `q = p + n·f(r)` stops being
one-to-one once `f'(r) > 1`, and past that a clean ring turns into chatter.
Since `f' ≈ amplitude × frequency`, amplitude is scaled by
`INTERACTION_REF_FREQ / freq` so the margin holds across ripple frequencies —
a broad slow ripple can travel further than a tight fast one. The field is also
tapered to zero at the touch point, because a radial field carries an `f(r)/r`
term that would otherwise blow the Jacobian up exactly where the user pressed.

## Coherence and clean fringes

The additive branch is a **complex phasor sum**, not a sum of sines:

```
ψ(p) = Σ  Aᵢ/√rᵢ · e^i(k·rᵢ + φᵢ + ωt)
```

A bare `sin(kr)` carries only the instantaneous displacement, so there is no way
to ask where the nodes *are* — only where the surface happens to be right now.
Carrying both components gives two readings of the same field:

| | |
|---|---|
| `Re(ψ)` | the displacement, which oscillates |
| `\|ψ\|` | the envelope, which does not |

Because the time term sits inside the phase and every source shares it at full
Resonance, `e^(iωt)` factors out of the sum — so `|ψ|` is genuinely constant in
time and the nodal lines never move. That is Young's pattern, and the **Fringes**
control blends from the live displacement to that standing envelope.

Amplitude falls as `1/√r` — cylindrical spreading in 2D. Without it the fringes
have no envelope and the field reads as a flat plaid rather than as waves
radiating from somewhere.

Two things had to become exact for this to be clean, and both were wrong before:

- **Resonance 1 means one wavelength**, not within 2.8%. The beat period is the
  reciprocal of the frequency difference, so even a 2% mismatch makes the whole
  pattern crawl.
- **Drift converges with its sign**, not `sign(drift) * 0.22`. Opposite signs left
  the sources counter-rotating, which swept the fringes across the frame no matter
  how well matched their frequencies were.

**Young fringes** is a pattern family: a `slit` layout puts a close, equal,
isotropic pair just outside one frame edge, so the frame shows the fan of nodal
lines rather than the sources. Unequal amplitudes let one source dominate and you
see its own rings instead of interference; anisotropy, radial power and warp all
bend the wavefronts out of step. The family pins all four.

Note the slit pair has to stay inside the legal origin range — a per-coordinate
clamp pulls one source in and not the other, which breaks the pair's symmetry and
with it the fringes.

**The medium engine cannot do this.** Clean fringes need monochromatic continuous
excitation; per-point frequency needs broadband impulses. Those are opposites, and
the medium is built for the second. Use the analytic engine for clean interference
and the medium for lively, physical, noisy water.

## Resonance

Each source stores two frequency ratios and two phases. Resonance interpolates
between them:

| | frequencies | phases |
| --- | --- | --- |
| 0 | spread — 0.78…1.30 of base | free-running |
| 1 | within ±2.8% of each other | locked to quarter turns |

Never exactly equal at either end: identical sources stop beating, and beating
is where the moiré comes from.

## Interaction

Four transient ripples in a fixed ring buffer; a fifth recycles the oldest.
Each displaces the field radially by
`n · sin(freq·front) · e^(−age·decay) · e^(−front²/width²) · strength` with
`front = r − speed·age`, evaluated analytically alongside the permanent waves.
Because they move the same coordinates, they automatically change the normals,
the highlights, the shadows and the refraction — the disturbance is *in* the
material, not drawn on it.

Microphone onsets go through the same `spawn()` path, so audio deforms the
waveform exactly as a fingertip does; bass passes a `broad` flag that lowers the
frequency and widens the front, which — through the frequency scaling above —
also gives it a larger displacement.

Emission is throttled on pointer distance, speed and elapsed time together —
slow movement gives broad low-frequency deformation, fast movement tight strong
impulses, a tap one strong radial impulse. Ripples are **culled** once decayed
below 1% rather than left to asymptote, which is what makes the return to the
seed-defined state exact: verified by frame hash, base and post-interaction
frames are byte-identical.

Shapes are Full, Circle and Rounded. Drop and Blob were removed — a teardrop or
a wobbling blob silhouette fights the wave geometry rather than framing it.

## The medium engine

`Engine: Medium` swaps the closed-form waves for a real simulation: **one
physical scalar field** on a 256 lattice, in real units, stepped at a fixed
1/240s.

```
du/dt = v
dv/dt = c²∇²u − ω₀(p)²u − γv + F(p,t)
```

A damped Klein-Gordon equation — a membrane on an elastic foundation. The
`ω₀(p)²u` term is what makes every point a resonator in its own spring rather
than a bead on a string, and it gives the medium a dispersion relation
`ω² = ω₀² + c²|k|²`, so the per-point frequency decides whether energy
propagates, and a spatially varying `ω₀` refracts waves toward the slacker
regions.

**One field, not four.** Every origin, every pointer touch and every syllable
forces the same `u`. Interference here is genuine linear superposition, with real
beats between detuned sources, real nodal lines and real reflection off the
boundary. An earlier version ran four independent fields and multiplied them at
render time: convincing moiré, but multiplication is an operator applied to two
fields, not an interaction between them.

**State is (u, v)**, which is complete, so this ping-pongs between two textures.
An earlier leapfrog also needed u(n−1), and reading that from the texture being
rendered into is the feedback loop GL forbids — it silently wrote nothing and
failed with `INVALID_OPERATION` until it got a third buffer.

Controls map to physics: **Density** is the wave speed `c` (a slower medium
carries shorter waves), **Vibration** is `ω₀` and its spatial spread, and
**Interference** is the balance of drive between origins — one dominant source
gives readable concentric rings, four equal ones give nodal lines and beat cells.
With one field there is no additive-versus-multiplicative choice to make;
superposition is superposition.

**The boundary absorbs rather than reflects.** A free boundary sent waves back:
they reached the lattice edge, bounced, and returned through the frame as
criss-crossing standing structure. Damping now ramps up smoothly through a margin
outside the visible area, dissipating waves before they arrive. The ramp is
smoothstepped and squared because a *sharp* rise in damping is itself an
impedance discontinuity and reflects nearly as much as the hard edge did.

The margin sits **outside** the −0.5…1.5 origin range, not inside it — origins
are allowed out to those limits, and a sponge overlapping them would quietly damp
an off-frame origin to silence, losing the long arcs those positions exist to
produce. So the lattice spans that range *plus* the margin, at 384 across.

Measured after the change: a single tap decays 88% over 4.4s with no returning
energy, amplitude at the true boundary is 8% of the in-frame amplitude, and the
tap force needed raising 2.4x — the reflections had been recycling energy back
through the frame and quietly inflating the steady amplitude.

### Voice

While the microphone is live and voiced, the voice *is* the drive:

| | |
|---|---|
| **pitch** | the rate every point vibrates at |
| **loudness** | how hard they are driven |
| silence | no forcing at all — the field rings down and the avatar goes still |

Pitch comes from autocorrelation on the time-domain window, not from the
frequency bins (at this FFT size a bin is ~23Hz, most of a semitone at the bottom
of the vocal range). It is normalised against the zero-lag energy so the peak
height doubles as a confidence measure, which is what rejects breath and
sibilants instead of reporting a random pitch, and it takes the first local
maximum rather than the global one to avoid the octave error.

A 200Hz fundamental cannot be displayed directly, so pitch maps logarithmically
onto a visible 1.2–9Hz band: an octave of voice is a constant step of visible
rate. The floor is not lower for a physical reason — wavelength is
`2πc/sqrt(ω²−ω₀²)`, so a drive near the natural frequency makes waves longer than
the frame and one below it does not propagate at all. An earlier 0.45Hz floor put
a low voice under the cutoff and it excited nothing. Across this band a deep
voice reads as broad slow swells and a high one as fine fast ripples.

Measured, driving the medium with synthetic features: a 100Hz pitch produced
0.67Hz at a point in the field against 0.68 predicted, and 400Hz produced 3.5Hz
against 3.46. Loudness 0.2 → 0.9 raised amplitude 7.0x against 8.2 predicted.
Ten seconds of silence took the field from 0.358 rms to 0.011.

Two calibrations were measured rather than estimated: drive acceleration (a
Q-factor estimate was out by two orders of magnitude, because each origin
*radiates* and the escaping energy dwarfs the damping), and damping, which is set
by decay length — `v_g/γ` has to exceed the lattice or the far side of the frame
never receives anything.

Known limitation: the lattice is 256 across a domain twice the frame, so ~128
texels cover the visible area and the medium is visibly softer than the analytic
engine.

## Determinism

`configFromSeed(seed)` is the whole identity mapping. Randomisation works on
whole compositions — family, then a composition-aware origin layout (opposing /
diagonal / cluster / surround / outside / asymmetric), then the frequency
relationships, then values from ranges known-good for that family.

Candidates are validated on the CPU before they reach the GPU:
`playground/field.ts` mirrors the field maths — including the warp — and rejects
`flat`, `empty`, `chaotic` and `aliased` results. Two subtleties:

- The aliasing guard counts the **sum** of source frequencies for the
  multiplicative field and the **max** for the additive one, interpolated by the
  interference mix. Taking the max for both let cellular compositions through at
  roughly half the density they actually need.
- The threshold is 22px per oscillation, which is far above Nyquist. This is an
  avatar at 500px: below roughly 20px per cell it stops looking like relief and
  starts looking like corduroy, well before it technically aliases.

Density is also scaled down as waves are added (×0.8 at three, ×0.66 at four),
because each extra source multiplies into the moiré term and a product's spatial
frequency is the sum of its factors'.

Because the validator and the renderer must agree, every normalised control
becomes engine units in exactly one place: `playground/mapping.ts`.

## Controls

Seed · Waves · Edit Origins · Pattern · Density · Thickness · Interference ·
Resonance · Wave Depth · Warp · Stretch · Shape · Pigment · Ink base · Mesh ·
Light Angle · Light Intensity · Shadow Depth · Chromatic · Grain · Interaction ·
Audio.

**Pigment** is a swatch grid of the whole pastel set with the 1–4 colours in use
selected, not a list of named palettes. Two things that used to be authored per
palette are derived instead: attractor *placement* comes from the seed (a
canonical layout for the count, rotated by a seeded angle), and the paper tone
comes from the selection — its average hue at very low chroma. That second one
matters: using one of the chart's own pale tints as the base reads as a colour
rather than as paper and drags a multi-hue selection into a single wash.

Since every colour in the chart is high-value, a genuinely dark material is not
reachable from it at high Mesh. **Ink base** darkens the paper the pigment sits
on, so ink base plus a lower Mesh is the route to a deep look.

Thickness reshapes the wave *profile*, which is what thickness means once the
field is a surface rather than a set of drawn lines: low values square it into
plateaus joined by narrow steep walls, and only the walls catch the light.

Internal: per-source frequency, phase and amplitude; interaction frequency,
speed, decay and width; specular power; normal strength; attractor count;
refraction ratios; warp geometry; exposure; contrast; ambient level.

Light Angle is a dial with a lit sphere preview, because an angle in radians is
not something anyone can set by number.

## Debug views

`#/playground?debug` adds a selector for each stage: base mesh, additive waves,
multiplicative moiré, final height, surface normals, diffuse, highlight, shadow,
chromatic refraction, composite. Not part of the playground proper.

## Performance

Internal resolution comes from a GPU tier heuristic (`playground/gpu.ts`), never
from `devicePixelRatio`. At most 4 permanent plus 4 transient sources, all
analytic, in one pass — no simulation textures, no upsampling, nothing to
ping-pong. Rendering pauses when the tab is hidden or the canvas leaves the
viewport, drops to 30fps when nothing is happening, and parks entirely under
`prefers-reduced-motion` once the transients are gone. The frame loop does not
allocate.

## Not yet exercised

- **Audio reaction** is implemented — volume to ripple strength, bass to broader
  deeper impulses, mids to the interference clock, highs to refraction, onsets
  to new transient ripples at a wave origin — but has not been run against a
  live microphone. It is analyser-only: no recorder, no buffering, no network.
- **Integrated-GPU performance** is by design (one pass, ≤8 analytic sources,
  tiered resolution) rather than measured on such hardware.
- **Boundary-aware resonance.** Shapes are still clipping masks; the brief's
  later goal is for boundaries to drive real reflection and resonant modes.
