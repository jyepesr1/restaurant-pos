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
import { createWorld, type TestHub, type World } from './testing/world'

// Events the hub saved as a conflict (docs/SYNC.md#rechazos-cuarentena-y-conflictos): the order did
// not apply them, so they are not alerts in the cloud either
// (docs/KPIS.md#eventos-guardados-como-conflicto). The cloud gives exactly what the hub's own store
// gives.

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
 * that did not know about the close, a void and a refund of that payment and a discount (all
 * `order_closed`), and a second void of an item already voided (`item_already_voided`).
 */
function history() {
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
  const late = {
    voidCash: event(
      order,
      'PaymentVoided',
      { payment_id: cash.payment_id, register_shift_id: SHIFT },
      { ...at('21:00'), reason: 'Tarde', device_id: REGISTER },
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
      { ...at('21:01'), reason: 'Tarde', device_id: REGISTER },
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
      { ...at('21:02'), reason: 'Tarde' },
    ),
    secondVoid: event(order2, 'ItemVoided', voidOf(lasagna.item_id), {
      ...at('21:03'),
      reason: 'Otro mesero ya lo anuló',
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

async function uploaded() {
  const h = history()
  const r = await m.cloud.receiveEvents(hub.hub, h.events)
  expect(r.every((x) => x.status === 'saved')).toBe(true)
  return h
}

describe('events saved as a conflict, in the cloud as in the hub', () => {
  // The register and the reports still count them (a task of its own, docs/KPIS.md): the cloud
  // gives exactly what the hub's own store gives.
  it('the report and the open register: the same as in the hub', async () => {
    const h = await uploaded()
    const { data } = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
      cloudReportData(tx, scope(), DAY, DAY),
    )
    expect(data).toEqual(reportData(hubStore(h.events), DAY, DAY))
    const now = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
      registersNow(tx, scope(), '2026-10-01', DAY),
    )
    expect(now.open.map((o) => o.reconciliation)).toEqual([
      savedReconciliation(hubStore(h.events), SHIFT),
    ])
  })

  it('the alerts: only the real void, none of the conflicting events', async () => {
    const h = await uploaded()
    const cloud = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
      dayAlerts(tx, scope(), DAY, CONFIG),
    )
    const store = hubStore(h.events)
    const data = reportData(store, DAY, DAY)
    const r = report({
      ...data,
      config: { sales_by_waiter: CONFIG.sales_by_waiter, rounding_mode: CONFIG.rounding_mode },
    })
    const ids = new Set([
      ...store.periodEvents(ALERT_EVENT_TYPES, DAY, DAY).map((e) => e.aggregate_id),
      ...data.events.map((e) => e.aggregate_id),
    ])
    const expected = alerts({
      day: DAY,
      voids: r.voids,
      cancellations: r.cancellations,
      orders: new Map([...ids].map((id) => [id, store.aggregateEvents(id)])),
      registerClosings: data.registerClosings,
      threshold: CONFIG.register_variance_threshold,
    })
    expect(cloud.alerts).toEqual(expected)
    expect(cloud.alerts.map((a) => a.id)).toEqual([h.firstVoid.id])
  })
})
