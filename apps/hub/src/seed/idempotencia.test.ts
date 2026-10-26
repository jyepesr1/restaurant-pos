import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isValidId, newId } from '@pos/core'
import { aplicarMigraciones, type BaseSqlite, TABLAS_VERSIONADAS } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { asegurarRoles } from '../acceso/inicial'
import type { Cambio } from '../acceso/registros'
import { idEstable, insertarVersionado, SISTEMA } from '../acceso/registros'
import { ServicioAcceso } from '../acceso/servicio'
import { leerCarta, rulesWithoutDish } from './carta'
import { PERSONAL, sembrar, TABLES } from './sembrar'

// Pruebas adicionales de la tarea 0.8: repetir el seed, varios hubs y restaurantes, registros
// archivados, cambios en la carta, variantes, sabores, secciones ocultas e interrupciones.

const TEXTO_CARTA = readFileSync(
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)
const AHORA = '2026-10-24T20:00:00.000Z'
const MAS_TARDE = '2026-10-25T09:30:00.000Z'

/** Tablas que el seed llena con IDs estables (sin personal ni roles, que crea el hub). */
const TABLAS_SEED = [
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

const volcar = (db: BaseSqlite, sqlTables: readonly string[]) =>
  Object.fromEntries(sqlTables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]))

const contar = (db: BaseSqlite, sql: string, ...p: string[]) => Number(db.prepare(sql).get(...p)?.n)

/**
 * Un hub recién instalado con un restaurante de ID dado (o nuevo). La sede también lleva un ID
 * estable para poder comparar dos hubs del mismo restaurante fila por fila.
 */
function hub(restauranteId = newId(), shared?: BaseSqlite) {
  const db = shared ?? abrirBase(':memory:')
  if (!shared) aplicarMigraciones(db)
  agregarRestaurante(db, restauranteId)
  const roles = asegurarRoles(db, restauranteId, AHORA)
  const access = new ServicioAcceso({
    db,
    restauranteId,
    key: Buffer.alloc(32, 3),
    clock: () => AHORA,
  })
  const cargar = (text = TEXTO_CARTA, ahora = AHORA, withIt: ServicioAcceso = access) =>
    sembrar(db, withIt, { restauranteId, roles, menu: leerCarta(text) }, ahora)
  return { db, access, roles, restauranteId, cargar }
}

function agregarRestaurante(db: BaseSqlite, id: string) {
  db.prepare(
    `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
     VALUES (?, ?, ?, ?, 1, 'Mi restaurante', '{}')`,
  ).run(id, id, AHORA, AHORA)
  db.prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)").run(id)
  insertarVersionado(
    db,
    'locations',
    id,
    { name: 'Principal', address: null, time_zone: 'America/Bogota' },
    SISTEMA,
    AHORA,
    idEstable(id, 'sede:principal'),
  )
}

// Cartas pequeñas para los casos borde.
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
const cartaDe = (...sections: ReturnType<typeof section>[]) => stringify({ secciones: sections })

const ID_FIJO = '01JB0000000000000000000000'

describe('repetir el seed', () => {
  it('cinco corridas con relojes distintos dejan la base idéntica, con versiones y PIN', () => {
    const h = hub()
    h.cargar(TEXTO_CARTA, AHORA)
    const sqlTables = [...TABLAS_VERSIONADAS, 'counters', 'user_credentials']
    const referencia = volcar(h.db, sqlTables)

    for (const time of [MAS_TARDE, '2026-10-26T01:00:00.000Z', '2027-01-01T00:00:00.000Z']) {
      const r = h.cargar(TEXTO_CARTA, time)
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
    h.cargar(TEXTO_CARTA, '2027-06-30T12:00:00.000Z')
    expect(volcar(h.db, sqlTables)).toEqual(referencia)
  })

  it('el resumen de la primera corrida cuenta todo como creado y el de la segunda todo como igual', () => {
    const h = hub()
    const first = h.cargar()
    const segunda = h.cargar(TEXTO_CARTA, MAS_TARDE)
    const checks = (c: Partial<Record<Cambio, number>>) => ({
      created: 0,
      updated: 0,
      equal: 0,
      respected: 0,
      archived: 0,
      ...c,
    })

    expect(first.sqlTables.dining_tables).toEqual(checks({ created: TABLES }))
    expect(first.sqlTables.products).toEqual(checks({ created: 98 }))
    expect(first.sqlTables.users).toEqual(checks({ created: PERSONAL.length }))
    expect(first.sqlTables.taxes).toEqual(checks({ created: 1 }))
    expect(segunda.sqlTables.dining_tables).toEqual(checks({ equal: TABLES }))
    expect(segunda.sqlTables.products).toEqual(checks({ equal: 98 }))
    expect(segunda.sqlTables.users).toEqual(checks({ equal: PERSONAL.length }))
    expect(segunda.sqlTables.restaurants).toEqual(checks({ equal: 1 }))
    // El impuesto se crea una sola vez: después el seed lo respeta, no lo compara.
    expect(segunda.sqlTables.taxes).toEqual(checks({ respected: 1 }))
  })

  it('el contador de catálogo es el mayor `version` y ninguna versión se repite', () => {
    const h = hub()
    h.cargar()
    const versiones = TABLAS_VERSIONADAS.flatMap((t) =>
      h.db
        .prepare(`SELECT version FROM ${t}`)
        .all()
        .map((f) => Number(f.version)),
    )
    const counter = Number(
      h.db.prepare("SELECT value FROM counters WHERE name = 'catalog'").get()?.value,
    )
    expect(Math.max(...versiones)).toBe(counter)
    // Una versión por cambio: dos filas con la misma versión harían ambiguo el "cambios desde N".
    expect(new Set(versiones).size).toBe(versiones.length)
  })

  it('el mismo restaurante en dos hubs distintos da exactamente las mismas filas', () => {
    const a = hub(ID_FIJO)
    const b = hub(ID_FIJO)
    a.cargar()
    b.cargar()
    expect(volcar(a.db, TABLAS_SEED)).toEqual(volcar(b.db, TABLAS_SEED))
    // Y las personas del seed tienen los mismos IDs (no los PIN).
    expect(volcar(a.db, ['locations'])).toEqual(volcar(b.db, ['locations']))
    const ids = (h: ReturnType<typeof hub>) =>
      h.db
        .prepare("SELECT id FROM users WHERE name <> 'Administrador' ORDER BY id")
        .all()
        .map((f) => f.id)
    expect(ids(a)).toEqual(ids(b))
  })

  it('el orden de la carta no cambia los IDs de los productos', () => {
    const original = leerCarta(TEXTO_CARTA)
    const barajada = stringify({
      secciones: (parse(TEXTO_CARTA) as { secciones: { platos: unknown[] }[] }).secciones
        .reverse()
        .map((s) => ({ ...s, platos: [...s.platos].reverse() })),
    })
    const a = hub(ID_FIJO)
    const b = hub(ID_FIJO)
    a.cargar(TEXTO_CARTA)
    b.cargar(barajada)
    const idsProductos = (h: ReturnType<typeof hub>) =>
      h.db
        .prepare('SELECT id, name, price FROM products ORDER BY id')
        .all()
        .map((f) => `${f.id}:${f.name}:${f.price}`)
    expect(idsProductos(b)).toEqual(idsProductos(a))
    expect(original.flatMap((c) => c.products)).toHaveLength(98)
  })

  it('todos los IDs del seed son ULID válidos y no se repiten entre tablas', () => {
    const h = hub()
    h.cargar()
    const ids = TABLAS_VERSIONADAS.flatMap((t) =>
      h.db
        .prepare(`SELECT id FROM ${t}`)
        .all()
        .map((f) => String(f.id)),
    )
    for (const id of ids) expect(isValidId(id)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('restaurantes distintos', () => {
  it('dos restaurantes con la misma marca de tiempo en la misma base no chocan en ningún ID', () => {
    const other = `${ID_FIJO.slice(0, 10)}ZZZZZZZZZZZZZZZZ`
    const a = hub(ID_FIJO)
    const b = hub(other, a.db)
    a.cargar()
    b.cargar()

    expect(
      contar(a.db, 'SELECT count(*) AS n FROM products WHERE restaurant_id = ?', ID_FIJO),
    ).toBe(98)
    expect(contar(a.db, 'SELECT count(*) AS n FROM products WHERE restaurant_id = ?', other)).toBe(
      98,
    )
    for (const tableName of TABLAS_VERSIONADAS) {
      const ids = a.db
        .prepare(`SELECT id FROM ${tableName}`)
        .all()
        .map((f) => String(f.id))
      expect(new Set(ids).size).toBe(ids.length)
    }
    // Repetir el seed de uno no toca al otro.
    const before = volcar(a.db, ['products'])
    b.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(volcar(a.db, ['products'])).toEqual(before)
  })

  it('con ULID de restaurantes distintos, la misma clave da IDs distintos aunque el prefijo sea igual', () => {
    const a = idEstable(ID_FIJO, 'mesa:1')
    const b = idEstable(`${ID_FIJO.slice(0, 10)}ZZZZZZZZZZZZZZZZ`, 'mesa:1')
    expect(a.slice(0, 10)).toBe(b.slice(0, 10))
    expect(a).not.toBe(b)
    expect(isValidId(a)).toBe(true)
    expect(isValidId(b)).toBe(true)
  })

  it('el ID depende de la clave exacta: mayúsculas y espacios dan IDs distintos', () => {
    const ids = ['mesa:1', 'mesa:01', 'Mesa:1', 'mesa: 1', 'mesa:1 '].map((c) =>
      idEstable(ID_FIJO, c),
    )
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('registros archivados a mano', () => {
  const idDe = (h: ReturnType<typeof hub>, key: string) => idEstable(h.restauranteId, key)
  const status = (h: ReturnType<typeof hub>, tableName: string, id: string) =>
    h.db.prepare(`SELECT active, version FROM ${tableName} WHERE id = ?`).get(id)

  it('el seed reactiva un producto, una mesa, una categoría y una opción archivados', () => {
    const h = hub()
    h.cargar()
    const objetivos = [
      ['products', idDe(h, 'producto:PIZZAS:quattro-formaggi')],
      ['dining_tables', idDe(h, 'mesa:7')],
      ['categories', idDe(h, 'categoria:PIZZAS')],
      ['modifiers', idDe(h, 'modificador:sabor:BEBIDAS:te-hatsu:Rojo')],
    ] as const
    const contadorAntes = Number(
      h.db.prepare("SELECT value FROM counters WHERE name = 'catalog'").get()?.value,
    )
    for (const [tableName, id] of objetivos)
      h.db.prepare(`UPDATE ${tableName} SET active = 0 WHERE id = ?`).run(id)

    const r = h.cargar(TEXTO_CARTA, MAS_TARDE)
    for (const [tableName, id] of objetivos) {
      expect({ tableName, ...status(h, tableName, id) }).toMatchObject({ tableName, active: 1 })
      expect(Number(status(h, tableName, id)?.version)).toBeGreaterThan(contadorAntes)
    }
    expect(r.sqlTables.products).toMatchObject({ created: 0, updated: 1 })
    expect(r.sqlTables.dining_tables).toMatchObject({ created: 0, updated: 1 })
    // No se duplicó nada.
    expect(contar(h.db, 'SELECT count(*) AS n FROM products')).toBe(98)
    expect(contar(h.db, 'SELECT count(*) AS n FROM dining_tables')).toBe(TABLES)

    // La corrida siguiente ya no cambia nada.
    const tercera = h.cargar(TEXTO_CARTA, '2026-10-26T09:00:00.000Z')
    expect(tercera.sqlTables.products).toMatchObject({ updated: 0 })
  })

  it('un producto archivado que además cambió de precio vuelve con el precio de la carta', () => {
    const h = hub()
    h.cargar()
    const id = idDe(h, 'producto:PIZZAS:quattro-formaggi')
    h.db.prepare('UPDATE products SET active = 0, price = 1 WHERE id = ?').run(id)
    h.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(h.db.prepare('SELECT active, price FROM products WHERE id = ?').get(id)).toEqual({
      active: 1,
      price: 44_900,
    })
  })

  it('un usuario archivado del seed no se recrea ni choca su ID, y no se le da PIN nuevo', () => {
    const h = hub()
    h.cargar()
    const id = idDe(h, 'usuario:caja')
    const fingerprint = h.db
      .prepare('SELECT pin_hash FROM user_credentials WHERE user_id = ?')
      .get(id)
    h.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id)

    const r = h.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(r.pins).toEqual([])
    expect(r.sqlTables.users?.created).toBe(0)
    expect(contar(h.db, 'SELECT count(*) AS n FROM users WHERE id = ?', id)).toBe(1)
    expect(h.db.prepare('SELECT pin_hash FROM user_credentials WHERE user_id = ?').get(id)).toEqual(
      fingerprint,
    )
  })
})

describe('cambios en la carta', () => {
  const names = (h: ReturnType<typeof hub>, sql = 'SELECT name FROM products WHERE active = 1') =>
    h.db
      .prepare(sql)
      .all()
      .map((f) => String(f.name))

  it('cambiar solo mayúsculas o acentos del nombre conserva el producto y actualiza el nombre', () => {
    const h = hub()
    h.cargar()
    const id = idEstable(h.restauranteId, 'producto:PIZZAS:quattro-formaggi')
    const r = h.cargar(
      TEXTO_CARTA.replace('es: Quattro Formaggi', 'es: Quattro formaggi'),
      MAS_TARDE,
    )
    expect(h.db.prepare('SELECT name FROM products WHERE id = ?').get(id)?.name).toBe(
      'Quattro formaggi',
    )
    expect(r.sqlTables.products).toMatchObject({ created: 0, updated: 1 })
    expect(contar(h.db, 'SELECT count(*) AS n FROM products')).toBe(98)

    // "Té Hatsu" → "Te Hatsu": mismo producto (la clave quita los acentos), con sus sabores.
    const hatsu = idEstable(h.restauranteId, 'producto:BEBIDAS:te-hatsu')
    h.cargar(TEXTO_CARTA.replace('es: Té Hatsu', 'es: Te Hatsu'), '2026-10-26T09:00:00.000Z')
    expect(h.db.prepare('SELECT name FROM products WHERE id = ?').get(hatsu)?.name).toBe('Te Hatsu')
    expect(contar(h.db, 'SELECT count(*) AS n FROM products')).toBe(98)
  })

  it('renombrar un plato crea el nuevo y archiva el viejo: la carta del mesero no queda duplicada', () => {
    const h = hub()
    h.cargar()
    const oldOne = idEstable(h.restauranteId, 'producto:PIZZAS:quattro-formaggi')
    const before = Number(
      h.db.prepare('SELECT version FROM products WHERE id = ?').get(oldOne)?.version,
    )
    const r = h.cargar(TEXTO_CARTA.replace('es: Quattro Formaggi', 'es: Cuatro Quesos'), MAS_TARDE)

    expect(r.sqlTables.products).toMatchObject({ created: 1, updated: 0, archived: 1 })
    const row = h.db.prepare('SELECT active, price, version FROM products WHERE id = ?').get(oldOne)
    expect(row).toMatchObject({ active: 0, price: 44_900 })
    // Archivar es un cambio más del catálogo: sube la versión para que los dispositivos lo reciban.
    expect(Number(row?.version)).toBeGreaterThan(before)
    expect(names(h)).toContain('Cuatro Quesos')
    expect(names(h)).not.toContain('Quattro Formaggi')
    expect(contar(h.db, 'SELECT count(*) AS n FROM products WHERE active = 1')).toBe(98)

    // Y la corrida siguiente ya no archiva nada más.
    const another = h.cargar(
      TEXTO_CARTA.replace('es: Quattro Formaggi', 'es: Cuatro Quesos'),
      '2026-10-26T09:00:00.000Z',
    )
    expect(another.sqlTables.products).toMatchObject({ created: 0, updated: 0, archived: 0 })
  })

  it('si el nombre vuelve a ser el de antes, el producto archivado se reactiva con su mismo ID', () => {
    const h = hub()
    h.cargar()
    const oldOne = idEstable(h.restauranteId, 'producto:PIZZAS:quattro-formaggi')
    h.cargar(TEXTO_CARTA.replace('es: Quattro Formaggi', 'es: Cuatro Quesos'), MAS_TARDE)
    h.cargar(TEXTO_CARTA, '2026-10-26T09:00:00.000Z')
    expect(h.db.prepare('SELECT active FROM products WHERE id = ?').get(oldOne)?.active).toBe(1)
    expect(
      contar(
        h.db,
        "SELECT count(*) AS n FROM products WHERE name = 'Cuatro Quesos' AND active = 1",
      ),
    ).toBe(0)
  })

  it('quitar un sabor, un plato o una sección de la carta archiva lo ya sembrado', () => {
    const h = hub()
    h.cargar()
    const recortada = TEXTO_CARTA.replace('es: Rojo/Amarillo/Blanco', 'es: Rojo/Amarillo/Verde')
    const r = h.cargar(recortada, MAS_TARDE)
    const flavors = (active: number) =>
      names(
        h,
        `SELECT m.name FROM modifiers m JOIN modifier_groups g ON g.id = m.group_id
         WHERE g.name = 'Sabor' AND m.active = ${active} AND m.name IN ('Rojo','Amarillo','Blanco','Verde')`,
      ).sort()
    expect(flavors(1)).toEqual(['Amarillo', 'Rojo', 'Verde'])
    expect(flavors(0)).toEqual(['Blanco'])
    expect(r.sqlTables.modifiers).toMatchObject({ created: 1, archived: 1 })

    const menu = parse(TEXTO_CARTA) as { secciones: { clave: string; platos: unknown[] }[] }
    const pizzas = menu.secciones.find((s) => s.clave === 'PIZZAS')?.platos.length ?? 0
    const sinPizzas = stringify({ secciones: menu.secciones.filter((s) => s.clave !== 'PIZZAS') })
    const r2 = h.cargar(sinPizzas, '2026-10-26T09:00:00.000Z')
    expect(
      contar(h.db, "SELECT count(*) AS n FROM categories WHERE name = 'Pizzas' AND active = 1"),
    ).toBe(0)
    expect(r2.sqlTables.categories).toMatchObject({ archived: 1 })
    expect(r2.sqlTables.products).toMatchObject({ archived: pizzas })
    expect(contar(h.db, 'SELECT count(*) AS n FROM products WHERE active = 1')).toBe(98 - pizzas)
    // Nada se borró: sigue todo en la base, archivado.
    expect(contar(h.db, 'SELECT count(*) AS n FROM products')).toBe(98)
  })

  it('lo que una persona editó o creó (usuario_id) no se pisa ni se archiva', () => {
    const h = hub()
    h.cargar()
    const quattro = idEstable(h.restauranteId, 'producto:PIZZAS:quattro-formaggi')
    const margarita = idEstable(h.restauranteId, 'producto:PIZZAS:garden-margarita')
    const manager = idEstable(h.restauranteId, 'usuario:gerente')
    // El gerente cambió un precio desde el editor; el seed no debe devolverlo.
    h.db
      .prepare('UPDATE products SET price = 50000, user_id = ? WHERE id = ?')
      .run(manager, quattro)
    // Y creó un producto propio que no está en la carta.
    const own = newId()
    h.db
      .prepare(
        `INSERT INTO products (id, restaurant_id, created_at, updated_at, version, user_id, category_id, name, price, tax_id)
         SELECT ?, restaurant_id, created_at, updated_at, 9999, ?, category_id, 'Plato del día', 25000, tax_id FROM products WHERE id = ?`,
      )
      .run(own, manager, quattro)

    const r = h.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(h.db.prepare('SELECT price, active FROM products WHERE id = ?').get(quattro)).toEqual({
      price: 50_000,
      active: 1,
    })
    expect(h.db.prepare('SELECT active FROM products WHERE id = ?').get(own)?.active).toBe(1)
    expect(r.sqlTables.products).toMatchObject({ respected: 1, archived: 0, updated: 0 })
    expect(h.db.prepare('SELECT active FROM products WHERE id = ?').get(margarita)?.active).toBe(1)

    // Un producto de una persona que sale de la carta tampoco se archiva.
    h.cargar(
      TEXTO_CARTA.replace('es: Quattro Formaggi', 'es: Cuatro Quesos'),
      '2026-10-26T09:00:00.000Z',
    )
    expect(h.db.prepare('SELECT active FROM products WHERE id = ?').get(quattro)?.active).toBe(1)
  })

  it('el impuesto que el contador cambió no se devuelve a la tarifa del seed', () => {
    const h = hub()
    h.cargar()
    h.db.prepare("UPDATE taxes SET rate = 1900 WHERE type = 'inc'").run()
    const r = h.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(h.db.prepare('SELECT rate FROM taxes').get()?.rate).toBe(1900)
    expect(r.sqlTables.taxes).toMatchObject({ respected: 1, updated: 0 })
  })

  it('un plato con disponible: false no se carga, y si ya estaba se archiva', () => {
    const h = hub()
    h.cargar()
    const id = idEstable(h.restauranteId, 'producto:PIZZAS:quattro-formaggi')
    const text = (menu: string) => menu
    const soldOut = text(
      TEXTO_CARTA.replace(/(es: Quattro Formaggi[\s\S]*?disponible: )true/, '$1false'),
    )
    expect(soldOut).not.toBe(TEXTO_CARTA)
    expect(leerCarta(soldOut).flatMap((c) => c.products)).toHaveLength(97)
    const r = h.cargar(soldOut, MAS_TARDE)
    expect(r.sqlTables.products).toMatchObject({ archived: 1, created: 0 })
    expect(h.db.prepare('SELECT active FROM products WHERE id = ?').get(id)?.active).toBe(0)

    // En un hub limpio ni siquiera se crea.
    const clean = hub()
    clean.cargar(soldOut)
    expect(contar(clean.db, 'SELECT count(*) AS n FROM products')).toBe(97)
  })

  it('mover un plato a otra sección lo siembra en la nueva y archiva el de la vieja', () => {
    const h = hub()
    h.cargar(cartaDe(section('A', [dish('Agua', 3000)]), section('B', [dish('Jugo', 5000)])))
    const r = h.cargar(
      cartaDe(section('A', []), section('B', [dish('Jugo', 5000), dish('Agua', 3000)])),
      MAS_TARDE,
    )
    expect(r.sqlTables.products).toMatchObject({ created: 1, archived: 1 })
    expect(
      contar(h.db, "SELECT count(*) AS n FROM products WHERE name = 'Agua' AND active = 1"),
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

  it('cambiar el precio de una variante actualiza la variante y el precio base solo si era la más barata', () => {
    const text = cartaDe(
      section('VINOS', [dish('Malbec Botella', 120_000), dish('Malbec Copa', 30_000)]),
    )
    const h = hub()
    h.cargar(text)
    const product = idEstable(h.restauranteId, 'producto:VINOS:malbec')

    const subeBotella = h.cargar(text.replace('120000', '125000'), MAS_TARDE)
    expect(subeBotella.sqlTables.variants).toMatchObject({ updated: 1, equal: 1 })
    expect(subeBotella.sqlTables.products).toMatchObject({ updated: 0 })

    const subeCopa = h.cargar(
      text.replace('120000', '125000').replace('30000', '31000'),
      '2026-10-26T09:00:00.000Z',
    )
    expect(subeCopa.sqlTables.variants).toMatchObject({ updated: 1, equal: 1 })
    expect(subeCopa.sqlTables.products).toMatchObject({ updated: 1 })
    expect(h.db.prepare('SELECT price FROM products WHERE id = ?').get(product)?.price).toBe(31_000)
  })
})

describe('variantes copa y botella', () => {
  const productsOf = (text: string) => leerCarta(text).flatMap((c) => c.products)

  it('una copa sola, sin su botella, queda como producto suelto con su nombre completo', () => {
    const [p] = productsOf(cartaDe(section('VINOS', [dish('Malbec Copa', 30_000)])))
    expect(p).toMatchObject({ name: 'Malbec Copa', price: 30_000, variants: [] })
  })

  it('una botella sola queda como producto suelto, con el tamaño al inicio o al final', () => {
    const ps = productsOf(
      cartaDe(
        section('VINOS', [dish('Botella Lambrusco', 99_000), dish('Merlot Botella', 90_000)]),
      ),
    )
    expect(ps.map((p) => [p.name, p.variants.length])).toEqual([
      ['Botella Lambrusco', 0],
      ['Merlot Botella', 0],
    ])
  })

  it('el tamaño al inicio también junta copa y botella en un producto', () => {
    const [p] = productsOf(
      cartaDe(section('VINOS', [dish('Botella Malbec', 120_000), dish('Copa Malbec', 30_000)])),
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

  it('el vino sin tamaño más su copa y su botella no se junta: tres productos', () => {
    const ps = productsOf(
      cartaDe(
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

  it('dos copas del mismo vino son un plato repetido y la lectura falla', () => {
    expect(() =>
      leerCarta(
        cartaDe(section('VINOS', [dish('Malbec Copa', 30_000), dish('Malbec Copa', 31_000)])),
      ),
    ).toThrow(/repetido/)
  })

  it('dos platos que solo difieren en mayúsculas o acentos son un plato repetido', () => {
    expect(() =>
      leerCarta(cartaDe(section('X', [dish('Café', 1000), dish('cafe', 2000)]))),
    ).toThrow(/repetido/)
  })

  it('la carta lista botella primero pero en la base la copa queda con orden 0', () => {
    const h = hub()
    h.cargar(
      cartaDe(section('VINOS', [dish('Malbec Botella', 120_000), dish('Malbec Copa', 30_000)])),
    )
    expect(h.db.prepare('SELECT name, position FROM variants ORDER BY position').all()).toEqual([
      { name: 'Copa', position: 0 },
      { name: 'Botella', position: 1 },
    ])
  })

  it('si la carta deja de tener la botella, el producto con variantes se archiva con sus dos variantes', () => {
    const h = hub()
    h.cargar(
      cartaDe(section('VINOS', [dish('Malbec Botella', 120_000), dish('Malbec Copa', 30_000)])),
    )
    const r = h.cargar(cartaDe(section('VINOS', [dish('Malbec Copa', 30_000)])), MAS_TARDE)
    // La copa suelta es otro producto ("Malbec Copa"); el viejo, con sus variantes, se archiva.
    expect(r.sqlTables.products).toMatchObject({ created: 1, archived: 1 })
    expect(r.sqlTables.variants).toMatchObject({ archived: 2 })
    expect(contar(h.db, 'SELECT count(*) AS n FROM variants WHERE active = 1')).toBe(0)
    expect(
      h.db
        .prepare('SELECT name FROM products WHERE active = 1')
        .all()
        .map((f) => f.name),
    ).toEqual(['Malbec Copa'])
  })

  it('con variantes, la descripción es la del primer plato que la traiga', () => {
    const [p] = leerCarta(
      cartaDe(
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

describe('sabores', () => {
  const hatsu = (description: string, name = 'Té Hatsu') =>
    cartaDe(section('BEBIDAS', [dish(name, 13_900, description)]))

  it('los sabores con acentos son opciones del grupo, estables entre corridas', () => {
    const h = hub()
    const text = hatsu('Limón/Piña/Maracuyá', 'Soda Hatsu')
    h.cargar(text)
    const names = h.db
      .prepare('SELECT name FROM modifiers ORDER BY position')
      .all()
      .map((f) => f.name)
    expect(names).toEqual(['Limón', 'Piña', 'Maracuyá'])
    const r = h.cargar(text, MAS_TARDE)
    expect(r.sqlTables.modifiers).toEqual({
      created: 0,
      updated: 0,
      equal: 3,
      respected: 0,
      archived: 0,
    })
  })

  it('los espacios alrededor de la barra se ignoran: "Rojo / Amarillo" vale', () => {
    const [p] = leerCarta(hatsu('  Rojo / Amarillo /Blanco ')).flatMap((c) => c.products)
    expect(p?.groups[0]?.options.map((o) => o.name)).toEqual(['Rojo', 'Amarillo', 'Blanco'])
    expect(p?.description).toBeNull()
  })

  it('un sabor con espacio interno es un solo sabor', () => {
    const [p] = leerCarta(hatsu('Fresa Limón/Maracuyá')).flatMap((c) => c.products)
    expect(p?.groups[0]?.options.map((o) => o.name)).toEqual(['Fresa Limón', 'Maracuyá'])
  })

  it('sabores obligatorios y sin costo', () => {
    const [p] = leerCarta(hatsu('Rojo/Blanco')).flatMap((c) => c.products)
    expect(p?.groups[0]).toMatchObject({ minimum: 1, maximum: 1 })
    expect(p?.groups[0]?.options.every((o) => o.extraPrice === 0)).toBe(true)
  })

  it('el Té Hatsu o la Soda Hatsu con menos de dos sabores es un error de la carta', () => {
    for (const description of ['Natural', 'Rojo', 'Rojo/', '/Rojo', 'Rojo//', ' / ', ''])
      expect(() => leerCarta(hatsu(description)), description).toThrow(/sabores/)
    expect(() => leerCarta(cartaDe(section('B', [dish('Té Hatsu', 1)])))).toThrow(/sabores/)
    expect(() => leerCarta(hatsu('Rojo', 'Soda Hatsu'))).toThrow(/sabores/)
  })

  it('un sabor repetido ("Rojo/Rojo") es un error de la carta, con o sin acentos y mayúsculas', () => {
    for (const description of ['Rojo/Rojo/Blanco', 'Rojo/rojo', 'Limón/Limon', ' Rojo /Rojo '])
      expect(() => leerCarta(hatsu(description)), description).toThrow(/repite/)
  })

  it('otro plato con barras en la descripción no se vuelve sabor', () => {
    for (const description of ['Jamón/Queso', 'Rojo/Amarillo', 'Aguacate / Tomate']) {
      const [p] = leerCarta(cartaDe(section('S', [dish('Sándwich', 9000, description)]))).flatMap(
        (c) => c.products,
      )
      expect({ description, groups: p?.groups.length, text: p?.description }).toEqual({
        description,
        groups: 0,
        text: description,
      })
    }
  })

  it('si la carta ya no trae el Té Hatsu o la Tagliata, `reglasSinPlato` lo avisa', () => {
    expect(rulesWithoutDish(leerCarta(TEXTO_CARTA))).toEqual([])
    expect(rulesWithoutDish(leerCarta(cartaDe(section('S', [dish('Agua', 1)]))))).toEqual([
      'Tagliata di Manzo',
      'Té Hatsu',
      'Soda Hatsu',
    ])
  })

  it('el grupo de término de la carne se comparte entre productos y se crea una sola vez', () => {
    const h = hub()
    h.cargar()
    expect(
      contar(h.db, "SELECT count(*) AS n FROM modifier_groups WHERE name = 'Término de la carne'"),
    ).toBe(1)
    expect(
      contar(
        h.db,
        'SELECT count(*) AS n FROM modifiers WHERE group_id = ?',
        idEstable(h.restauranteId, 'grupo:termino'),
      ),
    ).toBe(4)
    expect(
      contar(
        h.db,
        'SELECT count(*) AS n FROM product_modifier_groups WHERE group_id = ?',
        idEstable(h.restauranteId, 'grupo:termino'),
      ),
    ).toBeGreaterThan(1)
  })
})

describe('secciones ocultas', () => {
  const dosSecciones = (visibleA: boolean, visibleB = true) =>
    cartaDe(
      section('A', [dish('Agua', 3000)], { visible: visibleA }),
      section('B', [dish('Jugo', 5000)], { visible: visibleB }),
    )

  it('una sección invisible no se siembra y el orden de las visibles queda seguido', () => {
    const menu = leerCarta(
      cartaDe(
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
    h.cargar(
      cartaDe(section('A', [dish('a', 1)], { visible: false }), section('B', [dish('b', 1)])),
    )
    expect(contar(h.db, 'SELECT count(*) AS n FROM categories')).toBe(1)
    expect(contar(h.db, 'SELECT count(*) AS n FROM products')).toBe(1)
  })

  it('las claves de sección son únicas en toda la carta, también las de secciones invisibles', () => {
    expect(() =>
      leerCarta(
        cartaDe(section('A', [dish('x', 1)], { visible: false }), section('A', [dish('y', 1)])),
      ),
    ).toThrow(/repetida/)
  })

  it('una clave de sección con espacios, ":" o "|" se rechaza porque va dentro de los IDs', () => {
    for (const key of ['A B', 'A:B', 'A|B', '', ' A'])
      expect(() => leerCarta(cartaDe(section(key, [dish('x', 1)]))), key).toThrow()
  })

  it('una sección invisible con un precio inválido sí falla: la carta se valida entera', () => {
    expect(() =>
      leerCarta(
        cartaDe(section('A', [dish('x', 1.5)], { visible: false }), section('B', [dish('y', 1)])),
      ),
    ).toThrow()
  })

  it('ocultar una sección ya sembrada la archiva con sus productos y deja el orden seguido', () => {
    const h = hub()
    h.cargar(dosSecciones(true))
    const r = h.cargar(dosSecciones(false), MAS_TARDE)
    expect(r.sqlTables.categories).toMatchObject({ archived: 1, updated: 1 })
    expect(r.sqlTables.products).toMatchObject({ archived: 1 })
    expect(contar(h.db, 'SELECT count(*) AS n FROM categories WHERE active = 1')).toBe(1)
    expect(h.db.prepare("SELECT position FROM categories WHERE name = 'B'").get()?.position).toBe(0)
    expect(h.db.prepare("SELECT active FROM products WHERE name = 'Agua'").get()?.active).toBe(0)
    // Mostrarla otra vez la reactiva.
    h.cargar(dosSecciones(true), '2026-10-26T09:00:00.000Z')
    expect(contar(h.db, 'SELECT count(*) AS n FROM products WHERE active = 1')).toBe(2)
  })

  it('una carta con todas las secciones ocultas no deja categorías ni productos', () => {
    const h = hub()
    h.cargar(dosSecciones(true))
    h.cargar(dosSecciones(false, false), MAS_TARDE)
    expect(contar(h.db, 'SELECT count(*) AS n FROM products WHERE active = 1')).toBe(0)
    expect(contar(h.db, 'SELECT count(*) AS n FROM categories WHERE active = 1')).toBe(0)
    expect(contar(h.db, 'SELECT count(*) AS n FROM dining_tables WHERE active = 1')).toBe(TABLES)
  })
})

describe('seed interrumpido', () => {
  /** La base que lanza al preparar la sentencia que cumpla `cuando`: el proceso murió ahí. */
  function conFalla(db: BaseSqlite, cuando: (sql: string) => boolean): BaseSqlite {
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        if (cuando(sql)) throw new Error('el proceso murió')
        return db.prepare(sql)
      },
      close: () => db.close(),
    }
  }

  it('si muere a mitad del catálogo no queda nada a medias y la siguiente corrida deja el resultado limpio', () => {
    const h = hub(ID_FIJO)
    const allRows = [...TABLAS_VERSIONADAS, 'counters', 'user_credentials']
    const before = volcar(h.db, allRows)

    let insertados = 0
    const faulty = conFalla(
      h.db,
      (sql) => sql.startsWith('INSERT INTO products ') && ++insertados === 50,
    )
    expect(() =>
      sembrar(
        faulty,
        h.access,
        { restauranteId: h.restauranteId, roles: h.roles, menu: leerCarta(TEXTO_CARTA) },
        AHORA,
      ),
    ).toThrow('el proceso murió')

    // Ni salón, ni estaciones, ni impuesto, ni el nombre del restaurante: nada se guardó.
    expect(volcar(h.db, allRows)).toEqual(before)
    expect(h.db.prepare('SELECT name FROM restaurants').get()?.name).toBe('Mi restaurante')
    expect(contar(h.db, 'SELECT count(*) AS n FROM dining_tables')).toBe(0)

    // Sin restos que estorben: queda igual que en un hub que corrió el seed sin interrupción.
    const clean = hub(ID_FIJO)
    clean.cargar()
    h.cargar()
    expect(volcar(h.db, TABLAS_SEED)).toEqual(volcar(clean.db, TABLAS_SEED))
  })

  it('si falla al crear al personal no queda nada: ni catálogo ni usuarios, y la siguiente corrida lo crea todo', () => {
    const h = hub(ID_FIJO)
    const allRows = [...TABLAS_VERSIONADAS, 'counters', 'user_credentials']
    const before = volcar(h.db, allRows)
    let llamadas = 0
    const quebradiza = {
      insertUser: (...args: Parameters<ServicioAcceso['insertUser']>) => {
        if (++llamadas === 4) throw new Error('el proceso murió')
        return h.access.insertUser(...args)
      },
    } as unknown as ServicioAcceso

    expect(() => h.cargar(TEXTO_CARTA, AHORA, quebradiza)).toThrow('el proceso murió')
    expect(llamadas).toBe(4)
    // Los tres usuarios que se alcanzaron a crear también se deshicieron, con sus PIN.
    expect(volcar(h.db, allRows)).toEqual(before)

    const r = h.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(r.pins.map((p) => p.name)).toEqual(PERSONAL.map((p) => p.name))
    expect(contar(h.db, 'SELECT count(*) AS n FROM users')).toBe(PERSONAL.length)
    expect(contar(h.db, 'SELECT count(*) AS n FROM products')).toBe(98)
    const clean = hub(ID_FIJO)
    clean.cargar(TEXTO_CARTA, MAS_TARDE)
    expect(volcar(h.db, TABLAS_SEED)).toEqual(volcar(clean.db, TABLAS_SEED))
  })

  it('con `sinPersonal` se carga el catálogo sin crear a nadie ni entregar PIN', () => {
    const h = hub()
    const r = sembrar(
      h.db,
      h.access,
      {
        restauranteId: h.restauranteId,
        roles: h.roles,
        menu: leerCarta(TEXTO_CARTA),
        sinPersonal: true,
      },
      AHORA,
    )
    expect(r.pins).toEqual([])
    expect(r.sqlTables.users).toBeUndefined()
    expect(contar(h.db, 'SELECT count(*) AS n FROM users')).toBe(0)
    expect(contar(h.db, 'SELECT count(*) AS n FROM products')).toBe(98)
    // Y una corrida normal después completa el personal.
    expect(h.cargar(TEXTO_CARTA, MAS_TARDE).pins).toHaveLength(PERSONAL.length)
  })

  it('una configuración del restaurante inválida detiene el seed sin escribir nada', () => {
    const h = hub()
    h.db.prepare('UPDATE restaurants SET config = \'{"odd_field":1}\'').run()
    const allRows = [...TABLAS_VERSIONADAS, 'counters']
    const before = volcar(h.db, allRows)
    expect(() => h.cargar()).toThrow()
    expect(volcar(h.db, allRows)).toEqual(before)
  })

  it('un restaurante sin sede detiene el seed con un mensaje claro y sin cambiar su nombre', () => {
    const h = hub()
    h.db.exec('DROP TRIGGER locations_no_delete')
    h.db.exec('DELETE FROM locations')
    expect(() => h.cargar()).toThrow(/sede/)
    expect(h.db.prepare('SELECT name FROM restaurants').get()?.name).toBe('Mi restaurante')
    expect(contar(h.db, 'SELECT count(*) AS n FROM dining_tables')).toBe(0)
  })

  it('una carta con un precio inválido falla antes de tocar la base', () => {
    const h = hub()
    const before = volcar(h.db, TABLAS_VERSIONADAS)
    expect(() => h.cargar(TEXTO_CARTA.replace('precio: 44900', 'precio: 44900.5'))).toThrow()
    expect(volcar(h.db, TABLAS_VERSIONADAS)).toEqual(before)
  })
})
