import { newId } from '@pos/core'
import { handle } from '../api'
import { type AuthenticatedHub, Cloud } from '../cloud'
import type { Sql } from '../sql'
import { testDatabase } from './pglite'

// Helpers shared by the cloud tests: deterministic ids, flat events (without going through the
// POS factory: the cloud only requires the envelope), restaurants and already registered hubs.

export const ADMIN = 'token-de-administracion-de-prueba'
export const NOW = new Date('2026-10-26T15:00:00.000Z')
/** Fixed fast-check seed: the property tests are repeatable. */
export const SEED = 20261026

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A valid, deterministic ULID from a number (and a marker letter to tell them apart). */
export function ulid(n: number, brand = 'A'): string {
  let rest = n
  let tail = ''
  while (tail.length < 24) {
    tail = ULID_ALPHABET[rest % 32] + tail
    rest = Math.floor(rest / 32)
  }
  return `0${brand}${tail}`
}

export interface FlatEvent {
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

/** A minimal but valid event for the cloud; the number sets its id and its sequence. */
export function flatEvent(n: number, extras: Partial<FlatEvent> = {}): FlatEvent {
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

export const batch = (from: number, howMany: number) =>
  Array.from({ length: howMany }, (_, i) => flatEvent(from + i))

export interface TestHub {
  hub: AuthenticatedHub
  credential: string
  restaurantId: string
}

export interface World {
  sql: Sql
  db: Awaited<ReturnType<typeof testDatabase>>['db']
  cloud: Cloud
  clock: { now: Date }
  /** Creates the restaurant (if needed) and registers a hub with a new code. */
  newHub: (restaurantId?: string) => Promise<TestHub>
  /** A request to the API with the test's token and clock. */
  request: (httpMethod: string, route: string, body?: unknown, token?: string) => Promise<Response>
}

export async function createWorld(): Promise<World> {
  const { sql, db } = await testDatabase()
  const clock = { now: NOW }
  const cloud = new Cloud(sql, () => clock.now)
  const newHub = async (restaurantId = newId()): Promise<TestHub> => {
    await cloud.createRestaurant({ id: restaurantId, name: 'Restaurante de prueba' })
    const code = await cloud.createCode(restaurantId)
    if (!code) throw new Error('no code')
    const r = await cloud.registerHub({
      code: code.code,
      restaurant_id: restaurantId,
      hub_id: newId(),
      location_id: newId(),
      name: 'Caja',
      instance: 'i',
    })
    if (!r.ok) throw new Error(r.reason)
    const hub = await cloud.authenticate(r.credential)
    if (!hub) throw new Error('no hub')
    return { hub, credential: r.credential, restaurantId }
  }
  const request: World['request'] = (httpMethod, route, body, token) =>
    handle(
      new Request(`https://cloud.faro.test${route}`, {
        method: httpMethod,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body:
          body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
      { sql, adminToken: ADMIN, clock: () => clock.now },
    )
  return { sql, db, cloud, clock, newHub, request }
}

/** A restaurant's stored events, ordered by id, to compare different runs. */
export async function savedEvents(db: World['db'], restaurantId: string) {
  const r = await db.query<{
    id: string
    fingerprint: string
    hub_sequence: string
    hub_id: string
    content: unknown
  }>(
    'SELECT id, fingerprint, hub_sequence::text, hub_id, content FROM events WHERE restaurant_id = $1 ORDER BY id',
    [restaurantId],
  )
  return r.rows
}

export async function count(db: World['db'], tableName: string, restaurantId?: string) {
  const r = restaurantId
    ? await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${tableName} WHERE restaurant_id = $1`,
        [restaurantId],
      )
    : await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tableName}`)
  return r.rows[0]?.n ?? 0
}

export const statuses = (r: { status: string }[]) => r.map((x) => x.status)
