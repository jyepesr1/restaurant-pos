import { PGlite, type Transaction } from '@electric-sql/pglite'
import { migrate } from '../migrations'
import type { Row, Sql } from '../sql'

// Embedded Postgres (PGlite) for the tests: the same SQL that will run on Neon, with no network or
// accounts.

type Connection = PGlite | Transaction

export function wrap(db: Connection): Sql {
  return {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []) {
      const r = await db.query<T>(text, [...params])
      return r.rows
    },
    async execute(script: string) {
      await db.exec(script)
    },
    async transaction<T>(job: (sql: Sql) => Promise<T>) {
      // Inside a transaction no new one is opened: it continues in the same one.
      if (!('transaction' in db)) return job(wrap(db))
      return db.transaction((tx) => job(wrap(tx)))
    },
  }
}

/** A new in-memory database, with the migrations applied. */
export async function testDatabase(): Promise<{ sql: Sql; db: PGlite }> {
  const db = new PGlite()
  const sql = wrap(db)
  await migrate(sql)
  return { sql, db }
}

/** A new in-memory database, WITHOUT migrations (to test the migrations themselves). */
export function emptyDatabase(): { sql: Sql; db: PGlite } {
  const db = new PGlite()
  return { sql: wrap(db), db }
}
