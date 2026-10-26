import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { applyMigrations, currentVersion } from './migrate'
import { MIGRATIONS } from './migrations'
import { openDatabase } from './node'
import { insertIntoTable, insertVersioned, NOW, seed } from './testing/utils'

// `print_jobs` accepts the Z report (`report`, task 1.9) without losing rows.

function migratedDatabase() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
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
  return { db, job }
}

const rows = (db: ReturnType<typeof openDatabase>) =>
  db.prepare('SELECT * FROM print_jobs ORDER BY id').all()

describe('report print jobs', () => {
  it('jobs of every type, the report included, stay identical when re-running the migrations', () => {
    const { db, job } = migratedDatabase()
    job()
    job({ type: 'preBill', event_id: newId(), ticket_id: 'preBill' })
    job({ type: 'test', status: 'discarded', finished_at: NOW })
    job({ type: 'report', event_id: newId(), ticket_id: 'closeout' })
    const before = rows(db)
    expect(MIGRATIONS[0]?.name).toBe('initial')
    expect(applyMigrations(db)).toEqual([])
    expect(currentVersion(db)).toBe(1)
    expect(rows(db)).toEqual(before)
  })

  it('accepts the report type only with its exact name, and it is not replaced or deleted', () => {
    const { db, job } = migratedDatabase()
    expect(() => job({ type: 'Report' })).toThrow()
    const event = newId()
    job({ type: 'report', event_id: event, ticket_id: 'closeout' })
    // The same closeout on the same printer is not duplicated (unique index).
    expect(() => job({ type: 'report', event_id: event, ticket_id: 'closeout' })).toThrow()
    // A reprint has no event: there can be several.
    job({ type: 'report', ticket_id: 'closeout' })
    job({ type: 'report', ticket_id: 'closeout' })
    expect(() => db.prepare('DELETE FROM print_jobs').run()).toThrow(/no se borra/)
    expect(() => job({ type: 'other' })).toThrow()
  })
})
