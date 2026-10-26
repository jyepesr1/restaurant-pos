import type { ApplicableEvent } from '../events/order'
import { type RoundingMode, roundDiv, toInteger } from '../money/arithmetic'
import type { OrderState } from '../order/state'
import {
  type ItemizedTax,
  itemTotals,
  orderTotals,
  pricePerUnit,
  taxesOfOrders,
} from '../order/totals'
import { type ChargedByMethod, chargedBy } from '../register/shift'

// The basic reports (task 1.9), with the formulas in docs/KPIS.md. The hub gathers the period's
// orders and events; here we only compute, so the screen, the CSV and the Z report always say the
// same thing.

export interface ReportInput {
  /** Business days of the period, inclusive (YYYY-MM-DD). */
  from: string
  until: string
  /**
   * Each `OrderClosed` of the period: the order when closed (`after`) and as it was at its
   * previous close (`before`, null if it is the first). An order reopened on another day adds only
   * the difference on that day: what was already reported for a day does not change
   * (DINERO.md#día-operativo-e-informes).
   */
  closings?: readonly { before: OrderState | null; after: OrderState }[]
  /** Test shortcut: orders closed for the first time in the period (closes with no `before`). */
  closedIds?: readonly OrderState[]
  /** The orders named by the period's events (for voids and cancellations). */
  related: readonly OrderState[]
  /**
   * For each `ItemVoided` (its id), the order as it was right before: the voided item may later
   * have gone to another table (move or merge) and no longer be in its order.
   */
  onVoid?: ReadonlyMap<string, OrderState>
  /**
   * The events recorded in the period (payments, payment voids, refunds, product voids,
   * cancellations and cash movements) and, even if they are from another day, the payments those
   * voids and refunds reverse.
   */
  events: readonly ApplicableEvent[]
  config: {
    sales_by_waiter: 'added_by' | 'assigned_waiter'
    rounding_mode: RoundingMode
  }
}

export interface SalesSummary {
  gross: number
  voided: number
  discounts: number
  net: number
  /** Σ cash rounding adjustment in those orders' payments (DINERO.md: Z report line). */
  settings: number
  taxes: ItemizedTax[]
  tips: number
  checks: number
  guests: number
  averageTicket: number
  spendPerGuest: number
}

export interface WaiterSales {
  userId: string
  net: number
  checks: number
  averageTicket: number
}

export interface ProductSales {
  productId: string
  variantId: string | null
  name: string
  units: number
  net: number
}

export interface VoidEntry {
  eventId: string
  orderId: string
  /** The order's number for its day, if known. */
  orderNumber: number | null
  name: string
  units: number
  value: number
  reason: string | null
  alreadyPrepared: boolean
  userId: string
  authorizedById: string | null
  time: string
}

export interface Cancellation {
  eventId: string
  orderId: string
  orderNumber: number | null
  value: number
  reason: string | null
  userId: string
  authorizedById: string | null
  time: string
}

export interface ReportDiscount {
  orderId: string
  orderNumber: number | null
  rule: 'percent' | 'value' | 'comp'
  value: number
  amount: number
  reason: string | null
}

export interface Report {
  from: string
  until: string
  sales: SalesSummary
  byMethod: ChargedByMethod[]
  byWaiter: WaiterSales[]
  byProduct: ProductSales[]
  voids: VoidEntry[]
  cancellations: Cancellation[]
  discounts: ReportDiscount[]
  tipPool: { tips: number; paidOut: number; balance: number }
}

/** a ÷ b rounded to pesos with the restaurant's mode; 0 if b is 0. Symmetric for negative a. */
function average(a: number, b: number, mode: RoundingMode): number {
  if (b === 0) return 0
  const abs = toInteger(roundDiv(BigInt(Math.abs(a)), BigInt(b), mode))
  return a < 0 ? -abs : abs
}

const timeOf = (e: ApplicableEvent) => e.received_at ?? e.hub_estimated_time

/** Whether a business day (YYYY-MM-DD) falls in the period. */
const inPeriod = (day: string | undefined, from: string, until: string) =>
  day !== undefined && day >= from && day <= until

export function report(entry: ReportInput): Report {
  const { config, from, until } = entry
  const mode = config.rounding_mode
  const closings = [
    ...(entry.closings ?? []),
    ...(entry.closedIds ?? []).map((after) => ({ before: null, after })),
  ]

  // Sales: what each close of the period added (the order at close minus its previous close).
  let gross = 0
  let voided = 0
  let discounts = 0
  let net = 0
  let settings = 0
  let tips = 0
  let checks = 0
  let guests = 0
  const waiters = new Map<string, { net: number; orders: Set<string> }>()
  const products = new Map<string, ProductSales>()
  const discountList: ReportDiscount[] = []
  const add = (p: OrderState, sign: 1 | -1, firstOne: boolean) => {
    const t = orderTotals(p)
    gross += sign * t.gross
    voided += sign * t.voided
    discounts += sign * t.discount
    net += sign * t.net
    settings += sign * t.settings
    tips += sign * t.tips
    // A check and its guests are counted once: at the first close.
    if (firstOne) {
      guests += p.guests
      if (t.net > 0) checks += 1
    }
    for (const item of Object.values(p.items)) {
      const ti = itemTotals(p, item)
      const waiter = config.sales_by_waiter === 'added_by' ? item.addedBy : p.assignedWaiterId
      const m = waiters.get(waiter) ?? { net: 0, orders: new Set<string>() }
      m.net += sign * ti.net
      if (firstOne && ti.net > 0) m.orders.add(p.id)
      waiters.set(waiter, m)
      const units = Math.max(0, item.quantity - item.voidedQuantity)
      if (units === 0 && ti.net === 0) continue
      const key = `${item.productId}:${item.variantId ?? ''}`
      const v = products.get(key) ?? {
        productId: item.productId,
        variantId: item.variantId,
        name: item.name,
        units: 0,
        net: 0,
      }
      v.units += sign * units
      v.net += sign * ti.net
      products.set(key, v)
    }
  }
  const amountOf = (d: OrderState['discounts'][string]) =>
    Object.values(d.amounts).reduce((a, b) => a + b, 0)
  for (const { before, after } of closings) {
    add(after, 1, before === null)
    if (before) add(before, -1, false)
    // The discounts new since the previous close; one removed on reopening subtracts.
    for (const d of Object.values(after.discounts))
      if (!before?.discounts[d.id])
        discountList.push({
          orderId: after.id,
          orderNumber: after.dayNumber,
          rule: d.rule,
          value: d.value,
          amount: amountOf(d),
          reason: d.reason,
        })
    for (const d of Object.values(before?.discounts ?? {}))
      if (!after.discounts[d.id])
        discountList.push({
          orderId: after.id,
          orderNumber: after.dayNumber,
          rule: d.rule,
          value: d.value,
          amount: -amountOf(d),
          reason: d.reason,
        })
  }

  // What was recorded in the period: payments by method, voids, cancellations and the pool.
  const fromPeriod = (e: ApplicableEvent) => inPeriod(e.business_day, from, until)
  const byMethod = chargedBy(entry.events, fromPeriod)
  const ordersById = new Map(
    [...entry.related, ...closings.map((c) => c.after)].map((p) => [p.id, p] as const),
  )
  const voids: VoidEntry[] = []
  const cancellations: Cancellation[] = []
  let paidOut = 0
  for (const e of entry.events) {
    if (!fromPeriod(e)) continue
    if (e.type === 'ItemVoided') {
      const order = entry.onVoid?.get(e.id) ?? ordersById.get(e.aggregate_id)
      const item = order?.items[e.data.item_id]
      voids.push({
        eventId: e.id,
        orderId: e.aggregate_id,
        orderNumber: order?.dayNumber ?? null,
        name: item?.name ?? 'Producto',
        units: e.data.quantity,
        value: item ? e.data.quantity * pricePerUnit(item) : 0,
        reason: e.reason,
        alreadyPrepared: e.data.already_prepared,
        userId: e.user_id,
        authorizedById: e.authorized_by_id ?? null,
        time: timeOf(e),
      })
    } else if (e.type === 'OrderCanceled') {
      const order = ordersById.get(e.aggregate_id)
      cancellations.push({
        eventId: e.id,
        orderId: e.aggregate_id,
        orderNumber: order?.dayNumber ?? null,
        value: order ? orderTotals(order).net : 0,
        reason: e.reason,
        userId: e.user_id,
        authorizedById: e.authorized_by_id ?? null,
        time: timeOf(e),
      })
    } else if (e.type === 'CashMovementRecorded' && e.data.type === 'tip_payout') {
      paidOut += e.data.amount
    }
  }
  const recordedTips = byMethod.reduce((a, m) => a + m.tip, 0)

  return {
    from,
    until,
    sales: {
      gross,
      voided,
      discounts,
      net,
      settings,
      taxes: taxesOfOrders(
        closings.map((c) => c.after),
        mode,
        closings.flatMap((c) => (c.before ? [c.before] : [])),
      ),
      tips,
      checks,
      guests,
      averageTicket: average(net, checks, mode),
      spendPerGuest: average(net, guests, mode),
    },
    byMethod,
    byWaiter: [...waiters]
      .filter(([, m]) => m.net !== 0 || m.orders.size > 0)
      .map(([userId, m]) => ({
        userId,
        net: m.net,
        checks: m.orders.size,
        averageTicket: average(m.net, m.orders.size, mode),
      }))
      .sort((a, b) => b.net - a.net),
    byProduct: [...products.values()]
      .filter((p) => p.units !== 0 || p.net !== 0)
      .sort((a, b) => b.net - a.net || b.units - a.units),
    voids,
    cancellations,
    discounts: discountList,
    tipPool: {
      tips: recordedTips,
      paidOut,
      balance: recordedTips - paidOut,
    },
  }
}
