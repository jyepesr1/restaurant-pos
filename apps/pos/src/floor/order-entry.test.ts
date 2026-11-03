import { newId, rebuild } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { courseTickets, itemData, matchingLine, movedFrom, showsCheck } from './order'
import { moreOrders, openOrders, soldOutIds, soldOutKey } from './projection'
import { inOrder, itemData as item, local, opening, testCatalog } from './testing'

const simple = {
  id: newId(),
  name: 'Limonada',
  description: null,
  favorite: false,
  price: 9_900,
  tax: { type: 'inc' as const, rate: 800 },
  variants: [],
  groups: [],
}
const withDishes = () =>
  testCatalog({
    categories: [{ id: newId(), name: 'Bebidas', stationId: 'E-BARRA', products: [simple] }],
  })

// Order entry from 1.3: sold out, the most ordered, the line that adds up, firing a course and the
// item data with person, course and note.

const soldOut = (
  product: string,
  status: 'confirmed' | 'pending' = 'confirmed',
  variant: string | null = null,
) =>
  local('ProductSoldOut', product, { product_id: product, variant_id: variant }, status, {
    aggregate_type: 'product',
  })
const available = (product: string, status: 'confirmed' | 'pending' = 'confirmed') =>
  local('ProductAvailable', product, { product_id: product, variant_id: null }, status, {
    aggregate_type: 'product',
  })

describe('sold out (86)', () => {
  it('the last event wins; own pending ones go on top of the confirmed ones', () => {
    const p = newId()
    expect(soldOutIds([soldOut(p)])).toEqual(new Set([p]))
    expect(soldOutIds([soldOut(p), available(p)])).toEqual(new Set())
    // Confirmed "available", but this device just marked it sold out offline.
    expect(soldOutIds([available(p), soldOut(p, 'pending')])).toEqual(new Set([p]))
  })

  it('a variant sells out by itself (the bottle, not the glass)', () => {
    const p = newId()
    const bottle = newId()
    expect(soldOutIds([soldOut(p, 'confirmed', bottle)])).toEqual(new Set([soldOutKey(p, bottle)]))
  })

  it('a rejected event does not count, and product events do not become orders', () => {
    const p = newId()
    const rejected = { ...soldOut(p), status: 'rejected' as const }
    expect(soldOutIds([rejected])).toEqual(new Set())
    const order = newId()
    expect(
      openOrders([soldOut(p), local('OrderOpened', order, opening)]).map((x) => x.status.id),
    ).toEqual([order])
  })
})

describe('the most ordered', () => {
  it('counts units per product, from most to least', () => {
    const order = newId()
    const a = newId()
    const b = newId()
    const locals = [
      local('OrderOpened', order, opening),
      local('ItemAdded', order, item({ product_id: a, quantity: 1 })),
      local('ItemAdded', order, item({ product_id: b, quantity: 3 })),
      local('ItemAdded', order, item({ product_id: a, quantity: 1 })),
    ]
    expect(moreOrders(locals)).toEqual([b, a])
    expect(moreOrders(locals, 1)).toEqual([b])
  })
})

describe('the same product again', () => {
  const orderWith = (...data: ReturnType<typeof item>[]) => {
    const order = newId()
    return rebuild(
      [local('OrderOpened', order, opening), ...data.map((d) => local('ItemAdded', order, d))].map(
        (l) => l.event,
      ),
      order,
    )
  }

  it('adds to the unsent identical line: same product, person, course, no note', () => {
    const product = newId()
    const first = item({ product_id: product })
    const status = orderWith(first)
    expect(matchingLine(status, item({ product_id: product }))?.id).toBe(first.item_id)
  })

  it('does not add if the person, the course, the note or the options change', () => {
    const product = newId()
    const status = orderWith(item({ product_id: product }))
    expect(matchingLine(status, item({ product_id: product, guest: 2 }))).toBeNull()
    expect(matchingLine(status, item({ product_id: product, course: 'main' }))).toBeNull()
    expect(matchingLine(status, item({ product_id: product, notes: 'sin hielo' }))).toBeNull()
    expect(
      matchingLine(
        status,
        item({
          product_id: product,
          modifiers: [{ modifier_id: newId(), name: 'Doble', extra_price: 0 }],
        }),
      ),
    ).toBeNull()
    expect(matchingLine(null, item({ product_id: product }))).toBeNull()
  })
})

describe('firing a course', () => {
  it("sends only the course's items, by station", () => {
    const catalog = withDishes()
    const order = newId()
    const entry = item({ product_id: simple.id, course: 'starter' })
    const main = item({ product_id: simple.id, course: 'main' })
    const status = rebuild(
      [
        local('OrderOpened', order, opening),
        local('ItemAdded', order, entry),
        local('ItemAdded', order, main),
      ].map((l) => l.event),
      order,
    )
    if (!status) throw new Error('missing')
    const data = courseTickets(catalog, status, 'main')
    expect(data?.tickets).toEqual([
      expect.objectContaining({ station_id: 'E-BARRA', item_ids: [main.item_id] }),
    ])
    expect(courseTickets(catalog, status, 'dessert')).toBeNull()
  })
})

describe('item data', () => {
  it('carry person, course, quantity and the trimmed note (empty is null)', () => {
    const catalog = withDishes()
    const p = simple
    expect(
      itemData(
        catalog,
        p,
        null,
        {},
        { guest: 2, course: 'dessert', quantity: 3, notes: '  sin azúcar ' },
      ),
    ).toMatchObject({
      guest: 2,
      course: 'dessert',
      quantity: 3,
      notes: 'sin azúcar',
    })
    expect(itemData(catalog, p, null, {}, { notes: '   ' }).notes).toBeNull()
  })
})

describe('the «Cuenta» button', () => {
  const stateOf = (
    channel: 'dine_in' | 'takeout' | 'delivery' | 'bar',
    ...more: ((o: string) => ReturnType<typeof local>)[]
  ) => {
    const order = newId()
    const status = rebuild(
      [local('OrderOpened', order, { ...opening, channel }), ...more.map((m) => m(order))].map(
        (l) => l.event,
      ),
      order,
    )
    if (!status) throw new Error('missing')
    return status
  }
  const line = item()
  const adds = (o: string) => local('ItemAdded', o, line)
  const sends = (o: string) =>
    local('ItemsSent', o, {
      tickets: [{ ticket_id: newId(), station_id: 'E-BARRA', item_ids: [line.item_id] }],
    })

  it('at a table, only once something has gone to the kitchen', () => {
    expect(showsCheck(stateOf('dine_in'))).toBe(false)
    expect(showsCheck(stateOf('dine_in', adds))).toBe(false)
    expect(showsCheck(stateOf('dine_in', adds, sends))).toBe(true)
    // One sent and another still being taken: the sent one can already be billed.
    expect(showsCheck(stateOf('dine_in', adds, sends, (o) => local('ItemAdded', o, item())))).toBe(
      true,
    )
  })

  it('at a table without stations nothing is ever sent: from the first product', () => {
    expect(showsCheck(stateOf('dine_in'), false)).toBe(false)
    expect(showsCheck(stateOf('dine_in', adds), false)).toBe(true)
  })

  it('a held course is not sent yet', () => {
    const held = item({ course: 'main' })
    const status = stateOf(
      'dine_in',
      (o) => local('CourseHeld', o, { course: 'main' }),
      (o) => local('ItemAdded', o, held),
    )
    expect(status.items[held.item_id]?.status).toBe('held')
    expect(showsCheck(status)).toBe(false)
  })

  it('takeout, delivery and bar, from the first product', () => {
    for (const channel of ['takeout', 'delivery', 'bar'] as const) {
      expect(showsCheck(stateOf(channel))).toBe(false)
      expect(showsCheck(stateOf(channel, adds))).toBe(true)
    }
  })
})

describe('the «Cuenta» button, edge cases', () => {
  type Local = ReturnType<typeof local>
  const SHIFT = newId()

  const stateFrom = (order: string, events: Local[]) => {
    // Renumbered by position: the events are built before the arrays that order them.
    const status = rebuild(
      inOrder(events).map((l) => l.event),
      order,
    )
    if (!status) throw new Error('missing')
    return status
  }
  const sendOf = (order: string, ...ids: string[]) =>
    local('ItemsSent', order, {
      tickets: [{ ticket_id: newId(), station_id: 'E-COCINA', item_ids: ids }],
    })
  const tablePayment = (order: string, amount: number) =>
    local('PaymentRecorded', order, {
      payment_id: newId(),
      check_id: null,
      register_shift_id: SHIFT,
      method: 'nequi' as const,
      amount,
      tip: 0,
      tendered: null,
      change: null,
      rounding_adjustment: 0,
      rounding: null,
      cardTerminal: null,
      charge_reference: null,
    })
  const atTable = (order: string, tableId: string | null = newId()) =>
    local('OrderOpened', order, { ...opening, table_id: tableId })

  it('served items keep the button (served is past «sent»)', () => {
    const order = newId()
    const dish = item()
    const status = stateFrom(order, [
      atTable(order),
      local('ItemAdded', order, dish),
      sendOf(order, dish.item_id),
      local('ItemServed', order, { item_ids: [dish.item_id] }),
    ])
    expect(status.items[dish.item_id]?.status).toBe('served')
    expect(showsCheck(status)).toBe(true)
  })

  it('items in preparation or ready keep the button, and so do items returned to the queue', () => {
    const order = newId()
    const a = item()
    const b = item()
    const base = [
      atTable(order),
      local('ItemAdded', order, a),
      local('ItemAdded', order, b),
      sendOf(order, a.item_id, b.item_id),
    ]
    const prep = stateFrom(order, [
      ...base,
      local('ItemInPreparation', order, { item_ids: [a.item_id, b.item_id] }),
    ])
    expect(showsCheck(prep)).toBe(true)
    const ready = stateFrom(order, [
      ...base,
      local('ItemReady', order, { item_ids: [a.item_id, b.item_id] }),
    ])
    expect(showsCheck(ready)).toBe(true)
    const back = stateFrom(order, [
      ...base,
      local('ItemServed', order, { item_ids: [a.item_id] }),
      local('ItemReturnedToQueue', order, { item_ids: [a.item_id] }),
    ])
    expect(back.items[a.item_id]?.status).toBe('sent')
    expect(showsCheck(back)).toBe(true)
  })

  it('a sent item that is then voided entirely no longer counts', () => {
    const order = newId()
    const dish = item()
    const status = stateFrom(order, [
      atTable(order),
      local('ItemAdded', order, dish),
      sendOf(order, dish.item_id),
      local(
        'ItemVoided',
        order,
        { item_id: dish.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        'confirmed',
        { reason: 'Error del mesero' },
      ),
    ])
    expect(status.items[dish.item_id]?.status).toBe('voided')
    expect(showsCheck(status)).toBe(false)
  })

  it('voiding only some units of a sent line keeps the button', () => {
    const order = newId()
    const dish = item({ quantity: 3 })
    const status = stateFrom(order, [
      atTable(order),
      local('ItemAdded', order, dish),
      sendOf(order, dish.item_id),
      local(
        'ItemVoided',
        order,
        { item_id: dish.item_id, quantity: 2, already_prepared: false, ticket_id: null },
        'confirmed',
        { reason: 'Error del mesero' },
      ),
    ])
    expect(status.items[dish.item_id]).toMatchObject({ status: 'sent', voidedQuantity: 2 })
    expect(showsCheck(status)).toBe(true)
  })

  it('a voided sent item does not make an unsent one billable, but another sent one does', () => {
    const order = newId()
    const voided = item()
    const pending = item()
    const kept = item()
    const void1 = local(
      'ItemVoided',
      order,
      { item_id: voided.item_id, quantity: 1, already_prepared: false, ticket_id: null },
      'confirmed',
      { reason: 'Error del mesero' },
    )
    const first = [
      atTable(order),
      local('ItemAdded', order, voided),
      sendOf(order, voided.item_id),
      void1,
      local('ItemAdded', order, pending),
    ]
    expect(showsCheck(stateFrom(order, first))).toBe(false)
    const second = [...first, local('ItemAdded', order, kept), sendOf(order, kept.item_id)]
    expect(showsCheck(stateFrom(order, second))).toBe(true)
  })

  it('after moving the only sent item to another table, the source has no button', () => {
    const source = newId()
    const target = newId()
    const dish = item()
    const events = [atTable(source), local('ItemAdded', source, dish), sendOf(source, dish.item_id)]
    const sourceBefore = stateFrom(source, events)
    expect(showsCheck(sourceBefore)).toBe(true)
    const targetOpen = atTable(target)
    const move = local(
      'ItemsMoved',
      source,
      {
        target_order_id: target,
        items: [movedFrom(sourceBefore.items[dish.item_id] as never)],
      },
      'confirmed',
      { related: [target] },
    )
    const sourceAfter = stateFrom(source, [...events, move])
    expect(Object.keys(sourceAfter.items)).toHaveLength(0)
    expect(showsCheck(sourceAfter)).toBe(false)
    // The target receives it already sent: it can be billed there.
    const targetAfter = stateFrom(target, [targetOpen, move])
    expect(targetAfter.items[dish.item_id]?.status).toBe('sent')
    expect(showsCheck(targetAfter)).toBe(true)
  })

  it('moving one of two sent items leaves the button on the source', () => {
    const source = newId()
    const target = newId()
    const a = item()
    const b = item()
    const events = [
      atTable(source),
      local('ItemAdded', source, a),
      local('ItemAdded', source, b),
      sendOf(source, a.item_id, b.item_id),
    ]
    const before = stateFrom(source, events)
    const move = local(
      'ItemsMoved',
      source,
      { target_order_id: target, items: [movedFrom(before.items[a.item_id] as never)] },
      'confirmed',
      { related: [target] },
    )
    const after = stateFrom(source, [...events, move])
    expect(Object.keys(after.items)).toEqual([b.item_id])
    expect(showsCheck(after)).toBe(true)
  })

  it('merged tables behave like a single order', () => {
    const order = newId()
    const main = newId()
    const extra = newId()
    const dish = item()
    const open = [atTable(order, main), local('TablesMerged', order, { table_ids: [extra] })]
    const unsent = stateFrom(order, [...open, local('ItemAdded', order, dish)])
    expect(unsent.mergedTables).toEqual([extra])
    expect(showsCheck(unsent)).toBe(false)
    const sent = stateFrom(order, [
      ...open,
      local('ItemAdded', order, dish),
      sendOf(order, dish.item_id),
    ])
    expect(showsCheck(sent)).toBe(true)
    // Separating the tables later does not change it.
    const separated = stateFrom(order, [
      ...open,
      local('ItemAdded', order, dish),
      sendOf(order, dish.item_id),
      local('TablesSeparated', order, { table_ids: [extra] }),
    ])
    expect(separated.mergedTables).toEqual([])
    expect(showsCheck(separated)).toBe(true)
  })

  it('a held course that is then fired is pending, not billable, until it is sent', () => {
    const order = newId()
    const main = item({ course: 'main' })
    const open = [
      atTable(order),
      local('CourseHeld', order, { course: 'main' }),
      local('ItemAdded', order, main),
    ]
    const held = stateFrom(order, open)
    expect(held.items[main.item_id]?.status).toBe('held')
    expect(showsCheck(held)).toBe(false)

    const fired = stateFrom(order, [...open, local('CourseFired', order, { course: 'main' })])
    expect(fired.items[main.item_id]?.status).toBe('pending')
    expect(showsCheck(fired)).toBe(false)

    const sent = stateFrom(order, [
      ...open,
      local('CourseFired', order, { course: 'main' }),
      sendOf(order, main.item_id),
    ])
    expect(sent.items[main.item_id]?.status).toBe('sent')
    expect(showsCheck(sent)).toBe(true)
  })

  it('a sent starter keeps the button while the main course is still held', () => {
    const order = newId()
    const starter = item({ course: 'starter' })
    const main = item({ course: 'main' })
    const status = stateFrom(order, [
      atTable(order),
      local('CourseHeld', order, { course: 'main' }),
      local('ItemAdded', order, starter),
      local('ItemAdded', order, main),
      sendOf(order, starter.item_id),
    ])
    expect(status.items[main.item_id]?.status).toBe('held')
    expect(showsCheck(status)).toBe(true)
  })

  it('a payment already made shows the button at a table with nothing sent (to pay the rest)', () => {
    const order = newId()
    const dish = item()
    const status = stateFrom(order, [
      atTable(order),
      local('ItemAdded', order, dish),
      tablePayment(order, 1_000),
    ])
    expect(Object.keys(status.payments)).toHaveLength(1)
    expect(showsCheck(status)).toBe(true)
  })

  it('a partially paid order with something sent shows the button (to pay the rest)', () => {
    const order = newId()
    const dish = item()
    const status = stateFrom(order, [
      atTable(order),
      local('ItemAdded', order, dish),
      sendOf(order, dish.item_id),
      tablePayment(order, 1_000),
    ])
    expect(Object.keys(status.payments)).toHaveLength(1)
    expect(showsCheck(status)).toBe(true)
  })

  it('takeout partially paid still shows the button, and a voided-only takeout does not', () => {
    const order = newId()
    const dish = item()
    const open = local('OrderOpened', order, { ...opening, channel: 'takeout' })
    const paid = stateFrom(order, [
      open,
      local('ItemAdded', order, dish),
      tablePayment(order, 1_000),
    ])
    expect(Object.keys(paid.payments)).toHaveLength(1)
    expect(showsCheck(paid)).toBe(true)

    const voided = stateFrom(order, [
      open,
      local('ItemAdded', order, dish),
      sendOf(order, dish.item_id),
      local(
        'ItemVoided',
        order,
        { item_id: dish.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        'confirmed',
        { reason: 'Error del mesero' },
      ),
    ])
    expect(voided.items[dish.item_id]?.status).toBe('voided')
    expect(showsCheck(voided)).toBe(false)
  })
})
