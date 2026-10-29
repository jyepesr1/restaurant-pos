import { Client } from 'pg'
import { handle, type RateLimiter } from './api'
import { lazySql, sqlFromPg } from './pg'

// The Cloudflare Worker (ADR-016): the cloud API connected to Neon through Hyperdrive. One `pg`
// client per request, as Cloudflare asks (Hyperdrive keeps the pool), and only if the route
// needs the database. The panel's files (apps/pos/dist-panel) are served by Workers Static Assets
// without running the Worker: it only runs for /v1/* (`run_worker_first` in wrangler.jsonc).

export interface Env {
  HYPERDRIVE: { connectionString: string }
  /** Worker secret (`wrangler secret put TOKEN_ADMIN`). */
  TOKEN_ADMIN?: string
  /** Rate Limiting binding for panel sign-ins (`ratelimits` in wrangler.jsonc); optional. */
  PANEL_LIMITER?: RateLimiter
  /** The panel's address if it is not the Worker's own (a Worker variable); optional. */
  PANEL_ORIGIN?: string
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

export default {
  async fetch(req: Request, environment: Env, context: ExecutionContext): Promise<Response> {
    let client: Client | null = null
    const sql = lazySql(async () => {
      client = new Client({ connectionString: environment.HYPERDRIVE.connectionString })
      // A connection drop midway through the request must not go unhandled.
      client.on('error', (e) => console.error('Conexión con la base perdida:', e.message))
      await client.connect()
      return sqlFromPg(client)
    })
    try {
      return await handle(req, {
        sql,
        adminToken: environment.TOKEN_ADMIN,
        limiter: environment.PANEL_LIMITER,
        panelOrigin: environment.PANEL_ORIGIN,
      })
    } finally {
      const opened = client as Client | null
      if (opened) context.waitUntil(opened.end().catch(() => {}))
    }
  },
}
