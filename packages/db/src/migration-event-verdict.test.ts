import { describe, expect, it } from 'vitest'
import { applyMigrations, currentVersion, sqlFingerprint } from './migrate'
import { MIGRATIONS } from './migrations'
import { openDatabase } from './node'
import { insertEvent, seed } from './testing/utils'

// Migration 0002 (task 1.7b): the hub's verdict on each event, `events.unapplied`.

/** A database at version 1 (before the verdict) with two events already saved. */
function beforeTheVerdict() {
  const db = openDatabase(':memory:')
  expect(applyMigrations(db, MIGRATIONS.slice(0, 1))).toEqual([1])
  const { restaurant } = seed(db)
  const first = insertEvent(db, restaurant)
  const second = insertEvent(db, restaurant, { sequence: 2, type: 'OrderClosed', data: '{}' })
  return { db, restaurant, ids: [first.id, second.id] }
}

const verdicts = (db: ReturnType<typeof openDatabase>) =>
  db
    .prepare('SELECT sequence, unapplied FROM events ORDER BY sequence')
    .all()
    .map((r) => [Number(r.sequence), Number(r.unapplied)])

describe('migration 0002: the verdict of each event', () => {
  it('is the second migration and is recorded with its name and hash', () => {
    const db = openDatabase(':memory:')
    expect(MIGRATIONS.map((m) => [m.version, m.name])).toEqual([
      [1, 'initial'],
      [2, 'event_verdict'],
    ])
    expect(applyMigrations(db)).toEqual([1, 2])
    expect(currentVersion(db)).toBe(2)
    expect(db.prepare('SELECT name, hash FROM migrations WHERE version = 2').get()).toEqual({
      name: 'event_verdict',
      hash: sqlFingerprint(MIGRATIONS[1]?.sql as string),
    })
  })

  it('on a database with events, every saved event stays applied (0) and keeps its columns', () => {
    const { db } = beforeTheVerdict()
    const before = db.prepare('SELECT * FROM events ORDER BY sequence').all()
    expect(applyMigrations(db)).toEqual([2])
    const after = db.prepare('SELECT * FROM events ORDER BY sequence').all()
    expect(after).toEqual(before.map((row) => ({ ...row, unapplied: 0 })))
    expect(applyMigrations(db)).toEqual([])
    expect(verdicts(db)).toEqual([
      [1, 0],
      [2, 0],
    ])
  })

  it('a new event can be saved as not applied (1), and nothing else', () => {
    const { db, restaurant } = beforeTheVerdict()
    applyMigrations(db)
    insertEvent(db, restaurant, { sequence: 3, type: 'PaymentRecorded', unapplied: 1 })
    expect(() => insertEvent(db, restaurant, { sequence: 4, unapplied: 2 })).toThrow(/CHECK/)
    expect(() => insertEvent(db, restaurant, { sequence: 4, unapplied: null })).toThrow(/NOT NULL/)
    expect(verdicts(db)).toEqual([
      [1, 0],
      [2, 0],
      [3, 1],
    ])
  })

  it('events are still never updated, deleted or replaced: neither is their verdict', () => {
    const { db, restaurant, ids } = beforeTheVerdict()
    applyMigrations(db)
    expect(() =>
      db.prepare('UPDATE events SET unapplied = 1 WHERE id = ?').run(ids[0] as string),
    ).toThrow(/no se modifican/)
    expect(() => db.prepare('DELETE FROM events WHERE id = ?').run(ids[1] as string)).toThrow(
      /no se borran/,
    )
    expect(() =>
      insertEvent(db, restaurant, { id: ids[0] as string, sequence: 3, unapplied: 1 }),
    ).toThrow(/no se reemplazan/)
    expect(verdicts(db)).toEqual([
      [1, 0],
      [2, 0],
    ])
  })

  it('editing it after it was applied is rejected by its hash', () => {
    const db = openDatabase(':memory:')
    applyMigrations(db)
    const edited = MIGRATIONS.map((m) => (m.version === 2 ? { ...m, sql: `${m.sql}\n-- x` } : m))
    expect(() => applyMigrations(db, edited)).toThrow(/Migration 2 .*changed after it was applied/)
  })

  it('a hub with only the first migration does not open a database already at version 2', () => {
    const db = openDatabase(':memory:')
    applyMigrations(db)
    expect(() => applyMigrations(db, MIGRATIONS.slice(0, 1))).toThrow(/version 2, newer/)
  })
})
