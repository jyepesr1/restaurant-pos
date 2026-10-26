import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { applyMigrations, currentVersion, sqlFingerprint } from './migrate'
import { MIGRATIONS } from './migrations'
import { openDatabase } from './node'
import { COMMON_COLUMNS, LOCAL_TABLES, VERSIONED_TABLES } from './schema'
import type { SqliteDatabase, SqlValue } from './sqlite'
import { insertIntoTable, insertVersioned, NOW, seed } from './testing/utils'

// Printers, print queue and kitchen screens (task 1.4, ADR-015).

/** A migrated database with a floor, staff, a device and a running session. */
function migratedDatabase() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const s = seed(db)
  const role = insertVersioned(db, 'roles', s.restaurant, { name: 'Mesero', system: 1 })
  const kitchenRole = insertVersioned(db, 'roles', s.restaurant, { name: 'Cocina' })
  const ana = insertVersioned(db, 'users', s.restaurant, { name: 'Ana', role_id: role })
  const luis = insertVersioned(db, 'users', s.restaurant, {
    name: 'Luis',
    role_id: kitchenRole,
    active: 0,
  })
  const device = insertVersioned(db, 'devices', s.restaurant, {
    location_id: s.location,
    name: 'Celular de Ana',
    type: 'waiter',
  })
  const screen = insertVersioned(db, 'devices', s.restaurant, {
    location_id: s.location,
    name: 'Tablet vieja',
    type: 'kds',
    revoked_at: NOW,
  })
  const station = insertVersioned(db, 'stations', s.restaurant, { name: 'Cocina' })
  insertIntoTable(db, 'sessions', {
    id: newId(),
    restaurant_id: s.restaurant,
    user_id: ana,
    device_id: device,
    secret_hash: 'h',
    start: NOW,
    last_used: NOW,
  })
  return { db, ...s, role, kitchenRole, ana, luis, device, screen, station }
}

const migrated = migratedDatabase

const count = (db: SqliteDatabase, tableName: string) =>
  Number(db.prepare(`SELECT count(*) AS n FROM ${tableName}`).get()?.n)

const TABLES_BEFORE = [
  'restaurants',
  'locations',
  'zones',
  'taxes',
  'categories',
  'products',
  'roles',
  'users',
  'devices',
  'stations',
  'sessions',
  'counters',
  'migrations',
] as const

/** A network printer with everything in order; `fields` changes whatever is being tested. */
function printer(
  db: SqliteDatabase,
  restaurant: string,
  fields: Record<string, SqlValue> = {},
  id: string = newId(),
) {
  return insertVersioned(
    db,
    'printers',
    restaurant,
    {
      name: 'Cocina',
      connection: 'network',
      address: '192.168.1.50',
      port: 9100,
      width: 80,
      ...fields,
    },
    id,
  )
}

function job(
  db: SqliteDatabase,
  restaurant: string,
  printerId: string,
  fields: Record<string, SqlValue> = {},
) {
  const id = newId()
  insertIntoTable(db, 'print_jobs', {
    id,
    restaurant_id: restaurant,
    printer_id: printerId,
    type: 'ticket',
    content: '{"station":"Cocina"}',
    created_at: NOW,
    ...fields,
  })
  return id
}

describe('tickets: overview', () => {
  it('the initial migration applies to a new database and is recorded with its hash', () => {
    const db = openDatabase(':memory:')
    expect(MIGRATIONS[0]?.name).toBe('initial')
    expect(currentVersion(db)).toBe(0)
    expect(applyMigrations(db)).toEqual([1])
    expect(currentVersion(db)).toBe(1)
    const entry = db.prepare('SELECT * FROM migrations WHERE version = 1').get()
    expect(entry).toMatchObject({
      name: 'initial',
      hash: sqlFingerprint(MIGRATIONS[0]?.sql as string),
    })
  })

  it('re-running does nothing, and editing it after it was applied is rejected by its hash', () => {
    const { db } = migrated()
    expect(applyMigrations(db)).toEqual([])
    const edited = [{ ...(MIGRATIONS[0] as object), sql: `${MIGRATIONS[0]?.sql}\n-- x` }]
    expect(() => applyMigrations(db, edited as never)).toThrow(/cambió después de aplicarse/)
  })

  it('both printing tables are STRICT and in their category', () => {
    const { db } = migrated()
    const sqlTables = db.prepare('PRAGMA table_list').all()
    for (const name of ['printers', 'print_jobs'])
      expect(sqlTables.find((t) => t.name === name)).toMatchObject({ strict: 1 })
    expect(VERSIONED_TABLES).toContain('printers')
    expect(LOCAL_TABLES).toContain('print_jobs')
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('printers')")
      .all()
      .map((c) => c.name)
    for (const common of COMMON_COLUMNS) expect(columns).toContain(common)
  })
})

describe('tickets: nothing is lost', () => {
  it('no row of the other tables disappears or changes when re-running', () => {
    const base = migratedDatabase()
    const before = Object.fromEntries(TABLES_BEFORE.map((t) => [t, count(base.db, t)]))
    const rowsBefore = base.db.prepare('SELECT * FROM users ORDER BY id').all()
    const devicesBefore = base.db.prepare('SELECT * FROM devices ORDER BY id').all()
    const rolesBefore = base.db.prepare('SELECT * FROM roles ORDER BY id').all()
    expect(before.users).toBe(2)
    expect(before.devices).toBe(2)
    expect(before.migrations).toBe(1)
    applyMigrations(base.db)
    // Every table keeps its count, `migrations` included (still one row).
    for (const t of TABLES_BEFORE) expect(count(base.db, t)).toBe(before[t])
    expect(base.db.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(rowsBefore)
    expect(base.db.prepare('SELECT * FROM devices ORDER BY id').all()).toEqual(devicesBefore)
    expect(base.db.prepare('SELECT * FROM roles ORDER BY id').all()).toEqual(rolesBefore)
  })

  it('rows written without the screen columns default to: real people, visible roles, devices without stations', () => {
    const { db } = migrated()
    expect(db.prepare('SELECT DISTINCT screen FROM users').all()).toEqual([{ screen: 0 }])
    expect(db.prepare('SELECT DISTINCT hidden FROM roles').all()).toEqual([{ hidden: 0 }])
    expect(db.prepare('SELECT DISTINCT station_ids FROM devices').all()).toEqual([
      { station_ids: null },
    ])
    expect(count(db, 'printers')).toBe(0)
    expect(count(db, 'print_jobs')).toBe(0)
  })

  it('the database is consistent: no broken references', () => {
    const { db } = migrated()
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
  })

  it('a device that is a screen (kds) stays kds and can get stations', () => {
    const { db, screen, station } = migrated()
    expect(db.prepare('SELECT type FROM devices WHERE id = ?').get(screen)).toEqual({
      type: 'kds',
    })
    db.prepare('UPDATE devices SET station_ids = ? WHERE id = ?').run(
      JSON.stringify([station]),
      screen,
    )
    expect(db.prepare('SELECT station_ids FROM devices WHERE id = ?').get(screen)).toEqual({
      station_ids: JSON.stringify([station]),
    })
  })

  it('a migration failing midway leaves the database at version 0 (all or nothing)', () => {
    const db = openDatabase(':memory:')
    const broken = {
      version: 1,
      name: 'initial',
      sql: `${MIGRATIONS[0]?.sql}
CREATE TABLE printers (x TEXT) STRICT;`,
    }
    expect(() => applyMigrations(db, [broken])).toThrow()
    expect(currentVersion(db)).toBe(0)
    const names = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((t) => t.name)
    expect(names).not.toContain('printers')
    expect(names).not.toContain('print_jobs')
    expect(names).not.toContain('users')
    const columns = db.prepare("SELECT name FROM pragma_table_info('users')").all()
    expect(columns.map((c) => c.name)).not.toContain('screen')
  })
})

describe('tickets: device, person and role columns', () => {
  it.each([
    ['users', 'screen'],
    ['roles', 'hidden'],
  ])('%s.%s only accepts 0 and 1', (tableName, column) => {
    const { db, ana, role } = migrated()
    const id = tableName === 'users' ? ana : role
    expect(() =>
      db.prepare(`UPDATE ${tableName} SET ${column} = 1 WHERE id = ?`).run(id),
    ).not.toThrow()
    expect(() =>
      db.prepare(`UPDATE ${tableName} SET ${column} = 0 WHERE id = ?`).run(id),
    ).not.toThrow()
    for (const badCase of [2, -1])
      expect(() =>
        db.prepare(`UPDATE ${tableName} SET ${column} = ? WHERE id = ?`).run(badCase, id),
      ).toThrow(/CHECK/)
    expect(() =>
      db.prepare(`UPDATE ${tableName} SET ${column} = NULL WHERE id = ?`).run(id),
    ).toThrow()
  })

  it('devices.station_ids accepts NULL and JSON, and rejects text that is not JSON', () => {
    const { db, device } = migrated()
    const put = (v: string | null) =>
      db.prepare('UPDATE devices SET station_ids = ? WHERE id = ?').run(v, device)
    expect(() => put(null)).not.toThrow()
    expect(() => put('[]')).not.toThrow()
    expect(() => put('["a","b"]')).not.toThrow()
    expect(() => put('[a,')).toThrow(/CHECK/)
    expect(() => put('no es json')).toThrow(/CHECK/)
  })
})

describe('tickets: printers table', () => {
  it('a network printer with its default values', () => {
    const { db, restaurant } = migrated()
    const id = printer(db, restaurant)
    expect(db.prepare('SELECT * FROM printers WHERE id = ?').get(id)).toMatchObject({
      active: 1,
      code_page: 'pc850',
      station_ids: '[]',
      fallback_id: null,
      port: 9100,
    })
  })

  it('a USB printer has no port', () => {
    const { db, restaurant } = migrated()
    expect(() =>
      printer(db, restaurant, { connection: 'usb', address: 'POS-80', port: null }),
    ).not.toThrow()
  })

  it.each([
    ['unknown connection', { connection: 'bluetooth' }],
    ['width 57', { width: 57 }],
    ['width 0', { width: 0 }],
    ['made-up code page', { code_page: 'utf8' }],
    ['empty name', { name: '' }],
    ['name of 61', { name: 'a'.repeat(61) }],
    ['empty address', { address: '' }],
    ['address of 256', { address: 'a'.repeat(256) }],
    ['port 0', { port: 0 }],
    ['port 65536', { port: 65536 }],
    ['negative port', { port: -1 }],
    ['stations that are not JSON', { station_ids: '[Cocina' }],
    ['active 2', { active: 2 }],
    ['negative version', { version: -1 }],
  ])('rejects %s', (_, fields) => {
    const { db, restaurant } = migrated()
    expect(() => printer(db, restaurant, fields as Record<string, SqlValue>)).toThrow()
  })

  it.each([
    ['name of 1', { name: 'a' }],
    ['name of 60', { name: 'a'.repeat(60) }],
    ['address of 255', { address: 'a'.repeat(255) }],
    ['port 1', { port: 1 }],
    ['port 65535', { port: 65535 }],
    ['width 58', { width: 58 }],
    ['code page wpc1252', { code_page: 'wpc1252' }],
    ['code page no_accents', { code_page: 'no_accents' }],
    ['no port', { port: null }],
  ])('accepts %s', (_, fields) => {
    const { db, restaurant } = migrated()
    expect(() => printer(db, restaurant, fields as Record<string, SqlValue>)).not.toThrow()
  })

  it('the id must be a 26-character ULID', () => {
    const { db, restaurant } = migrated()
    expect(() => printer(db, restaurant, {}, 'corto')).toThrow(/CHECK/)
  })

  it('a printer cannot be its own fallback, nor point to one that does not exist', () => {
    const { db, restaurant } = migrated()
    const id = newId()
    expect(() => printer(db, restaurant, { fallback_id: id }, id)).toThrow(/CHECK/)
    expect(() => printer(db, restaurant, { fallback_id: newId() })).toThrow(/FOREIGN KEY/)
    const another = printer(db, restaurant)
    expect(() => printer(db, restaurant, { fallback_id: another })).not.toThrow()
    // Nor making itself its fallback later.
    expect(() =>
      db.prepare('UPDATE printers SET fallback_id = id WHERE id = ?').run(another),
    ).toThrow(/CHECK/)
  })

  it('is not deleted: it is archived', () => {
    const { db, restaurant } = migrated()
    const id = printer(db, restaurant)
    expect(() => db.prepare('DELETE FROM printers WHERE id = ?').run(id)).toThrow(/se archiva/)
    expect(() => db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(id)).not.toThrow()
    expect(count(db, 'printers')).toBe(1)
  })

  it('requires an existing restaurant', () => {
    const { db } = migrated()
    expect(() => printer(db, newId())).toThrow(/FOREIGN KEY/)
  })
})

describe('tickets: print queue (print_jobs)', () => {
  it('a new job starts pending, with no attempts and no finish time', () => {
    const { db, restaurant } = migrated()
    const p = printer(db, restaurant)
    const id = job(db, restaurant, p)
    expect(db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      finished_at: null,
      last_error: null,
      printed_on_id: null,
      discarded_by_id: null,
    })
  })

  it.each([
    ['unknown type', { type: 'factura' }],
    ['unknown status', { status: 'sent' }],
    ['negative attempts', { attempts: -1 }],
    ['content that is not JSON', { content: 'comanda' }],
    ['pending with a finish time', { finished_at: NOW }],
    ['printed without a finish time', { status: 'printed', printed_on_id: 'x' }],
    ['discarded without a finish time', { status: 'discarded' }],
    ['short id', { id: 'corto' }],
  ])('rejects %s', (_, fields) => {
    const { db, restaurant } = migrated()
    const p = printer(db, restaurant)
    expect(() => job(db, restaurant, p, fields as Record<string, SqlValue>)).toThrow()
  })

  it('printed must say on which printer it came out', () => {
    const { db, restaurant } = migrated()
    const p = printer(db, restaurant)
    expect(() => job(db, restaurant, p, { status: 'printed', finished_at: NOW })).toThrow(/CHECK/)
    expect(() =>
      job(db, restaurant, p, { status: 'printed', finished_at: NOW, printed_on_id: p }),
    ).not.toThrow()
  })

  it('discarded can be by a person or by the hub (no person)', () => {
    const { db, restaurant, ana } = migrated()
    const p = printer(db, restaurant)
    expect(() =>
      job(db, restaurant, p, {
        status: 'discarded',
        finished_at: NOW,
        discarded_by_id: ana,
      }),
    ).not.toThrow()
    expect(() => job(db, restaurant, p, { status: 'discarded', finished_at: NOW })).not.toThrow()
    expect(() =>
      job(db, restaurant, p, {
        status: 'discarded',
        finished_at: NOW,
        discarded_by_id: newId(),
      }),
    ).toThrow(/FOREIGN KEY/)
  })

  it('a job goes from pending to printed, but does not go back to pending without a finish time', () => {
    const { db, restaurant } = migrated()
    const p = printer(db, restaurant)
    const id = job(db, restaurant, p)
    db.prepare(
      "UPDATE print_jobs SET status = 'printed', finished_at = ?, printed_on_id = ? WHERE id = ?",
    ).run(NOW, p, id)
    expect(() =>
      db.prepare("UPDATE print_jobs SET status = 'pending' WHERE id = ?").run(id),
    ).toThrow(/CHECK/)
  })

  it('points to printers that exist', () => {
    const { db, restaurant } = migrated()
    expect(() => job(db, restaurant, newId())).toThrow(/FOREIGN KEY/)
    const p = printer(db, restaurant)
    expect(() =>
      job(db, restaurant, p, {
        status: 'printed',
        finished_at: NOW,
        printed_on_id: newId(),
      }),
    ).toThrow(/FOREIGN KEY/)
  })

  it('is never deleted: not even when printed', () => {
    const { db, restaurant } = migrated()
    const p = printer(db, restaurant)
    const id = job(db, restaurant, p, {
      status: 'printed',
      finished_at: NOW,
      printed_on_id: p,
    })
    expect(() => db.prepare('DELETE FROM print_jobs WHERE id = ?').run(id)).toThrow(/no se borra/)
    expect(() => db.prepare('DELETE FROM print_jobs').run()).toThrow(/no se borra/)
    expect(count(db, 'print_jobs')).toBe(1)
  })

  it('archiving a printer with jobs neither deletes nor touches its jobs', () => {
    const { db, restaurant } = migrated()
    const p = printer(db, restaurant)
    job(db, restaurant, p)
    job(db, restaurant, p)
    db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(p)
    expect(count(db, 'print_jobs')).toBe(2)
    expect(
      db.prepare("SELECT count(*) AS n FROM print_jobs WHERE status = 'pending'").get(),
    ).toEqual({ n: 2 })
  })
})

describe('tickets: the unique index prevents duplicating a ticket', () => {
  const event = newId()
  const ticket = newId()

  it('the same event, ticket and printer are not stored twice', () => {
    const { db, restaurant } = migrated()
    const p = printer(db, restaurant)
    job(db, restaurant, p, { event_id: event, ticket_id: ticket })
    expect(() => job(db, restaurant, p, { event_id: event, ticket_id: ticket })).toThrow(/UNIQUE/)
    expect(count(db, 'print_jobs')).toBe(1)
  })

  it('with ON CONFLICT DO NOTHING (as the hub uses it) the retry is ignored without error', () => {
    const { db, restaurant } = migrated()
    const p = printer(db, restaurant)
    const insert = () =>
      db
        .prepare(
          `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, event_id, ticket_id, content, created_at)
           VALUES (?, ?, ?, 'ticket', ?, ?, '{}', ?) ON CONFLICT DO NOTHING`,
        )
        .run(newId(), restaurant, p, event, ticket, NOW)
    expect(Number(insert().changes)).toBe(1)
    expect(Number(insert().changes)).toBe(0)
    expect(count(db, 'print_jobs')).toBe(1)
  })

  it('it also applies when the first one was already printed or discarded', () => {
    const { db, restaurant } = migrated()
    const p = printer(db, restaurant)
    job(db, restaurant, p, {
      event_id: event,
      ticket_id: ticket,
      status: 'printed',
      finished_at: NOW,
      printed_on_id: p,
    })
    expect(() => job(db, restaurant, p, { event_id: event, ticket_id: ticket })).toThrow(/UNIQUE/)
  })

  it('the same ticket on another printer, or another ticket of the same event, is stored', () => {
    const { db, restaurant } = migrated()
    const p1 = printer(db, restaurant)
    const p2 = printer(db, restaurant, { name: 'Barra' })
    job(db, restaurant, p1, { event_id: event, ticket_id: ticket })
    expect(() => job(db, restaurant, p2, { event_id: event, ticket_id: ticket })).not.toThrow()
    expect(() => job(db, restaurant, p1, { event_id: event, ticket_id: newId() })).not.toThrow()
    expect(() => job(db, restaurant, p1, { event_id: newId(), ticket_id: ticket })).not.toThrow()
    expect(count(db, 'print_jobs')).toBe(4)
  })

  it('test pages (no event) can repeat as many times as wanted', () => {
    const { db, restaurant } = migrated()
    const p = printer(db, restaurant)
    for (let i = 0; i < 3; i++) job(db, restaurant, p, { type: 'test' })
    expect(count(db, 'print_jobs')).toBe(3)
  })

  it('a job without a ticket (ticket_id NULL) of the same event is not covered by the index', () => {
    // Documents the index limit: SQLite does not compare NULL with NULL. The hub always sends
    // `ticket_id`, so this does not happen in normal use.
    const { db, restaurant } = migrated()
    const p = printer(db, restaurant)
    job(db, restaurant, p, { event_id: event })
    expect(() => job(db, restaurant, p, { event_id: event })).not.toThrow()
  })

  it('the index is partial: it exists with that name and only covers jobs with an event', () => {
    const { db } = migrated()
    const index = db
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'print_jobs_unique'")
      .get()
    expect(String(index?.sql)).toMatch(/UNIQUE/i)
    expect(String(index?.sql)).toMatch(/WHERE event_id IS NOT NULL/i)
  })
})

describe('tickets: several restaurants in the same database', () => {
  it('each restaurant has its printers and its queue; the counts do not mix', () => {
    const { db, restaurant } = migrated()
    const other = seed(db).restaurant
    const p1 = printer(db, restaurant)
    const p2 = printer(db, other)
    job(db, restaurant, p1)
    job(db, other, p2)
    job(db, other, p2)
    const lookup = (r: string) =>
      Number(db.prepare('SELECT count(*) AS n FROM print_jobs WHERE restaurant_id = ?').get(r)?.n)
    expect(lookup(restaurant)).toBe(1)
    expect(lookup(other)).toBe(2)
    expect(
      Number(
        db.prepare('SELECT count(*) AS n FROM printers WHERE restaurant_id = ?').get(other)?.n,
      ),
    ).toBe(1)
  })
})
