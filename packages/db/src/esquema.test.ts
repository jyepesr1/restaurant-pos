import { newId } from '@pos/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  COLUMNAS_COMUNES,
  TABLAS_INMUTABLES,
  TABLAS_LOCALES,
  TABLAS_PROYECCION,
  TABLAS_VERSIONADAS,
} from './esquema'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones } from './migrar'
import { abrirBase } from './node'
import type { BaseSqlite, ValorSql } from './sqlite'

const AHORA = '2026-10-24T15:00:00.000Z'

function nombresDeTablas(db: BaseSqlite): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((fila) => String(fila.name))
}

/** Inserta una fila con las columnas comunes de un registro versionado. */
function insertarVersionado(
  db: BaseSqlite,
  tabla: string,
  restauranteId: string,
  fields: Record<string, ValorSql>,
  id = newId(),
): string {
  const fila: Record<string, ValorSql> = {
    id,
    restaurant_id: restauranteId,
    created_at: AHORA,
    updated_at: AHORA,
    version: 1,
    ...fields,
  }
  const columnas = Object.keys(fila)
  db.prepare(
    `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
  ).run(...Object.values(fila))
  return id
}

/** Restaurante con lo mínimo para crear productos. */
function sembrarMinimo(db: BaseSqlite) {
  const restaurant = newId()
  insertarVersionado(db, 'restaurants', restaurant, { name: 'Prueba', config: '{}' }, restaurant)
  const tax = insertarVersionado(db, 'taxes', restaurant, {
    name: 'INC 8 %',
    type: 'inc',
    rate: 800,
  })
  const category = insertarVersionado(db, 'categories', restaurant, { name: 'Pizzas' })
  return { restaurant, tax, category }
}

function insertarEvento(db: BaseSqlite, restaurant: string, fields: Record<string, ValorSql> = {}) {
  const fila: Record<string, ValorSql> = {
    restaurant_id: restaurant,
    id: newId(),
    type: 'OrderOpened',
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: newId(),
    data: '{"channel":"salon"}',
    user_id: newId(),
    device_id: newId(),
    device_time: AHORA,
    hub_estimated_time: AHORA,
    base_sequence: 0,
    sequence: 1,
    received_at: AHORA,
    business_day: '2026-10-24',
    content_hash: 'abc',
    ...fields,
  }
  const columnas = Object.keys(fila)
  db.prepare(
    `INSERT INTO events (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
  ).run(...Object.values(fila))
  return fila
}

describe('migraciones', () => {
  it('crean la base desde cero y no repiten nada en una segunda corrida', () => {
    const db = abrirBase(':memory:')

    expect(aplicarMigraciones(db)).toEqual(MIGRACIONES.map((m) => m.version))
    expect(aplicarMigraciones(db)).toEqual([])
  })

  it('se niegan a abrir una base más nueva que la aplicación', () => {
    const db = abrirBase(':memory:')
    aplicarMigraciones(db)
    db.prepare(
      "INSERT INTO migrations (version, name, hash, applied_at) VALUES (99, 'futura', 'x', ?)",
    ).run(AHORA)

    expect(() => aplicarMigraciones(db)).toThrow(/más nueva que esta aplicación/)
  })

  it('si una migración falla, la base queda en la versión anterior', () => {
    const db = abrirBase(':memory:')
    const migraciones = [
      { version: 1, name: 'buena', sql: 'CREATE TABLE a (x INTEGER) STRICT;' },
      {
        version: 2,
        name: 'broken',
        sql: 'CREATE TABLE b (x INTEGER) STRICT; SELECT * FROM not_found;',
      },
    ]

    expect(() => aplicarMigraciones(db, migraciones)).toThrow()
    expect(nombresDeTablas(db)).toContain('a')
    expect(nombresDeTablas(db)).not.toContain('b')
    expect(db.prepare('SELECT max(version) AS v FROM migrations').get()?.v).toBe(1)
  })

  it('exigen numeración consecutiva', () => {
    const db = abrirBase(':memory:')
    const migraciones = [{ version: 2, name: 'salta', sql: 'SELECT 1;' }]

    expect(() => aplicarMigraciones(db, migraciones)).toThrow(/numeradas/)
  })
})

describe('esquema', () => {
  let db: BaseSqlite

  beforeEach(() => {
    db = abrirBase(':memory:')
    aplicarMigraciones(db)
  })

  it('toda tabla está en exactamente una categoría', () => {
    const clasificadas = [
      ...TABLAS_VERSIONADAS,
      ...TABLAS_INMUTABLES,
      ...TABLAS_PROYECCION,
      ...TABLAS_LOCALES,
    ]

    expect(new Set(clasificadas).size).toBe(clasificadas.length)
    expect(nombresDeTablas(db).sort()).toEqual([...clasificadas].sort())
  })

  it('todas las tablas son STRICT', () => {
    const noEstrictas = db
      .prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND strict = 0")
      .all()
      .map((fila) => String(fila.name))
      .filter((name) => !name.startsWith('sqlite_'))

    expect(noEstrictas).toEqual([])
  })

  it.each(TABLAS_VERSIONADAS)('%s tiene las columnas comunes', (tabla) => {
    const columnas = db
      .prepare(`SELECT name FROM pragma_table_info('${tabla}')`)
      .all()
      .map((fila) => String(fila.name))

    expect(columnas).toEqual(expect.arrayContaining([...COLUMNAS_COMUNES]))
  })

  it('las claves foráneas están activas', () => {
    const { restaurant } = sembrarMinimo(db)

    expect(() =>
      insertarVersionado(db, 'dining_tables', restaurant, {
        zone_id: newId(),
        name: '1',
        shape: 'round',
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        capacity: 4,
      }),
    ).toThrow(/FOREIGN KEY/)
  })
})

describe('dinero en la base', () => {
  let db: BaseSqlite
  let base: ReturnType<typeof sembrarMinimo>

  beforeEach(() => {
    db = abrirBase(':memory:')
    aplicarMigraciones(db)
    base = sembrarMinimo(db)
  })

  const product = (price: ValorSql) =>
    insertarVersionado(db, 'products', base.restaurant, {
      category_id: base.category,
      name: 'Garden Margarita',
      price,
      tax_id: base.tax,
    })

  it('acepta precios enteros en pesos', () => {
    expect(() => product(40900)).not.toThrow()
    expect(() => product(0)).not.toThrow()
  })

  it('rechaza precios con decimales', () => {
    expect(() => product(40900.5)).toThrow(/REAL/)
  })

  it.each([-1, 100_000_001])('rechaza el precio %d (fuera de rango)', (price) => {
    expect(() => product(price)).toThrow(/CHECK/)
  })

  it.each([-1, 10_001, 8.5])('rechaza la tarifa de impuesto %d', (rate) => {
    expect(() =>
      insertarVersionado(db, 'taxes', base.restaurant, { name: 'X', type: 'iva', rate }),
    ).toThrow()
  })

  it.each([0, 1000])('rechaza la cantidad %d en un ítem de pedido', (quantity) => {
    const order = newId()
    db.prepare(
      `INSERT INTO orders (id, restaurant_id, channel, status, opened_at, last_sequence)
       VALUES (?, ?, 'dine_in', 'open', ?, 1)`,
    ).run(order, base.restaurant, AHORA)

    expect(() =>
      db
        .prepare(
          `INSERT INTO order_items (id, restaurant_id, order_id, position, product_id, name,
             unit_price, tax_type, rate, quantity, status, added_by)
           VALUES (?, ?, ?, 1, ?, 'Pinsa', 20900, 'inc', 800, ?, 'pending', ?)`,
        )
        .run(newId(), base.restaurant, order, newId(), quantity, newId()),
    ).toThrow(/CHECK/)
  })
})

describe('eventos', () => {
  let db: BaseSqlite
  let restaurant: string

  beforeEach(() => {
    db = abrirBase(':memory:')
    aplicarMigraciones(db)
    restaurant = sembrarMinimo(db).restaurant
  })

  it('no se pueden modificar', () => {
    const event = insertarEvento(db, restaurant)

    expect(() =>
      db.prepare("UPDATE events SET data = '{}' WHERE id = ?").run(event.id ?? null),
    ).toThrow(/no se modifican/)
  })

  it('no se pueden borrar', () => {
    const event = insertarEvento(db, restaurant)

    expect(() => db.prepare('DELETE FROM events WHERE id = ?').run(event.id ?? null)).toThrow(
      /no se borran/,
    )
  })

  it.each(TABLAS_INMUTABLES)('%s tiene bloqueados UPDATE y DELETE', (tabla) => {
    const disparadores = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?")
      .all(tabla)
      .map((fila) => String(fila.name))

    expect(disparadores).toEqual(
      expect.arrayContaining([`${tabla}_no_delete`, `${tabla}_no_replace`, `${tabla}_no_update`]),
    )
  })

  it('el mismo id no se guarda dos veces en un restaurante', () => {
    const event = insertarEvento(db, restaurant)

    expect(() => insertarEvento(db, restaurant, { id: event.id ?? null, sequence: 2 })).toThrow(
      /no se reemplazan/,
    )
  })

  it('dos eventos no comparten secuencia', () => {
    insertarEvento(db, restaurant, { sequence: 1 })

    expect(() => insertarEvento(db, restaurant, { sequence: 1 })).toThrow(
      /no se reemplazan|sin huecos/,
    )
  })

  it('la secuencia es contigua: no admite huecos', () => {
    insertarEvento(db, restaurant, { sequence: 1 })

    expect(() => insertarEvento(db, restaurant, { sequence: 3 })).toThrow(/sin huecos/)
    expect(() => insertarEvento(db, restaurant, { sequence: 2 })).not.toThrow()
  })

  it('INSERT OR REPLACE no puede reescribir un evento', () => {
    const event = insertarEvento(db, restaurant, { data: '{"a":1}' })
    const columnas = Object.keys(event)
    const reemplazar = db.prepare(
      `INSERT OR REPLACE INTO events (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
    )

    expect(() => reemplazar.run(...Object.values({ ...event, data: '{"a":2}' }))).toThrow(
      /no se reemplazan|sin huecos/,
    )
    expect(db.prepare('SELECT data FROM events').get()?.data).toBe('{"a":1}')
  })

  it('rechaza datos que no son JSON y días operativos mal formados', () => {
    expect(() => insertarEvento(db, restaurant, { data: 'no es json' })).toThrow(/CHECK/)
    expect(() => insertarEvento(db, restaurant, { business_day: '24/10/2026' })).toThrow(/CHECK/)
  })

  it('las proyecciones sí se pueden borrar para reconstruirlas', () => {
    const order = newId()
    db.prepare(
      `INSERT INTO orders (id, restaurant_id, channel, status, opened_at, last_sequence)
       VALUES (?, ?, 'dine_in', 'open', ?, 1)`,
    ).run(order, restaurant, AHORA)

    expect(() => db.exec('DELETE FROM orders')).not.toThrow()
  })
})

describe('credenciales', () => {
  it('un PIN es único entre usuarios vigentes, pero se libera al desactivar', () => {
    const db = abrirBase(':memory:')
    aplicarMigraciones(db)
    const { restaurant } = sembrarMinimo(db)
    const role = insertarVersionado(db, 'roles', restaurant, { name: 'mesero' })
    const user = () => insertarVersionado(db, 'users', restaurant, { name: 'Ana', role_id: role })
    const credential = db.prepare(
      `INSERT INTO user_credentials (user_id, restaurant_id, pin_hash, pin_generated_at, current)
       VALUES (?, ?, 'huella-1', ?, ?)`,
    )

    const ana = user()
    credential.run(ana, restaurant, AHORA, 1)
    expect(() => credential.run(user(), restaurant, AHORA, 1)).toThrow(/UNIQUE/)

    db.prepare('UPDATE user_credentials SET current = 0 WHERE user_id = ?').run(ana)
    expect(() => credential.run(user(), restaurant, AHORA, 1)).not.toThrow()
  })
})
