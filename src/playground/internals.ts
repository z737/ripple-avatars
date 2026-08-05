/* ---------------------------------------------------------------------------
   Values the V1 brief keeps off the panel: warp geometry, exposure, contrast,
   ambient level, specular response and shape metrics.

   They are still part of the avatar's identity, so they are derived from the
   seed rather than hardcoded — a different seed gets a different surface, and
   the same seed always gets the same one.
   --------------------------------------------------------------------------- */

import { rngFrom } from '../engine/prng'
import { PgConfig } from './params'

export interface Internals {
  /** four spatial frequencies for the analytic domain warp */
  warpFreq: [number, number, number, number]
  /** and their phases */
  warpPhase: [number, number, number, number]
  exposure: number
  contrast: number
  /** how much of the pigment survives where no light reaches it */
  ambient: number
  /** specular is not exposed; it rides on wave depth and light intensity */
  specular: number
  shapeSize: number
  shapeSoft: number
  /** spatial scale of the medium's per-point frequency map, and its offset */
  freqScale: number
  freqPhase: [number, number]
  /** rotation of the ink gradient relative to the base one, so a stroke's hue
   *  differs from the paper it sits on instead of vanishing into it */
  inkRot: number
}

export function internals(cfg: PgConfig): Internals {
  const r = rngFrom(cfg.seed + '|internal|' + cfg.pattern)
  const dark = cfg.darkBase

  return {
    // Low frequencies only. High-frequency warp would shred the moiré cells;
    // the brief needs them readable at full warp.
    warpFreq: [r.range(1.1, 2.6), r.range(1.1, 2.6), r.range(1.1, 2.6), r.range(1.1, 2.6)],
    warpPhase: [r.range(0, 6.283), r.range(0, 6.283), r.range(0, 6.283), r.range(0, 6.283)],
    exposure: dark ? r.range(0.94, 1.04) : r.range(0.98, 1.08),
    contrast: dark ? r.range(1.0, 1.1) : r.range(1.02, 1.14),
    ambient: dark ? r.range(0.5, 0.62) : r.range(0.62, 0.74),
    specular: r.range(0.5, 0.9),
    shapeSize: cfg.shape === 'full' ? 1 : r.range(0.84, 0.94),
    shapeSoft: cfg.shape === 'full' ? 0.002 : r.range(0.008, 0.035),
    // A low number: roughly one undulation of stiffer and slacker medium across
    // the frame. Higher would scatter every wave within a few texels and the
    // field would read as grain rather than as structure.
    freqScale: r.range(4, 9),
    freqPhase: [r.range(0, 6.283), r.range(0, 6.283)],
    inkRot: r.range(1.2, 5.1),
  }
}
