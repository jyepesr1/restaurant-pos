import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { applyMigrations, currentVersion, sqlFingerprint } from './migrate'
import { MIGRATIONS } from './migrations'
import { openDatabase } from './node'
import { COMMON_COLUMNS, VERSIONED_TABLES } from './schema'
import type { SqliteDatabase } from './sqlite'
import { insertIntoTable, insertVersioned, NOW, seed } from './testing/utils'

// Checkout (task 1.6): card terminals and pre-bills in the print queue.

/** A migrated database with a printer and print jobs in every status. */
function migratedDatabase() {
  const db = openDatabase(':memory:')
  const applied = applyMigrations(db)
  const s = seed(db)
  const printer = insertVersioned(db, 'printers', s.restaurant, {
    name: 'Barra',
    connection: 'network',
    address: '192.168.1.50',
    port: 9100,
    width: 80,
  })
  const job = (fields: Record<string, string | number | null>) => {
    const id = newId()
    insertIntoTable(db, 'print_jobs', {
      id,
      restaurant_id: s.restaurant,
      printer_id: printer,
      type: 'ticket',
      content: '{"station":"Barra"}',
      created_at: NOW,
      ...fields,
    })
    return id
  }
  job({ event_id: newId(), ticket_id: newId() })
  job({ type: 'test' })
  job({ status: 'printed', finished_at: NOW, printed_on_id: printer, attempts: 2 })
  return { db, applied, ...s, printer, job }
}

const rows = (db: SqliteDatabase) => db.prepare('SELECT * FROM print_jobs ORDER BY id').all()

describe('checkout', () => {
  it('the initial migration is applied and recorded with its name and hash', () => {
    const { db, applied } = migratedDatabase()
    expect(MIGRATIONS[0]?.name).toBe('initial')
    expect(applied).toEqual([1])
    expect(currentVersion(db)).toBe(1)
    expect(db.prepare('SELECT name, hash FROM migrations WHERE version = 1').get()).toEqual({
      name: 'initial',
      hash: sqlFingerprint(MIGRATIONS[0]?.sql as string),
    })
  })

  it('the print queue keeps each row as is when re-running and accepts pre-bills', () => {
    const { db, job } = migratedDatabase()
    const before = rows(db)
    expect(before).toHaveLength(3)
    expect(() => job({ type: 'prebill' })).toThrow()
    expect(applyMigrations(db)).toEqual([])
    expect(rows(db)).toEqual(before)
    expect(() => job({ type: 'preBill' })).not.toThrow()
    expect(() => job({ type: 'otra' })).toThrow()
  })

  it('the queue does not allow deleting, replacing or duplicating an event on the same printer', () => {
    const { db, job, printer } = migratedDatabase()
    const id = job({})
    expect(() => db.prepare('DELETE FROM print_jobs WHERE id = ?').run(id)).toThrow(/no se borra/)
    expect(() =>
      db
        .prepare(
          'INSERT OR REPLACE INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at) SELECT id, restaurant_id, printer_id, type, content, created_at FROM print_jobs WHERE id = ?',
        )
        .run(id),
    ).toThrow(/no se reemplazan/)
    const event = newId()
    job({ event_id: event, ticket_id: 'c' })
    expect(() => job({ event_id: event, ticket_id: 'c' })).toThrow()
    const indices = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'print_jobs'")
      .all()
      .map((i) => i.name)
    expect(indices).toEqual(expect.arrayContaining(['print_jobs_pending', 'print_jobs_unique']))
    expect(printer).toBeTruthy()
  })

  it('card_terminals is STRICT, versioned, with the common columns, and is not deleted', () => {
    const { db, restaurant } = migratedDatabase()
    expect(VERSIONED_TABLES).toContain('card_terminals')
    const tableName = db
      .prepare('PRAGMA table_list')
      .all()
      .find((t) => t.name === 'card_terminals')
    expect(tableName).toMatchObject({ strict: 1 })
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('card_terminals')")
      .all()
      .map((c) => c.name)
    for (const common of COMMON_COLUMNS) expect(columns).toContain(common)
    const id = insertVersioned(db, 'card_terminals', restaurant, {
      name: 'Bold 1',
      provider: 'bold',
    })
    expect(() =>
      insertVersioned(db, 'card_terminals', restaurant, { name: 'X', provider: 'visa' }),
    ).toThrow()
    expect(() =>
      insertVersioned(db, 'card_terminals', restaurant, { name: '', provider: 'bold' }),
    ).toThrow()
    expect(() => db.prepare('DELETE FROM card_terminals WHERE id = ?').run(id)).toThrow(
      /se archiva/,
    )
  })

  it('the database is consistent', () => {
    const { db } = migratedDatabase()
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
  })
})
