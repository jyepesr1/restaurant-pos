import { huellaEvento } from '@pos/sync'
import { z } from 'zod'
import type { Sql } from './sql'

// La lógica de la nube (tarea 1.10, ADR-016): restaurantes, registro de hubs con un código de un
// solo uso y recepción de los eventos que sube cada hub, sin duplicar. No sabe de HTTP (eso es
// `api.ts`) ni de con qué se conecta a Postgres (`sql.ts`).

/** Cuántos eventos caben en un lote. El hub sube de a varios para ponerse al día rápido. */
export const MAX_EVENTOS_POR_LOTE = 500
/** Un evento más grande que esto no es un evento del POS (el hub limita lo que acepta). */
export const MAX_BYTES_EVENTO = 64 * 1024
/** Cuánto dura un código de registro. */
export const VIGENCIA_CODIGO_MS = 24 * 60 * 60 * 1000

const anioValido = (t: string) => {
  const anio = Number(t.slice(0, 4))
  return anio >= 2000 && anio <= 2999
}
/** «Z» o un desfase de hasta 14 horas (el mayor que existe). */
const desfaseValido = (t: string) => {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(t)
  return !m || Number(m[2]) * 60 + Number(m[3]) <= 14 * 60
}

const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)

/**
 * Lo mínimo que la nube exige de un evento: el sobre con lo que puso el hub. Los datos no se
 * revisan aquí: el hub ya lo aceptó, y la nube no rechaza lo que el hub aceptó (ADR-016).
 */
const EventoSubido = z.looseObject({
  id: Ulid,
  type: z.string().min(1).max(60),
  aggregate_type: z.string().min(1).max(30),
  aggregate_id: Ulid,
  sequence: z.int().min(1),
  // Fechas razonables para un POS: Postgres no acepta el año 0 ni desfases de horas imposibles.
  received_at: z.iso.datetime({ offset: true }).refine((t) => anioValido(t) && desfaseValido(t)),
  business_day: z.iso.date().refine(anioValido),
  data: z.record(z.string(), z.unknown()),
})

export const Registro = z.strictObject({
  code: z.string().min(1).max(40),
  hub_id: Ulid,
  location_id: Ulid,
  name: z.string().trim().min(1).max(60),
  instancia: z.string().min(1).max(100),
})
export type Registro = z.infer<typeof Registro>

export const NuevoRestaurante = z.strictObject({
  id: Ulid,
  name: z.string().trim().min(1).max(120),
})

/** Lo que pasó con cada evento de un lote. */
export type ResultadoEvento =
  | { id: string; status: 'saved' | 'already_stored' }
  /** El id ya estaba con otro contenido: el guardado no cambia y el nuevo queda para revisión. */
  | { id: string; status: 'divergent' }
  | { id: string | null; status: 'invalid'; reason: string }

export interface HubAutenticado {
  id: string
  restauranteId: string
  sedeId: string
}

/**
 * Postgres no guarda en `jsonb` el carácter nulo ni medio par de sustitutos de Unicode: un texto
 * así haría fallar el lote entero. Se revisan valores y claves.
 */
const SUSTITUTO_SUELTO = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const NULO = String.fromCharCode(0)
const noValido = (text: string) => text.includes(NULO) || SUSTITUTO_SUELTO.test(text)
export function textoValido(value: unknown): boolean {
  // Sin recursión: un dato muy anidado no agota la pila.
  const pendingList: unknown[] = [value]
  while (pendingList.length > 0) {
    const v = pendingList.pop()
    if (typeof v === 'string') {
      if (noValido(v)) return false
    } else if (Array.isArray(v)) pendingList.push(...v)
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (noValido(k)) return false
        pendingList.push(x)
      }
  }
  return true
}

/** Un error de Postgres por un dato que no acepta (clase 22: fechas, textos, números fuera de rango). */
const esErrorDeDato = (e: unknown) => String((e as { code?: unknown })?.code ?? '').startsWith('22')

// ── Credenciales ───────────────────────────────────────────────────────

/** SHA-256 en hexadecimal (Web Crypto: igual en Workers y en Node). */
export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const aleatorio = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes))

/** Credencial de un hub: 32 bytes al azar en base64url. Se muestra una vez; se guarda su huella. */
export function nuevaCredencial(): string {
  return btoa(String.fromCharCode(...aleatorio(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

/** Sin letras que se confunden al dictarlas (0/O, 1/I/L). */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** «K7PM-QX2R-9DHT»: 12 caracteres para escribir a mano al instalar el PC de caja. */
export function nuevoCodigo(): string {
  const letras = [...aleatorio(12)].map((b) => ALFABETO[b % ALFABETO.length]).join('')
  return `${letras.slice(0, 4)}-${letras.slice(4, 8)}-${letras.slice(8)}`
}

/** El código como lo escriba la persona: sin espacios ni guiones y en mayúsculas. */
export const normalizarCodigo = (code: string) => code.replace(/[\s-]/g, '').toUpperCase()

// ── Operaciones ────────────────────────────────────────────────────────

export class Nube {
  private readonly sql: Sql
  private readonly clock: () => Date

  constructor(sql: Sql, clock: () => Date = () => new Date()) {
    this.sql = sql
    this.clock = clock
  }

  /**
   * Corre el trabajo dentro de una transacción de un solo restaurante: la seguridad por fila de
   * la base solo deja ver y escribir sus eventos, aunque una consulta olvide filtrar.
   */
  private enRestaurante<T>(restauranteId: string, trabajo: (tx: Sql) => Promise<T>): Promise<T> {
    return this.sql.transaccion(async (tx) => {
      await tx.query("SELECT set_config('faro.restaurant_id', $1, true)", [restauranteId])
      await tx.query('SET LOCAL ROLE faro_data')
      return trabajo(tx)
    })
  }

  /** Crea el restaurante si no existe (con el mismo id que tiene en su hub). */
  async crearRestaurante(
    data: z.infer<typeof NuevoRestaurante>,
  ): Promise<'created' | 'already_existed'> {
    const rows = await this.sql.query(
      'INSERT INTO restaurants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id',
      [data.id, data.name],
    )
    return rows.length > 0 ? 'created' : 'already_existed'
  }

  /** Un código para registrar un hub del restaurante; null si el restaurante no existe. */
  async crearCodigo(restauranteId: string): Promise<{ code: string; venceEn: string } | null> {
    const [existe] = await this.sql.query('SELECT 1 FROM restaurants WHERE id = $1', [
      restauranteId,
    ])
    if (!existe) return null
    const code = nuevoCodigo()
    const venceEn = new Date(this.clock().getTime() + VIGENCIA_CODIGO_MS).toISOString()
    await this.sql.query(
      'INSERT INTO registration_codes (fingerprint, restaurant_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [await sha256(normalizarCodigo(code)), restauranteId, this.clock().toISOString(), venceEn],
    )
    return { code, venceEn }
  }

  /**
   * Registra un hub con su código y devuelve su credencial. El código vence a las 24 horas y es
   * de un solo hub: si la respuesta se perdió (se cayó el Wi-Fi), el mismo hub puede repetir el
   * registro con el mismo código mientras no venza y recibe una credencial nueva (la anterior deja
   * de servir). Otro hub con un código usado, o el mismo hub con otro código, no se registra.
   */
  async registrarHub(
    data: Registro,
  ): Promise<
    | { ok: true; credential: string; restauranteId: string }
    | { ok: false; reason: 'invalid_code' | 'hub_already_registered' }
  > {
    const fingerprint = await sha256(normalizarCodigo(data.code))
    const credential = nuevaCredencial()
    const huellaCredencial = await sha256(credential)
    const ahora = this.clock().toISOString()
    try {
      return await this.sql.transaccion(async (tx) => {
        // FOR UPDATE: dos registros a la vez con el mismo código no lo usan los dos.
        const [code] = await tx.query<{ restaurant_id: string; hub_id: string | null }>(
          `SELECT restaurant_id, hub_id FROM registration_codes
           WHERE fingerprint = $1 AND expires_at > $2 FOR UPDATE`,
          [fingerprint, ahora],
        )
        if (!code) return { ok: false, reason: 'invalid_code' } as const
        if (code.hub_id !== null) {
          // Ya usado: solo lo repite el mismo hub, y solo si no fue revocado.
          if (code.hub_id !== data.hub_id) return { ok: false, reason: 'invalid_code' } as const
          const repetido = await tx.query(
            `UPDATE hubs SET credential_hash = $2
             WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
            [data.hub_id, huellaCredencial],
          )
          if (repetido.length === 0) return { ok: false, reason: 'invalid_code' } as const
          return { ok: true, credential, restauranteId: code.restaurant_id } as const
        }
        const [already] = await tx.query('SELECT 1 FROM hubs WHERE id = $1', [data.hub_id])
        if (already) return { ok: false, reason: 'hub_already_registered' } as const
        await tx.query(
          `INSERT INTO hubs (id, restaurant_id, location_id, name, instancia, credential_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            data.hub_id,
            code.restaurant_id,
            data.location_id,
            data.name,
            data.instancia,
            huellaCredencial,
            ahora,
          ],
        )
        await tx.query(
          'UPDATE registration_codes SET used_at = $2, hub_id = $3 WHERE fingerprint = $1',
          [fingerprint, ahora, data.hub_id],
        )
        return { ok: true, credential, restauranteId: code.restaurant_id } as const
      })
    } catch (e) {
      // Dos registros del mismo hub a la vez con códigos distintos: el segundo choca con la clave.
      if ((e as { code?: string }).code === '23505')
        return { ok: false, reason: 'hub_already_registered' }
      throw e
    }
  }

  /** El hub dueño de una credencial, si existe y no está revocado. */
  async authenticate(credential: string): Promise<HubAutenticado | null> {
    if (!credential || credential.length > 200) return null
    const [hub] = await this.sql.query<{ id: string; restaurant_id: string; location_id: string }>(
      'SELECT id, restaurant_id, location_id FROM hubs WHERE credential_hash = $1 AND revoked_at IS NULL',
      [await sha256(credential)],
    )
    return hub ? { id: hub.id, restauranteId: hub.restaurant_id, sedeId: hub.location_id } : null
  }

  /** Revoca un hub: su credencial deja de servir. */
  async revocarHub(hubId: string): Promise<boolean> {
    const rows = await this.sql.query(
      'UPDATE hubs SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id',
      [hubId, this.clock().toISOString()],
    )
    return rows.length > 0
  }

  /**
   * Guarda un lote de eventos del hub en una transacción. Un evento que ya estaba (mismo id y
   * contenido) no se duplica; uno que ya estaba con otro contenido no pisa el guardado y queda en
   * `divergent_events`. Devuelve el resultado de cada uno, en el orden en que llegaron.
   */
  async recibirEventos(
    hub: HubAutenticado,
    crudos: readonly unknown[],
  ): Promise<ResultadoEvento[]> {
    const resultados: ResultadoEvento[] = []
    type Valido = { indice: number; id: string; fingerprint: string; fila: Record<string, unknown> }
    const validEntries: Valido[] = []
    /** El mismo id otra vez en el lote: se compara con lo que quede guardado. */
    const repetidosEnLote: Valido[] = []
    const seenSet = new Set<string>()
    crudos.forEach((crudo, indice) => {
      const r = EventoSubido.safeParse(crudo)
      // El id solo se devuelve si parece un id (no se le devuelve al hub cualquier texto).
      const crudoId = (crudo as { id?: unknown } | null)?.id
      const id = typeof crudoId === 'string' && crudoId.length <= 26 ? crudoId : null
      if (!r.success) {
        resultados[indice] = { id, status: 'invalid', reason: 'format' }
        return
      }
      // La huella también limita el anidamiento: así lo que sigue no recorre datos sin fondo.
      let fingerprint: string
      try {
        fingerprint = huellaEvento(r.data)
      } catch {
        resultados[indice] = { id: r.data.id, status: 'invalid', reason: 'too_deeply_nested' }
        return
      }
      if (!textoValido(r.data)) {
        resultados[indice] = { id: r.data.id, status: 'invalid', reason: 'invalid_character' }
        return
      }
      const content = JSON.stringify(r.data)
      if (new TextEncoder().encode(content).length > MAX_BYTES_EVENTO) {
        resultados[indice] = { id: r.data.id, status: 'invalid', reason: 'too_large' }
        return
      }
      const valid: Valido = {
        indice,
        id: r.data.id,
        fingerprint,
        fila: {
          id: r.data.id,
          type: r.data.type,
          aggregate_type: r.data.aggregate_type,
          aggregate_id: r.data.aggregate_id,
          hub_sequence: r.data.sequence,
          business_day: r.data.business_day,
          received_at: r.data.received_at,
          content: r.data,
          fingerprint,
        },
      }
      if (seenSet.has(r.data.id)) repetidosEnLote.push(valid)
      else {
        seenSet.add(r.data.id)
        validEntries.push(valid)
      }
    })
    if (validEntries.length === 0) return resultados

    return this.enRestaurante(hub.restauranteId, async (tx) => {
      const insertar = (rows: Valido[]) =>
        tx.query<{ id: string }>(
          `INSERT INTO events (restaurant_id, id, hub_id, type, aggregate_type, aggregate_id,
                               hub_sequence, business_day, received_at, content, fingerprint)
           SELECT $1, x.id, $2, x.type, x.aggregate_type, x.aggregate_id,
                  x.hub_sequence, x.business_day, x.received_at, x.content, x.fingerprint
           FROM jsonb_to_recordset($3::jsonb) AS x(
             id text, type text, aggregate_type text, aggregate_id text, hub_sequence bigint,
             business_day date, received_at timestamptz, content jsonb, fingerprint text)
           ON CONFLICT (restaurant_id, id) DO NOTHING
           RETURNING id`,
          [hub.restauranteId, hub.id, JSON.stringify(rows.map((v) => v.fila))],
        )
      // Una sola sentencia para todo el lote. Si la base rechaza un dato (una fecha que Postgres
      // no acepta, por ejemplo), se prueba uno por uno: el malo queda inválido y el resto entra.
      // Si no, el hub reintentaría para siempre un lote que nunca pasa.
      let aGuardar = validEntries
      let guardados: { id: string }[]
      await tx.query('SAVEPOINT lote')
      try {
        guardados = await insertar(validEntries)
        await tx.query('RELEASE SAVEPOINT lote')
      } catch (e) {
        if (!esErrorDeDato(e)) throw e
        await tx.query('ROLLBACK TO SAVEPOINT lote')
        guardados = []
        aGuardar = []
        for (const v of validEntries) {
          await tx.query('SAVEPOINT uno')
          try {
            guardados.push(...(await insertar([v])))
            await tx.query('RELEASE SAVEPOINT uno')
            aGuardar.push(v)
          } catch (e2) {
            if (!esErrorDeDato(e2)) throw e2
            await tx.query('ROLLBACK TO SAVEPOINT uno')
            resultados[v.indice] = { id: v.id, status: 'invalid', reason: 'rejected_by_database' }
          }
        }
      }

      const nuevos = new Set(guardados.map((g) => g.id))
      // Lo que quedó guardado de cada id: lo nuevo de este lote o lo de antes.
      const guardada = new Map<string, string>()
      for (const v of aGuardar) if (nuevos.has(v.id)) guardada.set(v.id, v.fingerprint)
      const consultar = [
        ...new Set(
          [...aGuardar, ...repetidosEnLote].map((v) => v.id).filter((id) => !guardada.has(id)),
        ),
      ]
      if (consultar.length > 0) {
        const rows = await tx.query<{ id: string; fingerprint: string }>(
          'SELECT id, fingerprint FROM events WHERE restaurant_id = $1 AND id = ANY($2::text[])',
          [hub.restauranteId, consultar],
        )
        for (const f of rows) guardada.set(f.id, f.fingerprint)
      }
      const enLote = repetidosEnLote.filter((v) => guardada.has(v.id))
      const distintos = [...aGuardar.filter((v) => !nuevos.has(v.id)), ...enLote].filter(
        (v) => guardada.get(v.id) !== v.fingerprint,
      )
      if (distintos.length > 0)
        await tx.query(
          `INSERT INTO divergent_events (restaurant_id, event_id, hub_id, content, fingerprint)
           SELECT $1, x.id, $2, x.content, x.fingerprint
           FROM jsonb_to_recordset($3::jsonb) AS x(id text, content jsonb, fingerprint text)
           ON CONFLICT (restaurant_id, event_id, fingerprint) DO NOTHING`,
          [hub.restauranteId, hub.id, JSON.stringify(distintos.map((d) => d.fila))],
        )
      // Lo guardado sin huecos desde la secuencia 1: desde ahí sigue el hub (`lastSequence`).
      await tx.query(
        `UPDATE hubs SET contiguous_sequence = (
           SELECT coalesce(max(s.hub_sequence), hubs.contiguous_sequence) FROM (
             SELECT hub_sequence, row_number() OVER (ORDER BY hub_sequence) AS n
             FROM (SELECT DISTINCT hub_sequence FROM events
                   WHERE restaurant_id = $1 AND hub_id = $2
                     AND hub_sequence > hubs.contiguous_sequence) d
           ) s WHERE s.hub_sequence = hubs.contiguous_sequence + s.n)
         WHERE id = $2`,
        [hub.restauranteId, hub.id],
      )
      for (const v of [...aGuardar, ...repetidosEnLote]) {
        if (!guardada.has(v.id)) {
          // Repetido en el lote de uno que la base rechazó: corre la misma suerte.
          resultados[v.indice] = { id: v.id, status: 'invalid', reason: 'rejected_by_database' }
          continue
        }
        const esNuevo = nuevos.has(v.id) && !repetidosEnLote.includes(v)
        resultados[v.indice] = {
          id: v.id,
          status: esNuevo
            ? 'saved'
            : guardada.get(v.id) === v.fingerprint
              ? 'already_stored'
              : 'divergent',
        }
      }
      return resultados
    })
  }

  /**
   * Hasta qué secuencia del hub está todo en la nube, sin huecos desde la 1: desde ahí sigue
   * subiendo. Si un evento no se pudo guardar (inválido), se queda ahí y el hub lo debe avisar.
   */
  async lastSequence(hub: HubAutenticado): Promise<number> {
    const [fila] = await this.sql.query<{ s: string | number }>(
      'SELECT contiguous_sequence AS s FROM hubs WHERE id = $1',
      [hub.id],
    )
    return Number(fila?.s ?? 0)
  }
}
