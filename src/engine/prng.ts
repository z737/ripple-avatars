/** Deterministic seeded PRNG. Structural randomness is generated here in JS and
 *  uploaded as uniforms — never derived GPU-side, because shader float precision
 *  differs across hardware and an avatar must look the same on every device. */

export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Rng {
  next(): number
  range(min: number, max: number): number
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  bool(p?: number): boolean
}

export function rngFrom(seed: string): Rng {
  const r = mulberry32(hashString(seed))
  return {
    next: r,
    range: (min, max) => min + r() * (max - min),
    int: (min, max) => min + Math.floor(r() * (max - min + 1)),
    pick: (items) => items[Math.floor(r() * items.length) % items.length],
    bool: (p = 0.5) => r() < p,
  }
}

const WORDS = [
  'vachana', 'inya', 'tarang', 'dhwani', 'nada', 'raga', 'laya', 'sur',
  'kalpa', 'meera', 'anand', 'chitra', 'veena', 'aalap', 'bindu', 'tala',
]

/** Human-readable seeds, so a voice's avatar identity is quotable. */
export function randomSeed(): string {
  const w = WORDS[Math.floor(Math.random() * WORDS.length)]
  const n = Math.floor(Math.random() * 9000) + 1000
  return `${w}-${n}`
}
