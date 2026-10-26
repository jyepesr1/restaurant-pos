import type { Client } from 'pg'
import type { Row, Sql } from './sql'

// `Sql` sobre node-postgres (`pg`): el conector que recomiendan Cloudflare y Neon con Hyperdrive
// (docs/integraciones/neon-cloudflare.md). Sirve en el Worker y en los comandos de Node.

export function sqlDePg(client: Pick<Client, 'query'>, inTransaction = false): Sql {
  const sql: Sql = {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []) {
      const r = await client.query(text, [...params])
      return r.rows as T[]
    },
    async execute(guion: string) {
      // Sin parámetros, pg manda el guion entero (varias sentencias) en una sola consulta.
      await client.query(guion)
    },
    async transaction<T>(job: (tx: Sql) => Promise<T>) {
      // Dentro de una transacción no se abre otra: se sigue en la misma.
      if (inTransaction) return job(sql)
      await client.query('BEGIN')
      try {
        const r = await job(sqlDePg(client, true))
        await client.query('COMMIT')
        return r
      } catch (e) {
        // Si la conexión se cayó, el ROLLBACK también falla: se conserva el error original.
        await client.query('ROLLBACK').catch(() => {})
        throw e
      }
    },
  }
  return sql
}

/**
 * Un `Sql` que se conecta recién en la primera consulta: las rutas que no tocan la base (salud,
 * rutas que no existen) no abren conexión.
 */
export function sqlPerezoso(connect: () => Promise<Sql>): Sql {
  let connection: Promise<Sql> | null = null
  const sql = () => {
    connection ??= connect()
    return connection
  }
  return {
    query: async (text, params) => (await sql()).query(text, params),
    execute: async (guion) => (await sql()).execute(guion),
    transaction: async (job) => (await sql()).transaction(job),
  }
}
