import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { event, itemCopy } from '../../../packages/core/src/testing/factory'
import { handle, MAX_BODY_BYTES } from './api'
import { MAX_EVENTS_PER_BATCH, newCode, normalizeCode } from './cloud'
import { CLOUD_MIGRATIONS, migrate } from './migrations'
import { testDatabase } from './testing/pglite'

// The cloud API (task 1.10) against an embedded Postgres: create the restaurant, register the
// hub with a single-use code and upload events without duplicates.

const ADMIN = 'token-de-administracion-de-prueba'
const NOW = new Date('2026-10-26T15:00:00.000Z')

async function world() {
  const { sql, db } = await testDatabase()
  const clock = { now: NOW }
  const request = (httpMethod: string, route: string, body?: unknown, token?: string) =>
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
  const restaurant = newId()
  const location = newId()
  /** Creates the restaurant and a code and registers a hub; returns its credential. */
  const registeredHub = async (rest = restaurant, hubId = newId()) => {
    await request('POST', '/v1/admin/restaurants', { id: rest, name: 'La Spritzzería' }, ADMIN)
    const { code } = await (
      await request('POST', '/v1/admin/codes', { restaurant_id: rest }, ADMIN)
    ).json()
    const r = await request('POST', '/v1/hubs/register', {
      code,
      hub_id: hubId,
      location_id: location,
      name: 'Caja principal',
      instance: 'instance-1',
    })
    expect(r.status).toBe(201)
    const { credential } = await r.json()
    return { credential: credential as string, hubId }
  }
  return { sql, db, clock, request, restaurant, location, registeredHub }
}

/** An order with two events, as the hub stores them (with the hub's sequence, day and time). */
function orderEvents(sequence = 1) {
  const order = newId()
  return [
    event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }, {
      sequence,
      business_day: '2026-10-26',
    } as never),
    event(order, 'ItemAdded', itemCopy(), {
      sequence: sequence + 1,
      business_day: '2026-10-26',
    } as never),
  ]
}

describe('cloud migrations', () => {
  it('apply once; repeating them does nothing; editing an applied one fails', async () => {
    const { sql } = await testDatabase()
    expect(await migrate(sql)).toEqual([])
    const edited = CLOUD_MIGRATIONS.map((m) => ({ ...m, sql: `${m.sql}\n-- change` }))
    await expect(migrate(sql, edited)).rejects.toThrow(/cambió después de aplicarse/)
  })

  it('events are neither changed nor deleted', async () => {
    const { request, registeredHub, db } = await world()
    const { credential } = await registeredHub()
    await request('POST', '/v1/events', { events: orderEvents() }, credential)
    await expect(db.query("UPDATE events SET type = 'x'")).rejects.toThrow(/solo se agregan/)
    await expect(db.query('DELETE FROM events')).rejects.toThrow(/solo se agregan/)
  })
})

describe('admin and hub registration', () => {
  it('without the admin token nothing is created', async () => {
    const { request, restaurant } = await world()
    const without = await request('POST', '/v1/admin/restaurants', { id: restaurant, name: 'X' })
    expect(without.status).toBe(401)
    const other = await request(
      'POST',
      '/v1/admin/restaurants',
      { id: restaurant, name: 'X' },
      'other',
    )
    expect(other.status).toBe(401)
  })

  it('with no admin token configured, the admin routes do not work', async () => {
    const { sql } = await testDatabase()
    const r = await handle(
      new Request('https://cloud.faro.test/v1/admin/restaurants', {
        method: 'POST',
        headers: { authorization: 'Bearer cualquiera' },
        body: JSON.stringify({ id: newId(), name: 'X' }),
      }),
      { sql },
    )
    expect(r.status).toBe(401)
  })

  it('creating the restaurant twice does not duplicate it; a code for one that does not exist gives 404', async () => {
    const { request, restaurant } = await world()
    const data = { id: restaurant, name: 'La Spritzzería' }
    expect((await request('POST', '/v1/admin/restaurants', data, ADMIN)).status).toBe(201)
    expect((await request('POST', '/v1/admin/restaurants', data, ADMIN)).status).toBe(200)
    const r = await request('POST', '/v1/admin/codes', { restaurant_id: newId() }, ADMIN)
    expect(r.status).toBe(404)
  })

  it('the code works once, regardless of case or dashes, and expires after 24 hours', async () => {
    const { request, restaurant, location, clock } = await world()
    await request('POST', '/v1/admin/restaurants', { id: restaurant, name: 'R' }, ADMIN)
    const fresh = async () =>
      (
        await (
          await request('POST', '/v1/admin/codes', { restaurant_id: restaurant }, ADMIN)
        ).json()
      ).code as string
    const record = (code: string, hub_id = newId()) =>
      request('POST', '/v1/hubs/register', {
        code,
        hub_id,
        location_id: location,
        name: 'Caja',
        instance: 'i',
      })

    const code = await fresh()
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect((await record(` ${code.toLowerCase().replaceAll('-', ' ')} `)).status).toBe(201)
    expect((await record(code)).status).toBe(403)

    const other = await fresh()
    clock.now = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1)
    expect((await record(other)).status).toBe(403)
  })

  it('an already registered hub is not registered again with another code', async () => {
    const { request, registeredHub, restaurant, location } = await world()
    const { hubId } = await registeredHub()
    const { code } = await (
      await request('POST', '/v1/admin/codes', { restaurant_id: restaurant }, ADMIN)
    ).json()
    const r = await request('POST', '/v1/hubs/register', {
      code,
      hub_id: hubId,
      location_id: location,
      name: 'Caja',
      instance: 'i',
    })
    expect(r.status).toBe(409)
  })

  it('codes do not repeat and only use letters and digits that are easy to read aloud', () => {
    const codes = new Set(Array.from({ length: 2000 }, newCode))
    expect(codes.size).toBe(2000)
    for (const c of codes) expect(normalizeCode(c)).not.toMatch(/[01OIL]/)
  })
})

describe('uploading events', () => {
  it('saves a batch, and resending it does not duplicate it', async () => {
    const { request, registeredHub, db } = await world()
    const { credential } = await registeredHub()
    const events = orderEvents()
    const r = await request('POST', '/v1/events', { events }, credential)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      results: events.map((e) => ({ id: e.id, status: 'saved' })),
      last_sequence: 2,
    })
    const another = await (await request('POST', '/v1/events', { events }, credential)).json()
    expect(another.results.map((x: { status: string }) => x.status)).toEqual([
      'already_stored',
      'already_stored',
    ])
    expect((await db.query('SELECT count(*)::int AS n FROM events')).rows).toEqual([{ n: 2 }])
  })

  it('the same id with other content does not overwrite the stored one: it is kept for review', async () => {
    const { request, registeredHub, db } = await world()
    const { credential } = await registeredHub()
    const [opened] = orderEvents()
    if (!opened) throw new Error('no event')
    await request('POST', '/v1/events', { events: [opened] }, credential)
    const changed = { ...opened, data: { ...opened.data, guests: 9 } }
    const r = await (await request('POST', '/v1/events', { events: [changed] }, credential)).json()
    expect(r.results).toEqual([{ id: opened.id, status: 'divergent' }])
    const [saved] = (
      await db.query<{ c: number }>("SELECT (content->'data'->>'guests')::int AS c FROM events")
    ).rows
    expect(saved?.c).toBe(2)
    expect((await db.query('SELECT count(*)::int AS n FROM divergent_events')).rows).toEqual([
      { n: 1 },
    ])
  })

  it('a malformed event does not sink the batch: the others are saved', async () => {
    const { request, registeredHub } = await world()
    const { credential } = await registeredHub()
    const [a, b] = orderEvents()
    const r = await (
      await request('POST', '/v1/events', { events: [a, { id: 'x', type: 'Nada' }, b] }, credential)
    ).json()
    expect(r.results.map((x: { status: string }) => x.status)).toEqual([
      'saved',
      'invalid',
      'saved',
    ])
  })

  it('with no credential, a made-up one or a revoked hub nothing is uploaded', async () => {
    const { request, registeredHub } = await world()
    const { credential, hubId } = await registeredHub()
    const events = orderEvents()
    expect((await request('POST', '/v1/events', { events })).status).toBe(401)
    expect((await request('POST', '/v1/events', { events }, 'inventada')).status).toBe(401)
    expect((await request('POST', '/v1/admin/hubs/revoke', { hub_id: hubId }, ADMIN)).status).toBe(
      204,
    )
    expect((await request('POST', '/v1/events', { events }, credential)).status).toBe(401)
  })

  it('each restaurant sees only its own, even if the event ids match', async () => {
    const { request, registeredHub, db } = await world()
    const a = await registeredHub(newId())
    const b = await registeredHub(newId())
    const events = orderEvents()
    await request('POST', '/v1/events', { events }, a.credential)
    // The same event in another restaurant is not "already stored": it is its own.
    const r = await (await request('POST', '/v1/events', { events }, b.credential)).json()
    expect(r.results.map((x: { status: string }) => x.status)).toEqual(['saved', 'saved'])
    expect((await db.query('SELECT count(*)::int AS n FROM events')).rows).toEqual([{ n: 4 }])
    const last = await (await request('GET', '/v1/events/last', undefined, b.credential)).json()
    expect(last).toEqual({ last_sequence: 2 })
  })

  it('limits: empty batch, more than 500 events, body that is not JSON or too large', async () => {
    const { request, registeredHub } = await world()
    const { credential } = await registeredHub()
    expect((await request('POST', '/v1/events', { events: [] }, credential)).status).toBe(400)
    const many = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => ({}))
    expect((await request('POST', '/v1/events', { events: many }, credential)).status).toBe(400)
    expect((await request('POST', '/v1/events', '{no es json', credential)).status).toBe(400)
    const huge = JSON.stringify({ events: ['x'.repeat(MAX_BODY_BYTES)] })
    const r = await request('POST', '/v1/events', huge, credential)
    expect(r.status).toBe(413)
    expect((await r.json()).error).toBe('batch_too_large')
  })

  it('an event over 64 KB is invalid, the rest of the batch is saved', async () => {
    const { request, registeredHub } = await world()
    const { credential } = await registeredHub()
    const [a, b] = orderEvents()
    if (!a || !b) throw new Error('no events')
    const large = { ...b, data: { ...b.data, notes: 'x'.repeat(70_000) } }
    const r = await (await request('POST', '/v1/events', { events: [a, large] }, credential)).json()
    expect(r.results).toEqual([
      { id: a.id, status: 'saved' },
      { id: b.id, status: 'invalid', reason: 'too_large' },
    ])
  })

  it('routes that do not exist give 404 and health responds', async () => {
    const { request } = await world()
    expect((await request('GET', '/v1/health')).status).toBe(200)
    expect((await request('GET', '/v1/nothing')).status).toBe(404)
  })
})

describe('row-level security in the database', () => {
  it('inside a restaurant only its events are seen, and another cannot be written to', async () => {
    const { request, registeredHub, sql } = await world()
    const restA = newId()
    const restB = newId()
    const a = await registeredHub(restA)
    const b = await registeredHub(restB)
    await request('POST', '/v1/events', { events: orderEvents() }, a.credential)
    await request('POST', '/v1/events', { events: orderEvents() }, b.credential)
    const inRestaurant = <T>(rest: string, job: (tx: typeof sql) => Promise<T>) =>
      sql.transaction(async (tx) => {
        await tx.query("SELECT set_config('faro.restaurant_id', $1, true)", [rest])
        await tx.query('SET LOCAL ROLE faro_data')
        return job(tx)
      })
    // A query without a filter still sees only its restaurant's events.
    const seenSet = await inRestaurant(restA, (tx) =>
      tx.query<{ r: string }>('SELECT DISTINCT restaurant_id AS r FROM events'),
    )
    expect(seenSet).toEqual([{ r: restA }])
    // Without stating the restaurant nothing is seen.
    const nothing = await sql.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE faro_data')
      return tx.query('SELECT 1 FROM events')
    })
    expect(nothing).toEqual([])
    // Writing an event of B from a transaction of A fails.
    await expect(
      inRestaurant(restA, (tx) =>
        tx.query(
          `INSERT INTO events (restaurant_id, id, hub_id, type, aggregate_type, aggregate_id,
             hub_sequence, business_day, received_at, content, fingerprint)
           VALUES ($1, $2, $3, 't', 'order', $2, 1, '2026-10-26', now(), '{}', 'h')`,
          [restB, newId(), b.hubId],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // The API role cannot delete or change the hubs registry beyond its own either.
    await expect(inRestaurant(restA, (tx) => tx.query('DELETE FROM hubs'))).rejects.toThrow(
      /permission denied/,
    )
  })
})

describe('code review (1.10)', () => {
  it('a text with a null character or half a surrogate is invalid and does not sink the batch', async () => {
    const { request, registeredHub } = await world()
    const { credential } = await registeredHub()
    const [a, b] = orderEvents()
    if (!a || !b) throw new Error('no events')
    const withNul = { ...b, data: { ...b.data, notes: `con ${String.fromCharCode(0)} nulo` } }
    const r = await (
      await request('POST', '/v1/events', { events: [a, withNul] }, credential)
    ).json()
    expect(r.results).toEqual([
      { id: a.id, status: 'saved' },
      { id: b.id, status: 'invalid', reason: 'invalid_character' },
    ])
    const [c] = orderEvents(10)
    if (!c) throw new Error('no event')
    const lone = { ...c, data: { ...c.data, 'key\uD800': 1 } }
    const r2 = await (await request('POST', '/v1/events', { events: [lone] }, credential)).json()
    expect(r2.results[0]).toMatchObject({ status: 'invalid', reason: 'invalid_character' })
  })

  it('last_sequence is the last one with no gaps from 1, not the highest', async () => {
    const { request, registeredHub } = await world()
    const { credential } = await registeredHub()
    const [s1, s2] = orderEvents(1)
    const [s3, s4] = orderEvents(3)
    const upload = async (events: unknown[]) =>
      (await (await request('POST', '/v1/events', { events }, credential)).json()).last_sequence
    // The later ones arrive first (3 and 4): 1 and 2 are missing.
    expect(await upload([s3, s4])).toBe(0)
    expect(await upload([s1])).toBe(1)
    expect(await upload([s2])).toBe(4)
  })

  it('registration can be repeated with the same code and the same hub: the previous credential is voided', async () => {
    const { request, restaurant, location } = await world()
    await request('POST', '/v1/admin/restaurants', { id: restaurant, name: 'R' }, ADMIN)
    const { code } = await (
      await request('POST', '/v1/admin/codes', { restaurant_id: restaurant }, ADMIN)
    ).json()
    const hub_id = newId()
    const record = (id = hub_id) =>
      request('POST', '/v1/hubs/register', {
        code,
        hub_id: id,
        location_id: location,
        name: 'C',
        instance: 'i',
      })
    const first = (await (await record()).json()).credential
    const second = await record()
    expect(second.status).toBe(201)
    const newOne = (await second.json()).credential
    expect(newOne).not.toBe(first)
    expect((await request('GET', '/v1/events/last', undefined, first)).status).toBe(401)
    expect((await request('GET', '/v1/events/last', undefined, newOne)).status).toBe(200)
    // Another hub with that used code, no.
    expect((await record(newId())).status).toBe(403)
  })

  it('an internal error responds 500 without details', async () => {
    const faulty = {
      query: async () => {
        throw Object.assign(new Error('relation "secreta" does not exist'), { code: '42P01' })
      },
      execute: async () => {},
      transaction: async () => {
        throw new Error('x')
      },
    }
    const r = await handle(
      new Request('https://cloud.faro.test/v1/events/last', {
        headers: { authorization: 'Bearer algo' },
      }),
      { sql: faulty },
    )
    expect(r.status).toBe(500)
    expect(await r.text()).not.toMatch(/secreta|relation/)
  })
})

describe('batch with a value Postgres rejects', () => {
  it('the rest is saved and the bad one is invalid, with no 500 or stuck batch', async () => {
    const { request, registeredHub } = await world()
    const { credential } = await registeredHub()
    const [a, b] = orderEvents()
    if (!a || !b) throw new Error('no events')
    // A February 30 passes the envelope but Postgres does not accept it as a date.
    const badCase = { ...b, business_day: '2026-02-30' }
    const r = await request('POST', '/v1/events', { events: [a, badCase] }, credential)
    expect(r.status).toBe(200)
    const { results } = await r.json()
    expect(results[0]).toEqual({ id: a.id, status: 'saved' })
    expect(results[1]).toMatchObject({ id: b.id, status: 'invalid' })
    // Resending the batch gives the same result: it does not get stuck.
    const another = await (
      await request('POST', '/v1/events', { events: [a, badCase] }, credential)
    ).json()
    expect(another.results.map((x: { status: string }) => x.status)).toEqual([
      'already_stored',
      'invalid',
    ])
  })
})
