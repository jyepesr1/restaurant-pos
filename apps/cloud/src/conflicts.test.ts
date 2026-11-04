import {
  ALERT_EVENT_TYPES,
  alerts,
  newId,
  type OrderEvent,
  type RestaurantConfig,
  report,
} from '@pos/core'
import { type HubStore, MemoryStore, ordersOf, reportData, savedReconciliation } from '@pos/sync'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  cardPaymentData,
  cashPaymentData,
  event,
  itemCopy,
} from '../../../packages/core/src/testing/factory'
import { dayAlerts } from './alerts'
import { inRestaurant } from './cloud'
import { registersNow } from './register'
import { cloudReportData, configFrom, type Scope } from './reports'
import { createWorld, savedEvents, type TestHub, type World } from './testing/world'

// Events the hub saved as a conflict (docs/SYNC.md#rechazos-cuarentena-y-conflictos): the order did
// not apply them. Since task 1.7b the hub marks them (`unapplied`): their money counts neither in
// the register nor in the reports and goes apart, with an alert of its own; the rest is not an
// alert (docs/KPIS.md#eventos-guardados-como-conflicto). One saved before the mark still counts in
// the register, as it did. The cloud gives exactly what the hub's own store gives.

let m: World
let hub: TestHub

beforeEach(async () => {
  m = await createWorld()
  hub = await m.newHub()
})

const DAY = '2026-10-26'
const SHIFT = newId()
const REGISTER = newId()
const CONFIG: RestaurantConfig = configFrom({})
const at = (hhmm: string) => ({ business_day: DAY, received_at: `${DAY}T${hhmm}:00.000Z` })

/**
 * An open shift (base 100.000) and an order paid 40.000 in cash and closed; then, from a register
 * that did not know about the close, another payment of 10.000, a void and a refund of the first
 * payment and a discount (all `order_closed`), and a second void of an item already voided
 * (`item_already_voided`). With `marked`, those late events carry the hub's mark (`unapplied`), as
 * the hub saves them since task 1.7b; without it, as one saved before.
 */
function history(marked: boolean) {
  const order = newId()
  const pinsa = itemCopy({ name: 'Pinsa', unit_price: 40_000 })
  const order2 = newId()
  const lasagna = itemCopy({ name: 'Lasaña', unit_price: 30_000 })
  const card = cardPaymentData(30_000, { register_shift_id: SHIFT })
  const cash = cashPaymentData(40_000, { register_shift_id: SHIFT })
  const reg = { ...at('12:00'), aggregate_type: 'register_shift' as const, device_id: REGISTER }
  const sent = (id: string) => ({
    tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [id] }],
  })
  const voidOf = (id: string) => ({
    item_id: id,
    quantity: 1,
    already_prepared: false,
    ticket_id: null,
  })
  const mark = marked ? { unapplied: true as const } : {}
  const late = {
    lateCharge: event(
      order,
      'PaymentRecorded',
      cashPaymentData(10_000, { register_shift_id: SHIFT }),
      { ...at('20:55'), device_id: REGISTER, ...mark },
    ),
    voidCash: event(
      order,
      'PaymentVoided',
      { payment_id: cash.payment_id, register_shift_id: SHIFT },
      { ...at('21:00'), reason: 'Tarde', device_id: REGISTER, ...mark },
    ),
    refundCash: event(
      order,
      'RefundRecorded',
      {
        payment_id: cash.payment_id,
        refund_id: newId(),
        sale_amount: 5_000,
        tip_amount: 0,
        method: 'cash',
        register_shift_id: SHIFT,
      },
      { ...at('21:01'), reason: 'Tarde', device_id: REGISTER, ...mark },
    ),
    discount: event(
      order,
      'DiscountApplied',
      {
        discount_id: newId(),
        scope: 'order',
        rule: 'value',
        value: 5_000,
        unit_count: null,
        amounts: [{ item_id: pinsa.item_id, amount: 5_000 }],
      },
      { ...at('21:02'), reason: 'Tarde', ...mark },
    ),
    secondVoid: event(order2, 'ItemVoided', voidOf(lasagna.item_id), {
      ...at('21:03'),
      reason: 'Otro mesero ya lo anuló',
      ...mark,
    }),
  }
  const firstVoid = event(order2, 'ItemVoided', voidOf(lasagna.item_id), {
    ...at('20:30'),
    reason: 'Se quemó',
  })
  const events: OrderEvent[] = [
    event(SHIFT, 'ShiftOpened', { register_id: REGISTER, base: 100_000 }, reg),
    event(order, 'OrderOpened', { channel: 'takeout', table_id: null, guests: 1 }, at('19:00')),
    event(order, 'ItemAdded', pinsa, at('19:00')),
    event(order, 'PaymentRecorded', cash, { ...at('20:00'), device_id: REGISTER }),
    event(order, 'OrderClosed', {}, at('20:01')),
    event(order2, 'OrderOpened', { channel: 'takeout', table_id: null, guests: 1 }, at('19:00')),
    event(order2, 'ItemAdded', lasagna, at('19:00')),
    event(order2, 'ItemAdded', itemCopy({ unit_price: 30_000 }), at('19:00')),
    event(order2, 'ItemsSent', sent(lasagna.item_id), at('19:05')),
    firstVoid,
    event(order2, 'PaymentRecorded', card, { ...at('20:40'), device_id: REGISTER }),
    ...Object.values(late),
  ]
  return {
    events: events.map((e, i) => ({ ...e, sequence: i + 1 })),
    late,
    firstVoid,
  }
}

function hubStore(events: readonly OrderEvent[]): HubStore {
  const store = new MemoryStore()
  for (const e of events) store.saveEvent(e, e.id, ordersOf(e))
  return store
}

const scope = (): Scope => ({ restaurantId: hub.restaurantId, hubIds: [hub.hub.id] })

async function uploaded(marked: boolean) {
  const h = history(marked)
  const r = await m.cloud.receiveEvents(hub.hub, h.events)
  expect(r.every((x) => x.status === 'saved')).toBe(true)
  return h
}

/** The register in the cloud's panel and the hub's own, for the same events. */
async function registers(events: readonly OrderEvent[]) {
  const now = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
    registersNow(tx, scope(), '2026-10-01', DAY),
  )
  return {
    cloud: now.open.map((o) => o.reconciliation),
    hub: [savedReconciliation(hubStore(events), SHIFT)],
  }
}

/** The day's alerts as the hub's store would give them, with every event at hand. */
function hubAlerts(events: readonly OrderEvent[]) {
  const store = hubStore(events)
  const data = reportData(store, DAY, DAY)
  const r = report({
    ...data,
    config: { sales_by_waiter: CONFIG.sales_by_waiter, rounding_mode: CONFIG.rounding_mode },
  })
  const ids = new Set([
    ...store.periodEvents(ALERT_EVENT_TYPES, DAY, DAY).map((e) => e.aggregate_id),
    ...data.events.map((e) => e.aggregate_id),
  ])
  return alerts({
    day: DAY,
    voids: r.voids,
    cancellations: r.cancellations,
    orders: new Map([...ids].map((id) => [id, store.aggregateEvents(id)])),
    registerClosings: data.registerClosings,
    unapplied: r.unapplied,
    threshold: CONFIG.register_variance_threshold,
  })
}

const cloudAlerts = () =>
  inRestaurant(m.sql, hub.restaurantId, (tx) => dayAlerts(tx, scope(), DAY, CONFIG))

describe('events the hub marked as unapplied (task 1.7b), in the cloud as in the hub', () => {
  it('the stored content keeps the mark; the events without it do not get one', async () => {
    const h = await uploaded(true)
    const saved = new Map(
      (await savedEvents(m.db, hub.restaurantId)).map((row) => [
        row.id,
        (row.content as { unapplied?: unknown }).unapplied,
      ]),
    )
    for (const e of Object.values(h.late)) expect(saved.get(e.id)).toBe(true)
    expect(saved.get(h.firstVoid.id)).toBeUndefined()
    expect([...saved.values()].filter((u) => u !== undefined)).toHaveLength(5)
  })

  it('the report and the open register: the same as in the hub, with the money apart', async () => {
    const h = await uploaded(true)
    const { data } = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
      cloudReportData(tx, scope(), DAY, DAY),
    )
    expect(data).toEqual(reportData(hubStore(h.events), DAY, DAY))
    const { cloud, hub: inHub } = await registers(h.events)
    expect(cloud).toEqual(inHub)
    const [reconciliation] = cloud
    // Only the first cash payment counts: neither the late one, nor its void, nor the refund.
    expect(reconciliation?.cash).toMatchObject({ charged: 40_000, refunds: 0, expected: 140_000 })
    expect(reconciliation?.unapplied.map((u) => [u.eventId, u.type, u.method, u.amount])).toEqual([
      [h.late.lateCharge.id, 'PaymentRecorded', 'cash', 10_000],
      [h.late.voidCash.id, 'PaymentVoided', 'cash', -40_000],
      [h.late.refundCash.id, 'RefundRecorded', 'cash', -5_000],
    ])
    const r = report({
      ...data,
      config: { sales_by_waiter: CONFIG.sales_by_waiter, rounding_mode: CONFIG.rounding_mode },
    })
    expect(r.unapplied.map((u) => u.eventId)).toEqual(
      reconciliation?.unapplied.map((u) => u.eventId),
    )
    expect(r.voids.map((v) => v.eventId)).toEqual([h.firstVoid.id])
  })

  it('the alerts: the real void and one «unapplied money» per payment, void and refund', async () => {
    const h = await uploaded(true)
    const cloud = await cloudAlerts()
    expect(cloud.alerts).toEqual(hubAlerts(h.events))
    expect(cloud.alerts.map((a) => [a.id, a.type])).toEqual([
      [h.late.refundCash.id, 'unapplied_money'],
      [h.late.voidCash.id, 'unapplied_money'],
      [h.late.lateCharge.id, 'unapplied_money'],
      [h.firstVoid.id, 'item_voided'],
    ])
    const charge = cloud.alerts.find((a) => a.id === h.late.lateCharge.id)
    expect(charge).toMatchObject({
      type: 'unapplied_money',
      kind: 'PaymentRecorded',
      value: 10_000,
      method: 'cash',
      userId: h.late.lateCharge.user_id,
      order: { channel: 'takeout' },
    })
    expect(cloud.alerts.find((a) => a.id === h.late.voidCash.id)).toMatchObject({
      reason: 'Tarde',
      value: -40_000,
    })
  })
})

describe('events saved as a conflict before the mark, in the cloud as in the hub', () => {
  it('the register still counts them, as the hub that saved them does', async () => {
    const h = await uploaded(false)
    const { data } = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
      cloudReportData(tx, scope(), DAY, DAY),
    )
    expect(data).toEqual(reportData(hubStore(h.events), DAY, DAY))
    const { cloud, hub: inHub } = await registers(h.events)
    expect(cloud).toEqual(inHub)
    const [reconciliation] = cloud
    expect(reconciliation?.unapplied).toEqual([])
    // The late payment, the void and the refund move the cash, as before the mark.
    expect(reconciliation?.cash.charged).toBe(50_000)
    expect(reconciliation?.cash.refunds).toBeGreaterThan(0)
  })

  it('the alerts: only the real void, none of the conflicting events', async () => {
    const h = await uploaded(false)
    const cloud = await cloudAlerts()
    expect(cloud.alerts).toEqual(hubAlerts(h.events))
    expect(cloud.alerts.map((a) => a.id)).toEqual([h.firstVoid.id])
  })
})
