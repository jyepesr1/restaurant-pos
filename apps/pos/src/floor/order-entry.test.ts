import { newId, rebuild } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { courseTickets, itemData, matchingLine } from './order'
import { moreOrders, openOrders, soldOutIds, soldOutKey } from './projection'
import { itemData as item, local, opening, testCatalog } from './testing'

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
    const entry = item({ product_id: simple.id, course: 'entry' })
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
