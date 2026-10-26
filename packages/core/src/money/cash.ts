import { requirePesos, toInteger } from './arithmetic'

export type CashRoundingMode = 'nearest_half_down' | 'nearest_half_up' | 'down' | 'up'

/**
 * What is charged in cash for a balance, rounded to the multiple `m`
 * (docs/DINERO.md#pagos). With the default mode, the half goes in the customer's favor:
 * 36.810 → 36.800; 36.850 → 36.800; 36.851 → 36.900; 50 → 0.
 */
export function chargedInCash(
  balance: number,
  multiple: number,
  mode: CashRoundingMode = 'nearest_half_down',
): number {
  const s = requirePesos(balance, 'balance')
  const m = requirePesos(multiple, 'múltiplo')
  if (m <= 1n) return toInteger(s)
  switch (mode) {
    case 'nearest_half_down':
      return toInteger(m * ((2n * s + m - 1n) / (2n * m)))
    case 'nearest_half_up':
      return toInteger(m * ((2n * s + m) / (2n * m)))
    case 'down':
      return toInteger(m * (s / m))
    case 'up':
      return toInteger(m * ((s + m - 1n) / m))
  }
}

export interface CashPaymentInput {
  amount: number
  roundingAdjustment: number
  tip: number
  tendered: number
  change: number
}

/** tendered = amount + rounding_adjustment + tip + change, with change ≥ 0. */
export function cashBalances({
  amount,
  roundingAdjustment,
  tip,
  tendered,
  change,
}: CashPaymentInput): boolean {
  return change >= 0 && tendered === amount + roundingAdjustment + tip + change
}
