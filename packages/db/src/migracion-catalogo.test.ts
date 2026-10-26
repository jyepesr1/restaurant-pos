import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones, versionActual } from './migrar'
import { abrirBase } from './node'
import { AHORA, insertarEnTabla, insertarVersionado } from './pruebas/utiles'
import type { BaseSqlite } from './sqlite'

// La migración 3 sobre una base real de la versión 2: el historial del catálogo (`catalog_changes`)
// queda con una fila por registro y no se puede reescribir.

const HASTA_V2 = MIGRACIONES.filter((m) => m.version <= 2)
// Hasta la 3: las pruebas de esta migración no dependen de las que vengan después.
const HASTA_V3 = MIGRACIONES.filter((m) => m.version <= 3)
const TABLAS_CATALOGO = [
  'taxes',
  'stations',
  'categories',
  'products',
  'variants',
  'modifier_groups',
  'product_modifier_groups',
  'modifiers',
  'product_stations',
] as const

/** Una base en la versión 2 con un restaurante cuyo catálogo tiene un registro en cada tabla. */
function baseVersion2() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db, HASTA_V2)
  const restaurant = newId()
  let version = 0
  // Como el hub: cada registro toma el siguiente valor del contador.
  const v = (fields: Record<string, string | number | null> = {}) => ({
    version: ++version,
    updated_at: `2026-10-24T15:00:${String(version).padStart(2, '0')}.000Z`,
    ...fields,
  })
  insertarVersionado(db, 'restaurants', restaurant, { name: 'Prueba', config: '{}' }, restaurant)
  const record = (tabla: string, fields: Record<string, string | number | null>) =>
    insertarVersionado(db, tabla, restaurant, v(fields))

  const tax = record('taxes', { name: 'INC 8 %', type: 'inc', rate: 800 })
  const exempt = record('taxes', { name: 'Exento', type: 'exempt', rate: 0 })
  const station = record('stations', { name: 'Cocina', position: 1 })
  const category = record('categories', {
    name: 'Pizzas',
    position: 2,
    station_id: station,
    photo: 'pizzas.jpg',
    user_id: newId(),
    device_id: newId(),
  })
  const product = record('products', {
    category_id: category,
    name: 'Margarita',
    description: null,
    price: 40_900,
    tax_id: tax,
    favorite: 1,
  })
  // Archivado: también entra al historial, con activo = 0.
  const archived = record('products', {
    category_id: category,
    name: 'Vieja',
    price: 1_000,
    tax_id: exempt,
    active: 0,
  })
  const variant = record('variants', {
    product_id: product,
    name: 'Grande',
    price: 50_000,
    position: 1,
  })
  const group = record('modifier_groups', { name: 'Extras', minimum: 0, maximum: 3 })
  record('product_modifier_groups', { product_id: product, group_id: group, position: 0 })
  record('modifiers', { group_id: group, name: 'Queso', extra_price: 3_000, position: 0 })
  record('product_stations', { product_id: product, station_id: station })
  // El contador global del catálogo, como lo deja el hub.
  db.prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', ?)").run(
    restaurant,
    version,
  )
  return { db, restaurant, product, archived, variant, category, ultimaVersion: version }
}

const historial = (db: BaseSqlite) =>
  db.prepare('SELECT * FROM catalog_changes ORDER BY version').all()

describe('migración 3 sobre una base de la versión 2', () => {
  it('es la migración 3 y crea el historial', () => {
    const { db } = baseVersion2()
    expect(MIGRACIONES.find((m) => m.version === 3)?.name).toBe('catalog_changes')
    expect(versionActual(db)).toBe(2)
    expect(aplicarMigraciones(db, HASTA_V3)).toEqual([3])
    expect(versionActual(db)).toBe(3)
  })

  it('deja una fila por registro del catálogo, también los archivados', () => {
    const { db, restaurant } = baseVersion2()
    const before: Record<string, number> = {}
    for (const t of TABLAS_CATALOGO)
      before[t] = Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.n)

    aplicarMigraciones(db)

    for (const t of TABLAS_CATALOGO) {
      const n = Number(
        db.prepare('SELECT count(*) AS n FROM catalog_changes WHERE entity = ?').get(t)?.n,
      )
      expect(n, t).toBe(before[t])
    }
    expect(historial(db)).toHaveLength(Object.values(before).reduce((a, b) => a + b, 0))
    expect(historial(db)).toHaveLength(11)
    // Solo del catálogo: ni el restaurante ni nada más entra.
    expect(db.prepare("SELECT 1 FROM catalog_changes WHERE entity = 'restaurants'").get()).toBe(
      undefined,
    )
    expect(historial(db).every((f) => f.restaurant_id === restaurant)).toBe(true)
  })

  it('cada fila conserva la versión, el autor y la hora del registro, sin estado anterior', () => {
    const { db, category } = baseVersion2()
    const fila = db.prepare('SELECT * FROM categories WHERE id = ?').get(category)
    aplicarMigraciones(db)

    const change = db.prepare('SELECT * FROM catalog_changes WHERE record_id = ?').get(category)
    expect(change).toMatchObject({
      version: fila?.version,
      entity: 'categories',
      before: null,
      user_id: fila?.user_id,
      device_id: fila?.device_id,
      done_at: fila?.updated_at,
    })
    expect(JSON.parse(String(change?.after))).toEqual(fila)
  })

  it('el estado guardado trae todas las columnas de cada tabla, ni una más ni una menos', () => {
    const { db } = baseVersion2()
    aplicarMigraciones(db)
    for (const tabla of TABLAS_CATALOGO) {
      const columnas = db
        .prepare(`PRAGMA table_info(${tabla})`)
        .all()
        .map((c) => String(c.name))
        .sort()
      const change = db.prepare('SELECT after FROM catalog_changes WHERE entity = ?').get(tabla)
      expect(Object.keys(JSON.parse(String(change?.after))).sort(), tabla).toEqual(columnas)
    }
  })

  it('el estado guardado es igual a la fila de la tabla (valores y tipos)', () => {
    const { db } = baseVersion2()
    aplicarMigraciones(db)
    for (const tabla of TABLAS_CATALOGO) {
      for (const fila of db.prepare(`SELECT * FROM ${tabla}`).all()) {
        const change = db
          .prepare('SELECT after FROM catalog_changes WHERE record_id = ?')
          .get(fila.id ?? '')
        expect(JSON.parse(String(change?.after)), `${tabla} ${fila.id}`).toEqual(fila)
      }
    }
  })

  it('no toca los datos de la versión 2', () => {
    const { db } = baseVersion2()
    const photo = () =>
      TABLAS_CATALOGO.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())
    const before = photo()
    aplicarMigraciones(db)
    expect(photo()).toEqual(before)
  })

  it('anota desde qué versión hay historial: la última del contador al migrar', () => {
    const { db, restaurant, ultimaVersion } = baseVersion2()
    aplicarMigraciones(db)
    const counter = (name: string) =>
      db
        .prepare('SELECT value FROM counters WHERE restaurant_id = ? AND name = ?')
        .get(restaurant, name)?.value
    expect(counter('history_since')).toBe(ultimaVersion)
    expect(counter('catalog')).toBe(ultimaVersion)
    // Una migración repetida no lo mueve.
    aplicarMigraciones(db)
    expect(counter('history_since')).toBe(ultimaVersion)
  })

  it('sin contador de catálogo (base sin ediciones) no inventa historial_desde', () => {
    const db = abrirBase(':memory:')
    aplicarMigraciones(db, HASTA_V2)
    const r = newId()
    insertarVersionado(db, 'restaurants', r, { name: 'P', config: '{}' }, r)
    aplicarMigraciones(db)
    expect(db.prepare("SELECT 1 FROM counters WHERE name = 'history_since'").get()).toBe(undefined)
  })

  it('una base de la versión 2 sin catálogo migra con el historial vacío', () => {
    const db = abrirBase(':memory:')
    aplicarMigraciones(db, HASTA_V2)
    expect(aplicarMigraciones(db, HASTA_V3)).toEqual([3])
    expect(historial(db)).toEqual([])
  })

  it('repetir la migración no duplica el historial', () => {
    const { db } = baseVersion2()
    aplicarMigraciones(db)
    const n = historial(db).length
    expect(aplicarMigraciones(db)).toEqual([])
    expect(historial(db)).toHaveLength(n)
  })

  it('con dos restaurantes en la misma base, cada uno conserva su propio historial', () => {
    const { db, restaurant } = baseVersion2()
    const other = newId()
    insertarVersionado(db, 'restaurants', other, { name: 'Otro', config: '{}' }, other)
    // Las mismas versiones que el primero: la llave es (restaurante, versión).
    insertarVersionado(db, 'stations', other, { name: 'Barra', version: 1 })
    aplicarMigraciones(db)
    const lookup = (r: string) =>
      Number(
        db.prepare('SELECT count(*) AS n FROM catalog_changes WHERE restaurant_id = ?').get(r)?.n,
      )
    expect(lookup(restaurant)).toBe(11)
    expect(lookup(other)).toBe(1)
  })

  it('si dos registros comparten versión la migración falla entera y la base sigue en la 2', () => {
    // Nunca pasa con el contador del hub; si pasara, mejor frenar que perder historia.
    const { db, restaurant } = baseVersion2()
    insertarVersionado(db, 'stations', restaurant, { name: 'Repetida', version: 1 })
    expect(() => aplicarMigraciones(db)).toThrow()
    expect(versionActual(db)).toBe(2)
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'catalog_changes'").get()).toBe(
      undefined,
    )
  })
})

describe('el historial del catálogo es de solo agregar', () => {
  function migrada() {
    const m = baseVersion2()
    aplicarMigraciones(m.db)
    const fila = historial(m.db)[0]
    return { ...m, fila }
  }

  it('rechaza UPDATE', () => {
    const { db } = migrada()
    expect(() => db.exec("UPDATE catalog_changes SET after = '{}'")).toThrow(/no se modifican/)
    expect(() => db.exec('UPDATE catalog_changes SET user_id = NULL')).toThrow(/no se modifican/)
  })

  it('rechaza DELETE', () => {
    const { db } = migrada()
    const n = historial(db).length
    expect(() => db.exec('DELETE FROM catalog_changes')).toThrow(/no se borran/)
    expect(() => db.exec('DELETE FROM catalog_changes WHERE version = 1')).toThrow(/no se borran/)
    expect(historial(db)).toHaveLength(n)
  })

  it('rechaza INSERT OR REPLACE y REPLACE INTO sobre una versión existente', () => {
    const { db, restaurant, fila } = migrada()
    const before = historial(db)
    const reemplazo = (verbo: string) =>
      db
        .prepare(
          `${verbo} INTO catalog_changes (restaurant_id, version, entity, record_id, after, done_at)
           VALUES (?, ?, 'products', ?, '{"falso":true}', ?)`,
        )
        .run(restaurant, Number(fila?.version), newId(), AHORA)
    expect(() => reemplazo('INSERT OR REPLACE')).toThrow(/no se reemplazan/)
    expect(() => reemplazo('REPLACE')).toThrow(/no se reemplazan/)
    expect(() => reemplazo('INSERT')).toThrow(/no se reemplazan/)
    expect(historial(db)).toEqual(before)
  })

  it('INSERT OR IGNORE sobre una versión existente tampoco cambia nada', () => {
    const { db, restaurant, fila } = migrada()
    const before = historial(db)
    try {
      db.prepare(
        `INSERT OR IGNORE INTO catalog_changes (restaurant_id, version, entity, record_id, after, done_at)
         VALUES (?, ?, 'products', ?, '{}', ?)`,
      ).run(restaurant, Number(fila?.version), newId(), AHORA)
    } catch {
      // Abortar también está bien: lo que importa es que la historia no cambie.
    }
    expect(historial(db)).toEqual(before)
  })

  it('sí deja agregar una versión nueva, incluso del mismo registro (muchos cambios)', () => {
    const { db, restaurant, product, ultimaVersion } = migrada()
    for (let i = 1; i <= 50; i++)
      db.prepare(
        `INSERT INTO catalog_changes (restaurant_id, version, entity, record_id, before, after, done_at)
         VALUES (?, ?, 'products', ?, NULL, ?, ?)`,
      ).run(restaurant, ultimaVersion + i, product, JSON.stringify({ price: i }), AHORA)
    const n = Number(
      db.prepare('SELECT count(*) AS n FROM catalog_changes WHERE record_id = ?').get(product)?.n,
    )
    expect(n).toBe(51)
  })

  it('valida lo que se agrega: entidad, id, JSON y restaurante', () => {
    const { db, restaurant, ultimaVersion } = migrada()
    const insertar = (fields: {
      entity?: string
      registro?: string
      before?: string | null
      after?: string
      restaurant?: string
      version?: number
    }) =>
      db
        .prepare(
          `INSERT INTO catalog_changes (restaurant_id, version, entity, record_id, before, after, done_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fields.restaurant ?? restaurant,
          fields.version ?? ultimaVersion + 1,
          fields.entity ?? 'products',
          fields.registro ?? newId(),
          fields.before ?? null,
          fields.after ?? '{}',
          AHORA,
        )
    expect(() => insertar({ entity: 'dining_tables' })).toThrow()
    expect(() => insertar({ entity: 'restaurants' })).toThrow()
    expect(() => insertar({ registro: 'corto' })).toThrow()
    expect(() => insertar({ after: 'no es json' })).toThrow()
    expect(() => insertar({ before: '{roto' })).toThrow()
    expect(() => insertar({ restaurant: newId() })).toThrow()
    expect(() => insertar({ version: -1 })).toThrow()
    expect(() => insertar({})).not.toThrow()
  })

  it('la tabla está declarada como inmutable en el esquema', async () => {
    const { TABLAS_INMUTABLES } = await import('./esquema')
    expect(TABLAS_INMUTABLES).toContain('catalog_changes')
  })

  it('insertar directo en el catálogo no escribe el historial (eso lo hace el hub)', () => {
    // Insertar directo en el catálogo (sin pasar por el hub) no escribe el historial: eso lo hace
    // el hub, no la base.
    const { db, restaurant } = migrada()
    const n = historial(db).length
    insertarEnTabla(db, 'stations', {
      id: newId(),
      restaurant_id: restaurant,
      created_at: AHORA,
      updated_at: AHORA,
      version: 999,
      name: 'Nueva',
      position: 0,
    })
    expect(historial(db)).toHaveLength(n)
  })
})
