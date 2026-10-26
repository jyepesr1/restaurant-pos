import { z } from 'zod'
import { MAX_EVENTOS_POR_LOTE, Nube, NuevoRestaurante, Registro, sha256 } from './nube'
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
  reloj?: () => Date
}

const json = (estado: number, cuerpo: unknown) =>
  new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
const error = (estado: number, codigo: string, mensaje: string) =>
  json(estado, { error: codigo, mensaje })

const bearer = (req: Request) => {
  const [esquema, token] = (req.headers.get('authorization') ?? '').split(' ')
  return esquema === 'Bearer' && token ? token : null
}

const MUY_GRANDE = Symbol('muy_grande')

/**
 * El cuerpo como JSON, leído sin pasar del límite aunque no traiga `content-length`. Devuelve
 * MUY_GRANDE si se pasa, o null si no es JSON.
 */
async function cuerpoJson(req: Request): Promise<unknown> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES_CUERPO) return MUY_GRANDE
  if (!req.body) return null
  const lector = req.body.getReader()
  const partes: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await lector.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES_CUERPO) {
      await lector.cancel().catch(() => {})
      return MUY_GRANDE
    }
    partes.push(value)
  }
  const bytes = new Uint8Array(total)
  let pos = 0
  for (const p of partes) {
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
  error(413, 'lote_grande', 'El lote es demasiado grande: súbelo en lotes más pequeños')

/** Compara el token de administración por su huella: el tiempo no depende de cuánto coincide. */
async function esAdmin(req: Request, tokenAdmin: string | undefined) {
  const token = bearer(req)
  if (!tokenAdmin || !token) return false
  return (await sha256(token)) === (await sha256(tokenAdmin))
}

const Lote = z.strictObject({ eventos: z.array(z.unknown()).min(1).max(MAX_EVENTOS_POR_LOTE) })

export async function atender(req: Request, entorno: EntornoApi): Promise<Response> {
  const nube = new Nube(entorno.sql, entorno.reloj)
  const { pathname } = new URL(req.url)
  const ruta = `${req.method} ${pathname}`

  try {
    if (ruta === 'GET /v1/salud') return json(200, { ok: true })

    // ── Administración de Faro ──
    if (pathname.startsWith('/v1/admin/')) {
      if (!(await esAdmin(req, entorno.tokenAdmin)))
        return error(401, 'sin_permiso', 'Falta el token de administración')
      const cuerpo = await cuerpoJson(req)
      if (cuerpo === MUY_GRANDE) return muyGrande()
      if (ruta === 'POST /v1/admin/restaurantes') {
        const datos = NuevoRestaurante.safeParse(cuerpo)
        if (!datos.success) return error(400, 'datos_invalidos', 'Falta el id o el nombre')
        const r = await nube.crearRestaurante(datos.data)
        return json(r === 'creado' ? 201 : 200, { estado: r })
      }
      if (ruta === 'POST /v1/admin/codigos') {
        const datos = z.strictObject({ restaurante_id: z.string().length(26) }).safeParse(cuerpo)
        if (!datos.success) return error(400, 'datos_invalidos', 'Falta el restaurante')
        const r = await nube.crearCodigo(datos.data.restaurante_id)
        if (!r) return error(404, 'sin_restaurante', 'Ese restaurante no existe')
        return json(201, { codigo: r.codigo, vence_en: r.venceEn })
      }
      if (ruta === 'POST /v1/admin/hubs/revocar') {
        const datos = z.strictObject({ hub_id: z.string().length(26) }).safeParse(cuerpo)
        if (!datos.success) return error(400, 'datos_invalidos', 'Falta el hub')
        return (await nube.revocarHub(datos.data.hub_id))
          ? new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
          : error(404, 'sin_hub', 'Ese hub no existe o ya estaba revocado')
      }
      return error(404, 'no_existe', 'Esa ruta no existe')
    }

    // ── Registro de un hub (con el código, sin credencial todavía) ──
    if (ruta === 'POST /v1/hubs/registro') {
      const cuerpo = await cuerpoJson(req)
      if (cuerpo === MUY_GRANDE) return muyGrande()
      const datos = Registro.safeParse(cuerpo)
      if (!datos.success) return error(400, 'datos_invalidos', 'Datos con formato inesperado')
      const r = await nube.registrarHub(datos.data)
      if (!r.ok)
        return r.motivo === 'codigo_invalido'
          ? error(
              403,
              'codigo_invalido',
              'El código no existe, ya se usó o venció. Pide uno nuevo.',
            )
          : error(409, 'hub_ya_registrado', 'Este PC de caja ya está registrado')
      return json(201, { credencial: r.credencial, restaurante_id: r.restauranteId })
    }

    // ── Lo que hace un hub registrado ──
    const credencial = bearer(req)
    const hub = credencial ? await nube.autenticar(credencial) : null
    if (ruta === 'POST /v1/eventos' || ruta === 'GET /v1/eventos/ultima') {
      if (!hub)
        return error(
          401,
          'credencial_invalida',
          'Este PC de caja no está registrado o fue revocado',
        )
      if (ruta === 'GET /v1/eventos/ultima')
        return json(200, { ultima_secuencia: await nube.ultimaSecuencia(hub) })
      const cuerpo = await cuerpoJson(req)
      if (cuerpo === MUY_GRANDE) return muyGrande()
      const lote = Lote.safeParse(cuerpo)
      if (!lote.success)
        return error(400, 'datos_invalidos', `Un lote trae de 1 a ${MAX_EVENTOS_POR_LOTE} eventos`)
      const resultados = await nube.recibirEventos(hub, lote.data.eventos)
      return json(200, { resultados, ultima_secuencia: await nube.ultimaSecuencia(hub) })
    }

    return error(404, 'no_existe', 'Esa ruta no existe')
  } catch (e) {
    // Un error interno no se muestra al hub, y al registro solo va lo justo: el detalle de un
    // error de Postgres puede traer valores de la fila (datos del restaurante).
    const { code, constraint, message } = (e ?? {}) as Record<string, unknown>
    console.error('Error en la API de la nube:', { ruta, code, constraint, message })
    return error(500, 'error_interno', 'La nube tuvo un problema. Se reintentará.')
  }
}
