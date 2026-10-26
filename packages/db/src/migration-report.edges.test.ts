import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from './migrate'
import { openDatabase } from './node'
import { insertIntoTable, insertVersioned, NOW, seed } from './testing/utils'

// The print queue beyond the basics: what it must keep (constraints, triggers, indexes and keys)
// and that re-running the migrations does nothing.

function migratedDatabase() {
  const db = openDatabase(':memory:')
  const applied = applyMigrations(db)
  const s = seed(db)
  const printer = insertVersioned(db, 'printers', s.restaurant, {
    name: 'Caja',
    connection: 'network',
    address: '192.168.1.60',
    port: 9100,
    width: 80,
  })
  const job = (fields: Record<string, string | number | null> = {}) =>
    insertIntoTable(db, 'print_jobs', {
      id: newId(),
      restaurant_id: s.restaurant,
      printer_id: printer,
      type: 'ticket',
      content: '{}',
      created_at: NOW,
      ...fields,
    })
  return { db, applied, s, printer, job }
}

const list = (db: ReturnType<typeof openDatabase>, type: string) =>
  db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? ORDER BY name')
    .all(type, 'print_jobs')
    .map((f) => String(f.name))

describe('print queue: what it keeps', () => {
  it('re-running does nothing and the database has no broken keys', () => {
    const { db, applied, job } = migratedDatabase()
    job()
    expect(applied).toEqual([1])
    expect(applyMigrations(db)).toEqual([])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('SELECT count(*) AS n FROM print_jobs').get()?.n).toBe(1)
  })

  it('has its indexes and triggers, and re-running keeps them', () => {
    const before = migratedDatabase()
    const indexesBefore = list(before.db, 'index').filter((n) => !n.startsWith('sqlite_'))
    const triggersBefore = list(before.db, 'trigger')
    expect(indexesBefore).toEqual(['print_jobs_pending', 'print_jobs_unique'])
    expect(triggersBefore).toEqual(['print_jobs_no_delete', 'print_jobs_no_replace'])
    applyMigrations(before.db)
    expect(list(before.db, 'index').filter((n) => !n.startsWith('sqlite_'))).toEqual(indexesBefore)
    expect(list(before.db, 'trigger')).toEqual(triggersBefore)
    expect(triggersBefore.length).toBeGreaterThanOrEqual(2)
  })

  it('the table is STRICT and there is no leftover temporary table', () => {
    const { db } = migratedDatabase()
    const sql = String(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'print_jobs'").get()?.sql,
    )
    expect(sql).toMatch(/STRICT/)
    expect(sql).toContain("'report'")
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'print_jobs_new'").get(),
    ).toBeUndefined()
  })

  it('the other constraints hold: status, finished and who printed', () => {
    const { printer, job } = migratedDatabase()
    expect(() => job({ type: 'report', status: 'raro' })).toThrow()
    // Pending with a finish time, or finished without one, is not valid.
    expect(() => job({ type: 'report', finished_at: NOW })).toThrow()
    expect(() => job({ type: 'report', status: 'discarded' })).toThrow()
    // Printed without saying on which printer, neither.
    expect(() => job({ type: 'report', status: 'printed', finished_at: NOW })).toThrow()
    expect(() =>
      job({
        type: 'report',
        status: 'printed',
        finished_at: NOW,
        printed_on_id: printer,
      }),
    ).not.toThrow()
    // The content is JSON.
    expect(() => job({ type: 'report', content: 'no es json' })).toThrow()
    // A printer that does not exist.
    expect(() => job({ type: 'report', printer_id: newId() })).toThrow()
  })

  it('the same event can produce a Z report and a ticket on the same printer without clashing', () => {
    const { db, job } = migratedDatabase()
    const event = newId()
    job({ type: 'report', event_id: event, ticket_id: 'closeout' })
    job({ type: 'ticket', event_id: event, ticket_id: newId() })
    expect(() => job({ type: 'report', event_id: event, ticket_id: 'closeout' })).toThrow()
    // INSERT OR REPLACE does not rewrite the record (SQLite does not fire the delete then).
    const id = newId()
    job({ id, type: 'report', ticket_id: 'closeout' })
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
           SELECT id, restaurant_id, printer_id, type, '{"other":1}', created_at FROM print_jobs WHERE id = ?`,
        )
        .run(id),
    ).toThrow(/no se reemplazan|no se borra/)
  })

  it('existing rows keep status, attempts, errors and dates exactly when re-running', () => {
    const { db, printer, job } = migratedDatabase()
    job({
      attempts: 3,
      last_error: 'La impresora rechazó la conexión',
      type: 'preBill',
      ticket_id: 'preBill',
      event_id: newId(),
    })
    job({
      status: 'printed',
      finished_at: NOW,
      printed_on_id: printer,
      attempts: 1,
      content: '{"a":[1,2,3]}',
    })
    const before = db.prepare('SELECT * FROM print_jobs ORDER BY id').all()
    applyMigrations(db)
    expect(db.prepare('SELECT * FROM print_jobs ORDER BY id').all()).toEqual(before)
  })
})
