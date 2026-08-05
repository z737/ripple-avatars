/* ---------------------------------------------------------------------------
   Seed -> a designed configuration.

   Randomisation works on whole compositions, never on individual shader
   values: pick a pattern family, pick a composition-aware origin layout,
   choose the two ends of each source's frequency relationship, then draw the
   remaining values from ranges known-good for that family. Candidates are
   validated on the CPU (see field.ts) and repaired or rejected before they
   reach the GPU.
   --------------------------------------------------------------------------- */

import { Rng, rngFrom } from '../engine/prng'
import { validate } from './field'
import { clamp } from './mapping'
import { MAX_COLORS, PASTEL_ROWS } from './palettes'
import {
  ORIGIN_MAX,
  ORIGIN_MIN,
  PATTERNS,
  PG_SHAPES,
  Pattern,
  PgConfig,
  PgShape,
  PgSource,
  WaveCount,
} from './params'

const TAU = Math.PI * 2

export const LAYOUTS = [
  'slit',
  'opposing',
  'diagonal',
  'cluster',
  'surround',
  'outside',
  'asymmetric',
] as const
export type Layout = (typeof LAYOUTS)[number]

const C = 0.5 // frame centre in UV space

const place = (a: number, r: number, cx = C, cy = C) => ({
  x: cx + Math.cos(a) * r,
  y: cy + Math.sin(a) * r,
})

/** Origin layouts. Radii are in UV units, so anything past ~0.71 from centre
 *  leaves the visible frame at that angle. */
function layoutOrigins(layout: Layout, n: number, r: Rng): { x: number; y: number }[] {
  const a0 = r.range(0, TAU)

  switch (layout) {
    case 'opposing':
      // alternating sides of the centre, unequal radii so it never mirrors
      return Array.from({ length: n }, (_, i) => {
        const side = i % 2 === 0 ? 0 : Math.PI
        const a = a0 + side + r.range(-0.28, 0.28) + Math.floor(i / 2) * 1.1
        return place(a, r.range(0.34, 0.66))
      })

    case 'diagonal': {
      const span = r.range(0.55, 1.15)
      return Array.from({ length: n }, (_, i) => {
        const t = n === 1 ? 0 : i / (n - 1) - 0.5
        return place(a0, t * span * 2 + r.range(-0.06, 0.06))
      })
    }

    case 'cluster': {
      const c = place(a0, r.range(0, 0.24))
      return Array.from({ length: n }, () =>
        place(r.range(0, TAU), r.range(0.06, 0.26), c.x, c.y)
      )
    }

    case 'surround': {
      const rad = r.range(0.6, 0.82)
      return Array.from({ length: n }, (_, i) =>
        place(a0 + (i / n) * TAU + r.range(-0.3, 0.3), rad * r.range(0.85, 1.15))
      )
    }

    case 'outside':
      // every source beyond the frame -> broad arcs and directional bands
      return Array.from({ length: n }, (_, i) =>
        place(a0 + (i / n) * TAU * r.range(0.35, 0.8), r.range(0.9, 1.35))
      )

    case 'slit': {
      // Young geometry. A close, equal pair just *outside* one edge, so the frame
      // shows the fan of nodal lines spreading away from the pair rather than the
      // sources themselves — which is the whole point of the double slit: you
      // look at the interference, not at the slits.
      const a = a0
      // Just outside the frame edge, and no further: push + gap has to stay
      // within the legal origin range or the per-coordinate clamp pulls one
      // source in and not the other, which breaks the pair's symmetry and with
      // it the fringes. 0.5 is the frame edge along an axis; 0.84 is the limit.
      const push = r.range(0.56, 0.8)
      const gap = r.range(0.08, 0.17)
      const cx = C - Math.cos(a) * push
      const cy = C - Math.sin(a) * push
      const tx = -Math.sin(a)
      const ty = Math.cos(a)
      return Array.from({ length: n }, (_, i) => {
        const t = n === 1 ? 0 : i / (n - 1) - 0.5
        return { x: cx + tx * gap * 2 * t, y: cy + ty * gap * 2 * t }
      })
    }

    case 'asymmetric':
    default: {
      // rejection-sampled for a minimum separation, so sources never stack
      const out: { x: number; y: number }[] = []
      for (let i = 0; i < n; i++) {
        let best = place(r.range(0, TAU), r.range(0.1, 0.9))
        for (let tries = 0; tries < 10; tries++) {
          const p = place(r.range(0, TAU), r.range(0.1, 0.9))
          const near = out.reduce(
            (m, q) => Math.min(m, Math.hypot(p.x - q.x, p.y - q.y)),
            Infinity
          )
          best = p
          if (near > 0.3) break
        }
        out.push(best)
      }
      return out
    }
  }
}

interface FamilySpec {
  layouts: readonly Layout[]
  density: [number, number]
  thickness: [number, number]
  interference: [number, number]
  resonance: [number, number]
  waveDepth: [number, number]
  warp: [number, number]
  /** magnitude of the stretch offset applied along one axis */
  stretch: [number, number]
  power: [number, number]
  /** amplitude of every source after the first — orbit needs one dominant centre */
  satellite: [number, number]
}

/** The five families are parameter regions of one renderer, not five shaders.
 *  What separates them is mostly the additive/multiplicative balance and how the
 *  origins are laid out. */
const FAMILY: Record<Pattern, FamilySpec> = {
  young: {
    // Young's double slit. Everything here is chosen to keep the fringes clean:
    // a slit pair outside the frame, one wavelength (resonance at the top), the
    // coherent branch only, and no warp — a warp bends the wavefronts out of
    // step and turns fixed nodal lines back into mush.
    layouts: ['slit'],
    density: [0.5, 0.78],
    thickness: [0.22, 0.5],
    interference: [0, 0.1],
    resonance: [0.95, 1],
    waveDepth: [0.58, 0.9],
    warp: [0, 0.05],
    stretch: [0, 0.06],
    power: [1, 1],
    satellite: [1, 1],
  },
  orbit: {
    // additive-dominant: recognisable concentric rings with visible centres
    layouts: ['cluster', 'asymmetric'],
    density: [0.28, 0.5],
    thickness: [0.45, 0.78],
    interference: [0.04, 0.24],
    resonance: [0.5, 0.9],
    waveDepth: [0.4, 0.72],
    warp: [0.04, 0.22],
    stretch: [0, 0.2],
    power: [0.95, 1.1],
    satellite: [0.35, 0.6],
  },
  interference: {
    // balanced additive + multiplicative height
    layouts: ['slit', 'slit', 'opposing', 'diagonal', 'asymmetric'],
    density: [0.32, 0.62],
    thickness: [0.3, 0.62],
    interference: [0.38, 0.62],
    resonance: [0.4, 0.85],
    waveDepth: [0.4, 0.7],
    warp: [0.05, 0.28],
    stretch: [0, 0.32],
    power: [0.95, 1.2],
    satellite: [0.85, 1],
  },
  cellular: {
    // multiplicative-dominant: hollow cells, capsules, repeating intersections
    layouts: ['cluster', 'surround', 'asymmetric'],
    density: [0.28, 0.5],
    thickness: [0.2, 0.48],
    interference: [0.76, 0.98],
    resonance: [0.55, 0.95],
    waveDepth: [0.35, 0.65],
    warp: [0.06, 0.3],
    stretch: [0.1, 0.45],
    power: [0.9, 1.12],
    satellite: [0.8, 1],
  },
  tunnel: {
    // off-canvas sources, strong anisotropy, converging structure
    layouts: ['opposing', 'outside'],
    density: [0.24, 0.42],
    thickness: [0.35, 0.68],
    interference: [0.3, 0.55],
    resonance: [0.45, 0.85],
    waveDepth: [0.45, 0.78],
    warp: [0.04, 0.2],
    stretch: [0.5, 0.9],
    power: [1.3, 1.7],
    satellite: [0.8, 1],
  },
  flow: {
    // broad wavelength, smooth warp, off-axis placement -> long sweeping arcs
    layouts: ['outside', 'diagonal'],
    density: [0.18, 0.38],
    thickness: [0.4, 0.72],
    interference: [0.18, 0.45],
    resonance: [0.3, 0.7],
    waveDepth: [0.42, 0.75],
    warp: [0.45, 0.85],
    stretch: [0.25, 0.65],
    power: [0.85, 1.25],
    satellite: [0.75, 1],
  },
}

function buildSources(pattern: Pattern, n: number, layout: Layout, r: Rng): PgSource[] {
  const f = FAMILY[pattern]
  const pts = layoutOrigins(layout, n, r)
  const baseRot = r.range(0, TAU)
  // Clean fringes need equal, isotropic, unit-power sources. Unequal amplitudes
  // let one source dominate and you see its own rings instead of interference;
  // anisotropy and radial power bend the wavefronts out of step.
  const slit = layout === 'slit'

  return pts.map((p, i) => {
    // Tunnel and flow lean on anisotropy; the axis bias is shared so the
    // sources elongate together instead of cancelling each other out.
    const aniso = r.range(f.stretch[0], f.stretch[1])
    const along = r.bool() ? 1 : -1

    return {
      x: clamp(p.x, ORIGIN_MIN, ORIGIN_MAX),
      y: clamp(p.y, ORIGIN_MIN, ORIGIN_MAX),
      // resonance 0: spread wide apart, like 21.7 / 26.2 / 31.4 / 24.9
      spreadRatio: i === 0 ? 1 : r.range(0.78, 1.3),
      // resonance 1: exactly equal. Clean Young fringes need a single
      // wavelength — even a 2% mismatch makes the pattern crawl, because the
      // beat period is the reciprocal of the difference. The beating the moiré
      // needs is available across the rest of the Resonance range.
      tunedRatio: 1,
      phaseFree: r.range(0, TAU),
      phaseTuned: Math.round(r.range(0, 3)) * (Math.PI / 2),
      rot: baseRot + r.range(-0.4, 0.4),
      power: slit ? 1 : r.range(f.power[0], f.power[1]),
      drift: (r.bool() ? 1 : -1) * r.range(0.12, 0.38),
      amp: slit || i === 0 ? 1 : r.range(f.satellite[0], f.satellite[1]),
      sx: slit ? 1 : 1 + aniso * along * 0.5,
      sy: slit ? 1 : 1 - aniso * along * 0.5,
      wander: r.range(0, TAU),
    }
  })
}

interface Options {
  pattern?: Pattern
  waves?: WaveCount
  shape?: PgShape
  colors?: string[]
  darkBase?: boolean
}

function candidate(seed: string, tag: string, opt: Options): PgConfig {
  const r = rngFrom(seed + '|' + tag)
  const pattern = opt.pattern ?? (r.pick(PATTERNS) as Pattern)
  const waves = opt.waves ?? (r.pick([2, 2, 3, 4]) as WaveCount)
  const f = FAMILY[pattern]
  const layout = r.pick(f.layouts)

  // Colours are drawn from one row of the chart rather than from the whole set.
  // The rows are already harmonious; picking freely across all 39 reliably
  // produces clashes, and the user can still cross rows by hand afterwards.
  const colors =
    opt.colors ??
    (() => {
      const row = r.pick(PASTEL_ROWS)
      const count = r.int(1, MAX_COLORS)
      const pool = [...row]
      const out: string[] = []
      for (let i = 0; i < count && pool.length; i++) {
        out.push(pool.splice(Math.floor(r.next() * pool.length), 1)[0])
      }
      return out
    })()

  const stretchMag = r.range(f.stretch[0], f.stretch[1])
  const stretchAxis = r.range(0, TAU)

  // Full frame most of the time — a silhouette is a deliberate choice, not the
  // default look of the reference family.
  const shape = opt.shape ?? (r.bool(0.62) ? 'full' : (r.pick(PG_SHAPES) as PgShape))

  return {
    seed,
    // The medium is a prototype; the analytic engine stays the default so a
    // randomised avatar is still exactly reproducible.
    engine: 'analytic' as const,
    waves,
    pattern,
    sources: buildSources(pattern, waves, layout, r),

    // Lean toward the standing envelope: it is the cleaner read of the field and
    // the one that looks like an interference pattern rather than like water.
    // Young goes almost all the way — the envelope *is* the fringe pattern.
    fringe: pattern === 'young' ? r.range(0.82, 1) : r.range(0.45, 0.9),
    vibration: r.range(0.25, 0.6),
    // Point frequency on by default: a uniform medium is the plainer of the two.
    pointFrequency: true,
    // Absorbing by default. Reflection builds standing structure across the
    // frame, which is a deliberate look rather than a sensible default.
    reflect: false,
    viscosity: r.range(0.06, 0.3),
    inkBlend: r.bool(0.7) ? ('add' as const) : r.bool(0.6) ? ('opaque' as const) : ('multiply' as const),
    surface: r.bool(0.72) ? ('glossy' as const) : r.bool(0.6) ? ('matte' as const) : ('chrome' as const),

    // Each extra source multiplies into the moiré term, and a product's spatial
    // frequency is the sum of its factors' — so the base frequency has to come
    // down as waves are added or four sources always look like noise.
    density: r.range(f.density[0], f.density[1]) * (waves === 2 ? 1 : waves === 3 ? 0.8 : 0.66),
    thickness: r.range(f.thickness[0], f.thickness[1]),
    interference: r.range(f.interference[0], f.interference[1]),
    resonance: r.range(f.resonance[0], f.resonance[1]),
    waveDepth: r.range(f.waveDepth[0], f.waveDepth[1]),
    warp: r.range(f.warp[0], f.warp[1]),

    // Not pushed to the top of the range: the brief wants neutral cream and
    // low-saturation regions to stay common, not colour edge to edge.
    mesh: r.range(0.48, 0.84),
    lightIntensity: r.range(0.45, 0.78),
    shadowDepth: r.range(0.38, 0.7),
    chromatic: r.range(0.22, 0.58),
    grain: r.range(0.2, 0.5),
    interaction: r.range(0.4, 0.75),

    lightAngle: r.range(0, TAU),
    stretch: {
      x: clamp(Math.cos(stretchAxis) * stretchMag, -1, 1),
      y: clamp(Math.sin(stretchAxis) * stretchMag, -1, 1),
    },
    shape,
    colors,
    // Mostly paper. An ink base is a deliberate choice, not a default.
    darkBase: opt.darkBase ?? r.bool(0.14),
    audio: false,
  }
}

/** seed -> a validated configuration. Rejected candidates get one density
 *  repair — most failures are just too many or too few fringes — before the
 *  next composition is tried. */
export function configFromSeed(seed: string, opt: Options = {}): PgConfig {
  let last = candidate(seed, '0', opt)

  for (let attempt = 0; attempt < 12; attempt++) {
    const cfg = attempt === 0 ? last : candidate(seed, String(attempt), opt)
    last = cfg

    const v = validate(cfg)
    if (v.ok) return cfg

    const shift = v.reason === 'aliased' || v.reason === 'chaotic' ? -0.14 : 0.14
    const repaired = { ...cfg, density: clamp(cfg.density + shift, 0.08, 1) }
    if (validate(repaired).ok) return repaired
  }

  // Nothing passed in 12 tries: fall back to a density that cannot alias.
  return { ...last, density: clamp(last.density, 0.2, 0.5) }
}

/** The composition the page opens on. Fixed, so the playground always starts
 *  from something worth looking at. */
export const defaultConfig = (): PgConfig =>
  configFromSeed('vachana-2201', { pattern: 'interference', waves: 2, shape: 'full' })

/** New origin positions only — the rest of the composition is untouched. */
export function reroll(cfg: PgConfig, tag: string): PgConfig {
  const r = rngFrom(cfg.seed + '|origins|' + tag)
  const layout = r.pick(LAYOUTS)
  const pts = layoutOrigins(layout, cfg.waves, r)
  return {
    ...cfg,
    sources: cfg.sources.map((s, i) => ({
      ...s,
      x: clamp(pts[i].x, ORIGIN_MIN, ORIGIN_MAX),
      y: clamp(pts[i].y, ORIGIN_MIN, ORIGIN_MAX),
    })),
  }
}

/** Back to the layout this seed and family were born with. */
export function resetOrigins(cfg: PgConfig): PgConfig {
  const fresh = configFromSeed(cfg.seed, {
    pattern: cfg.pattern,
    waves: cfg.waves,
    shape: cfg.shape,
    colors: cfg.colors,
    darkBase: cfg.darkBase,
  })
  return {
    ...cfg,
    sources: cfg.sources.map((s, i) => ({
      ...s,
      x: fresh.sources[i]?.x ?? s.x,
      y: fresh.sources[i]?.y ?? s.y,
    })),
  }
}

/** Changing the wave count has to build real sources for the new slots, and a
 *  family is defined by its layout, so they come from the same generator. */
export function setWaves(cfg: PgConfig, waves: WaveCount): PgConfig {
  const fresh = configFromSeed(cfg.seed, {
    pattern: cfg.pattern,
    waves,
    shape: cfg.shape,
    colors: cfg.colors,
    darkBase: cfg.darkBase,
  })
  return {
    ...cfg,
    waves,
    // keep the origins the user has already positioned
    sources: fresh.sources.map((s, i) =>
      cfg.sources[i] ? { ...s, x: cfg.sources[i].x, y: cfg.sources[i].y } : s
    ),
  }
}

/** Switching family re-rolls the structural half and keeps material and light. */
export function setPattern(cfg: PgConfig, pattern: Pattern): PgConfig {
  const fresh = configFromSeed(cfg.seed, {
    pattern,
    waves: cfg.waves,
    shape: cfg.shape,
    colors: cfg.colors,
    darkBase: cfg.darkBase,
  })
  return {
    ...fresh,
    mesh: cfg.mesh,
    lightAngle: cfg.lightAngle,
    lightIntensity: cfg.lightIntensity,
    shadowDepth: cfg.shadowDepth,
    chromatic: cfg.chromatic,
    grain: cfg.grain,
    interaction: cfg.interaction,
    audio: cfg.audio,
  }
}
