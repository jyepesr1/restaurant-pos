import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isValidId, newId } from '@pos/core'
import { applyMigrations, type SqliteDatabase, VERSIONED_TABLES } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { ensureRoles } from '../access/initial'
import type { Change } from '../access/records'
import { insertVersioned, SYSTEM, stableId } from '../access/records'
import { AccessService } from '../access/service'
import { readMenu, rulesWithoutDish } from './menu'
import { STAFF, seed, TABLES } from './seed'

// Additional tests for task 0.8: repeating the seed, several hubs and restaurants, archived
// records, menu changes, variants, flavors, hidden sections and interruptions.

const MENU_TEXT = readFileSync(
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)
const NOW = '2026-10-24T20:00:00.000Z'
const LATER = '2026-10-25T09:30:00.000Z'

/** Tables the seed fills with stable IDs (without staff or roles, which the hub creates). */
const SEED_TABLES = [
  'restaurants',
  'zones',
  'dining_tables',
  'stations',
  'taxes',
  'categories',
  'products',
  'variants',
  'modifier_groups',
  'modifiers',
  'product_modifier_groups',
] as const

const dump = (db: SqliteDatabase, sqlTables: readonly string[]) =>
  Object.fromEntries(sqlTables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]))

const count = (db: SqliteDatabase, sql: string, ...p: string[]) =>
  Number(db.prepare(sql).get(...p)?.n)

/**
 * A freshly installed hub with a restaurant of a given ID (or a new one). The location also has a
 * stable ID so two hubs of the same restaurant can be compared row by row.
 */
function hub(restaurantId = newId(), shared?: SqliteDatabase) {
  const db = shared ?? openDatabase(':memory:')
  if (!shared) applyMigrations(db)
  addRestaurant(db, restaurantId)
  const roles = ensureRoles(db, restaurantId, NOW)
  const access = new AccessService({
    db,
    restaurantId,
    key: Buffer.alloc(32, 3),
    clock: () => NOW,
  })
  const load = (text = MENU_TEXT, now = NOW, withIt: AccessService = access) =>
    seed(db, withIt, { restaurantId, roles, menu: readMenu(text) }, now)
  return { db, access, roles, restaurantId, load }
}

function addRestaurant(db: SqliteDatabase, id: string) {
  db.prepare(
    `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
     VALUES (?, ?, ?, ?, 1, 'Mi restaurante', '{}')`,
  ).run(id, id, NOW, NOW)
  db.prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)").run(id)
  insertVersioned(
    db,
    'locations',
    id,
    { name: 'Principal', address: null, time_zone: 'America/Bogota' },
    SYSTEM,
    NOW,
    stableId(id, 'location:principal'),
  )
}

// Small menus for the edge cases.
const dish = (name: string, price: number, description?: string) => ({
  nombre: { es: name },
  descripcion: description === undefined ? undefined : { es: description },
  precio: price,
})
const section = (key: string, dishes: ReturnType<typeof dish>[], extra = {}) => ({
  clave: key,
  nombre: key,
  grupo: 'barra',
  boton: { es: key },
  platos: dishes,
  ...extra,
})
const menuOf = (...sections: ReturnType<typeof section>[]) => stringify({ secciones: sections })

const FIXED_ID = '01JB0000000000000000000000'

describe('repeating the seed', () => {
  it('five runs with different clocks leave the database identical, with versions and PINs', () => {
    const h = hub()
    h.load(MENU_TEXT, NOW)
    const sqlTables = [...VERSIONED_TABLES, 'counters', 'user_credentials']
    const reference = dump(h.db, sqlTables)

    for (const time of [LATER, '2026-10-26T01:00:00.000Z', '2027-01-01T00:00:00.000Z']) {
      const r = h.load(MENU_TEXT, time)
      expect(r.pins).toEqual([])
      for (const [tableName, c] of Object.entries(r.sqlTables))
        expect({ tableName, ...c, equal: 0, respected: 0 }).toEqual({
          tableName,
          created: 0,
          updated: 0,
          equal: 0,
          respected: 0,
          archived: 0,
        })
    }
    h.load(MENU_TEXT, '2027-06-30T12:00:00.000Z')
    expect(dump(h.db, sqlTables)).toEqual(reference)
  })

  it('the first run summary counts everything as created and the second one everything as unchanged', () => {
    const h = hub()
    const first = h.load()
    const second = h.load(MENU_TEXT, LATER)
    const checks = (c: Partial<Record<Change, number>>) => ({
      created: 0,
      updated: 0,
      equal: 0,
      respected: 0,
      archived: 0,
      ...c,
    })

    expect(first.sqlTables.dining_tables).toEqual(checks({ created: TABLES }))
    expect(first.sqlTables.products).toEqual(checks({ created: 98 }))
    expect(first.sqlTables.users).toEqual(checks({ created: STAFF.length }))
    expect(first.sqlTables.taxes).toEqual(checks({ created: 1 }))
    expect(second.sqlTables.dining_tables).toEqual(checks({ equal: TABLES }))
    expect(second.sqlTables.products).toEqual(checks({ equal: 98 }))
    expect(second.sqlTables.users).toEqual(checks({ equal: STAFF.length }))
    expect(second.sqlTables.restaurants).toEqual(checks({ equal: 1 }))
    // The tax is created only once: afterwards the seed respects it, it does not compare it.
    expect(second.sqlTables.taxes).toEqual(checks({ respected: 1 }))
  })

  it('the catalog counter is the highest `version` and no version repeats', () => {
    const h = hub()
    h.load()
    const versions = VERSIONED_TABLES.flatMap((t) =>
      h.db
        .prepare(`SELECT version FROM ${t}`)
        .all()
        .map((f) => Number(f.version)),
    )
    const counter = Number(
      h.db.prepare("SELECT value FROM counters WHERE name = 'catalog'").get()?.value,
    )
    expect(Math.max(...versions)).toBe(counter)
    // One version per change: two rows with the same version would make "changes since N" ambiguous.
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('the same restaurant on two different hubs gives exactly the same rows', () => {
    const a = hub(FIXED_ID)
    const b = hub(FIXED_ID)
    a.load()
    b.load()
    expect(dump(a.db, SEED_TABLES)).toEqual(dump(b.db, SEED_TABLES))
    // And the seed people have the same IDs (not the PINs).
    expect(dump(a.db, ['locations'])).toEqual(dump(b.db, ['locations']))
    const ids = (h: ReturnType<typeof hub>) =>
      h.db
        .prepare("SELECT id FROM users WHERE name <> 'Administrador' ORDER BY id")
        .all()
        .map((f) => f.id)
    expect(ids(a)).toEqual(ids(b))
  })

  it('the menu order does not change the product IDs', () => {
    const original = readMenu(MENU_TEXT)
    const shuffled = stringify({
      secciones: (parse(MENU_TEXT) as { secciones: { platos: unknown[] }[] }).secciones
        .reverse()
        .map((s) => ({ ...s, platos: [...s.platos].reverse() })),
    })
    const a = hub(FIXED_ID)
    const b = hub(FIXED_ID)
    a.load(MENU_TEXT)
    b.load(shuffled)
    const productIds = (h: ReturnType<typeof hub>) =>
      h.db
        .prepare('SELECT id, name, price FROM products ORDER BY id')
        .all()
        .map((f) => `${f.id}:${f.name}:${f.price}`)
    expect(productIds(b)).toEqual(productIds(a))
    expect(original.flatMap((c) => c.products)).toHaveLength(98)
  })

  it('all seed IDs are valid ULIDs and do not repeat across tables', () => {
    const h = hub()
    h.load()
    const ids = VERSIONED_TABLES.flatMap((t) =>
      h.db
        .prepare(`SELECT id FROM ${t}`)
        .all()
        .map((f) => String(f.id)),
    )
    for (const id of ids) expect(isValidId(id)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('different restaurants', () => {
  it('two restaurants with the same timestamp in the same database do not clash on any ID', () => {
    const other = `${FIXED_ID.slice(0, 10)}ZZZZZZZZZZZZZZZZ`
    const a = hub(FIXED_ID)
    const b = hub(other, a.db)
    a.load()
    b.load()

    expect(
      count(a.db, 'SELECT count(*) AS n FROM products WHERE restaurant_id = ?', FIXED_ID),
    ).toBe(98)
    expect(count(a.db, 'SELECT count(*) AS n FROM products WHERE restaurant_id = ?', other)).toBe(
      98,
    )
    for (const tableName of VERSIONED_TABLES) {
      const ids = a.db
        .prepare(`SELECT id FROM ${tableName}`)
        .all()
        .map((f) => String(f.id))
      expect(new Set(ids).size).toBe(ids.length)
    }
    // Repeating the seed of one does not touch the other.
    const before = dump(a.db, ['products'])
    b.load(MENU_TEXT, LATER)
    expect(dump(a.db, ['products'])).toEqual(before)
  })

  it('with different restaurant ULIDs, the same key gives different IDs even if the prefix is equal', () => {
    const a = stableId(FIXED_ID, 'table:1')
    const b = stableId(`${FIXED_ID.slice(0, 10)}ZZZZZZZZZZZZZZZZ`, 'table:1')
    expect(a.slice(0, 10)).toBe(b.slice(0, 10))
    expect(a).not.toBe(b)
    expect(isValidId(a)).toBe(true)
    expect(isValidId(b)).toBe(true)
  })

  it('the ID depends on the exact key: case and spaces give different IDs', () => {
    const ids = ['table:1', 'table:01', 'Table:1', 'table: 1', 'table:1 '].map((c) =>
      stableId(FIXED_ID, c),
    )
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('records archived by hand', () => {
  const idOf = (h: ReturnType<typeof hub>, key: string) => stableId(h.restaurantId, key)
  const status = (h: ReturnType<typeof hub>, tableName: string, id: string) =>
    h.db.prepare(`SELECT active, version FROM ${tableName} WHERE id = ?`).get(id)

  it('the seed reactivates an archived product, table, category and option', () => {
    const h = hub()
    h.load()
    const targets = [
      ['products', idOf(h, 'product:PIZZAS:quattro-formaggi')],
      ['dining_tables', idOf(h, 'table:7')],
      ['categories', idOf(h, 'category:PIZZAS')],
      ['modifiers', idOf(h, 'modifier:sabor:BEBIDAS:te-hatsu:Rojo')],
    ] as const
    const counterBefore = Number(
      h.db.prepare("SELECT value FROM counters WHERE name = 'catalog'").get()?.value,
    )
    for (const [tableName, id] of targets)
      h.db.prepare(`UPDATE ${tableName} SET active = 0 WHERE id = ?`).run(id)

    const r = h.load(MENU_TEXT, LATER)
    for (const [tableName, id] of targets) {
      expect({ tableName, ...status(h, tableName, id) }).toMatchObject({ tableName, active: 1 })
      expect(Number(status(h, tableName, id)?.version)).toBeGreaterThan(counterBefore)
    }
    expect(r.sqlTables.products).toMatchObject({ created: 0, updated: 1 })
    expect(r.sqlTables.dining_tables).toMatchObject({ created: 0, updated: 1 })
    // Nothing was duplicated.
    expect(count(h.db, 'SELECT count(*) AS n FROM products')).toBe(98)
    expect(count(h.db, 'SELECT count(*) AS n FROM dining_tables')).toBe(TABLES)

    // The next run no longer changes anything.
    const third = h.load(MENU_TEXT, '2026-10-26T09:00:00.000Z')
    expect(third.sqlTables.products).toMatchObject({ updated: 0 })
  })

  it('an archived product whose price also changed comes back with the menu price', () => {
    const h = hub()
    h.load()
    const id = idOf(h, 'product:PIZZAS:quattro-formaggi')
    h.db.prepare('UPDATE products SET active = 0, price = 1 WHERE id = ?').run(id)
    h.load(MENU_TEXT, LATER)
    expect(h.db.prepare('SELECT active, price FROM products WHERE id = ?').get(id)).toEqual({
      active: 1,
      price: 44_900,
    })
  })

  it('an archived seed user is not recreated, its ID does not clash, and it gets no new PIN', () => {
    const h = hub()
    h.load()
    const id = idOf(h, 'user:caja')
    const fingerprint = h.db
      .prepare('SELECT pin_hash FROM user_credentials WHERE user_id = ?')
      .get(id)
    h.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id)

    const r = h.load(MENU_TEXT, LATER)
    expect(r.pins).toEqual([])
    expect(r.sqlTables.users?.created).toBe(0)
    expect(count(h.db, 'SELECT count(*) AS n FROM users WHERE id = ?', id)).toBe(1)
    expect(h.db.prepare('SELECT pin_hash FROM user_credentials WHERE user_id = ?').get(id)).toEqual(
      fingerprint,
    )
  })
})

describe('menu changes', () => {
  const names = (h: ReturnType<typeof hub>, sql = 'SELECT name FROM products WHERE active = 1') =>
    h.db
      .prepare(sql)
      .all()
      .map((f) => String(f.name))

  it('changing only the case or accents of the name keeps the product and updates the name', () => {
    const h = hub()
    h.load()
    const id = stableId(h.restaurantId, 'product:PIZZAS:quattro-formaggi')
    const r = h.load(MENU_TEXT.replace('es: Quattro Formaggi', 'es: Quattro formaggi'), LATER)
    expect(h.db.prepare('SELECT name FROM products WHERE id = ?').get(id)?.name).toBe(
      'Quattro formaggi',
    )
    expect(r.sqlTables.products).toMatchObject({ created: 0, updated: 1 })
    expect(count(h.db, 'SELECT count(*) AS n FROM products')).toBe(98)

    // "Té Hatsu" → "Te Hatsu": same product (the key strips accents), with its flavors.
    const hatsu = stableId(h.restaurantId, 'product:BEBIDAS:te-hatsu')
    h.load(MENU_TEXT.replace('es: Té Hatsu', 'es: Te Hatsu'), '2026-10-26T09:00:00.000Z')
    expect(h.db.prepare('SELECT name FROM products WHERE id = ?').get(hatsu)?.name).toBe('Te Hatsu')
    expect(count(h.db, 'SELECT count(*) AS n FROM products')).toBe(98)
  })

  it('renaming a dish creates the new one and archives the old one: the waiter menu is not duplicated', () => {
    const h = hub()
    h.load()
    const quattroId = stableId(h.restaurantId, 'product:PIZZAS:quattro-formaggi')
    const before = Number(
      h.db.prepare('SELECT version FROM products WHERE id = ?').get(quattroId)?.version,
    )
    const r = h.load(MENU_TEXT.replace('es: Quattro Formaggi', 'es: Cuatro Quesos'), LATER)

    expect(r.sqlTables.products).toMatchObject({ created: 1, updated: 0, archived: 1 })
    const row = h.db
      .prepare('SELECT active, price, version FROM products WHERE id = ?')
      .get(quattroId)
    expect(row).toMatchObject({ active: 0, price: 44_900 })
    // Archiving is one more catalog change: it bumps the version so devices receive it.
    expect(Number(row?.version)).toBeGreaterThan(before)
    expect(names(h)).toContain('Cuatro Quesos')
    expect(names(h)).not.toContain('Quattro Formaggi')
    expect(count(h.db, 'SELECT count(*) AS n FROM products WHERE active = 1')).toBe(98)

    // And the next run does not archive anything else.
    const another = h.load(
      MENU_TEXT.replace('es: Quattro Formaggi', 'es: Cuatro Quesos'),
      '2026-10-26T09:00:00.000Z',
    )
    expect(another.sqlTables.products).toMatchObject({ created: 0, updated: 0, archived: 0 })
  })

  it('if the name goes back to the previous one, the archived product is reactivated with the same ID', () => {
    const h = hub()
    h.load()
    const quattroId = stableId(h.restaurantId, 'product:PIZZAS:quattro-formaggi')
    h.load(MENU_TEXT.replace('es: Quattro Formaggi', 'es: Cuatro Quesos'), LATER)
    h.load(MENU_TEXT, '2026-10-26T09:00:00.000Z')
    expect(h.db.prepare('SELECT active FROM products WHERE id = ?').get(quattroId)?.active).toBe(1)
    expect(
      count(h.db, "SELECT count(*) AS n FROM products WHERE name = 'Cuatro Quesos' AND active = 1"),
    ).toBe(0)
  })

  it('removing a flavor, a dish or a section from the menu archives what was already seeded', () => {
    const h = hub()
    h.load()
    const trimmedMenu = MENU_TEXT.replace('es: Rojo/Amarillo/Blanco', 'es: Rojo/Amarillo/Verde')
    const r = h.load(trimmedMenu, LATER)
    const flavors = (active: number) =>
      names(
        h,
        `SELECT m.name FROM modifiers m JOIN modifier_groups g ON g.id = m.group_id
         WHERE g.name = 'Sabor' AND m.active = ${active} AND m.name IN ('Rojo','Amarillo','Blanco','Verde')`,
      ).sort()
    expect(flavors(1)).toEqual(['Amarillo', 'Rojo', 'Verde'])
    expect(flavors(0)).toEqual(['Blanco'])
    expect(r.sqlTables.modifiers).toMatchObject({ created: 1, archived: 1 })

    const menu = parse(MENU_TEXT) as { secciones: { clave: string; platos: unknown[] }[] }
    const pizzas = menu.secciones.find((s) => s.clave === 'PIZZAS')?.platos.length ?? 0
    const withoutPizzas = stringify({
      secciones: menu.secciones.filter((s) => s.clave !== 'PIZZAS'),
    })
    const r2 = h.load(withoutPizzas, '2026-10-26T09:00:00.000Z')
    expect(
      count(h.db, "SELECT count(*) AS n FROM categories WHERE name = 'Pizzas' AND active = 1"),
    ).toBe(0)
    expect(r2.sqlTables.categories).toMatchObject({ archived: 1 })
    expect(r2.sqlTables.products).toMatchObject({ archived: pizzas })
    expect(count(h.db, 'SELECT count(*) AS n FROM products WHERE active = 1')).toBe(98 - pizzas)
    // Nothing was deleted: everything is still in the database, archived.
    expect(count(h.db, 'SELECT count(*) AS n FROM products')).toBe(98)
  })

  it('what a person edited or created (user_id) is not overwritten or archived', () => {
    const h = hub()
    h.load()
    const quattro = stableId(h.restaurantId, 'product:PIZZAS:quattro-formaggi')
    const margarita = stableId(h.restaurantId, 'product:PIZZAS:garden-margarita')
    const manager = stableId(h.restaurantId, 'user:gerente')
    // The manager changed a price from the editor; the seed must not revert it.
    h.db
      .prepare('UPDATE products SET price = 50000, user_id = ? WHERE id = ?')
      .run(manager, quattro)
    // And created a custom product that is not on the menu.
    const own = newId()
    h.db
      .prepare(
        `INSERT INTO products (id, restaurant_id, created_at, updated_at, version, user_id, category_id, name, price, tax_id)
         SELECT ?, restaurant_id, created_at, updated_at, 9999, ?, category_id, 'Plato del día', 25000, tax_id FROM products WHERE id = ?`,
      )
      .run(own, manager, quattro)

    const r = h.load(MENU_TEXT, LATER)
    expect(h.db.prepare('SELECT price, active FROM products WHERE id = ?').get(quattro)).toEqual({
      price: 50_000,
      active: 1,
    })
    expect(h.db.prepare('SELECT active FROM products WHERE id = ?').get(own)?.active).toBe(1)
    expect(r.sqlTables.products).toMatchObject({ respected: 1, archived: 0, updated: 0 })
    expect(h.db.prepare('SELECT active FROM products WHERE id = ?').get(margarita)?.active).toBe(1)

    // A product made by a person that leaves the menu is not archived either.
    h.load(
      MENU_TEXT.replace('es: Quattro Formaggi', 'es: Cuatro Quesos'),
      '2026-10-26T09:00:00.000Z',
    )
    expect(h.db.prepare('SELECT active FROM products WHERE id = ?').get(quattro)?.active).toBe(1)
  })

  it('the tax the accountant changed is not reverted to the seed rate', () => {
    const h = hub()
    h.load()
    h.db.prepare("UPDATE taxes SET rate = 1900 WHERE type = 'inc'").run()
    const r = h.load(MENU_TEXT, LATER)
    expect(h.db.prepare('SELECT rate FROM taxes').get()?.rate).toBe(1900)
    expect(r.sqlTables.taxes).toMatchObject({ respected: 1, updated: 0 })
  })

  it('a dish with disponible: false is not loaded, and if it already existed it is archived', () => {
    const h = hub()
    h.load()
    const id = stableId(h.restaurantId, 'product:PIZZAS:quattro-formaggi')
    const text = (menu: string) => menu
    const soldOut = text(
      MENU_TEXT.replace(/(es: Quattro Formaggi[\s\S]*?disponible: )true/, '$1false'),
    )
    expect(soldOut).not.toBe(MENU_TEXT)
    expect(readMenu(soldOut).flatMap((c) => c.products)).toHaveLength(97)
    const r = h.load(soldOut, LATER)
    expect(r.sqlTables.products).toMatchObject({ archived: 1, created: 0 })
    expect(h.db.prepare('SELECT active FROM products WHERE id = ?').get(id)?.active).toBe(0)

    // On a clean hub it is not even created.
    const clean = hub()
    clean.load(soldOut)
    expect(count(clean.db, 'SELECT count(*) AS n FROM products')).toBe(97)
  })

  it('moving a dish to another section seeds it in the new one and archives the old one', () => {
    const h = hub()
    h.load(menuOf(section('A', [dish('Agua', 3000)]), section('B', [dish('Jugo', 5000)])))
    const r = h.load(
      menuOf(section('A', []), section('B', [dish('Jugo', 5000), dish('Agua', 3000)])),
      LATER,
    )
    expect(r.sqlTables.products).toMatchObject({ created: 1, archived: 1 })
    expect(
      count(h.db, "SELECT count(*) AS n FROM products WHERE name = 'Agua' AND active = 1"),
    ).toBe(1)
    expect(
      h.db
        .prepare(
          `SELECT c.name FROM products p JOIN categories c ON c.id = p.category_id
           WHERE p.name = 'Agua' AND p.active = 1`,
        )
        .get()?.name,
    ).toBe('B')
  })

  it('changing a variant price updates the variant, and the base price only if it was the cheapest', () => {
    const text = menuOf(
      section('VINOS', [dish('Malbec Botella', 120_000), dish('Malbec Copa', 30_000)]),
    )
    const h = hub()
    h.load(text)
    const product = stableId(h.restaurantId, 'product:VINOS:malbec')

    const bottlePriceUp = h.load(text.replace('120000', '125000'), LATER)
    expect(bottlePriceUp.sqlTables.variants).toMatchObject({ updated: 1, equal: 1 })
    expect(bottlePriceUp.sqlTables.products).toMatchObject({ updated: 0 })

    const glassPriceUp = h.load(
      text.replace('120000', '125000').replace('30000', '31000'),
      '2026-10-26T09:00:00.000Z',
    )
    expect(glassPriceUp.sqlTables.variants).toMatchObject({ updated: 1, equal: 1 })
    expect(glassPriceUp.sqlTables.products).toMatchObject({ updated: 1 })
    expect(h.db.prepare('SELECT price FROM products WHERE id = ?').get(product)?.price).toBe(31_000)
  })
})

describe('glass and bottle variants', () => {
  const productsOf = (text: string) => readMenu(text).flatMap((c) => c.products)

  it('a glass alone, without its bottle, stays a standalone product with its full name', () => {
    const [p] = productsOf(menuOf(section('VINOS', [dish('Malbec Copa', 30_000)])))
    expect(p).toMatchObject({ name: 'Malbec Copa', price: 30_000, variants: [] })
  })

  it('a bottle alone stays a standalone product, with the size at the start or the end', () => {
    const ps = productsOf(
      menuOf(section('VINOS', [dish('Botella Lambrusco', 99_000), dish('Merlot Botella', 90_000)])),
    )
    expect(ps.map((p) => [p.name, p.variants.length])).toEqual([
      ['Botella Lambrusco', 0],
      ['Merlot Botella', 0],
    ])
  })

  it('the size at the start also joins glass and bottle into one product', () => {
    const [p] = productsOf(
      menuOf(section('VINOS', [dish('Botella Malbec', 120_000), dish('Copa Malbec', 30_000)])),
    )
    expect(p).toMatchObject({
      name: 'Malbec',
      price: 30_000,
      variants: [
        { name: 'Copa', price: 30_000 },
        { name: 'Botella', price: 120_000 },
      ],
    })
  })

  it('the wine without size plus its glass and bottle is not joined: three products', () => {
    const ps = productsOf(
      menuOf(
        section('VINOS', [
          dish('Malbec', 10_000),
          dish('Malbec Copa', 30_000),
          dish('Malbec Botella', 120_000),
        ]),
      ),
    )
    expect(ps.map((p) => p.name)).toEqual(['Malbec', 'Malbec Copa', 'Malbec Botella'])
    expect(ps.every((p) => p.variants.length === 0)).toBe(true)
  })

  it('two glasses of the same wine are a repeated dish and reading fails', () => {
    expect(() =>
      readMenu(
        menuOf(section('VINOS', [dish('Malbec Copa', 30_000), dish('Malbec Copa', 31_000)])),
      ),
    ).toThrow(/repetido/)
  })

  it('two dishes that differ only in case or accents are a repeated dish', () => {
    expect(() => readMenu(menuOf(section('X', [dish('Café', 1000), dish('cafe', 2000)])))).toThrow(
      /repetido/,
    )
  })

  it('the menu lists the bottle first but in the database the glass gets position 0', () => {
    const h = hub()
    h.load(menuOf(section('VINOS', [dish('Malbec Botella', 120_000), dish('Malbec Copa', 30_000)])))
    expect(h.db.prepare('SELECT name, position FROM variants ORDER BY position').all()).toEqual([
      { name: 'Copa', position: 0 },
      { name: 'Botella', position: 1 },
    ])
  })

  it('if the menu no longer has the bottle, the product with variants is archived with both variants', () => {
    const h = hub()
    h.load(menuOf(section('VINOS', [dish('Malbec Botella', 120_000), dish('Malbec Copa', 30_000)])))
    const r = h.load(menuOf(section('VINOS', [dish('Malbec Copa', 30_000)])), LATER)
    // The standalone glass is another product ("Malbec Copa"); the old one, with its variants, is archived.
    expect(r.sqlTables.products).toMatchObject({ created: 1, archived: 1 })
    expect(r.sqlTables.variants).toMatchObject({ archived: 2 })
    expect(count(h.db, 'SELECT count(*) AS n FROM variants WHERE active = 1')).toBe(0)
    expect(
      h.db
        .prepare('SELECT name FROM products WHERE active = 1')
        .all()
        .map((f) => f.name),
    ).toEqual(['Malbec Copa'])
  })

  it('with variants, the description is that of the first dish that has one', () => {
    const [p] = readMenu(
      menuOf(
        section('VINOS', [
          dish('Malbec Copa', 30_000),
          dish('Malbec Botella', 120_000, 'Mendoza, 2021'),
        ]),
      ),
    ).flatMap((c) => c.products)
    expect(p?.variants).toHaveLength(2)
    expect(p?.description).toBe('Mendoza, 2021')
  })
})

describe('flavors', () => {
  const hatsu = (description: string, name = 'Té Hatsu') =>
    menuOf(section('BEBIDAS', [dish(name, 13_900, description)]))

  it('flavors with accents are options of the group, stable across runs', () => {
    const h = hub()
    const text = hatsu('Limón/Piña/Maracuyá', 'Soda Hatsu')
    h.load(text)
    const names = h.db
      .prepare('SELECT name FROM modifiers ORDER BY position')
      .all()
      .map((f) => f.name)
    expect(names).toEqual(['Limón', 'Piña', 'Maracuyá'])
    const r = h.load(text, LATER)
    expect(r.sqlTables.modifiers).toEqual({
      created: 0,
      updated: 0,
      equal: 3,
      respected: 0,
      archived: 0,
    })
  })

  it('spaces around the slash are ignored: "Rojo / Amarillo" works', () => {
    const [p] = readMenu(hatsu('  Rojo / Amarillo /Blanco ')).flatMap((c) => c.products)
    expect(p?.groups[0]?.options.map((o) => o.name)).toEqual(['Rojo', 'Amarillo', 'Blanco'])
    expect(p?.description).toBeNull()
  })

  it('a flavor with an inner space is a single flavor', () => {
    const [p] = readMenu(hatsu('Fresa Limón/Maracuyá')).flatMap((c) => c.products)
    expect(p?.groups[0]?.options.map((o) => o.name)).toEqual(['Fresa Limón', 'Maracuyá'])
  })

  it('flavors are required and free', () => {
    const [p] = readMenu(hatsu('Rojo/Blanco')).flatMap((c) => c.products)
    expect(p?.groups[0]).toMatchObject({ minimum: 1, maximum: 1 })
    expect(p?.groups[0]?.options.every((o) => o.extraPrice === 0)).toBe(true)
  })

  it('Té Hatsu or Soda Hatsu with fewer than two flavors is a menu error', () => {
    for (const description of ['Natural', 'Rojo', 'Rojo/', '/Rojo', 'Rojo//', ' / ', ''])
      expect(() => readMenu(hatsu(description)), description).toThrow(/sabores/)
    expect(() => readMenu(menuOf(section('B', [dish('Té Hatsu', 1)])))).toThrow(/sabores/)
    expect(() => readMenu(hatsu('Rojo', 'Soda Hatsu'))).toThrow(/sabores/)
  })

  it('a repeated flavor ("Rojo/Rojo") is a menu error, with or without accents and case', () => {
    for (const description of ['Rojo/Rojo/Blanco', 'Rojo/rojo', 'Limón/Limon', ' Rojo /Rojo '])
      expect(() => readMenu(hatsu(description)), description).toThrow(/repite/)
  })

  it('another dish with slashes in the description does not become a flavor', () => {
    for (const description of ['Jamón/Queso', 'Rojo/Amarillo', 'Aguacate / Tomate']) {
      const [p] = readMenu(menuOf(section('S', [dish('Sándwich', 9000, description)]))).flatMap(
        (c) => c.products,
      )
      expect({ description, groups: p?.groups.length, text: p?.description }).toEqual({
        description,
        groups: 0,
        text: description,
      })
    }
  })

  it('if the menu no longer has Té Hatsu or the Tagliata, `rulesWithoutDish` reports it', () => {
    expect(rulesWithoutDish(readMenu(MENU_TEXT))).toEqual([])
    expect(rulesWithoutDish(readMenu(menuOf(section('S', [dish('Agua', 1)]))))).toEqual([
      'Tagliata di Manzo',
      'Té Hatsu',
      'Soda Hatsu',
    ])
  })

  it('the meat doneness group is shared across products and created only once', () => {
    const h = hub()
    h.load()
    expect(
      count(h.db, "SELECT count(*) AS n FROM modifier_groups WHERE name = 'Término de la carne'"),
    ).toBe(1)
    expect(
      count(
        h.db,
        'SELECT count(*) AS n FROM modifiers WHERE group_id = ?',
        stableId(h.restaurantId, 'group:termino'),
      ),
    ).toBe(4)
    expect(
      count(
        h.db,
        'SELECT count(*) AS n FROM product_modifier_groups WHERE group_id = ?',
        stableId(h.restaurantId, 'group:termino'),
      ),
    ).toBeGreaterThan(1)
  })
})

describe('hidden sections', () => {
  const twoSections = (visibleA: boolean, visibleB = true) =>
    menuOf(
      section('A', [dish('Agua', 3000)], { visible: visibleA }),
      section('B', [dish('Jugo', 5000)], { visible: visibleB }),
    )

  it('an invisible section is not seeded and the order of the visible ones stays consecutive', () => {
    const menu = readMenu(
      menuOf(
        section('A', [dish('a', 1)], { visible: false }),
        section('B', [dish('b', 1)]),
        section('C', [dish('c', 1)], { visible: false }),
        section('D', [dish('d', 1)]),
      ),
    )
    expect(menu.map((c) => [c.key, c.position])).toEqual([
      ['B', 0],
      ['D', 1],
    ])
    const h = hub()
    h.load(menuOf(section('A', [dish('a', 1)], { visible: false }), section('B', [dish('b', 1)])))
    expect(count(h.db, 'SELECT count(*) AS n FROM categories')).toBe(1)
    expect(count(h.db, 'SELECT count(*) AS n FROM products')).toBe(1)
  })

  it('section keys are unique across the whole menu, including those of invisible sections', () => {
    expect(() =>
      readMenu(
        menuOf(section('A', [dish('x', 1)], { visible: false }), section('A', [dish('y', 1)])),
      ),
    ).toThrow(/repetida/)
  })

  it('a section key with spaces, ":" or "|" is rejected because it goes inside the IDs', () => {
    for (const key of ['A B', 'A:B', 'A|B', '', ' A'])
      expect(() => readMenu(menuOf(section(key, [dish('x', 1)]))), key).toThrow()
  })

  it('an invisible section with an invalid price does fail: the whole menu is validated', () => {
    expect(() =>
      readMenu(
        menuOf(section('A', [dish('x', 1.5)], { visible: false }), section('B', [dish('y', 1)])),
      ),
    ).toThrow()
  })

  it('hiding an already seeded section archives it with its products and keeps the order consecutive', () => {
    const h = hub()
    h.load(twoSections(true))
    const r = h.load(twoSections(false), LATER)
    expect(r.sqlTables.categories).toMatchObject({ archived: 1, updated: 1 })
    expect(r.sqlTables.products).toMatchObject({ archived: 1 })
    expect(count(h.db, 'SELECT count(*) AS n FROM categories WHERE active = 1')).toBe(1)
    expect(h.db.prepare("SELECT position FROM categories WHERE name = 'B'").get()?.position).toBe(0)
    expect(h.db.prepare("SELECT active FROM products WHERE name = 'Agua'").get()?.active).toBe(0)
    // Showing it again reactivates it.
    h.load(twoSections(true), '2026-10-26T09:00:00.000Z')
    expect(count(h.db, 'SELECT count(*) AS n FROM products WHERE active = 1')).toBe(2)
  })

  it('a menu with all sections hidden leaves no categories or products', () => {
    const h = hub()
    h.load(twoSections(true))
    h.load(twoSections(false, false), LATER)
    expect(count(h.db, 'SELECT count(*) AS n FROM products WHERE active = 1')).toBe(0)
    expect(count(h.db, 'SELECT count(*) AS n FROM categories WHERE active = 1')).toBe(0)
    expect(count(h.db, 'SELECT count(*) AS n FROM dining_tables WHERE active = 1')).toBe(TABLES)
  })
})

describe('interrupted seed', () => {
  /** The database that throws when preparing the statement matching `when`: the process died there. */
  function withFailure(db: SqliteDatabase, when: (sql: string) => boolean): SqliteDatabase {
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        if (when(sql)) throw new Error('the process died')
        return db.prepare(sql)
      },
      close: () => db.close(),
    }
  }

  it('if it dies halfway through the catalog nothing is left half done and the next run leaves a clean result', () => {
    const h = hub(FIXED_ID)
    const allRows = [...VERSIONED_TABLES, 'counters', 'user_credentials']
    const before = dump(h.db, allRows)

    let inserted = 0
    const faulty = withFailure(
      h.db,
      (sql) => sql.startsWith('INSERT INTO products ') && ++inserted === 50,
    )
    expect(() =>
      seed(
        faulty,
        h.access,
        { restaurantId: h.restaurantId, roles: h.roles, menu: readMenu(MENU_TEXT) },
        NOW,
      ),
    ).toThrow('the process died')

    // No dining room, no stations, no tax, no restaurant name: nothing was saved.
    expect(dump(h.db, allRows)).toEqual(before)
    expect(h.db.prepare('SELECT name FROM restaurants').get()?.name).toBe('Mi restaurante')
    expect(count(h.db, 'SELECT count(*) AS n FROM dining_tables')).toBe(0)

    // No leftovers in the way: it ends up the same as a hub that ran the seed without interruption.
    const clean = hub(FIXED_ID)
    clean.load()
    h.load()
    expect(dump(h.db, SEED_TABLES)).toEqual(dump(clean.db, SEED_TABLES))
  })

  it('if it fails while creating staff nothing is left: no catalog or users, and the next run creates it all', () => {
    const h = hub(FIXED_ID)
    const allRows = [...VERSIONED_TABLES, 'counters', 'user_credentials']
    const before = dump(h.db, allRows)
    let calls = 0
    const brittle = {
      insertUser: (...args: Parameters<AccessService['insertUser']>) => {
        if (++calls === 4) throw new Error('the process died')
        return h.access.insertUser(...args)
      },
    } as unknown as AccessService

    expect(() => h.load(MENU_TEXT, NOW, brittle)).toThrow('the process died')
    expect(calls).toBe(4)
    // The three users that got created were also rolled back, with their PINs.
    expect(dump(h.db, allRows)).toEqual(before)

    const r = h.load(MENU_TEXT, LATER)
    expect(r.pins.map((p) => p.name)).toEqual(STAFF.map((p) => p.name))
    expect(count(h.db, 'SELECT count(*) AS n FROM users')).toBe(STAFF.length)
    expect(count(h.db, 'SELECT count(*) AS n FROM products')).toBe(98)
    const clean = hub(FIXED_ID)
    clean.load(MENU_TEXT, LATER)
    expect(dump(h.db, SEED_TABLES)).toEqual(dump(clean.db, SEED_TABLES))
  })

  it('with `withoutStaff` the catalog loads without creating anyone or handing out PINs', () => {
    const h = hub()
    const r = seed(
      h.db,
      h.access,
      {
        restaurantId: h.restaurantId,
        roles: h.roles,
        menu: readMenu(MENU_TEXT),
        withoutStaff: true,
      },
      NOW,
    )
    expect(r.pins).toEqual([])
    expect(r.sqlTables.users).toBeUndefined()
    expect(count(h.db, 'SELECT count(*) AS n FROM users')).toBe(0)
    expect(count(h.db, 'SELECT count(*) AS n FROM products')).toBe(98)
    // And a normal run afterwards completes the staff.
    expect(h.load(MENU_TEXT, LATER).pins).toHaveLength(STAFF.length)
  })

  it('an invalid restaurant config stops the seed without writing anything', () => {
    const h = hub()
    h.db.prepare('UPDATE restaurants SET config = \'{"odd_field":1}\'').run()
    const allRows = [...VERSIONED_TABLES, 'counters']
    const before = dump(h.db, allRows)
    expect(() => h.load()).toThrow()
    expect(dump(h.db, allRows)).toEqual(before)
  })

  it('a restaurant without a location stops the seed with a clear message and without changing its name', () => {
    const h = hub()
    h.db.exec('DROP TRIGGER locations_no_delete')
    h.db.exec('DELETE FROM locations')
    expect(() => h.load()).toThrow(/sede/)
    expect(h.db.prepare('SELECT name FROM restaurants').get()?.name).toBe('Mi restaurante')
    expect(count(h.db, 'SELECT count(*) AS n FROM dining_tables')).toBe(0)
  })

  it('a menu with an invalid price fails before touching the database', () => {
    const h = hub()
    const before = dump(h.db, VERSIONED_TABLES)
    expect(() => h.load(MENU_TEXT.replace('precio: 44900', 'precio: 44900.5'))).toThrow()
    expect(dump(h.db, VERSIONED_TABLES)).toEqual(before)
  })
})
