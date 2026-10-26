import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isValidId } from '@pos/core'
import { applyMigrations } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { ensureAdmin, ensureRestaurant, ensureRoles } from '../access/initial'
import { stableId } from '../access/records'
import { AccessService } from '../access/service'
import { DONENESS, readMenu } from './menu'
import { STAFF, seed, TABLES } from './seed'

const MENU_PATH = fileURLToPath(
  new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url),
)
const MENU_TEXT = readFileSync(MENU_PATH, 'utf8')
const NOW = '2026-10-24T20:00:00.000Z'

function hub() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const restaurantId = ensureRestaurant(db, NOW)
  const roles = ensureRoles(db, restaurantId, NOW)
  const access = new AccessService({
    db,
    restaurantId,
    key: Buffer.alloc(32, 3),
    clock: () => NOW,
  })
  ensureAdmin(db, access, roles.admin, false)
  const load = (text = MENU_TEXT, now = NOW) =>
    seed(db, access, { restaurantId, roles, menu: readMenu(text) }, now)
  const rows = (sql: string, ...p: string[]) => db.prepare(sql).all(...p)
  return { db, access, restaurantId, load, rows }
}

describe('reading the menu', () => {
  const menu = readMenu(MENU_TEXT)
  const products = menu.flatMap((c) => c.products)
  const search = (name: string) => products.find((p) => p.name === name)

  it('returns the 15 sections with their station: food to the kitchen, drinks to the bar', () => {
    expect(menu.map((c) => c.name)).toEqual([
      'Entradas',
      'Pizzas',
      'Pastas',
      'Lasañas',
      'Hamburguesas',
      'Spritz',
      'Postres',
      'De Autor',
      'Clásicos',
      'Mocktails',
      'Sangrías',
      'Vinos',
      'Tragos',
      'Sodas',
      'Refrescos',
    ])
    expect(menu.find((c) => c.key === 'PIZZAS')?.station).toBe('cocina')
    expect(menu.find((c) => c.key === 'SPRITZ')?.station).toBe('barra')
  })

  it('glass and bottle of the same wine are one product with two options; a bottle alone stays the same', () => {
    expect(search('Ramón Bilbao Crianza')).toMatchObject({
      price: 30_900,
      variants: [
        { name: 'Copa', price: 30_900 },
        { name: 'Botella', price: 129_900 },
      ],
    })
    expect(search('Ramón Bilbao Verdejo')?.variants).toHaveLength(2)
    expect(search('Botella Lambrusco Rosé')).toMatchObject({ price: 99_900, variants: [] })
    expect(products).toHaveLength(98)
  })

  it('the Té Hatsu flavor is required and free; the meat carries doneness', () => {
    expect(search('Té Hatsu')).toMatchObject({
      description: null,
      groups: [
        {
          name: 'Sabor',
          minimum: 1,
          maximum: 1,
          options: [
            { name: 'Rojo', extraPrice: 0 },
            { name: 'Amarillo', extraPrice: 0 },
            { name: 'Blanco', extraPrice: 0 },
          ],
        },
      ],
    })
    expect(search('Soda Hatsu')?.groups[0]?.options.map((o) => o.name)).toEqual(['Limon', 'Sandía'])
    expect(search('Tagliata di Manzo')?.groups).toEqual([DONENESS])
    expect(search('Spritz Burguer')?.groups).toEqual([DONENESS])
    expect(search('Quattro Formaggi')?.groups).toEqual([])
  })

  it('no price is lost or changed: each dish is there as a product or as an option', () => {
    const original = MENU_TEXT.match(/precio: (\d+)/g)?.map((t) => Number(t.slice(8))) ?? []
    const loadedPrices = products.flatMap((p) =>
      p.variants.length > 0 ? p.variants.map((v) => v.price) : [p.price],
    )
    expect(loadedPrices.sort((a, b) => a - b)).toEqual(original.sort((a, b) => a - b))
    for (const price of loadedPrices) expect(Number.isInteger(price)).toBe(true)
  })

  it('rejects prices with decimals, negative or as text, and repeated sections', () => {
    const makeOne = (price: unknown, key = 'A') => ({
      clave: key,
      nombre: 'X',
      grupo: 'comida',
      boton: { es: 'X' },
      platos: [{ nombre: { es: 'Plato' }, precio: price }],
    })
    for (const price of [20_900.5, -1, '20900', 200_000_000])
      expect(() => readMenu(stringify({ secciones: [makeOne(price)] }))).toThrow()
    expect(() => readMenu(stringify({ secciones: [makeOne(1), makeOne(2)] }))).toThrow(/repetida/)
    expect(() => readMenu('secciones: []')).toThrow()
    expect(() => readMenu('no es: [una carta')).toThrow()
  })
})

describe('loading into the database', () => {
  it('creates the dining room, the menu and the staff with valid IDs', () => {
    const h = hub()
    const r = h.load()

    const check = (tableName: string) =>
      Number(h.db.prepare(`SELECT count(*) AS n FROM ${tableName} WHERE active = 1`).get()?.n)
    expect(check('dining_tables')).toBe(TABLES)
    expect(check('categories')).toBe(15)
    expect(check('products')).toBe(98)
    expect(check('variants')).toBe(4)
    expect(check('stations')).toBe(2)
    expect(check('users')).toBe(STAFF.length + 1)
    expect(r.pins.map((p) => p.name)).toEqual(STAFF.map((p) => p.name))
    for (const { id } of h.rows('SELECT id FROM products')) expect(isValidId(String(id))).toBe(true)

    expect(h.rows('SELECT name FROM restaurants')).toEqual([{ name: 'La Spritzzería' }])
    expect(h.rows('SELECT type, rate FROM taxes')).toEqual([{ type: 'inc', rate: 800 }])
    // Each product with its tax and its category, each category with its station.
    expect(
      h.rows(
        `SELECT count(*) AS n FROM products p JOIN categories c ON c.id = p.category_id
         JOIN stations e ON e.id = c.station_id JOIN taxes i ON i.id = p.tax_id`,
      ),
    ).toEqual([{ n: 98 }])
  })

  it('a second run changes nothing: no records, no versions, no PINs', () => {
    const h = hub()
    h.load()
    const before = h.rows('SELECT id, version FROM products ORDER BY id')
    const pinHashesBefore = h.rows('SELECT user_id, pin_hash FROM user_credentials ORDER BY 1')
    const r = h.load(MENU_TEXT, '2026-10-25T10:00:00.000Z')

    for (const [tableName, c] of Object.entries(r.sqlTables)) {
      expect({ tableName, created: c.created, updated: c.updated }).toEqual({
        tableName,
        created: 0,
        updated: 0,
      })
    }
    expect(r.pins).toEqual([])
    expect(h.rows('SELECT id, version FROM products ORDER BY id')).toEqual(before)
    expect(h.rows('SELECT user_id, pin_hash FROM user_credentials ORDER BY 1')).toEqual(
      pinHashesBefore,
    )
  })

  it('if the menu changes a price, only that product is updated and bumps its version', () => {
    const h = hub()
    h.load()
    const id = stableId(h.restaurantId, 'product:PIZZAS:quattro-formaggi')
    const before = h.db.prepare('SELECT price, version FROM products WHERE id = ?').get(id)
    const r = h.load(MENU_TEXT.replace('precio: 44900', 'precio: 46900'))

    const after = h.db.prepare('SELECT price, version FROM products WHERE id = ?').get(id)
    expect(before?.price).toBe(44_900)
    expect(after?.price).toBe(46_900)
    expect(Number(after?.version)).toBeGreaterThan(Number(before?.version))
    expect(r.sqlTables.products).toMatchObject({ updated: 1 })
  })

  it('respects the config the restaurant already changed', () => {
    const h = hub()
    h.db.prepare('UPDATE restaurants SET config = \'{"cash_rounding":50}\'').run()
    h.load()
    const config = JSON.parse(String(h.db.prepare('SELECT config FROM restaurants').get()?.config))
    expect(config).toMatchObject({ cash_rounding: 50, suggested_tip: 1000 })
  })

  it('the IDs are the same in two hubs with the same restaurant', () => {
    const a = stableId('01JB0000000000000000000000', 'table:1')
    expect(a).toBe(stableId('01JB0000000000000000000000', 'table:1'))
    expect(a).not.toBe(stableId('01JB0000000000000000000000', 'table:2'))
    expect(a.slice(0, 10)).toBe('01JB000000')
    expect(isValidId(a)).toBe(true)
  })
})
