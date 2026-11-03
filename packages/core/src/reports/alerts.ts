import type { Channel, PaymentMethod } from '../events/common'
import type { ApplicableEvent } from '../events/order'
import { rebuild, unappliedEvents } from '../order/apply'
import type { OrderState } from '../order/state'
import { orderTotals } from '../order/totals'
import { isLargeVariance, methodKeyOf, type ShiftReconciliation } from '../register/shift'
import type { Cancellation, VoidEntry } from './report'

// The owner's alerts for a business day (task 1.11c-2, docs/PANEL.md#alertas): what someone did
// that takes money away or changes what was already charged, with who did it, who authorized it,
// why and for how much. Product voids and canceled orders come from `report()`; the rest comes from
// the day's events. An event the hub saved as a conflict (its order did not apply it) is never an
// alert, though `report()` still counts it (docs/KPIS.md#eventos-guardados-como-conflicto). Only
// computes: whoever calls it gathers the events.

export const ALERT_TYPES = [
  'item_voided',
  'order_canceled',
  'discount',
  'payment_voided',
  'refund',
  'order_reopened',
  'register_variance',
] as const

export type AlertType = (typeof ALERT_TYPES)[number]

/** The order an alert is about, as it was right before what happened. */
export interface AlertOrder {
  id: string
  /** The order's number for its day, if it has one. */
  number: number | null
  tableId: string | null
  /** Null only if the order's events were not at hand. */
  channel: Channel | null
}

interface AlertBase {
  /** The event's id (a register variance: the close's id and the method). */
  id: string
  time: string
  /** Null in a register variance: it is about the register, not an order. */
  order: AlertOrder | null
  /** Who did it (in a register variance, who closed the register). */
  userId: string
  /** Who authorized it with their PIN, if it was someone else. */
  authorizedById: string | null
  /** The reason they wrote (in a register variance, the cashier's justification). */
  reason: string | null
  /**
   * In pesos. What the action is worth: what was voided, discounted, returned or what the order
   * had when it was reopened. In a register variance, counted − expected (negative: missing).
   * Null only in a voided payment whose payment is not among the events, or a reopening without
   * the order's previous events: it cannot be known («monto no disponible», never a made-up 0).
   */
  value: number | null
}

export type Alert = AlertBase &
  (
    | {
        type: 'item_voided'
        value: number
        name: string
        units: number
        alreadyPrepared: boolean
      }
    | { type: 'order_canceled'; value: number }
    | {
        type: 'discount'
        value: number
        rule: 'percent' | 'value' | 'comp'
        scope: 'item' | 'order'
        /** A percentage discount, in basis points (1000 = 10 %). */
        basisPoints: number | null
        /** A courtesy: how many units. */
        units: number | null
        /** The names of the discounted products (one with `scope: 'item'`). */
        items: string[]
        /** When it was removed and by whom, if it was. */
        removedAt: string | null
        removedBy: string | null
      }
    | {
        type: 'payment_voided'
        value: number | null
        method: PaymentMethod | null
        customMethodId: string | null
        /** The part of `value` that was tip (null, like `value`, without the payment). */
        tip: number | null
        /** The part of `value` that was the cash rounding adjustment (null without the payment). */
        roundingAdjustment: number | null
      }
    | {
        type: 'refund'
        value: number
        method: PaymentMethod
        customMethodId: string | null
        /** The part of `value` that was tip. */
        tip: number
      }
    | { type: 'order_reopened'; value: number | null }
    | {
        type: 'register_variance'
        value: number
        shiftId: string
        method: PaymentMethod
        customMethodId: string | null
        /** What there should be (cash) or what the system recorded (another method). */
        expected: number
        /** What was counted (cash) or what the method's own close says. */
        counted: number
        openedBy: string
      }
  )

/** A register close of the day (the hub's `ShiftClose` has these fields). */
export interface AlertClosing {
  eventId: string
  openedBy: string
  closedBy: string
  reconciliation: ShiftReconciliation
}

export interface AlertsInput {
  /** The business day (YYYY-MM-DD). */
  day: string
  /** `report().voids` and `report().cancellations` of that day. */
  voids: readonly VoidEntry[]
  cancellations: readonly Cancellation[]
  /**
   * Every event of each order with something to alert about on the day, by order id (as the hub's
   * `aggregateEvents`: also the moves and merges that touch it). Also the orders of `voids` and
   * `cancellations`: from them it is known whether one was saved as a conflict (without the order's
   * opening, it counts).
   */
  orders: ReadonlyMap<string, readonly ApplicableEvent[]>
  /** The register closes of the day. */
  registerClosings: readonly AlertClosing[]
  /** From how many pesos a variance is an alert (`register_variance_threshold`). */
  threshold: number
}

/** The event types read from the orders' events (voids and cancellations come from the report). */
export const ALERT_EVENT_TYPES = [
  'DiscountApplied',
  'PaymentVoided',
  'RefundRecorded',
  'OrderReopened',
] as const

const timeOf = (e: ApplicableEvent) => e.received_at ?? e.hub_estimated_time

const ALERT_EVENTS: ReadonlySet<string> = new Set(ALERT_EVENT_TYPES)

/** The alerts of the day, from the newest to the oldest. */
export function alerts(entry: AlertsInput): Alert[] {
  const { day, orders } = entry
  const eventById = new Map<string, ApplicableEvent>()
  for (const list of orders.values()) for (const e of list) eventById.set(e.id, e)
  /** The order right before that event (all of it if the event is not among its events). */
  const before = (orderId: string, eventId: string): OrderState | null => {
    const sequence = eventById.get(eventId)?.sequence ?? Number.POSITIVE_INFINITY
    return rebuild(
      (orders.get(orderId) ?? []).filter((e) => (e.sequence ?? 0) < sequence),
      orderId,
    )
  }
  const orderOf = (p: OrderState | null, id: string, number: number | null = null): AlertOrder =>
    p
      ? { id, number: p.dayNumber, tableId: p.tableId, channel: p.channel }
      : { id, number, tableId: null, channel: null }

  // What the hub saved as a conflict (an item already voided, an order already closed…) changed
  // nothing: no alert. `report()` still lists such a void or cancellation (docs/KPIS.md), so it is
  // left out here, from each order's own events.
  const unappliedOf = new Map<string, ReadonlySet<string>>()
  const unapplied = (orderId: string): ReadonlySet<string> => {
    let set = unappliedOf.get(orderId)
    if (!set) {
      set = unappliedEvents(orders.get(orderId) ?? [], [orderId])
      unappliedOf.set(orderId, set)
    }
    return set
  }

  const out: Alert[] = []
  for (const v of entry.voids) {
    if (unapplied(v.orderId).has(v.eventId)) continue
    out.push({
      type: 'item_voided',
      id: v.eventId,
      time: v.time,
      order: orderOf(before(v.orderId, v.eventId), v.orderId, v.orderNumber),
      userId: v.userId,
      authorizedById: v.authorizedById,
      reason: v.reason,
      value: v.value,
      name: v.name,
      units: v.units,
      alreadyPrepared: v.alreadyPrepared,
    })
  }
  for (const c of entry.cancellations) {
    if (unapplied(c.orderId).has(c.eventId)) continue
    out.push({
      type: 'order_canceled',
      id: c.eventId,
      time: c.time,
      order: orderOf(before(c.orderId, c.eventId), c.orderId, c.orderNumber),
      userId: c.userId,
      authorizedById: c.authorizedById,
      reason: c.reason,
      value: c.value,
    })
  }

  const seen = new Set<string>()
  for (const [orderId, list] of orders) {
    const skipped = unapplied(orderId)
    for (const e of list) {
      // Each event once, from its own order, and only those recorded on the day.
      if (e.aggregate_id !== orderId || e.business_day !== day || seen.has(e.id)) continue
      if (!ALERT_EVENTS.has(e.type) || skipped.has(e.id)) continue
      seen.add(e.id)
      const state = before(orderId, e.id)
      const common = {
        id: e.id,
        time: timeOf(e),
        order: orderOf(state, orderId),
        userId: e.user_id,
        authorizedById: e.authorized_by_id ?? null,
        reason: e.reason,
      }
      const paymentOf = (paymentId: string) =>
        list.find((p) => p.type === 'PaymentRecorded' && p.data.payment_id === paymentId) as
          | Extract<ApplicableEvent, { type: 'PaymentRecorded' }>
          | undefined
      if (e.type === 'DiscountApplied') {
        const d = e.data
        const removal = list.find(
          (x) =>
            x.type === 'DiscountRemoved' &&
            !skipped.has(x.id) &&
            x.data.discount_id === d.discount_id &&
            (x.sequence ?? 0) > (e.sequence ?? 0),
        )
        out.push({
          ...common,
          type: 'discount',
          value: d.amounts.reduce((s, m) => s + m.amount, 0),
          rule: d.rule,
          scope: d.scope,
          basisPoints: d.rule === 'percent' ? d.value : null,
          units: d.unit_count,
          items: d.amounts.map((m) => state?.items[m.item_id]?.name ?? 'Producto'),
          removedAt: removal ? timeOf(removal) : null,
          removedBy: removal ? removal.user_id : null,
        })
      } else if (e.type === 'PaymentVoided') {
        const p = paymentOf(e.data.payment_id)?.data
        out.push({
          ...common,
          type: 'payment_voided',
          value: p ? p.amount + p.rounding_adjustment + p.tip : null,
          method: p?.method ?? null,
          customMethodId: p?.custom_method_id ?? null,
          tip: p ? p.tip : null,
          roundingAdjustment: p ? p.rounding_adjustment : null,
        })
      } else if (e.type === 'RefundRecorded') {
        out.push({
          ...common,
          type: 'refund',
          value: e.data.sale_amount + e.data.tip_amount,
          method: e.data.method,
          customMethodId: paymentOf(e.data.payment_id)?.data.custom_method_id ?? null,
          tip: e.data.tip_amount,
        })
      } else {
        out.push({
          ...common,
          type: 'order_reopened',
          // What it had when it was closed; unknown without the order's previous events.
          value: state?.status === 'closed' ? orderTotals(state).net : null,
        })
      }
    }
  }

  for (const c of entry.registerClosings) {
    const closed = c.reconciliation.closed
    if (!closed) continue
    const common = {
      type: 'register_variance' as const,
      time: closed.time,
      order: null,
      userId: c.closedBy,
      authorizedById: null,
      reason: closed.justification,
      shiftId: c.reconciliation.shiftId,
      openedBy: c.openedBy,
    }
    if (isLargeVariance(closed.variance, entry.threshold))
      out.push({
        ...common,
        id: `${c.eventId}:cash`,
        value: closed.variance,
        method: 'cash',
        customMethodId: null,
        expected: closed.expected,
        counted: closed.counted,
      })
    for (const m of closed.otherMethods)
      if (isLargeVariance(m.variance, entry.threshold))
        out.push({
          ...common,
          id: `${c.eventId}:${methodKeyOf(m)}`,
          value: m.variance,
          method: m.method,
          customMethodId: m.customMethodId,
          expected: m.expected,
          counted: m.reported,
        })
  }

  return out.sort((a, b) =>
    a.time === b.time ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.time < b.time ? 1 : -1,
  )
}

/** The people an alert names: who did it, who authorized it, who removed or opened. */
export const alertPeople = (list: readonly Alert[]): string[] =>
  list.flatMap((a) => [
    a.userId,
    ...(a.authorizedById ? [a.authorizedById] : []),
    ...(a.type === 'discount' && a.removedBy ? [a.removedBy] : []),
    ...(a.type === 'register_variance' ? [a.openedBy] : []),
  ])

/** The tables the alerts name. */
export const alertTables = (list: readonly Alert[]): string[] =>
  list.flatMap((a) => (a.order?.tableId ? [a.order.tableId] : []))
