import { PGlite, type Transaction } from '@electric-sql/pglite'
import { migrar } from '../migraciones'
import type { Fila, Sql } from '../sql'

// Postgres embebido (PGlite) para las pruebas: el mismo SQL que correrá en Neon, sin red ni cuentas.

type Conexion = PGlite | Transaction

export function envolver(db: Conexion): Sql {
  return {
    async query<T extends Fila = Fila>(text: string, parametros: readonly unknown[] = []) {
      const r = await db.query<T>(text, [...parametros])
      return r.rows
    },
    async execute(guion: string) {
      await db.exec(guion)
    },
    async transaccion<T>(trabajo: (sql: Sql) => Promise<T>) {
      // Dentro de una transacción no se abre otra: se sigue en la misma.
      if (!('transaction' in db)) return trabajo(envolver(db))
      return db.transaction((tx) => trabajo(envolver(tx)))
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
