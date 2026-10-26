import {
  allocateTip,
  type CashRoundingMode,
  type ChargedByMethod,
  chargedInCash,
  chargedInShift,
  checkBalance,
  checkPendingTip,
  equalParts,
  itemTotals,
  METHOD_NAME,
  methodName as methodNameOf,
  type OrderState,
  orderTip,
  orderTotals,
  type PaymentMethod,
  requirePesos,
  shiftReconciliation,
  splitByItems,
} from '@pos/core'
import type { Catalog, LocalEvent } from '@pos/sync'

// Pre-bill, split and checkout (task 1.6, docs/DINERO.md): every amount comes from the money code
// of `@pos/core` with the restaurant's rules that come with the menu. The screens only show what
// is calculated here.

export type CheckoutRules = NonNullable<Catalog['restaurant']['checkout']>

/** A checkout option: a method, the card as credit or debit, or a custom method. */
export interface CheckoutOption {
  key: string
  name: string
  method: PaymentMethod
  cardType: 'credit' | 'debit' | null
  customMethodId: string | null
}

/**
 * What shows at checkout, in this order: the enabled methods (the card, as credit and as
 * debit) and then the restaurant's custom ones (task 1.6).
 */
export function checkoutOptions(rules: CheckoutRules): CheckoutOption[] {
  const options: CheckoutOption[] = []
  const base = { cardType: null, customMethodId: null }
  for (const method of rules.paymentMethods) {
    if (method === 'card') {
      options.push(
        { ...base, key: 'credit', name: 'Tarjeta crédito', method, cardType: 'credit' },
        { ...base, key: 'debit', name: 'Tarjeta débito', method, cardType: 'debit' },
      )
    } else options.push({ ...base, key: method, name: METHOD_NAME[method], method })
  }
  for (const m of rules.customMethods ?? [])
    options.push({ ...base, key: m.id, name: m.name, method: 'other', customMethodId: m.id })
  return options
}

/** The name of a method in a payment: a custom one by its name (even if archived, «Otro»). */
export const methodName = (
  method: PaymentMethod,
  customMethodId: string | null | undefined,
  rules: CheckoutRules | null,
) =>
  methodNameOf(method, customMethodId, [
    ...(rules?.customMethods ?? []),
    ...(rules?.archivedCustomMethods ?? []),
  ])

/** «INC 8 %», «IVA 19 %», «Exento» (the same name as the printed pre-bill). */
export function taxName(type: 'inc' | 'iva' | 'exempt', rate: number): string {
  if (type === 'exempt' || rate === 0) return 'Exento'
  return `${type.toUpperCase()} ${`${rate / 100}`.replace('.', ',')} %`
}

/** The restaurant's checkout rules; a hub from before 1.6 does not send them. */
export const rulesOf = (catalog: Catalog | null): CheckoutRules | null =>
  catalog?.restaurant.checkout ?? null

const configOf = (r: CheckoutRules) => ({
  suggested_tip: r.suggestedTip,
  rounding_mode: r.roundingMode,
})

/** Suggested tip on `amount` of the order (the balance, a check or what is being charged now). */
export const suggestedTipOf = (order: OrderState, amount: number, rules: CheckoutRules) =>
  amount <= 0 ? 0 : orderTip(order, amount, configOf(rules))

/**
 * In cash, the tip is suggested rounded to the cash multiple so it can be paid
 * with bills; the cashier can change it. With the other methods it is exact (DINERO.md).
 */
export const cashTip = (tip: number, rules: CheckoutRules) =>
  chargedInCash(tip, rules.cashRounding, rules.cashRoundingMode)

/**
 * The suggested tip of a payment of `value` on what is left (`available`): the tip on what is
 * left before the payment minus the one on what will be left after. That way partial payments
 * add up to the whole tip, without an extra peso from rounding (docs/DINERO.md#propina-sugerida).
 */
export function paymentTip(
  order: OrderState,
  check: { amount: number; suggestedTip: number } | null,
  available: number,
  value: number,
  rules: CheckoutRules,
): number {
  if (value <= 0 || value > available) return 0
  const pending = (balance: number) =>
    check ? checkPendingTip(check, balance) : suggestedTipOf(order, balance, rules)
  return Math.max(0, pending(available) - pending(available - value))
}

/**
 * The tip of a payment with another percentage (5 %, 15 %…) in basis points, by the same rule
 * as the suggested one: on the pre-tax base of what is charged.
 */
export const tipWithPercent = (
  order: OrderState,
  available: number,
  value: number,
  points: number,
  rules: CheckoutRules,
) => paymentTip(order, null, available, value, { ...rules, suggestedTip: points })

/** A pre-bill line: what still stands, with its net. */
export interface CheckLine {
  id: string
  quantity: number
  name: string
  options: string[]
  net: number
}

export function linesOf(order: OrderState): CheckLine[] {
  return Object.values(order.items)
    .filter((i) => i.status !== 'voided' && i.quantity > i.voidedQuantity)
    .sort((a, b) => a.position - b.position)
    .map((i) => ({
      id: i.id,
      quantity: i.quantity - i.voidedQuantity,
      name: i.name,
      options: i.modifiers.map((m) => m.name),
      net: itemTotals(order, i).net,
    }))
}

/** A check of a split order, with what it still has to pay. */
export interface VisibleCheck {
  id: string
  name: string
  amount: number
  balance: number
  /** The tip set when splitting. */
  suggestedTip: number
  /** What is left of that tip, according to what is left of the check. */
  pendingTip: number
}

/**
 * What is left to charge: the split's checks with their balance and, separately, what did not end
 * up in any check (added after splitting, or what was not allocated).
 */
export function outstanding(order: OrderState): {
  balance: number
  checks: VisibleCheck[]
  unassigned: number
} {
  const { balance } = orderTotals(order)
  if (!order.checks) return { balance, checks: [], unassigned: 0 }
  const checks = order.checks
    .map((c) => ({
      id: c.id,
      name: c.name,
      amount: c.amount,
      balance: Math.max(0, checkBalance(order, c.id) ?? 0),
      suggestedTip: c.suggestedTip,
    }))
    .map((c) => ({ ...c, pendingTip: checkPendingTip(c, c.balance) }))
  const inChecks = checks.reduce((a, c) => a + c.balance, 0)
  return { balance, checks, unassigned: Math.max(0, balance - inChecks) }
}

/** The data of `CheckSplit`: fixed amounts and the tip of each check. */
export interface NewCheck {
  check_id: string
  name: string
  amount: number
  suggested_tip: number
  items: { item_id: string; fraction: { n: number; d: number } }[]
}

/**
 * The tip of each check: the one on what is split, allocated in proportion to what each one
 * pays (DINERO.md#propina-sugerida).
 */
function withTips(order: OrderState, amounts: readonly number[], rules: CheckoutRules): number[] {
  const total = amounts.reduce((a, m) => a + m, 0)
  return total === 0
    ? amounts.map(() => 0)
    : allocateTip(suggestedTipOf(order, total, rules), amounts)
}

/** The balance in `people` equal parts by largest remainder (100.000 ÷ 3 = 33.334 + 33.333 + 33.333). */
export function inEqualParts(
  order: OrderState,
  people: number,
  rules: CheckoutRules,
  newId: () => string,
): NewCheck[] {
  const { balance } = orderTotals(order)
  const amounts = equalParts(balance, people)
  const tips = withTips(order, amounts, rules)
  return amounts.map((amount, i) => ({
    check_id: newId(),
    name: `Persona ${i + 1}`,
    amount,
    suggested_tip: tips[i] ?? 0,
    items: [],
  }))
}

/**
 * Each product to the check that pays for it; one that several checks share is split among them in
 * equal parts. What nobody takes stays unassigned and is charged separately. Only before the first
 * payment: after that the balance is split in equal parts (DINERO.md#división-de-la-cuenta).
 */
export function byProducts(
  order: OrderState,
  assignedChecks: ReadonlyMap<string, readonly number[]>,
  checks: number,
  rules: CheckoutRules,
  newId: () => string,
): { checks: NewCheck[]; unassigned: number } {
  const lines = linesOf(order)
  // A product that another device voided while splitting no longer counts.
  const currentOnes = new Set(lines.map((l) => l.id))
  const assignments = [...assignedChecks]
    .filter(([itemId]) => currentOnes.has(itemId))
    .flatMap(([itemId, src]) =>
      src
        .filter((c) => c < checks)
        .map((check, _i, allRows) => ({ check, itemId, fraction: { n: 1, d: allRows.length } })),
    )
  const { amounts, unassigned } = splitByItems(
    lines.map((l) => ({ itemId: l.id, net: l.net })),
    assignments,
    checks,
  )
  const tips = withTips(order, amounts, rules)
  return {
    checks: amounts.map((amount, i) => ({
      check_id: newId(),
      name: `Cuenta ${i + 1}`,
      amount,
      suggested_tip: tips[i] ?? 0,
      items: assignments
        .filter((a) => a.check === i)
        .map((a) => ({ item_id: a.itemId, fraction: a.fraction })),
    })),
    unassigned,
  }
}

/** When removing checks, what was in the ones that no longer exist goes back to «sin asignar». */
export function trimAssignments(
  assignedChecks: ReadonlyMap<string, readonly number[]>,
  checks: number,
): Map<string, number[]> {
  const newOnes = new Map<string, number[]>()
  for (const [item, src] of assignedChecks) {
    const kept = src.filter((c) => c < checks)
    if (kept.length > 0) newOnes.set(item, kept)
  }
  return newOnes
}

export interface CashCalculation {
  /** What is charged for the sale: the amount, rounded only if it leaves the balance at 0. */
  charged: number
  adjustment: number
  /** Sale + tip: the minimum the customer hands over. */
  amountDue: number
  change: number
  /** What is missing if what was tendered is not enough (0 if it is). */
  missing: number
  /** The rounding rule that goes in the event, only in the payment that leaves the balance at 0. */
  rounding: { multiple: number; mode: CashRoundingMode } | null
}

/**
 * A cash payment (DINERO.md#pagos): `tendered = amount + rounding_adjustment + tip + change`.
 * Rounding goes only in the payment that leaves the balance at 0 (`balance` is the check's
 * available amount).
 */
export function cashPayment(
  p: { balance: number; amount: number; tip: number; tendered: number },
  rules: CheckoutRules,
): CashCalculation {
  for (const [name, value] of Object.entries(p)) requirePesos(value, name)
  if (p.amount <= 0 || p.amount > p.balance)
    throw new RangeError(`El monto debe ser mayor que 0 y no pasar del saldo (${p.balance})`)
  const closes = p.amount === p.balance
  const charged = closes
    ? chargedInCash(p.balance, rules.cashRounding, rules.cashRoundingMode)
    : p.amount
  const amountDue = charged + p.tip
  const excess = p.tendered - amountDue
  return {
    charged,
    adjustment: charged - p.amount,
    amountDue,
    change: Math.max(0, excess),
    missing: Math.max(0, -excess),
    rounding:
      closes && charged !== p.amount
        ? { multiple: rules.cashRounding, mode: rules.cashRoundingMode }
        : null,
  }
}

/** The open shift of a register (task 1.6): the latest current `ShiftOpened` from that device. */
export interface VisibleShift {
  id: string
  base: number
  openedAt: string
  /** Not yet confirmed by the hub. */
  pendingConfirmation: boolean
}

export function shiftOfRegister(
  locals: readonly LocalEvent[],
  registerId: string,
): VisibleShift | null {
  // A shift whose close is confirmed is no longer open (task 1.7); a pending one stays open
  // until the hub accepts it, in case it rejects it.
  const closedIds = new Set(
    locals
      .filter((l) => l.event.type === 'ShiftClosed' && l.status === 'confirmed')
      .map((l) => l.event.aggregate_id),
  )
  let shift: VisibleShift | null = null
  for (const l of locals) {
    if (closedIds.has(l.event.aggregate_id)) continue
    const e = l.event
    if (e.type !== 'ShiftOpened' || e.data.register_id !== registerId) continue
    if (l.status !== 'confirmed' && l.status !== 'pending') continue
    const candidate = {
      id: e.aggregate_id,
      base: e.data.base,
      openedAt: e.received_at ?? e.hub_estimated_time,
      pendingConfirmation: l.status === 'pending',
    }
    if (!shift || candidate.openedAt > shift.openedAt) shift = candidate
  }
  return shift
}

/** What was charged in a shift, by payment method (calculated by `@pos/core`, same as the hub). */
export interface ShiftSummary {
  byMethod: ChargedByMethod[]
  payments: number
}

export function shiftSummary(locals: readonly LocalEvent[], shiftId: string): ShiftSummary {
  const byMethod = chargedInShift(currentOf(locals), shiftId)
  return { byMethod, payments: byMethod.reduce((a, m) => a + m.payments, 0) }
}

/** The shift reconciliation with what is stored here (confirmed and pending). */
export const registerReconciliation = (locals: readonly LocalEvent[], shiftId: string) =>
  shiftReconciliation(currentOf(locals), shiftId)

const currentOf = (locals: readonly LocalEvent[]) =>
  locals.filter((l) => l.status === 'confirmed' || l.status === 'pending').map((l) => l.event)
