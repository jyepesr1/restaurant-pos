import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { type Author, insertVersioned, updateVersioned } from './access/records'
import { setupMenu } from './catalog-fixtures'
import { CatalogHistory, priceChecker } from './prices'

// The catalog history and the check of the copied price when the catalog changed between the
// version the device saw and the one the hub has (docs/DINERO.md#precio-copiado).

const AUTHOR: Author = { userId: null, deviceId: null }

function setup() {
  const m = setupMenu()
  const history = new CatalogHistory(m.db, m.restaurantId)
  const patch = (tableName: string, id: string, fields: Record<string, string | number | null>) => {
    updateVersioned(m.db, tableName, m.restaurantId, id, fields, AUTHOR, m.clock())
    return history.currentVersion()
  }
  const create = (tableName: string, fields: Record<string, string | number | null>) => {
    const id = insertVersioned(m.db, tableName, m.restaurantId, fields, AUTHOR, m.clock())
    return { id, version: history.currentVersion() }
  }
  const data = (p: ReturnType<typeof m.product>, fields: Record<string, unknown> = {}) => ({
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
    catalog_version: history.currentVersion(),
    price_channel_id: null,
    ...fields,
  })
  const variance = (d: ReturnType<typeof data>) =>
    history.variance({ type: 'ItemAdded', data: d } as Parameters<CatalogHistory['variance']>[0])
  return { ...m, history, patch, create, data, variance }
}

describe('history with many changes to the same record', () => {
  it('each version returns the price it had, and between versions the latest earlier one', () => {
    const m = setup()
    const burrata = m.product('Burrata Spritz')
    const versions: { version: number; price: number }[] = [
      { version: m.history.currentVersion(), price: burrata.price },
    ]
    for (let i = 1; i <= 300; i++) {
      const price = burrata.price + i * 100
      versions.push({ version: m.patch('products', burrata.id, { price }), price })
      // A change to another record in between: the version moves on without touching the burrata.
      if (i % 7 === 0) m.create('stations', { name: `Estación ${i}`, position: i })
    }
    for (const { version, price } of versions)
      expect(m.history.stateIn('products', burrata.id, version)?.price, `v${version}`).toBe(price)
    // A version between two product changes takes the value of the earlier change.
    const [a, b] = [versions[7], versions[8]]
    if (!a || !b) throw new Error('missing')
    for (let v = a.version; v < b.version; v++)
      expect(m.history.stateIn('products', burrata.id, v)?.price).toBe(a.price)
  })

  it('each row stores as "before" the "after" of the previous one and versions only go up', () => {
    const m = setup()
    const burrata = m.product('Burrata Spritz')
    for (let i = 1; i <= 120; i++) m.patch('products', burrata.id, { price: 1_000 + i })
    const rows = m.db
      .prepare('SELECT * FROM catalog_changes WHERE record_id = ? ORDER BY version')
      .all(burrata.id)
    expect(rows).toHaveLength(121)
    expect(rows[0]?.before).toBeNull()
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.before).toBe(rows[i - 1]?.after)
      expect(Number(rows[i]?.version)).toBeGreaterThan(Number(rows[i - 1]?.version))
    }
    const allRows = m.db.prepare('SELECT version FROM catalog_changes').all()
    expect(new Set(allRows.map((f) => f.version)).size).toBe(allRows.length)
  })

  it('there is no state before the record existed', () => {
    const m = setup()
    const { id, version } = m.create('stations', { name: 'Nueva', position: 9 })
    expect(m.history.stateIn('stations', id, version - 1)).toBeUndefined()
    expect(m.history.stateIn('stations', id, 0)).toBeUndefined()
    expect(m.history.stateIn('stations', id, version)?.name).toBe('Nueva')
    expect(m.history.stateIn('stations', newId(), version)).toBeUndefined()
    // With the wrong entity, the same id does not exist.
    expect(m.history.stateIn('products', id, version)).toBeUndefined()
  })

  it("another restaurant's records do not mix in", () => {
    const m = setup()
    const other = new CatalogHistory(m.db, newId())
    const burrata = m.product('Burrata Spritz')
    expect(other.stateIn('products', burrata.id, m.history.currentVersion())).toBeUndefined()
    expect(other.currentVersion()).toBe(0)
  })

  it('the history with the migrated catalog matches what each table has today', () => {
    const m = setup()
    for (const p of m.catalog().categories.flatMap((c) => c.products)) {
      const row = m.db.prepare('SELECT * FROM products WHERE id = ?').get(p.id)
      expect(m.history.stateIn('products', p.id, m.history.currentVersion())).toEqual(row)
    }
  })
})

describe('price_mismatch with the catalog changed afterwards', () => {
  it('a variant archived afterwards: the old item matches, the new one no longer does', () => {
    const m = setup()
    const wine = m.product('Ramón Bilbao Crianza')
    const [glass, bottle] = wine.variants
    if (!glass || !bottle) throw new Error('missing')
    const bottleItem = (extra = {}) =>
      m.data(wine, { variant_id: bottle.id, unit_price: bottle.price, ...extra })
    const oldVersion = m.history.currentVersion()
    expect(m.variance(bottleItem())).toBeNull()

    const v = m.patch('variants', bottle.id, { active: 0 })
    // The device still on the old menu sold the bottle: it matches its version.
    expect(m.variance(bottleItem({ catalog_version: oldVersion }))).toBeNull()
    // With the version where it was already archived, the bottle does not exist.
    expect(m.variance(bottleItem({ catalog_version: v }))).toMatch(/sin elegir una de sus opciones/)
    // The glass is still there.
    expect(
      m.variance(
        m.data(wine, { variant_id: glass.id, unit_price: glass.price, catalog_version: v }),
      ),
    ).toBeNull()
  })

  it('archiving all variants: the product is sold without an option again', () => {
    const m = setup()
    const wine = m.product('Ramón Bilbao Crianza')
    let v = 0
    for (const variant of wine.variants) v = m.patch('variants', variant.id, { active: 0 })
    expect(m.variance(m.data(wine, { catalog_version: v }))).toBeNull()
    expect(
      m.variance(m.data(wine, { variant_id: wine.variants[0]?.id, catalog_version: v })),
    ).toMatch(/opción que el producto no tiene/)
  })

  it('a variant whose price changed between versions', () => {
    const m = setup()
    const wine = m.product('Ramón Bilbao Crianza')
    const bottle = wine.variants[1]
    if (!bottle) throw new Error('missing')
    const before = m.history.currentVersion()
    const after = m.patch('variants', bottle.id, { price: bottle.price + 10_000 })
    const item = (price: number, catalog_version: number) =>
      m.data(wine, { variant_id: bottle.id, unit_price: price, catalog_version })
    expect(m.variance(item(bottle.price, before))).toBeNull()
    expect(m.variance(item(bottle.price + 10_000, before))).toMatch(/la carta decía/)
    expect(m.variance(item(bottle.price, after))).toMatch(/la carta decía/)
    expect(m.variance(item(bottle.price + 10_000, after))).toBeNull()
  })

  it('a variant created afterwards: with the old version the product did not require an option', () => {
    const m = setup()
    const pizza = m.product('Burrata Spritz')
    const before = m.history.currentVersion()
    const familyVariant = m.create('variants', {
      product_id: pizza.id,
      name: 'Familiar',
      price: 90_000,
      position: 0,
    })
    expect(m.variance(m.data(pizza, { catalog_version: before }))).toBeNull()
    expect(m.variance(m.data(pizza, { catalog_version: familyVariant.version }))).toMatch(
      /sin elegir una de sus opciones/,
    )
    expect(
      m.variance(
        m.data(pizza, {
          catalog_version: familyVariant.version,
          variant_id: familyVariant.id,
          unit_price: 90_000,
        }),
      ),
    ).toBeNull()
    // The variant did not exist yet in the old version.
    expect(
      m.variance(
        m.data(pizza, {
          catalog_version: before,
          variant_id: familyVariant.id,
          unit_price: 90_000,
        }),
      ),
    ).toMatch(/opción que el producto no tiene/)
  })

  it('a modifier whose price changed between versions', () => {
    const m = setup()
    const tagliata = m.product('Tagliata di Manzo')
    const option = tagliata.groups[0]?.options[0]
    if (!option) throw new Error('missing')
    const before = m.history.currentVersion()
    const after = m.patch('modifiers', option.id, {
      extra_price: option.extraPrice + 2_500,
    })
    const item = (extra: number, catalog_version: number) =>
      m.data(tagliata, {
        catalog_version,
        modifiers: [{ modifier_id: option.id, name: option.name, extra_price: extra }],
      })
    expect(m.variance(item(option.extraPrice, before))).toBeNull()
    expect(m.variance(item(option.extraPrice, after))).toMatch(/La opción «.+» se cobró/)
    expect(m.variance(item(option.extraPrice + 2_500, after))).toBeNull()
    expect(m.variance(item(option.extraPrice + 2_500, before))).toMatch(/La opción «.+» se cobró/)
  })

  it('a modifier archived afterwards was no longer on the menu; before, it was', () => {
    const m = setup()
    const tagliata = m.product('Tagliata di Manzo')
    const option = tagliata.groups[0]?.options[0]
    if (!option) throw new Error('missing')
    const before = m.history.currentVersion()
    const after = m.patch('modifiers', option.id, { active: 0 })
    const item = (catalog_version: number) =>
      m.data(tagliata, {
        catalog_version,
        modifiers: [{ modifier_id: option.id, name: option.name, extra_price: option.extraPrice }],
      })
    expect(m.variance(item(before))).toBeNull()
    expect(m.variance(item(after))).toMatch(/no estaba en la carta/)
  })

  it('a changed tax: the old rate is valid with the old version', () => {
    const m = setup()
    const pizza = m.product('Burrata Spritz')
    const taxId = String(
      m.db.prepare('SELECT tax_id FROM products WHERE id = ?').get(pizza.id)?.tax_id,
    )
    const before = m.history.currentVersion()
    const after = m.patch('taxes', taxId, { rate: pizza.tax.rate + 100 })
    expect(m.variance(m.data(pizza, { catalog_version: before }))).toBeNull()
    expect(m.variance(m.data(pizza, { catalog_version: after }))).toMatch(/impuesto/)
    expect(
      m.variance(m.data(pizza, { catalog_version: after, rate: pizza.tax.rate + 100 })),
    ).toBeNull()
  })

  it('a product that switched tax (another record) is also detected', () => {
    const m = setup()
    const pizza = m.product('Burrata Spritz')
    const exempt = m.create('taxes', { name: 'Exento', type: 'exempt', rate: 0 })
    const before = m.history.currentVersion()
    const after = m.patch('products', pizza.id, { tax_id: exempt.id })
    expect(m.variance(m.data(pizza, { catalog_version: before }))).toBeNull()
    expect(m.variance(m.data(pizza, { catalog_version: after }))).toMatch(/impuesto/)
    expect(
      m.variance(m.data(pizza, { catalog_version: after, tax_type: 'exempt', rate: 0 })),
    ).toBeNull()
  })

  it('a different tax type with the same rate does not match either', () => {
    const m = setup()
    const pizza = m.product('Burrata Spritz')
    const otherType = pizza.tax.type === 'inc' ? 'iva' : 'inc'
    expect(m.variance(m.data(pizza, { tax_type: otherType }))).toMatch(/impuesto/)
  })

  it("a product created after the item's version was not on the menu", () => {
    const m = setup()
    const base = m.product('Burrata Spritz')
    const tax = String(
      m.db.prepare('SELECT tax_id FROM products WHERE id = ?').get(base.id)?.tax_id,
    )
    const category = String(
      m.db.prepare('SELECT category_id FROM products WHERE id = ?').get(base.id)?.category_id,
    )
    const before = m.history.currentVersion()
    const fresh = m.create('products', {
      category_id: category,
      name: 'Postre nuevo',
      price: 15_000,
      tax_id: tax,
    })
    const howWouldSeeIt = (catalog_version: number) => ({
      ...m.data(base, { catalog_version }),
      product_id: fresh.id,
      name: 'Postre nuevo',
      unit_price: 15_000,
    })
    expect(m.variance(howWouldSeeIt(before))).toMatch(/no estaba en la carta/)
    expect(m.variance(howWouldSeeIt(fresh.version - 1))).toMatch(/no estaba en la carta/)
    expect(m.variance(howWouldSeeIt(fresh.version))).toBeNull()
  })

  it('archived and reactivated: matches before and after, not in the gap', () => {
    const m = setup()
    const pizza = m.product('Burrata Spritz')
    const before = m.history.currentVersion()
    const archived = m.patch('products', pizza.id, { active: 0 })
    const reactivated = m.patch('products', pizza.id, { active: 1 })
    expect(m.variance(m.data(pizza, { catalog_version: before }))).toBeNull()
    expect(m.variance(m.data(pizza, { catalog_version: archived }))).toMatch(
      /no estaba en la carta/,
    )
    expect(m.variance(m.data(pizza, { catalog_version: reactivated }))).toBeNull()
  })

  it('a future version the hub does not have is flagged, whatever the product', () => {
    const m = setup()
    const pizza = m.product('Burrata Spritz')
    const futureTime = m.history.currentVersion() + 1
    expect(m.variance(m.data(pizza, { catalog_version: futureTime }))).toMatch(
      /versión del catálogo/,
    )
    expect(m.variance(m.data(pizza, { catalog_version: Number.MAX_SAFE_INTEGER }))).toMatch(
      /versión del catálogo/,
    )
  })

  it('a product_id that is actually something else in the catalog is flagged', () => {
    const m = setup()
    const pizza = m.product('Burrata Spritz')
    const wine = m.product('Ramón Bilbao Crianza')
    const variant = wine.variants[0]
    const group = m.product('Tagliata di Manzo').groups[0]
    if (!variant || !group) throw new Error('missing')
    for (const id of [variant.id, group.id, group.options[0]?.id, newId()])
      expect(m.variance(m.data(pizza, { product_id: id })), String(id)).not.toBeNull()
  })

  it('with a repeated modifier', () => {
    const m = setup()
    const tagliata = m.product('Tagliata di Manzo')
    const option = tagliata.groups[0]?.options[0]
    if (!option) throw new Error('missing')
    const mod = {
      modifier_id: option.id,
      name: option.name,
      extra_price: option.extraPrice,
    }
    expect(m.variance(m.data(tagliata, { modifiers: [mod] }))).toBeNull()
    expect(m.variance(m.data(tagliata, { modifiers: [mod, mod] }))).toMatch(/viene dos veces/)
  })

  it('priceChecker only looks at ItemAdded', () => {
    const m = setup()
    const checker = priceChecker(m.db, m.restaurantId)
    const pizza = m.product('Burrata Spritz')
    const badCase = m.data(pizza, { unit_price: 1 })
    expect(checker.review({ type: 'ItemAdded', data: badCase } as never)).toMatch(/la carta decía/)
    expect(checker.review({ type: 'OrderOpened', data: {} } as never)).toBeNull()
  })

  it('an item with 200 later price changes still compares against its version', () => {
    const m = setup()
    const pizza = m.product('Burrata Spritz')
    const seenByDevice = m.history.currentVersion()
    for (let i = 1; i <= 200; i++) m.patch('products', pizza.id, { price: pizza.price + i })
    expect(m.variance(m.data(pizza, { catalog_version: seenByDevice }))).toBeNull()
    expect(m.variance(m.data(pizza))).toMatch(/la carta decía/)
  })

  it('a special price (price_channel_id) is flagged: they do not exist yet', () => {
    const m = setup()
    const pizza = m.product('Burrata Spritz')
    expect(m.variance(m.data(pizza, { price_channel_id: newId() }))).toMatch(/precio especial/)
  })

  it('a tax archived afterwards does not match with the new version, but does with the old one', () => {
    const m = setup()
    const pizza = m.product('Burrata Spritz')
    const taxId = String(
      m.db.prepare('SELECT tax_id FROM products WHERE id = ?').get(pizza.id)?.tax_id,
    )
    const before = m.history.currentVersion()
    const after = m.patch('taxes', taxId, { active: 0 })
    expect(m.variance(m.data(pizza, { catalog_version: before }))).toBeNull()
    expect(m.variance(m.data(pizza, { catalog_version: after }))).toMatch(/impuesto/)
  })

  it('an option from an archived group, or from a product without that group, is flagged', () => {
    const m = setup()
    const tagliata = m.product('Tagliata di Manzo')
    const group = tagliata.groups[0]
    const option = group?.options[0]
    if (!group || !option) throw new Error('missing')
    const withOption = (p: ReturnType<typeof m.product>, catalog_version?: number) =>
      m.data(p, {
        ...(catalog_version === undefined ? {} : { catalog_version }),
        modifiers: [{ modifier_id: option.id, name: option.name, extra_price: option.extraPrice }],
      })
    // From another product.
    expect(m.variance(withOption(m.product('Burrata Spritz')))).toMatch(/no es de/)
    // From the group archived afterwards: it was valid before.
    const before = m.history.currentVersion()
    const after = m.patch('modifier_groups', group.id, { active: 0 })
    expect(m.variance(withOption(tagliata, before))).toBeNull()
    expect(m.variance(withOption(tagliata, after))).toMatch(/no es de/)
  })

  it('an option whose link to the product was archived afterwards was valid with the earlier version', () => {
    const m = setup()
    const tagliata = m.product('Tagliata di Manzo')
    const option = tagliata.groups[0]?.options[0]
    if (!option) throw new Error('missing')
    const link = String(
      m.db.prepare('SELECT id FROM product_modifier_groups WHERE product_id = ?').get(tagliata.id)
        ?.id,
    )
    const before = m.history.currentVersion()
    const after = m.patch('product_modifier_groups', link, { active: 0 })
    const item = (catalog_version: number) =>
      m.data(tagliata, {
        catalog_version,
        modifiers: [{ modifier_id: option.id, name: option.name, extra_price: option.extraPrice }],
      })
    expect(m.variance(item(before))).toBeNull()
    expect(m.variance(item(after))).toMatch(/no es de/)
  })
})

describe('history_since: what came before the migration', () => {
  it('before that version the oldest known state is used, not "did not exist"', () => {
    const m = setup()
    const burrata = m.product('Burrata Spritz')
    const createdVersion = Number(
      m.db
        .prepare('SELECT version FROM catalog_changes WHERE record_id = ? AND before IS NULL')
        .get(burrata.id)?.version,
    )
    const v = m.patch('products', burrata.id, { price: burrata.price + 500 })
    // Without `history_since`, a version before its creation does not know it.
    expect(m.history.stateIn('products', burrata.id, createdVersion - 1)).toBeUndefined()
    // Migrating an old database leaves that counter: earlier versions take the oldest state.
    m.db
      .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'history_since', ?)")
      .run(m.restaurantId, v)
    expect(m.history.stateIn('products', burrata.id, createdVersion - 1)?.price).toBe(burrata.price)
    expect(m.history.stateIn('products', burrata.id, v - 1)?.price).toBe(burrata.price)
    // From that version on there is full history.
    expect(m.history.stateIn('products', burrata.id, v)?.price).toBe(burrata.price + 500)
    // What does not exist in any version still does not exist.
    expect(m.history.stateIn('products', newId(), createdVersion - 1)).toBeUndefined()
    // An item from the old version matches the old price.
    expect(m.variance(m.data(burrata, { catalog_version: createdVersion - 1 }))).toBeNull()
  })
})
