import { PALETTES } from './palettes'
import {
  RippleParams,
  SHAPES,
  STRUCTURES,
  SURFACES,
  Shape,
  Source,
  Structure,
  Surface,
} from './params'
import { rngFrom } from './prng'

const TAU = Math.PI * 2

/** Structure families are named regions of parameter space, not separate
 *  shaders. Each one decides how many sources there are and how they sit. */
function buildSources(structure: Structure, r: ReturnType<typeof rngFrom>): Source[] {
  const src = (o: Partial<Source>): Source => ({
    x: 0,
    y: 0,
    sx: 1,
    sy: 1,
    rot: 0,
    freq: 12,
    phase: 0,
    power: 1,
    drift: 0.3,
    amp: 1,
    ...o,
  })

  switch (structure) {
    case 'orbit': {
      // single near-isotropic source -> concentric rings (reference 2, panel 3)
      return [
        src({
          x: r.range(-0.35, 0.35),
          y: r.range(-0.35, 0.35),
          sx: r.range(0.85, 1.15),
          sy: r.range(0.85, 1.15),
          rot: r.range(0, TAU),
          freq: r.range(16, 26),
          phase: r.range(0, TAU),
          power: r.range(0.9, 1.15),
          drift: r.range(0.2, 0.5),
        }),
      ]
    }

    case 'tunnel': {
      // two strongly anisotropic sources with power > 1 -> receding curved grid
      const rot = r.range(-0.5, 0.5)
      return [
        src({
          x: r.range(-0.2, 0.2),
          y: r.range(0.35, 0.9),
          sx: r.range(0.5, 0.8),
          sy: r.range(1.3, 2.2),
          rot,
          freq: r.range(16, 24),
          phase: r.range(0, TAU),
          power: r.range(1.3, 1.75),
          drift: r.range(0.2, 0.4),
        }),
        src({
          x: r.range(-0.3, 0.3),
          y: r.range(-0.9, -0.35),
          sx: r.range(0.6, 1.0),
          sy: r.range(1.0, 1.8),
          rot: rot + r.range(-0.6, 0.6),
          freq: r.range(14, 22),
          phase: r.range(0, TAU),
          power: r.range(1.2, 1.6),
          drift: r.range(-0.4, -0.15),
        }),
      ]
    }

    case 'flow': {
      // three sources, heavily warped downstream -> long sweeping arcs
      return [0, 1, 2].map((i) =>
        src({
          x: r.range(-0.9, 0.9),
          y: r.range(-0.9, 0.9),
          sx: r.range(0.6, 1.6),
          sy: r.range(0.6, 1.6),
          rot: r.range(0, TAU),
          freq: r.range(11, 18),
          phase: r.range(0, TAU),
          power: r.range(0.85, 1.3),
          drift: r.range(-0.4, 0.4) + i * 0.05,
        })
      )
    }

    case 'interference':
    default: {
      // two sources set apart. Their product traces Lame-curve cells where the
      // fringe families cross and hyperbolic arcs away from it — the signature
      // geometry of references 3, 6 and 7.
      const a = r.range(0, TAU)
      const sep = r.range(0.45, 0.95)
      return [
        src({
          x: Math.cos(a) * sep,
          y: Math.sin(a) * sep,
          sx: r.range(0.7, 1.3),
          sy: r.range(0.7, 1.3),
          rot: r.range(0, TAU),
          freq: r.range(17, 26),
          phase: r.range(0, TAU),
          power: r.range(0.95, 1.25),
          drift: r.range(0.15, 0.45),
        }),
        src({
          x: -Math.cos(a) * sep * r.range(0.7, 1.2),
          y: -Math.sin(a) * sep * r.range(0.7, 1.2),
          sx: r.range(0.7, 1.4),
          sy: r.range(0.7, 1.4),
          rot: r.range(0, TAU),
          freq: r.range(17, 26),
          phase: r.range(0, TAU),
          power: r.range(0.95, 1.25),
          drift: r.range(-0.45, -0.15),
        }),
      ]
    }
  }
}

/** voiceId (or any string) -> a complete, reproducible avatar.
 *  Persist the seed with the voice; never regenerate per session. */
export function paramsFromSeed(seed: string): RippleParams {
  const r = rngFrom(seed)

  const structure = r.pick(STRUCTURES) as Structure
  const shape = r.pick(SHAPES) as Shape
  const surface = r.pick(SURFACES) as Surface
  const palette = r.pick(PALETTES)

  const warpBase = structure === 'flow' ? r.range(0.35, 0.95) : r.range(0.02, 0.35)

  return {
    seed,
    structure,
    shape,
    surface,
    paletteId: palette.id,

    sources: buildSources(structure, r),
    interference: structure === 'orbit' ? r.range(0.3, 0.7) : r.range(0.0, 0.28),
    density: r.range(1.7, 3.0),
    lineWidth: r.range(0.7, 1.6),
    bleed: r.range(0, 0.4),

    warpAmount: warpBase,
    warpScale: r.range(0.6, 2.4),
    warpOctaves: r.int(2, 4),

    layers: r.int(3, 4),
    chromaSplit: r.range(0.04, 0.11),
    chromaPhase: r.range(0.1, 0.24),
    chromaAngle: r.range(0, TAU),
    hueSpread: r.range(0.1, 0.55),
    coreGlow: r.range(0.15, 0.42),

    exposure: r.range(0.94, 1.12),
    contrast: r.range(1.05, 1.32),

    lightAngle: r.range(0, TAU),

    grain: r.range(0.06, 0.17),
    shapeSize: shape === 'full' ? 1 : r.range(0.72, 0.95),
    shapeSoft: r.range(0.006, 0.05),

    speed: 0.35,
  }
}

/** Presets calibrated by eye against individual references. These are internal
 *  ground truth for engine validation — see PLAN.md §0 before shipping them. */
export const PRESETS: { id: string; name: string; apply: () => RippleParams }[] = [
  {
    id: 'ref-sage',
    name: 'Ref · Sage grid',
    apply: () => ({
      ...paramsFromSeed('vachana-2201'),
      structure: 'interference',
      shape: 'full',
      surface: 'soft',
      paletteId: 'sage',
      sources: [
        { x: 0.2, y: 0.58, sx: 0.95, sy: 1.05, rot: 0.3, freq: 21, phase: 0.4, power: 1.06, drift: 0.3, amp: 1 },
        { x: -0.36, y: -0.5, sx: 1.1, sy: 0.92, rot: -0.5, freq: 19, phase: 2.1, power: 1.1, drift: -0.28, amp: 1 },
      ],
      interference: 0.04,
      density: 2.5,
      lineWidth: 0.9,
      bleed: 0.12,
      warpAmount: 0.12,
      warpScale: 1.2,
      warpOctaves: 3,
      layers: 3,
      chromaSplit: 0.09,
      chromaPhase: 0.16,
      hueSpread: 0.4,
      coreGlow: 0.3,
      exposure: 1.0,
      contrast: 1.22,
      grain: 0.15,
      shapeSize: 1,
      shapeSoft: 0.01,
    }),
  },
  {
    id: 'ref-tunnel',
    name: 'Ref · Cream tunnel',
    apply: () => ({
      ...paramsFromSeed('tarang-4417'),
      structure: 'tunnel',
      shape: 'full',
      surface: 'embossed',
      paletteId: 'cream',
      sources: [
        { x: 0.05, y: 0.72, sx: 0.62, sy: 1.85, rot: 0.12, freq: 20, phase: 1.1, power: 1.52, drift: 0.26, amp: 1 },
        { x: -0.12, y: -0.6, sx: 0.8, sy: 1.35, rot: -0.28, freq: 17, phase: 3.0, power: 1.34, drift: -0.22, amp: 1 },
      ],
      interference: 0.03,
      density: 2.7,
      lineWidth: 1.35,
      bleed: 0.32,
      warpAmount: 0.09,
      warpScale: 1.0,
      warpOctaves: 3,
      layers: 5,
      chromaSplit: 0.11,
      chromaPhase: 0.24,
      hueSpread: 0.5,
      coreGlow: 0.34,
      exposure: 1.06,
      contrast: 1.2,
      grain: 0.15,
      shapeSize: 1,
      shapeSoft: 0.01,
    }),
  },
  {
    id: 'ref-amber',
    name: 'Ref · Amber rings',
    apply: () => ({
      ...paramsFromSeed('nada-1180'),
      structure: 'orbit',
      shape: 'full',
      surface: 'soft',
      paletteId: 'amber',
      sources: [
        { x: 0.02, y: -0.42, sx: 1.0, sy: 1.05, rot: 0, freq: 22, phase: 0.6, power: 1.02, drift: 0.3, amp: 1 },
      ],
      interference: 0.5,
      density: 1.9,
      lineWidth: 2.3,
      bleed: 0.6,
      warpAmount: 0.14,
      warpScale: 0.9,
      warpOctaves: 3,
      layers: 3,
      chromaSplit: 0.03,
      chromaPhase: 0.2,
      hueSpread: 0.2,
      coreGlow: 0.22,
      exposure: 1.12,
      contrast: 1.0,
      grain: 0.12,
      shapeSize: 1,
      shapeSoft: 0.01,
    }),
  },
  {
    id: 'ref-navy',
    name: 'Ref · Deep navy',
    apply: () => ({
      ...paramsFromSeed('dhwani-7712'),
      structure: 'interference',
      shape: 'full',
      surface: 'glossy',
      paletteId: 'ink-navy',
      sources: [
        { x: -0.28, y: 0.5, sx: 1.15, sy: 0.9, rot: 0.5, freq: 20, phase: 0.2, power: 1.08, drift: 0.24, amp: 1 },
        { x: 0.3, y: -0.48, sx: 0.95, sy: 1.2, rot: -0.4, freq: 18, phase: 2.6, power: 1.04, drift: -0.2, amp: 1 },
      ],
      interference: 0.08,
      density: 2.2,
      lineWidth: 1.3,
      bleed: 0.45,
      warpAmount: 0.18,
      warpScale: 1.3,
      warpOctaves: 3,
      layers: 4,
      chromaSplit: 0.06,
      chromaPhase: 0.38,
      hueSpread: 0.35,
      coreGlow: 0.4,
      exposure: 0.82,
      contrast: 1.12,
      grain: 0.12,
      shapeSize: 1,
      shapeSoft: 0.01,
    }),
  },
  {
    id: 'avatar-round',
    name: 'Avatar · Round',
    apply: () => ({
      ...paramsFromSeed('meera-3390'),
      structure: 'orbit',
      shape: 'circle',
      surface: 'soft',
      paletteId: 'brand',
      interference: 0.45,
      density: 2.0,
      lineWidth: 2.0,
      bleed: 0.5,
      warpAmount: 0.2,
      layers: 4,
      chromaSplit: 0.035,
      chromaPhase: 0.24,
      hueSpread: 0.35,
      coreGlow: 0.28,
      exposure: 1.06,
      contrast: 1.05,
      grain: 0.11,
      shapeSize: 0.86,
      shapeSoft: 0.03,
    }),
  },
]
