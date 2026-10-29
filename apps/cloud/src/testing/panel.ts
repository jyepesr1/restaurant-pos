import { randomBytes, scryptSync } from 'node:crypto'
import { newId } from '@pos/core'
import { fingerprint } from '@pos/sync'
import { type ApiEnv, handle } from '../api'
import type { TestHub, World } from './world'

// Helpers for the panel tests: verifiers in the hub's format, snapshots uploaded as the hub does
// and requests with the panel's cookie and origin.

export const PANEL_ORIGIN = 'https://cloud.faro.test'

/** A verifier like the hub's (`scrypt$cost$r$p$salt$hash`); a low cost so the tests are quick. */
export function verifierFor(password: string, cost = 4): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password.normalize('NFC'), salt, 32, {
    N: 2 ** cost,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
  return ['scrypt', cost, 8, 1, salt.toString('base64url'), hash.toString('base64url')].join('$')
}

export interface RemoteUser {
  user_id: string
  username: string
  name: string
  verifier: string
  permissions: string[]
}

export const remoteUser = (
  username: string,
  password: string,
  permissions = ['remote_access', 'view_reports'],
  name = username,
): RemoteUser => ({
  user_id: newId(),
  username,
  name,
  verifier: verifierFor(password),
  permissions,
})

/** Uploads a snapshot as the hub does; returns the response status. */
export async function putSnapshot(m: World, hub: TestHub, kind: string, content: unknown) {
  const r = await m.request(
    'PUT',
    `/v1/snapshots/${kind}`,
    { fingerprint: fingerprint(content), content },
    hub.credential,
  )
  return r.status
}

/** The restaurant's slug, as created by `newHub`. */
export async function slugOf(m: World, restaurantId: string): Promise<string> {
  const r = await m.db.query<{ slug: string }>('SELECT slug FROM restaurants WHERE id = $1', [
    restaurantId,
  ])
  return r.rows[0]?.slug ?? ''
}

export interface PanelRequest {
  body?: unknown
  cookie?: string | null
  origin?: string | null
  ip?: string
  headers?: Record<string, string>
}

/** A request to the panel, from its own page unless the test says otherwise. */
export function panelRequest(
  m: World,
  method: string,
  route: string,
  o: PanelRequest = {},
  environment: Partial<ApiEnv> = {},
): Promise<Response> {
  const origin = o.origin === undefined ? PANEL_ORIGIN : o.origin
  return handle(
    new Request(`${PANEL_ORIGIN}${route}`, {
      method,
      headers: {
        ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(origin !== null ? { origin } : {}),
        ...(o.cookie ? { cookie: `__Host-faro_panel=${o.cookie}` } : {}),
        ...(o.ip ? { 'cf-connecting-ip': o.ip } : {}),
        ...o.headers,
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    }),
    { sql: m.sql, clock: () => m.clock.now, ...environment },
  )
}

/** The session cookie's value from a `set-cookie`, or null. */
export function cookieFrom(r: Response): string | null {
  const header = r.headers.get('set-cookie') ?? ''
  const m = /__Host-faro_panel=([^;]*)/.exec(header)
  return m?.[1] ? m[1] : null
}
