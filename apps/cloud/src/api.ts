import { z } from 'zod'
import {
  type AuthenticatedHub,
  Cloud,
  hubMaxOf,
  MAX_EVENTS_PER_BATCH,
  NewRestaurant,
  Registration,
  sha256,
} from './cloud'
import {
  EXPIRES_HEADER,
  type LiveReason,
  type LiveRooms,
  roomOf,
  SESSION_HEADER,
} from './live-protocol'
import {
  COOKIE_NAME,
  Panel,
  type PanelSession,
  REMOTE_ACCESS,
  SESSION_MS,
  VIEW_REPORTS,
} from './panel'
import { normalizeUsername } from './password'
import { isSnapshotKind, MAX_SNAPSHOT_BYTES, saveSnapshot } from './snapshots'
import type { Sql } from './sql'

// The cloud HTTP API (task 1.10, ADR-016), as a standard `fetch`: the same function runs on
// Cloudflare Workers and in the Node tests. Everything goes over HTTPS with a token in
// `Authorization: Bearer`: the Faro admin's to create restaurants and codes, and each hub's
// credential to upload its events.

/** A batch of 500 events fits easily; anything bigger does not come from the POS. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc). Optional. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface ApiEnv {
  /** The database. In the Worker it connects only on the first query (`lazySql`). */
  sql: Sql
  /** The Faro admin token (a Worker secret). Without it, there are no admin routes. */
  adminToken?: string
  clock?: () => Date
  /** First, cheap barrier on panel sign-ins (per IP and per restaurant:user). */
  limiter?: RateLimiter
  /** The panel's address, for the `Origin` check. By default, the request's own origin. */
  panelOrigin?: string
  /**
   * The live panel's Durable Objects (worker.ts). Without them there is no `GET /v1/panel/live`
   * and nobody is told; the panels still poll.
   */
  live?: LiveRooms
  /** Keeps a promise going after the response (the Worker's `ctx.waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void
}

/** A location that said nothing for longer than this is «back» on its next call (as the panel's NO_NEWS_MS). */
export const BACK_ONLINE_AFTER_MS = 2 * 60_000

/**
 * Tells the room's panels, after the response and without holding it: a failed notice is only
 * logged (the panels poll anyway; the truth is in Postgres).
 */
function tellLive(
  environment: ApiEnv,
  what: string,
  call: (live: LiveRooms) => Promise<unknown>,
): void {
  const live = environment.live
  if (!live) return
  const sent = Promise.resolve()
    .then(() => call(live))
    .catch((e) => {
      const { message } = (e ?? {}) as Record<string, unknown>
      console.error('Could not tell the live panel:', { what, message })
    })
  environment.waitUntil?.(sent)
}

const notify = (environment: ApiEnv, hub: AuthenticatedHub, reason: LiveReason) =>
  tellLive(environment, reason, (live) =>
    live.notify(roomOf(hub.restaurantId, hub.locationId), reason),
  )

/**
 * On every response of the Worker: Static Assets' `_headers` does not apply to what the Worker
 * generates (docs/integraciones/panel-cloudflare.md, section 5).
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
const error = (status: number, code: string, message: string, headers?: Record<string, string>) =>
  json(status, { error: code, message }, headers)
const noContent = (headers: Record<string, string> = {}) =>
  new Response(null, { status: 204, headers })

function withSecurityHeaders(r: Response): Response {
  const headers = new Headers(r.headers)
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v)
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers })
}

const bearer = (req: Request) => {
  const [scheme, token] = (req.headers.get('authorization') ?? '').split(' ')
  return scheme === 'Bearer' && token ? token : null
}

const TOO_LARGE = Symbol('too_large')

/**
 * The body as JSON, read without going over the limit even without `content-length`. Returns
 * TOO_LARGE if it goes over, or null if it is not JSON.
 */
async function jsonBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  if (Number(req.headers.get('content-length') ?? 0) > maxBytes) return TOO_LARGE
  if (!req.body) return null
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return TOO_LARGE
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(total)
  let pos = 0
  for (const p of parts) {
    bytes.set(p, pos)
    pos += p.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

const tooLarge = () =>
  error(413, 'batch_too_large', 'El lote es demasiado grande: súbelo en lotes más pequeños')

/** Compares the admin token by its fingerprint: the time does not depend on how much matches. */
async function isAdmin(req: Request, adminToken: string | undefined) {
  const token = bearer(req)
  if (!adminToken || !token) return false
  return (await sha256(token)) === (await sha256(adminToken))
}

const Batch = z.strictObject({ events: z.array(z.unknown()).min(1).max(MAX_EVENTS_PER_BATCH) })

export async function handle(req: Request, environment: ApiEnv): Promise<Response> {
  const r = await respond(req, environment)
  // The live panel's 101 carries the WebSocket: a new Response would lose it (and with status 101
  // it fails). It goes back exactly as the Durable Object gave it.
  return r.status === 101 ? r : withSecurityHeaders(r)
}

async function respond(req: Request, environment: ApiEnv): Promise<Response> {
  const cloud = new Cloud(environment.sql, environment.clock)
  const clock = environment.clock ?? (() => new Date())
  const { pathname } = new URL(req.url)
  const route = `${req.method} ${pathname}`

  try {
    if (route === 'GET /v1/health') return json(200, { ok: true })

    // ── Faro administration ──
    if (pathname.startsWith('/v1/admin/')) {
      if (!(await isAdmin(req, environment.adminToken)))
        return error(401, 'no_permission', 'Falta el token de administración')
      const body = await jsonBody(req)
      if (body === TOO_LARGE) return tooLarge()
      if (route === 'POST /v1/admin/restaurants') {
        const data = NewRestaurant.safeParse(body)
        if (!data.success) return error(400, 'invalid_data', 'Falta el id o el nombre')
        const r = await cloud.createRestaurant(data.data)
        if (r.status === 'slug_taken')
          return error(409, 'slug_taken', 'Ese nombre corto ya es de otro restaurante')
        return json(r.status === 'created' ? 201 : 200, r)
      }
      if (route === 'POST /v1/admin/codes') {
        const data = z.strictObject({ restaurant_id: z.string().length(26) }).safeParse(body)
        if (!data.success) return error(400, 'invalid_data', 'Falta el restaurante')
        const r = await cloud.createCode(data.data.restaurant_id)
        if (!r) return error(404, 'no_restaurant', 'Ese restaurante no existe')
        return json(201, { code: r.code, expires_at: r.expiresAt })
      }
      if (route === 'POST /v1/admin/hubs/revoke') {
        const data = z.strictObject({ hub_id: z.string().length(26) }).safeParse(body)
        if (!data.success) return error(400, 'invalid_data', 'Falta el hub')
        return (await cloud.revokeHub(data.data.hub_id))
          ? noContent()
          : error(404, 'no_hub', 'Ese hub no existe o ya estaba revocado')
      }
      return error(404, 'not_found', 'Esa ruta no existe')
    }

    // ── Registering a hub (with the code, no credential yet) ──
    if (route === 'POST /v1/hubs/register') {
      const body = await jsonBody(req)
      if (body === TOO_LARGE) return tooLarge()
      const data = Registration.safeParse(body)
      if (!data.success) return error(400, 'invalid_data', 'Datos con formato inesperado')
      const r = await cloud.registerHub(data.data)
      if (!r.ok) {
        if (r.reason === 'invalid_code')
          return error(
            403,
            'invalid_code',
            'El código no existe, ya se usó o venció. Pide uno nuevo.',
          )
        if (r.reason === 'other_restaurant')
          return error(
            403,
            'other_restaurant',
            'Ese código es de otro restaurante. Pide uno para este restaurante.',
          )
        return error(409, 'hub_already_registered', 'Este PC de caja ya está registrado')
      }
      return json(201, { credential: r.credential, restaurant_id: r.restaurantId })
    }

    // ── The owner's panel (session cookie) ──
    if (pathname.startsWith('/v1/panel/')) return await panelRoute(req, route, environment)

    // ── What a registered hub does ──
    const snapshotKind = /^PUT \/v1\/snapshots\/([a-z_]{1,30})$/.exec(route)?.[1]
    if (route === 'POST /v1/events' || route === 'GET /v1/events/last' || snapshotKind) {
      const credential = bearer(req)
      const hub = credential ? await cloud.authenticate(credential) : null
      if (!hub)
        return error(401, 'invalid_credential', 'Este PC de caja no está registrado o fue revocado')
      if (snapshotKind !== undefined) {
        if (!isSnapshotKind(snapshotKind))
          return error(400, 'invalid_data', 'Ese tipo de instantánea no existe')
        const body = await jsonBody(req, MAX_SNAPSHOT_BYTES)
        if (body === TOO_LARGE) return error(413, 'too_large', 'La instantánea pasa de 2 MB')
        const r = await saveSnapshot(environment.sql, hub, snapshotKind, body, clock())
        if (typeof r === 'object') return error(400, 'invalid_data', r.invalid)
        if (r === 'revoked')
          return error(
            401,
            'invalid_credential',
            'Este PC de caja no está registrado o fue revocado',
          )
        if (r === 'saved') notify(environment, hub, 'snapshot')
        return noContent()
      }
      // Any call from the hub is a heartbeat; `x-faro-hub-max` says how far it has. It is never
      // what makes uploading fail.
      const previous = await cloud
        .heartbeat(hub, hubMaxOf(req.headers.get('x-faro-hub-max')))
        .catch((e) => {
          const { code, message } = (e ?? {}) as Record<string, unknown>
          console.error('Could not record the hub heartbeat:', { code, message })
          return undefined
        })
      // Back after a silence (or its first call ever): the panels stop saying «Sin noticias». A
      // hub that is no longer there (revoked meanwhile) or a heartbeat that failed tells nobody.
      const seen = previous?.previous
      const backOnline =
        previous !== null &&
        previous !== undefined &&
        (seen === null ||
          (seen instanceof Date && clock().getTime() - seen.getTime() > BACK_ONLINE_AFTER_MS))
      if (route === 'GET /v1/events/last') {
        const answer = json(200, { last_sequence: await cloud.lastSequence(hub) })
        if (backOnline) notify(environment, hub, 'back_online')
        return answer
      }
      const body = await jsonBody(req)
      if (body === TOO_LARGE) return tooLarge()
      const batch = Batch.safeParse(body)
      if (!batch.success)
        return error(400, 'invalid_data', `Un lote trae de 1 a ${MAX_EVENTS_PER_BATCH} eventos`)
      const results = await cloud.receiveEvents(hub, batch.data.events)
      const answer = json(200, { results, last_sequence: await cloud.lastSequence(hub) })
      // Only after the commit, and only if something new was stored: one notice per batch.
      if (results.some((r) => r.status === 'saved')) notify(environment, hub, 'events')
      else if (backOnline) notify(environment, hub, 'back_online')
      return answer
    }

    return error(404, 'not_found', 'Esa ruta no existe')
  } catch (e) {
    // An internal error is not shown to the hub, and only the bare minimum goes to the log: the
    // detail of a Postgres error may carry row values (restaurant data).
    const { code, constraint, message } = (e ?? {}) as Record<string, unknown>
    console.error('Cloud API error:', { route, code, constraint, message })
    return error(500, 'internal_error', 'La nube tuvo un problema. Se reintentará.')
  }
}

// ── Panel ──────────────────────────────────────────────────────────────

const SignIn = z.strictObject({
  restaurant: z.string().min(1).max(80),
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
})

const sessionCookie = (value: string, maxAgeSeconds: number) =>
  `${COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`
const CLEAR_COOKIE = { 'set-cookie': sessionCookie('', 0) }

/** The panel cookie's value, if the request brings one. */
function cookieOf(req: Request): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === COOKIE_NAME) return value.join('=')
  }
  return null
}

/** The same for everything: it does not say which of the three was wrong. */
const INVALID_CREDENTIALS = 'Revisa el restaurante, el usuario y la contraseña.'
const waitResponse = (waitMs: number) =>
  error(
    429,
    'wait',
    `Demasiados intentos. Espera ${Math.ceil(waitMs / 1000)} segundos y vuelve a intentar.`,
    { 'retry-after': String(Math.ceil(waitMs / 1000)) },
  )

/**
 * The panel's routes with a session, and the permission each one asks for besides the session
 * (which already requires `remote_access`). docs/PANEL.md#quién-entra.
 */
const PANEL_ROUTES = {
  'GET /v1/panel/me': null,
  'GET /v1/panel/summary': VIEW_REPORTS,
  'GET /v1/panel/reports': VIEW_REPORTS,
  'GET /v1/panel/floor': REMOTE_ACCESS,
  'GET /v1/panel/register': VIEW_REPORTS,
  'GET /v1/panel/alerts': VIEW_REPORTS,
  'GET /v1/panel/live': REMOTE_ACCESS,
} as const satisfies Record<string, string | null>
type PanelRoute = keyof typeof PANEL_ROUTES

const NO_PERMISSION: Record<NonNullable<(typeof PANEL_ROUTES)[PanelRoute]>, string> = {
  [VIEW_REPORTS]: 'No tienes permiso para ver los reportes',
  [REMOTE_ACCESS]: 'No tienes permiso para entrar desde fuera del local',
}

async function panelRoute(req: Request, route: string, environment: ApiEnv): Promise<Response> {
  const panel = new Panel(environment.sql, environment.clock, {
    // A session revoked while being checked: its open sockets close too (review 1.11c-2, point 8).
    onSessionRevoked: ({ sessionId, rooms }) =>
      tellLive(environment, 'revoked', (live) =>
        Promise.all(rooms.map((room) => live.closeSession(room, sessionId))),
      ),
  })
  const url = new URL(req.url)

  if (req.method === 'POST') {
    // Everything that changes something comes from the panel's own page (CSRF, OWASP): `Origin`
    // missing, `null` or from another site is refused.
    const origin = req.headers.get('origin')
    if (!origin || origin !== (environment.panelOrigin ?? url.origin))
      return error(403, 'invalid_origin', 'Esta acción solo se puede hacer desde el panel')
  }

  if (route === 'POST /v1/panel/sign-in') {
    if (!(req.headers.get('content-type') ?? '').startsWith('application/json'))
      return error(400, 'invalid_data', 'Datos con formato inesperado')
    const body = await jsonBody(req, 4 * 1024)
    if (body === TOO_LARGE) return tooLarge()
    const data = SignIn.safeParse(body)
    if (!data.success)
      return error(400, 'invalid_data', 'Faltan el restaurante, el usuario o la contraseña')
    const ip = req.headers.get('cf-connecting-ip')
    if (environment.limiter) {
      const keys = [
        ...(ip ? [`ip:${ip}`] : []),
        // Normalized as in panel_attempts: «ANA» and «ana» are the same user.
        `user:${data.data.restaurant.trim().toLowerCase()}:${normalizeUsername(data.data.username) ?? data.data.username.trim().toLowerCase().slice(0, 100)}`,
      ]
      for (const key of keys)
        if (!(await environment.limiter.limit({ key })).success) return waitResponse(60_000)
    }
    const r = await panel.signIn({ ...data.data, ip })
    if (r.ok) return json(200, r.me, { 'set-cookie': sessionCookie(r.cookie, SESSION_MS / 1000) })
    if (r.reason === 'wait') return waitResponse(r.waitMs)
    return json(
      401,
      {
        error: 'invalid_credentials',
        message: INVALID_CREDENTIALS,
        ...(r.waitMs > 0 ? { wait_ms: r.waitMs } : {}),
      },
      r.waitMs > 0 ? { 'retry-after': String(Math.ceil(r.waitMs / 1000)) } : {},
    )
  }

  if (route === 'POST /v1/panel/sign-out') {
    const ended = await panel.signOut(cookieOf(req))
    // Its open live sockets close too (the others of the person stay).
    if (ended)
      tellLive(environment, 'sign-out', (live) =>
        live.closeSession(roomOf(ended.restaurant.id, ended.locationId), ended.sessionId),
      )
    return noContent(CLEAR_COOKIE)
  }

  if (route === 'GET /v1/panel/live') return await liveRoute(req, panel, environment)

  if (!Object.hasOwn(PANEL_ROUTES, route)) return error(404, 'not_found', 'Esa ruta no existe')
  const needs = PANEL_ROUTES[route as PanelRoute]

  const cookie = cookieOf(req)
  const session: PanelSession | null = await panel.session(cookie)
  if (!session)
    return error(
      401,
      'no_session',
      'Tu sesión terminó. Vuelve a entrar.',
      cookie === null ? {} : CLEAR_COOKIE,
    )
  if (needs && !session.user.permissions.includes(needs))
    return error(403, 'no_permission', NO_PERMISSION[needs])
  if (route === 'GET /v1/panel/me') return json(200, await panel.me(session))
  if (route === 'GET /v1/panel/summary') return json(200, await panel.summary(session))
  const param = (name: string) => url.searchParams.get(name) || undefined
  if (route === 'GET /v1/panel/floor') {
    // The version of the plan the panel already has: if it is the current one, it does not travel.
    const plan = param('plan')
    return json(200, await panel.floor(session, plan && plan.length <= 128 ? plan : null))
  }
  if (route === 'GET /v1/panel/register') return json(200, await panel.register(session))
  if (route === 'GET /v1/panel/alerts') {
    const r = await panel.alerts(session, param('day'))
    if ('error' in r) return error(400, 'invalid_data', r.error)
    return json(200, r)
  }

  const r = await panel.report(session, param('from'), param('until'))
  if ('error' in r) return error(400, 'invalid_data', r.error)
  return json(200, r)
}

/**
 * `GET /v1/panel/live`: the panel's WebSocket (docs/PANEL.md#aviso-en-vivo-websocket). Everything is checked here,
 * before touching the Durable Object: the upgrade, the `Origin` (a page from another site can open
 * a WebSocket with the cookie: CSWSH, OWASP), the session and its permission. The room comes from
 * the session, never from the address.
 */
async function liveRoute(req: Request, panel: Panel, environment: ApiEnv): Promise<Response> {
  const url = new URL(req.url)
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
    return error(426, 'websocket_expected', 'Esta dirección es solo para el panel en vivo', {
      upgrade: 'websocket',
    })
  const origin = req.headers.get('origin')
  if (!origin || origin !== (environment.panelOrigin ?? url.origin))
    return error(403, 'invalid_origin', 'El panel en vivo solo se abre desde el panel')
  const cookie = cookieOf(req)
  const session = await panel.session(cookie)
  if (!session)
    return error(
      401,
      'no_session',
      'Tu sesión terminó. Vuelve a entrar.',
      cookie === null ? {} : CLEAR_COOKIE,
    )
  const needs = PANEL_ROUTES['GET /v1/panel/live']
  if (!session.user.permissions.includes(needs))
    return error(403, 'no_permission', NO_PERMISSION[needs])
  if (!environment.live)
    return error(503, 'no_live', 'El panel en vivo no está disponible; se actualiza solo.')
  // What the Durable Object receives: the browser's handshake without its cookie and without any
  // `x-faro-*` it made up, plus the session the Worker checked.
  const headers = new Headers()
  req.headers.forEach((value, name) => {
    if (!name.startsWith('x-faro-') && name !== 'cookie') headers.set(name, value)
  })
  headers.set(SESSION_HEADER, session.sessionId)
  headers.set(EXPIRES_HEADER, session.expiresAt)
  return environment.live.connect(
    roomOf(session.restaurant.id, session.locationId),
    new Request(`${url.origin}/v1/panel/live`, { method: 'GET', headers }),
  )
}
