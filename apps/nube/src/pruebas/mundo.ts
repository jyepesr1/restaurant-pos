import { newId } from '@pos/core'
import { atender } from '../api'
import { type HubAutenticado, Nube } from '../nube'
import type { Sql } from '../sql'
import { baseDePrueba } from './pglite'

// Utilidades compartidas por las pruebas de la nube: ids deterministas, eventos planos (sin pasar
// por la fábrica del POS: la nube solo exige el sobre), restaurantes y hubs ya registrados.

export const ADMIN = 'token-de-administracion-de-prueba'
export const AHORA = new Date('2026-10-26T15:00:00.000Z')
/** Semilla fija de fast-check: las pruebas de propiedades son repetibles. */
export const SEMILLA = 20261026

const ALFABETO_ULID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Un ULID válido y determinista a partir de un número (y una letra de marca para distinguir). */
export function ulid(n: number, brand = 'A'): string {
  let rest = n
  let cola = ''
  while (cola.length < 24) {
    cola = ALFABETO_ULID[rest % 32] + cola
    rest = Math.floor(rest / 32)
  }
  return `0${brand}${cola}`
}

export interface EventoPlano {
  id: string
  type: string
  aggregate_type: string
  aggregate_id: string
  sequence: number
  received_at: string
  business_day: string
  data: Record<string, unknown>
  [field: string]: unknown
}

/** Un evento mínimo pero válido para la nube; el número fija su id y su secuencia. */
export function eventoPlano(n: number, extras: Partial<EventoPlano> = {}): EventoPlano {
  return {
    id: ulid(n, 'E'),
    type: 'ItemAdded',
    aggregate_type: 'order',
    aggregate_id: ulid(Math.floor(n / 3), 'P'),
    sequence: n,
    received_at: '2026-10-26T15:00:00.000Z',
    business_day: '2026-10-26',
    data: { quantity: (n % 5) + 1, notes: `nota ${n}` },
    ...extras,
  }
}

export const batch = (from: number, cuantos: number) =>
  Array.from({ length: cuantos }, (_, i) => eventoPlano(from + i))

export interface HubDePrueba {
  hub: HubAutenticado
  credential: string
  restauranteId: string
}

export interface Mundo {
  sql: Sql
  db: Awaited<ReturnType<typeof baseDePrueba>>['db']
  nube: Nube
  clock: { ahora: Date }
  /** Crea (si hace falta) el restaurante y registra un hub con un código nuevo. */
  nuevoHub: (restauranteId?: string) => Promise<HubDePrueba>
  /** Una petición a la API con el token y el reloj de la prueba. */
  request: (metodo: string, ruta: string, cuerpo?: unknown, token?: string) => Promise<Response>
}

export async function crearMundo(): Promise<Mundo> {
  const { sql, db } = await baseDePrueba()
  const clock = { ahora: AHORA }
  const nube = new Nube(sql, () => clock.ahora)
  const nuevoHub = async (restauranteId = newId()): Promise<HubDePrueba> => {
    await nube.crearRestaurante({ id: restauranteId, name: 'Restaurante de prueba' })
    const code = await nube.crearCodigo(restauranteId)
    if (!code) throw new Error('sin código')
    const r = await nube.registrarHub({
      code: code.code,
      hub_id: newId(),
      location_id: newId(),
      name: 'Caja',
      instancia: 'i',
    })
    if (!r.ok) throw new Error(r.reason)
    const hub = await nube.authenticate(r.credential)
    if (!hub) throw new Error('sin hub')
    return { hub, credential: r.credential, restauranteId }
  }
  const request: Mundo['request'] = (metodo, ruta, cuerpo, token) =>
    atender(
      new Request(`https://cloud.faro.test${ruta}`, {
        method: metodo,
        headers: {
          ...(cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body:
          cuerpo === undefined
            ? undefined
            : typeof cuerpo === 'string'
              ? cuerpo
              : JSON.stringify(cuerpo),
      }),
      { sql, tokenAdmin: ADMIN, clock: () => clock.ahora },
    )
  return { sql, db, nube, clock, nuevoHub, request }
}

/** Lo guardado de un restaurante, ordenado por id, para comparar corridas distintas. */
export async function eventosGuardados(db: Mundo['db'], restauranteId: string) {
  const r = await db.query<{
    id: string
    fingerprint: string
    hub_sequence: string
    hub_id: string
    content: unknown
  }>(
    'SELECT id, fingerprint, hub_sequence::text, hub_id, content FROM events WHERE restaurant_id = $1 ORDER BY id',
    [restauranteId],
  )
  return r.rows
}

export async function contar(db: Mundo['db'], tableName: string, restauranteId?: string) {
  const r = restauranteId
    ? await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${tableName} WHERE restaurant_id = $1`,
        [restauranteId],
      )
    : await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tableName}`)
  return r.rows[0]?.n ?? 0
}

export const statuses = (r: { status: string }[]) => r.map((x) => x.status)
