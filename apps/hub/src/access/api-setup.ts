import type { FastifyInstance } from 'fastify'
import { createAppServer } from '../server'
import { type AccessSetup, setupAccess } from './setup'

// Test utilities: the access setup with the Fastify server on top, to test the API
// (`/api/sign-in`, `/api/staff/*`) with any IP, token and body. For tests only.

export interface ApiResponse {
  statusCode: number
  headers: Record<string, unknown>
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON response
  json: () => any
  body: string
}

export type Session = { session_id: string; secret: string }

export interface Api extends AccessSetup {
  app: FastifyInstance
  catalogChanges: number[]
  post: (url: string, body: unknown, options?: PostOptions) => Promise<ApiResponse>
  /** Signs in with username and password and returns what is needed to call the staff API. */
  signInAdmin: (
    who?: 'admin' | 'cashier',
    // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON response
  ) => Promise<{ token: string; session: Session; body: any }>
  /** Body for `/api/staff/*` with the session included. */
  withSession: (s: Session, extra: object) => object
  /** Username and password of the default admin. */
  admin: () => { user: string; password: string }
}

export interface PostOptions {
  token?: string
  ip?: string
  headers?: Record<string, string>
}

export function setupApi(m: AccessSetup = setupAccess()): Api {
  const catalogChanges: number[] = []
  const app = createAppServer({
    access: m.access,
    catalog: {
      db: m.db,
      restaurantId: m.restaurantId,
      access: m.access,
      clock: m.clock,
      onChange: (v) => catalogChanges.push(v),
    },
  })
  const post: Api['post'] = (url, body, { token, ip = '10.0.0.20', headers = {} } = {}) =>
    app.inject({
      method: 'POST',
      url,
      payload: body as object,
      remoteAddress: ip,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    }) as unknown as Promise<ApiResponse>
  const signInAdmin: Api['signInAdmin'] = async (who = 'admin') => {
    const p = m.people[who]
    const r = await post('/api/sign-in', { user: p.user, password: p.password })
    if (r.statusCode !== 201) throw new Error(`Sign-in failed: ${r.body}`)
    const body = r.json()
    return {
      token: body.device.token,
      session: { session_id: body.session_id, secret: body.secret },
      body,
    }
  }
  return {
    ...m,
    app,
    catalogChanges,
    post,
    signInAdmin,
    withSession: (s, extra) => ({ ...s, ...extra }),
    admin: () => ({
      user: m.people.admin.user as string,
      password: m.people.admin.password as string,
    }),
  }
}
