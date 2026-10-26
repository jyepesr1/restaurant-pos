import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { applyMigrations, currentVersion } from './migrate'
import { MIGRATIONS } from './migrations'
import { openDatabase } from './node'
import type { SqliteDatabase } from './sqlite'
import { insertIntoTable, insertVersioned, NOW, seed } from './testing/utils'

// The print queue with real data: re-running the migrations must not lose or move anything
// that is already there, and the table keeps all its rules.

function migratedDatabase() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const s = seed(db)
  const printer = (name: string, width = 80) =>
    insertVersioned(db, 'printers', s.restaurant, {
      name,
      connection: 'network',
      address: '192.168.1.50',
      port: 9100,
      width,
    })
  const bar = printer('Barra')
  const kitchen = printer('Cocina', 58)
  const role = insertVersioned(db, 'roles', s.restaurant, { name: 'Cajero' })
  const user = insertVersioned(db, 'users', s.restaurant, { name: 'Caja', role_id: role })
  const device = insertVersioned(db, 'devices', s.restaurant, {
    location_id: s.location,
    name: 'Caja 1',
    type: 'register',
  })
  const job = (fields: Record<string, string | number | null>) => {
    const id = newId()
    insertIntoTable(db, 'print_jobs', {
      id,
      restaurant_id: s.restaurant,
      printer_id: bar,
      type: 'ticket',
      content: '{"station":"Barra","lines":["1 x Garden Margarita"]}',
      created_at: NOW,
      ...fields,
    })
    return id
  }
  return { db, ...s, bar, kitchen, user, device, job }
}

const rows = (db: SqliteDatabase) => db.prepare('SELECT * FROM print_jobs ORDER BY id').all()

/** A queue with one job in each status and every column filled. */
function withQueue() {
  const base = migratedDatabase()
  const { job, kitchen, bar, user, device } = base
  const pending = job({
    event_id: newId(),
    ticket_id: newId(),
    printer_id: kitchen,
    attempts: 4,
    last_error: 'ECONNREFUSED 192.168.1.50:9100',
  })
  const printed = job({
    status: 'printed',
    finished_at: NOW,
    printed_on_id: kitchen,
    attempts: 2,
    event_id: newId(),
    ticket_id: newId(),
  })
  const discardedJob = job({
    status: 'discarded',
    finished_at: NOW,
    discarded_by_id: user,
    discarded_device_id: device,
    last_error: 'sin papel',
    attempts: 7,
    printer_id: bar,
  })
  const mockPrinter = job({ type: 'test', content: '{"mockPrinter":true}' })
  return { ...base, pending, printed, discardedJob, mockPrinter }
}

describe('print queue with jobs in every status', () => {
  it('each row stays identical, column by column, when re-running (nothing moves or is lost)', () => {
    const { db } = withQueue()
    const before = rows(db)
    expect(before).toHaveLength(4)
    expect(applyMigrations(db)).toEqual([])
    const after = rows(db)
    expect(after).toEqual(before)
    // The columns keep their names and order.
    const columns = (tableName: string) =>
      db
        .prepare(`SELECT name FROM pragma_table_info('${tableName}')`)
        .all()
        .map((c) => c.name)
    expect(Object.keys(after[0] ?? {})).toEqual(columns('print_jobs'))
  })

  it('keeps the data that matter about a person: who discarded, from which device and why', () => {
    const { db, discardedJob, user, device, bar } = withQueue()
    applyMigrations(db)
    expect(db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(discardedJob)).toMatchObject({
      status: 'discarded',
      discarded_by_id: user,
      discarded_device_id: device,
      last_error: 'sin papel',
      attempts: 7,
      printer_id: bar,
      finished_at: NOW,
    })
  })

  it('the JSON content, the event and the ticket of a pending job are kept', () => {
    const { db, pending } = withQueue()
    const before = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(pending)
    applyMigrations(db)
    const after = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(pending)
    expect(after).toEqual(before)
    expect(JSON.parse(String(after?.content))).toEqual({
      station: 'Barra',
      lines: ['1 x Garden Margarita'],
    })
    expect(after).toMatchObject({ status: 'pending', attempts: 4, finished_at: null })
  })

  it('the other tables stay intact and the foreign keys have no broken references', () => {
    const { db } = withQueue()
    const sqlTables = ['restaurants', 'printers', 'users', 'devices', 'roles', 'products']
    const check = (t: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.n)
    const before = sqlTables.map(check)
    applyMigrations(db)
    expect(sqlTables.map(check)).toEqual(before)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
  })

  it('foreign keys stay on and are enforced in the queue', () => {
    const { db, job } = withQueue()
    applyMigrations(db)
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(() => job({ printer_id: newId() })).toThrow(/FOREIGN KEY/)
    expect(() =>
      job({
        status: 'discarded',
        finished_at: NOW,
        discarded_by_id: newId(),
      }),
    ).toThrow(/FOREIGN KEY/)
  })

  it('the table has no leftovers: no temporary table, no duplicated indexes or triggers', () => {
    const { db } = withQueue()
    applyMigrations(db)
    const objects = db
      .prepare(
        "SELECT type, name FROM sqlite_schema WHERE tbl_name LIKE 'print_jobs%' ORDER BY name",
      )
      .all()
      .map((o) => `${o.type}:${o.name}`)
    expect(objects.filter((o) => o.includes('new'))).toEqual([])
    expect(objects).toEqual(
      expect.arrayContaining([
        'index:print_jobs_pending',
        'index:print_jobs_unique',
        'trigger:print_jobs_no_delete',
        'trigger:print_jobs_no_replace',
        'table:print_jobs',
      ]),
    )
    expect(new Set(objects).size).toBe(objects.length)
    const tableName = db
      .prepare('PRAGMA table_list')
      .all()
      .find((t) => t.name === 'print_jobs')
    expect(tableName).toMatchObject({ strict: 1 })
  })

  it('the table rules still hold for the existing jobs', () => {
    const { db, job, pending, printed, bar } = withQueue()
    applyMigrations(db)
    // A job that already existed is neither deleted nor replaced.
    expect(() => db.prepare('DELETE FROM print_jobs WHERE id = ?').run(pending)).toThrow(
      /no se borra/,
    )
    expect(() =>
      db.prepare("UPDATE print_jobs SET status = 'cualquiera' WHERE id = ?").run(printed),
    ).toThrow()
    // A pending job has no finish time, finished ones do.
    expect(() => job({ status: 'pending', finished_at: NOW })).toThrow()
    expect(() => job({ status: 'printed' })).toThrow()
    // Printed must say on which printer it came out.
    expect(() => job({ status: 'printed', finished_at: NOW })).toThrow()
    expect(() => job({ status: 'printed', finished_at: NOW, printed_on_id: bar })).not.toThrow()
    expect(() => job({ attempts: -1 })).toThrow()
    expect(() => job({ content: 'no es json' })).toThrow()
  })

  it('the same event with the same ticket is not duplicated on a printer, existing rows included', () => {
    const { db, job, pending, kitchen } = withQueue()
    applyMigrations(db)
    const existingRow = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(pending)
    expect(() =>
      job({
        event_id: String(existingRow?.event_id),
        ticket_id: String(existingRow?.ticket_id),
        printer_id: kitchen,
      }),
    ).toThrow(/UNIQUE/)
    // Another printer or another ticket of the same event is fine.
    expect(() =>
      job({
        event_id: String(existingRow?.event_id),
        ticket_id: String(existingRow?.ticket_id),
      }),
    ).not.toThrow()
    expect(() =>
      job({
        event_id: String(existingRow?.event_id),
        ticket_id: newId(),
        printer_id: kitchen,
      }),
    ).not.toThrow()
  })

  it('jobs without an event (test pages) can repeat: the unique index ignores them', () => {
    const { db, job } = withQueue()
    applyMigrations(db)
    expect(() => {
      job({ type: 'test' })
      job({ type: 'test' })
      job({ type: 'preBill' })
      job({ type: 'preBill' })
    }).not.toThrow()
  })

  it('the pending index still serves the queue (restaurant, status, created_at)', () => {
    const { db } = withQueue()
    applyMigrations(db)
    const columns = db
      .prepare("SELECT name FROM pragma_index_info('print_jobs_pending') ORDER BY seqno")
      .all()
      .map((c) => c.name)
    expect(columns).toEqual(['restaurant_id', 'status', 'created_at'])
  })

  it('a pre-bill without a ticket is stored and queried as pending', () => {
    const { db, job } = withQueue()
    applyMigrations(db)
    const id = job({
      type: 'preBill',
      event_id: newId(),
      ticket_id: null,
      content: '{"table":"5"}',
    })
    expect(db.prepare('SELECT type, status FROM print_jobs WHERE id = ?').get(id)).toEqual({
      type: 'preBill',
      status: 'pending',
    })
    const pendingList = db
      .prepare("SELECT count(*) AS n FROM print_jobs WHERE status = 'pending'")
      .get()
    expect(pendingList).toEqual({ n: 3 })
  })
})

describe('print queue: edge cases', () => {
  it('with an empty queue, re-running also works and leaves it empty', () => {
    const db = openDatabase(':memory:')
    expect(applyMigrations(db)).toEqual([1])
    seed(db)
    expect(applyMigrations(db)).toEqual([])
    expect(rows(db)).toEqual([])
  })

  it('a new database gets the single migration', () => {
    const db = openDatabase(':memory:')
    expect(applyMigrations(db)).toEqual(MIGRATIONS.map((m) => m.version))
    expect(applyMigrations(db)).toEqual([])
    expect(currentVersion(db)).toBe(1)
  })

  it('re-running the migrations does nothing and does not touch the jobs', () => {
    const { db } = withQueue()
    applyMigrations(db)
    const before = rows(db)
    expect(applyMigrations(db)).toEqual([])
    expect(rows(db)).toEqual(before)
  })

  it('if the migration leaves a broken reference it fails entirely: no table is left half made', () => {
    const db = openDatabase(':memory:')
    // A job pointing to a printer that does not exist (slipped in with the keys off).
    const broken = {
      ...(MIGRATIONS[0] as (typeof MIGRATIONS)[number]),
      withoutForeignKeys: true,
      sql: `${MIGRATIONS[0]?.sql}
INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
VALUES ('${newId()}', '${newId()}', '${newId()}', 'ticket', '{}', '${NOW}');`,
    }
    expect(() => applyMigrations(db, [broken])).toThrow(/referencias rotas/)
    expect(currentVersion(db)).toBe(0)
    // No table was left half made.
    const names = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'print_jobs%' OR name = 'card_terminals'",
      )
      .all()
      .map((o) => o.name)
    expect(names).not.toContain('print_jobs')
    expect(names).not.toContain('print_jobs_new')
    expect(names).not.toContain('card_terminals')
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  })

  it('a job with an unknown type cannot enter, before or after re-running', () => {
    const { db, job } = withQueue()
    expect(() => job({ type: 'PreBill' })).toThrow()
    expect(() => job({ type: 'receipt' })).toThrow()
    applyMigrations(db)
    expect(() => job({ type: 'receipt' })).toThrow()
  })
})

describe('card terminals', () => {
  function migrated() {
    const base = migratedDatabase()
    const cardTerminal = (fields: Record<string, string | number | null> = {}) =>
      insertVersioned(base.db, 'card_terminals', base.restaurant, {
        name: 'Bold 1',
        provider: 'bold',
        ...fields,
      })
    return { ...base, cardTerminal }
  }

  it.each(['bold', 'redeban', 'credibanco', 'other'])('accepts the provider %s', (provider) => {
    const { cardTerminal } = migrated()
    expect(() => cardTerminal({ provider })).not.toThrow()
  })

  it.each(['visa', '', 'BOLD', null])('rejects the provider %s', (provider) => {
    const { cardTerminal } = migrated()
    expect(() => cardTerminal({ provider })).toThrow()
  })

  it('the name is 1 to 60 characters long', () => {
    const { cardTerminal } = migrated()
    expect(() => cardTerminal({ name: 'x' })).not.toThrow()
    expect(() => cardTerminal({ name: 'x'.repeat(60) })).not.toThrow()
    expect(() => cardTerminal({ name: 'x'.repeat(61) })).toThrow()
    expect(() => cardTerminal({ name: '' })).toThrow()
    expect(() => cardTerminal({ name: null })).toThrow()
  })

  it('starts active, and active is only 0 or 1', () => {
    const { db, cardTerminal } = migrated()
    const id = cardTerminal()
    expect(db.prepare('SELECT active FROM card_terminals WHERE id = ?').get(id)).toEqual({
      active: 1,
    })
    expect(() => cardTerminal({ active: 2 })).toThrow()
    expect(() => cardTerminal({ active: -1 })).toThrow()
  })

  it('is archived with active = 0 and reused; it is not deleted', () => {
    const { db, cardTerminal } = migrated()
    const id = cardTerminal()
    db.prepare('UPDATE card_terminals SET active = 0, version = version + 1 WHERE id = ?').run(id)
    expect(db.prepare('SELECT active, version FROM card_terminals WHERE id = ?').get(id)).toEqual({
      active: 0,
      version: 2,
    })
    db.prepare('UPDATE card_terminals SET active = 1, version = version + 1 WHERE id = ?').run(id)
    expect(db.prepare('SELECT active FROM card_terminals WHERE id = ?').get(id)).toEqual({
      active: 1,
    })
    expect(() => db.prepare('DELETE FROM card_terminals WHERE id = ?').run(id)).toThrow(
      /se archiva/,
    )
  })

  it('requires an existing restaurant and a 26-character ULID', () => {
    const { db, cardTerminal } = migrated()
    expect(() =>
      insertVersioned(db, 'card_terminals', newId(), { name: 'Huérfano', provider: 'bold' }),
    ).toThrow(/FOREIGN KEY/)
    expect(() =>
      insertVersioned(
        db,
        'card_terminals',
        String(db.prepare('SELECT id FROM restaurants').get()?.id),
        { name: 'Corto', provider: 'bold' },
        'corto',
      ),
    ).toThrow()
    expect(() => cardTerminal()).not.toThrow()
  })

  it('the version cannot be negative and the version index serves sync', () => {
    const { db, cardTerminal } = migrated()
    expect(() => cardTerminal({ version: -1 })).toThrow()
    const columns = db
      .prepare("SELECT name FROM pragma_index_info('card_terminals_by_version') ORDER BY seqno")
      .all()
      .map((c) => c.name)
    expect(columns).toEqual(['restaurant_id', 'version'])
  })

  it('each restaurant has its own: two can give their terminal the same name', () => {
    const { db, cardTerminal } = migrated()
    const other = newId()
    insertVersioned(db, 'restaurants', other, { name: 'Otro', config: '{}' }, other)
    cardTerminal()
    expect(() =>
      insertVersioned(db, 'card_terminals', other, { name: 'Bold 1', provider: 'bold' }),
    ).not.toThrow()
    expect(
      db.prepare('SELECT count(*) AS n FROM card_terminals WHERE restaurant_id = ?').get(other),
    ).toEqual({ n: 1 })
  })
})
