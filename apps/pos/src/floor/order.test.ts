import { newId, rebuild } from '@pos/core'
import type { Catalog } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import {
  asksForOptions,
  type CatalogGroup,
  type CatalogProduct,
  copyOf,
  itemData,
  missingSelection,
  pendingSend,
  selectedPrice,
  ticketsByStation,
} from './order'
import { itemData as copy, local, opening, testCatalog } from './testing'

const group = (fields: Partial<CatalogGroup> = {}): CatalogGroup => ({
  id: newId(),
  name: 'Punto de cocción',
  minimum: 1,
  maximum: 1,
  options: [
    { id: 'O-1', name: 'Término medio', extraPrice: 0 },
    { id: 'O-2', name: 'Bien cocido', extraPrice: 0 },
    { id: 'O-3', name: 'Extra queso', extraPrice: 3_000 },
  ],
  ...fields,
})

const product = (fields: Partial<CatalogProduct> = {}): CatalogProduct => ({
  id: newId(),
  name: 'Ramón Bilbao',
  description: null,
  favorite: false,
  price: 20_000,
  tax: { type: 'inc', rate: 800 },
  variants: [],
  groups: [],
  ...fields,
})

const wine = product({
  variants: [
    { id: 'V-COPA', name: 'Copa', price: 24_000 },
    { id: 'V-BOTELLA', name: 'Botella', price: 98_000 },
  ],
})

describe('asksForOptions', () => {
  it('is false without variants or groups and true with either of them', () => {
    expect(asksForOptions(product())).toBe(false)
    expect(asksForOptions(wine)).toBe(true)
    expect(asksForOptions(product({ groups: [group()] }))).toBe(true)
  })
})

describe('missingSelection', () => {
  it('without variants or groups nothing is missing', () => {
    expect(missingSelection(product(), null, {})).toEqual([])
  })

  it('asks for the size if the product has variants and none was chosen, or a foreign one was', () => {
    expect(missingSelection(wine, null, {})).toEqual(['tamaño'])
    expect(missingSelection(wine, 'V-OTRO-PRODUCTO', {})).toEqual(['tamaño'])
    expect(missingSelection(wine, 'V-COPA', {})).toEqual([])
  })

  it('asks for each group below its minimum, with the name in lowercase', () => {
    const g = group({ minimum: 2, maximum: 3 })
    const p = product({ groups: [g] })
    expect(missingSelection(p, null, {})).toEqual(['punto de cocción'])
    expect(missingSelection(p, null, { [g.id]: ['O-1'] })).toEqual(['punto de cocción'])
    expect(missingSelection(p, null, { [g.id]: ['O-1', 'O-2'] })).toEqual([])
  })

  it('a group with minimum 0 is optional', () => {
    const p = product({ groups: [group({ minimum: 0, maximum: 2 })] })
    expect(missingSelection(p, null, {})).toEqual([])
  })

  it('joins size and groups, in that order', () => {
    const p = product({ variants: wine.variants, groups: [group()] })
    expect(missingSelection(p, null, {})).toEqual(['tamaño', 'punto de cocción'])
  })
})

describe('itemData', () => {
  const catalog = testCatalog({ version: 7 })

  it('simple product: copies name, price and tax from the catalog', () => {
    const p = product({ name: 'Limonada', price: 9_900 })
    const d = itemData(catalog, p, null, {})
    expect(d).toMatchObject({
      product_id: p.id,
      variant_id: null,
      name: 'Limonada',
      unit_price: 9_900,
      tax_type: 'inc',
      rate: 800,
      quantity: 1,
      modifiers: [],
      catalog_version: 7,
      price_channel_id: null,
    })
    expect(d.item_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('with a variant: the price and the name are the variant ones', () => {
    const d = itemData(catalog, wine, 'V-BOTELLA', {})
    expect(d).toMatchObject({
      variant_id: 'V-BOTELLA',
      name: 'Ramón Bilbao · Botella',
      unit_price: 98_000,
    })
  })

  it('with modifiers: stores id, name and surcharge of what was chosen, in catalog order', () => {
    const g = group({ minimum: 1, maximum: 3 })
    const p = product({ groups: [g] })
    const d = itemData(catalog, p, null, { [g.id]: ['O-3', 'O-1'] })
    expect(d.modifiers).toEqual([
      { modifier_id: 'O-1', name: 'Término medio', extra_price: 0 },
      { modifier_id: 'O-3', name: 'Extra queso', extra_price: 3_000 },
    ])
    // The unit price does not include the surcharge: the order calculation adds it.
    expect(d.unit_price).toBe(20_000)
  })

  it('an id that is not from the group does not count as chosen', () => {
    const g = group({ minimum: 1, maximum: 1 })
    const p = product({ groups: [g] })
    expect(missingSelection(p, null, { [g.id]: ['AJENA'] })).toEqual(['punto de cocción'])
    expect(() => itemData(catalog, p, null, { [g.id]: ['AJENA'] })).toThrow('Falta elegir')
    const d = itemData(catalog, p, null, { [g.id]: ['O-1', 'AJENA'] })
    expect(d.modifiers.map((m) => m.modifier_id)).toEqual(['O-1'])
  })

  it('going over the group maximum is not trimmed silently: it throws and stores nothing', () => {
    const g = group({ minimum: 1, maximum: 1 })
    const p = product({ groups: [g] })
    expect(() => itemData(catalog, p, null, { [g.id]: ['O-1', 'O-2'] })).toThrow(
      'En punto de cocción se eligen máximo 1',
    )
    // Exactly at the maximum is fine.
    expect(itemData(catalog, p, null, { [g.id]: ['O-2'] }).modifiers).toHaveLength(1)
  })

  it('an exempt product gets rate 0', () => {
    const p = product({ tax: { type: 'exempt', rate: 800 } })
    expect(itemData(catalog, p, null, {})).toMatchObject({ tax_type: 'exempt', rate: 0 })
  })

  it('with a variant and modifiers at once', () => {
    const g = group()
    const p = product({ variants: wine.variants, groups: [g] })
    const d = itemData(catalog, p, 'V-COPA', { [g.id]: ['O-2'] })
    expect(d).toMatchObject({ name: 'Ramón Bilbao · Copa', unit_price: 24_000 })
    expect(d.modifiers).toHaveLength(1)
  })

  it('if something is missing, it throws with what is missing and generates nothing', () => {
    const p = product({ variants: wine.variants, groups: [group()] })
    expect(() => itemData(catalog, p, null, {})).toThrow('Falta elegir: tamaño, punto de cocción')
  })

  it('each call generates a new item_id', () => {
    const p = product()
    expect(itemData(catalog, p, null, {}).item_id).not.toBe(itemData(catalog, p, null, {}).item_id)
  })

  it('the data passes the ItemAdded event schema', async () => {
    const { validateNewEvent } = await import('@pos/core')
    const g = group()
    const p = product({ variants: wine.variants, groups: [g] })
    const data = itemData(catalog, p, 'V-COPA', { [g.id]: ['O-1'] })
    // The schema requires ULIDs in product, variant and modifier: they are tested with real ids.
    const real = { ...data, product_id: newId(), variant_id: newId() }
    real.modifiers = real.modifiers.map((m) => ({ ...m, modifier_id: newId() }))
    const event = local('ItemAdded', newId(), real, 'pending').event
    expect(validateNewEvent(event).ok).toBe(true)
  })
})

describe('ticketsByStation', () => {
  const orderId = newId()
  const inKitchen = newId()
  const atBar = newId()
  const withoutStation = newId()

  function stateWith(products: string[]) {
    const events = [
      local('OrderOpened', orderId, opening),
      ...products.map((product_id) => local('ItemAdded', orderId, copy({ product_id }), 'pending')),
    ]
    const status = rebuild(
      events.map((l) => l.event),
      orderId,
    )
    if (!status) throw new Error('no state')
    return status
  }

  const catalog: Catalog = testCatalog({
    categories: [
      {
        id: 'C1',
        name: 'Pizzas',
        stationId: 'E-COCINA',
        products: [product({ id: inKitchen })],
      },
      { id: 'C2', name: 'Tragos', stationId: 'E-BARRA', products: [product({ id: atBar })] },
      { id: 'C3', name: 'Varios', stationId: null, products: [product({ id: withoutStation })] },
    ],
  })

  it('one ticket per station, with the items of each one', () => {
    const status = stateWith([inKitchen, atBar, inKitchen])
    const r = ticketsByStation(catalog, status)
    expect(r?.tickets).toHaveLength(2)
    const kitchen = r?.tickets.find((c) => c.station_id === 'E-COCINA')
    const bar = r?.tickets.find((c) => c.station_id === 'E-BARRA')
    expect(kitchen?.item_ids).toHaveLength(2)
    expect(bar?.item_ids).toHaveLength(1)
    expect(new Set(r?.tickets.map((c) => c.ticket_id)).size).toBe(2)
    // Every pending item goes out in some ticket, without repeating.
    const sentList = r?.tickets.flatMap((c) => c.item_ids) ?? []
    expect(new Set(sentList)).toEqual(new Set(pendingSend(status).map((i) => i.id)))
  })

  it('a category without a station goes to the first station of the restaurant', () => {
    const r = ticketsByStation(catalog, stateWith([withoutStation]))
    expect(r?.tickets.map((c) => c.station_id)).toEqual(['E-COCINA'])
  })

  it('a product no longer in the catalog also goes to the first station', () => {
    const r = ticketsByStation(catalog, stateWith([newId()]))
    expect(r?.tickets.map((c) => c.station_id)).toEqual(['E-COCINA'])
  })

  it('without stations in the restaurant there is nowhere to send items of a category without a station', () => {
    const without = { ...catalog, stations: [] }
    expect(ticketsByStation(without, stateWith([withoutStation]))).toBeNull()
    // What does have its own station (even if the restaurant lists none) keeps working.
    expect(ticketsByStation(without, stateWith([atBar]))?.tickets).toHaveLength(1)
  })

  it('if any item has nowhere to go, nothing is sent (not even what could be)', () => {
    const without = { ...catalog, stations: [] }
    expect(ticketsByStation(without, stateWith([inKitchen, withoutStation]))).toBeNull()
  })

  it('without items to send it returns null', () => {
    expect(ticketsByStation(catalog, stateWith([]))).toBeNull()
  })

  it('what was already sent does not go out again', () => {
    const aggregate = copy({ product_id: inKitchen })
    const itemId = aggregate.item_id
    const events = [
      local('OrderOpened', orderId, opening),
      local('ItemAdded', orderId, aggregate, 'pending'),
    ]
    events.push(
      local(
        'ItemsSent',
        orderId,
        { tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [itemId] }] },
        'pending',
      ),
    )
    const status = rebuild(
      events.map((l) => l.event),
      orderId,
    )
    expect(status?.items[itemId]?.status).toBe('sent')
    expect(ticketsByStation(catalog, status as never)).toBeNull()
  })
})

describe('selectedPrice', () => {
  const g = group({ minimum: 0, maximum: 3 })

  it('simple product: its price', () => {
    expect(selectedPrice(product({ price: 12_000 }), null, {})).toBe(12_000)
  })

  it('the variant replaces the base price and the extras are added', () => {
    const p = product({ variants: wine.variants, groups: [g] })
    expect(selectedPrice(p, 'V-BOTELLA', {})).toBe(98_000)
    expect(selectedPrice(p, 'V-COPA', { [g.id]: ['O-3'] })).toBe(27_000)
    expect(selectedPrice(p, 'V-COPA', { [g.id]: ['O-3', 'O-1'] })).toBe(27_000)
  })

  it('without a chosen variant it uses the product price; a foreign id adds nothing', () => {
    const p = product({ price: 20_000, variants: wine.variants, groups: [g] })
    expect(selectedPrice(p, null, { [g.id]: ['AJENA'] })).toBe(20_000)
  })

  it('matches what the order charges for the saved item', async () => {
    const { rebuild, orderTotals } = await import('@pos/core')
    const p = product({ variants: wine.variants, groups: [g] })
    const selectedIds = { [g.id]: ['O-3'] }
    const orderId = newId()
    const real = { ...itemData(testCatalog(), p, 'V-COPA', selectedIds), product_id: newId() }
    real.variant_id = newId()
    real.modifiers = real.modifiers.map((m) => ({ ...m, modifier_id: newId() }))
    const status = rebuild(
      [
        local('OrderOpened', orderId, opening).event,
        local('ItemAdded', orderId, real, 'pending').event,
      ],
      orderId,
    )
    expect(orderTotals(status as never).net).toBe(selectedPrice(p, 'V-COPA', selectedIds))
  })
})

describe('copyOf', () => {
  it('repeats the item with a new id and the given catalog version', () => {
    const orderId = newId()
    const original = copy({
      product_id: newId(),
      name: 'Pizza',
      quantity: 2,
      guest: 3,
      course: 'main',
      notes: 'sin cebolla',
      modifiers: [{ modifier_id: newId(), name: 'Extra queso', extra_price: 3_000 }],
    })
    const status = rebuild(
      [local('OrderOpened', orderId, opening).event, local('ItemAdded', orderId, original).event],
      orderId,
    )
    const item = status?.items[original.item_id]
    if (!item) throw new Error('no item')
    const c = copyOf(item, 9)
    expect(c.item_id).not.toBe(original.item_id)
    expect(c).toEqual({ ...original, item_id: c.item_id, catalog_version: 9 })
  })
})
