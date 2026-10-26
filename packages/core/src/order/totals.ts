import type { TaxType } from '../events/common'
import { allocate } from '../money/allocation'
import { type RoundingMode, roundDiv, toInteger } from '../money/arithmetic'
import { breakDown } from '../money/fiscal'
import { priceWithExtras } from '../money/line'
import { tipOnAmount } from '../money/tip'
import type { OrderItem, OrderState } from './state'

/** Price of one unit of the item with its modifiers. */
export function pricePerUnit(item: OrderItem): number {
  return priceWithExtras(
    item.unitPrice,
    item.modifiers.map((m) => m.extraPrice),
  )
}

export function itemDiscount(status: OrderState, itemId: string): number {
  return Object.values(status.discounts).reduce((a, d) => a + (d.amounts[itemId] ?? 0), 0)
}

export interface ItemTotals {
  gross: number
  voided: number
  discount: number
  net: number
}

/** gross − voided − discounts = net (docs/DINERO.md#línea-de-pedido). */
export function itemTotals(status: OrderState, item: OrderItem): ItemTotals {
  const perUnit = pricePerUnit(item)
  const gross = item.quantity * perUnit
  const voided = item.voidedQuantity * perUnit
  const discount = itemDiscount(status, item.id)
  return { gross, voided, discount, net: gross - voided - discount }
}

export interface OrderTotals extends ItemTotals {
  /** Σ of what was paid in current payments, minus what was refunded from the sale. */
  paid: number
  balance: number
  tips: number
  settings: number
}

export function orderTotals(status: OrderState): OrderTotals {
  const t = { gross: 0, voided: 0, discount: 0, net: 0 }
  for (const item of Object.values(status.items)) {
    const ti = itemTotals(status, item)
    t.gross += ti.gross
    t.voided += ti.voided
    t.discount += ti.discount
    t.net += ti.net
  }
  let paid = 0
  let tips = 0
  let settings = 0
  for (const payment of Object.values(status.payments)) {
    if (payment.voided) continue
    paid += payment.amount - payment.refundedSale
    tips += payment.tip - payment.refundedTip
    settings += payment.roundingAdjustment
  }
  return { ...t, paid, balance: t.net - paid, tips, settings }
}

/** Balance of a split check, or of the whole order if `checkId` is null. */
export function checkBalance(status: OrderState, checkId: string | null): number | null {
  if (checkId === null) return orderTotals(status).balance
  const check = status.checks?.find((c) => c.id === checkId)
  if (!check) return null
  const paid = Object.values(status.payments)
    .filter((p) => !p.voided && p.checkId === checkId)
    .reduce((a, p) => a + p.amount - p.refundedSale, 0)
  return check.amount - paid
}

/** Payments that still count: not voided and with some of the charge not refunded. */
export function hasCurrentPayments(status: OrderState): boolean {
  return Object.values(status.payments).some(
    (p) =>
      !p.voided && p.amount + p.roundingAdjustment + p.tip - p.refundedSale - p.refundedTip > 0,
  )
}

/**
 * Suggested tip on `amount` of this order (the balance, or the part being split or charged):
 * on the pre-tax base, net of discounts and voids (docs/DINERO.md#propina-sugerida).
 */
export function orderTip(
  status: OrderState,
  amount: number,
  config: { suggested_tip: number; rounding_mode: RoundingMode },
): number {
  const lines = Object.values(status.items)
    .map((item) => ({ net: itemTotals(status, item).net, rate: item.rate }))
    .filter((l) => l.net > 0)
  return tipOnAmount(lines, amount, config.suggested_tip, config.rounding_mode)
}

/**
 * The remaining tip of a split check when it has `balance` pesos left: the tip set when
 * splitting, allocated by largest remainder between what was paid and what remains. That way the
 * partial payments of a check add up exactly to its tip (docs/DINERO.md#propina-sugerida).
 */
export function checkPendingTip(
  check: { amount: number; suggestedTip: number },
  balance: number,
): number {
  if (balance <= 0) return 0
  if (balance >= check.amount) return check.suggestedTip
  return allocate(check.suggestedTip, [check.amount - balance, balance])[1] ?? 0
}

/** The tax of a group of lines with the same type and rate, in pesos. */
export interface ItemizedTax {
  type: TaxType
  /** Basis points: 800 = 8%. */
  rate: number
  /** Net of the group without the tax. */
  base: number
  tax: number
}

/**
 * The itemized tax of the order, by type and rate, for the pre-bill (task 1.6): the same
 * per-line breakdown as the DIAN document (docs/DINERO.md#desglose-fiscal), with each group's tax
 * rounded to pesos and the base as the remainder, so base + tax equals the exact net. It is
 * informational: the DIAN document carries the decimals — (validate) with the accountant.
 */
export function orderTaxes(status: OrderState, mode?: RoundingMode): ItemizedTax[] {
  return taxesOfOrders([status], mode)
}

/**
 * The itemized tax of several orders (the reports, task 1.9): each line's hundredths are summed
 * by type and rate across all orders and rounded **only once** per group (docs/DINERO.md,
 * principle 2). Summing each order's already-rounded tax would drift. `subtract` are states that
 * are deducted (what was already reported for a reopened order); a group can end up negative and
 * is rounded by its absolute value.
 */
export function taxesOfOrders(
  statuses: readonly OrderState[],
  mode?: RoundingMode,
  subtract: readonly OrderState[] = [],
): ItemizedTax[] {
  const groups = new Map<string, { type: TaxType; rate: number; net: number; hundredths: number }>()
  const add = (status: OrderState, sign: 1 | -1) => {
    for (const item of Object.values(status.items)) {
      const { net } = itemTotals(status, item)
      if (net <= 0) continue
      const rate = item.taxType === 'exempt' ? 0 : item.rate
      const key = `${item.taxType}:${rate}`
      const g = groups.get(key) ?? { type: item.taxType, rate, net: 0, hundredths: 0 }
      g.net += sign * net
      g.hundredths += sign * breakDown(net, rate, mode).taxHundredths
      groups.set(key, g)
    }
  }
  for (const status of statuses) add(status, 1)
  for (const status of subtract) add(status, -1)
  return [...groups.values()]
    .filter((g) => g.net !== 0 || g.hundredths !== 0)
    .sort((a, b) => b.net - a.net)
    .map((g) => {
      const abs = toInteger(roundDiv(BigInt(Math.abs(g.hundredths)), 100n, mode))
      const tax = g.hundredths < 0 ? -abs : abs
      return { type: g.type, rate: g.rate, base: g.net - tax, tax }
    })
}
