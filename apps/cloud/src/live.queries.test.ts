import { newId, type OrderEvent } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../packages/core/src/testing/factory'
import { dayAlerts } from './alerts'
import { inRestaurant } from './cloud'
import { LIVE_WINDOW_DAYS, liveOrders } from './live'
import { addDays } from './panel'
import { registersNow } from './register'
import { configFrom, hubsOfLocation, type Scope } from './reports'
import type { Sql } from './sql'
import { createWorld } from './testing/world'

// The live routes must ask Postgres a fixed number of questions, however many orders and shifts
// there are (task 1.11c-2): the Worker pays for every round trip, and a query per order would turn
// a busy Friday night into a slow panel. Counted, not timed, so it never flakes.

const TODAY = '2026-10-26'
const day = { business_day: TODAY, received_at: `${TODAY}T14:00:00.000Z` }

/** `orders` orders on tables (half sent to the kitchen, a fifth moved to the next one), plus `shifts` open shifts. */
function restaurantWith(orders: number, shifts: number): OrderEvent[] {
  const events: OrderEvent[] = []
  const ids: { id: string; copy: ReturnType<typeof itemCopy> }[] = []
  for (let i = 0; i < orders; i++) {
    const id = newId()
    const copy = itemCopy({ unit_price: 10_000 + i })
    ids.push({ id, copy })
    events.push(
      event(id, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }, day),
      event(id, 'ItemAdded', copy, day),
    )
    if (i % 2 === 0)
      events.push(
        event(
          id,
          'ItemsSent',
          { tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [copy.item_id] }] },
          day,
        ),
      )
  }
  // Every fifth order sends its dish to the next order: the loading rounds have to follow it.
  for (let i = 0; i + 1 < ids.length; i += 5) {
    const [from, to] = [ids[i], ids[i + 1]]
    if (!from || !to || i % 2 !== 0) continue
    events.push(
      event(
        from.id,
        'ItemsMoved',
        {
          target_order_id: to.id,
          items: [
            {
              item: from.copy,
              status: 'sent',
              voided_quantity: 0,
              added_by: events[1]?.user_id ?? newId(),
            },
          ],
        },
        day,
      ),
    )
  }
  for (let s = 0; s < shifts; s++) {
    const id = newId()
    const order = newId()
    const shift = {
      aggregate_type: 'register_shift' as const,
      business_day: TODAY,
      received_at: `${TODAY}T13:00:00.000Z`,
    }
    events.push(
      event(id, 'ShiftOpened', { register_id: newId(), base: 50_000 }, shift),
      event(order, 'OrderOpened', { channel: 'takeout', table_id: null, guests: 1 }, day),
      event(order, 'ItemAdded', itemCopy({ unit_price: 20_000 }), day),
      event(order, 'PaymentRecorded', cashPaymentData(20_000, { register_shift_id: id }), day),
    )
  }
  return events.map((e, i) => ({ ...e, sequence: i + 1 }))
}

async function counted(size: { orders: number; shifts: number }) {
  const w = await createWorld()
  const h = await w.newHub()
  const events = restaurantWith(size.orders, size.shifts)
  for (let i = 0; i < events.length; i += 400) {
    const r = await w.cloud.receiveEvents(h.hub, events.slice(i, i + 400))
    expect(r.every((x) => x.status === 'saved')).toBe(true)
  }
  let queries = 0
  const counting = (inner: Sql): Sql => ({
    query: (text, params) => {
      queries++
      return inner.query(text, params)
    },
    execute: (script) => inner.execute(script),
    transaction: (job) => inner.transaction((tx) => job(counting(tx))),
  })
  const run = async <T>(job: (tx: Sql, scope: Scope) => Promise<T>) => {
    queries = 0
    const result = await inRestaurant(counting(w.sql), h.restaurantId, async (tx) => {
      const scope: Scope = {
        restaurantId: h.restaurantId,
        hubIds: await hubsOfLocation(tx, h.restaurantId, h.hub.locationId),
      }
      return job(tx, scope)
    })
    return { result, queries }
  }
  const floor = await run((tx, scope) => liveOrders(tx, scope, addDays(TODAY, -LIVE_WINDOW_DAYS)))
  const register = await run((tx, scope) =>
    registersNow(tx, scope, addDays(TODAY, -LIVE_WINDOW_DAYS), TODAY),
  )
  const alerts = await run((tx, scope) => dayAlerts(tx, scope, TODAY, configFrom({})))
  return { floor, register, alerts }
}

describe('queries do not grow with the restaurant', () => {
  it('floor, register and alerts ask the same number of questions for 10 orders as for 150', async () => {
    const small = await counted({ orders: 10, shifts: 1 })
    const big = await counted({ orders: 150, shifts: 6 })
    // The big one really has the load.
    expect(big.floor.result.orders.length).toBeGreaterThanOrEqual(150)
    expect(big.register.result.open).toHaveLength(6)
    for (const k of ['floor', 'register', 'alerts'] as const)
      expect(big[k].queries, k).toBeGreaterThan(2)
    // Same questions per round; rounds are bounded (LIVE_MAX_ROUNDS), not tied to the size.
    for (const k of ['floor', 'register', 'alerts'] as const) {
      expect(big[k].queries, k).toBeLessThanOrEqual(small[k].queries + 2)
      expect(big[k].queries, k).toBeLessThan(40)
    }
  })
})
