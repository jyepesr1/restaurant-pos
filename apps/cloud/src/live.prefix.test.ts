import { newId, type OrderEvent } from '@pos/core'
import { kitchenTickets, type LocalEvent, openOrders } from '@pos/sync'
import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../packages/core/src/testing/factory'
import { actionArb } from '../../../packages/core/src/testing/simulator'
import { buildHistory, type HistoryPlan } from '../../../packages/sync/src/testing/histories'
import { type AuthenticatedHub, inRestaurant } from './cloud'
import { LIVE_WINDOW_DAYS, liveOrders, ticketJson } from './live'
import { addDays } from './panel'
import { hubsOfLocation, type Scope } from './reports'
import { createWorld, type TestHub, type World } from './testing/world'

// The hub dies half way and restarts (task 1.11c-2): whatever part of the history the cloud has
// is shown exactly as a device with that part would show it, nothing is invented while a piece is
// missing, and once the hub resends everything (with repeats) the floor is the full one.

let m: World

beforeEach(async () => {
  m = await createWorld()
})

const TODAY = '2026-10-26'

const plan = fc.record<HistoryPlan>({
  actions: fc.array(actionArb, { minLength: 10, maxLength: 80, size: 'max' }),
  days: fc.array(fc.nat(2), { minLength: 1, maxLength: 150 }),
  closes: fc.tuple(fc.boolean(), fc.boolean()),
  tips: fc.tuple(fc.constantFrom(0, 1_000), fc.constantFrom(0, 2_500)),
})

function onDevice(events: readonly OrderEvent[]) {
  const locals: LocalEvent[] = [...events]
    .sort((a, b) => a.sequence - b.sequence)
    .map((e, position) => ({ event: e, status: 'confirmed', own: false, position }))
  const orders = openOrders(locals)
  return { orders, tickets: kitchenTickets(locals, orders) }
}

async function upload(h: AuthenticatedHub, events: readonly OrderEvent[]) {
  for (let i = 0; i < events.length; i += 500) {
    const r = await m.cloud.receiveEvents(h, events.slice(i, i + 500))
    expect(r.every((x) => x.status === 'saved' || x.status === 'already_stored')).toBe(true)
  }
}

async function fromCloud(h: TestHub) {
  const scope: Scope = {
    restaurantId: h.restaurantId,
    hubIds: await inRestaurant(m.sql, h.restaurantId, (tx) =>
      hubsOfLocation(tx, h.restaurantId, h.hub.locationId),
    ),
  }
  return inRestaurant(m.sql, h.restaurantId, (tx) =>
    // The histories are dated 2026-10-23..25: the whole window is wide enough.
    liveOrders(tx, scope, addDays(TODAY, -LIVE_WINDOW_DAYS)),
  )
}

describe('a hub that uploads in pieces', () => {
  it('a prefix shows what a device with that prefix shows; the rest, out of order and repeated, completes it', async () => {
    let withOrders = 0
    await fc.assert(
      fc.asyncProperty(plan, fc.nat(1000), fc.nat(1000), async (p, a, b) => {
        const history = buildHistory(p)
        const all = history.events
        const k = a % (all.length + 1)
        const j = k + (b % (all.length - k + 1))
        const [prefix, middle, tail] = [all.slice(0, k), all.slice(k, j), all.slice(j)]
        const target = await m.newHub()

        await upload(target.hub, prefix)
        const early = await fromCloud(target)
        const expectedEarly = onDevice(prefix)
        expect(early.orders).toEqual(expectedEarly.orders)
        expect(early.tickets.map(ticketJson)).toEqual(expectedEarly.tickets.map(ticketJson))
        if (early.orders.length > 0) withOrders++

        // The tail arrives before the middle (a gap): nothing is shown without its opening.
        await upload(target.hub, tail)
        const gap = await fromCloud(target)
        const received = new Set([...prefix, ...tail].map((e) => e.id))
        const opened = new Set(
          all
            .filter((e) => e.type === 'OrderOpened' && received.has(e.id))
            .map((e) => e.aggregate_id),
        )
        for (const o of gap.orders) expect(opened.has(o.status.id)).toBe(true)
        for (const t of gap.tickets) expect(opened.has(t.order.status.id)).toBe(true)

        // The restarted hub resends from the middle and also repeats the prefix.
        await upload(target.hub, [...middle, ...prefix.slice(-3), ...tail.slice(0, 2)])
        const done = await fromCloud(target)
        const expected = onDevice(all)
        expect(done.orders).toEqual(expected.orders)
        expect(done.tickets.map(ticketJson)).toEqual(expected.tickets.map(ticketJson))
      }),
      { seed: 20_261_103, numRuns: 40 },
    )
    expect(withOrders).toBeGreaterThan(5)
  })
})

describe('the 31-day window with random lifecycles', () => {
  // Orders opened, closed, reopened and canceled at random days: the cloud shows exactly those that
  // a device shows and whose last open/reopen is within the window, by a model that does not use
  // the cloud’s query.
  const lifecycle = fc.record({
    opened: fc.integer({ min: 0, max: 60 }),
    // Days after the opening for each further step; the order closes, may reopen, and may end canceled.
    steps: fc.array(fc.tuple(fc.constantFrom('close', 'reopen', 'cancel'), fc.nat(10)), {
      maxLength: 4,
    }),
  })

  it('matches a model of “last lifecycle event within the window”', async () => {
    let inside = 0
    let outside = 0
    await fc.assert(
      fc.asyncProperty(fc.array(lifecycle, { minLength: 1, maxLength: 8 }), async (list) => {
        const target = await m.newHub()
        const events: OrderEvent[] = []
        const lastDay = new Map<string, { day: string; open: boolean }>()
        for (const l of list) {
          const order = newId()
          const dayOf = (n: number) => addDays(TODAY, -(60 - n))
          let at = l.opened
          const stamp = (n: number) => ({
            business_day: dayOf(Math.min(n, 60)),
            received_at: `${dayOf(Math.min(n, 60))}T15:00:00.000Z`,
          })
          const copy = itemCopy({ unit_price: 10_000 })
          events.push(
            event(
              order,
              'OrderOpened',
              { channel: 'takeout', table_id: null, guests: 1 },
              stamp(at),
            ),
            event(order, 'ItemAdded', copy, stamp(at)),
          )
          let state: 'open' | 'closed' | 'canceled' = 'open'
          let paid = false
          lastDay.set(order, { day: stamp(at).business_day, open: true })
          for (const [step, gap] of l.steps) {
            at += gap
            const when = stamp(at)
            if (step === 'close' && state === 'open') {
              if (!paid) events.push(event(order, 'PaymentRecorded', cashPaymentData(10_000), when))
              paid = true
              events.push(event(order, 'OrderClosed', {}, when))
              state = 'closed'
              lastDay.set(order, { day: when.business_day, open: false })
            } else if (step === 'reopen' && state === 'closed') {
              events.push(event(order, 'OrderReopened', {}, { ...when, reason: 'Faltó algo' }))
              state = 'open'
              lastDay.set(order, { day: when.business_day, open: true })
            } else if (step === 'cancel' && state === 'open') {
              events.push(event(order, 'OrderCanceled', {}, { ...when, reason: 'Se fueron' }))
              state = 'canceled'
              lastDay.set(order, { day: when.business_day, open: false })
            }
          }
        }
        const numbered = events.map((e, i) => ({ ...e, sequence: i + 1 }))
        await upload(target.hub, numbered)
        const live = await fromCloud(target)
        const since = addDays(TODAY, -LIVE_WINDOW_DAYS)
        const expected = onDevice(numbered).orders.filter((o) => {
          const last = lastDay.get(o.status.id)
          return last?.open && last.day >= since
        })
        expect(live.orders.map((o) => o.status.id).sort()).toEqual(
          expected.map((o) => o.status.id).sort(),
        )
        for (const o of onDevice(numbered).orders) {
          const last = lastDay.get(o.status.id)
          if (last && last.day >= since) inside++
          else outside++
        }
      }),
      { seed: 20_261_103, numRuns: 30 },
    )
    expect(inside).toBeGreaterThan(5)
    expect(outside).toBeGreaterThan(5)
  })
})
