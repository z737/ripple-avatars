/* ---------------------------------------------------------------------------
   Abstract — a disc cut out of a fine grid of squares.

   Square and Circle place sixteen large components directly. Abstract keeps the
   sixteen, but each one is now a *cluster* of small squares grown on a grid of
   16, 32 or 64 cells a side. The goo then fuses each cluster into one organic
   blob, and fuses neighbouring clusters wherever they happen to touch — so
   which components are joined and which stand alone falls out of the growth
   rather than out of a separate random roll.

   Three decisions carry the look:

   - Grown, not sampled. Assigning cells to the nearest of sixteen seeds gives
     Voronoi cells: convex, straight-edged, obviously computed. Growing each
     blob one random frontier cell at a time gives lobes and inlets, which is
     what the reference sketch has.
   - Mirrored. Eight blobs are grown in the left half and reflected, so the
     silhouette is bilaterally symmetric and the mark reads as deliberate. The
     reflection is geometric only: a mirrored pair takes two *different* shades,
     so all sixteen steps of the ramp still appear.
   - The edge is cell-quantised. A cell is either in the disc or out, so the
     boundary steps in whole squares and the goo softens it. Clipping the mark
     to a true circle instead would slice the corner radii flat, which is the
     one thing this shape language cannot survive.
   --------------------------------------------------------------------------- */

import { rngFrom } from '../engine/prng'
import { TILE_COUNT } from './params'

/** Blobs actually grown. The other eight are their mirror images. */
const HALF = TILE_COUNT / 2

/** Candidates weighed per seed when spreading the starting points. Enough for
 *  an even scatter; more just costs time for no visible gain. */
const CANDIDATES = 14

export interface AbstractMask {
  grid: number
  /** component id + 1 per cell, 0 for empty. Row-major, row 0 at the top, which
   *  is both the shader's uv orientation and the texture upload order. */
  cells: Uint8Array
  /** fused-cluster id + 1 per cell, 0 for empty.
   *
   *  Two cells share a group when they are connected through bonded
   *  components. The shader needs this because the fillet radius that makes a
   *  cluster read as one organic mass is wider than the channel left between
   *  unbonded blobs — so a single smooth minimum over everything would weld the
   *  whole disc together and Bonding would control nothing. Merging is smooth
   *  inside a group and hard between groups, which decouples the two. */
  groups: Uint8Array
  /** how many fused clusters the mark has */
  clusters: number
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

export function abstractFromSeed(
  seed: string,
  opts: { grid: number; density: number; bond: number }
): AbstractMask {
  const G = Math.max(4, Math.round(opts.grid))
  const half = G >> 1
  const cw = 1 / G
  const r = rngFrom(`${seed}|abs|${G}`)

  // Cell centres inside this radius are in the disc. Pulled in by more than
  // half a cell so that the widest the goo can bulge still lands inside the
  // canvas rather than clipping against its edge.
  const radius = 0.5 - 0.7 * cw
  const inDisc = (col: number, row: number) => {
    const dx = (col + 0.5) * cw - 0.5
    const dy = (row + 0.5) * cw - 0.5
    return dx * dx + dy * dy <= radius * radius
  }

  // Every cell in the left half of the disc, as flat indices.
  const pool: number[] = []
  for (let row = 0; row < G; row++) {
    for (let col = 0; col < half; col++) {
      if (inDisc(col, row)) pool.push(row * G + col)
    }
  }

  const cells = new Uint8Array(G * G)
  const groups = new Uint8Array(G * G)
  if (pool.length < HALF) return { grid: G, cells, groups, clusters: 0 }

  const colOf = (i: number) => i % G
  const rowOf = (i: number) => Math.floor(i / G)

  // --- starting points -----------------------------------------------------
  // Best-candidate sampling: pick the farthest of several random tries. Plain
  // random seeds clump, and two blobs starting adjacent grow as one.
  const seeds: number[] = []
  for (let b = 0; b < HALF; b++) {
    let best = -1
    let bestDist = -1
    for (let c = 0; c < CANDIDATES; c++) {
      const cand = pool[Math.floor(r.next() * pool.length)]
      let nearest = Infinity
      for (const s of seeds) {
        const dx = colOf(cand) - colOf(s)
        const dy = rowOf(cand) - rowOf(s)
        nearest = Math.min(nearest, dx * dx + dy * dy)
      }
      if (nearest > bestDist) {
        bestDist = nearest
        best = cand
      }
    }
    seeds.push(best)
  }

  // --- growth --------------------------------------------------------------
  const owner = new Int8Array(G * G).fill(-1)
  const frontier: number[][] = []
  const size = new Int32Array(HALF)

  // Uneven budgets, so the mark has a few large masses and a few small
  // fragments rather than sixteen blobs of one size.
  const weights = Array.from({ length: HALF }, () => r.range(0.45, 1.55))
  const weightSum = weights.reduce((a, b) => a + b, 0)
  const budget = Math.max(HALF, Math.round(pool.length * opts.density))
  const target = weights.map((w) => Math.max(1, Math.round((budget * w) / weightSum)))

  // --- who may touch whom --------------------------------------------------
  // Decided before growing, not after. Letting all sixteen blobs grow into
  // contact and then eroding the seams afterwards eats whole blobs at the
  // coarse grid, where a blob is only three or four cells. Settling the bonds
  // first means growth simply stops one cell short of an unbonded neighbour,
  // leaving a channel the goo cannot bridge, and no blob loses any mass.
  const bond: boolean[][] = Array.from({ length: HALF }, () => new Array(HALF).fill(true))
  for (let a = 0; a < HALF; a++) {
    for (let b = a + 1; b < HALF; b++) {
      const joined = r.next() < opts.bond
      bond[a][b] = joined
      bond[b][a] = joined
    }
  }

  /** True if claiming this cell for `b` would put it against a blob `b` is not
   *  bonded to. Owners never change, so a cell that fails this can be dropped
   *  from the frontier for good. */
  const blocked = (cell: number, b: number) => {
    const col = colOf(cell)
    const row = rowOf(cell)
    for (const [dc, dr] of NEIGHBOURS) {
      const nc = col + dc
      const nr = row + dr
      if (nc < 0 || nc >= half || nr < 0 || nr >= G) continue
      const o = owner[nr * G + nc]
      if (o >= 0 && o !== b && !bond[b][o]) return true
    }
    return false
  }

  /** Unclaimed 4-neighbours of a cell, inside the left half of the disc. The
   *  frontier holds candidates to *claim*, so it is never the cell itself. */
  const pushNeighbours = (cell: number, f: number[]) => {
    const col = colOf(cell)
    const row = rowOf(cell)
    for (const [dc, dr] of NEIGHBOURS) {
      const nc = col + dc
      const nr = row + dr
      if (nc < 0 || nc >= half || nr < 0 || nr >= G) continue
      const n = nr * G + nc
      if (owner[n] < 0 && inDisc(nc, nr)) f.push(n)
    }
  }

  for (let b = 0; b < HALF; b++) {
    const s = seeds[b]
    const f: number[] = []
    // A duplicate seed would leave one blob with nothing to grow from; the
    // owner check keeps it empty rather than corrupting its neighbour.
    if (owner[s] < 0) {
      owner[s] = b
      size[b] = 1
      pushNeighbours(s, f)
    }
    frontier.push(f)
  }

  let filled = HALF
  for (;;) {
    let placedAny = false

    // Round-robin one cell per blob per pass, so all eight advance together.
    // Draining one blob at a time lets the first one wander across the disc and
    // wall the others in.
    for (let b = 0; b < HALF; b++) {
      if (size[b] >= target[b] || filled >= budget) continue
      const f = frontier[b]

      while (f.length > 0) {
        // Random frontier cell, swap-popped. Taking the newest cell instead
        // grows a snake; taking the oldest grows a disc. Random gives lobes.
        const j = Math.floor(r.next() * f.length)
        const cell = f[j]
        f[j] = f[f.length - 1]
        f.pop()
        if (owner[cell] >= 0 || blocked(cell, b)) continue

        owner[cell] = b
        size[b]++
        filled++
        placedAny = true
        pushNeighbours(cell, f)
        break
      }
    }

    // Every blob is either at its target or boxed in with nowhere left to go.
    if (!placedAny) break
  }

  // --- mirror --------------------------------------------------------------
  for (let row = 0; row < G; row++) {
    for (let col = 0; col < half; col++) {
      const o = owner[row * G + col]
      if (o < 0) continue
      cells[row * G + col] = o + 1
      cells[row * G + (G - 1 - col)] = o + 1 + HALF
    }
  }

  // --- fused clusters ------------------------------------------------------
  // A flood fill over filled cells, after the mirror, so a blob that reaches
  // the centre line joins with its own reflection and the two halves read as
  // one mark rather than two.
  let clusters = 0
  const stack: number[] = []
  for (let start = 0; start < G * G; start++) {
    if (cells[start] === 0 || groups[start] !== 0) continue
    clusters++
    groups[start] = clusters
    stack.push(start)
    while (stack.length > 0) {
      const p = stack.pop()!
      const col = colOf(p)
      const row = rowOf(p)
      for (const [dc, dr] of NEIGHBOURS) {
        const nc = col + dc
        const nr = row + dr
        if (nc < 0 || nc >= G || nr < 0 || nr >= G) continue
        const n = nr * G + nc
        if (cells[n] === 0 || groups[n] !== 0) continue
        groups[n] = clusters
        stack.push(n)
      }
    }
  }

  return { grid: G, cells, groups, clusters }
}
