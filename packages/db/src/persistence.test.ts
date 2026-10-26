import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId } from '@pos/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, currentVersion } from './migrate'
import { MIGRATIONS } from './migrations'

const ALL = MIGRATIONS.map((m) => m.version)
const LATEST = ALL.at(-1)

import { openDatabase } from './node'
import type { SqliteDatabase } from './sqlite'
import { insertEvent, seed } from './testing/utils'

const CHILD = fileURLToPath(new URL('./testing/child-transaction.mjs', import.meta.url))

describe('database in a file', () => {
  let folder: string
  let route: string
  const openHandles: SqliteDatabase[] = []

  const open = () => {
    const db = openDatabase(route)
    openHandles.push(db)
    return db
  }

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'pos-db-'))
    route = join(folder, 'pos.sqlite')
  })

  afterEach(() => {
    for (const db of openHandles.splice(0)) (db as unknown as { close(): void }).close()
    rmSync(folder, { recursive: true, force: true })
  })

  it('opens in WAL mode with foreign keys and full synchronous', () => {
    const db = open()

    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
    expect(db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2)
  })

  it('reopening an already migrated file repeats no migrations and keeps the data', () => {
    const first = open()
    expect(applyMigrations(first, undefined, () => '2026-10-24T10:00:00.000Z')).toEqual(ALL)
    const { restaurant } = seed(first)
    const event = insertEvent(first, restaurant)
    ;(first as unknown as { close(): void }).close()
    openHandles.length = 0

    const second = open()
    expect(applyMigrations(second, undefined, () => '2030-01-01T00:00:00.000Z')).toEqual([])

    expect(currentVersion(second)).toBe(LATEST)
    expect(second.prepare('SELECT version, applied_at FROM migrations').all()).toEqual(
      ALL.map((version) => ({ version, applied_at: '2026-10-24T10:00:00.000Z' })),
    )
    expect(
      second.prepare('SELECT id, data FROM events WHERE restaurant_id = ?').all(restaurant),
    ).toEqual([{ id: event.id, data: '{"channel":"dine_in"}' }])
    expect(second.prepare('SELECT name FROM products').all()).toEqual([{ name: 'Margarita' }])
  })

  it('a migrated and reopened database still rejects UPDATE of events', () => {
    const first = open()
    applyMigrations(first)
    const { restaurant } = seed(first)
    insertEvent(first, restaurant)
    ;(first as unknown as { close(): void }).close()
    openHandles.length = 0

    expect(() => open().exec("UPDATE events SET data = '{}'")).toThrow(/no se modifican/)
  })

  it('if the process dies midway through a transaction nothing is left half done', async () => {
    const initial = open()
    applyMigrations(initial)
    const { restaurant } = seed(initial)
    const confirmed = insertEvent(initial, restaurant, { sequence: 1 })
    const pending = newId()

    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', CHILD, route, restaurant, pending],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let errors = ''
    child.stderr.on('data', (chunk) => {
      errors += String(chunk)
    })
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.on('exit', (_code, signal) => resolve(signal)),
    )

    // The child reports when it has done the INSERT inside BEGIN and not committed yet.
    await new Promise<void>((resolve, reject) => {
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
        if (output.includes('in-transaction')) resolve()
      })
      child.on('exit', () => reject(new Error(`The child exited early: ${errors}`)))
    })

    // While the transaction is still open, another reader only sees what was committed.
    const events = () =>
      initial
        .prepare('SELECT id FROM events ORDER BY sequence')
        .all()
        .map((row) => row.id)
    expect(events()).toEqual([confirmed.id])

    child.kill('SIGKILL')
    expect(await exited).toBe('SIGKILL')
    ;(initial as unknown as { close(): void }).close()
    openHandles.length = 0

    const reopenedInstance = open()
    expect(applyMigrations(reopenedInstance)).toEqual([])
    expect(currentVersion(reopenedInstance)).toBe(LATEST)
    expect(
      reopenedInstance
        .prepare('SELECT id FROM events ORDER BY sequence')
        .all()
        .map((row) => row.id),
    ).toEqual([confirmed.id])
    expect(
      reopenedInstance.prepare('SELECT count(*) AS n FROM events WHERE id = ?').get(pending)?.n,
    ).toBe(0)
    expect(reopenedInstance.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')

    // Sequence 2, which the child was using, is free for the next real event.
    expect(() => insertEvent(reopenedInstance, restaurant, { sequence: 2 })).not.toThrow()
  })

  it('creating the database in a new folder leaves the file at the latest version', () => {
    const db = open()
    applyMigrations(db)

    expect(existsSync(route)).toBe(true)
    expect(currentVersion(db)).toBe(LATEST)
  })
})
