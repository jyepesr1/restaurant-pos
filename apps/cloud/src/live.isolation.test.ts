import { newId, type OrderEvent } from '@pos/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { event, itemCopy } from '../../../packages/core/src/testing/factory'
import type { AlertsAnswer, RegisterAnswer } from './panel'
import { panelRequest } from './testing/panel'
import { person, publish, signInAs } from './testing/session'
import { createWorld, type TestHub, type World } from './testing/world'

// Two restaurants that happen to use the very same ids (the same order, shift and event ids: a
// restored backup, a copied seed, a hostile hub) must still see only their own floor, register and
// alerts on every new route of the panel (task 1.11c-2).

let m: World
let a: TestHub
let b: TestHub

const SHIFT = newId()
const ORDER = newId()
const TABLE = newId()
const REGISTER = newId()
const USER = newId()

beforeEach(async () => {
  m = await createWorld()
  ;[a, b] = [await m.newHub(), await m.newHub()]
})

/** The same ids for both restaurants; only `guests` and the cash count tell them apart. */
function story(guests: number, counted: number): OrderEvent[] {
  const day = { business_day: '2026-10-26', received_at: '2026-10-26T14:00:00.000Z' }
  const shift = {
    ...day,
    aggregate_type: 'register_shift' as const,
    user_id: USER,
    device_id: REGISTER,
  }
  const count = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const copy = itemCopy({
    item_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    name: 'Pizza',
    unit_price: 40_000,
  })
  const events = [
    event(SHIFT, 'ShiftOpened', { register_id: REGISTER, base: 100_000 }, shift),
    event(ORDER, 'OrderOpened', { channel: 'dine_in', table_id: TABLE, guests }, day),
    event(ORDER, 'ItemAdded', copy, day),
    // Sent before voiding (an item not sent is removed, not voided: the hub would refuse it).
    event(
      ORDER,
      'ItemsSent',
      { tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [copy.item_id] }] },
      day,
    ),
    event(
      ORDER,
      'ItemVoided',
      { item_id: copy.item_id, quantity: 1, already_prepared: false, ticket_id: null },
      { ...day, reason: guests === 2 ? 'Cambio de idea' : 'Se equivocó', authorized_by_id: USER },
    ),
    event(ORDER, 'ItemAdded', itemCopy({ unit_price: 40_000 }), day),
    event(
      SHIFT,
      'CashCountRecorded',
      {
        cash_count_id: count,
        tally: [{ value: 1000, quantity: counted / 1000 }],
        counted_cash: counted,
      },
      shift,
    ),
    event(
      SHIFT,
      'ShiftClosed',
      {
        cash_count_id: count,
        expected_cash: 100_000,
        counted_cash: counted,
        variance: counted - 100_000,
        justification: 'Diferencia',
        other_methods: [],
      },
      shift,
    ),
  ]
  return events.map((e, i) => ({ ...e, id: ids[i] as string, sequence: i + 1 }))
}
// The same event ids in both restaurants.
const ids = Array.from({ length: 8 }, () => newId())

const get = async <T>(cookie: string, route: string) => {
  const r = await panelRequest(m, 'GET', route, { cookie })
  expect(r.status, route).toBe(200)
  return (await r.json()) as T
}

describe('the same ids in two restaurants', () => {
  it('both store their copy, and every new route shows each one its own', async () => {
    for (const [h, guests, counted] of [
      [a, 2, 95_000],
      [b, 6, 100_000 + 7_000],
    ] as const) {
      const r = await m.cloud.receiveEvents(h.hub, story(guests, counted))
      expect(r.map((x) => x.status)).toEqual(Array(8).fill('saved'))
    }
    const [ua, ub] = [
      person(['remote_access', 'view_reports']),
      person(['remote_access', 'view_reports']),
    ]
    await publish(m, a, [ua])
    await publish(m, b, [ub])
    const [ca, cb] = [await signInAs(m, a, ua), await signInAs(m, b, ub)]

    for (const [cookie, guests, reason, variance] of [
      [ca, 2, 'Cambio de idea', -5_000],
      [cb, 6, 'Se equivocó', 7_000],
    ] as const) {
      const floor = await get<{ orders: { guests: number }[] }>(cookie, '/v1/panel/floor')
      expect(floor.orders.map((o) => o.guests)).toEqual([guests])
      const reg = await get<RegisterAnswer>(cookie, '/v1/panel/register')
      expect(reg.open).toEqual([])
      expect(reg.closed.map((c) => c.closed?.variance)).toEqual([variance])
      const al = await get<AlertsAnswer>(cookie, '/v1/panel/alerts')
      expect(al.alerts.map((x) => [x.type, x.reason]).sort()).toEqual(
        [
          ['item_voided', reason],
          ['register_variance', 'Diferencia'],
        ].sort(),
      )
      const summary = await get<{ open: { guests: number }; alerts: number }>(
        cookie,
        '/v1/panel/summary',
      )
      expect(summary.open.guests).toBe(guests)
      expect(summary.alerts).toBe(2)
    }
  })

  it('a session of one restaurant never reads the other’s rows, even holding its ids', async () => {
    await m.cloud.receiveEvents(a.hub, story(2, 95_000))
    const ub = person(['remote_access', 'view_reports'])
    await publish(m, b, [ub])
    const cb = await signInAs(m, b, ub)
    // B has not uploaded anything: it sees nothing of A, though the ids are the same.
    expect((await get<{ orders: unknown[] }>(cb, '/v1/panel/floor')).orders).toEqual([])
    expect((await get<RegisterAnswer>(cb, '/v1/panel/register')).closed).toEqual([])
    expect((await get<AlertsAnswer>(cb, '/v1/panel/alerts')).alerts).toEqual([])
  })
})
