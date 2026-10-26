import { allocate } from './allocation'
import { BASIS_POINTS, type RoundingMode, requirePesos, roundDiv, toInteger } from './arithmetic'
import { priceWithExtras, requireQuantity } from './line'

export function requireBasisPoints(bp: number, name = 'percent'): bigint {
  if (!Number.isSafeInteger(bp) || bp < 0 || bp > BASIS_POINTS) {
    throw new RangeError(
      `${name} debe estar entre 0 y ${BASIS_POINTS} puntos básicos (llegó ${bp})`,
    )
  }
  return BigInt(bp)
}

/** Percentage (in basis points) of a base, rounded once: 15 % of 12.950 = 1.943. */
export function percent(base: number, bp: number, mode?: RoundingMode): number {
  return toInteger(
    roundDiv(requirePesos(base, 'base') * requireBasisPoints(bp), BigInt(BASIS_POINTS), mode),
  )
}

/** Comp of `units` of a line: units × (unit_price + Σ extras). */
export function comp(units: number, unitPrice: number, extras: readonly number[] = []): number {
  return toInteger(requireQuantity(units) * BigInt(priceWithExtras(unitPrice, extras)))
}

/**
 * Allocates an order discount across the lines, in proportion to what each one has left
 * after the discounts already applied. Returns `null` if the discount exceeds what is left
 * (no line can go negative).
 */
export function allocateOrderDiscount(
  discount: number,
  leftover: readonly number[],
): number[] | null {
  const total = leftover.reduce((a, r, i) => a + requirePesos(r, `restante ${i}`), 0n)
  if (requirePesos(discount, 'descuento') > total) return null
  if (total === 0n) return leftover.map(() => 0)
  return allocate(discount, leftover)
}
