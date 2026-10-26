import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { applyMigrations, currentVersion, sqlFingerprint } from './migrate'
import { MIGRATIONS } from './migrations'
import { openDatabase } from './node'
import type { SqliteDatabase, SqlValue } from './sqlite'
import { insertVersioned, NOW } from './testing/utils'

// `floor_plan_elements` (task 1.2) on a real migrated database: re-running the migrations does
// not touch anything already there, and the table has its rules (CHECK), its trigger against
// deletes and its keys.

/** A migrated database with a floor: zone, tables (one archived) and a minimal menu. */
function databaseWithFloor() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const restaurant = newId()
  insertVersioned(db, 'restaurants', restaurant, { name: 'Prueba', config: '{}' }, restaurant)
  const location = insertVersioned(db, 'locations', restaurant, {
    name: 'Envigado',
    time_zone: 'America/Bogota',
  })
  const zone = insertVersioned(db, 'zones', restaurant, {
    location_id: location,
    name: 'Salón',
    level: 1,
  })
  const table = (name: string, fields: Record<string, SqlValue> = {}) =>
    insertVersioned(db, 'dining_tables', restaurant, {
      zone_id: zone,
      name,
      shape: 'square',
      x: 10,
      y: 20,
      width: 80,
      height: 80,
      rotation: 45,
      capacity: 4,
      ...fields,
    })
  const activeTable = table('1')
  const archivedTable = table('2', { active: 0 })
  const tax = insertVersioned(db, 'taxes', restaurant, {
    name: 'INC 8 %',
    type: 'inc',
    rate: 800,
  })
  const category = insertVersioned(db, 'categories', restaurant, { name: 'Pizzas' })
  const product = insertVersioned(db, 'products', restaurant, {
    category_id: category,
    name: 'Margarita',
    price: 40_900,
    tax_id: tax,
  })
  // A catalog history already written.
  db.prepare(
    `INSERT INTO catalog_changes (restaurant_id, version, entity, record_id, before, after, done_at)
     VALUES (?, 7, 'products', ?, NULL, '{"name":"Margarita"}', ?)`,
  ).run(restaurant, product, NOW)
  db.prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 7)").run(
    restaurant,
  )
  return { db, restaurant, zone, activeTable, archivedTable, product }
}

const TABLES = [
  'restaurants',
  'locations',
  'zones',
  'dining_tables',
  'taxes',
  'categories',
  'products',
  'catalog_changes',
  'counters',
]
const photo = (db: SqliteDatabase) =>
  TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()])

function migrated() {
  const base = databaseWithFloor()
  applyMigrations(base.db)
  const element = (fields: Record<string, SqlValue> = {}) =>
    insertVersioned(base.db, 'floor_plan_elements', base.restaurant, {
      zone_id: base.zone,
      type: 'wall',
      x: 0,
      y: 0,
      width: 300,
      height: 20,
      ...fields,
    })
  return { ...base, element }
}

describe('floor plan elements on a migrated database', () => {
  it('the initial migration applies on its own and creates the table', () => {
    const db = openDatabase(':memory:')
    expect(MIGRATIONS[0]?.name).toBe('initial')
    expect(currentVersion(db)).toBe(0)
    expect(applyMigrations(db)).toEqual([1])
    expect(currentVersion(db)).toBe(1)
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'floor_plan_elements'").get(),
    ).toBeDefined()
    // Repeating it does nothing.
    expect(applyMigrations(db)).toEqual([])
  })

  it('re-running touches no data: floor, menu, history or counters', () => {
    const { db } = databaseWithFloor()
    const before = photo(db)
    applyMigrations(db)
    expect(photo(db)).toEqual(before)
  })

  it('tables and zones stay, the archived one too, with their geometry', () => {
    const { db, activeTable, archivedTable } = databaseWithFloor()
    applyMigrations(db)
    expect(db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(activeTable)).toMatchObject({
      x: 10,
      y: 20,
      width: 80,
      height: 80,
      rotation: 45,
      active: 1,
    })
    expect(
      db.prepare('SELECT active FROM dining_tables WHERE id = ?').get(archivedTable)?.active,
    ).toBe(0)
  })

  it('the table starts empty, is STRICT and has the common columns of a versioned record', () => {
    const { db } = migrated()
    expect(db.prepare('SELECT count(*) AS n FROM floor_plan_elements').get()?.n).toBe(0)
    const tableName = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'floor_plan_elements'")
      .get()
    expect(String(tableName?.sql)).toMatch(/STRICT/)
    const columns = db
      .prepare('PRAGMA table_info(floor_plan_elements)')
      .all()
      .map((c) => String(c.name))
    expect(columns).toEqual([
      'id',
      'restaurant_id',
      'created_at',
      'updated_at',
      'version',
      'user_id',
      'device_id',
      'active',
      'zone_id',
      'type',
      'text',
      'x',
      'y',
      'width',
      'height',
      'rotation',
    ])
  })

  it('creates the version and zone indexes, and the trigger against deletes', () => {
    const { db } = migrated()
    const objects = db
      .prepare("SELECT name, type FROM sqlite_master WHERE tbl_name = 'floor_plan_elements'")
      .all()
      .map((o) => `${o.type}:${o.name}`)
    expect(objects).toEqual(
      expect.arrayContaining([
        'index:floor_plan_elements_by_version',
        'index:floor_plan_elements_by_zone',
        'trigger:floor_plan_elements_no_delete',
      ]),
    )
  })

  it('the other triggers still stand (catalog history and deletes)', () => {
    const { db, restaurant, product, activeTable } = migrated()
    expect(() => db.prepare('DELETE FROM catalog_changes').run()).toThrow(/no se borran/)
    expect(() => db.prepare('UPDATE catalog_changes SET done_at = ?').run(NOW)).toThrow(
      /no se modifican/,
    )
    expect(() => db.prepare('DELETE FROM dining_tables WHERE id = ?').run(activeTable)).toThrow(
      /archiva/,
    )
    expect(() => db.prepare('DELETE FROM products WHERE id = ?').run(product)).toThrow(/archiva/)
    expect(
      db
        .prepare('SELECT count(*) AS n FROM catalog_changes WHERE restaurant_id = ?')
        .get(restaurant)?.n,
    ).toBe(1)
  })

  it('the migration hash is in the registry: editing it later is detected', () => {
    const { db } = migrated()
    const m1 = MIGRATIONS[0]
    expect(db.prepare('SELECT hash FROM migrations WHERE version = 1').get()?.hash).toBe(
      sqlFingerprint(m1?.sql ?? ''),
    )
    const editedList = MIGRATIONS.map((m) =>
      m.version === 1 ? { ...m, sql: `${m.sql}\n-- editada` } : m,
    )
    expect(() => applyMigrations(db, editedList)).toThrow(/cambió después de aplicarse/)
  })

  it('if the migration fails midway, the database stays at version 0 without the table', () => {
    const db = openDatabase(':memory:')
    const broken = MIGRATIONS.map((m) =>
      m.version === 1 ? { ...m, sql: `${m.sql}\nSELECT * FROM not_found;` } : m,
    )
    expect(() => applyMigrations(db, broken)).toThrow()
    expect(currentVersion(db)).toBe(0)
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'floor_plan_elements'").get(),
    ).toBeUndefined()
    // And it can be retried with the good one.
    expect(applyMigrations(db)).toEqual([1])
  })
})

describe('floor_plan_elements: table rules', () => {
  it('accepts every element type, with or without text, and negative coordinates', () => {
    const { element } = migrated()
    for (const type of ['wall', 'door', 'plant', 'bar', 'text'])
      expect(() => element({ type })).not.toThrow()
    expect(() => element({ type: 'text', text: 'Baños' })).not.toThrow()
    expect(() => element({ x: -500, y: -10_000 })).not.toThrow()
  })

  it.each(['table', '', 'WALL', 'ventana'])('rejects the type "%s"', (type) => {
    const { element } = migrated()
    expect(() => element({ type })).toThrow(/CHECK/)
  })

  it.each([0, -1, -100])('rejects the width %d', (width) => {
    const { element } = migrated()
    expect(() => element({ width })).toThrow(/CHECK/)
  })

  it.each([0, -1])('rejects the height %d', (height) => {
    const { element } = migrated()
    expect(() => element({ height })).toThrow(/CHECK/)
  })

  it('accepts rotations from 0 to 359 and rejects the rest', () => {
    const { element } = migrated()
    for (const rotation of [0, 1, 180, 359]) expect(() => element({ rotation })).not.toThrow()
    for (const rotation of [-1, 360, 720]) expect(() => element({ rotation })).toThrow(/CHECK/)
  })

  it('rotation is 0 and it is active when not given', () => {
    const { db, element } = migrated()
    const id = element()
    expect(
      db.prepare('SELECT rotation, active, text FROM floor_plan_elements WHERE id = ?').get(id),
    ).toEqual({ rotation: 0, active: 1, text: null })
  })

  it('rejects active outside 0 and 1, a negative version and an id that is not 26 long', () => {
    const { db, restaurant, zone } = migrated()
    const base = { zone_id: zone, type: 'wall', x: 0, y: 0, width: 10, height: 10 }
    const create = (fields: Record<string, SqlValue>, id?: string) =>
      insertVersioned(db, 'floor_plan_elements', restaurant, { ...base, ...fields }, id)
    expect(() => create({ active: 2 })).toThrow(/CHECK/)
    expect(() => create({ active: -1 })).toThrow(/CHECK/)
    expect(() => create({ version: -1 })).toThrow(/CHECK/)
    expect(() => create({}, 'corto')).toThrow(/CHECK/)
    expect(() => create({ version: 0 })).not.toThrow()
  })

  it('the STRICT table takes no decimals or text in the measurements', () => {
    const { element } = migrated()
    expect(() => element({ x: 0.5 })).toThrow(/REAL|datatype|INTEGER/i)
    expect(() => element({ width: 10.5 })).toThrow(/REAL|datatype|INTEGER/i)
    expect(() => element({ y: 'up' })).toThrow(/datatype|INTEGER/i)
  })

  it('requires an existing zone and restaurant', () => {
    const { db, restaurant, element } = migrated()
    expect(() => element({ zone_id: newId() })).toThrow(/FOREIGN/)
    const fields = { zone_id: null, type: 'wall', x: 0, y: 0, width: 10, height: 10 }
    expect(() => insertVersioned(db, 'floor_plan_elements', restaurant, fields)).toThrow(/NOT NULL/)
    expect(() =>
      insertVersioned(db, 'floor_plan_elements', newId(), {
        ...fields,
        zone_id: db.prepare('SELECT id FROM zones').get()?.id as string,
      }),
    ).toThrow(/FOREIGN/)
  })

  it('is not deleted, alone or all at once; it is archived with active = 0', () => {
    const { db, element } = migrated()
    const id = element()
    expect(() => db.prepare('DELETE FROM floor_plan_elements WHERE id = ?').run(id)).toThrow(
      /archiva/,
    )
    expect(() => db.prepare('DELETE FROM floor_plan_elements').run()).toThrow(/archiva/)
    db.prepare('UPDATE floor_plan_elements SET active = 0, version = 2 WHERE id = ?').run(id)
    expect(
      db.prepare('SELECT active, version FROM floor_plan_elements WHERE id = ?').get(id),
    ).toEqual({
      active: 0,
      version: 2,
    })
  })

  it('the rules apply again on update', () => {
    const { db, element } = migrated()
    const id = element()
    expect(() =>
      db.prepare('UPDATE floor_plan_elements SET rotation = 360 WHERE id = ?').run(id),
    ).toThrow(/CHECK/)
    expect(() =>
      db.prepare('UPDATE floor_plan_elements SET width = 0 WHERE id = ?').run(id),
    ).toThrow(/CHECK/)
    expect(() =>
      db.prepare('UPDATE floor_plan_elements SET zone_id = ? WHERE id = ?').run(newId(), id),
    ).toThrow(/FOREIGN/)
  })

  it('a zone with elements cannot be deleted (zones are not deleted either)', () => {
    const { db, zone, element } = migrated()
    element()
    expect(() => db.prepare('DELETE FROM zones WHERE id = ?').run(zone)).toThrow()
  })
})
