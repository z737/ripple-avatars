/* ---------------------------------------------------------------------------
   Internal render resolution.

   Deliberately not devicePixelRatio: a 500 CSS-px avatar at DPR 3 is 1500²
   fragments of isoline extraction for no visible gain, and it is exactly what
   makes this kind of shader unusable on integrated GPUs.
   --------------------------------------------------------------------------- */

export type Tier = 'high' | 'normal' | 'weak'

export const TIER_SIZE: Record<Tier, number> = {
  high: 640,
  normal: 500,
  weak: 384,
}

const HIGH = /(apple m[1-9]|rtx|radeon pro|geforce|quadro|arc a)/i
const WEAK = /(mali|adreno [1-5]|powervr|intel.*(hd|uhd) graphics [45]|swiftshader|llvmpipe)/i

export function detectTier(gl: WebGL2RenderingContext): Tier {
  let renderer = ''
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  if (ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '')

  const cores = navigator.hardwareConcurrency ?? 4
  const mobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent)

  if (WEAK.test(renderer) || cores <= 3) return 'weak'
  if (mobile) return renderer && HIGH.test(renderer) ? 'normal' : 'weak'
  if (HIGH.test(renderer) && cores >= 8) return 'high'
  return 'normal'
}

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
