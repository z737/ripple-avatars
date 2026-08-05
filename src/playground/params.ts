/* ---------------------------------------------------------------------------
   Chromatic Ripple Playground — public parameter surface.

   Every exposed control is a normalised 0..1 (or -1..1) value. The mapping to
   real engine units — frequencies, wave depths, light vectors, refraction
   ratios — lives in `mapping.ts` and stays internal, per the V1 constraint.

   The renderer treats the wave field as a HEIGHT FIELD, not as something to
   colour. Nothing here selects a colour per wave; the palette supplies one
   continuous mesh gradient for the whole canvas and the waves only deform it.
   --------------------------------------------------------------------------- */

/** Two ways to produce the surface.
 *
 *  `analytic` evaluates closed-form radial waves per pixel — cheap, exactly
 *  reproducible, exact normals, but disturbances cannot really propagate.
 *
 *  `medium` runs a lattice of coupled oscillators: every point of the field has
 *  its own natural frequency and rings, ripples spread by propagation, and
 *  several disturbances genuinely interfere because they share one medium. This
 *  is a prototype, kept side by side with the analytic engine for comparison. */
export const ENGINES = ['analytic', 'medium', 'ink', 'heatmap'] as const
export type Engine = (typeof ENGINES)[number]

export const ENGINE_LABEL: Record<Engine, string> = {
  analytic: 'Analytic',
  medium: 'Medium',
  ink: 'Ink',
  heatmap: 'Heat',
}

/** How overlapping strokes combine. */
export const INK_BLENDS = ['add', 'opaque', 'multiply'] as const
export type InkBlend = (typeof INK_BLENDS)[number]
export const INK_BLEND_LABEL: Record<InkBlend, string> = {
  add: 'Add',
  opaque: 'Opaque',
  multiply: 'Multiply',
}
export const INK_BLEND_INDEX: Record<InkBlend, number> = {
  add: 0,
  opaque: 1,
  multiply: 2,
}

/** Surface material. Matte is pigment barely lit; Chrome is the opposite end —
 *  a hard sharp specular over a strong self-reflection of the mesh. */
export const SURFACES = ['matte', 'glossy', 'chrome'] as const
export type Surface = (typeof SURFACES)[number]
export const SURFACE_LABEL: Record<Surface, string> = {
  matte: 'Matte',
  glossy: 'Glossy',
  chrome: 'Chrome',
}
/** 0 = matte, 1 = chrome. The shader takes one number, not a mode. */
export const SURFACE_METALLIC: Record<Surface, number> = {
  matte: 0,
  glossy: 0.4,
  chrome: 1,
}

/** Internal render resolution relative to the displayed canvas. Auto follows the
 *  GPU tier; the other two supersample, which is where the sharpness comes from. */
export const QUALITIES = ['auto', 'high', 'ultra'] as const
export type Quality = (typeof QUALITIES)[number]
export const QUALITY_LABEL: Record<Quality, string> = {
  auto: 'Auto',
  high: 'High',
  ultra: 'Ultra',
}

export const PATTERNS = ['young', 'orbit', 'interference', 'cellular', 'tunnel', 'flow'] as const
export const PG_SHAPES = ['full', 'circle', 'rounded'] as const
export const WAVE_COUNTS = [2, 3, 4] as const

export type Pattern = (typeof PATTERNS)[number]
export type PgShape = (typeof PG_SHAPES)[number]
export type WaveCount = (typeof WAVE_COUNTS)[number]

export const PATTERN_LABEL: Record<Pattern, string> = {
  young: 'Young fringes',
  orbit: 'Orbit',
  interference: 'Interference',
  cellular: 'Cellular',
  tunnel: 'Tunnel',
  flow: 'Flow',
}

export const SHAPE_LABEL: Record<PgShape, string> = {
  full: 'Full',
  circle: 'Circle',
  rounded: 'Rounded',
}

export const PG_SHAPE_INDEX: Record<PgShape, number> = {
  full: 0,
  circle: 1,
  rounded: 2,
}

/** Developer-only visualisations of each stage of the pipeline. */
export const DEBUG_MODES = [
  'composite',
  'mesh',
  'additive',
  'multiplicative',
  'height',
  'normals',
  'diffuse',
  'highlight',
  'shadow',
  'chromatic',
] as const
export type DebugMode = (typeof DEBUG_MODES)[number]

export const DEBUG_LABEL: Record<DebugMode, string> = {
  composite: 'Final composite',
  mesh: 'Base mesh',
  additive: 'Additive waves',
  multiplicative: 'Multiplicative moiré',
  height: 'Final height',
  normals: 'Surface normals',
  diffuse: 'Diffuse lighting',
  highlight: 'Highlight',
  shadow: 'Shadow',
  chromatic: 'Chromatic refraction',
}

export const DEBUG_INDEX: Record<DebugMode, number> = {
  composite: 0,
  mesh: 1,
  additive: 2,
  multiplicative: 3,
  height: 4,
  normals: 5,
  diffuse: 6,
  highlight: 7,
  shadow: 8,
  chromatic: 9,
}

/** A permanent wave origin — part of the avatar's identity.
 *
 *  Positions live in canvas UV space: 0..1 is visible, and the full legal range
 *  is -0.5..1.5 so sources can sit off-frame, which is what produces the large
 *  sweeping arcs, partial rings and tunnel compositions.
 *
 *  Frequency is stored as a *pair* — a spread ratio and a near-unity one.
 *  Resonance interpolates between them, which is what makes that control change
 *  how mathematically related the sources are rather than how bright the image
 *  is. Neither end is ever exactly 1.0 for every source: identical frequencies
 *  produce no beating, and beating is where the moiré comes from. */
export interface PgSource {
  x: number
  y: number
  /** frequency ratio at resonance 0 — deliberately far from its neighbours */
  spreadRatio: number
  /** frequency ratio at resonance 1 — within a couple of percent of 1 */
  tunedRatio: number
  /** free-running phase, used at resonance 0 */
  phaseFree: number
  /** phase snapped to a quarter turn, used at resonance 1 */
  phaseTuned: number
  rot: number
  /** radial power; > 1 compresses the centre and opens the outer rings */
  power: number
  /** signed idle phase drift rate */
  drift: number
  amp: number
  /** anisotropy baked into the origin, multiplied by the global Stretch */
  sx: number
  sy: number
  /** seed for this source's tiny idle positional wander */
  wander: number
}

export const ORIGIN_MIN = -0.5
export const ORIGIN_MAX = 1.5

export interface PgConfig {
  seed: string

  engine: Engine
  waves: WaveCount
  pattern: Pattern
  sources: PgSource[]

  /** natural frequency of every point of the medium (medium engine only).
   *  Resonance controls the *spread* around it. */
  vibration: number
  /** 0 = the live oscillating displacement, 1 = the standing interference
   *  envelope: the fringe pattern a screen would record, and the cleanest
   *  reading of the field because it does not move at all */
  fringe: number
  /** whether points differ in frequency at all. Off makes the medium uniform —
   *  one frequency everywhere — which is a plain wave medium. */
  pointFrequency: boolean
  /** let the boundary reflect instead of absorbing. Waves then bounce back
   *  through the frame and build standing structure. */
  reflect: boolean
  /** how quickly the medium dissipates: slippery water through to syrup */
  viscosity: number
  surface: Surface
  /** how overlapping ink strokes combine (ink engine only) */
  inkBlend: InkBlend

  /* --- exposed sliders, all 0..1 --- */
  density: number
  thickness: number
  interference: number
  resonance: number
  waveDepth: number
  warp: number
  mesh: number
  lightIntensity: number
  shadowDepth: number
  chromatic: number
  grain: number
  interaction: number

  /* --- exposed, other --- */
  /** radians; direction the light comes from, in the plane of the canvas */
  lightAngle: number
  stretch: { x: number; y: number } // -1..1, 0,0 = isotropic
  shape: PgShape
  /** 1 to 4 hex colours chosen from the pastel set; the mesh is built from
   *  these, and their placement comes from the seed */
  colors: string[]
  /** ink base instead of paper */
  darkBase: boolean
  audio: boolean
}

/** Slider metadata for the panel. All normalised — see the note at the top. */
export const PG_RANGES = {
  vibration: { label: 'Vibration' },
  viscosity: { label: 'Viscosity' },
  fringe: { label: 'Fringes' },
  density: { label: 'Density' },
  thickness: { label: 'Thickness' },
  interference: { label: 'Interference' },
  resonance: { label: 'Resonance' },
  waveDepth: { label: 'Wave depth' },
  warp: { label: 'Warp' },
  mesh: { label: 'Mesh' },
  lightIntensity: { label: 'Light intensity' },
  shadowDepth: { label: 'Shadow depth' },
  chromatic: { label: 'Chromatic' },
  grain: { label: 'Grain' },
  interaction: { label: 'Interaction' },
} as const

export type PgRangeKey = keyof typeof PG_RANGES
