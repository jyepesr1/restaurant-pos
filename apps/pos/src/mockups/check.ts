import {
  allocateTip,
  chargedInCash,
  equalParts,
  fullConfig,
  lineGross,
  ORDER_TOTAL_LIMIT,
  requirePesos,
  splitByItems,
  suggestedTip,
} from '@pos/core'

// Check calculations for the mockups, with the real money code from `@pos/core`
// (docs/DINERO.md): the screens only show what comes out of here.

/** The pilot's configuration (Restaurant.config with its default values). */
export const CONFIG = fullConfig()

/**
 * INC rate for all the pilot's products, in basis points — (validate) with the
 * accountant. In Phase 1 each item carries a copy of the rate of its `Tax`.
 */
export const INC_RATE = 800

export interface CheckLine {
  id: string
  quantity: number
  unitPrice: number
  extras: readonly number[]
}

export const lineNet = (l: CheckLine) => lineGross(l.quantity, l.unitPrice, l.extras)

export function checkTotal(lines: readonly CheckLine[]): number {
  const total = lines.reduce((sum, l) => sum + lineNet(l), 0)
  if (total > ORDER_TOTAL_LIMIT) throw new RangeError('El pedido pasa del límite')
  return total
}

/** What is left to pay: the total minus what the payments made cover. */
export const balanceOf = (total: number, payments: readonly { amount: number }[]) =>
  total - payments.reduce((s, p) => s + p.amount, 0)

/**
 * Suggested tip on the pre-INC base of the balance to be paid (DINERO.md#propina-sugerida).
 * With a single rate in the order, the balance's base is the total's minus what was paid.
 */
export const tipOn = (balance: number) =>
  balance <= 0
    ? 0
    : suggestedTip([{ net: balance, rate: INC_RATE }], CONFIG.suggested_tip, CONFIG.rounding_mode)

/**
 * In cash the tip is suggested rounded to the cash multiple ($100, the half in the guest's
 * favor) so it can be paid with bills; the cashier can change it (owner's decision,
 * 24-Oct-2026). With card it stays exact. The tip is not a sale: it does not touch the DIAN
 * document.
 */
export const cashTip = (tip: number) =>
  chargedInCash(tip, CONFIG.cash_rounding, CONFIG.cash_rounding_mode)

export const inEqualParts = (balance: number, people: number) => equalParts(balance, people)

/** Each item to one check; an item taken by several, in equal parts among them. */
export function byItems(
  lines: readonly CheckLine[],
  assignedChecks: ReadonlyMap<string, readonly number[]>,
  checks: number,
) {
  return splitByItems(
    lines.map((l) => ({ itemId: l.id, net: lineNet(l) })),
    [...assignedChecks].flatMap(([itemId, itemChecks]) =>
      itemChecks.map((check) => ({ check, itemId, fraction: { n: 1, d: itemChecks.length } })),
    ),
    checks,
  )
}

/** The tip of each check: the one of the split balance, in proportion to what each one pays. */
export const checkTips = (amounts: readonly number[]) => {
  const total = amounts.reduce((s, m) => s + m, 0)
  return total === 0 ? amounts.map(() => 0) : allocateTip(tipOn(total), amounts)
}

// When checks are removed, what was assigned to the ones that no longer exist goes back to
// «sin asignar» (unassigned): the same rule as the operations app.
export { trimAssignments } from '../floor/checks'

export interface CashPayment {
  /** What is charged for the sale: the amount, rounded only if it leaves the balance at 0. */
  charged: number
  adjustment: number
  /** Sale + tip: what the guest must hand over at least. */
  amountDue: number
  change: number
  /** What is missing if what was received is not enough (0 if it is). */
  missing: number
}

/**
 * A cash payment (DINERO.md#pagos): `tendered = amount + rounding_adjustment + tip + change`.
 * The rounding to $100 goes only in the payment that leaves the balance at 0.
 */
export function cashPayment(p: {
  balance: number
  amount: number
  tip: number
  tendered: number
}): CashPayment {
  for (const [name, value] of Object.entries(p)) requirePesos(value, name)
  if (p.amount <= 0 || p.amount > p.balance)
    throw new RangeError(`El monto debe ser mayor que 0 y no pasar del saldo (${p.balance})`)
  const charged =
    p.amount === p.balance
      ? chargedInCash(p.balance, CONFIG.cash_rounding, CONFIG.cash_rounding_mode)
      : p.amount
  const amountDue = charged + p.tip
  const excess = p.tendered - amountDue
  return {
    charged,
    adjustment: charged - p.amount,
    amountDue,
    change: Math.max(0, excess),
    missing: Math.max(0, -excess),
  }
}

/** With a card terminal, `amount + tip` is what it must approve (DINERO.md#pagos). */
export function cardPayment(p: { balance: number; amount: number; tip: number }) {
  requirePesos(p.tip, 'tip')
  if (p.amount <= 0 || p.amount > p.balance)
    throw new RangeError(`El monto debe ser mayor que 0 y no pasar del saldo (${p.balance})`)
  return { approved: p.amount + p.tip }
}
