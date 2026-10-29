import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId } from '@pos/core'
import type { SqliteDatabase } from '@pos/db'
import { afterEach, describe, expect, it } from 'vitest'
import { hubInDir, OPEN_ORDER, setupHub } from '../access/hub-setup'
import { readMenu } from './menu'
import { seed } from './seed'

// The order uses what task 0.8 seeded: each item copies product, price, tax and modifiers from
// the catalog and travels through the sync hub with its `catalog_version`.

const MENU_TEXT = readFileSync(
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)
const NOW = '2026-10-24T20:00:00.000Z'

const getRow = (db: SqliteDatabase, sql: string, ...p: string[]) => {
  const row = db.prepare(sql).get(...p)
  if (!row) throw new Error(`No result: ${sql}`)
  return row
}
const catalogVersion = (db: SqliteDatabase) =>
  Number(getRow(db, "SELECT value FROM counters WHERE name = 'catalog'").value)

/** The item the app would build when tapping that product: all copied from the seeded database. */
function catalogItem(
  db: SqliteDatabase,
  product: string,
  options: { variant?: string; modifiers?: string[] } = {},
) {
  const p = getRow(
    db,
    `SELECT p.id, p.name, p.price, i.type, i.rate FROM products p
     JOIN taxes i ON i.id = p.tax_id WHERE p.name = ? AND p.active = 1`,
    product,
  )
  const v = options.variant
    ? getRow(
        db,
        'SELECT id, price FROM variants WHERE product_id = ? AND name = ?',
        String(p.id),
        options.variant,
      )
    : null
  const modifiers = (options.modifiers ?? []).map((name) => {
    const m = getRow(
      db,
      `SELECT m.id, m.name, m.extra_price FROM modifiers m
       JOIN product_modifier_groups pg ON pg.group_id = m.group_id
       WHERE pg.product_id = ? AND m.name = ?`,
      String(p.id),
      name,
    )
    return {
      modifier_id: String(m.id),
      name: String(m.name),
      extra_price: Number(m.extra_price),
    }
  })
  return {
    item_id: newId(),
    product_id: String(p.id),
    variant_id: v ? String(v.id) : null,
    name: options.variant ? `${product} (${options.variant})` : product,
    unit_price: Number(v ? v.price : p.price),
    tax_type: String(p.type) as 'inc',
    rate: Number(p.rate),
    quantity: 1,
    guest: null,
    course: null,
    modifiers,
    notes: null,
    catalog_version: catalogVersion(db),
    price_channel_id: null,
  }
}

function seededHub() {
  const m = setupHub()
  const r = seed(
    m.db,
    m.access,
    { restaurantId: m.restaurantId, roles: m.roles, menu: readMenu(MENU_TEXT) },
    NOW,
  )
  const waiterPin = r.pins.find((p) => p.name === 'Mesero 1')?.pin as string
  const { connection } = m.pair('waiter')
  const session = m.access.startSession(connection, waiterPin)
  if (!session.ok) throw new Error(session.message)
  return { m, connection, session, r }
}

describe('the order uses what was seeded', () => {
  it('the seed waiter signs in with their PIN and adds wine by the bottle, a dish without options and a flavor', () => {
    const { m, connection, session } = seededHub()
    const order = newId()
    const bottle = catalogItem(m.db, 'Ramón Bilbao Crianza', { variant: 'Botella' })
    const glass = catalogItem(m.db, 'Ramón Bilbao Crianza', { variant: 'Copa' })
    const pizza = catalogItem(m.db, 'Quattro Formaggi')
    const tea = catalogItem(m.db, 'Té Hatsu', { modifiers: ['Rojo'] })
    expect([bottle.unit_price, glass.unit_price, pizza.unit_price]).toEqual([
      129_900, 30_900, 44_900,
    ])
    expect(tea.modifiers).toHaveLength(1)

    const en = { aggregate_id: order }
    const r = m.hub.receiveBatch(connection, [
      m.event(connection, session, 'OrderOpened', OPEN_ORDER, en),
      ...[bottle, glass, pizza, tea].map((it, i) =>
        m.event(connection, session, 'ItemAdded', it, { ...en, base_sequence: i + 1 }),
      ),
    ])
    expect(r.results.map((x) => x.status)).toEqual(Array(5).fill('confirmed'))

    const items = m.hub.order(order)?.items ?? {}
    expect(items[bottle.item_id]).toMatchObject({
      variantId: bottle.variant_id,
      unitPrice: 129_900,
      taxType: 'inc',
      rate: 800,
    })
    expect(items[pizza.item_id]).toMatchObject({
      productId: pizza.product_id,
      unitPrice: 44_900,
    })
    expect(items[tea.item_id]?.modifiers).toEqual([
      expect.objectContaining({ name: 'Rojo', extraPrice: 0 }),
    ])
  })

  it('a dish with doneness carries the chosen doneness as a free modifier', () => {
    const { m, connection, session } = seededHub()
    const order = newId()
    const burger = catalogItem(m.db, 'Spritz Burguer', { modifiers: ['Tres cuartos'] })
    const r = m.hub.receiveBatch(connection, [
      m.event(connection, session, 'OrderOpened', OPEN_ORDER, { aggregate_id: order }),
      m.event(connection, session, 'ItemAdded', burger, {
        aggregate_id: order,
        base_sequence: 1,
      }),
    ])
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(m.hub.order(order)?.items[burger.item_id]?.modifiers[0]).toMatchObject({
      name: 'Tres cuartos',
      extraPrice: 0,
    })
  })

  it('the stored event keeps the `catalog_version` it was added with, and a new menu does not change it', () => {
    const { m, connection, session } = seededHub()
    const order = newId()
    const before = catalogItem(m.db, 'Quattro Formaggi')
    m.hub.receiveBatch(connection, [
      m.event(connection, session, 'OrderOpened', OPEN_ORDER, { aggregate_id: order }),
      m.event(connection, session, 'ItemAdded', before, { aggregate_id: order, base_sequence: 1 }),
    ])

    // The restaurant raises the price: the seed runs again and the counter advances.
    seed(
      m.db,
      m.access,
      {
        restaurantId: m.restaurantId,
        roles: m.roles,
        menu: readMenu(MENU_TEXT.replace('precio: 44900', 'precio: 46900')),
      },
      '2026-10-25T09:00:00.000Z',
    )
    const after = catalogItem(m.db, 'Quattro Formaggi')
    expect(after.catalog_version).toBeGreaterThan(before.catalog_version)
    expect(after.unit_price).toBe(46_900)
    expect(after.product_id).toBe(before.product_id)

    const r = m.hub.receiveBatch(connection, [
      m.event(connection, session, 'ItemAdded', after, {
        aggregate_id: order,
        base_sequence: 2,
      }),
    ])
    expect(r.results[0]?.status).toBe('confirmed')

    const savedList = m.db
      .prepare("SELECT data FROM events WHERE type = 'ItemAdded' ORDER BY sequence")
      .all()
      .map((f) => JSON.parse(String(f.data)))
    expect(savedList.map((d) => [d.catalog_version, d.unit_price])).toEqual([
      [before.catalog_version, 44_900],
      [after.catalog_version, 46_900],
    ])
    // The old item keeps its price: what is charged is what the guest saw when ordering.
    expect(m.hub.order(order)?.items[before.item_id]?.unitPrice).toBe(44_900)
  })

  it('an item whose variant price differs from another variant does not mix: each carries its ID', () => {
    const { m } = seededHub()
    const bottle = catalogItem(m.db, 'Ramón Bilbao Verdejo', { variant: 'Botella' })
    const glass = catalogItem(m.db, 'Ramón Bilbao Verdejo', { variant: 'Copa' })
    expect(bottle.product_id).toBe(glass.product_id)
    expect(bottle.variant_id).not.toBe(glass.variant_id)
    expect(bottle.unit_price).toBeGreaterThan(glass.unit_price)
  })
})

describe('the hub starts after the seed', () => {
  let folder = ''
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('reopening the data folder leaves everything intact: same restaurant, same PINs and a seed with no changes', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-seed-hub-'))
    const hubs = hubInDir(join(folder, 'data'))
    try {
      const a = hubs.spinUp()
      const r = seed(
        a.db,
        a.access,
        { restaurantId: a.restaurantId, roles: a.roles, menu: readMenu(MENU_TEXT) },
        hubs.clock(),
      )
      const code = a.access.createPairing(
        { pin: a.admin.pin as string, name: 'Celular', type: 'waiter' },
        null,
      )
      if (!code.ok) throw new Error(code.message)
      const paired = a.access.pair(code.code, '10.0.0.9')
      if (!paired.ok) throw new Error(paired.message)
      const token = paired.token
      const products = getRow(a.db, 'SELECT count(*) AS n FROM products').n
      const versions = catalogVersion(a.db)
      hubs.shutDown()
      hubs.advance(60_000)

      const b = hubs.spinUp()
      expect(b.restaurantId).toBe(a.restaurantId)
      expect(b.admin).toEqual({ pin: null, user: null, password: null, alerts: [] })
      expect(b.newKey).toBe(false)
      expect(getRow(b.db, 'SELECT count(*) AS n FROM products').n).toBe(products)
      expect(getRow(b.db, 'SELECT count(*) AS n FROM users WHERE active = 1').n).toBe(6)
      expect(getRow(b.db, 'SELECT name FROM restaurants').name).toBe('La Spritzzería')
      expect(catalogVersion(b.db)).toBe(versions)

      // The paired device and a seed waiter PIN are still valid with the hub restarted.
      const connection = b.access.authenticate(token)
      expect(connection).not.toBeNull()
      const waiter = r.pins.find((p) => p.name === 'Mesero 2')?.pin as string
      expect(
        b.access.startSession(connection as NonNullable<typeof connection>, waiter),
      ).toMatchObject({
        ok: true,
      })

      // And a new seed changes nothing.
      const another = seed(
        b.db,
        b.access,
        { restaurantId: b.restaurantId, roles: b.roles, menu: readMenu(MENU_TEXT) },
        hubs.clock(),
      )
      for (const [tableName, changes] of Object.entries(another.sqlTables))
        expect({ tableName, created: changes.created, updated: changes.updated }).toEqual({
          tableName,
          created: 0,
          updated: 0,
        })
      expect(another.pins).toEqual([])
      expect(catalogVersion(b.db)).toBe(versions)
    } finally {
      hubs.shutDown()
    }
  })
})
