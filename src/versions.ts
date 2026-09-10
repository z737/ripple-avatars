/* ---------------------------------------------------------------------------
   The platform's versions, in one place.

   Each version is a whole generation of the renderer rather than a page: v1
   draws isolines over a mesh gradient, v2 treats the wave field as a height
   field and reads it through four engines. They share the seed system, the
   design tokens and the PRNG, and nothing else — which is why they stay as
   separate versions instead of one page with a mode switch.
   --------------------------------------------------------------------------- */

export const PLATFORM_NAME = 'Avatar Playground'

export const VERSIONS = [
  {
    id: 'v1',
    label: 'v1',
    /** shown in the picker, so it has to say what the version *is* */
    summary: 'Isoline avatars',
  },
  {
    id: 'v2',
    label: 'v2',
    summary: 'Chromatic ripple',
  },
  {
    id: 'v3',
    label: 'v3',
    summary: 'Tile mark',
  },
] as const

export type VersionId = (typeof VERSIONS)[number]['id']

/** What loads when someone arrives with no version in the URL. */
export const DEFAULT_VERSION: VersionId = 'v3'

export const versionRoute = (id: VersionId) => `#/${id}`

/** Which version a hash asks for, or null if it names none.
 *
 *  Matched on the path segment alone so query-ish suffixes survive — `#/v2?debug`
 *  has to keep working, since that is how the debug views are reached. */
export function versionFromHash(hash: string): VersionId | null {
  const path = hash.replace(/^#\/?/, '').split(/[?&#]/)[0].toLowerCase()
  return VERSIONS.some((v) => v.id === path) ? (path as VersionId) : null
}
