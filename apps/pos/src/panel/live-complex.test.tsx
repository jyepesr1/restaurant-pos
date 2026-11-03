import { newId } from '@pos/core'
import { kitchenTickets, type LocalEvent, openOrders } from '@pos/sync'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { inOrder, itemData, local, opening } from '../floor/testing'
import type { FloorAnswer } from './live-floor'
import type { Polled } from './summary'
import { floorAnswerOf, KITCHEN, TABLE_1, TABLE_2, TERRACE_TABLE } from './testing'

// Complicated orders as the owner reads them (task 1.11c-2): the cloud’s answer for tables merged
// and separated, dishes moved between tables, held courses, partial voids and reopened accounts,
// rendered in «Salón» and «Cocina». The answers are built with the devices’ own projections and
// sent through JSON, as the route does.

vi.mock('../ui/theme', () => ({
  useTheme: () => ({ theme: 'system', dark: false, select: () => {} }),
}))
const { FloorView, OrderDetail } = await import('./PanelFloor')
const { KitchenView } = await import('./PanelKitchen')
const { placeOf, visibleOrders } = await import('./live-floor')

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const ZONE = 'America/Bogota'

/** The cloud’s floor for those events (all confirmed), through JSON. */
function answerFor(locals: readonly LocalEvent[]): FloorAnswer {
  const base = floorAnswerOf()
  const ordered = inOrder(locals)
  const orders = openOrders(ordered)
  const tickets = kitchenTickets(ordered, orders)
  return JSON.parse(
    JSON.stringify({
      ...base,
      orders: orders.map((p) => p.status),
      tickets: tickets.map((t) => ({
        key: t.key,
        ticket_id: t.ticketId,
        order_id: t.order.status.id,
        station_id: t.stationId,
        number: t.number,
        sent_at: t.sentAt,
        item_ids: t.items.map((i) => i.id),
        ready: t.list,
      })),
    }),
  ) as FloorAnswer
}

const polled = (data: FloorAnswer): Polled<FloorAnswer> => ({
  data,
  receivedAt: data.server_now,
  failed: false,
  error: null,
  errorKind: null,
})
const nowOf = (data: FloorAnswer) => Date.parse(data.server_now)

const list = (data: FloorAnswer) =>
  text(
    renderToStaticMarkup(
      <FloorView
        polled={polled(data)}
        deviceNow={nowOf(data)}
        timeZone={ZONE}
        initialView="list"
      />,
    ),
  )
const kitchen = (data: FloorAnswer) =>
  text(
    renderToStaticMarkup(
      <KitchenView polled={polled(data)} deviceNow={nowOf(data)} timeZone={ZONE} />,
    ),
  )
const detail = (data: FloorAnswer, id: string) => {
  const order = visibleOrders(data.orders).find((p) => p.status.id === id)
  if (!order) throw new Error('no order')
  return text(
    renderToStaticMarkup(
      <OrderDetail
        order={order}
        place={placeOf(data)}
        users={data.users}
        time={{ now: nowOf(data), frozenAt: null }}
        timeZone={ZONE}
        titled
      />,
    ),
  )
}

const WAITER_ID = newId()
/** Dishes added by the same waiter that the move names (the copy has to match). */
const added = (order: string, item: ReturnType<typeof itemData>) =>
  local('ItemAdded', order, item, 'confirmed', { user_id: WAITER_ID })
const opened = (order: string, table: string, guests = 2) =>
  local('OrderOpened', order, { ...opening, table_id: table, guests })
/** What travels when a dish moves: its copy, without the catalog fields of «ItemAdded». */
const moved = (item: ReturnType<typeof itemData>, status: 'sent' | 'pending' = 'sent') => ({
  item: (({ catalog_version: _c, price_channel_id: _p, ...copy }) => copy)(item),
  status,
  voided_quantity: 0,
  added_by: WAITER_ID,
})

describe('tables merged and separated', () => {
  it('the plan joins the tables of one order, and separating them frees the second', () => {
    const a = newId()
    const base = [opened(a, TABLE_1, 8), local('ItemAdded', a, itemData({ name: 'Parrilla' }))]
    const merged = answerFor([...base, local('TablesMerged', a, { table_ids: [TABLE_2] })])
    const t = list(merged)
    expect(t).toContain('1 Tomando pedido 20 min · Unida con 2')
    expect(t).toContain('2 Tomando pedido Unida a la mesa 1')
    expect(detail(merged, a)).toContain('Mesa 1 + 2')
    const separated = answerFor([
      ...base,
      local('TablesMerged', a, { table_ids: [TABLE_2] }),
      local('TablesSeparated', a, { table_ids: [TABLE_2] }),
    ])
    expect(list(separated)).not.toMatch(/Unida/i)
    expect(list(separated)).toContain('2 Libre')
  })
})

describe('dishes moved between tables', () => {
  it('the table left empty reads «Libre», the other grows, and the card follows the dish', () => {
    const [a, b] = [newId(), newId()]
    const pasta = itemData({ name: 'Pasta', unit_price: 30_000 })
    const ticket = newId()
    const sent = local('ItemsSent', a, {
      tickets: [{ ticket_id: ticket, station_id: KITCHEN, item_ids: [pasta.item_id] }],
    })
    const numbered = {
      ...sent,
      event: { ...sent.event, assignments: { ticket_numbers: { [ticket]: 8 } } },
    } as LocalEvent
    const data = answerFor([
      opened(a, TABLE_1),
      added(a, pasta),
      numbered,
      opened(b, TERRACE_TABLE, 3),
      local('ItemsMoved', a, { target_order_id: b, items: [moved(pasta)] }, 'confirmed', {
        related: [b],
      }),
    ])
    const floor = list(data)
    // «Mesa 1» is free again; the terrace table has the pasta.
    expect(floor).toContain('1 Libre')
    expect(floor).toContain('3 En preparación')
    // The kitchen shows ticket 8 at the new table.
    const k = kitchen(data)
    expect(k).toContain('#8')
    expect(k).toContain('Mesa 3')
    expect(k).not.toContain('Mesa 1')
    expect(detail(data, b)).toContain('Pasta')
    expect(detail(data, a)).toContain('Sin productos todavía')
  })

  it('a ticket split across two tables is two cards with the same number', () => {
    const [a, b] = [newId(), newId()]
    const pasta = itemData({ name: 'Pasta', unit_price: 30_000 })
    const pizza = itemData({ name: 'Pizza', unit_price: 40_000 })
    const ticket = newId()
    const sent = local('ItemsSent', a, {
      tickets: [
        { ticket_id: ticket, station_id: KITCHEN, item_ids: [pasta.item_id, pizza.item_id] },
      ],
    })
    const numbered = {
      ...sent,
      event: { ...sent.event, assignments: { ticket_numbers: { [ticket]: 12 } } },
    } as LocalEvent
    const data = answerFor([
      opened(a, TABLE_1),
      added(a, pasta),
      added(a, pizza),
      numbered,
      opened(b, TABLE_2),
      local('ItemsMoved', a, { target_order_id: b, items: [moved(pizza)] }, 'confirmed', {
        related: [b],
      }),
    ])
    const k = kitchen(data)
    expect(k.match(/#12/g)).toHaveLength(2)
    expect(k).toContain('Mesa 1')
    expect(k).toContain('Mesa 2')
  })
})

describe('held courses', () => {
  it('a held course reads «En espera» and the table «Tomando pedido»; fired, it reads «Sin enviar»', () => {
    const a = newId()
    const starter = itemData({ name: 'Entrada', course: 'starter' })
    const dessert = itemData({ name: 'Postre', course: 'dessert' })
    const base = [
      opened(a, TABLE_1),
      local('CourseHeld', a, { course: 'dessert' }),
      local('ItemAdded', a, starter),
      local('ItemAdded', a, dessert),
    ]
    const held = answerFor(base)
    expect(detail(held, a)).toContain('En espera')
    expect(list(held)).toContain('1 Tomando pedido')
    const fired = answerFor([...base, local('CourseFired', a, { course: 'dessert' })])
    expect(detail(fired, a)).not.toContain('En espera')
  })
})

describe('partial voids', () => {
  it('voided units leave the count, the total and the kitchen card, and are listed apart', () => {
    const a = newId()
    const pizzas = itemData({ name: 'Pizza', unit_price: 40_000, quantity: 3 })
    const ticket = newId()
    const sent = local('ItemsSent', a, {
      tickets: [{ ticket_id: ticket, station_id: KITCHEN, item_ids: [pizzas.item_id] }],
    })
    const data = answerFor([
      opened(a, TABLE_1),
      local('ItemAdded', a, pizzas),
      sent,
      local(
        'ItemVoided',
        a,
        { item_id: pizzas.item_id, quantity: 1, already_prepared: false, ticket_id: ticket },
        'confirmed',
        { reason: 'Se equivocó' },
      ),
    ])
    const t = detail(data, a)
    expect(t).toContain('2 × Pizza')
    expect(t).toContain('Anulados')
    expect(t).toContain('1 × Pizza')
    expect(kitchen(data)).toContain('2')
  })
})

describe('a reopened account', () => {
  it('is on the floor again like any other order', () => {
    const a = newId()
    const data = answerFor([
      opened(a, TABLE_1),
      local('ItemAdded', a, itemData({ name: 'Café' })),
      local('OrderClosed', a, {}),
      local('OrderReopened', a, {}, 'confirmed', { reason: 'Faltó cobrar' }),
    ])
    expect(list(data)).toContain('1 Tomando pedido 20 min')
    expect(data.orders.map((o) => o.id)).toEqual([a])
  })
})

describe('an order whose table is not on the plan', () => {
  // The catalog snapshot can lag behind the orders (a table deleted, a plan not uploaded yet): the
  // owner must not lose sight of an open order because the plan does not know its table.
  it('is still listed in «Salón»', () => {
    const a = newId()
    const ghostTable = newId()
    const data = answerFor([
      opened(a, ghostTable, 4),
      added(a, itemData({ name: 'Costillas', unit_price: 55_000 })),
    ])
    const floor = list(data)
    expect(floor).toContain('$55.000')
  })

  it('is still on its kitchen card, with a name instead of a blank', () => {
    const a = newId()
    const ghostTable = newId()
    const dish = itemData({ name: 'Costillas', unit_price: 55_000 })
    const ticket = newId()
    const data = answerFor([
      opened(a, ghostTable, 4),
      added(a, dish),
      local('ItemsSent', a, {
        tickets: [{ ticket_id: ticket, station_id: KITCHEN, item_ids: [dish.item_id] }],
      }),
    ])
    expect(kitchen(data)).toContain('Costillas')
  })
})
