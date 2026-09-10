/* ---------------------------------------------------------------------------
   The only place normalised control values become engine units.

   Kept separate from the renderer because the randomiser's rejection pass has
   to evaluate the same height field on the CPU — if these curves lived inline
   in the renderer the validator would be checking a different surface than the
   one the GPU draws.
   --------------------------------------------------------------------------- */

import { ORIGIN_MAX, ORIGIN_MIN, PgConfig, PgSource } from './params'

/** Base angular frequency, radians per unit of UV distance. The moiré
 *  reference runs ~60 over a [-1,1] frame, i.e. ~120 over this 0..1 one; the
 *  range brackets that. */
export const densityToFreq = (d: number) => 16 + 150 * Math.pow(clamp01(d), 1.35)

/** Thickness reshapes the wave *profile*, which is what "thickness" means once
 *  the field is a surface instead of a set of drawn lines. Low values give a
 *  squared-off profile — flat plateaus joined by narrow steep walls, and the
 *  walls are the only thing the light catches, so they read as thin embossed
 *  ridges. High values relax it back toward a plain sinusoid: broad, soft,
 *  rounded swells. The remap is tanh-based so its derivative stays bounded and
 *  the normals never blow up. */
export const thicknessToProfile = (t: number) => lerp(2.9, 0.5, clamp01(t))

/** Virtual surface displacement. Not a contrast control: it scales the
 *  gradient that builds the normal, so it changes the *shape* of the surface
 *  the light is reading. */
/** Because the gradient is divided by the base frequency downstream, this
 *  number *is* the surface's typical slope: 0.33 is a ~18 degree tilt on the
 *  ridge flanks, 0.8 is ~39. Anything much past 1 pushes every flank past the
 *  point where the highlight and shadow terms saturate, and the material stops
 *  reading as relief and starts reading as black-and-white stripes. */
export const waveDepthToScale = (d: number) => 0.06 + 0.7 * Math.pow(clamp01(d), 1.4)

export const warpToAmp = (w: number) => 0.42 * Math.pow(clamp01(w), 1.5)

/** Refraction offset in UV units. Applied along the surface normal, so flat
 *  areas get nothing and steep ridges get the full amount.
 *
 *  Sized against the *pigment*, not the pattern. The mesh is a gaussian blend with
 *  attractor radii around 0.6, so two sample points have to be a good fraction of
 *  that apart before they return different colours. Since this is then multiplied
 *  by normal.xz — typically about 0.35 — and by the channel ratio spread, the
 *  number here has to be several times the separation you actually want to see. */
export const chromaticToOffset = (c: number) => 0.5 * Math.pow(clamp01(c), 1.15)

export const grainToAmp = (g: number) => 0.2 * clamp01(g)

/* ---------------------------------------------------------------------------
   The ink engine.

   A different reading of the same field: instead of lighting a surface, draw the
   *zero set* as stroked contours and colour each stroke from a second gradient.
   That is what the reference artworks do — hollow outlines of near-constant
   screen width, hue drifting with position, and neighbouring strokes in
   different hues because they sample the gradient at slightly offset places.
   --------------------------------------------------------------------------- */

/** Stroke half-width in pixels, at the 640px reference size. Thickness means
 *  literal line weight here rather than wave-profile sharpness.
 *
 *  The floor matters: coverage is normalised by the field's own slope, so this is
 *  a true pixel width — and below about 1px a stroke stops being a line and
 *  becomes speckle, since most pixels along it miss the isoline entirely. */
export const thicknessToStroke = (t: number) => 1.1 + 7.0 * Math.pow(clamp01(t), 1.2)

/** More separation needs more strokes to read as separation rather than as a
 *  shift of the whole pattern. */
export const chromaticToInkLayers = (c: number) =>
  Math.max(1, Math.min(5, 1 + Math.round(clamp01(c) * 4)))

/** Offset between successive strokes, as a fraction of one fringe spacing —
 *  divided by frequency at the call site so it never exceeds a whole cell and
 *  floods the paper at high density. */
export const chromaticToInkSplit = (c: number) => 0.62 * Math.pow(clamp01(c), 1.15)

/** How far apart in the ink gradient successive strokes sample. This is what
 *  actually produces the multi-colour fringe: a magenta stroke with a cyan one
 *  beside it. */
export const chromaticToInkHue = (c: number) => 0.1 + 0.42 * clamp01(c)

/** Brightening at genuine crossings, for the additive blend. */
export const chromaticToInkGlow = (c: number) => 0.25 + 0.5 * clamp01(c)

export const shadowDepthToAmount = (s: number) => 1.15 * clamp01(s)
export const lightIntensityToAmount = (l: number) => 0.25 + 1.35 * clamp01(l)

/** Peak radial *displacement* of the wave field, in UV units — not a height.
 *
 *  A disturbance drags the existing waveform rather than adding rings to it, so
 *  what matters is how far it moves the pattern. 0.024 is about a fifth of a
 *  wavelength at typical density: clearly a deformation, and just under the
 *  point where the coordinate map folds back on itself and the ring turns into
 *  chatter. `INTERACTION_REF_FREQ` keeps that margin constant across ripple
 *  frequencies — folding depends on displacement x frequency, so a broad slow
 *  ripple can travel further than a tight fast one. */
export const interactionToDisplacement = (i: number) => 0.024 * clamp01(i)
export const INTERACTION_REF_FREQ = 40

/* ---------------------------------------------------------------------------
   The oscillator medium.

   Everything below is in per-step, dimensionless units, because that is what
   keeps a lattice stable: the sim knows nothing about seconds, only about
   steps, and it is stepped at a fixed rate.

   The medium obeys  W^2 = W0^2 + k * |wavevector|^2. Two consequences drive the
   whole mapping:

   - Below the cutoff (drive under W0) the response is evanescent: the point
     vibrates but its neighbours barely hear it. Above it, waves propagate.
   - So Density can set the *wavelength* and Vibration the *natural frequency*,
     and the drive frequency follows from the dispersion relation rather than
     being another free parameter. Both controls stay physically meaningful and
     cannot fight each other.

   Vibration raises the mean natural frequency and its spatial spread together,
   so as it climbs, more of the field crosses above the drive and stops
   propagating — the field moves from throwing ripples to shimmering in place,
   with trapped pockets in between. That is the knob.
   --------------------------------------------------------------------------- */

/** Lattice resolution. Not the render resolution. */
export const MEDIUM_SIZE = 384
/** Dead margin beyond the legal origin range, in field units, reserved for the
 *  absorbing layer.
 *
 *  It has to sit *outside* that range rather than inside it: origins are allowed
 *  out to -0.5 and 1.5, and a sponge overlapping them would quietly damp an
 *  off-frame origin to silence — losing the long sweeping arcs those positions
 *  exist to produce. */
export const MEDIUM_MARGIN = 0.3
/** The lattice spans the whole legal origin range plus that margin. Off-canvas
 *  origins are the point of the range — an origin outside the lattice cannot
 *  drive it at all. */
export const MEDIUM_MIN = ORIGIN_MIN - MEDIUM_MARGIN
export const MEDIUM_DOMAIN = ORIGIN_MAX - ORIGIN_MIN + 2 * MEDIUM_MARGIN
/** field units per lattice texel */
export const MEDIUM_TEXEL = MEDIUM_DOMAIN / MEDIUM_SIZE
/** field position -> lattice texture coordinate */
export const toMediumUv = (v: number) => (v - MEDIUM_MIN) / MEDIUM_DOMAIN

/** Absorbing layer, in lattice UV — exactly the margin above.
 *
 *  A free boundary reflects: waves reached the lattice edge, bounced, and came
 *  back through the frame as criss-crossing standing structure. Ramping damping
 *  up through this layer dissipates them before they arrive, so nothing returns.
 *
 *  The ramp is smooth and squared on purpose. A *sharp* rise in damping is itself
 *  an impedance discontinuity and reflects almost as much as the hard boundary
 *  did — the gradient has to be gentle over roughly a wavelength. */
export const MEDIUM_ABSORB_WIDTH = MEDIUM_MARGIN / MEDIUM_DOMAIN
/** Extra damping at the outermost texel, 1/s. Sized so a wave crossing the layer
 *  at group velocity loses several e-foldings before touching the edge. */
export const MEDIUM_ABSORB_GAMMA = 14

/** Damping rate applied to the shortest wave the lattice can hold, 1/s.
 *
 *  The medium silted up: over tens of seconds the frame filled with fine
 *  criss-cross chop until no long waves were visible. Neither existing loss term
 *  could remove it. Bulk gamma decays every wavelength at the same rate, and the
 *  absorbing margin only catches waves that travel to it — but on a discrete
 *  lattice the group velocity is |sin(k h)|/(k h), which is exactly zero at the
 *  two-texel wavelength. Grid-scale modes stand still. The taps inject a little
 *  of them every strike, nothing took it away, and it built up.
 *
 *  Viscosity damps at nu*k^2, so pinning the rate at the lattice's largest k
 *  (pi/h) states the intent directly.
 *
 *  The size is set by where the viscous rate crosses bulk gamma, since that is
 *  the wavelength below which this term takes over: 4R/lambda^2 = gamma, so
 *  lambda = sqrt(4R/gamma). The chop to remove is 2 to 4 texels; the ripple
 *  ridges worth keeping start around 10. At R = 18 against a mid gamma of ~0.9
 *  the crossover lands at 9 texels, right in the gap — a 3-texel wave is damped
 *  at 8/s and gone in a tenth of a second, while a 20-texel one loses 0.18/s,
 *  five times under bulk damping and therefore untouched.
 *
 *  60 was the first attempt and was too strong: it put the crossover at 16
 *  texels and visibly flattened the surface along with the chop. */
export const MEDIUM_NYQUIST_DAMPING = 18

/** Kelvin-Voigt viscosity divided by h^2, which is what the shader wants since
 *  its stencil is the raw five-point sum.
 *
 *  nu = R*h^2/pi^2 makes nu*k^2 equal R at k = pi/h, so this reduces to a
 *  constant — the smoothing is then identical at every lattice pitch instead of
 *  changing strength with the quality setting.
 *
 *  The term is explicit, so it needs dt*R < 2 to stay stable; the caller clamps
 *  against the timestep in force. */
export const MEDIUM_NU_H2 = MEDIUM_NYQUIST_DAMPING / (Math.PI * Math.PI)

/** Lattice pitch the medium was calibrated at. */
export const MEDIUM_BASE_SIZE = 384

/** Target for dt*omega at the lattice's stiffest mode.
 *
 *  Semi-implicit Euler on u'' = -omega^2 u is stable only while dt*omega < 2, and
 *  the stiffest mode on a five-point stencil is the CHECKERBOARD k = (pi/h, pi/h),
 *  where omega^2 = 8c^2/h^2 + omega0^2.
 *
 *  The old fixed Courant factor of 0.7 put that product at 2*sqrt(2)*0.7 = 1.980
 *  — a 1% margin — and at a 256 lattice with high Vibration the omega0 term tipped
 *  it past 2.0 outright. Past the limit that one mode grows every step until it
 *  saturates the state clamp, which is the pixel checkerboard that appeared at low
 *  Density. 1.4 leaves a 30% margin instead. */
export const MEDIUM_COURANT = 1.4

/** Simulation timestep, in seconds.
 *
 *  Solved from the *actual* stiffness rather than assumed from the worst case:
 *  dt = COURANT / omega_max, with omega_max measured at the checkerboard mode for
 *  the wave speed and natural frequency currently in force. Three things follow.
 *
 *  It cannot go unstable — the bound is the thing being solved for, so every
 *  combination of Density, Vibration and lattice pitch is safe by construction
 *  rather than by a constant that happened to be small enough.
 *
 *  It is cheaper where it can afford to be. A thick, slow medium is not stiff, so
 *  it takes far larger steps: at full Density the timestep is about 3x the old
 *  one, which is most of what makes the heavy end light to run.
 *
 *  And the physics is unchanged by any of it. dt is in real seconds and every
 *  term is a rate, so step size affects accuracy and cost, never the frequencies
 *  or wavelengths that come out. */
export const mediumDt = (latticeSize: number, waveSpeed: number, omega0: number) => {
  const h = MEDIUM_DOMAIN / latticeSize
  const omegaMax = Math.sqrt((8 * waveSpeed * waveSpeed) / (h * h) + omega0 * omega0)
  return MEDIUM_COURANT / Math.max(omegaMax, 1e-6)
}

/** Top of the Density range, UV per second.
 *
 *  Lowered from 0.95. That was fast enough to read as agitated rather than
 *  soothing, and it was also the value the old fixed timestep was calibrated
 *  against, so it set the stability margin for every other setting too. */
export const MAX_WAVE_SPEED = 0.62

/** Lattice pitch per quality. Costs rise as size^2 * (1/dt), so ultra is roughly
 *  4.6x the work of auto — which is why it is opt-in. */
/** @deprecated Lattice pitch is now its own control — see LATTICE_SIZE in
 *  params.ts. Kept only so nothing silently reads a stale coupling. */
export const QUALITY_LATTICE: Record<string, number> = {
  auto: 384,
  high: 512,
  ultra: 640,
}

/** Internal render resolution as a multiple of the displayed canvas.
 *
 *  Auto reproduces the old tier-based behaviour at a 500px canvas. The other two
 *  supersample: the extra samples are what remove the stair-stepping on steep
 *  ridges, which no amount of shader work can fix at 1:1. */
export const QUALITY_RENDER_SCALE: Record<string, number> = {
  auto: 1,
  high: 2,
  ultra: 3,
}

/** Wave speed, UV per second — the medium's stiffness, and what Density
 *  controls. For a given drive frequency the wavelength is 2*pi*c/sqrt(w^2-w0^2),
 *  so a slower medium carries shorter, tighter waves.
 *
 *  Read as thickness: turning Density up is pouring in more liquid. The medium
 *  gets slower and heavier, its ripples shorter and more crowded, and it damps
 *  harder — see densityToDrag, which moves with this. Turning it down thins the
 *  medium out to something light and open.
 *
 *  The floor stays at 0.30. Dropping it to 0.16 to push "more liquid" further
 *  emptied the frame instead: a wave travels v_g/gamma before it dies, so at 0.16
 *  against a default gamma of ~0.9 that reach is 0.14 UV — a seventh of the
 *  frame. The taps could no longer fill it and the surface went flat. No CFL
 *  ceiling applies any more; mediumDt solves for the timestep from whatever speed
 *  is set. */
export const densityToWaveSpeed = (d: number) => lerp(MAX_WAVE_SPEED, 0.3, clamp01(d))

/** Extra velocity damping contributed by Density, 1/s.
 *
 *  Thickness is not only slowness — a heavy liquid also dissipates faster, and
 *  that is part of what separates heavy from merely slow.
 *
 *  Kept small on purpose. Damping is deliberately not amplitude-compensated (see
 *  MEDIUM_GAMMA_REF below for why no scaling law can cancel it), so every unit
 *  added here is level lost at the top of the range with no way to win it back.
 *  0.9 was tried and took the surface to completely flat at full Density. 0.22
 *  reads as thicker without emptying the frame. */
export const densityToDrag = (d: number) => 0.22 * Math.pow(clamp01(d), 1.6)

/** Velocity damping, 1/s.
 *
 *  Set by decay length, not by feel: a wave reaches v_g/gamma before it dies,
 *  with group velocity v_g = c^2*k/omega. At 0.35 that length is about 1.7 UV —
 *  comfortably across the visible frame — while still letting the field settle
 *  in roughly three seconds once the drive stops, which is what makes silence
 *  read as stillness. */
export const MEDIUM_GAMMA = 0.35

/** Viscosity -> velocity damping, 1/s.
 *
 *  The low end is set by decay length, not by feel: a wave reaches v_g/gamma
 *  before it dies, so below ~0.12 waves outlive several crossings of the lattice
 *  and the field never settles. The high end is syrup — a disturbance dies before
 *  it travels a wavelength, which reads as a thick, sluggish surface. */
/** Water to syrup, as a half-life: about 4s at the bottom, 0.7s at the top.
 *
 *  A 0.12-1.22 span only moved the half-life 2.2x across the whole slider, which
 *  read as the control doing nothing. Widening it costs level at the top — a
 *  viscous medium genuinely does not carry waves far — and that is the honest
 *  trade rather than a defect. */
export const viscosityToGamma = (v: number) => 0.1 + 2.3 * Math.pow(clamp01(v), 1.5)

/** Bulk damping is cut when the boundary reflects.
 *
 *  Without this, Reflection was measurable at the boundary and invisible in the
 *  frame: the edge sits outside the visible area and the round trip back through
 *  the margin was damped to nothing. A reflective cavity that loses most of the
 *  energy per bounce cannot build standing structure, which is the whole point of
 *  turning reflection on. */
export const REFLECT_DAMPING = 0.4

/** Radius of an origin's tap footprint, in field units.
 *
 *  0.02 was about three texels — a needle. Concentrating a tap's whole force into
 *  three texels drove a spike straight into the +/-8 clamp at the tap point, which
 *  is what most of the visible clipping was. Spreading it over ~7 texels reads as
 *  a press rather than a puncture and costs nothing. */
export const MEDIUM_DRIVE_SIGMA = 0.05
/** Tap acceleration, UV/s^2, calibrated at MEDIUM_TAP_REF.
 *
 *  Large because a tap is brief: a continuous drive on resonance builds up over
 *  many cycles, an impulse gets one shot. Measured, not estimated — moving from
 *  continuous forcing to taps cost a factor of ~30 that no back-of-envelope
 *  predicted.
 *
 *  Scaled by (W0/REF)^2 at use. Two effects compound: a brief kick leaves a
 *  stiffer oscillator with less displacement, and a fixed-duration tap has a
 *  fixed bandwidth, so the higher a point's resonance the less of the tap's
 *  energy sits at it. Measured falloff was ~W0^-2 across the bar's range.
 *  Without this the field visibly fades as Vibration goes up — and the bar has to
 *  change the *rate*, not the depth. */
/** Raised 2.4x when the absorbing margin went in. A reflecting boundary was
 *  recycling energy back through the frame, which quietly inflated the steady
 *  amplitude; once nothing comes back, the taps have to do all the work. */
export const MEDIUM_TAP_ACC = 60000
export const MEDIUM_TAP_REF = 22
/** Viscosity is *not* amplitude-compensated, deliberately.
 *
 *  The taps sit outside the visible frame, so what reaches it is radiated over a
 *  distance and attenuated by exp(-gamma*L/v_g) — exponential in damping, not a
 *  power of it. No single scaling law can cancel that, and a viscous medium
 *  genuinely does not carry waves far, so the quietening is correct physics rather
 *  than a defect to hide.
 *
 *  Two wrong laws were tried against measurements first: F/gamma (the driven
 *  oscillator relation, which made viscous taps violent) and F/sqrt(gamma) (the
 *  accumulated-energy relation, still far too weak at the top). What the range
 *  needed instead was to be narrower. */
export const MEDIUM_GAMMA_REF = 0.35
/** Scales the field into the ~±1 the profile remap expects. */
export const MEDIUM_GAIN = 1.7

/** Per-point natural frequency, rad/s. Kept inside the band a viewer can
 *  actually see oscillate — a few tenths of a hertz to a few hertz. */
/** Per-point natural frequency, rad/s — and now literally the rate the points
 *  ring at, so the band has to be one a viewer can see: roughly 0.8Hz to 7Hz.
 *
 *  It used to be ten times lower, which was right when W0 only decided whether
 *  energy propagated and a separate drive set the rate. Once the medium is struck
 *  rather than driven, W0 *is* the vibration, and the old band read as a barely
 *  moving surface. It also matches pitchToOmega0's band, so switching the
 *  microphone on does not jump the field to a different speed. */
export const vibrationToOmega0 = (v: number) => 5 + 39 * Math.pow(clamp01(v), 1.2)

/** Spread of the per-point frequency, as a fraction of its centre.
 *
 *  Resonance is what closes it: at 1 every point agrees on a frequency, at 0 they
 *  disagree by up to a third either way. Never exactly zero — identical
 *  oscillators stop beating, and beating is where the structure comes from.
 *
 *  Keeping it a *fraction* of the centre is what makes wave count scale with
 *  frequency. A wave crossing from a region at w1 into one at w2 has
 *  k = sqrt(w1^2 - w2^2)/c, so the number of ripples is set by frequency
 *  differences; if those differences grow in proportion to the centre, raising
 *  Vibration raises both the rate the field vibrates at and how many waves it
 *  carries. */
export const resonanceToSpread = (resonance: number) =>
  0.02 + 0.53 * Math.pow(1 - clamp01(resonance), 0.8)

/** Rate the origins tap the surface, Hz.
 *
 *  Deliberately slow. A *continuously* driven medium settles at the drive
 *  frequency no matter what its points prefer — which is why the Vibration bar
 *  used to change amplitude and wavelength but never the rate anything vibrated
 *  at. Struck instead, each region rings at its own natural frequency between
 *  taps, and the per-point frequency becomes something you can actually see. */
export const MEDIUM_TAP_HZ = 1.2
/** Fraction of a tap period the impulse occupies. Short, so it is broadband
 *  enough to excite whatever frequency each point prefers. */
export const MEDIUM_TAP_WIDTH = 0.32

/** Voice pitch -> the frequency the points themselves ring at, rad/s.
 *
 *  This drives the medium's natural frequency rather than a forcing frequency,
 *  so a pitch change retunes the surface instead of pushing it: the points really
 *  do vibrate at your pitch, and — through the relation above — a higher pitch
 *  also puts more waves in the frame. */
export function pitchToOmega0(hz: number) {
  const t = clamp01((Math.log(Math.max(hz, 1)) - Math.log(70)) / (Math.log(500) - Math.log(70)))
  const visibleHz = 1.1 * Math.pow(8 / 1.1, t)
  return Math.PI * 2 * visibleHz
}

/** The per-point frequency field, in rad/s. A JS mirror of `omega0` in
 *  medium.frag.glsl — the panel's frequency map has to show the real field, not
 *  an impression of it, so the two must not drift apart. */
export function omega0At(
  x: number,
  y: number,
  centre: number,
  spread: number,
  mapScale: number,
  phase: readonly [number, number]
) {
  const n =
    Math.sin(x * mapScale + phase[0]) * Math.sin(y * mapScale * 0.87 + phase[1]) +
    0.5 * Math.sin((x + y) * mapScale * 0.61 - phase[0])
  return Math.max(centre + n * spread * 0.4, 0)
}

/** Lowest and highest frequency any point of the field rings at, in Hz. */
export function omega0RangeHz(
  centre: number,
  spread: number,
  mapScale: number,
  phase: readonly [number, number]
) {
  let lo = Infinity
  let hi = 0
  for (let j = 0; j <= 24; j++) {
    for (let i = 0; i <= 24; i++) {
      const w = omega0At(i / 24, j / 24, centre, spread, mapScale, phase)
      if (w < lo) lo = w
      if (w > hi) hi = w
    }
  }
  const k = 1 / (Math.PI * 2)
  return { lo: lo * k, hi: hi * k }
}

/** Target wavelength for the idle drive, in UV. Only used to choose an idle
 *  frequency; once audio is driving the field the wavelength follows from the
 *  dispersion relation and the voice's pitch. */
const IDLE_WAVELENGTH = 0.18

/** The frequency that produces `IDLE_WAVELENGTH` in this medium. Inverting the
 *  dispersion relation rather than picking a number keeps the idle field looking
 *  like the same material the audio will drive. */
export function idleDriveOmega(density: number, vibration: number, ratio: number) {
  const c = densityToWaveSpeed(density)
  const w0 = vibrationToOmega0(vibration)
  const k = ((Math.PI * 2) / IDLE_WAVELENGTH) * ratio
  return Math.sqrt(w0 * w0 + c * c * k * k)
}

/** Voice pitch -> the rate the field vibrates at, rad/s.
 *
 *  A 70-500Hz fundamental cannot be shown directly; nothing on a display
 *  oscillates at 200Hz visibly. The mapping is logarithmic, so an octave of
 *  voice is a constant step of visible rate — which is what makes the response
 *  feel proportional to pitch rather than jumping at the top of the range.
 *
 *  The band starts at 1.2Hz rather than lower for a physical reason: wavelength
 *  is 2*pi*c/sqrt(w^2 - w0^2), so a drive close to the medium's natural frequency
 *  produces waves longer than the frame, and one below it does not propagate at
 *  all. An earlier 0.45Hz floor put a low voice under the cutoff and it excited
 *  nothing. Across this band a deep voice reads as broad slow swells and a high
 *  one as fine fast ripples, which is the behaviour worth having. */
export function pitchToOmega(hz: number) {
  const t = clamp01((Math.log(Math.max(hz, 1)) - Math.log(70)) / (Math.log(500) - Math.log(70)))
  const visibleHz = 1.2 * Math.pow(9 / 1.2, t)
  return Math.PI * 2 * visibleHz
}

/** Loudness -> drive amplitude. Squared-ish so quiet speech stays quiet and the
 *  field is genuinely still in silence. */
export const loudnessToDrive = (v: number) => Math.pow(clamp01(v), 1.4)

/** Interference, in the medium, is the balance of drive between the origins.
 *
 *  With one physical field there is no additive-versus-multiplicative choice to
 *  make — superposition is superposition. What does change how much interference
 *  structure appears is whether one origin dominates or all of them contribute
 *  equally: a single strong source gives readable concentric rings, four equal
 *  ones give nodal lines and beat cells. That is the physical version of the
 *  same control. */
export function mediumSourceWeight(interference: number, index: number) {
  return index === 0 ? 1 : lerp(0.12, 1, smoothstep(0.05, 0.85, clamp01(interference)))
}

/** Depth has to be divided by the field's spatial frequency in both engines, or
 *  the lighting changes every time the wavelength does. */
export const mediumDepthDivisor = () => (Math.PI * 2) / IDLE_WAVELENGTH

/** Stretch pad (-1..1) -> per-axis scale. Positive x elongates horizontally. */
export function stretchToScale(s: { x: number; y: number }): [number, number] {
  return [Math.exp(clamp(s.x, -1, 1) * 0.95), Math.exp(clamp(s.y, -1, 1) * 0.95)]
}

/** Interference drives the additive/multiplicative blend of the height field.
 *  Split into two curves so the low end keeps individual concentric rings
 *  readable and the top end is dominated by cellular moiré structure. */
export const interferenceToMix = (i: number) => smoothstep(0.04, 0.82, clamp01(i))

/** Light direction. Angle is in the plane of the canvas; elevation stays
 *  internal, low enough that slopes cast real directional contrast. */
export function lightVector(angle: number): [number, number, number] {
  const elev = 0.62
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const h = Math.sqrt(Math.max(1 - elev * elev, 0))
  return [c * h, elev, s * h]
}

/** Resonance resolves a source's stored pair of frequencies and phases.
 *
 *  At 0 the ratios are spread (21.7 / 26.2 / 31.4 / 24.9 territory) and phases
 *  run free, so interference is irregular and asymmetric. At 1 they collapse to
 *  within a couple of percent of each other (24 / 24.5 / 23.5 / 25) with phases
 *  locked to quarter turns, which produces stable standing structures — but
 *  never to *exactly* equal, because identical sources stop beating and beating
 *  is where the moiré lives. */
export function resolveSource(s: PgSource, resonance: number) {
  const r = clamp01(resonance)
  return {
    ratio: lerp(s.spreadRatio, s.tunedRatio, r),
    phase: lerp(s.phaseFree, s.phaseTuned, r),
    // At full resonance every source drifts at exactly the same rate — sign
    // included. That is what makes the pattern stationary: with a common
    // frequency the time factor e^(iwt) is shared, so it factors out of the
    // superposition and the nodal lines stop moving. Opposite signs would leave
    // the sources counter-rotating and the fringes would sweep across the frame,
    // which is what the previous Math.sign() version did.
    drift: lerp(s.drift, 0.22, r),
  }
}

/** Autonomous drift. Deliberately tiny: the avatar should feel alive without
 *  becoming unrecognisable, and at 0 the frame is a pure function of seed and
 *  settings. */
export const IDLE_MOTION = 0.14
/** Slow breathing of ring spacing, lifted from the moiré reference. */
export const IDLE_BREATHE = 0.035
/** How far an origin wanders from its authored position, in UV units. */
export const IDLE_WANDER = 0.01

export function sourceScale(s: PgSource, cfg: PgConfig): [number, number] {
  const [gx, gy] = stretchToScale(cfg.stretch)
  return [s.sx * gx, s.sy * gy]
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const clamp01 = (v: number) => clamp(v, 0, 1)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export function smoothstep(e0: number, e1: number, x: number) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}
