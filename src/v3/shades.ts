/* ---------------------------------------------------------------------------
   One hue, sixteen shades.

   Built in OKLCH so the steps are perceptually even. Stepping lightness in sRGB
   instead would bunch the pale tiles together and leave a hole in the middle of
   the ramp — the grid would read as "some pale tiles and two dark ones" rather
   than as an even scale.

   Chroma tapers as lightness rises. A pale tile physically cannot hold much
   chroma, and asking for it clips a channel and shifts the hue, so the pale end
   would drift away from the hue everything else shares.
   --------------------------------------------------------------------------- */

import { oklabToRgb } from '../playground/palettes'
import { V3Config } from './params'

type Rgb = [number, number, number]

function oklch(L: number, C: number, hueDeg: number): Rgb {
  const h = (hueDeg * Math.PI) / 180
  return oklabToRgb([L, C * Math.cos(h), C * Math.sin(h)])
}

/** shade 0 is the palest tile, 1 the deepest. */
export function shadeRgb(cfg: V3Config, shade: number): Rgb {
  const top = 0.93
  const bottom = top - 0.46 * cfg.shadeSpread
  const L = top - shade * (top - bottom)

  // Taper: full chroma at the deep end, a fraction of it at the pale end.
  //
  // Calibrated against the reference mark rather than guessed. 0.17 put the
  // deepest tile at C 0.08 and the whole grid read as desaturated teal-grey;
  // the reference's deep blue is nearer C 0.15, which is what 0.32 gives at the
  // bottom of the ramp while leaving the pale end a light tint.
  const C = cfg.saturation * 0.32 * (1.12 - L)

  return oklch(L, Math.max(C, 0), cfg.hue)
}

/** The paper the mark sits on. A tint of the same hue rather than pure white,
 *  so the palest tiles still separate from it. */
export function bgRgb(cfg: V3Config): Rgb {
  const L = 1 - 0.86 * cfg.background
  return oklch(L, cfg.saturation * 0.035, cfg.hue)
}
