import { orderTotals } from '@pos/core'
import { describe, expect, it, vi } from 'vitest'
import { TIME } from '../floor/testing'
import type { LiveFloor } from './api'
import {
  at,
  cloudNow,
  EMPTY_PLAN,
  type FloorAnswer,
  floorFetcher,
  floorState,
  kitchenOf,
  placeOf,
  visibleOrders,
} from './live-floor'
import { EMPTY } from './poller'
import { NO_NEWS_MS, type Polled } from './summary'
import { floorAnswerOf, KITCHEN, TABLE_1, WAITER } from './testing'

// What «Salón» and «Cocina» of the panel make of the cloud's answer (task 1.11c-2), without
// drawing it: the plan kept between answers, the orders and cards rebuilt, and the clock.

const ZONE = 'America/Bogota'
const MIN = 60_000

/** With plain spaces (the time format uses narrow ones). */
const plain = (t: string | null) => (t ?? '').replace(/\s/g, ' ')

const answered = (data: FloorAnswer, receivedAt = data.server_now): Polled<FloorAnswer> => ({
  data,
  receivedAt,
  failed: false,
  error: null,
  errorKind: null,
})

describe('asking for the floor', () => {
  const answer = (over: Partial<LiveFloor>): LiveFloor => ({ ...floorAnswerOf(), ...over })

  it('the first time without a version; then with the one it has, and the plan stays', async () => {
    const plan = floorAnswerOf().plan
    const floor = vi
      .fn()
      .mockResolvedValueOnce(answer({ plan_version: 'v1', plan }))
      .mockResolvedValueOnce(answer({ plan_version: 'v1', plan: null }))
    const fetch = floorFetcher({ floor })
    expect((await fetch()).plan).toEqual(plan)
    expect((await fetch()).plan).toEqual(plan)
    expect(floor.mock.calls).toEqual([[null], ['v1']])
  })

  it('a new version brings its plan, and it is the one kept', async () => {
    const plan = floorAnswerOf().plan
    const other = { ...plan, zones: [{ id: 'z9', name: 'Bar', level: 2 }] }
    const floor = vi
      .fn()
      .mockResolvedValueOnce(answer({ plan_version: 'v1', plan }))
      .mockResolvedValueOnce(answer({ plan_version: 'v2', plan: other }))
      .mockResolvedValueOnce(answer({ plan_version: 'v2', plan: null }))
    const fetch = floorFetcher({ floor })
    await fetch()
    expect((await fetch()).plan).toEqual(other)
    expect((await fetch()).plan).toEqual(other)
    expect(floor.mock.calls.at(-1)).toEqual(['v2'])
  })

  it('without a catalog in the cloud, or a version it does not have, an empty plan', async () => {
    const floor = vi
      .fn()
      .mockResolvedValueOnce(answer({ plan_version: null, plan: null }))
      .mockResolvedValueOnce(answer({ plan_version: 'v7', plan: null }))
    const fetch = floorFetcher({ floor })
    expect((await fetch()).plan).toEqual(EMPTY_PLAN)
    expect((await fetch()).plan).toEqual(EMPTY_PLAN)
  })
})

describe('the orders and the kitchen cards', () => {
  it('each order with its net, all confirmed', () => {
    const data = floorAnswerOf()
    const orders = visibleOrders(data.orders)
    expect(orders.map((p) => p.total)).toEqual(data.orders.map((o) => orderTotals(o).net))
    expect(orders.every((p) => !p.pendingConfirmation && p.itemsToConfirm.size === 0)).toBe(true)
  })

  it('the cards come back with their order and items, in the cloud’s order', () => {
    const data = floorAnswerOf()
    const orders = visibleOrders(data.orders)
    const cards = kitchenOf(data, orders)
    expect(cards).toHaveLength(1)
    const [card] = cards
    expect(card?.order.status.tableId).toBe(TABLE_1)
    expect(card?.stationId).toBe(KITCHEN)
    expect(card?.number).toBe(12)
    expect(card?.items.map((i) => i.name)).toEqual(['Pizza margarita', 'Limonada'])
    expect(card?.list).toBe(false)
  })

  it('a card of an order or an item that is no longer there is left out', () => {
    const data = floorAnswerOf()
    const ticket = data.tickets[0]
    if (!ticket) throw new Error('no ticket')
    const orders = visibleOrders(data.orders)
    expect(kitchenOf({ ...data, tickets: [{ ...ticket, order_id: 'otro' }] }, orders)).toEqual([])
    expect(kitchenOf({ ...data, tickets: [{ ...ticket, item_ids: ['nada'] }] }, orders)).toEqual([])
  })

  it('the waiters by name, as the floor components look them up', () => {
    expect(placeOf(floorAnswerOf()).staff).toEqual([{ id: WAITER, name: 'Ana Gómez' }])
  })
})

describe('the clock', () => {
  it('the cloud’s time plus what passed on the phone, whatever the phone’s clock says', () => {
    const phoneAhead = Date.parse('2030-01-01T00:00:00.000Z')
    expect(
      cloudNow('2026-10-24T15:20:00.000Z', new Date(phoneAhead).toISOString(), phoneAhead + 90_000),
    ).toBe(Date.parse('2026-10-24T15:21:30.000Z'))
  })

  it('up to date: the times run with that clock', () => {
    const data = floorAnswerOf()
    const received = '2030-01-01T00:00:00.000Z'
    const { state, time } = floorState(answered(data, received), Date.parse(received) + MIN, ZONE)
    expect(state.kind).toBe('up_to_date')
    expect(time).toEqual({ now: Date.parse(data.server_now) + MIN, frozenAt: null })
  })

  it('without news from the hub, even between answers, the times stop at the last news', () => {
    const data = floorAnswerOf()
    const received = data.server_now
    const later = Date.parse(received) + NO_NEWS_MS + MIN
    const { state, time } = floorState(answered(data, received), later, ZONE)
    expect(state.kind).toBe('no_news')
    expect(plain(state.text)).toBe('Sin noticias del restaurante desde las 10:20 a. m.')
    expect(time.now).toBe(Date.parse(data.local.last_seen_at ?? ''))
    expect(plain(time.frozenAt)).toBe('10:20 a. m.')
    expect(plain(at('25 min', time))).toBe('25 min a las 10:20 a. m.')
  })

  it('without internet: they stop at the last answer', () => {
    const data = floorAnswerOf()
    const polled = { ...answered(data), failed: true, error: 'x', errorKind: 'offline' }
    const { state, time } = floorState(polled, Date.parse(data.server_now) + 10 * MIN, ZONE)
    expect(state.kind).toBe('offline')
    expect(time.now).toBe(Date.parse(data.server_now))
    expect(plain(time.frozenAt)).toBe('10:20 a. m.')
  })

  it('before the first answer, the phone’s own clock and nothing frozen', () => {
    const { state, time } = floorState(EMPTY, Date.parse(TIME), ZONE)
    expect(state.kind).toBe('nothing_yet')
    expect(time).toEqual({ now: Date.parse(TIME), frozenAt: null })
    expect(at('5 min', time)).toBe('5 min')
  })
})
