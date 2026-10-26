import { z } from 'zod'
import { MAX_EVENTOS_POR_LOTE, Nube, NuevoRestaurante, Registration, sha256 } from './nube'
import type { Sql } from './sql'

// La API HTTP de la nube (tarea 1.10, ADR-016), como un `fetch` estándar: la misma función corre
// en Cloudflare Workers y en las pruebas de Node. Todo va por HTTPS con un token en
// `Authorization: Bearer`: el del administrador de Faro para crear restaurantes y códigos, y la
// credencial de cada hub para subir sus eventos.

/** Un lote de 500 eventos cabe holgado; más que esto no es del POS. */
export const MAX_BYTES_CUERPO = 4 * 1024 * 1024

export interface EntornoApi {
  /** La base. En el Worker conecta recién en la primera consulta (`sqlPerezoso`). */
  sql: Sql
  /** El token del administrador de Faro (un secreto del Worker). Sin él, no hay rutas de administración. */
  tokenAdmin?: string
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
  const [schema, token] = (req.headers.get('authorization') ?? '').split(' ')
  return schema === 'Bearer' && token ? token : null
}

const MUY_GRANDE = Symbol('too_large')

/**
 * El cuerpo como JSON, leído sin pasar del límite aunque no traiga `content-length`. Devuelve
 * MUY_GRANDE si se pasa, o null si no es JSON.
 */
async function cuerpoJson(req: Request): Promise<unknown> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES_CUERPO) return MUY_GRANDE
  if (!req.body) return null
  const lector = req.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await lector.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES_CUERPO) {
      await lector.cancel().catch(() => {})
      return MUY_GRANDE
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

const muyGrande = () =>
  error(413, 'batch_too_large', 'El lote es demasiado grande: súbelo en lotes más pequeños')

/** Compara el token de administración por su huella: el tiempo no depende de cuánto coincide. */
async function esAdmin(req: Request, tokenAdmin: string | undefined) {
  const token = bearer(req)
  if (!tokenAdmin || !token) return false
  return (await sha256(token)) === (await sha256(tokenAdmin))
}

const Lote = z.strictObject({ events: z.array(z.unknown()).min(1).max(MAX_EVENTOS_POR_LOTE) })

export async function atender(req: Request, environment: EntornoApi): Promise<Response> {
  const nube = new Nube(environment.sql, environment.clock)
  const { pathname } = new URL(req.url)
  const route = `${req.method} ${pathname}`

  try {
    if (route === 'GET /v1/health') return json(200, { ok: true })

    // ── Administración de Faro ──
    if (pathname.startsWith('/v1/admin/')) {
      if (!(await esAdmin(req, environment.tokenAdmin)))
        return error(401, 'no_permission', 'Falta el token de administración')
      const body = await cuerpoJson(req)
      if (body === MUY_GRANDE) return muyGrande()
      if (route === 'POST /v1/admin/restaurants') {
        const data = NuevoRestaurante.safeParse(body)
        if (!data.success) return error(400, 'invalid_data', 'Falta el id o el nombre')
        const r = await nube.crearRestaurante(data.data)
        return json(r === 'created' ? 201 : 200, { status: r })
      }
      if (route === 'POST /v1/admin/codes') {
        const data = z.strictObject({ restaurant_id: z.string().length(26) }).safeParse(body)
        if (!data.success) return error(400, 'invalid_data', 'Falta el restaurante')
        const r = await nube.crearCodigo(data.data.restaurant_id)
        if (!r) return error(404, 'no_restaurant', 'Ese restaurante no existe')
        return json(201, { code: r.code, expires_at: r.expiresAt })
      }
      if (route === 'POST /v1/admin/hubs/revoke') {
        const data = z.strictObject({ hub_id: z.string().length(26) }).safeParse(body)
        if (!data.success) return error(400, 'invalid_data', 'Falta el hub')
        return (await nube.revocarHub(data.data.hub_id))
          ? new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
          : error(404, 'no_hub', 'Ese hub no existe o ya estaba revocado')
      }
      return error(404, 'not_found', 'Esa ruta no existe')
    }

    // ── Registro de un hub (con el código, sin credencial todavía) ──
    if (route === 'POST /v1/hubs/register') {
      const body = await cuerpoJson(req)
      if (body === MUY_GRANDE) return muyGrande()
      const data = Registration.safeParse(body)
      if (!data.success) return error(400, 'invalid_data', 'Datos con formato inesperado')
      const r = await nube.registrarHub(data.data)
      if (!r.ok)
        return r.reason === 'invalid_code'
          ? error(403, 'invalid_code', 'El código no existe, ya se usó o venció. Pide uno nuevo.')
          : error(409, 'hub_already_registered', 'Este PC de caja ya está registrado')
      return json(201, { credential: r.credential, restaurant_id: r.restaurantId })
    }

    // ── Lo que hace un hub registrado ──
    const credential = bearer(req)
    const hub = credential ? await nube.authenticate(credential) : null
    if (route === 'POST /v1/events' || route === 'GET /v1/events/last') {
      if (!hub)
        return error(401, 'invalid_credential', 'Este PC de caja no está registrado o fue revocado')
      if (route === 'GET /v1/events/last')
        return json(200, { last_sequence: await nube.lastSequence(hub) })
      const body = await cuerpoJson(req)
      if (body === MUY_GRANDE) return muyGrande()
      const batch = Lote.safeParse(body)
      if (!batch.success)
        return error(400, 'invalid_data', `Un lote trae de 1 a ${MAX_EVENTOS_POR_LOTE} eventos`)
      const results = await nube.recibirEventos(hub, batch.data.events)
      return json(200, { results, last_sequence: await nube.lastSequence(hub) })
    }

    return error(404, 'not_found', 'Esa ruta no existe')
  } catch (e) {
    // Un error interno no se muestra al hub, y al registro solo va lo justo: el detalle de un
    // error de Postgres puede traer valores de la fila (datos del restaurante).
    const { code, constraint, message } = (e ?? {}) as Record<string, unknown>
    console.error('Error en la API de la nube:', { route, code, constraint, message })
    return error(500, 'internal_error', 'La nube tuvo un problema. Se reintentará.')
  }
}
