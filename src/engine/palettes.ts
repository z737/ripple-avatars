/** Palettes calibrated by eye against the reference set. Each has a paper pair
 *  (the field's mid-tone, which is NOT the white margin) and up to 5 ink
 *  attractors placed in unit space — the ink colour at a pixel is the OKLab
 *  inverse-distance blend of these. */

export interface InkStop {
  color: string
  x: number
  y: number
}

export interface Palette {
  id: string
  name: string
  paperA: string
  paperB: string
  matte: string
  ink: InkStop[]
}

export const PALETTES: Palette[] = [
  {
    id: 'sage',
    name: 'Sage Interference',
    paperA: '#a3b09a',
    paperB: '#cfc9b4',
    matte: '#f2efe9',
    ink: [
      { color: '#ff3b2f', x: 0.12, y: 0.86 },
      { color: '#19c8e0', x: 0.86, y: 0.84 },
      { color: '#ffd426', x: 0.44, y: 0.32 },
      { color: '#2fd18b', x: 0.1, y: 0.16 },
      { color: '#ff5fa2', x: 0.9, y: 0.24 },
    ],
  },
  {
    id: 'cream',
    name: 'Cream Chroma',
    paperA: '#e8e0cf',
    paperB: '#f2ece0',
    matte: '#f2efe9',
    ink: [
      { color: '#37c8ee', x: 0.16, y: 0.9 },
      { color: '#7b4dff', x: 0.5, y: 0.6 },
      { color: '#ff7a1a', x: 0.88, y: 0.72 },
      { color: '#ff2d78', x: 0.72, y: 0.14 },
      { color: '#ffc93c', x: 0.2, y: 0.22 },
    ],
  },
  {
    id: 'amber',
    name: 'Amber Calm',
    paperA: '#f0dfbc',
    paperB: '#fbf3e2',
    matte: '#f7f3ea',
    ink: [
      { color: '#ff9500', x: 0.5, y: 0.78 },
      { color: '#ffc61a', x: 0.28, y: 0.34 },
      { color: '#ff6a2b', x: 0.8, y: 0.5 },
      { color: '#ffe08a', x: 0.5, y: 0.1 },
    ],
  },
  {
    id: 'ink-navy',
    name: 'Deep Navy',
    paperA: '#141a2e',
    paperB: '#1e2540',
    matte: '#f2efe9',
    ink: [
      { color: '#3d5bff', x: 0.3, y: 0.7 },
      { color: '#7a4dff', x: 0.66, y: 0.5 },
      { color: '#1fb6c9', x: 0.2, y: 0.24 },
      { color: '#ff5f8f', x: 0.84, y: 0.2 },
    ],
  },
  {
    id: 'pale',
    name: 'Pale Mist',
    paperA: '#e9e6ea',
    paperB: '#f4f1f0',
    matte: '#f7f5f4',
    ink: [
      { color: '#2fd6d6', x: 0.2, y: 0.8 },
      { color: '#ff4d88', x: 0.76, y: 0.68 },
      { color: '#a68cff', x: 0.5, y: 0.4 },
      { color: '#ffd166', x: 0.3, y: 0.14 },
    ],
  },
  {
    id: 'brand',
    name: 'Gnani Brand',
    paperA: '#efe7e2',
    paperB: '#f8f4f1',
    matte: '#ffffff',
    ink: [
      { color: '#ff6b3d', x: 0.24, y: 0.78 },
      { color: '#ff2d6f', x: 0.72, y: 0.66 },
      { color: '#8b5cf6', x: 0.5, y: 0.36 },
      { color: '#ffb03a', x: 0.2, y: 0.2 },
    ],
  },
]

export const paletteById = (id: string): Palette =>
  PALETTES.find((p) => p.id === id) ?? PALETTES[0]

/** '#rrggbb' -> [r,g,b] in 0..1 */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ]
}
