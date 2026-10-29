import { type ApplicableEvent, newId, rebuild, validateNewEvent } from '@pos/core'
import type { LocalEvent } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { courseTickets, itemData, matchingLine, ticketsByStation } from './order'
import {
  moreOrders,
  openOrders,
  soldOutIds,
  soldOutKey,
  tableStatus,
  type VisibleOrder,
} from './projection'
import { itemData as item, local, opening, testCatalog } from './testing'

// Edge cases of order entry from 1.3: sold-out items and their order, most ordered, adding to the
// matching line, firing a course, the item data and the takeout order.

const withSequence = (l: LocalEvent, sequence: number): LocalEvent => ({
  ...l,
  event: { ...l.event, sequence } as ApplicableEvent,
})
const ofProduct = { aggregate_type: 'product' } as const
const brand = (
  type: 'ProductSoldOut' | 'ProductAvailable',
  product: string,
  variant: string | null = null,
  status: 'confirmed' | 'pending' = 'confirmed',
) => local(type, product, { product_id: product, variant_id: variant }, status, ofProduct)

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
const catalog = testCatalog({
  categories: [{ id: newId(), name: 'Bebidas', stationId: 'E-BARRA', products: [simple] }],
})

const orderWith = (...events: ((p: string) => LocalEvent)[]) => {
  const p = newId()
  const locals = [local('OrderOpened', p, opening), ...events.map((f) => f(p))]
  return {
    p,
    locals,
    status: rebuild(
      locals.map((l) => l.event),
      p,
    ),
  }
}
const aggregate =
  (data: ReturnType<typeof item>, status: 'confirmed' | 'pending' = 'confirmed') =>
  (p: string) =>
    local('ItemAdded', p, data, status)

describe('soldOutIds(): order of confirmed and pending', () => {
  it('confirmed ones win by sequence even if the list comes unordered', () => {
    const p = newId()
    const markSoldOut = withSequence(brand('ProductSoldOut', p), 5)
    const release = withSequence(brand('ProductAvailable', p), 9)
    expect(soldOutIds([release, markSoldOut])).toEqual(new Set())
    expect(soldOutIds([markSoldOut, release])).toEqual(new Set())
    const release2 = withSequence(brand('ProductAvailable', p), 3)
    expect(soldOutIds([markSoldOut, release2])).toEqual(new Set([p]))
  })

  it('own pending always goes above confirmed, wherever it is in the list', () => {
    const p = newId()
    const confirmedSoldOut = withSequence(brand('ProductSoldOut', p), 50)
    const pendingAvailable = brand('ProductAvailable', p, null, 'pending')
    expect(soldOutIds([pendingAvailable, confirmedSoldOut])).toEqual(new Set())
    expect(soldOutIds([confirmedSoldOut, pendingAvailable])).toEqual(new Set())
    // And the other way: pending "sold out" over a confirmed "available" later in sequence.
    const confirmedFree = withSequence(brand('ProductAvailable', p), 99)
    const pendingSoldOut = brand('ProductSoldOut', p, null, 'pending')
    expect(soldOutIds([pendingSoldOut, confirmedFree])).toEqual(new Set([p]))
  })

  it('several pending ones apply in list order; the last one wins', () => {
    const p = newId()
    expect(
      soldOutIds([
        brand('ProductSoldOut', p, null, 'pending'),
        brand('ProductAvailable', p, null, 'pending'),
        brand('ProductSoldOut', p, null, 'pending'),
      ]),
    ).toEqual(new Set([p]))
    expect(
      soldOutIds([
        brand('ProductSoldOut', p, null, 'pending'),
        brand('ProductAvailable', p, null, 'pending'),
      ]),
    ).toEqual(new Set())
  })

  it('a confirmed one without sequence counts as 0: it goes before any with a sequence', () => {
    const p = newId()
    const withoutSequence = withSequence(
      brand('ProductAvailable', p),
      undefined as unknown as number,
    )
    const withSeq = withSequence(brand('ProductSoldOut', p), 1)
    expect(soldOutIds([withSeq, withoutSequence])).toEqual(new Set([p]))
    expect(soldOutIds([withoutSequence, withSeq])).toEqual(new Set([p]))
  })

  it('with variants: each stands alone and the whole product is another key', () => {
    const p = newId()
    const glass = newId()
    const bottle = newId()
    const events = [
      withSequence(brand('ProductSoldOut', p, bottle), 1),
      withSequence(brand('ProductSoldOut', p, glass), 2),
      withSequence(brand('ProductAvailable', p, glass), 3),
    ]
    expect(soldOutIds(events)).toEqual(new Set([soldOutKey(p, bottle)]))
    // Marking the whole product available does not free the bottle; selling it out spares a glass.
    expect(soldOutIds([...events, withSequence(brand('ProductAvailable', p), 4)])).toEqual(
      new Set([soldOutKey(p, bottle)]),
    )
    expect(soldOutIds([...events, withSequence(brand('ProductSoldOut', p), 4)])).toEqual(
      new Set([soldOutKey(p, bottle), soldOutKey(p)]),
    )
    expect(soldOutKey(p)).toBe(p)
    expect(soldOutKey(p, null)).toBe(p)
    expect(soldOutKey(p, glass)).not.toBe(soldOutKey(p, bottle))
  })

  it('a rejected or quarantined event does not count; a confirmed one for another product has no effect', () => {
    const p = newId()
    const other = newId()
    const rejected = { ...brand('ProductSoldOut', p), status: 'rejected' as const }
    const quarantine = { ...brand('ProductSoldOut', p), status: 'quarantine' as const }
    expect(soldOutIds([rejected, quarantine])).toEqual(new Set())
    expect(soldOutIds([rejected, withSequence(brand('ProductSoldOut', other), 1)])).toEqual(
      new Set([other]),
    )
    // A rejected "available" does not free what is still sold out.
    const releasesRejected = { ...brand('ProductAvailable', p), status: 'rejected' as const }
    expect(soldOutIds([withSequence(brand('ProductSoldOut', p), 1), releasesRejected])).toEqual(
      new Set([p]),
    )
  })

  it('order events do not count, and with no events nothing is sold out', () => {
    const { locals } = orderWith(aggregate(item()))
    expect(soldOutIds(locals)).toEqual(new Set())
    expect(soldOutIds([])).toEqual(new Set())
  })
})

describe('moreOrders with rejected events and other edge cases', () => {
  it('rejected or quarantined items do not add up', () => {
    const p = newId()
    const good = newId()
    const badCase = newId()
    const locals = [
      local('OrderOpened', p, opening),
      local('ItemAdded', p, item({ product_id: good, quantity: 1 })),
      {
        ...local('ItemAdded', p, item({ product_id: badCase, quantity: 9 })),
        status: 'rejected' as const,
      },
      {
        ...local('ItemAdded', p, item({ product_id: badCase, quantity: 9 })),
        status: 'quarantine' as const,
      },
    ]
    expect(moreOrders(locals)).toEqual([good])
  })

  it('own pending does count; on a tie confirmed goes first, in hub order', () => {
    const p = newId()
    const a = newId()
    const b = newId()
    const c = newId()
    const locals = [
      local('ItemAdded', p, item({ product_id: a, quantity: 2 })),
      local('ItemAdded', p, item({ product_id: b, quantity: 2 }), 'pending'),
      local('ItemAdded', p, item({ product_id: c, quantity: 2 })),
    ]
    expect(moreOrders(locals)).toEqual([a, c, b])
    expect(moreOrders(locals, 2)).toEqual([a, c])
    expect(moreOrders(locals, 0)).toEqual([])
    expect(moreOrders([])).toEqual([])
  })

  it('the default cap is 12 products', () => {
    const p = newId()
    const locals = Array.from({ length: 15 }, (_, i) =>
      local('ItemAdded', p, item({ product_id: newId(), quantity: 15 - i })),
    )
    expect(moreOrders(locals)).toHaveLength(12)
  })

  // Found by qa-pruebas in 1.3 and already fixed: adding the same product again is saved as
  // `ItemChanged` on the line, and `moreOrders` only looked at ItemAdded.
  it('moreOrders counts the units added with ItemChanged', () => {
    const p = newId()
    const lemonade = newId()
    const beer = newId()
    const line = item({ product_id: lemonade, quantity: 1 })
    const locals = [
      local('OrderOpened', p, opening),
      local('ItemAdded', p, line),
      local('ItemAdded', p, item({ product_id: beer, quantity: 3 })),
      local('ItemChanged', p, { item_id: line.item_id, quantity: 10 }),
    ]
    expect(moreOrders(locals)).toEqual([lemonade, beer])
  })

  it('removed does not count and voided is subtracted', () => {
    const p = newId()
    const [lemonade, beer, water] = [newId(), newId(), newId()]
    const removedItem = item({ product_id: lemonade, quantity: 5 })
    const voidedItem = item({ product_id: beer, quantity: 4 })
    const locals = [
      local('OrderOpened', p, opening),
      local('ItemAdded', p, removedItem),
      local('ItemAdded', p, voidedItem),
      local('ItemAdded', p, item({ product_id: water, quantity: 2 })),
      local('ItemRemoved', p, { item_id: removedItem.item_id }),
      local('ItemVoided', p, {
        item_id: voidedItem.item_id,
        quantity: 3,
        already_prepared: false,
        ticket_id: null,
      }),
    ]
    expect(moreOrders(locals)).toEqual([water, beer])
  })
})

describe('matchingLine: held, voided and options in another order', () => {
  const op = (n: string) => ({ modifier_id: n, name: n, extra_price: 0 })

  it('options in another order are the same line', () => {
    const product = newId()
    const [a, b, c] = [newId(), newId(), newId()]
    const first = item({ product_id: product, modifiers: [op(a), op(b), op(c)] })
    const { status } = orderWith(aggregate(first))
    const equal = matchingLine(
      status,
      item({ product_id: product, modifiers: [op(c), op(a), op(b)] }),
    )
    expect(equal?.id).toBe(first.item_id)
    // One option more or less makes it a different line.
    expect(
      matchingLine(status, item({ product_id: product, modifiers: [op(a), op(b)] })),
    ).toBeNull()
    expect(
      matchingLine(
        status,
        item({ product_id: product, modifiers: [op(a), op(b), op(c), op(newId())] }),
      ),
    ).toBeNull()
  })

  it('a line already sent or removed is not added to', () => {
    const product = newId()
    const line = item({ product_id: product })
    const sent = orderWith(aggregate(line), (p) =>
      local('ItemsSent', p, {
        tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [line.item_id] }],
      }),
    )
    expect(matchingLine(sent.status, item({ product_id: product }))).toBeNull()

    const removedItem = orderWith(aggregate(line), (p) =>
      local('ItemRemoved', p, { item_id: line.item_id }),
    )
    expect(matchingLine(removedItem.status, item({ product_id: product }))).toBeNull()
  })

  it('with two possible matching lines (another person) picks the one for the same person', () => {
    const product = newId()
    const table = item({ product_id: product, guest: null })
    const p2 = item({ product_id: product, guest: 2 })
    const { status } = orderWith(aggregate(table), aggregate(p2))
    expect(matchingLine(status, item({ product_id: product, guest: 2 }))?.id).toBe(p2.item_id)
    expect(matchingLine(status, item({ product_id: product, guest: null }))?.id).toBe(table.item_id)
    expect(matchingLine(status, item({ product_id: product, guest: 3 }))).toBeNull()
  })

  it('does not add if the new one has a note, nor to a line that already has a note', () => {
    const product = newId()
    const withNote = orderWith(aggregate(item({ product_id: product, notes: 'sin hielo' })))
    expect(matchingLine(withNote.status, item({ product_id: product }))).toBeNull()
    expect(
      matchingLine(withNote.status, item({ product_id: product, notes: 'sin hielo' })),
    ).toBeNull()
  })

  it('tells variants apart (glass and bottle are different lines)', () => {
    const product = newId()
    const glass = newId()
    const bottle = newId()
    const { status } = orderWith(aggregate(item({ product_id: product, variant_id: glass })))
    expect(matchingLine(status, item({ product_id: product, variant_id: bottle }))).toBeNull()
    expect(matchingLine(status, item({ product_id: product, variant_id: glass }))).not.toBeNull()
    expect(matchingLine(status, item({ product_id: product, variant_id: null }))).toBeNull()
  })

  it('an order without lines or a different order gives no match', () => {
    const { status } = orderWith()
    expect(matchingLine(status, item())).toBeNull()
  })

  it('the same product in a held course adds to its held line', () => {
    const product = newId()
    const first = item({ product_id: product, course: 'dessert' })
    const { status } = orderWith(
      (p) => local('CourseHeld', p, { course: 'dessert' }),
      aggregate(first),
    )
    expect(status?.items[first.item_id]?.status).toBe('held')
    expect(matchingLine(status, item({ product_id: product, course: 'dessert' }))?.id).toBe(
      first.item_id,
    )
  })

  it('does not add to a line with another copied price (another menu version)', () => {
    const product = newId()
    const old = item({ product_id: product, unit_price: 9_900, catalog_version: 1 })
    const { status } = orderWith(aggregate(old))
    const matchForNew = (fields: Record<string, unknown>) =>
      matchingLine(status, item({ product_id: product, unit_price: 9_900, ...fields }))
    expect(matchForNew({ unit_price: 10_900, catalog_version: 2 })).toBeNull()
    expect(matchForNew({ catalog_version: 2 })?.id).toBe(old.item_id)
    expect(matchForNew({ tax_type: 'iva', rate: 1_900 })).toBeNull()
    expect(matchForNew({ rate: 1_900 })).toBeNull()
    expect(matchForNew({ tax_type: 'exempt', rate: 0 })).toBeNull()
  })

  it('the same option with another extra price is not the same line', () => {
    const product = newId()
    const o = newId()
    const withOption = (price: number) => ({
      modifier_id: o,
      name: 'Doble',
      extra_price: price,
    })
    const { status } = orderWith(
      aggregate(item({ product_id: product, modifiers: [withOption(2_000)] })),
    )
    expect(
      matchingLine(status, item({ product_id: product, modifiers: [withOption(3_000)] })),
    ).toBeNull()
    expect(
      matchingLine(status, item({ product_id: product, modifiers: [withOption(2_000)] })),
    ).not.toBeNull()
  })

  it('does not add to a discounted line nor in a split order', () => {
    const product = newId()
    const line = item({ product_id: product })
    const { status } = orderWith(aggregate(line))
    if (!status) throw new Error('missing')
    const withDiscount = {
      ...status,
      discounts: {
        D1: { id: 'D1', amounts: { [line.item_id]: 500 } },
      },
    } as unknown as typeof status
    expect(matchingLine(withDiscount, item({ product_id: product }))).toBeNull()
    const divided = { ...status, checks: [] } as unknown as typeof status
    expect(matchingLine(divided, item({ product_id: product }))).toBeNull()
    expect(matchingLine(status, item({ product_id: product }))?.id).toBe(line.item_id)
  })
})

describe('courseTickets with pending items from other courses', () => {
  const catalogTwo = testCatalog({
    categories: [
      { id: newId(), name: 'Bebidas', stationId: 'E-BARRA', products: [simple] },
      {
        id: newId(),
        name: 'Platos',
        stationId: 'E-COCINA',
        products: [{ ...simple, id: 'P-PLATO', name: 'Pizza' }],
      },
    ],
  })

  it('only sends the fired course: other courses and items without course stay pending', () => {
    const entry = item({ product_id: simple.id, course: 'starter' })
    const barMain = item({ product_id: simple.id, course: 'main' })
    const kitchenMain = item({ product_id: 'P-PLATO', course: 'main' })
    const dessert = item({ product_id: 'P-PLATO', course: 'dessert' })
    const withoutCourse = item({ product_id: simple.id, course: null })
    const { status } = orderWith(
      aggregate(entry),
      aggregate(barMain),
      aggregate(kitchenMain),
      aggregate(dessert),
      aggregate(withoutCourse),
    )
    if (!status) throw new Error('missing')

    const data = courseTickets(catalogTwo, status, 'main')
    const sentList = data?.tickets.flatMap((c) => c.item_ids).sort()
    expect(sentList).toEqual([barMain.item_id, kitchenMain.item_id].sort())
    expect(data?.tickets.map((c) => c.station_id).sort()).toEqual(['E-BARRA', 'E-COCINA'])
    // The original state was not modified: the others are still to be sent.
    expect(Object.keys(status.items)).toHaveLength(5)
    expect(ticketsByStation(catalogTwo, status)?.tickets.flatMap((c) => c.item_ids)).toHaveLength(5)
  })

  it('if the course already went out or is empty, there is nothing to send (even with others pending)', () => {
    const main = item({ product_id: simple.id, course: 'main' })
    const dessert = item({ product_id: simple.id, course: 'dessert' })
    const { status } = orderWith(aggregate(main), aggregate(dessert), (p) =>
      local('ItemsSent', p, {
        tickets: [{ ticket_id: newId(), station_id: 'E-BARRA', item_ids: [main.item_id] }],
      }),
    )
    if (!status) throw new Error('missing')
    expect(courseTickets(catalogTwo, status, 'main')).toBeNull()
    expect(courseTickets(catalogTwo, status, 'starter')).toBeNull()
    expect(courseTickets(catalogTwo, status, 'dessert')?.tickets).toHaveLength(1)
  })

  it('held items of that course wait until fired; then they go out', () => {
    const dessert = item({ product_id: simple.id, course: 'dessert' })
    const held = orderWith((p) => local('CourseHeld', p, { course: 'dessert' }), aggregate(dessert))
    if (!held.status) throw new Error('missing')
    expect(courseTickets(catalogTwo, held.status, 'dessert')).toBeNull()

    const fired = orderWith(
      (p) => local('CourseHeld', p, { course: 'dessert' }),
      aggregate(dessert),
      (p) => local('CourseFired', p, { course: 'dessert' }),
    )
    if (!fired.status) throw new Error('missing')
    expect(courseTickets(catalogTwo, fired.status, 'dessert')?.tickets[0]?.item_ids).toEqual([
      dessert.item_id,
    ])
  })
})

describe('itemData with out-of-range extras', () => {
  const validData = (extras: Parameters<typeof itemData>[4]) => {
    const d = itemData(catalog, simple, null, {}, extras)
    const p = newId()
    return validateNewEvent({
      id: newId(),
      type: 'ItemAdded',
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: p,
      related: [],
      data: d,
      session_id: null,
      user_id: newId(),
      device_id: newId(),
      authorization_id: null,
      reason: null,
      device_time: '2026-10-24T15:00:00.000Z',
      hub_estimated_time: '2026-10-24T15:00:00.000Z',
      base_sequence: 0,
    })
  }

  it('without extras: one unit, for the table, no course or note', () => {
    expect(itemData(catalog, simple, null, {})).toMatchObject({
      quantity: 1,
      guest: null,
      course: null,
      notes: null,
      catalog_version: catalog.version,
      price_channel_id: null,
    })
  })

  it('quantity 0 and guest 0 pass through as is, and the schema rejects them before saving', () => {
    expect(itemData(catalog, simple, null, {}, { quantity: 0 }).quantity).toBe(0)
    expect(itemData(catalog, simple, null, {}, { guest: 0 }).guest).toBe(0)
    expect(validData({ quantity: 0 }).ok).toBe(false)
    expect(validData({ guest: 0 }).ok).toBe(false)
    expect(validData({ quantity: -3 }).ok).toBe(false)
    expect(validData({ guest: 100 }).ok).toBe(false)
    expect(validData({ quantity: 1.5 }).ok).toBe(false)
  })

  it('quantity 99 is valid; 100 passes the schema but the screen never goes over 99', () => {
    expect(validData({ quantity: 99 }).ok).toBe(true)
    // The schema accepts up to the quantity cap (999); the 99 limit is set by the screen.
    expect(validData({ quantity: 100 }).ok).toBe(true)
    expect(validData({ quantity: 1_000 }).ok).toBe(false)
  })

  it('guest 1 and 99 are valid; the note is trimmed and one over 500 characters fails the schema', () => {
    expect(validData({ guest: 1 }).ok).toBe(true)
    expect(validData({ guest: 99 }).ok).toBe(true)
    expect(itemData(catalog, simple, null, {}, { notes: '\n  sin hielo \t' }).notes).toBe(
      'sin hielo',
    )
    expect(validData({ notes: 'a'.repeat(500) }).ok).toBe(true)
    expect(validData({ notes: 'a'.repeat(501) }).ok).toBe(false)
  })

  it('empty extras or explicit null count as "no extras"', () => {
    const d = itemData(catalog, simple, null, {}, { guest: null, course: null, notes: undefined })
    expect(d).toMatchObject({ guest: null, course: null, notes: null, quantity: 1 })
  })
})

describe('projection of a takeout order (no table, with daily number)', () => {
  it('carries channel, daily number and no tableId; sold-out items do not get in the way', () => {
    const p = newId()
    const locals = [
      local('OrderOpened', p, { channel: 'takeout', table_id: null, guests: 1 }),
      withSequence(brand('ProductSoldOut', newId()), 7),
      local('ItemAdded', p, item({ unit_price: 12_000 })),
    ]
    const [v] = openOrders(locals)
    expect(v?.status.channel).toBe('takeout')
    expect(v?.status.tableId).toBeNull()
    expect(v?.status.dayNumber).toBe(1)
    expect(v?.total).toBe(12_000)
    expect(tableStatus(v ? [v] : [])).toBe('taking')
  })

  it('not yet confirmed it has no daily number; once confirmed it gets it from the hub', () => {
    const p = newId()
    const opened = local(
      'OrderOpened',
      p,
      { channel: 'takeout', table_id: null, guests: 1 },
      'pending',
    )
    expect(openOrders([opened])[0]?.status.dayNumber).toBeNull()
    expect(openOrders([opened])[0]?.pendingConfirmation).toBe(true)

    const confirmed = {
      ...opened,
      status: 'confirmed' as const,
      event: {
        ...opened.event,
        sequence: 4,
        received_at: '2026-10-24T15:00:00.000Z',
        business_day: '2026-10-24',
        assignments: { day_number: 12 },
        affects: [],
        authorized_by_id: null,
      } as ApplicableEvent,
    }
    expect(openOrders([confirmed])[0]?.status.dayNumber).toBe(12)
  })

  it('two takeout orders and one dine-in are told apart; product events never show as an order', () => {
    const [a, b, c] = [newId(), newId(), newId()]
    const x = newId()
    const table = newId()
    const seenSet: VisibleOrder[] = openOrders([
      local('OrderOpened', a, { channel: 'takeout', table_id: null, guests: 1 }),
      local('OrderOpened', b, { channel: 'delivery', table_id: null, guests: 1 }),
      local('OrderOpened', c, { channel: 'dine_in', table_id: table, guests: 2 }),
      brand('ProductSoldOut', x),
      brand('ProductAvailable', x),
    ])
    expect(seenSet.map((v) => v.status.channel).sort()).toEqual(['delivery', 'dine_in', 'takeout'])
    expect(seenSet.map((v) => v.status.id)).not.toContain(x)
    expect(seenSet.find((v) => v.status.channel === 'dine_in')?.status.tableId).toBe(table)
    expect(seenSet.filter((v) => v.status.tableId === null)).toHaveLength(2)
  })
})
