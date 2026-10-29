export interface ShiftCashMovements {
  base: number
  /** Cash payments of the shift: amount, rounding adjustment and tip. */
  payments: readonly { amount: number; roundingAdjustment: number; tip: number }[]
  /** Reversals of voided payments and cash refunds recorded in the shift. */
  refunds: readonly number[]
  cashIn: readonly number[]
  cashOut: readonly number[]
  tipPayouts: readonly number[]
  partialWithdrawals: readonly number[]
}

const add = (values: readonly number[]) => values.reduce((a, b) => a + b, 0)

/**
 * Cash that should be in the drawer (docs/DINERO.md#caja):
 * base + Σ (amount + adjustment + tip) − refunds + cash_in − cash_out − tip_payout − withdrawals.
 */
export function expectedCash(m: ShiftCashMovements): number {
  const charged = add(m.payments.map((p) => p.amount + p.roundingAdjustment + p.tip))
  return (
    m.base +
    charged -
    add(m.refunds) +
    add(m.cashIn) -
    add(m.cashOut) -
    add(m.tipPayouts) -
    add(m.partialWithdrawals)
  )
}
