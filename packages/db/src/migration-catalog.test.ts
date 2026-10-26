import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { applyMigrations, currentVersion } from './migrate'
import { MIGRATIONS } from './migrations'
import { openDatabase } from './node'
import { inTransaction, type SqliteDatabase } from './sqlite'
import { insertIntoTable, insertVersioned, NOW } from './testing/utils'

// The catalog history (`catalog_changes`) on a real migrated database: one row per change of a
// catalog record, kept as written across re-running the migrations, and never rewritten.

const CATALOG_TABLES = [
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

/** A migrated database with a restaurant whose catalog has a record in every table. */
function catalogDatabase() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const restaurant = newId()
  let version = 0
  // Like the hub: each record takes the next counter value.
  const v = (fields: Record<string, string | number | null> = {}) => ({
    version: ++version,
    updated_at: `2026-10-24T15:00:${String(version).padStart(2, '0')}.000Z`,
    ...fields,
  })
  insertVersioned(db, 'restaurants', restaurant, { name: 'Prueba', config: '{}' }, restaurant)
  const record = (tableName: string, fields: Record<string, string | number | null>) =>
    insertVersioned(db, tableName, restaurant, v(fields))

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
  // Archived: it also enters the history, with active = 0.
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
  // The global catalog counter, as the hub leaves it.
  db.prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', ?)").run(
    restaurant,
    version,
  )
  return { db, restaurant, product, archived, variant, category, lastVersion: version }
}

/** Writes the history row of a record as the hub does: how it ended up, with no previous state. */
function recordHistory(db: SqliteDatabase, tableName: string, id: string) {
  const columns = db
    .prepare(`SELECT name FROM pragma_table_info('${tableName}')`)
    .all()
    .map((c) => String(c.name))
  db.prepare(
    `INSERT INTO catalog_changes
       (restaurant_id, version, entity, record_id, before, after, user_id, device_id, done_at)
     SELECT restaurant_id, version, '${tableName}', id, NULL,
       json_object(${columns.map((c) => `'${c}', ${c}`).join(', ')}), user_id, device_id, updated_at
     FROM ${tableName} WHERE id = ?`,
  ).run(id)
}

/** Writes the history of every catalog record, in one transaction. */
function recordAllHistory(db: SqliteDatabase) {
  inTransaction(db, () => {
    for (const t of CATALOG_TABLES)
      for (const row of db.prepare(`SELECT id FROM ${t} ORDER BY version`).all())
        recordHistory(db, t, String(row.id))
  })
}

/** The catalog database with the history of each of its records. */
function withHistory() {
  const base = catalogDatabase()
  recordAllHistory(base.db)
  return base
}

const history = (db: SqliteDatabase) =>
  db.prepare('SELECT * FROM catalog_changes ORDER BY version').all()

describe('catalog history on a migrated database', () => {
  it('the initial migration creates the history', () => {
    const db = openDatabase(':memory:')
    expect(MIGRATIONS[0]?.name).toBe('initial')
    expect(currentVersion(db)).toBe(0)
    expect(applyMigrations(db)).toEqual([1])
    expect(currentVersion(db)).toBe(1)
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalog_changes'")
        .get(),
    ).toBeDefined()
  })

  it('keeps one row per catalog record, archived ones too', () => {
    const { db, restaurant } = withHistory()
    const before: Record<string, number> = {}
    for (const t of CATALOG_TABLES)
      before[t] = Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.n)

    applyMigrations(db)

    for (const t of CATALOG_TABLES) {
      const n = Number(
        db.prepare('SELECT count(*) AS n FROM catalog_changes WHERE entity = ?').get(t)?.n,
      )
      expect(n, t).toBe(before[t])
    }
    expect(history(db)).toHaveLength(Object.values(before).reduce((a, b) => a + b, 0))
    expect(history(db)).toHaveLength(11)
    // Catalog only: neither the restaurant nor anything else enters.
    expect(db.prepare("SELECT 1 FROM catalog_changes WHERE entity = 'restaurants'").get()).toBe(
      undefined,
    )
    expect(history(db).every((f) => f.restaurant_id === restaurant)).toBe(true)
  })

  it('each row keeps the version, author and time of the record, with no previous state', () => {
    const { db, category } = withHistory()
    const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(category)
    applyMigrations(db)

    const change = db.prepare('SELECT * FROM catalog_changes WHERE record_id = ?').get(category)
    expect(change).toMatchObject({
      version: row?.version,
      entity: 'categories',
      before: null,
      user_id: row?.user_id,
      device_id: row?.device_id,
      done_at: row?.updated_at,
    })
    expect(JSON.parse(String(change?.after))).toEqual(row)
  })

  it('the history accepts exactly the catalog tables as entity, no more and no fewer', () => {
    const { db, restaurant, lastVersion } = catalogDatabase()
    const allTables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((t) => String(t.name))
    let version = lastVersion
    const accepted = allTables.filter((entity) => {
      try {
        db.prepare(
          `INSERT INTO catalog_changes (restaurant_id, version, entity, record_id, after, done_at)
           VALUES (?, ?, ?, ?, '{}', ?)`,
        ).run(restaurant, ++version, entity, newId(), NOW)
        return true
      } catch {
        return false
      }
    })
    expect(accepted.sort()).toEqual([...CATALOG_TABLES].sort())
  })

  it('the stored state equals the table row (values and types)', () => {
    const { db } = withHistory()
    applyMigrations(db)
    for (const tableName of CATALOG_TABLES) {
      for (const row of db.prepare(`SELECT * FROM ${tableName}`).all()) {
        const change = db
          .prepare('SELECT after FROM catalog_changes WHERE record_id = ?')
          .get(row.id ?? '')
        expect(JSON.parse(String(change?.after)), `${tableName} ${row.id}`).toEqual(row)
      }
    }
  })

  it('re-running the migrations does not touch the catalog data', () => {
    const { db } = catalogDatabase()
    const photo = () =>
      CATALOG_TABLES.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())
    const before = photo()
    applyMigrations(db)
    expect(photo()).toEqual(before)
  })

  it('the counters of where the history starts are kept as the hub wrote them', () => {
    const { db, restaurant, lastVersion } = catalogDatabase()
    db.prepare(
      "INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'history_since', ?)",
    ).run(restaurant, lastVersion)
    applyMigrations(db)
    const counter = (name: string) =>
      db
        .prepare('SELECT value FROM counters WHERE restaurant_id = ? AND name = ?')
        .get(restaurant, name)?.value
    expect(counter('history_since')).toBe(lastVersion)
    expect(counter('catalog')).toBe(lastVersion)
    // Re-running the migrations does not move it.
    applyMigrations(db)
    expect(counter('history_since')).toBe(lastVersion)
  })

  it('a new database does not invent history_since', () => {
    const db = openDatabase(':memory:')
    applyMigrations(db)
    const r = newId()
    insertVersioned(db, 'restaurants', r, { name: 'P', config: '{}' }, r)
    applyMigrations(db)
    expect(db.prepare("SELECT 1 FROM counters WHERE name = 'history_since'").get()).toBe(undefined)
  })

  it('a new database without a catalog starts with an empty history', () => {
    const db = openDatabase(':memory:')
    expect(applyMigrations(db)).toEqual([1])
    expect(history(db)).toEqual([])
  })

  it('re-running the migrations does not duplicate the history', () => {
    const { db } = withHistory()
    applyMigrations(db)
    const n = history(db).length
    expect(applyMigrations(db)).toEqual([])
    expect(history(db)).toHaveLength(n)
  })

  it('with two restaurants in the same database, each keeps its own history', () => {
    const { db, restaurant } = withHistory()
    const other = newId()
    insertVersioned(db, 'restaurants', other, { name: 'Otro', config: '{}' }, other)
    // The same versions as the first one: the key is (restaurant, version).
    const station = insertVersioned(db, 'stations', other, { name: 'Barra', version: 1 })
    recordHistory(db, 'stations', station)
    applyMigrations(db)
    const lookup = (r: string) =>
      Number(
        db.prepare('SELECT count(*) AS n FROM catalog_changes WHERE restaurant_id = ?').get(r)?.n,
      )
    expect(lookup(restaurant)).toBe(11)
    expect(lookup(other)).toBe(1)
  })

  it('if two records share a version, writing the history fails entirely and leaves nothing', () => {
    // Never happens with the hub counter; if it did, better stop than lose history.
    const { db, restaurant } = catalogDatabase()
    insertVersioned(db, 'stations', restaurant, { name: 'Repetida', version: 1 })
    expect(() => recordAllHistory(db)).toThrow(/no se reemplazan/)
    expect(currentVersion(db)).toBe(1)
    expect(history(db)).toEqual([])
  })
})

describe('the catalog history is append-only', () => {
  function migrated() {
    const m = withHistory()
    applyMigrations(m.db)
    const row = history(m.db)[0]
    return { ...m, row }
  }

  it('rejects UPDATE', () => {
    const { db } = migrated()
    expect(() => db.exec("UPDATE catalog_changes SET after = '{}'")).toThrow(/no se modifican/)
    expect(() => db.exec('UPDATE catalog_changes SET user_id = NULL')).toThrow(/no se modifican/)
  })

  it('rejects DELETE', () => {
    const { db } = migrated()
    const n = history(db).length
    expect(() => db.exec('DELETE FROM catalog_changes')).toThrow(/no se borran/)
    expect(() => db.exec('DELETE FROM catalog_changes WHERE version = 1')).toThrow(/no se borran/)
    expect(history(db)).toHaveLength(n)
  })

  it('rejects INSERT OR REPLACE and REPLACE INTO over an existing version', () => {
    const { db, restaurant, row } = migrated()
    const before = history(db)
    const replacement = (verb: string) =>
      db
        .prepare(
          `${verb} INTO catalog_changes (restaurant_id, version, entity, record_id, after, done_at)
           VALUES (?, ?, 'products', ?, '{"fake":true}', ?)`,
        )
        .run(restaurant, Number(row?.version), newId(), NOW)
    expect(() => replacement('INSERT OR REPLACE')).toThrow(/no se reemplazan/)
    expect(() => replacement('REPLACE')).toThrow(/no se reemplazan/)
    expect(() => replacement('INSERT')).toThrow(/no se reemplazan/)
    expect(history(db)).toEqual(before)
  })

  it('INSERT OR IGNORE over an existing version changes nothing either', () => {
    const { db, restaurant, row } = migrated()
    const before = history(db)
    try {
      db.prepare(
        `INSERT OR IGNORE INTO catalog_changes (restaurant_id, version, entity, record_id, after, done_at)
         VALUES (?, ?, 'products', ?, '{}', ?)`,
      ).run(restaurant, Number(row?.version), newId(), NOW)
    } catch {
      // Aborting is fine too: what matters is that the history does not change.
    }
    expect(history(db)).toEqual(before)
  })

  it('it does allow adding a new version, even of the same record (many changes)', () => {
    const { db, restaurant, product, lastVersion } = migrated()
    for (let i = 1; i <= 50; i++)
      db.prepare(
        `INSERT INTO catalog_changes (restaurant_id, version, entity, record_id, before, after, done_at)
         VALUES (?, ?, 'products', ?, NULL, ?, ?)`,
      ).run(restaurant, lastVersion + i, product, JSON.stringify({ price: i }), NOW)
    const n = Number(
      db.prepare('SELECT count(*) AS n FROM catalog_changes WHERE record_id = ?').get(product)?.n,
    )
    expect(n).toBe(51)
  })

  it('validates what is added: entity, id, JSON and restaurant', () => {
    const { db, restaurant, lastVersion } = migrated()
    const insert = (fields: {
      entity?: string
      entry?: string
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
          fields.version ?? lastVersion + 1,
          fields.entity ?? 'products',
          fields.entry ?? newId(),
          fields.before ?? null,
          fields.after ?? '{}',
          NOW,
        )
    expect(() => insert({ entity: 'dining_tables' })).toThrow()
    expect(() => insert({ entity: 'restaurants' })).toThrow()
    expect(() => insert({ entry: 'corto' })).toThrow()
    expect(() => insert({ after: 'no es json' })).toThrow()
    expect(() => insert({ before: '{roto' })).toThrow()
    expect(() => insert({ restaurant: newId() })).toThrow()
    expect(() => insert({ version: -1 })).toThrow()
    expect(() => insert({})).not.toThrow()
  })

  it('the table is declared immutable in the schema', async () => {
    const { IMMUTABLE_TABLES } = await import('./schema')
    expect(IMMUTABLE_TABLES).toContain('catalog_changes')
  })

  it('inserting straight into the catalog does not write the history (the hub does that)', () => {
    // Inserting straight into the catalog (bypassing the hub) does not write the history: the
    // hub does that, not the database.
    const { db, restaurant } = migrated()
    const n = history(db).length
    insertIntoTable(db, 'stations', {
      id: newId(),
      restaurant_id: restaurant,
      created_at: NOW,
      updated_at: NOW,
      version: 999,
      name: 'Nueva',
      position: 0,
    })
    expect(history(db)).toHaveLength(n)
  })
})
