import { newId, type OrderState } from '@pos/core'
import type { LocalEvent } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { movedFrom } from './order'
import { occupiesTable, openOrders as project, tableStatus, type VisibleOrder } from './projection'
import { inOrder, itemData, local, opening } from './testing'
import { kitchenTickets } from './tickets'

// Task 1.5 in the device's order list and in «Pedidos en cocina»: a dish that moves from one
// order to another shows in the target and not in the source, also if the move is still
// pending (offline). Merged tables all take the same order.

const KITCHEN = newId()
const openOrders = (l: LocalEvent[]) => project(inOrder(l))
const idOf = (l: LocalEvent) => (l.event.data as { item_id: string }).item_id
const ofOrder = (v: VisibleOrder[], id: string) => v.find((p) => p.status.id === id)

/** Source with a sent dish; target open; and the move event as the screen builds it. */
function scenario(options: { moveStatus?: 'confirmed' | 'pending' | 'rejected' } = {}) {
  const source = newId()
  const target = newId()
  const a = local('ItemAdded', source, itemData({ name: 'Tagliata', quantity: 2 }))
  const b = local('ItemAdded', source, itemData({ name: 'Risotto' }))
  const ticket = newId()
  const base = [
    local('OrderOpened', source, { ...opening, table_id: newId() }),
    local('OrderOpened', target, { ...opening, table_id: newId() }),
    a,
    b,
    local('ItemsSent', source, {
      tickets: [{ ticket_id: ticket, station_id: KITCHEN, item_ids: [idOf(a), idOf(b)] }],
    }),
  ] as LocalEvent[]
  const before = openOrders(base)
  const itemA = ofOrder(before, source)?.status.items[idOf(a)]
  if (!itemA) throw new Error('no item')
  const move = local(
    'ItemsMoved',
    source,
    { target_order_id: target, items: [movedFrom(itemA)] },
    options.moveStatus ?? 'confirmed',
    { related: [target] },
  )
  return { source, target, a, b, ticket, base, move, all: [...base, move] as LocalEvent[] }
}

describe('openOrders with moved products', () => {
  it('the dish shows in the target and not in the source', () => {
    const e = scenario()
    const v = openOrders(e.all)
    expect(Object.keys(ofOrder(v, e.source)?.status.items ?? {})).toEqual([idOf(e.b)])
    expect(Object.keys(ofOrder(v, e.target)?.status.items ?? {})).toEqual([idOf(e.a)])
    expect(ofOrder(v, e.target)?.status.items[idOf(e.a)]).toMatchObject({
      status: 'sent',
      quantity: 2,
    })
  })

  it('the totals are split and their sum does not change', () => {
    const e = scenario()
    const before = openOrders(e.base)
    const after = openOrders(e.all)
    const sum = (v: VisibleOrder[]) => v.reduce((n, p) => n + p.total, 0)
    expect(sum(after)).toBe(sum(before))
    expect(ofOrder(after, e.target)?.total).toBeGreaterThan(0)
  })

  it('pending (offline): it already shows moved, and both orders stay «por confirmar»', () => {
    const e = scenario({ moveStatus: 'pending' })
    const v = openOrders(e.all)
    expect(ofOrder(v, e.source)?.status.items[idOf(e.a)]).toBeUndefined()
    expect(ofOrder(v, e.target)?.status.items[idOf(e.a)]).toBeDefined()
    expect(ofOrder(v, e.source)?.pendingConfirmation).toBe(true)
    expect(ofOrder(v, e.target)?.pendingConfirmation).toBe(true)
  })

  it('a move rejected by the hub changes nothing: the dish stays in the source', () => {
    const e = scenario({ moveStatus: 'rejected' })
    const v = openOrders(e.all)
    expect(ofOrder(v, e.source)?.status.items[idOf(e.a)]).toBeDefined()
    expect(ofOrder(v, e.target)?.status.items).toEqual({})
  })

  it('opening the target and moving, both pending: the new order already shows with the dish', () => {
    const source = newId()
    const target = newId()
    const a = local('ItemAdded', source, itemData())
    const base = [
      local('OrderOpened', source, { ...opening, table_id: newId() }),
      a,
      local('ItemsSent', source, {
        tickets: [{ ticket_id: newId(), station_id: KITCHEN, item_ids: [idOf(a)] }],
      }),
    ] as LocalEvent[]
    const item = ofOrder(openOrders(base), source)?.status.items[idOf(a)]
    if (!item) throw new Error('no item')
    const batch = [
      ...base,
      local('OrderOpened', target, { ...opening, table_id: newId() }, 'pending'),
      local(
        'ItemsMoved',
        source,
        { target_order_id: target, items: [movedFrom(item)] },
        'pending',
        {
          related: [target],
        },
      ),
    ] as LocalEvent[]
    const v = openOrders(batch)
    expect(ofOrder(v, target)?.status.items[idOf(a)]).toBeDefined()
    expect(ofOrder(v, source)?.status.items).toEqual({})
  })

  it('a source left without products stays open but does not occupy its table; the target does', () => {
    const e = scenario()
    const everything = {
      ...e.move,
      event: {
        ...e.move.event,
        data: {
          target_order_id: e.target,
          items: [e.a, e.b].map((l) =>
            movedFrom(ofOrder(openOrders(e.base), e.source)?.status.items[idOf(l)] as never),
          ),
        },
      },
    } as LocalEvent
    const v = openOrders([...e.base, everything])
    const source = ofOrder(v, e.source)
    expect(source?.status.status).toBe('open')
    expect(Object.keys(source?.status.items ?? {})).toEqual([])
    expect(occupiesTable((source as VisibleOrder).status)).toBe(false)
    expect(occupiesTable(ofOrder(v, e.target)?.status as never)).toBe(true)
    expect(tableStatus([source as VisibleOrder])).toBe('free')
  })

  it('the move does not duplicate the target order nor leave foreign events in a third one', () => {
    const e = scenario()
    const thirdOne = newId()
    const v = openOrders([
      ...e.all,
      local('OrderOpened', thirdOne, { ...opening, table_id: newId() }),
    ])
    expect(v.map((p) => p.status.id).sort()).toEqual([e.source, e.target, thirdOne].sort())
    expect(ofOrder(v, thirdOne)?.status.items).toEqual({})
  })

  it('round trip: the dish returns to the source', () => {
    const e = scenario()
    const inTarget = ofOrder(openOrders(e.all), e.target)?.status.items[idOf(e.a)]
    if (!inTarget) throw new Error('no item')
    const runOnce = local(
      'ItemsMoved',
      e.target,
      { target_order_id: e.source, items: [movedFrom(inTarget)] },
      'confirmed',
      { related: [e.source] },
    )
    const v = openOrders([...e.all, runOnce] as LocalEvent[])
    expect(ofOrder(v, e.source)?.status.items[idOf(e.a)]).toBeDefined()
    expect(ofOrder(v, e.target)?.status.items[idOf(e.a)]).toBeUndefined()
  })
})

describe('kitchenTickets with a moved dish', () => {
  it('the ticket splits into two cards: what stayed in the source and what reached the target', () => {
    const e = scenario()
    const locals = inOrder(e.all)
    const orders = project(locals)
    const c = kitchenTickets(locals, orders)
    expect(c).toHaveLength(2)
    expect(c.every((x) => x.ticketId === e.ticket)).toBe(true)
    const byOrder = Object.fromEntries(
      c.map((x) => [x.order.status.id, x.items.map((i) => i.name)]),
    )
    expect(byOrder).toEqual({ [e.source]: ['Risotto'], [e.target]: ['Tagliata'] })
  })

  it('each card has a different key (ticket + order)', () => {
    const e = scenario()
    const locals = inOrder(e.all)
    const c = kitchenTickets(locals, project(locals))
    expect(new Set(c.map((x) => x.key)).size).toBe(c.length)
    expect(c.map((x) => x.key).sort()).toEqual(
      [`${e.ticket}:${e.source}`, `${e.ticket}:${e.target}`].sort(),
    )
  })

  it('without moving, a single card with key ticket:order', () => {
    const e = scenario()
    const locals = inOrder(e.base)
    const c = kitchenTickets(locals, project(locals))
    expect(c).toHaveLength(1)
    expect(c[0]?.key).toBe(`${e.ticket}:${e.source}`)
    expect(c[0]?.items.map((i) => i.name)).toEqual(['Tagliata', 'Risotto'])
  })

  it('if everything is moved, only the target card remains', () => {
    const e = scenario()
    const base = project(inOrder(e.base))
    const source = ofOrder(base, e.source)
    const everything = local(
      'ItemsMoved',
      e.source,
      {
        target_order_id: e.target,
        items: [e.a, e.b].map((l) => movedFrom(source?.status.items[idOf(l)] as never)),
      },
      'confirmed',
      { related: [e.target] },
    )
    const locals = inOrder([...e.base, everything] as LocalEvent[])
    const c = kitchenTickets(locals, project(locals))
    expect(c).toHaveLength(1)
    expect(c[0]?.order.status.id).toBe(e.target)
    expect(c[0]?.items).toHaveLength(2)
  })

  it('pending offline: the card already follows the dish to the target', () => {
    const e = scenario({ moveStatus: 'pending' })
    const locals = inOrder(e.all)
    const c = kitchenTickets(locals, project(locals))
    expect(c.find((x) => x.order.status.id === e.target)?.items.map((i) => i.name)).toEqual([
      'Tagliata',
    ])
  })

  it('a dish delivered in the target leaves the kitchen; the one still in the source stays', () => {
    const e = scenario()
    const locals = inOrder([
      ...e.all,
      local('ItemServed', e.target, { item_ids: [idOf(e.a)] }),
    ] as LocalEvent[])
    const c = kitchenTickets(locals, project(locals))
    expect(c.map((x) => x.order.status.id)).toEqual([e.source])
  })

  it('a canceled order no longer shows in the kitchen', () => {
    const e = scenario()
    const locals = inOrder([
      ...e.all,
      local('OrderCanceled', e.target, {}, 'confirmed', { reason: 'x' }),
    ] as LocalEvent[])
    const c = kitchenTickets(locals, project(locals))
    expect(c.map((x) => x.order.status.id)).toEqual([e.source])
  })

  it('the order by send time is kept among the split cards and other tickets', () => {
    const e = scenario()
    const locals = inOrder(e.all)
    const c = kitchenTickets(locals, project(locals))
    expect(c.map((x) => x.sentAt)).toEqual([...c.map((x) => x.sentAt)].sort())
  })
})

describe('occupiesTable', () => {
  const opened = (extras: Parameters<typeof local>[4] = {}, add = false, remove = false) => {
    const p = newId()
    const it = itemData()
    const ev = [local('OrderOpened', p, { ...opening, table_id: newId() }, 'confirmed', extras)]
    if (add) ev.push(local('ItemAdded', p, it) as never)
    if (remove) ev.push(local('ItemRemoved', p, { item_id: it.item_id }) as never)
    return openOrders(ev as LocalEvent[])[0]?.status as OrderState
  }

  it('a freshly opened order, with nothing, occupies the table', () => {
    expect(occupiesTable(opened())).toBe(true)
  })

  it('with a current product, it occupies it', () => {
    expect(occupiesTable(opened({}, true))).toBe(true)
  })

  it('a closed or canceled one does not', () => {
    const p = newId()
    const canceled = openOrders([
      local('OrderOpened', p, { ...opening, table_id: newId() }),
      local('OrderCanceled', p, {}, 'confirmed', { reason: 'x' }),
    ])
    expect(canceled).toEqual([])
    const status = { ...opened(), status: 'canceled' as const }
    expect(occupiesTable(status)).toBe(false)
    expect(occupiesTable({ ...opened(), status: 'closed' as const })).toBe(false)
  })

  it('with everything voided it stops occupying it', () => {
    const p = newId()
    const it = itemData()
    const v = openOrders([
      local('OrderOpened', p, { ...opening, table_id: newId() }),
      local('ItemAdded', p, it),
      local('ItemsSent', p, {
        tickets: [{ ticket_id: newId(), station_id: KITCHEN, item_ids: [it.item_id] }],
      }),
      local(
        'ItemVoided',
        p,
        { item_id: it.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        'confirmed',
        { reason: 'x' },
      ),
    ] as LocalEvent[])
    expect(v).toHaveLength(1)
    expect(occupiesTable((v[0] as VisibleOrder).status)).toBe(false)
  })

  it('removing what had not been sent yet does not release the table: the waiter is still taking the order', () => {
    // Same as in the hub (packages/sync/src/hub/hub.ts `occupies`): only what was moved to another
    // table or voided releases it.
    expect(occupiesTable(opened({}, true, true))).toBe(true)
  })
})

describe('tableStatus and merged tables', () => {
  function group() {
    const p = newId()
    const [m1, m2] = [newId(), newId()]
    const it = itemData()
    const events = [
      local('OrderOpened', p, { ...opening, table_id: m1 }),
      local('TablesMerged', p, { table_ids: [m2] }),
      local('ItemAdded', p, it),
    ] as LocalEvent[]
    return { p, m1, m2, it, events }
  }

  it('a group order keeps its merged tables in the projection', () => {
    const g = group()
    const [v] = openOrders(g.events)
    expect(v?.status.tableId).toBe(g.m1)
    expect(v?.status.mergedTables).toEqual([g.m2])
  })

  it('merged tables share status: taking, in kitchen, ready and served', () => {
    const g = group()
    const status = (extra: LocalEvent[]) => tableStatus(openOrders([...g.events, ...extra]))
    expect(status([])).toBe('taking')
    const send = local('ItemsSent', g.p, {
      tickets: [{ ticket_id: newId(), station_id: KITCHEN, item_ids: [g.it.item_id] }],
    })
    expect(status([send])).toBe('in_kitchen')
    expect(status([send, local('ItemReady', g.p, { item_ids: [g.it.item_id] })])).toBe('ready')
    expect(status([send, local('ItemServed', g.p, { item_ids: [g.it.item_id] })])).toBe('served')
  })

  it('an empty group (just merged, no products) shows as free', () => {
    const g = group()
    expect(tableStatus(openOrders(g.events.slice(0, 2)))).toBe('free')
  })

  it('separating the tables leaves the projection without merged ones', () => {
    const g = group()
    const [v] = openOrders([...g.events, local('TablesSeparated', g.p, { table_ids: [g.m2] })])
    expect(v?.status.mergedTables).toEqual([])
  })

  it('a pending merge (offline) already shows in the projection', () => {
    const g = group()
    const [v] = openOrders([
      ...g.events.slice(0, 1),
      local('TablesMerged', g.p, { table_ids: [g.m2] }, 'pending'),
    ])
    expect(v?.status.mergedTables).toEqual([g.m2])
    expect(v?.pendingConfirmation).toBe(true)
  })
})
