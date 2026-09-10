/* ---------------------------------------------------------------------------
   Seed -> a tile mark.

   Randomising 64 corner radii independently gives noise, not a mark. Two rules
   keep the family readable:

   - Corners quantise to a few steps, so radii repeat across tiles instead of
     every corner being its own arbitrary number. That repetition is what makes
     sixteen different tiles look like one set.
   - Shades are dealt from a shuffled ramp rather than drawn independently, so
     all sixteen steps appear exactly once. Independent draws clump — you get
     five near-identical pale tiles and no dark one, which loses the depth the
     reference gets from a couple of deep tiles anchoring the grid.
   --------------------------------------------------------------------------- */

import { Rng, rngFrom } from '../engine/prng'
import { TILE_COUNT, Tile, V3Config } from './params'

/** Radii snap to these fractions of the half-size. 1 is a full quarter-circle,
 *  0 is a square corner; the reference uses mostly the extremes with a few
 *  mediums between. */
const STEPS = [0, 0.35, 0.6, 0.85, 1]

function drawRadius(r: Rng, min: number, max: number, roundness: number): number {
  const t = r.next()
  // biased toward the round end, then mapped into the requested window
  const biased = Math.pow(t, 1 - 0.65 * roundness)
  const raw = min + biased * (max - min)
  // snap to the nearest step so corners rhyme across tiles
  return STEPS.reduce((best, s) => (Math.abs(s - raw) < Math.abs(best - raw) ? s : best), STEPS[0])
}

/** Fisher-Yates on a seeded generator, so the deal is reproducible. */
function shuffled<T>(items: T[], r: Rng): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r.next() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function tilesFromSeed(
  seed: string,
  opts: { radiusMin: number; radiusMax: number; roundness: number }
): Tile[] {
  const r = rngFrom(seed + '|tiles')

  // every step of the ramp used exactly once, then shuffled into place
  const shades = shuffled(
    Array.from({ length: TILE_COUNT }, (_, i) => i / (TILE_COUNT - 1)),
    r
  )

  return Array.from({ length: TILE_COUNT }, (_, i) => ({
    radii: [
      drawRadius(r, opts.radiusMin, opts.radiusMax, opts.roundness),
      drawRadius(r, opts.radiusMin, opts.radiusMax, opts.roundness),
      drawRadius(r, opts.radiusMin, opts.radiusMax, opts.roundness),
      drawRadius(r, opts.radiusMin, opts.radiusMax, opts.roundness),
    ] as [number, number, number, number],
    shade: shades[i],
  }))
}

export function configFromSeed(seed: string, keep?: Partial<V3Config>): V3Config {
  const r = rngFrom(seed + '|v3')

  const radiusMin = keep?.radiusMin ?? 0
  const radiusMax = keep?.radiusMax ?? 1
  const roundness = keep?.roundness ?? r.range(0.45, 0.8)

  return {
    seed,
    hue: keep?.hue ?? r.range(0, 360),
    shadeSpread: keep?.shadeSpread ?? r.range(0.55, 0.85),
    saturation: keep?.saturation ?? r.range(0.45, 0.8),

    tiles: tilesFromSeed(seed, { radiusMin, radiusMax, roundness }),

    gutter: keep?.gutter ?? r.range(0.12, 0.22),
    radiusMin,
    radiusMax,
    roundness,

    spread: keep?.spread ?? 0.5,
    spreadReach: keep?.spreadReach ?? 0.35,
    lift: keep?.lift ?? 0.4,

    layout: keep?.layout ?? 'square',
    goo: keep?.goo ?? 0.55,

    absGrid: keep?.absGrid ?? 32,
    absDensity: keep?.absDensity ?? r.range(0.4, 0.58),
    absBond: keep?.absBond ?? r.range(0.25, 0.45),
    // "Decent" rather than extreme: at 0 the merge shows every square it was
    // cut from, and the mark reads pixelated. High is right here — a cell is
    // only a building block, and once a cluster is fused what shows is the
    // outline, not the cells.
    absRadius: keep?.absRadius ?? 0.85,
  }
}

export const defaultConfig = (): V3Config =>
  // Opens close to the reference mark. 252 rather than the ~202 a colour picker
  // would suggest for blue: OKLCH hue is not sRGB hue, and 202 lands on teal.
  ({ ...configFromSeed('tile-0416'), hue: 252 })

/** Re-roll only the radii, leaving hue, shades and layout alone. */
export function rerollRadii(cfg: V3Config, tag: string): V3Config {
  return {
    ...cfg,
    tiles: tilesFromSeed(cfg.seed + '|' + tag, cfg),
  }
}
