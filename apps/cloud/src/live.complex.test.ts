import { newId, type OrderEvent } from '@pos/core'
import { kitchenTickets, type LocalEvent, openOrders } from '@pos/sync'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  cashPaymentData,
  event,
  itemCopy,
  WAITER,
} from '../../../packages/core/src/testing/factory'
import type { AuthenticatedHub } from './cloud'
import { type LiveFloor, ticketJson } from './live'
import { panelRequest } from './testing/panel'
import { person, publish, signInAs } from './testing/session'
import { createWorld, type TestHub, type World } from './testing/world'

// Complicated orders on the owner's panel (task 1.11c-2): moving dishes between tables, merging and
// separating tables, reopening an account, held and fired courses, partial voids. Each scenario goes
// through the real route and must show what a device with every event shows (the register), and
// the specific facts the owner would look at.

let m: World
let hub: TestHub
let cookie: string

const TODAY = '2026-10-26'
const at = (minute: number) => ({
  business_day: TODAY,
  received_at: `2026-10-26T14:${String(minute).padStart(2, '0')}:00.000Z`,
})

beforeEach(async () => {
  m = await createWorld()
  hub = await m.newHub()
  const owner = person(['remote_access', 'view_reports'], 'Dueña')
  await publish(m, hub, [owner])
  cookie = await signInAs(m, hub, owner)
})

const numbered = (events: readonly OrderEvent[]) =>
  events.map((e, i) => ({ ...e, sequence: i + 1 }))

async function upload(events: readonly OrderEvent[], h: AuthenticatedHub = hub.hub) {
  const r = await m.cloud.receiveEvents(h, events)
  expect(r.every((x) => x.status === 'saved' || x.status === 'already_stored')).toBe(true)
}

/** What a device that has every event shows (all confirmed, in the hub's order). */
function onDevice(events: readonly OrderEvent[]) {
  const locals: LocalEvent[] = [...events]
    .sort((a, b) => a.sequence - b.sequence)
    .map((e, position) => ({ event: e, status: 'confirmed', own: false, position }))
  const orders = openOrders(locals)
  return { orders, tickets: kitchenTickets(locals, orders) }
}

const floor = async () => {
  const r = await panelRequest(m, 'GET', '/v1/panel/floor', { cookie })
  expect(r.status).toBe(200)
  return (await r.json()) as LiveFloor
}
const summary = async () => {
  const r = await panelRequest(m, 'GET', '/v1/panel/summary', { cookie })
  expect(r.status).toBe(200)
  return (await r.json()) as {
    open: { orders: number; tables: number; guests: number; total: number }
  }
}

/** Uploads the events and checks the route against the register; returns the route’s answer. */
async function shown(events: readonly OrderEvent[]) {
  const all = numbered(events)
  await upload(all)
  const body = await floor()
  const device = onDevice(all)
  // JSON in both sides: the route answers JSON.
  expect(body.orders).toEqual(JSON.parse(JSON.stringify(device.orders.map((p) => p.status))))
  expect(body.tickets).toEqual(device.tickets.map(ticketJson))
  return { body, device }
}

const open = (order: string, table: string | null, guests = 2, minute = 0) =>
  event(
    order,
    'OrderOpened',
    { channel: table ? 'dine_in' : 'takeout', table_id: table, guests },
    at(minute),
  )
const add = (order: string, name: string, price: number, fields = {}, minute = 1) => {
  const copy = itemCopy({ name, unit_price: price, ...fields })
  return { copy, event: event(order, 'ItemAdded', copy, at(minute)) }
}
const sendItems = (order: string, items: string[], station: string, number: number, minute = 2) => {
  const ticket = newId()
  return {
    ticket,
    event: event(
      order,
      'ItemsSent',
      { tickets: [{ ticket_id: ticket, station_id: station, item_ids: items }] },
      { ...at(minute), assignments: { ticket_numbers: { [ticket]: number } } },
    ),
  }
}
const moved = (item: ReturnType<typeof itemCopy>, status: 'sent' | 'pending' = 'sent') => ({
  item,
  status,
  voided_quantity: 0,
  added_by: WAITER,
})

const KITCHEN = newId()

describe('moving dishes between tables', () => {
  it('a dish moved to another table shows there, and its card follows it; emptying a table frees it', async () => {
    const [t1, t2] = [newId(), newId()]
    const [a, b] = [newId(), newId()]
    const pasta = add(a, 'Pasta', 30_000)
    const pizza = add(a, 'Pizza', 40_000)
    const wine = add(a, 'Vino', 60_000)
    const salad = add(b, 'Ensalada', 15_000)
    const sentA = sendItems(a, [pasta.copy.item_id, pizza.copy.item_id], KITCHEN, 1)
    const sentB = sendItems(b, [salad.copy.item_id], KITCHEN, 2, 3)
    const base = [
      open(a, t1, 3),
      pasta.event,
      pizza.event,
      wine.event,
      sentA.event,
      open(b, t2, 1, 3),
      salad.event,
      sentB.event,
    ]
    // Pizza (already in the kitchen) goes to table 2.
    const move = event(a, 'ItemsMoved', { target_order_id: b, items: [moved(pizza.copy)] }, at(5))
    const { body } = await shown([...base, move])
    const byId = new Map(body.orders.map((o) => [o.id, o]))
    expect(Object.keys(byId.get(a)?.items ?? {}).sort()).toEqual(
      [pasta.copy.item_id, wine.copy.item_id].sort(),
    )
    expect(byId.get(b)?.items[pizza.copy.item_id]?.status).toBe('sent')
    // The card of A's ticket is split in two: pasta at table 1, pizza at table 2, same ticket number.
    const cards = body.tickets.filter((t) => t.ticket_id === sentA.ticket)
    expect(cards.map((t) => [t.order_id, t.item_ids])).toEqual(
      expect.arrayContaining([
        [a, [pasta.copy.item_id]],
        [b, [pizza.copy.item_id]],
      ]),
    )
    expect(cards).toHaveLength(2)
    expect(new Set(cards.map((t) => t.number))).toEqual(new Set([1]))
    // The dashboard counts both tables, 3 + 1 guests and the net of both.
    expect((await summary()).open).toMatchObject({ orders: 2, tables: 2, guests: 4 })
  })

  it('moving everything out leaves the table empty (not counted as open); the other one grows', async () => {
    const [t1, t2] = [newId(), newId()]
    const [a, b] = [newId(), newId()]
    const pasta = add(a, 'Pasta', 30_000)
    const sentA = sendItems(a, [pasta.copy.item_id], KITCHEN, 1)
    const events = [
      open(a, t1, 2),
      pasta.event,
      sentA.event,
      open(b, t2, 2, 3),
      event(a, 'ItemsMoved', { target_order_id: b, items: [moved(pasta.copy)] }, at(5)),
    ]
    const { body } = await shown(events)
    expect(body.orders.map((o) => o.id).sort()).toEqual([a, b].sort())
    expect(Object.keys(body.orders.find((o) => o.id === a)?.items ?? {})).toEqual([])
    expect(body.tickets.map((t) => [t.order_id, t.item_ids])).toEqual([[b, [pasta.copy.item_id]]])
    // «Mesas abiertas»: the emptied order does not hold its table.
    expect((await summary()).open).toMatchObject({ orders: 1, tables: 1, guests: 2, total: 30_000 })
  })

  it('a dish moved twice (A to B to C) is at C, once, under its first ticket', async () => {
    const [a, b, c] = [newId(), newId(), newId()]
    const [t1, t2, t3] = [newId(), newId(), newId()]
    const soup = add(a, 'Sopa', 12_000)
    const sent = sendItems(a, [soup.copy.item_id], KITCHEN, 4)
    const events = [
      open(a, t1),
      soup.event,
      sent.event,
      open(b, t2, 2, 3),
      open(c, t3, 2, 3),
      event(a, 'ItemsMoved', { target_order_id: b, items: [moved(soup.copy)] }, at(5)),
      event(b, 'ItemsMoved', { target_order_id: c, items: [moved(soup.copy)] }, at(6)),
    ]
    const { body } = await shown(events)
    expect(body.tickets.map((t) => [t.order_id, t.ticket_id, t.item_ids])).toEqual([
      [c, sent.ticket, [soup.copy.item_id]],
    ])
  })
})

describe('merging and separating tables', () => {
  it('a large party takes another table and gives it back', async () => {
    const [t1, t2] = [newId(), newId()]
    const a = newId()
    const pizza = add(a, 'Pizza', 40_000)
    const base = [open(a, t1, 8), pizza.event]
    const merged = await shown([...base, event(a, 'TablesMerged', { table_ids: [t2] }, at(3))])
    expect(merged.body.orders[0]?.mergedTables).toEqual([t2])
    expect((await summary()).open).toMatchObject({ orders: 1, tables: 2, guests: 8 })
    // Separating releases it: the same upload plus the new event.
    const separate = numbered([
      ...base,
      event(a, 'TablesMerged', { table_ids: [t2] }, at(3)),
      event(a, 'TablesSeparated', { table_ids: [t2] }, at(4)),
    ]).at(-1) as OrderEvent
    await upload([separate])
    const after = await floor()
    expect(after.orders[0]?.mergedTables).toEqual([])
    expect((await summary()).open).toMatchObject({ orders: 1, tables: 1 })
  })

  it('merging two orders: the source disappears, its dishes and its card are in the target', async () => {
    const [t1, t2] = [newId(), newId()]
    const [a, b] = [newId(), newId()]
    const pasta = add(a, 'Pasta', 30_000)
    const salad = add(b, 'Ensalada', 15_000)
    const sentB = sendItems(b, [salad.copy.item_id], KITCHEN, 9, 3)
    const events = [
      open(a, t1),
      pasta.event,
      open(b, t2, 2, 3),
      salad.event,
      sentB.event,
      // B joins A.
      event(a, 'OrdersMerged', { source_order_id: b, items: [moved(salad.copy, 'sent')] }, at(6)),
    ]
    const { body } = await shown(events)
    expect(body.orders.map((o) => o.id)).toEqual([a])
    expect(Object.keys(body.orders[0]?.items ?? {}).sort()).toEqual(
      [pasta.copy.item_id, salad.copy.item_id].sort(),
    )
    // B was canceled by the merge, yet its ticket is still in the kitchen, now at A's table.
    expect(body.tickets.map((t) => [t.order_id, t.ticket_id])).toEqual([[a, sentB.ticket]])
  })
})

describe('closing and reopening an account', () => {
  it('a paid and closed order leaves the floor and its card; reopened, it comes back', async () => {
    const t1 = newId()
    const a = newId()
    const pizza = add(a, 'Pizza', 40_000)
    const sent = sendItems(a, [pizza.copy.item_id], KITCHEN, 3)
    const served = event(a, 'ItemServed', { item_ids: [pizza.copy.item_id] }, at(4))
    const pay = event(a, 'PaymentRecorded', cashPaymentData(40_000), at(5))
    const close = event(a, 'OrderClosed', {}, at(6))
    const opening = [open(a, t1), pizza.event, sent.event, served, pay]
    const closed = await shown([...opening, close])
    expect(closed.body.orders).toEqual([])
    expect(closed.body.tickets).toEqual([])
    expect((await summary()).open).toEqual({ orders: 0, tables: 0, guests: 0, total: 0 })

    const reopen = numbered([
      ...opening,
      close,
      event(a, 'OrderReopened', {}, { ...at(8), reason: 'Faltó cobrar una propina' }),
    ]).at(-1) as OrderEvent
    await upload([reopen])
    const back = await floor()
    expect(back.orders.map((o) => o.id)).toEqual([a])
    // Delivered food does not go back to the kitchen.
    expect(back.tickets).toEqual([])
    expect((await summary()).open).toMatchObject({ orders: 1, tables: 1 })
  })

  it('closed, reopened and closed again: closed', async () => {
    const t1 = newId()
    const a = newId()
    const pizza = add(a, 'Pizza', 40_000)
    const events = [
      open(a, t1),
      pizza.event,
      event(a, 'PaymentRecorded', cashPaymentData(40_000), at(5)),
      event(a, 'OrderClosed', {}, at(6)),
      event(a, 'OrderReopened', {}, { ...at(7), reason: 'Error' }),
      event(a, 'OrderClosed', {}, at(8)),
    ]
    const { body } = await shown(events)
    expect(body.orders).toEqual([])
  })

  it('canceled orders disappear and their cards with them', async () => {
    const a = newId()
    const pizza = add(a, 'Pizza', 40_000)
    const sent = sendItems(a, [pizza.copy.item_id], KITCHEN, 3)
    const { body } = await shown([
      open(a, newId()),
      pizza.event,
      sent.event,
      event(a, 'OrderCanceled', {}, { ...at(5), reason: 'Se fueron' }),
    ])
    expect(body.orders).toEqual([])
    expect(body.tickets).toEqual([])
  })
})

describe('courses held and fired', () => {
  it('a held course waits (the table is still taking the order, no card) and fired it becomes sendable', async () => {
    const a = newId()
    const starter = add(a, 'Entrada', 10_000, { course: 'starter' })
    const dessert = add(a, 'Postre', 12_000, { course: 'dessert' })
    const hold = event(a, 'CourseHeld', { course: 'dessert' }, at(1))
    // Held before the dessert is ordered: it arrives held.
    const sentStarter = sendItems(a, [starter.copy.item_id], KITCHEN, 5, 3)
    const held = await shown([
      open(a, newId()),
      hold,
      starter.event,
      dessert.event,
      sentStarter.event,
    ])
    const order = held.body.orders[0]
    expect(order?.items[dessert.copy.item_id]?.status).toBe('held')
    expect(order?.items[starter.copy.item_id]?.status).toBe('sent')
    expect(order?.heldCourses).toEqual(['dessert'])
    // Only the starter is in the kitchen; the held dessert has no card.
    expect(held.body.tickets.map((t) => t.item_ids)).toEqual([[starter.copy.item_id]])
  })

  it('fired, the dessert is pending, then sent: a second card with the next number', async () => {
    const a = newId()
    const t1 = newId()
    const starter = add(a, 'Entrada', 10_000, { course: 'starter' })
    const dessert = add(a, 'Postre', 12_000, { course: 'dessert' })
    const first = sendItems(a, [starter.copy.item_id], KITCHEN, 5, 3)
    const second = sendItems(a, [dessert.copy.item_id], KITCHEN, 6, 9)
    const base = [
      open(a, t1),
      event(a, 'CourseHeld', { course: 'dessert' }, at(1)),
      starter.event,
      dessert.event,
      first.event,
    ]
    const afterFire = [...base, event(a, 'CourseFired', { course: 'dessert' }, at(8))]
    const fired = await shown(afterFire)
    expect(fired.body.orders[0]?.items[dessert.copy.item_id]?.status).toBe('pending')
    expect(fired.body.orders[0]?.heldCourses).toEqual([])
    expect(fired.body.tickets).toHaveLength(1)

    await upload([numbered([...afterFire, second.event]).at(-1) as OrderEvent])
    const sent = await floor()
    expect(sent.tickets.map((t) => [t.number, t.item_ids])).toEqual([
      [5, [starter.copy.item_id]],
      [6, [dessert.copy.item_id]],
    ])
  })
})

describe('partial voids', () => {
  it('voiding part of a dish already in the kitchen keeps its card; voiding it all removes the card', async () => {
    const a = newId()
    const pizzas = add(a, 'Pizza', 40_000, { quantity: 3 })
    const sent = sendItems(a, [pizzas.copy.item_id], KITCHEN, 8)
    const void1 = event(
      a,
      'ItemVoided',
      {
        item_id: pizzas.copy.item_id,
        quantity: 1,
        already_prepared: false,
        ticket_id: sent.ticket,
      },
      { ...at(4), reason: 'Se equivocó', authorized_by_id: WAITER },
    )
    const base = [open(a, newId()), pizzas.event, sent.event]
    const partial = await shown([...base, void1])
    expect(partial.body.orders[0]?.items[pizzas.copy.item_id]).toMatchObject({
      quantity: 3,
      voidedQuantity: 1,
    })
    expect(partial.body.tickets).toHaveLength(1)
    // 2 pizzas to pay: the net follows.
    expect((await summary()).open.total).toBe(80_000)

    const rest = event(
      a,
      'ItemVoided',
      {
        item_id: pizzas.copy.item_id,
        quantity: 2,
        already_prepared: false,
        ticket_id: sent.ticket,
      },
      { ...at(5), reason: 'Se fueron', authorized_by_id: WAITER },
    )
    await upload([numbered([...base, void1, rest]).at(-1) as OrderEvent])
    const all = await floor()
    expect(all.tickets).toEqual([])
    // The order stays open but it does not hold a table with everything voided.
    expect(all.orders.map((o) => o.id)).toEqual([a])
    expect((await summary()).open).toEqual({ orders: 0, tables: 0, guests: 0, total: 0 })
  })

  it('voiding one of two dishes of the same card: the card shrinks, it does not vanish', async () => {
    const a = newId()
    const x = add(a, 'Pasta', 30_000)
    const y = add(a, 'Pizza', 40_000)
    const sent = sendItems(a, [x.copy.item_id, y.copy.item_id], KITCHEN, 2)
    const { body } = await shown([
      open(a, newId()),
      x.event,
      y.event,
      sent.event,
      event(
        a,
        'ItemVoided',
        { item_id: x.copy.item_id, quantity: 1, already_prepared: true, ticket_id: sent.ticket },
        { ...at(4), reason: 'Frío', authorized_by_id: WAITER },
      ),
    ])
    expect(body.tickets.map((t) => t.item_ids)).toEqual([[y.copy.item_id]])
  })
})
