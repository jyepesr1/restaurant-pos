import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isValidId } from '@pos/core'
import { aplicarMigraciones } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { asegurarAdministrador, asegurarRestaurante, asegurarRoles } from '../acceso/inicial'
import { idEstable } from '../acceso/registros'
import { ServicioAcceso } from '../acceso/servicio'
import { DONENESS, leerCarta } from './carta'
import { PERSONAL, sembrar, TABLES } from './sembrar'

const RUTA_CARTA = fileURLToPath(
  new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url),
)
const TEXTO_CARTA = readFileSync(RUTA_CARTA, 'utf8')
const AHORA = '2026-10-24T20:00:00.000Z'

function hub() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  const restauranteId = asegurarRestaurante(db, AHORA)
  const roles = asegurarRoles(db, restauranteId, AHORA)
  const access = new ServicioAcceso({
    db,
    restauranteId,
    key: Buffer.alloc(32, 3),
    clock: () => AHORA,
  })
  asegurarAdministrador(db, access, roles.admin, false)
  const cargar = (text = TEXTO_CARTA, ahora = AHORA) =>
    sembrar(db, access, { restauranteId, roles, menu: leerCarta(text) }, ahora)
  const rows = (sql: string, ...p: string[]) => db.prepare(sql).all(...p)
  return { db, access, restauranteId, cargar, rows }
}

describe('lectura de la carta', () => {
  const menu = leerCarta(TEXTO_CARTA)
  const products = menu.flatMap((c) => c.products)
  const search = (name: string) => products.find((p) => p.name === name)

  it('trae las 15 secciones con su estación: comida a cocina, bebidas a barra', () => {
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

  it('copa y botella del mismo vino son un producto con dos opciones; una botella sola queda igual', () => {
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

  it('el sabor del Té Hatsu es obligatorio y sin costo; la carne lleva término', () => {
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

  it('ningún precio se pierde ni cambia: cada plato está como producto o como opción', () => {
    const original = TEXTO_CARTA.match(/precio: (\d+)/g)?.map((t) => Number(t.slice(8))) ?? []
    const cargados = products.flatMap((p) =>
      p.variants.length > 0 ? p.variants.map((v) => v.price) : [p.price],
    )
    expect(cargados.sort((a, b) => a - b)).toEqual(original.sort((a, b) => a - b))
    for (const price of cargados) expect(Number.isInteger(price)).toBe(true)
  })

  it('rechaza precios con decimales, negativos o en texto, y secciones repetidas', () => {
    const makeOne = (price: unknown, key = 'A') => ({
      clave: key,
      nombre: 'X',
      grupo: 'comida',
      boton: { es: 'X' },
      platos: [{ nombre: { es: 'Plato' }, precio: price }],
    })
    for (const price of [20_900.5, -1, '20900', 200_000_000])
      expect(() => leerCarta(stringify({ secciones: [makeOne(price)] }))).toThrow()
    expect(() => leerCarta(stringify({ secciones: [makeOne(1), makeOne(2)] }))).toThrow(/repetida/)
    expect(() => leerCarta('secciones: []')).toThrow()
    expect(() => leerCarta('no es: [una carta')).toThrow()
  })
})

describe('carga en la base', () => {
  it('crea el salón, la carta y el personal con IDs válidos', () => {
    const h = hub()
    const r = h.cargar()

    const check = (tabla: string) =>
      Number(h.db.prepare(`SELECT count(*) AS n FROM ${tabla} WHERE active = 1`).get()?.n)
    expect(check('dining_tables')).toBe(TABLES)
    expect(check('categories')).toBe(15)
    expect(check('products')).toBe(98)
    expect(check('variants')).toBe(4)
    expect(check('stations')).toBe(2)
    expect(check('users')).toBe(PERSONAL.length + 1)
    expect(r.pins.map((p) => p.name)).toEqual(PERSONAL.map((p) => p.name))
    for (const { id } of h.rows('SELECT id FROM products')) expect(isValidId(String(id))).toBe(true)

    expect(h.rows('SELECT name FROM restaurants')).toEqual([{ name: 'La Spritzzería' }])
    expect(h.rows('SELECT type, rate FROM taxes')).toEqual([{ type: 'inc', rate: 800 }])
    // Cada producto con su impuesto y su categoría, cada categoría con su estación.
    expect(
      h.rows(
        `SELECT count(*) AS n FROM products p JOIN categories c ON c.id = p.category_id
         JOIN stations e ON e.id = c.station_id JOIN taxes i ON i.id = p.tax_id`,
      ),
    ).toEqual([{ n: 98 }])
  })

  it('una segunda corrida no cambia nada: ni registros, ni versiones, ni PIN', () => {
    const h = hub()
    h.cargar()
    const before = h.rows('SELECT id, version FROM products ORDER BY id')
    const pinesAntes = h.rows('SELECT user_id, pin_hash FROM user_credentials ORDER BY 1')
    const r = h.cargar(TEXTO_CARTA, '2026-10-25T10:00:00.000Z')

    for (const [tabla, c] of Object.entries(r.sqlTables)) {
      expect({ tabla, created: c.created, updated: c.updated }).toEqual({
        tabla,
        created: 0,
        updated: 0,
      })
    }
    expect(r.pins).toEqual([])
    expect(h.rows('SELECT id, version FROM products ORDER BY id')).toEqual(before)
    expect(h.rows('SELECT user_id, pin_hash FROM user_credentials ORDER BY 1')).toEqual(pinesAntes)
  })

  it('si la carta cambia un precio, solo ese producto se actualiza y sube de versión', () => {
    const h = hub()
    h.cargar()
    const id = idEstable(h.restauranteId, 'producto:PIZZAS:quattro-formaggi')
    const before = h.db.prepare('SELECT price, version FROM products WHERE id = ?').get(id)
    const r = h.cargar(TEXTO_CARTA.replace('precio: 44900', 'precio: 46900'))

    const after = h.db.prepare('SELECT price, version FROM products WHERE id = ?').get(id)
    expect(before?.price).toBe(44_900)
    expect(after?.price).toBe(46_900)
    expect(Number(after?.version)).toBeGreaterThan(Number(before?.version))
    expect(r.sqlTables.products).toMatchObject({ updated: 1 })
  })

  it('respeta la configuración que el restaurante ya cambió', () => {
    const h = hub()
    h.db.prepare('UPDATE restaurants SET config = \'{"cash_rounding":50}\'').run()
    h.cargar()
    const config = JSON.parse(String(h.db.prepare('SELECT config FROM restaurants').get()?.config))
    expect(config).toMatchObject({ cash_rounding: 50, suggested_tip: 1000 })
  })

  it('los IDs son los mismos en dos hubs con el mismo restaurante', () => {
    const a = idEstable('01JB0000000000000000000000', 'mesa:1')
    expect(a).toBe(idEstable('01JB0000000000000000000000', 'mesa:1'))
    expect(a).not.toBe(idEstable('01JB0000000000000000000000', 'mesa:2'))
    expect(a.slice(0, 10)).toBe('01JB000000')
    expect(isValidId(a)).toBe(true)
  })
})
