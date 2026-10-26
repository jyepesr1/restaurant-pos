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

interface ToastContext {
  waitUntil(promise: Promise<unknown>): void
}

export default {
  async fetch(req: Request, environment: Entorno, context: ToastContext): Promise<Response> {
    let client: Client | null = null
    const sql = sqlPerezoso(async () => {
      client = new Client({ connectionString: environment.HYPERDRIVE.connectionString })
      // Una caída de la conexión a mitad de la petición no debe quedar sin manejar.
      client.on('error', (e) => console.error('Conexión con la base perdida:', e.message))
      await client.connect()
      return sqlDePg(client)
    })
    try {
      return await atender(req, { sql, tokenAdmin: environment.TOKEN_ADMIN })
    } finally {
      const opened = client as Client | null
      if (opened) context.waitUntil(opened.end().catch(() => {}))
    }
  },
}
