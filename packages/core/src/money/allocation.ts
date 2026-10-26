import { requirePesos, toInteger } from './arithmetic'

/**
 * Allocates `total` into parts proportional to `pesos` (weights) by largest remainder: the
 * parts add up to exactly the total. Ties are broken by order (the first part wins). If all
 * weights are 0, it splits into equal parts.
 */
export function allocate(total: number, pesos: readonly number[]): number[] {
  const t = requirePesos(total, 'total')
  if (pesos.length === 0) {
    if (t === 0n) return []
    throw new RangeError('No se puede repartir un total entre cero partes')
  }
  const p = pesos.map((weight, i) => requirePesos(weight, `peso ${i}`))
  const sum = p.reduce((a, b) => a + b, 0n)
  const weighted = sum === 0n ? p.map(() => 1n) : p
  const weightedSum = sum === 0n ? BigInt(p.length) : sum

  const parts = weighted.map((weight) => (t * weight) / weightedSum)
  const remainders = weighted.map((weight, i) => ({
    i,
    remainder: t * weight - (parts[i] ?? 0n) * weightedSum,
  }))
  let short = t - parts.reduce((a, b) => a + b, 0n)

  remainders.sort((a, b) =>
    b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.i - b.i,
  )
  for (const { i } of remainders) {
    if (short === 0n) break
    parts[i] = (parts[i] ?? 0n) + 1n
    short -= 1n
  }
  return parts.map(toInteger)
}

/**
 * Splits `total` into `n` equal parts by largest remainder:
 * 100.000 ÷ 3 = 33.334 + 33.333 + 33.333.
 */
export function equalParts(total: number, n: number): number[] {
  if (!Number.isSafeInteger(n) || n < 1)
    throw new RangeError(`n debe ser un entero ≥ 1 (llegó ${n})`)
  return allocate(
    total,
    Array.from({ length: n }, () => 1),
  )
}
