/**
 * Deep-freezes a value and everything it contains. A reducer that tries to modify its input throws
 * TypeError (ES modules run in strict mode), so a mutation cannot go unnoticed.
 */
export function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) freeze(child)
  return value
}

/** Shuffles a list with a mulberry32 generator: the same seed always gives the same order. */
export function shuffle<T>(list: readonly T[], seedValue: number): T[] {
  const copy = [...list]
  let s = seedValue >>> 0
  const random = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = copy[i] as T
    copy[i] = copy[j] as T
    copy[j] = tmp
  }
  return copy
}
