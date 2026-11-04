import type { PaymentMethod } from '../events/common'
import type { ApplicableEvent } from '../events/order'
import { expectedCash } from '../money/register'

// The reconciliation of a register shift (tasks 1.6 and 1.7, docs/DINERO.md#caja): what was
// charged per payment method, the cash movements, the counts and the cash there should be. The hub
// (to accept the close) and the register (to show it) compute it the same way, from the events.
// A void or a refund falls in the shift in which it is recorded, not in the payment's.

/**
 * Whether a register variance (counted − expected, in pesos) is large: from `threshold` pesos up,
 * either way, it needs a justification at the close and it is an alert. A threshold below 1 counts
 * as 1, so a variance of 0 is never large (the hub's rule, task 1.7).
 */
export const isLargeVariance = (variance: number, threshold: number) =>
  Math.abs(variance) >= Math.max(1, threshold)

export interface ChargedByMethod {
  method: PaymentMethod
  customMethodId: string | null
  /** Sale with its rounding, minus voids and refunds recorded in the shift. */
  sale: number
  tip: number
  payments: number
}

export interface ShiftMovement {
  id: string
  type: 'cash_in' | 'cash_out' | 'tip_payout'
  amount: number
  description: string
  toWhom: string | null
  time: string
}

/** The name of each method on screen, on paper and in reports. Custom ones go by their name. */
export const METHOD_NAME: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  nequi: 'Nequi',
  daviplata: 'Daviplata',
  breb: 'Bre-B',
  transfer: 'Transferencia',
  voucher: 'Bono',
  other: 'Otro',
}

/** The name of a method in a payment: a custom one by its name, even if archived. */
export function methodName(
  method: PaymentMethod,
  customMethodId: string | null | undefined,
  customMethods: readonly { id: string; name: string }[],
): string {
  return method === 'other'
    ? (customMethods.find((m) => m.id === customMethodId)?.name ?? METHOD_NAME.other)
    : METHOD_NAME[method]
}

/** A non-cash method: reconciled against its own close (task 1.8). */
export type NonCashMethod = Exclude<PaymentMethod, 'cash'>

/** The key of a method in the reconciliation: the method and, if custom, which one. */
export const methodKeyOf = (m: { method: PaymentMethod; customMethodId: string | null }) =>
  `${m.method}:${m.customMethodId ?? ''}`

/** What the close of a non-cash method says (the card terminal, an app). */
export interface MethodReport {
  method: NonCashMethod
  customMethodId: string | null
  reported: number
}

/** A non-cash method at close: what was recorded and what its close says. */
export interface MethodReconciliation extends MethodReport {
  expected: number
  variance: number
}

export interface ShiftCashCount {
  id: string
  tally: { value: number; quantity: number }[]
  counted: number
  /** The closes of the other methods, entered with the count (task 1.8). */
  others: MethodReport[]
  time: string
}

/**
 * A money event of the shift the hub saved as not applied (`unapplied`, task 1.7b): it stays out
 * of the expected amount and the methods, and is shown apart at close (DINERO.md#caja).
 */
export interface UnappliedMovement {
  eventId: string
  orderId: string
  type: 'PaymentRecorded' | 'PaymentVoided' | 'RefundRecorded'
  /** Null only in a voided payment whose payment is not among the events. */
  method: PaymentMethod | null
  customMethodId: string | null
  /**
   * In pesos, with the sign it would have moved the register: + charged (amount, rounding
   * adjustment and tip), − returned. Null only like `method`.
   */
  amount: number | null
  /** The part of `amount` that is tip, with the same sign (null like `amount`). */
  tip: number | null
  userId: string
  time: string
}

export interface ShiftReconciliation {
  shiftId: string
  registerId: string
  base: number
  openedAt: string
  byMethod: ChargedByMethod[]
  movements: ShiftMovement[]
  cashCounts: ShiftCashCount[]
  /** Money events of the shift the hub did not apply: outside `cash` and `byMethod`. */
  unapplied: UnappliedMovement[]
  cash: {
    /** What was charged in cash: amount, rounding and tip. */
    charged: number
    /** Reversals of voided cash payments and cash refunds of the shift. */
    refunds: number
    cashIn: number
    cashOut: number
    tipPayouts: number
    expected: number
  }
  closed: {
    expected: number
    counted: number
    variance: number
    justification: string | null
    otherMethods: MethodReconciliation[]
    time: string
  } | null
}

const timeOf = (e: ApplicableEvent) => e.received_at ?? e.hub_estimated_time

interface ShiftPayment {
  method: PaymentMethod
  customMethodId: string | null
  amount: number
  adjustment: number
  tip: number
}

/** The payments named by the events, by id (to reverse a void), applied or not. */
function paymentsById(events: readonly ApplicableEvent[]): Map<string, ShiftPayment> {
  const payments = new Map<string, ShiftPayment>()
  for (const e of events)
    if (e.type === 'PaymentRecorded')
      payments.set(e.data.payment_id, {
        method: e.data.method,
        customMethodId: e.data.custom_method_id ?? null,
        amount: e.data.amount,
        adjustment: e.data.rounding_adjustment,
        tip: e.data.tip,
      })
  return payments
}

/**
 * What was charged in a shift per payment method: sale (with its rounding) and tip, minus what was
 * voided and refunded in that shift. Methods that end at 0 are left out.
 */
export function chargedInShift(
  events: readonly ApplicableEvent[],
  shiftId: string,
): ChargedByMethod[] {
  return chargedBy(events, (e) => e.data.register_shift_id === shiftId)
}

/** The events that change what was charged per method. */
type CheckoutEvent = Extract<
  ApplicableEvent,
  { type: 'PaymentRecorded' | 'PaymentVoided' | 'RefundRecorded' }
>

/**
 * What was charged per payment method with the checkout events that `check` accepts (those of a
 * shift, those of some days): each payment adds; each void or refund subtracts from its payment's
 * method. The payments they reverse may be among the events even if they don't count (they belong
 * to another shift or day). Those the hub did not apply (`unapplied`) do not count.
 */
export function chargedBy(
  events: readonly ApplicableEvent[],
  check: (e: CheckoutEvent) => boolean,
): ChargedByMethod[] {
  const payments = paymentsById(events)
  const byMethod = new Map<string, ChargedByMethod>()
  const add = (
    p: Pick<ShiftPayment, 'method' | 'customMethodId'>,
    sale: number,
    tip: number,
    n: number,
  ) => {
    const key = methodKeyOf(p)
    const m = byMethod.get(key) ?? {
      method: p.method,
      customMethodId: p.customMethodId,
      sale: 0,
      tip: 0,
      payments: 0,
    }
    m.sale += sale
    m.tip += tip
    m.payments += n
    byMethod.set(key, m)
  }
  for (const e of events) {
    if (
      (e.type !== 'PaymentRecorded' && e.type !== 'PaymentVoided' && e.type !== 'RefundRecorded') ||
      e.unapplied ||
      !check(e)
    )
      continue
    if (e.type === 'PaymentRecorded') {
      const d = e.data
      add(
        { method: d.method, customMethodId: d.custom_method_id ?? null },
        d.amount + d.rounding_adjustment,
        d.tip,
        1,
      )
    } else if (e.type === 'PaymentVoided') {
      const payment = payments.get(e.data.payment_id)
      if (payment) add(payment, -(payment.amount + payment.adjustment), -payment.tip, -1)
    } else {
      const payment = payments.get(e.data.payment_id)
      add(
        { method: e.data.method, customMethodId: payment?.customMethodId ?? null },
        -e.data.sale_amount,
        -e.data.tip_amount,
        0,
      )
    }
  }
  return [...byMethod.values()].filter((m) => m.payments !== 0 || m.sale !== 0 || m.tip !== 0)
}

/** −n without a −0 (it would not survive JSON and breaks equality between nodes). */
const minus = (n: number) => (n === 0 ? 0 : -n)

/** A checkout event the hub did not apply, with the sign it would have moved the register. */
function unappliedMovement(
  e: CheckoutEvent,
  payments: ReadonlyMap<string, ShiftPayment>,
): UnappliedMovement {
  const base = { eventId: e.id, orderId: e.aggregate_id, userId: e.user_id, time: timeOf(e) }
  if (e.type === 'PaymentRecorded') {
    const d = e.data
    return {
      ...base,
      type: e.type,
      method: d.method,
      customMethodId: d.custom_method_id ?? null,
      amount: d.amount + d.rounding_adjustment + d.tip,
      tip: d.tip,
    }
  }
  const payment = payments.get(e.data.payment_id)
  if (e.type === 'PaymentVoided')
    return {
      ...base,
      type: e.type,
      method: payment?.method ?? null,
      customMethodId: payment?.customMethodId ?? null,
      amount: payment ? minus(payment.amount + payment.adjustment + payment.tip) : null,
      tip: payment ? minus(payment.tip) : null,
    }
  return {
    ...base,
    type: e.type,
    method: e.data.method,
    customMethodId: payment?.customMethodId ?? null,
    amount: minus(e.data.sale_amount + e.data.tip_amount),
    tip: minus(e.data.tip_amount),
  }
}

/**
 * The checkout events that `check` accepts and the hub did not apply (`unapplied`, task 1.7b), in
 * the order of the events: they count nowhere else and are shown apart (DINERO.md#caja).
 */
export function unappliedMoney(
  events: readonly ApplicableEvent[],
  check: (e: CheckoutEvent) => boolean,
): UnappliedMovement[] {
  const payments = paymentsById(events)
  const list: UnappliedMovement[] = []
  for (const e of events)
    if (
      (e.type === 'PaymentRecorded' || e.type === 'PaymentVoided' || e.type === 'RefundRecorded') &&
      e.unapplied &&
      check(e)
    )
      list.push(unappliedMovement(e, payments))
  return list
}

/**
 * The shift reconciliation from the events that touch it (in the order they were applied).
 * Without its `ShiftOpened`, null.
 */
export function shiftReconciliation(
  events: readonly ApplicableEvent[],
  shiftId: string,
): ShiftReconciliation | null {
  const opening = events.find((e) => e.type === 'ShiftOpened' && e.aggregate_id === shiftId)
  if (opening?.type !== 'ShiftOpened') return null
  const payments = paymentsById(events)
  const cash = { charged: 0, refunds: 0, cashIn: 0, cashOut: 0, tipPayouts: 0 }
  const movements: ShiftMovement[] = []
  const cashCounts: ShiftCashCount[] = []
  let closed: ShiftReconciliation['closed'] = null

  for (const e of events) {
    // Money the hub did not apply goes apart (`unapplied`), never into the expected cash.
    if (e.unapplied) continue
    switch (e.type) {
      case 'PaymentRecorded':
        if (e.data.register_shift_id === shiftId && e.data.method === 'cash')
          cash.charged += e.data.amount + e.data.rounding_adjustment + e.data.tip
        break
      case 'PaymentVoided': {
        const payment = payments.get(e.data.payment_id)
        if (e.data.register_shift_id === shiftId && payment?.method === 'cash')
          cash.refunds += payment.amount + payment.adjustment + payment.tip
        break
      }
      case 'RefundRecorded':
        if (e.data.register_shift_id === shiftId && e.data.method === 'cash')
          cash.refunds += e.data.sale_amount + e.data.tip_amount
        break
      case 'CashMovementRecorded': {
        if (e.aggregate_id !== shiftId) break
        const d = e.data
        if (d.type === 'cash_in') cash.cashIn += d.amount
        else if (d.type === 'cash_out') cash.cashOut += d.amount
        else cash.tipPayouts += d.amount
        movements.push({
          id: d.movement_id,
          type: d.type,
          amount: d.amount,
          description: d.description,
          toWhom: d.to_whom,
          time: timeOf(e),
        })
        break
      }
      case 'CashCountRecorded':
        if (e.aggregate_id === shiftId)
          cashCounts.push({
            id: e.data.cash_count_id,
            tally: e.data.tally,
            counted: e.data.counted_cash,
            others: (e.data.others ?? []).map((o) => ({
              method: o.method,
              customMethodId: o.custom_method_id,
              reported: o.reported,
            })),
            time: timeOf(e),
          })
        break
      case 'ShiftClosed':
        if (e.aggregate_id === shiftId)
          closed = {
            expected: e.data.expected_cash,
            counted: e.data.counted_cash,
            variance: e.data.variance,
            justification: e.data.justification,
            otherMethods: (e.data.other_methods ?? []).map((o) => ({
              method: o.method,
              customMethodId: o.custom_method_id,
              expected: o.expected,
              reported: o.reported,
              variance: o.variance,
            })),
            time: timeOf(e),
          }
        break
    }
  }

  const base = opening.data.base
  return {
    shiftId,
    registerId: opening.data.register_id,
    base,
    openedAt: timeOf(opening),
    byMethod: chargedInShift(events, shiftId),
    movements,
    cashCounts,
    unapplied: unappliedMoney(events, (e) => e.data.register_shift_id === shiftId),
    cash: {
      ...cash,
      expected: expectedCash({
        base,
        payments: [{ amount: cash.charged, roundingAdjustment: 0, tip: 0 }],
        refunds: [cash.refunds],
        cashIn: [cash.cashIn],
        cashOut: [cash.cashOut],
        tipPayouts: [cash.tipPayouts],
        partialWithdrawals: [],
      }),
    },
    closed,
  }
}

/** Colombian bills and coins, largest to smallest, for the cash count. */
export const DENOMINATIONS: readonly { value: number; type: 'bill' | 'coin' }[] = [
  { value: 100_000, type: 'bill' },
  { value: 50_000, type: 'bill' },
  { value: 20_000, type: 'bill' },
  { value: 10_000, type: 'bill' },
  { value: 5_000, type: 'bill' },
  { value: 2_000, type: 'bill' },
  { value: 1_000, type: 'bill' },
  { value: 1_000, type: 'coin' },
  { value: 500, type: 'coin' },
  { value: 200, type: 'coin' },
  { value: 100, type: 'coin' },
  { value: 50, type: 'coin' },
]

/**
 * The reconciliation of the other methods with a count (task 1.8): for each method with something
 * recorded or reported, what was recorded (sale + tip, what the card terminal approves or reaches
 * the app), what its close says and the variance (reported − expected).
 */
export function otherMethodsReconciliation(
  reconciliation: ShiftReconciliation,
  cashCount: ShiftCashCount,
): MethodReconciliation[] {
  const key = methodKeyOf
  const lines = new Map<string, MethodReconciliation>()
  for (const m of reconciliation.byMethod)
    if (m.method !== 'cash')
      lines.set(key(m), {
        method: m.method,
        customMethodId: m.customMethodId,
        expected: m.sale + m.tip,
        reported: 0,
        variance: 0,
      })
  for (const o of cashCount.others) {
    const current = lines.get(key(o)) ?? { ...o, expected: 0, reported: 0, variance: 0 }
    lines.set(key(o), { ...current, reported: o.reported })
  }
  return [...lines.values()]
    .map((l) => ({ ...l, variance: l.reported - l.expected }))
    .filter((l) => l.expected !== 0 || l.reported !== 0)
}
