import { PGlite, type Transaction } from '@electric-sql/pglite'
import { migrar } from '../migraciones'
import type { Row, Sql } from '../sql'

// Postgres embebido (PGlite) para las pruebas: el mismo SQL que correrá en Neon, sin red ni cuentas.

type Connection = PGlite | Transaction

export function envolver(db: Connection): Sql {
  return {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []) {
      const r = await db.query<T>(text, [...params])
      return r.rows
    },
    async execute(guion: string) {
      await db.exec(guion)
    },
    async transaction<T>(job: (sql: Sql) => Promise<T>) {
      // Dentro de una transacción no se abre otra: se sigue en la misma.
      if (!('transaction' in db)) return job(envolver(db))
      return db.transaction((tx) => job(envolver(tx)))
    },
  }
}

/** Una base nueva en memoria, con las migraciones aplicadas. */
export async function baseDePrueba(): Promise<{ sql: Sql; db: PGlite }> {
  const db = new PGlite()
  const sql = envolver(db)
  await migrar(sql)
  return { sql, db }
}

/** Una base nueva en memoria, SIN migraciones (para probar las propias migraciones). */
export function baseVacia(): { sql: Sql; db: PGlite } {
  const db = new PGlite()
  return { sql: envolver(db), db }
}
