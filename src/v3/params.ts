/* ---------------------------------------------------------------------------
   v3 — Tile Mark.

   A square divided into 16 components. Every tile keeps the same silhouette —
   a quad — and differs only in how each of its four corners is rounded, and in
   which shade of one hue it takes.

   That constraint is the whole design: one shape, one hue, and all the variety
   comes from 64 corner radii and 16 lightness steps. Nothing here is a wave, so
   v3 shares only the seed system and the design tokens with v1 and v2.
   --------------------------------------------------------------------------- */

/** 4 x 4. Fixed, because "16 components" is the design rather than a parameter. */
export const GRID = 4
export const TILE_COUNT = GRID * GRID

/** Corner order, and the order the four radius sliders appear in. */
export const CORNERS = ['tl', 'tr', 'br', 'bl'] as const
export type Corner = (typeof CORNERS)[number]
export const CORNER_LABEL: Record<Corner, string> = {
  tl: 'Top left',
  tr: 'Top right',
  br: 'Bottom right',
  bl: 'Bottom left',
}

export interface Tile {
  /** per-corner radius as a fraction of the tile's half-size: 0 square, 1 a
   *  full quarter-circle. Order matches CORNERS. */
  radii: [number, number, number, number]
  /** which step of the shade ramp this tile takes, 0..1 */
  shade: number
}

export interface V3Config {
  seed: string

  /** base hue in degrees; every tile is a shade of it */
  hue: number
  /** how much lightness varies across the 16 tiles */
  shadeSpread: number
  /** chroma of the ramp — 0 is greyscale */
  saturation: number

  tiles: Tile[]

  /** gap between tiles, as a fraction of the cell */
  gutter: number
  /** the randomiser draws radii from this window */
  radiusMin: number
  radiusMax: number
  /** pushes drawn radii toward the round end, so tiles read as a family rather
   *  than as noise */
  roundness: number

  /** how far neighbours are pushed away from the hovered tile */
  spread: number
  /** how many cells out the push still reaches */
  spreadReach: number
  /** how much the hovered tile grows */
  lift: number

  background: number
}

export const V3_RANGES = {
  shadeSpread: { label: 'Shade spread' },
  saturation: { label: 'Saturation' },
  gutter: { label: 'Gutter' },
  radiusMin: { label: 'Radius min' },
  radiusMax: { label: 'Radius max' },
  roundness: { label: 'Roundness' },
  spread: { label: 'Spread' },
  spreadReach: { label: 'Reach' },
  lift: { label: 'Lift' },
  background: { label: 'Background' },
} as const

export type V3RangeKey = keyof typeof V3_RANGES

/** row, column and centre of a tile in the unit square. */
export function cellOf(index: number) {
  const col = index % GRID
  const row = Math.floor(index / GRID)
  return {
    row,
    col,
    cx: (col + 0.5) / GRID,
    cy: (row + 0.5) / GRID,
  }
}
