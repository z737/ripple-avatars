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

/** Square lays the 16 components on a 4x4 grid; Circle lays them in a polar
 *  arrangement of 1 + 5 + 10 that fills a disc; Abstract keeps the disc but
 *  builds each of the 16 components out of many small squares on a fine grid.
 *  All three are always 16 components. */
export const LAYOUTS = ['square', 'circle', 'abstract'] as const
export type Layout = (typeof LAYOUTS)[number]
export const LAYOUT_LABEL: Record<Layout, string> = {
  square: 'Square',
  circle: 'Circle',
  abstract: 'Abstract',
}

/** Cells per side for Abstract. Coarse reads chunky and hand-cut; fine reads
 *  as smooth organic blobs. Powers of two only because nothing here needs the
 *  steps between them. */
export const ABSTRACT_GRIDS = [16, 32, 64] as const
export const ABSTRACT_GRID_LABEL: Record<string, string> = {
  '16': 'Coarse',
  '32': 'Medium',
  '64': 'Fine',
}

/** Components per ring, outward from the centre. Sums to TILE_COUNT.
 *
 *  1 + 5 + 10 rather than an even 4 + 6 + 6: an odd inner ring stops the mark
 *  from mirroring itself, and doubling the count each ring outward keeps the
 *  components closer to equal area than equal counts would. */
export const RINGS = [1, 5, 10] as const

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

  layout: Layout
  /** how far apart two components fuse, as a fraction of a cell. 0 keeps them
   *  separate; higher lets them reach for each other and merge. */
  goo: number

  // --- Abstract only ------------------------------------------------------
  /** cells per side of the fine grid the blobs are cut from */
  absGrid: number
  /** fraction of the disc that gets filled; the rest is holes and gaps */
  absDensity: number
  /** chance that two components are allowed to touch and fuse. 0 leaves sixteen
   *  islands; 1 welds the whole disc into one mass. */
  absBond: number
  /** one corner radius for every cell. Abstract has no per-corner logic — the
   *  shape variety comes from how cells clump, not from their corners. */
  absRadius: number
}

export const V3_RANGES = {
  shadeSpread: { label: 'Shade spread' },
  saturation: { label: 'Saturation' },
  gutter: { label: 'Gutter' },
  radiusMin: { label: 'Radius min' },
  radiusMax: { label: 'Radius max' },
  roundness: { label: 'Roundness' },
  spread: { label: 'Reach out' },
  spreadReach: { label: 'Falloff' },
  lift: { label: 'Lift' },
  goo: { label: 'Goo' },
  absDensity: { label: 'Density' },
  absBond: { label: 'Bonding' },
  absRadius: { label: 'Corner' },
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

export interface PolarCell {
  ring: number
  /** index within its ring */
  slot: number
  count: number
  /** mid radius, and half the radial extent, in unit-square units */
  rMid: number
  rHalf: number
  /** mid angle and half the angular extent, radians */
  aMid: number
  aHalf: number
}

/** Where each component sits in the disc. Ring 0 is the centre disc, which has
 *  no angular extent to speak of — it is flagged by aHalf >= PI so the shader
 *  can treat it as a plain circle rather than an annular sector. */
export function polarCellOf(index: number, gutter: number): PolarCell {
  let ring = 0
  let slot = index
  for (const count of RINGS) {
    if (slot < count) break
    slot -= count
    ring++
  }
  const count = RINGS[ring]

  // Ring radii divide the disc into RINGS.length bands of equal width.
  const band = 0.5 / RINGS.length
  const inner = ring * band
  const outer = inner + band
  const pad = (band * gutter) / 2

  if (ring === 0) {
    return {
      ring, slot, count,
      rMid: 0,
      rHalf: outer - pad,
      aMid: 0,
      aHalf: Math.PI,   // marks "this is the centre disc"
    }
  }

  const step = (Math.PI * 2) / count
  // Odd rings are rotated by a half step so seams do not line up radially.
  const rotate = ring % 2 === 1 ? step / 2 : 0
  return {
    ring, slot, count,
    rMid: (inner + outer) / 2,
    rHalf: (outer - inner) / 2 - pad,
    aMid: slot * step + rotate,
    aHalf: step / 2 - gutter * step * 0.35,
  }
}
