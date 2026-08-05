/* ---------------------------------------------------------------------------
   CPU mirror of the height field, used only by the randomiser's rejection pass.

   The brief asks randomisation to reject "empty, flat, over-saturated, aliased
   or chaotic" results. Structure can be judged without a GPU: the density of
   zero crossings says whether there is geometry at all and whether there is too
   much of it, and the peak phase gradient says whether the surface oscillates
   faster than the pixel grid can sample — which in a lit height field shows up
   as normal-map speckle rather than as clean interference.

   This mirrors the shader including the analytic warp, which is only four
   sinusoids. It does not need the light or the material: what is being judged
   is the shape of the surface.
   --------------------------------------------------------------------------- */

import { internals } from './internals'
import { densityToFreq, interferenceToMix, resolveSource, sourceScale, thicknessToProfile } from './mapping'
import { PgConfig } from './params'

/** Minimum pixels per oscillation.
 *
 *  This is an avatar at 500px, not a wallpaper — the number is set by what reads
 *  well at that size, not by the Nyquist limit. Below roughly 20px per cell the
 *  surface stops looking like relief and starts looking like corduroy, which is
 *  well before it actually aliases. A shaded height field also needs more room
 *  than a drawn isoline did: a normal has to resolve both flanks of a ridge. */
const MIN_PX_PER_FRINGE = 22

interface Prepared {
  x: number
  y: number
  cos: number
  sin: number
  isx: number
  isy: number
  k: number
  phase: number
  power: number
  amp: number
}

interface Ctx {
  src: Prepared[]
  mix: number
  fringe: number
  profile: number
  norm: number
  warpAmp: number
  warpFreq: number[]
  warpPhase: number[]
}

function prepare(cfg: PgConfig): Ctx {
  const freq = densityToFreq(cfg.density)
  const d = internals(cfg)

  const src = cfg.sources.slice(0, cfg.waves).map((s) => {
    const { ratio, phase } = resolveSource(s, cfg.resonance)
    const [sx, sy] = sourceScale(s, cfg)
    return {
      x: s.x,
      y: s.y,
      cos: Math.cos(-s.rot),
      sin: Math.sin(-s.rot),
      isx: 1 / Math.max(sx, 1e-3),
      isy: 1 / Math.max(sy, 1e-3),
      k: freq * ratio,
      phase,
      power: s.power,
      amp: s.amp,
    }
  })

  return {
    src,
    mix: interferenceToMix(cfg.interference),
    fringe: cfg.fringe,
    profile: thicknessToProfile(cfg.thickness),
    norm: Math.pow(1.414, src.length),
    warpAmp: 0.42 * Math.pow(Math.min(Math.max(cfg.warp, 0), 1), 1.5),
    warpFreq: d.warpFreq,
    warpPhase: d.warpPhase,
  }
}

function warp(c: Ctx, x: number, y: number): [number, number] {
  if (c.warpAmp <= 0.0001) return [x, y]
  const [a, b, cc, dd] = c.warpFreq
  const [p1, p2, p3, p4] = c.warpPhase
  return [
    x + c.warpAmp * (Math.sin(a * y + p1) + 0.5 * Math.sin(b * x + p2)),
    y + c.warpAmp * (Math.sin(cc * x + p3) + 0.5 * Math.sin(dd * y + p4)),
  ]
}

/** Height at a point in visible UV space, at t = 0. */
function evaluate(c: Ctx, px: number, py: number) {
  const [x, y] = warp(c, px, py)

  // Complex superposition, mirroring sourcePhasor in the shader: the validator
  // has to judge the surface that is actually drawn, and the additive branch is
  // now a phasor sum with 1/sqrt(r) spreading rather than a sum of sines.
  let re = 0
  let im = 0
  let mul = 1
  for (const s of c.src) {
    const dx = x - s.x
    const dy = y - s.y
    const qx = (dx * s.cos - dy * s.sin) * s.isx
    const qy = (dx * s.sin + dy * s.cos) * s.isy
    const r = Math.max(Math.hypot(qx, qy), 1e-4)
    const theta = Math.pow(r, s.power) * s.k + s.phase
    const a = s.amp / Math.sqrt(r + 0.15)
    re += a * Math.cos(theta)
    im += a * Math.sin(theta)
    mul *= a * Math.cos(theta)
  }
  const n = c.src.length
  re /= n
  im /= n
  const disp = re
  const env = Math.hypot(re, im) * 1.6 - 0.55
  const add = disp + (env - disp) * c.fringe
  mul *= c.norm

  const base = add + (mul - add) * c.mix
  return Math.tanh(base * c.profile) / Math.tanh(c.profile)
}

/** Steepest oscillation the surface carries at this point, in radians per unit
 *  UV — the quantity that decides whether it aliases.
 *
 *  Additive and multiplicative fields have to be counted differently. A sum of
 *  sines oscillates no faster than its fastest term, but a *product* generates
 *  sum frequencies: two sources at f1 and f2 put energy at f1 + f2. Taking the
 *  max for both would let cellular compositions past the guard at roughly half
 *  the density they actually need. */
function peakPhaseGradient(c: Ctx, x: number, y: number) {
  let maxG = 0
  let sumG = 0
  for (const s of c.src) {
    const dx = x - s.x
    const dy = y - s.y
    const qx = (dx * s.cos - dy * s.sin) * s.isx
    const qy = (dx * s.sin + dy * s.cos) * s.isy
    const r = Math.max(Math.hypot(qx, qy), 1e-3)
    // d/dr of (r^p * k), times the worst-case axis compression
    const grad = s.k * s.power * Math.pow(r, s.power - 1) * Math.max(s.isx, s.isy)
    maxG = Math.max(maxG, grad)
    sumG += grad
  }
  return maxG + (sumG - maxG) * c.mix
}

export interface FieldStats {
  /** fraction of neighbouring sample pairs that straddle a zero */
  crossings: number
  variance: number
  /** pixels per oscillation at the tightest point in the frame */
  minPxPerFringe: number
}

export function measure(cfg: PgConfig, renderSize = 500, steps = 33): FieldStats {
  const c = prepare(cfg)

  const n = steps * steps
  const v = new Float64Array(n)
  let peak = 0

  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const x = i / (steps - 1)
      const y = j / (steps - 1)
      v[j * steps + i] = evaluate(c, x, y)
      peak = Math.max(peak, peakPhaseGradient(c, x, y))
    }
  }

  let mean = 0
  for (let i = 0; i < n; i++) mean += v[i]
  mean /= n
  let variance = 0
  for (let i = 0; i < n; i++) variance += (v[i] - mean) ** 2
  variance /= n

  let cross = 0
  let pairs = 0
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const a = v[j * steps + i]
      if (i + 1 < steps) {
        if (a * v[j * steps + i + 1] < 0) cross++
        pairs++
      }
      if (j + 1 < steps) {
        if (a * v[(j + 1) * steps + i] < 0) cross++
        pairs++
      }
    }
  }

  const cyclesPerUv = peak / (Math.PI * 2)
  const minPxPerFringe = cyclesPerUv > 1e-6 ? renderSize / cyclesPerUv : Infinity

  return { crossings: cross / Math.max(pairs, 1), variance, minPxPerFringe }
}

export interface Verdict {
  ok: boolean
  reason?: 'flat' | 'empty' | 'chaotic' | 'aliased'
  stats: FieldStats
}

export function validate(cfg: PgConfig, renderSize = 500): Verdict {
  const stats = measure(cfg, renderSize)
  // The profile remap squashes the field toward +/-1, so the variance floor is
  // about "is there any relief at all" rather than a contrast measure.
  if (stats.variance < 0.02) return { ok: false, reason: 'flat', stats }
  if (stats.crossings < 0.06) return { ok: false, reason: 'empty', stats }
  // Multiplicative fields legitimately cross zero far more often than additive
  // ones — the zero set is the union of every source's — so this ceiling sits
  // higher than it would for a single wave.
  if (stats.crossings > 0.8) return { ok: false, reason: 'chaotic', stats }
  if (stats.minPxPerFringe < MIN_PX_PER_FRINGE) return { ok: false, reason: 'aliased', stats }
  return { ok: true, stats }
}
