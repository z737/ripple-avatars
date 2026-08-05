/* ---------------------------------------------------------------------------
   The pigment.

   There are no named palettes. The available colours are the whole pastel set
   below, and a configuration simply names the 1 to 4 of them it uses. Two things
   that used to be authored per palette are now derived:

   - **Attractor positions** come from a canonical layout for the count (one
     off-centre, two opposed, three in a triangle, four in a quadrant ring),
     rotated by a seeded angle. Placement stays part of the avatar's identity
     while the colours stay the user's choice.

   - **The paper tone** is derived from the selection: the average hue at very
     low chroma and very high lightness. This is deliberate, not lazy — using one
     of the chart's own pale tints as the base reads as a *colour* rather than as
     paper, and it drags a multi-hue selection into a single wash.

   Colours reach the shader already in OKLab, converted once here. The shader
   samples the gradient three times per pixel for chromatic refraction, so doing
   the forward conversion GPU-side would mean up to 12 cube roots per fragment
   for no visual gain.
   --------------------------------------------------------------------------- */

import { rngFrom } from '../engine/prng'

/** The CreativeBooster pastel chart, kept in its own rows. The rows are already
 *  harmonious, so they double as the groupings the randomiser draws from. */
export const PASTEL_ROWS: string[][] = [
  ['#fcd1f5', '#efbbf0', '#b795e4', '#97a5ee', '#95dff2'],
  ['#b7edf7', '#b4daf9', '#fed8ec', '#fbb1d3', '#fff1c2'],
  ['#efffdf', '#ceffc4', '#b3f9ff', '#b9d4ff', '#ffd1ff'],
  ['#f770e5', '#ff8ecc', '#ffaeb0', '#ffcb97', '#ffe791'],
  ['#efefef', '#b1e6f3', '#72ddf7', '#79b8f4', '#8093f1'],
  ['#eeeafd', '#d8caf6', '#c2a9ef', '#ac88e8', '#9667e0'],
  ['#9bf6ff', '#caffbf', '#fdffb6', '#ffd6a5', '#ffadad'],
  // Four, not five: the chart's last row repeats #fdffb6 from the row above, and
  // a picker that shows the same colour twice would light both up at once.
  ['#ffaaff', '#b2ffa3', '#94f6ff', '#7fb0ff'],
]

/** Every colour, in chart order. Deduplicated by construction above. */
export const PASTELS: string[] = PASTEL_ROWS.flat()

export const MIN_COLORS = 1
export const MAX_COLORS = 4

export interface Attractor {
  color: string
  x: number
  y: number
  radius: number
  falloff: number
}

/** Spread, radius and falloff per attractor count.
 *
 *  Tightened deliberately. The earlier radii were so wide that every attractor
 *  reached every point, so the blend was one averaged colour everywhere: measured
 *  2 levels of change over 0.3 UV and only 19 corner to corner. That flatness is
 *  why chromatic refraction did nothing — sampling three points across a gradient
 *  that has no gradient returns the same colour three times.
 *
 *  Tighter gaussians also serve the brief better, not worse: colour concentrates
 *  near each attractor and the neutral shows through between them, which is where
 *  the cream regions come from. */
const SHAPE: Record<number, { spread: number; radius: number; falloff: number }> = {
  1: { spread: 0.22, radius: 0.5, falloff: 1.6 },
  2: { spread: 0.34, radius: 0.42, falloff: 2.2 },
  3: { spread: 0.36, radius: 0.38, falloff: 2.4 },
  4: { spread: 0.38, radius: 0.34, falloff: 2.6 },
}

/** Place the chosen colours. Evenly spaced around the frame centre so no colour
 *  is crowded out, rotated by a seeded angle so two avatars with the same
 *  pigments still differ. */
export function meshAttractors(colors: string[], seed: string): Attractor[] {
  const used = colors.slice(0, MAX_COLORS)
  if (used.length === 0) return []

  const s = SHAPE[used.length] ?? SHAPE[4]
  const a0 = rngFrom(seed + '|mesh').range(0, Math.PI * 2)
  const step = (Math.PI * 2) / used.length

  return used.map((color, i) => {
    const a = a0 + i * step
    return {
      color,
      x: 0.5 + Math.cos(a) * s.spread,
      y: 0.5 + Math.sin(a) * s.spread,
      radius: s.radius,
      falloff: s.falloff,
    }
  })
}

// ---------------------------------------------------------------------------
// colour conversion
// ---------------------------------------------------------------------------
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const toGamma = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055

/** '#rrggbb' -> [r,g,b] in 0..1, gamma-encoded */
export function hex(h: string): [number, number, number] {
  const s = h.replace('#', '')
  return [
    parseInt(s.slice(0, 2), 16) / 255,
    parseInt(s.slice(2, 4), 16) / 255,
    parseInt(s.slice(4, 6), 16) / 255,
  ]
}

export type Lab = [number, number, number]

/** sRGB hex -> OKLab. Matches `oklabToLin` in the fragment shader. */
export function hexToOklab(h: string): Lab {
  const [r8, g8, b8] = hex(h)
  const r = toLinear(r8)
  const g = toLinear(g8)
  const b = toLinear(b8)

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ]
}

/** OKLab -> gamma-encoded sRGB, clamped. */
export function oklabToRgb(lab: Lab): [number, number, number] {
  const [L, A, B] = lab
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B
  const s_ = L - 0.0894841775 * A - 1.291485548 * B
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s

  return [
    Math.min(1, Math.max(0, toGamma(r))),
    Math.min(1, Math.max(0, toGamma(g))),
    Math.min(1, Math.max(0, toGamma(b))),
  ]
}

/** The base the pigment sits on, and the matte outside the shape mask.
 *
 *  Both are the selection's average hue held at very low chroma: a paper that
 *  belongs to the palette without competing with it. `dark` swaps it for an ink
 *  base, which is the only way to reach the deep look now that there is no
 *  hand-authored dark palette. */
export function baseTone(
  colors: string[],
  dark: boolean,
  /** Ink strokes need something to sit on. The references use a sage or tan
   *  mid-tone, not paper white — against a near-white base, pastel ink has almost
   *  no contrast and the strokes wash out. */
  midTone = false
): { neutral: Lab; matte: Lab } {
  let L = 0
  let A = 0
  let B = 0
  for (const c of colors) {
    const lab = hexToOklab(c)
    L += lab[0]
    A += lab[1]
    B += lab[2]
  }
  const n = Math.max(colors.length, 1)
  A /= n
  B /= n
  L /= n

  if (dark) {
    return { neutral: [0.26, A * 0.35, B * 0.35], matte: [0.95, A * 0.06, B * 0.06] }
  }
  if (midTone) {
    return { neutral: [0.74, A * 0.3, B * 0.3], matte: [0.95, A * 0.08, B * 0.08] }
  }
  return {
    neutral: [Math.max(L, 0.93), A * 0.16, B * 0.16],
    matte: [0.97, A * 0.07, B * 0.07],
  }
}
