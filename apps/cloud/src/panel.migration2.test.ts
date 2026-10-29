import { newId, type OrderEvent } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../packages/core/src/testing/factory'
import { handle } from './api'
import { sha256, slugOf } from './cloud'
import { CLOUD_MIGRATIONS, migrate, sqlFingerprint } from './migrations'
import { remoteUser } from './testing/panel'
import { emptyDatabase } from './testing/pglite'
import { createWorld, flatEvent, ulid } from './testing/world'

// Migration 2 on a database that already has data from migration 1 (task 1.11c-1): what it fills
// in must be what the live path would have written, it can be applied twice, it is all or nothing,
// and the panel works on the migrated data as on data uploaded afterwards.

type Db = ReturnType<typeof emptyDatabase>['db']

/** A database stopped at migration 1, with a restaurant, a hub and its events inserted raw. */
async function atMigration1() {
  const { sql, db } = emptyDatabase()
  await migrate(sql, CLOUD_MIGRATIONS.slice(0, 1))
  return { sql, db }
}

async function insertRestaurant(db: Db, id: string, name: string, createdAt?: string) {
  await db.query(
    createdAt
      ? 'INSERT INTO restaurants (id, name, created_at) VALUES ($1, $2, $3)'
      : 'INSERT INTO restaurants (id, name) VALUES ($1, $2)',
    createdAt ? [id, name, createdAt] : [id, name],
  )
}

async function insertHub(db: Db, restaurantId: string, credential = 'credencial') {
  const id = newId()
  const location = newId()
  await db.query(
    `INSERT INTO hubs (id, restaurant_id, location_id, name, instance, credential_hash)
     VALUES ($1, $2, $3, 'Caja', 'i', $4)`,
    [id, restaurantId, location, await sha256(credential)],
  )
  return { id, location, credential }
}

/** Inserts an event the way migration 1's receive path stored it: the whole event as `content`. */
async function insertEvent(
  db: Db,
  restaurantId: string,
  hubId: string,
  e: Record<string, unknown> & { id: string; type: string; aggregate_id: string; sequence: number },
) {
  await db.query(
    `INSERT INTO events (restaurant_id, id, hub_id, type, aggregate_type, aggregate_id,
       hub_sequence, business_day, received_at, content, fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'f')`,
    [
      restaurantId,
      e.id,
      hubId,
      e.type,
      e.aggregate_type ?? 'order',
      e.aggregate_id,
      e.sequence,
      e.business_day ?? '2026-10-26',
      e.received_at ?? '2026-10-26T15:00:00.000Z',
      JSON.stringify(e),
    ],
  )
}

const aggregateRows = async (db: Db, restaurantId?: string) =>
  (
    await db.query<{ event_id: string; aggregate_id: string; hub_sequence: string | number }>(
      `SELECT event_id, aggregate_id, hub_sequence FROM event_aggregates
       ${restaurantId ? 'WHERE restaurant_id = $1' : ''} ORDER BY event_id, aggregate_id`,
      restaurantId ? [restaurantId] : [],
    )
  ).rows.map((r) => `${r.event_id}|${r.aggregate_id}|${Number(r.hub_sequence)}`)

describe('applying it', () => {
  it('twice (or ten times) does nothing the second time, with data in place', async () => {
    const { sql, db } = await atMigration1()
    const r = newId()
    await insertRestaurant(db, r, 'La Spritzzería')
    const hub = await insertHub(db, r)
    await insertEvent(db, r, hub.id, flatEvent(1) as never)
    expect(await migrate(sql)).toEqual([2])
    const snapshot = async () => ({
      slugs: (await db.query('SELECT id, slug FROM restaurants ORDER BY id')).rows,
      aggregates: await aggregateRows(db),
      registry: (await db.query('SELECT version, fingerprint FROM migrations ORDER BY 1')).rows,
    })
    const first = await snapshot()
    for (let i = 0; i < 10; i++) expect(await migrate(sql)).toEqual([])
    expect(await snapshot()).toEqual(first)
    expect(first.registry).toHaveLength(2)
    expect(first.aggregates).toHaveLength(1)
  })

  it('running its SQL by hand a second time fails cleanly and leaves everything as it was', async () => {
    const { sql, db } = await atMigration1()
    await migrate(sql)
    const before = await aggregateRows(db)
    const panel = CLOUD_MIGRATIONS[1]
    await expect(sql.transaction((tx) => tx.execute(panel?.sql ?? ''))).rejects.toThrow()
    expect(await aggregateRows(db)).toEqual(before)
    // The registry still says it was applied once, with the fingerprint of its SQL.
    expect((await db.query('SELECT fingerprint FROM migrations WHERE version = 2')).rows).toEqual([
      { fingerprint: sqlFingerprint(panel?.sql ?? '') },
    ])
  })

  it('all or nothing: if something in the way makes it fail, there is no trace of it', async () => {
    const { sql, db } = await atMigration1()
    const r = newId()
    await insertRestaurant(db, r, 'La Spritzzería')
    // A table with the name of one of the new ones (the last statements of the migration).
    await db.query('CREATE TABLE panel_attempts (x integer)')
    await expect(migrate(sql)).rejects.toThrow()
    expect((await db.query('SELECT max(version) AS v FROM migrations')).rows).toEqual([{ v: 1 }])
    const columns = (
      await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'restaurants'",
      )
    ).rows.map((c) => c.column_name)
    expect(columns).not.toContain('slug')
    const tables = (
      await db.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      )
    ).rows.map((t) => t.tablename)
    for (const gone of ['event_aggregates', 'snapshots', 'remote_users', 'panel_sessions'])
      expect(tables, gone).not.toContain(gone)
    // Once the obstacle is gone, it applies cleanly.
    await db.query('DROP TABLE panel_attempts')
    expect(await migrate(sql)).toEqual([2])
    expect((await db.query('SELECT slug FROM restaurants')).rows).toEqual([
      { slug: 'la-spritzzeria' },
    ])
  })

  it('two processes migrating at once apply it once', async () => {
    const { sql } = await atMigration1()
    const results = await Promise.all([migrate(sql), migrate(sql)].map((p) => p.catch((e) => e)))
    const applied = results.flat().filter((v) => v === 2)
    expect(applied.length).toBeLessThanOrEqual(1)
    expect(results.some((r) => r instanceof Error && !/lock|deadlock|abort/i.test(r.message))).toBe(
      false,
    )
    expect(await migrate(sql)).toEqual([])
  })
})

describe('the orders of the events already stored', () => {
  /** Events with the shapes the hub produces: moved items, merged tables, plain ones. */
  const events = () => {
    const [a, b, c, d] = [ulid(1, 'P'), ulid(2, 'P'), ulid(3, 'P'), ulid(4, 'P')]
    return [
      flatEvent(1, { aggregate_id: a, related: [b] }),
      flatEvent(2, { aggregate_id: b, affects: [a, c] }),
      // Repeated ids and the aggregate also listed as related: one row each.
      flatEvent(3, { aggregate_id: c, related: [c, c, a], affects: [a, d, d] }),
      flatEvent(4, { aggregate_id: d }),
      // Ids that are not ULIDs (lowercase, short, long, numbers, null, nested) are ignored.
      flatEvent(5, {
        aggregate_id: a,
        related: [a.toLowerCase(), 'corto', `${b}X`, 7, null, [b], { id: b }, ''],
        affects: 'no es una lista',
      }),
      flatEvent(6, { aggregate_id: d, related: 'x', affects: { 0: a } }),
    ]
  }

  it('gives the same rows as receiving them live would have written', async () => {
    const list = events()
    // Migrated: stored raw under migration 1, then migration 2.
    const migrated = await atMigration1()
    const r1 = newId()
    await insertRestaurant(migrated.db, r1, 'Migrado')
    const hub1 = await insertHub(migrated.db, r1)
    for (const e of list) await insertEvent(migrated.db, r1, hub1.id, e as never)
    expect(await migrate(migrated.sql)).toEqual([2])

    // Live: a fresh database receiving the same events.
    const live = await createWorld()
    const h = await live.newHub()
    const received = await live.cloud.receiveEvents(h.hub, list)
    expect(received.map((r) => r.status)).toEqual(list.map(() => 'saved'))

    const fromMigration = await aggregateRows(migrated.db, r1)
    const fromLive = await aggregateRows(live.db, h.restaurantId)
    expect(fromMigration).toEqual(fromLive)
    // And it is not trivially empty or complete: a, b, c, d across the six events.
    expect(fromLive.length).toBeGreaterThan(list.length)
  })

  it('keeps each hub’s own sequence and hub id, with several hubs and restaurants', async () => {
    const { sql, db } = await atMigration1()
    const [r1, r2] = [newId(), newId()]
    await insertRestaurant(db, r1, 'Uno')
    await insertRestaurant(db, r2, 'Dos')
    const h1 = await insertHub(db, r1)
    const h1b = await insertHub(db, r1, 'otra')
    const h2 = await insertHub(db, r2, 'tercera')
    await insertEvent(db, r1, h1.id, flatEvent(1, { aggregate_id: ulid(1, 'P') }) as never)
    await insertEvent(db, r1, h1b.id, flatEvent(2, { aggregate_id: ulid(2, 'P') }) as never)
    await insertEvent(db, r2, h2.id, flatEvent(3, { aggregate_id: ulid(3, 'P') }) as never)
    await migrate(sql)
    const rows = (
      await db.query<{ restaurant_id: string; hub_id: string; hub_sequence: string }>(
        'SELECT restaurant_id, hub_id, hub_sequence::text FROM event_aggregates ORDER BY hub_sequence',
      )
    ).rows
    expect(rows).toEqual([
      { restaurant_id: r1, hub_id: h1.id, hub_sequence: '1' },
      { restaurant_id: r1, hub_id: h1b.id, hub_sequence: '2' },
      { restaurant_id: r2, hub_id: h2.id, hub_sequence: '3' },
    ])
  })

  it('a database with thousands of events migrates (the index and the fill are not quadratic)', async () => {
    const { sql, db } = await atMigration1()
    const r = newId()
    await insertRestaurant(db, r, 'Grande')
    const hub = await insertHub(db, r)
    await db.query(
      `INSERT INTO events (restaurant_id, id, hub_id, type, aggregate_type, aggregate_id,
         hub_sequence, business_day, received_at, content, fingerprint)
       SELECT $1, 'E' || lpad(n::text, 25, '0'), $2, 'ItemAdded', 'order',
              '0P' || lpad((n % 500)::text, 24, '0'), n, '2026-10-26', now(),
              jsonb_build_object('related', jsonb_build_array('0P' || lpad(((n + 1) % 500)::text, 24, '0'))),
              'f'
       FROM generate_series(1, 5000) n`,
      [r, hub.id],
    )
    expect(await migrate(sql)).toEqual([2])
    const [row] = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM event_aggregates'))
      .rows
    // Each event touches its aggregate and the next one's (500 different ones ring around).
    expect(row?.n).toBe(10_000)
  })
})

describe('the slugs given to the restaurants already there', () => {
  const NAMES = [
    'La Spritzzería',
    'Café Ñandú',
    'EL ÁRBOL DEL PARQUE',
    "Pizzería D'Ángelo & Hijos",
    'Sushi   Bar',
    '123 Burgers',
    'Ñ',
    '  Con espacios  ',
    'Guion-medio - y más',
    'ÜBER Küche',
    'x'.repeat(80),
    `${'abcdefghi-'.repeat(8)}`,
    // The cut falls right after a dash: nothing dangling at the end.
    `${'a'.repeat(49)} bb`,
  ]

  it('is the same as the one the API gives a new restaurant with that name', async () => {
    const { sql, db } = await atMigration1()
    const ids = NAMES.map(() => newId())
    for (const [i, name] of NAMES.entries())
      await insertRestaurant(
        db,
        ids[i] as string,
        name,
        `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      )
    await migrate(sql)
    const slugs = new Map(
      (await db.query<{ id: string; slug: string }>('SELECT id, slug FROM restaurants')).rows.map(
        (r) => [r.id, r.slug],
      ),
    )
    for (const [i, name] of NAMES.entries())
      expect(slugs.get(ids[i] as string), name).toBe(slugOf(name))
  })

  it('always satisfies the format, with names that have no letters or digits at all', async () => {
    const { sql, db } = await atMigration1()
    for (const name of ['¡¡!!', '---', '🙂🙂', '   ', '日本語レストラン', 'Ø'])
      await insertRestaurant(db, newId(), name)
    await migrate(sql)
    const slugs = (await db.query<{ slug: string }>('SELECT slug FROM restaurants')).rows.map(
      (r) => r.slug,
    )
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(slugs.every((s) => s.length <= 60)).toBe(true)
    // Several nameless ones: the first keeps «restaurante», the rest carry the end of their id.
    expect(slugs.filter((s) => s === 'restaurante')).toHaveLength(1)
  })

  it('repeated names: the oldest keeps the plain slug and the rest carry the end of their id', async () => {
    const { sql, db } = await atMigration1()
    const [old, newer, newest] = [newId(), newId(), newId()]
    await insertRestaurant(db, newest, 'Casa Mía', '2026-03-01T00:00:00Z')
    await insertRestaurant(db, old, 'CASA MÍA', '2026-01-01T00:00:00Z')
    await insertRestaurant(db, newer, 'casa mia', '2026-02-01T00:00:00Z')
    await migrate(sql)
    const slugs = Object.fromEntries(
      (await db.query<{ id: string; slug: string }>('SELECT id, slug FROM restaurants')).rows.map(
        (r) => [r.id, r.slug],
      ),
    )
    expect(slugs[old]).toBe('casa-mia')
    expect(slugs[newer]).toBe(`casa-mia-${newer.slice(-6).toLowerCase()}`)
    expect(slugs[newest]).toBe(`casa-mia-${newest.slice(-6).toLowerCase()}`)
  })

  it('a long repeated name still fits in 60 characters', async () => {
    const { sql, db } = await atMigration1()
    for (let i = 0; i < 3; i++) await insertRestaurant(db, newId(), 'z'.repeat(120))
    await migrate(sql)
    const slugs = (await db.query<{ slug: string }>('SELECT slug FROM restaurants')).rows
    expect(slugs.every((r) => r.slug.length <= 60)).toBe(true)
    expect(new Set(slugs.map((r) => r.slug)).size).toBe(3)
  })

  it('the admin can still create a restaurant on a migrated database, with the free slug', async () => {
    const { sql, db } = await atMigration1()
    await insertRestaurant(db, newId(), 'La Spritzzería')
    await migrate(sql)
    const response = await handle(
      new Request('https://cloud.faro.test/v1/admin/restaurants', {
        method: 'POST',
        headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
        body: JSON.stringify({ id: newId(), name: 'La Spritzzería' }),
      }),
      { sql, adminToken: 'admin' },
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ status: 'created', slug: 'la-spritzzeria-2' })
  })
})

describe('what the old hubs and sessions look like after it', () => {
  it('a hub from before has no heartbeat yet: the panel says so instead of failing', async () => {
    const { sql, db } = await atMigration1()
    const r = newId()
    await insertRestaurant(db, r, 'La Spritzzería')
    const hub = await insertHub(db, r, 'credencial-vieja')
    const [first] = [flatEvent(1, { aggregate_id: ulid(1, 'P') })]
    await insertEvent(db, r, hub.id, first as never)
    await db.query('UPDATE hubs SET contiguous_sequence = 1 WHERE id = $1', [hub.id])
    await migrate(sql)
    expect(
      (await db.query('SELECT last_seen_at, hub_max_sequence FROM hubs WHERE id = $1', [hub.id]))
        .rows,
    ).toEqual([{ last_seen_at: null, hub_max_sequence: null }])

    // The old hub's credential still works, and it uploads what the panel needs.
    const bearer = { authorization: `Bearer ${hub.credential}` }
    const user = remoteUser('ana', 'clave-de-ana-2026')
    const put = (kind: string, content: unknown, fingerprint: string) =>
      handle(
        new Request(`https://cloud.faro.test/v1/snapshots/${kind}`, {
          method: 'PUT',
          headers: { ...bearer, 'content-type': 'application/json' },
          body: JSON.stringify({ fingerprint, content }),
        }),
        { sql },
      )
    expect((await put('remote_users', [user], 'u1')).status).toBe(204)
    const signIn = await handle(
      new Request('https://cloud.faro.test/v1/panel/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://cloud.faro.test' },
        body: JSON.stringify({
          restaurant: 'la-spritzzeria',
          username: 'ana',
          password: 'clave-de-ana-2026',
        }),
      }),
      { sql },
    )
    expect(signIn.status).toBe(200)
    const cookie = /__Host-faro_panel=([^;]+)/.exec(signIn.headers.get('set-cookie') ?? '')?.[1]
    const summary = await handle(
      new Request('https://cloud.faro.test/v1/panel/summary', {
        headers: { cookie: `__Host-faro_panel=${cookie}` },
      }),
      { sql },
    )
    expect(summary.status).toBe(200)
    expect(((await summary.json()) as { local: unknown }).local).toMatchObject({
      last_seen_at: null,
      pending: null,
    })
  })

  it('reports over migrated events give the same as over events received live', async () => {
    const order = () => {
      const o = newId()
      const user = newId()
      const fields = {
        business_day: '2026-10-26',
        received_at: '2026-10-26T14:30:00.000Z',
        user_id: user,
      } as Partial<OrderEvent>
      return [
        event(o, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }, fields),
        event(o, 'ItemAdded', itemCopy({ unit_price: 50_000 }), fields),
        event(o, 'PaymentRecorded', cashPaymentData(50_000), fields),
        event(o, 'OrderClosed', {}, fields),
      ]
    }
    const list = [...order(), ...order()].map((e, i) => ({ ...e, sequence: i + 1 }))

    // Migrated database.
    const { sql, db } = await atMigration1()
    const r = newId()
    await insertRestaurant(db, r, 'La Spritzzería')
    const hub = await insertHub(db, r, 'cred')
    for (const e of list) await insertEvent(db, r, hub.id, e as never)
    await db.query('UPDATE hubs SET contiguous_sequence = $2 WHERE id = $1', [hub.id, list.length])
    await migrate(sql)

    // Live database, same events.
    const live = await createWorld()
    const h = await live.newHub()
    await live.cloud.receiveEvents(h.hub, list)

    const panelReport = async (env: { sql: typeof sql }, slug: string, credential: string) => {
      const user = remoteUser('ana', 'clave-de-ana-2026')
      const put = await handle(
        new Request('https://cloud.faro.test/v1/snapshots/remote_users', {
          method: 'PUT',
          headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
          body: JSON.stringify({ fingerprint: 'u', content: [user] }),
        }),
        { sql: env.sql },
      )
      expect(put.status).toBe(204)
      const signIn = await handle(
        new Request('https://cloud.faro.test/v1/panel/sign-in', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://cloud.faro.test' },
          body: JSON.stringify({
            restaurant: slug,
            username: 'ana',
            password: 'clave-de-ana-2026',
          }),
        }),
        { sql: env.sql },
      )
      const cookie = /__Host-faro_panel=([^;]+)/.exec(signIn.headers.get('set-cookie') ?? '')?.[1]
      const report = await handle(
        new Request('https://cloud.faro.test/v1/panel/reports?from=2026-10-26&until=2026-10-26', {
          headers: { cookie: `__Host-faro_panel=${cookie}` },
        }),
        { sql: env.sql, clock: () => new Date('2026-10-26T16:00:00.000Z') },
      )
      expect(report.status).toBe(200)
      return report.json() as Promise<{ report: { sales: { net: number; checks: number } } }>
    }
    const migrated = await panelReport({ sql }, 'la-spritzzeria', 'cred')
    const slug = (
      await live.db.query<{ slug: string }>('SELECT slug FROM restaurants WHERE id = $1', [
        h.restaurantId,
      ])
    ).rows[0]?.slug as string
    const received = await panelReport({ sql: live.sql }, slug, h.credential)
    expect(migrated.report.sales).toMatchObject({ net: 100_000, checks: 2 })
    expect(migrated).toEqual(received)
  })
})
