// Exact arithmetic for money (docs/DINERO.md#principios): everything in integers, fractions as
// BigInt numerator and denominator, and a single rounding at the end.

/** Limits from docs/DINERO.md. */
export const PRICE_LIMIT = 100_000_000
export const QUANTITY_LIMIT = 999
export const ORDER_TOTAL_LIMIT = 10_000_000_000
export const BASIS_POINTS = 10_000

/** Rounding mode for percentages and the tax breakdown (`rounding_mode` in the config). */
export type RoundingMode = 'half_up' | 'half_even'

/**
 * Rounds `a / b` (with `a ≥ 0` and `b > 0`) to an integer. By default, half up;
 * `half_even` takes the half to the nearest even number.
 */
export function roundDiv(a: bigint, b: bigint, mode: RoundingMode = 'half_up'): bigint {
  if (a < 0n || b <= 0n) throw new RangeError(`redondear(${a}, ${b}): se esperan a ≥ 0 y b > 0`)
  if (mode === 'half_up') return (2n * a + b) / (2n * b)
  const quotient = a / b
  const rest2 = 2n * (a % b)
  if (rest2 > b || (rest2 === b && quotient % 2n === 1n)) return quotient + 1n
  return quotient
}

/** Converts to `number`, requiring a safe integer. */
export function toInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`El valor ${value} no cabe en un entero seguro`)
  }
  return Number(value)
}

/** Requires an integer amount of pesos ≥ 0. */
export function requirePesos(value: number, name = 'amount'): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} debe ser un entero de pesos ≥ 0 (llegó ${value})`)
  }
  return BigInt(value)
}

export interface Fraction {
  n: bigint
  d: bigint
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y > 0n) [x, y] = [y, x % y]
  return x
}

export function addFractions(a: Fraction, b: Fraction): Fraction {
  const n = a.n * b.d + b.n * a.d
  const d = a.d * b.d
  const divisor = gcd(n, d) || 1n
  return { n: n / divisor, d: d / divisor }
}
