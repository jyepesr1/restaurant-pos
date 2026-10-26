import { newId } from '@pos/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from './migrate'
import { MIGRATIONS } from './migrations'
import { openDatabase } from './node'
import {
  COMMON_COLUMNS,
  IMMUTABLE_TABLES,
  LOCAL_TABLES,
  PROJECTION_TABLES,
  VERSIONED_TABLES,
} from './schema'
import type { SqliteDatabase, SqlValue } from './sqlite'

const NOW = '2026-10-24T15:00:00.000Z'

function tableNames(db: SqliteDatabase): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name))
}

/** Inserts a row with the common columns of a versioned record. */
function insertVersioned(
  db: SqliteDatabase,
  tableName: string,
  restaurantId: string,
  fields: Record<string, SqlValue>,
  id = newId(),
): string {
  const row: Record<string, SqlValue> = {
    id,
    restaurant_id: restaurantId,
    created_at: NOW,
    updated_at: NOW,
    version: 1,
    ...fields,
  }
  const columns = Object.keys(row)
  db.prepare(
    `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...Object.values(row))
  return id
}

/** A restaurant with the minimum to create products. */
function seedMinimal(db: SqliteDatabase) {
  const restaurant = newId()
  insertVersioned(db, 'restaurants', restaurant, { name: 'Prueba', config: '{}' }, restaurant)
  const tax = insertVersioned(db, 'taxes', restaurant, {
    name: 'INC 8 %',
    type: 'inc',
    rate: 800,
  })
  const category = insertVersioned(db, 'categories', restaurant, { name: 'Pizzas' })
  return { restaurant, tax, category }
}

function insertEvent(
  db: SqliteDatabase,
  restaurant: string,
  fields: Record<string, SqlValue> = {},
) {
  const row: Record<string, SqlValue> = {
    restaurant_id: restaurant,
    id: newId(),
    type: 'OrderOpened',
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: newId(),
    data: '{"channel":"dine_in"}',
    user_id: newId(),
    device_id: newId(),
    device_time: NOW,
    hub_estimated_time: NOW,
    base_sequence: 0,
    sequence: 1,
    received_at: NOW,
    business_day: '2026-10-24',
    content_hash: 'abc',
    ...fields,
  }
  const columns = Object.keys(row)
  db.prepare(
    `INSERT INTO events (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...Object.values(row))
  return row
}

describe('migrations', () => {
  it('create the database from scratch and repeat nothing on a second run', () => {
    const db = openDatabase(':memory:')

    expect(applyMigrations(db)).toEqual(MIGRATIONS.map((m) => m.version))
    expect(applyMigrations(db)).toEqual([])
  })

  it('refuse to open a database newer than the application', () => {
    const db = openDatabase(':memory:')
    applyMigrations(db)
    db.prepare(
      "INSERT INTO migrations (version, name, hash, applied_at) VALUES (99, 'futura', 'x', ?)",
    ).run(NOW)

    expect(() => applyMigrations(db)).toThrow(/más nueva que esta aplicación/)
  })

  it('if a migration fails, the database stays at the previous version', () => {
    const db = openDatabase(':memory:')
    const migrations = [
      { version: 1, name: 'buena', sql: 'CREATE TABLE a (x INTEGER) STRICT;' },
      {
        version: 2,
        name: 'broken',
        sql: 'CREATE TABLE b (x INTEGER) STRICT; SELECT * FROM not_found;',
      },
    ]

    expect(() => applyMigrations(db, migrations)).toThrow()
    expect(tableNames(db)).toContain('a')
    expect(tableNames(db)).not.toContain('b')
    expect(db.prepare('SELECT max(version) AS v FROM migrations').get()?.v).toBe(1)
  })

  it('require consecutive numbering', () => {
    const db = openDatabase(':memory:')
    const migrations = [{ version: 2, name: 'salta', sql: 'SELECT 1;' }]

    expect(() => applyMigrations(db, migrations)).toThrow(/numeradas/)
  })
})

describe('schema', () => {
  let db: SqliteDatabase

  beforeEach(() => {
    db = openDatabase(':memory:')
    applyMigrations(db)
  })

  it('every table is in exactly one category', () => {
    const classified = [
      ...VERSIONED_TABLES,
      ...IMMUTABLE_TABLES,
      ...PROJECTION_TABLES,
      ...LOCAL_TABLES,
    ]

    expect(new Set(classified).size).toBe(classified.length)
    expect(tableNames(db).sort()).toEqual([...classified].sort())
  })

  it('every table is STRICT', () => {
    const nonStrict = db
      .prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND strict = 0")
      .all()
      .map((row) => String(row.name))
      .filter((name) => !name.startsWith('sqlite_'))

    expect(nonStrict).toEqual([])
  })

  it.each(VERSIONED_TABLES)('%s has the common columns', (tableName) => {
    const columns = db
      .prepare(`SELECT name FROM pragma_table_info('${tableName}')`)
      .all()
      .map((row) => String(row.name))

    expect(columns).toEqual(expect.arrayContaining([...COMMON_COLUMNS]))
  })

  it('foreign keys are on', () => {
    const { restaurant } = seedMinimal(db)

    expect(() =>
      insertVersioned(db, 'dining_tables', restaurant, {
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

describe('money in the database', () => {
  let db: SqliteDatabase
  let base: ReturnType<typeof seedMinimal>

  beforeEach(() => {
    db = openDatabase(':memory:')
    applyMigrations(db)
    base = seedMinimal(db)
  })

  const product = (price: SqlValue) =>
    insertVersioned(db, 'products', base.restaurant, {
      category_id: base.category,
      name: 'Garden Margarita',
      price,
      tax_id: base.tax,
    })

  it('accepts whole-peso prices', () => {
    expect(() => product(40900)).not.toThrow()
    expect(() => product(0)).not.toThrow()
  })

  it('rejects prices with decimals', () => {
    expect(() => product(40900.5)).toThrow(/REAL/)
  })

  it.each([-1, 100_000_001])('rejects the price %d (out of range)', (price) => {
    expect(() => product(price)).toThrow(/CHECK/)
  })

  it.each([-1, 10_001, 8.5])('rejects the tax rate %d', (rate) => {
    expect(() =>
      insertVersioned(db, 'taxes', base.restaurant, { name: 'X', type: 'iva', rate }),
    ).toThrow()
  })

  it.each([0, 1000])('rejects the quantity %d in an order item', (quantity) => {
    const order = newId()
    db.prepare(
      `INSERT INTO orders (id, restaurant_id, channel, status, opened_at, last_sequence)
       VALUES (?, ?, 'dine_in', 'open', ?, 1)`,
    ).run(order, base.restaurant, NOW)

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

describe('events', () => {
  let db: SqliteDatabase
  let restaurant: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    applyMigrations(db)
    restaurant = seedMinimal(db).restaurant
  })

  it('cannot be modified', () => {
    const event = insertEvent(db, restaurant)

    expect(() =>
      db.prepare("UPDATE events SET data = '{}' WHERE id = ?").run(event.id ?? null),
    ).toThrow(/no se modifican/)
  })

  it('cannot be deleted', () => {
    const event = insertEvent(db, restaurant)

    expect(() => db.prepare('DELETE FROM events WHERE id = ?').run(event.id ?? null)).toThrow(
      /no se borran/,
    )
  })

  it.each(IMMUTABLE_TABLES)('%s has UPDATE and DELETE blocked', (tableName) => {
    const triggers = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?")
      .all(tableName)
      .map((row) => String(row.name))

    expect(triggers).toEqual(
      expect.arrayContaining([
        `${tableName}_no_delete`,
        `${tableName}_no_replace`,
        `${tableName}_no_update`,
      ]),
    )
  })

  it('the same id is not stored twice in a restaurant', () => {
    const event = insertEvent(db, restaurant)

    expect(() => insertEvent(db, restaurant, { id: event.id ?? null, sequence: 2 })).toThrow(
      /no se reemplazan/,
    )
  })

  it('two events do not share a sequence', () => {
    insertEvent(db, restaurant, { sequence: 1 })

    expect(() => insertEvent(db, restaurant, { sequence: 1 })).toThrow(
      /no se reemplazan|sin huecos/,
    )
  })

  it('the sequence is contiguous: no gaps allowed', () => {
    insertEvent(db, restaurant, { sequence: 1 })

    expect(() => insertEvent(db, restaurant, { sequence: 3 })).toThrow(/sin huecos/)
    expect(() => insertEvent(db, restaurant, { sequence: 2 })).not.toThrow()
  })

  it('INSERT OR REPLACE cannot rewrite an event', () => {
    const event = insertEvent(db, restaurant, { data: '{"a":1}' })
    const columns = Object.keys(event)
    const replace = db.prepare(
      `INSERT OR REPLACE INTO events (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )

    expect(() => replace.run(...Object.values({ ...event, data: '{"a":2}' }))).toThrow(
      /no se reemplazan|sin huecos/,
    )
    expect(db.prepare('SELECT data FROM events').get()?.data).toBe('{"a":1}')
  })

  it('rejects data that is not JSON and malformed business days', () => {
    expect(() => insertEvent(db, restaurant, { data: 'no es json' })).toThrow(/CHECK/)
    expect(() => insertEvent(db, restaurant, { business_day: '24/10/2026' })).toThrow(/CHECK/)
  })

  it('projections can be deleted to rebuild them', () => {
    const order = newId()
    db.prepare(
      `INSERT INTO orders (id, restaurant_id, channel, status, opened_at, last_sequence)
       VALUES (?, ?, 'dine_in', 'open', ?, 1)`,
    ).run(order, restaurant, NOW)

    expect(() => db.exec('DELETE FROM orders')).not.toThrow()
  })
})

describe('credentials', () => {
  it('a PIN is unique among current users, but is freed on deactivation', () => {
    const db = openDatabase(':memory:')
    applyMigrations(db)
    const { restaurant } = seedMinimal(db)
    const role = insertVersioned(db, 'roles', restaurant, { name: 'mesero' })
    const user = () => insertVersioned(db, 'users', restaurant, { name: 'Ana', role_id: role })
    const credential = db.prepare(
      `INSERT INTO user_credentials (user_id, restaurant_id, pin_hash, pin_generated_at, current)
       VALUES (?, ?, 'huella-1', ?, ?)`,
    )

    const ana = user()
    credential.run(ana, restaurant, NOW, 1)
    expect(() => credential.run(user(), restaurant, NOW, 1)).toThrow(/UNIQUE/)

    db.prepare('UPDATE user_credentials SET current = 0 WHERE user_id = ?').run(ana)
    expect(() => credential.run(user(), restaurant, NOW, 1)).not.toThrow()
  })
})
