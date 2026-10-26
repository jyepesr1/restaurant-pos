import { Client } from 'pg'
import { atender } from './api'
import { sqlDePg, sqlPerezoso } from './pg'

// El Worker de Cloudflare (ADR-016): la API de la nube conectada a Neon por Hyperdrive. Un
// cliente de `pg` por petición, como pide Cloudflare (Hyperdrive mantiene el pool), y solo si la
// ruta necesita la base.

export interface Entorno {
  HYPERDRIVE: { connectionString: string }
  /** Secreto del Worker (`wrangler secret put TOKEN_ADMIN`). */
  TOKEN_ADMIN?: string
}

interface Contexto {
  waitUntil(promesa: Promise<unknown>): void
}

export default {
  async fetch(req: Request, entorno: Entorno, contexto: Contexto): Promise<Response> {
    let cliente: Client | null = null
    const sql = sqlPerezoso(async () => {
      cliente = new Client({ connectionString: entorno.HYPERDRIVE.connectionString })
      // Una caída de la conexión a mitad de la petición no debe quedar sin manejar.
      cliente.on('error', (e) => console.error('Conexión con la base perdida:', e.message))
      await cliente.connect()
      return sqlDePg(cliente)
    })
    try {
      return await atender(req, { sql, tokenAdmin: entorno.TOKEN_ADMIN })
    } finally {
      const opened = cliente as Client | null
      if (opened) contexto.waitUntil(opened.end().catch(() => {}))
    }
  },
}
