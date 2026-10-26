import type { Client } from 'pg'
import type { Fila, Sql } from './sql'

// `Sql` sobre node-postgres (`pg`): el conector que recomiendan Cloudflare y Neon con Hyperdrive
// (docs/integraciones/neon-cloudflare.md). Sirve en el Worker y en los comandos de Node.

export function sqlDePg(cliente: Pick<Client, 'query'>, enTransaccion = false): Sql {
  const sql: Sql = {
    async query<T extends Fila = Fila>(texto: string, parametros: readonly unknown[] = []) {
      const r = await cliente.query(texto, [...parametros])
      return r.rows as T[]
    },
    async ejecutar(guion: string) {
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
export function sqlPerezoso(conectar: () => Promise<Sql>): Sql {
  let conexion: Promise<Sql> | null = null
  const sql = () => {
    conexion ??= conectar()
    return conexion
  }
  return {
    query: async (texto, parametros) => (await sql()).query(texto, parametros),
    ejecutar: async (guion) => (await sql()).ejecutar(guion),
    transaccion: async (trabajo) => (await sql()).transaccion(trabajo),
  }
}
