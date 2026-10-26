import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { newId } from '@pos/core'
import { HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { describe, expect, it } from 'vitest'
import { updateVersioned } from './access/records'
import { setupAccess } from './access/setup'
import { readCatalog } from './catalog'
import { CatalogHistory, priceChecker } from './prices'
import { readMenu } from './seed/menu'
import { seed } from './seed/seed'

// The copied price is compared with the catalog at the version the device saw, on the pilot's
// real menu (docs/DINERO.md#precio-copiado).

const MENU = readMenu(
  readFileSync(
    fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)

function setup() {
  const m = setupAccess()
  seed(
    m.db,
    m.access,
    { restaurantId: m.restaurantId, roles: m.roles, menu: MENU, withoutStaff: true },
    m.clock(),
  )
  const catalog = readCatalog(m.db, m.restaurantId)
  const products = catalog.categories.flatMap((c) => c.products)
  const product = (name: string) => {
    const p = products.find((x) => x.name === name)
    if (!p) throw new Error(`Missing ${name}`)
    return p
  }
  const history = new CatalogHistory(m.db, m.restaurantId)
  return { ...m, catalog, product, history }
}

type Setup = ReturnType<typeof setup>
type Product = ReturnType<Setup['product']>

const data = (m: Setup, p: Product, fields: Record<string, unknown> = {}) => ({
  item_id: newId(),
  product_id: p.id,
  variant_id: null as string | null,
  name: p.name,
  unit_price: p.price,
  tax_type: p.tax.type,
  rate: p.tax.rate,
  quantity: 1,
  guest: null,
  course: null,
  modifiers: [] as { modifier_id: string; name: string; extra_price: number }[],
  notes: null,
  catalog_version: m.catalog.version,
  price_channel_id: null,
  ...fields,
})

const item = (d: ReturnType<typeof data>) =>
  ({ type: 'ItemAdded', data: d }) as Parameters<CatalogHistory['variance']>[0]

describe('copied price against the catalog history', () => {
  it('an item that matches the menu has no variance', () => {
    const m = setup()
    expect(m.history.variance(item(data(m, m.product('Burrata Spritz'))))).toBeNull()
  })

  it("with glass and bottle: requires the variant and its price, not the product's", () => {
    const m = setup()
    const wine = m.product('Ramón Bilbao Crianza')
    const [glass, bottle] = wine.variants as [Product['variants'][0], Product['variants'][0]]
    expect(m.history.variance(item(data(m, wine)))).toMatch(/sin elegir una de sus opciones/)
    const withBottle = data(m, wine, { variant_id: bottle.id, unit_price: bottle.price })
    expect(m.history.variance(item(withBottle))).toBeNull()
    // The bottle charged at the glass price.
    const cheap = data(m, wine, { variant_id: bottle.id, unit_price: glass.price })
    expect(m.history.variance(item(cheap))).toMatch(/se cobró a \$/)
  })

  it('a variant on a product without variants, or from another product, does not match', () => {
    const m = setup()
    const wine = m.product('Ramón Bilbao Crianza')
    const pizza = m.product('Burrata Spritz')
    const foreign = data(m, pizza, { variant_id: wine.variants[0]?.id })
    expect(m.history.variance(item(foreign))).toMatch(/opción que el producto no tiene/)
  })

  it('price, tax and extras are compared', () => {
    const m = setup()
    const tagliata = m.product('Tagliata di Manzo')
    const doneness = tagliata.groups[0]?.options[0]
    if (!doneness) throw new Error('The Tagliata must have doneness')
    const withDoneness = (extra_price: number) =>
      data(m, tagliata, {
        modifiers: [{ modifier_id: doneness.id, name: doneness.name, extra_price }],
      })
    expect(m.history.variance(item(withDoneness(doneness.extraPrice)))).toBeNull()
    expect(m.history.variance(item(withDoneness(doneness.extraPrice + 500)))).toMatch(
      /La opción «.+» se cobró/,
    )
    const otherTax = data(m, tagliata, { rate: 1900 })
    expect(m.history.variance(item(otherTax))).toMatch(/impuesto/)
    const cheaper = data(m, tagliata, { unit_price: tagliata.price - 100 })
    expect(m.history.variance(item(cheaper))).toMatch(/la carta decía/)
    const ghost = data(m, tagliata, {
      modifiers: [{ modifier_id: newId(), name: 'Trufa', extra_price: 0 }],
    })
    expect(m.history.variance(item(ghost))).toMatch(/no estaba en la carta/)
  })

  it('the version the device saw counts: the old price is valid with the old version', () => {
    const m = setup()
    const burrata = m.product('Burrata Spritz')
    const before = m.catalog.version
    updateVersioned(
      m.db,
      'products',
      m.restaurantId,
      burrata.id,
      { price: burrata.price + 2_000 },
      { userId: null, deviceId: null },
      m.clock(),
    )
    const after = m.history.currentVersion()
    expect(after).toBeGreaterThan(before)
    // Offline device with the old menu: its price was the right one.
    expect(m.history.variance(item(data(m, burrata)))).toBeNull()
    // With the new menu, the old price no longer matches.
    const late = data(m, burrata, { catalog_version: after })
    expect(m.history.variance(item(late))).toMatch(/la carta decía/)
    const fresh = data(m, burrata, {
      catalog_version: after,
      unit_price: burrata.price + 2_000,
    })
    expect(m.history.variance(item(fresh))).toBeNull()
  })

  it('an archived product or a version the hub does not have do not match', () => {
    const m = setup()
    const burrata = m.product('Burrata Spritz')
    expect(
      m.history.variance(item(data(m, burrata, { catalog_version: m.catalog.version + 1 }))),
    ).toMatch(/versión del catálogo/)
    updateVersioned(
      m.db,
      'products',
      m.restaurantId,
      burrata.id,
      { active: 0 },
      { userId: null, deviceId: null },
      m.clock(),
    )
    const v = m.history.currentVersion()
    expect(m.history.variance(item(data(m, burrata, { catalog_version: v })))).toMatch(
      /no estaba en la carta/,
    )
    expect(m.history.variance(item(data(m, burrata, { catalog_version: 0 })))).toMatch(
      /no estaba en la carta/,
    )
  })

  it('an option from another product, a repeated one or a special price do not match', () => {
    const m = setup()
    const tagliata = m.product('Tagliata di Manzo')
    const tea = m.product('Té Hatsu')
    const flavor = tea.groups[0]?.options[0]
    const doneness = tagliata.groups[0]?.options[0]
    if (!flavor || !doneness) throw new Error('missing')
    const mod = (o: { id: string; name: string; extraPrice: number }) => ({
      modifier_id: o.id,
      name: o.name,
      extra_price: o.extraPrice,
    })
    expect(m.history.variance(item(data(m, tagliata, { modifiers: [mod(flavor)] })))).toMatch(
      /no es de «Tagliata/,
    )
    expect(
      m.history.variance(item(data(m, tagliata, { modifiers: [mod(doneness), mod(doneness)] }))),
    ).toMatch(/dos veces/)
    expect(
      m.history.variance(
        item(data(m, tagliata, { modifiers: [mod(doneness)], price_channel_id: newId() })),
      ),
    ).toMatch(/precio especial/)
  })

  it('an archived tax does not match', () => {
    const m = setup()
    const burrata = m.product('Burrata Spritz')
    const tax = String(
      m.db.prepare('SELECT tax_id FROM products WHERE id = ?').get(burrata.id)?.tax_id,
    )
    updateVersioned(
      m.db,
      'taxes',
      m.restaurantId,
      tax,
      { active: 0 },
      { userId: null, deviceId: null },
      m.clock(),
    )
    const v = m.history.currentVersion()
    expect(m.history.variance(item(data(m, burrata, { catalog_version: v })))).toMatch(/impuesto/)
  })

  it('in the hub: the item with a mismatched price is accepted and stays as a conflict', () => {
    const m = setup()
    const hub = new HubSync(new SqliteStore(m.db, m.restaurantId), {
      restaurantId: m.restaurantId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      instance: 'hub-1',
      clock: m.clock,
      access: {
        verify: () => ({ ok: true, authorizedById: null, authorizationId: null }),
        recordUse: () => {},
      },
      prices: priceChecker(m.db, m.restaurantId),
    })
    const { connection } = m.pair('waiter')
    const order = newId()
    const burrata = m.product('Burrata Spritz')
    const envelope = (type: string, d: unknown, base_sequence: number) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: order,
      related: [],
      data: d,
      session_id: null,
      user_id: newId(),
      device_id: connection.deviceId,
      authorization_id: null,
      reason: null,
      device_time: m.clock(),
      hub_estimated_time: m.clock(),
      base_sequence,
    })
    const r = hub.receiveBatch(connection, [
      envelope('OrderOpened', { channel: 'dine_in', table_id: null, guests: 2 }, 0),
      envelope('ItemAdded', data(m, burrata), 1),
      envelope('ItemAdded', data(m, burrata, { unit_price: 1_000 }), 1),
    ])
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    expect(r.results.map((x) => (x as { conflict?: string | null }).conflict ?? null)).toEqual([
      null,
      null,
      'price_mismatch',
    ])
    expect(hub.conflicts()).toEqual([
      expect.objectContaining({
        type: 'price_mismatch',
        description: expect.stringMatching(/\$1\.000/),
      }),
    ])
  })
})
