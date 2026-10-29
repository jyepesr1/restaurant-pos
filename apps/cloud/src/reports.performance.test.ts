import { newId, type OrderEvent, report } from '@pos/core'
import { MemoryStore, ordersOf, reportData } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../packages/core/src/testing/factory'
import { inRestaurant } from './cloud'
import { cloudReportData, configFrom, periodReport } from './reports'
import { createWorld } from './testing/world'

// How long the 31-day report takes (the panel's longest period in 1.11c-1) with about 1,500
// events per day, in PGlite. It prints the time; it only fails if it is absurdly slow.

const DAYS = 31
const ORDERS_PER_DAY = 214 // × 7 events ≈ 1,500 per day
const CASHIER = newId()

function history(): OrderEvent[] {
  const events: OrderEvent[] = []
  let sequence = 0
  const push = (e: OrderEvent, day: string, minute: number) => {
    sequence += 1
    const at = new Date(Date.parse(`${day}T17:00:00.000Z`) + minute * 60_000).toISOString()
    events.push({ ...e, sequence, business_day: day, received_at: at })
  }
  const register = newId()
  for (let d = 0; d < DAYS; d++) {
    const day = new Date(Date.UTC(2026, 9, 1 + d)).toISOString().slice(0, 10)
    const shift = newId()
    // Register events as the hub stores them (the same envelope as packages/sync's histories).
    const shiftEvent = (type: string, data: unknown) =>
      ({
        id: newId(),
        type,
        schema_version: 1,
        aggregate_type: 'register_shift',
        aggregate_id: shift,
        related: [],
        data,
        session_id: null,
        user_id: CASHIER,
        device_id: register,
        authorization_id: null,
        reason: null,
        device_time: `${day}T17:00:00.000Z`,
        hub_estimated_time: `${day}T17:00:00.000Z`,
        base_sequence: 0,
        assignments: {},
        affects: [],
        authorized_by_id: null,
      }) as unknown as OrderEvent
    push(shiftEvent('ShiftOpened', { register_id: register, base: 100_000 }), day, 0)
    for (let o = 0; o < ORDERS_PER_DAY; o++) {
      const order = newId()
      const items = [itemCopy(), itemCopy({ unit_price: 14_900 }), itemCopy({ unit_price: 29_900 })]
      const total = 40_900 + 14_900 + 29_900
      push(
        event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }),
        day,
        o,
      )
      for (const item of items) push(event(order, 'ItemAdded', item), day, o)
      push(
        event(order, 'ItemsSent', {
          tickets: [
            { ticket_id: newId(), station_id: newId(), item_ids: items.map((i) => i.item_id) },
          ],
        }),
        day,
        o,
      )
      push(
        event(order, 'PaymentRecorded', cashPaymentData(total, { register_shift_id: shift })),
        day,
        o + 1,
      )
      push(event(order, 'OrderClosed', {}), day, o + 1)
    }
    const cashCount = newId()
    push(
      shiftEvent('CashCountRecorded', {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: 100 }],
        counted_cash: 100_000,
      }),
      day,
      300,
    )
    push(
      shiftEvent('ShiftClosed', {
        cash_count_id: cashCount,
        expected_cash: 100_000,
        counted_cash: 100_000,
        variance: 0,
        justification: null,
        other_methods: [],
      }),
      day,
      301,
    )
  }
  return events
}

describe('performance', () => {
  it('the 31-day report with ~1,500 events per day', { timeout: 600_000 }, async () => {
    const m = await createWorld()
    const hub = await m.newHub()
    const events = history()
    let started = performance.now()
    for (let i = 0; i < events.length; i += 500) {
      const r = await m.cloud.receiveEvents(hub.hub, events.slice(i, i + 500))
      expect(r.every((x) => x.status === 'saved')).toBe(true)
    }
    const uploadMs = performance.now() - started
    const from = events[0]?.business_day as string
    const until = events.at(-1)?.business_day as string
    const scope = { restaurantId: hub.restaurantId, hubIds: [hub.hub.id], asOf: null }

    const times: number[] = []
    let last: Awaited<ReturnType<typeof cloudReportData>> | null = null
    for (let run = 0; run < 3; run++) {
      started = performance.now()
      last = await inRestaurant(m.sql, hub.restaurantId, (tx) =>
        cloudReportData(tx, scope, from, until),
      )
      periodReport(last.data, configFrom({}), new Map(), until)
      times.push(performance.now() - started)
    }
    const store = new MemoryStore()
    for (const e of events) store.saveEvent(e, e.id, ordersOf(e))
    started = performance.now()
    const inHub = reportData(store, from, until)
    const config = { sales_by_waiter: 'added_by', rounding_mode: 'half_up' } as const
    const hubReport = report({ ...inHub, config })
    const memoryMs = performance.now() - started

    if (!last) throw new Error('no report')
    expect(last.data).toEqual(inHub)
    expect(report({ ...last.data, config })).toEqual(hubReport)
    console.log(
      `31 días, ${events.length} eventos (${Math.round(events.length / DAYS)} por día): ` +
        `subirlos ${Math.round(uploadMs)} ms; reporte en la nube (PGlite) ` +
        `${times.map((t) => Math.round(t)).join(' / ')} ms en ${last.rounds} vueltas ` +
        `(${last.events} eventos cargados, ${(JSON.stringify(events).length / 1e6).toFixed(1)} MB de JSON); ` +
        `el mismo cálculo en memoria ${Math.round(memoryMs)} ms`,
    )
    expect(Math.min(...times)).toBeLessThan(60_000)
  })
})
