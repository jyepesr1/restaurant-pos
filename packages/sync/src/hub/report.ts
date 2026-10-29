import {
  type OrderEvent,
  type OrderState,
  type ReportInput,
  rebuild,
  type ShiftReconciliation,
  shiftReconciliation,
} from '@pos/core'
import type { HubStore } from './store'

// What the hub gathers from the database for reports (task 1.9, docs/KPIS.md): the orders that
// closed in the period, the events recorded in it and the register closings. The calculation is
// done by `report` in @pos/core; here we only query.

/** What counts on the day it was recorded (KPIS.md#período). */
const PERIOD_EVENT_TYPES = [
  'PaymentRecorded',
  'PaymentVoided',
  'RefundRecorded',
  'ItemVoided',
  'OrderCanceled',
  'CashMovementRecorded',
]

/** A closed shift, with its reconciliation and who opened and closed it. */
export interface ShiftClose {
  reconciliation: ShiftReconciliation
  /** The business day it was closed (that of the report that lists it). */
  businessDay: string
  /** The business day it was opened: that of the sales in its Z report. */
  openingDay: string
  openedBy: string
  closedBy: string
  eventId: string
}

/** A table close in the period: the order at closing and at its previous close. */
export type OrderClose = NonNullable<ReportInput['closings']>[number]

export type ReportData = Omit<ReportInput, 'config' | 'closings' | 'closedIds'> & {
  closings: OrderClose[]
  registerClosings: ShiftClose[]
}

/**
 * Adds to the events the payments that their voids and refunds reverse, even if they were
 * recorded on another day: without them we do not know which method the money comes from.
 */
function withOriginalPayments(store: HubStore, events: OrderEvent[]): OrderEvent[] {
  const ids = new Set(events.map((e) => e.id))
  const extra: OrderEvent[] = []
  for (const e of events) {
    if (e.type !== 'PaymentVoided' && e.type !== 'RefundRecorded') continue
    const paymentId = e.data.payment_id
    const payment = store
      .aggregateEvents(e.aggregate_id)
      .find((p) => p.type === 'PaymentRecorded' && p.data.payment_id === paymentId)
    if (payment && !ids.has(payment.id)) {
      ids.add(payment.id)
      extra.push(payment)
    }
  }
  return [...events, ...extra].sort((a, b) => a.sequence - b.sequence)
}

const ordersById = (store: HubStore, ids: Iterable<string>): OrderState[] =>
  [...new Set(ids)]
    .map((id) => rebuild(store.aggregateEvents(id), id))
    .filter((p): p is OrderState => p !== null)

/**
 * A shift's reconciliation from what is stored in the database (also works for one already
 * closed). `shiftEvents` are the shift's events if they were already read.
 */
export function savedReconciliation(
  store: HubStore,
  shiftId: string,
  shiftEvents: OrderEvent[] = store.aggregateEvents(shiftId),
): ShiftReconciliation | null {
  const opening = shiftEvents.find((e) => e.type === 'ShiftOpened')
  if (!opening) return null
  const events = withOriginalPayments(store, [
    ...shiftEvents,
    ...store.shiftCharges(shiftId, opening.business_day),
  ])
  return shiftReconciliation(events, shiftId)
}

/** A shift's close, if it is closed. */
export function shiftClose(store: HubStore, shiftId: string): ShiftClose | null {
  const events = store.aggregateEvents(shiftId)
  const opening = events.find((e) => e.type === 'ShiftOpened')
  const closeout = events.find((e) => e.type === 'ShiftClosed')
  if (!opening || !closeout) return null
  const reconciliation = savedReconciliation(store, shiftId, events)
  if (!reconciliation?.closed) return null
  return {
    reconciliation,
    businessDay: closeout.business_day,
    openingDay: opening.business_day,
    openedBy: opening.user_id,
    closedBy: closeout.user_id,
    eventId: closeout.id,
  }
}

export function reportData(store: HubStore, from: string, until: string): ReportData {
  // Each order's events, read once.
  const fromOrder = new Map<string, OrderEvent[]>()
  const eventsOf = (id: string) => {
    const all = fromOrder.get(id) ?? store.aggregateEvents(id)
    fromOrder.set(id, all)
    return all
  }
  /** The order as it was after the event at that sequence (or just before, with `<`). */
  const stateUntil = (id: string, sequence: number, included = true) =>
    rebuild(
      eventsOf(id).filter((x) => (included ? x.sequence <= sequence : x.sequence < sequence)),
      id,
    )

  // Each table close in the period adds what changed since its previous close: an order
  // reopened on another day does not change what was already reported
  // (DINERO.md#día-operativo-e-informes).
  const closings: OrderClose[] = []
  for (const c of store.periodEvents(['OrderClosed'], from, until)) {
    const after = stateUntil(c.aggregate_id, c.sequence)
    if (!after) continue
    const previous = eventsOf(c.aggregate_id)
      .filter((x) => x.type === 'OrderClosed' && x.aggregate_id === c.aggregate_id)
      .filter((x) => x.sequence < c.sequence)
      .at(-1)
    closings.push({
      before: previous ? stateUntil(c.aggregate_id, previous.sequence) : null,
      after,
    })
  }
  const events = withOriginalPayments(store, store.periodEvents(PERIOD_EVENT_TYPES, from, until))
  const related = ordersById(
    store,
    events
      .filter((e) => e.type === 'ItemVoided' || e.type === 'OrderCanceled')
      .map((e) => e.aggregate_id),
  )
  // The order just before each void: the item may have moved to another table later.
  const onVoid = new Map<string, OrderState>()
  for (const e of events) {
    if (e.type !== 'ItemVoided') continue
    const before = stateUntil(e.aggregate_id, e.sequence, false)
    if (before) onVoid.set(e.id, before)
  }
  return {
    from,
    until,
    closings,
    related,
    onVoid,
    events,
    registerClosings: store
      .periodEvents(['ShiftClosed'], from, until)
      .map((e) => shiftClose(store, e.aggregate_id))
      .filter((c): c is ShiftClose => c !== null),
  }
}
