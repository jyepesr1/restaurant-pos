import { nuevoId } from '@pos/core'
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
export function ulid(n: number, marca = 'A'): string {
  let resto = n
  let cola = ''
  while (cola.length < 24) {
    cola = ALFABETO_ULID[resto % 32] + cola
    resto = Math.floor(resto / 32)
  }
  return `0${marca}${cola}`
}

export interface EventoPlano {
  id: string
  tipo: string
  agregado_tipo: string
  agregado_id: string
  secuencia: number
  recibido_en: string
  dia_operativo: string
  datos: Record<string, unknown>
  [campo: string]: unknown
}

/** Un evento mínimo pero válido para la nube; el número fija su id y su secuencia. */
export function eventoPlano(n: number, extras: Partial<EventoPlano> = {}): EventoPlano {
  return {
    id: ulid(n, 'E'),
    tipo: 'ItemAgregado',
    agregado_tipo: 'pedido',
    agregado_id: ulid(Math.floor(n / 3), 'P'),
    secuencia: n,
    recibido_en: '2026-10-26T15:00:00.000Z',
    dia_operativo: '2026-10-26',
    datos: { cantidad: (n % 5) + 1, notas: `nota ${n}` },
    ...extras,
  }
}

export const lote = (desde: number, cuantos: number) =>
  Array.from({ length: cuantos }, (_, i) => eventoPlano(desde + i))

export interface HubDePrueba {
  hub: HubAutenticado
  credencial: string
  restauranteId: string
}

export interface Mundo {
  sql: Sql
  db: Awaited<ReturnType<typeof baseDePrueba>>['db']
  nube: Nube
  reloj: { ahora: Date }
  /** Crea (si hace falta) el restaurante y registra un hub con un código nuevo. */
  nuevoHub: (restauranteId?: string) => Promise<HubDePrueba>
  /** Una petición a la API con el token y el reloj de la prueba. */
  pedir: (metodo: string, ruta: string, cuerpo?: unknown, token?: string) => Promise<Response>
}

export async function crearMundo(): Promise<Mundo> {
  const { sql, db } = await baseDePrueba()
  const reloj = { ahora: AHORA }
  const nube = new Nube(sql, () => reloj.ahora)
  const nuevoHub = async (restauranteId = nuevoId()): Promise<HubDePrueba> => {
    await nube.crearRestaurante({ id: restauranteId, nombre: 'Restaurante de prueba' })
    const codigo = await nube.crearCodigo(restauranteId)
    if (!codigo) throw new Error('sin código')
    const r = await nube.registrarHub({
      codigo: codigo.codigo,
      hub_id: nuevoId(),
      sede_id: nuevoId(),
      nombre: 'Caja',
      instancia: 'i',
    })
    if (!r.ok) throw new Error(r.motivo)
    const hub = await nube.autenticar(r.credencial)
    if (!hub) throw new Error('sin hub')
    return { hub, credencial: r.credencial, restauranteId }
  }
  const pedir: Mundo['pedir'] = (metodo, ruta, cuerpo, token) =>
    atender(
      new Request(`https://nube.faro.test${ruta}`, {
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
      { sql, tokenAdmin: ADMIN, reloj: () => reloj.ahora },
    )
  return { sql, db, nube, reloj, nuevoHub, pedir }
}

/** Lo guardado de un restaurante, ordenado por id, para comparar corridas distintas. */
export async function eventosGuardados(db: Mundo['db'], restauranteId: string) {
  const r = await db.query<{
    id: string
    huella: string
    secuencia_hub: string
    hub_id: string
    contenido: unknown
  }>(
    'SELECT id, huella, secuencia_hub::text, hub_id, contenido FROM evento WHERE restaurante_id = $1 ORDER BY id',
    [restauranteId],
  )
  return r.rows
}

export async function contar(db: Mundo['db'], tabla: string, restauranteId?: string) {
  const r = restauranteId
    ? await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${tabla} WHERE restaurante_id = $1`,
        [restauranteId],
      )
    : await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla}`)
  return r.rows[0]?.n ?? 0
}

export const estados = (r: { estado: string }[]) => r.map((x) => x.estado)
