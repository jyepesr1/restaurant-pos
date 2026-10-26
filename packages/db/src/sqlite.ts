/** Values SQLite accepts as a parameter. */
export type SqlValue = string | number | bigint | null | Uint8Array

export type Row = Record<string, SqlValue>

export interface Statement {
  run(...params: SqlValue[]): { changes: number | bigint }
  get(...params: SqlValue[]): Row | undefined
  all(...params: SqlValue[]): Row[]
}

/**
 * The minimum the system needs from a SQLite database. Both `node:sqlite` (hub) and
 * `better-sqlite3` satisfy it, so the engine can be swapped without touching migrations or
 * queries.
 */
export interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}

/**
 * Runs `job` inside a transaction: everything is saved or nothing is. `job` must be
 * synchronous: with an async function the COMMIT would happen before it finishes.
 */
export function inTransaction<T>(db: SqliteDatabase, job: () => T): T {
  // Inside another transaction, the job joins it: everything stays or nothing does. There is no
  // savepoint: whoever catches an inner transaction's error without rethrowing it leaves its work
  // half done inside the outer one. That is why the error is always allowed to propagate.
  if (inProgress.has(db)) {
    const result = job()
    if (typeof (result as { then?: unknown } | undefined)?.then === 'function')
      throw new Error('inTransaction no admite funciones asíncronas')
    return result
  }
  db.exec('BEGIN IMMEDIATE')
  inProgress.add(db)
  try {
    const result = job()
    if (typeof (result as { then?: unknown } | undefined)?.then === 'function') {
      throw new Error('inTransaction no admite funciones asíncronas')
    }
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // SQLite already rolled back the transaction on its own (disk full, I/O): what matters
      // is the original error.
    }
    throw error
  } finally {
    inProgress.delete(db)
  }
}

/** The databases with an open `inTransaction` transaction. */
const inProgress = new WeakSet<SqliteDatabase>()
