import type { Client } from 'pg'
import type { Row, Sql } from './sql'

// `Sql` over node-postgres (`pg`): the connector Cloudflare and Neon recommend with Hyperdrive
// (docs/integraciones/neon-cloudflare.md). Works in the Worker and in the Node commands.

export function sqlFromPg(client: Pick<Client, 'query'>, inTransaction = false): Sql {
  const sql: Sql = {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []) {
      const r = await client.query(text, [...params])
      return r.rows as T[]
    },
    async execute(script: string) {
      // Without parameters, pg sends the whole script (several statements) in a single query.
      await client.query(script)
    },
    async transaction<T>(job: (tx: Sql) => Promise<T>) {
      // Inside a transaction no new one is opened: it continues in the same one.
      if (inTransaction) return job(sql)
      await client.query('BEGIN')
      try {
        const r = await job(sqlFromPg(client, true))
        await client.query('COMMIT')
        return r
      } catch (e) {
        // If the connection dropped, the ROLLBACK fails too: the original error is kept.
        await client.query('ROLLBACK').catch(() => {})
        throw e
      }
    },
  }
  return sql
}

/**
 * An `Sql` that connects only on the first query: routes that do not touch the database (health,
 * routes that do not exist) do not open a connection.
 */
export function lazySql(connect: () => Promise<Sql>): Sql {
  let connection: Promise<Sql> | null = null
  const sql = () => {
    connection ??= connect()
    return connection
  }
  return {
    query: async (text, params) => (await sql()).query(text, params),
    execute: async (script) => (await sql()).execute(script),
    transaction: async (job) => (await sql()).transaction(job),
  }
}
