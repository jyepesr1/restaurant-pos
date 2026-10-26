import type { Client } from 'pg'
import type { Fila, Sql } from './sql'

// `Sql` sobre node-postgres (`pg`): el conector que recomiendan Cloudflare y Neon con Hyperdrive
// (docs/integraciones/neon-cloudflare.md). Sirve en el Worker y en los comandos de Node.

export function sqlDePg(cliente: Pick<Client, 'query'>, enTransaccion = false): Sql {
  const sql: Sql = {
    async query<T extends Fila = Fila>(text: string, parametros: readonly unknown[] = []) {
      const r = await cliente.query(text, [...parametros])
      return r.rows as T[]
    },
    async execute(guion: string) {
      // Sin parámetros, pg manda el guion entero (varias sentencias) en una sola consulta.
      await cliente.query(guion)
    },
    async transaccion<T>(trabajo: (tx: Sql) => Promise<T>) {
      // Dentro de una transacción no se abre otra: se sigue en la misma.
      if (enTransaccion) return trabajo(sql)
      await cliente.query('BEGIN')
      try {
        const r = await trabajo(sqlDePg(cliente, true))
        await cliente.query('COMMIT')
        return r
      } catch (e) {
        // Si la conexión se cayó, el ROLLBACK también falla: se conserva el error original.
        await cliente.query('ROLLBACK').catch(() => {})
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
    query: async (text, parametros) => (await sql()).query(text, parametros),
    execute: async (guion) => (await sql()).execute(guion),
    transaccion: async (trabajo) => (await sql()).transaccion(trabajo),
  }
}
