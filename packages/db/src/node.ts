import { DatabaseSync } from 'node:sqlite'
import type { SqliteDatabase } from './sqlite'

export interface OpenOptions {
  /**
   * Holds the database exclusively while the process lives: a second hub on the same data
   * folder cannot open it. Used in the hub, not in tests.
   */
  exclusive?: boolean
  /** How long to wait if the database is busy before failing. */
  waitMs?: number
}

export class DatabaseBusyError extends Error {
  constructor() {
    super('Otro hub ya está usando esta base de datos. Cierra el otro antes de abrir este.')
  }
}

/**
 * Opens the hub database with `node:sqlite` (bundled with Node, no native modules to compile
 * on Windows). Node only: the cloud will use its own platform's SQLite.
 * A single connection per process: `node:sqlite` is synchronous and a wait blocks the hub.
 */
export function openDatabase(
  route: string,
  { exclusive = false, waitMs = 5000 }: OpenOptions = {},
): SqliteDatabase {
  const db = new DatabaseSync(route)
  try {
    // busy_timeout first: switching to WAL needs a lock and must be able to wait.
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(waitMs)}`)
    if (exclusive) db.exec('PRAGMA locking_mode = EXCLUSIVE')

    const mode = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode
    if (route !== ':memory:' && mode !== 'wal') {
      throw new Error(`No se pudo activar el modo WAL (quedó en "${String(mode)}")`)
    }
    // FULL: without a UPS, a power outage must not lose the last committed transaction (ADR-003).
    // recursive_triggers: extra safeguard so a REPLACE fires the delete blocks.
    db.exec(`
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA recursive_triggers = ON;
    `)
    // In exclusive mode the lock is taken on the first write: do it now.
    if (exclusive) db.exec('BEGIN IMMEDIATE; COMMIT;')
  } catch (error) {
    db.close()
    if (error instanceof Error && /database is locked/i.test(error.message)) {
      throw new DatabaseBusyError()
    }
    throw error
  }
  return db
}
