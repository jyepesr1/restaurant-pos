import { allocate } from './allocation'
import {
  addFractions,
  BASIS_POINTS,
  type Fraction,
  type RoundingMode,
  requirePesos,
  roundDiv,
  toInteger,
} from './arithmetic'
import { requireBasisPoints } from './discounts'

export interface TipLine {
  /** Line net in pesos, tax included and discounts already subtracted. */
  net: number
  /** Line tax rate in basis points. */
  rate: number
}

/**
 * Suggested tip on the pre-tax base, net of discounts, with a single rounding
 * (docs/DINERO.md#propina-sugerida). $100.000 at 8 % with 10 % → 9.259; $16.000 → 1.481.
 */
export function suggestedTip(
  lines: readonly TipLine[],
  tipRate: number,
  mode?: RoundingMode,
): number {
  const bp = requireBasisPoints(tipRate, 'tasa de propina')
  const base = lines.reduce<Fraction>(
    (accumulated, { net, rate }) =>
      addFractions(accumulated, {
        n: requirePesos(net, 'net') * BigInt(BASIS_POINTS),
        d: BigInt(BASIS_POINTS) + requireBasisPoints(rate, 'rate'),
      }),
    { n: 0n, d: 1n },
  )
  return toInteger(roundDiv(base.n * bp, base.d * BigInt(BASIS_POINTS), mode))
}

/**
 * Suggested tip for part of the order (the balance after earlier payments, or a split share): the
 * whole order's tip in proportion to `amount` over the net, with a single rounding
 * (docs/DINERO.md#propina-sugerida). $100.000 at 8 %, $40.000 paid → balance 60.000 → 5.556.
 */
export function tipOnAmount(
  lines: readonly TipLine[],
  amount: number,
  tipRate: number,
  mode?: RoundingMode,
): number {
  const bp = requireBasisPoints(tipRate, 'tasa de propina')
  const share = requirePesos(amount, 'amount')
  const net = lines.reduce((a, { net }) => a + requirePesos(net, 'net'), 0n)
  if (share > net) throw new RangeError(`El monto (${amount}) pasa del neto del pedido (${net})`)
  if (share === 0n) return 0
  const base = lines.reduce<Fraction>(
    (accumulated, { net, rate }) =>
      addFractions(accumulated, {
        n: BigInt(net) * BigInt(BASIS_POINTS),
        d: BigInt(BASIS_POINTS) + requireBasisPoints(rate, 'rate'),
      }),
    { n: 0n, d: 1n },
  )
  return toInteger(roundDiv(base.n * bp * share, base.d * BigInt(BASIS_POINTS) * net, mode))
}

/** Allocates the tip across checks in proportion to each one's amount. */
export function allocateTip(tip: number, checkAmounts: readonly number[]): number[] {
  return allocate(tip, checkAmounts)
}
