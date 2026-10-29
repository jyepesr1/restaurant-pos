import { z } from 'zod'
import { Cloud, MAX_EVENTS_PER_BATCH, NewRestaurant, Registration, sha256 } from './cloud'
import type { Sql } from './sql'

// The cloud HTTP API (task 1.10, ADR-016), as a standard `fetch`: the same function runs on
// Cloudflare Workers and in the Node tests. Everything goes over HTTPS with a token in
// `Authorization: Bearer`: the Faro admin's to create restaurants and codes, and each hub's
// credential to upload its events.

/** A batch of 500 events fits easily; anything bigger does not come from the POS. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface ApiEnv {
  /** The database. In the Worker it connects only on the first query (`lazySql`). */
  sql: Sql
  /** The Faro admin token (a Worker secret). Without it, there are no admin routes. */
  adminToken?: string
  clock?: () => Date
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
const error = (status: number, code: string, message: string) =>
  json(status, { error: code, message })

const bearer = (req: Request) => {
  const [scheme, token] = (req.headers.get('authorization') ?? '').split(' ')
  return scheme === 'Bearer' && token ? token : null
}

const TOO_LARGE = Symbol('too_large')

/**
 * The body as JSON, read without going over the limit even without `content-length`. Returns
 * TOO_LARGE if it goes over, or null if it is not JSON.
 */
async function jsonBody(req: Request): Promise<unknown> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return TOO_LARGE
  if (!req.body) return null
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
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
  const cloud = new Cloud(environment.sql, environment.clock)
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
        return json(r === 'created' ? 201 : 200, { status: r })
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
          ? new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
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

    // ── What a registered hub does ──
    const credential = bearer(req)
    const hub = credential ? await cloud.authenticate(credential) : null
    if (route === 'POST /v1/events' || route === 'GET /v1/events/last') {
      if (!hub)
        return error(401, 'invalid_credential', 'Este PC de caja no está registrado o fue revocado')
      if (route === 'GET /v1/events/last')
        return json(200, { last_sequence: await cloud.lastSequence(hub) })
      const body = await jsonBody(req)
      if (body === TOO_LARGE) return tooLarge()
      const batch = Batch.safeParse(body)
      if (!batch.success)
        return error(400, 'invalid_data', `Un lote trae de 1 a ${MAX_EVENTS_PER_BATCH} eventos`)
      const results = await cloud.receiveEvents(hub, batch.data.events)
      return json(200, { results, last_sequence: await cloud.lastSequence(hub) })
    }

    return error(404, 'not_found', 'Esa ruta no existe')
  } catch (e) {
    // An internal error is not shown to the hub, and only the bare minimum goes to the log: the
    // detail of a Postgres error may carry row values (restaurant data).
    const { code, constraint, message } = (e ?? {}) as Record<string, unknown>
    console.error('Error en la API de la nube:', { route, code, constraint, message })
    return error(500, 'internal_error', 'La nube tuvo un problema. Se reintentará.')
  }
}
