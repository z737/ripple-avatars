export const STRUCTURES = ['interference', 'tunnel', 'orbit', 'flow'] as const
export const SHAPES = ['full', 'circle', 'square', 'capsule', 'drop'] as const
export const SURFACES = ['flat', 'soft', 'embossed', 'glossy'] as const

export type Structure = (typeof STRUCTURES)[number]
export type Shape = (typeof SHAPES)[number]
export type Surface = (typeof SURFACES)[number]

export const SHAPE_INDEX: Record<Shape, number> = {
  full: 0,
  circle: 1,
  square: 2,
  capsule: 3,
  drop: 4,
}

/** Surface presets map to the derivative-lighting strength. */
export const SURFACE_LIGHT: Record<Surface, number> = {
  flat: 0.0,
  soft: 0.22,
  embossed: 0.55,
  glossy: 0.85,
}

export interface Source {
  x: number
  y: number
  sx: number
  sy: number
  rot: number
  freq: number
  phase: number
  power: number
  drift: number
  amp: number
}

export interface RippleParams {
  seed: string

  structure: Structure
  shape: Shape
  surface: Surface
  paletteId: string

  sources: Source[]
  interference: number
  density: number
  lineWidth: number
  bleed: number

  warpAmount: number
  warpScale: number
  warpOctaves: number

  layers: number
  chromaSplit: number
  chromaPhase: number
  chromaAngle: number
  hueSpread: number
  coreGlow: number

  exposure: number
  contrast: number

  lightAngle: number

  grain: number
  shapeSize: number
  shapeSoft: number

  speed: number
}

/** Slider metadata — drives the control panel and keeps ranges in one place. */
export const RANGES = {
  density: { min: 0.2, max: 7, step: 0.01, label: 'Density' },
  lineWidth: { min: 0.3, max: 6, step: 0.01, label: 'Line width' },
  bleed: { min: 0, max: 1, step: 0.01, label: 'Bleed' },
  warpAmount: { min: 0, max: 1.2, step: 0.01, label: 'Distortion' },
  warpScale: { min: 0.2, max: 4, step: 0.01, label: 'Distortion scale' },
  interference: { min: 0, max: 1, step: 0.01, label: 'Interference → beats' },
  chromaSplit: { min: 0, max: 0.35, step: 0.001, label: 'Chromatic split' },
  chromaPhase: { min: 0, max: 1.2, step: 0.01, label: 'Chromatic phase' },
  chromaAngle: { min: 0, max: 6.283, step: 0.01, label: 'Chromatic angle' },
  hueSpread: { min: 0, max: 0.9, step: 0.01, label: 'Hue spread' },
  coreGlow: { min: 0, max: 1.2, step: 0.01, label: 'Core glow' },
  exposure: { min: 0.5, max: 1.8, step: 0.01, label: 'Exposure' },
  contrast: { min: 0.6, max: 1.8, step: 0.01, label: 'Contrast' },
  grain: { min: 0, max: 0.28, step: 0.005, label: 'Grain' },
  shapeSize: { min: 0.3, max: 1.4, step: 0.01, label: 'Shape size' },
  shapeSoft: { min: 0.002, max: 0.3, step: 0.002, label: 'Edge softness' },
  speed: { min: 0, max: 1.5, step: 0.01, label: 'Speed' },
  lightAngle: { min: 0, max: 6.283, step: 0.01, label: 'Light angle' },
} as const

export type RangeKey = keyof typeof RANGES
