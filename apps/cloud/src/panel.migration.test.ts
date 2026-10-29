import { newId } from '@pos/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { slugOf } from './cloud'
import { CLOUD_MIGRATIONS, migrate } from './migrations'
import { emptyDatabase } from './testing/pglite'
import { ADMIN, createWorld, flatEvent, type World } from './testing/world'

// Migration 2 (task 1.11c-1, docs/PANEL.md#migración-2): restaurant slugs, the orders each event
// touches (also for the events already stored), and the panel tables, each restaurant isolated
// by row-level security.

let m: World
beforeAll(async () => {
  m = await createWorld()
})

const asApi = <T>(restaurantId: string | null, job: (tx: World['sql']) => Promise<T>) =>
  m.sql.transaction(async (tx) => {
    if (restaurantId !== null)
      await tx.query("SELECT set_config('faro.restaurant_id', $1, true)", [restaurantId])
    await tx.query('SET LOCAL ROLE faro_data')
    return job(tx)
  })

describe('on a database with migration 1 and data', () => {
  it('gives each restaurant a slug and indexes the orders of the events already stored', async () => {
    const { sql, db } = emptyDatabase()
    await migrate(sql, CLOUD_MIGRATIONS.slice(0, 1))
    const [r1, r2] = [newId(), newId()]
    const hubId = newId()
    await db.query(
      `INSERT INTO restaurants (id, name) VALUES ($1, 'La Spritzzería'), ($2, 'LA SPRITZZERÍA')`,
      [r1, r2],
    )
    await db.query(
      `INSERT INTO hubs (id, restaurant_id, location_id, name, instance, credential_hash)
       VALUES ($1, $2, $3, 'Caja', 'i', 'h')`,
      [hubId, r1, newId()],
    )
    const [a, b, c] = [newId(), newId(), newId()]
    const contents = [
      { id: newId(), aggregate_id: a, related: [b], affects: [c, b] },
      { id: newId(), aggregate_id: b, related: [], affects: [] },
      // A malformed one: only well-formed ids count.
      { id: newId(), aggregate_id: c, related: ['no-es-id', 7, null], affects: 'x' },
      { id: newId(), aggregate_id: a },
    ]
    for (const [i, e] of contents.entries())
      await db.query(
        `INSERT INTO events (restaurant_id, id, hub_id, type, aggregate_type, aggregate_id,
           hub_sequence, business_day, received_at, content, fingerprint)
         VALUES ($1, $2, $3, 'ItemsMoved', 'order', $4, $5, '2026-10-26', now(), $6, 'f')`,
        [r1, e.id, hubId, e.aggregate_id, i + 1, JSON.stringify(e)],
      )
    expect(await migrate(sql)).toEqual([2])
    const slugs = (await db.query<{ id: string; slug: string }>('SELECT id, slug FROM restaurants'))
      .rows
    expect(slugs.find((x) => x.id === r1)?.slug).toBe('la-spritzzeria')
    expect(slugs.find((x) => x.id === r2)?.slug).toBe(
      `la-spritzzeria-${r2.slice(-6).toLowerCase()}`,
    )
    const rows = (
      await db.query<{ event_id: string; aggregate_id: string; hub_sequence: string | number }>(
        'SELECT event_id, aggregate_id, hub_sequence FROM event_aggregates ORDER BY hub_sequence, aggregate_id',
      )
    ).rows.map((r) => [r.event_id, r.aggregate_id, Number(r.hub_sequence)])
    const [e1, e2, e3, e4] = contents.map((e) => e.id)
    expect(rows).toEqual(
      [
        [e1, a, 1],
        [e1, b, 1],
        [e1, c, 1],
        [e2, b, 2],
        [e3, c, 3],
        [e4, a, 4],
      ].sort((x, y) => Number(x[2]) - Number(y[2]) || String(x[1]).localeCompare(String(y[1]))),
    )
  })
})

describe('slugs', () => {
  it('from the name, without accents, in lowercase with dashes', () => {
    expect(slugOf('La Spritzzería')).toBe('la-spritzzeria')
    expect(slugOf('  Ñandú & Café — Envigado ')).toBe('nandu-cafe-envigado')
    expect(slugOf('¡¡!!')).toBe('restaurante')
    expect(slugOf('x'.repeat(200))).toHaveLength(50)
  })

  it('a repeated name gets -2, -3…; one asked for and taken is refused; repeating keeps the first', async () => {
    const [a, b, c, d] = [newId(), newId(), newId(), newId()]
    const name = `Casa ${newId()}`
    const base = slugOf(name)
    expect(await m.cloud.createRestaurant({ id: a, name })).toEqual({
      status: 'created',
      slug: base,
    })
    expect(await m.cloud.createRestaurant({ id: b, name })).toEqual({
      status: 'created',
      slug: `${base}-2`,
    })
    expect(await m.cloud.createRestaurant({ id: a, name: 'Otro' })).toEqual({
      status: 'already_existed',
      slug: base,
    })
    expect(await m.cloud.createRestaurant({ id: c, name, slug: base })).toEqual({
      status: 'slug_taken',
    })
    const own = `propio-${d.toLowerCase().slice(-8)}`
    expect(await m.cloud.createRestaurant({ id: d, name, slug: own })).toEqual({
      status: 'created',
      slug: own,
    })
  })

  it('the admin route accepts a slug and answers with it; a malformed one is 400, a taken one 409', async () => {
    const id = newId()
    const slug = `ruta-${id.toLowerCase().slice(-8)}`
    const r = await m.request('POST', '/v1/admin/restaurants', { id, name: 'R', slug }, ADMIN)
    expect(r.status).toBe(201)
    expect(await r.json()).toEqual({ status: 'created', slug })
    const taken = await m.request(
      'POST',
      '/v1/admin/restaurants',
      { id: newId(), name: 'R', slug },
      ADMIN,
    )
    expect(taken.status).toBe(409)
    for (const bad of ['Con Mayúscula', 'doble--guion', '-borde', 'x'.repeat(61), ''])
      expect(
        (
          await m.request(
            'POST',
            '/v1/admin/restaurants',
            { id: newId(), name: 'R', slug: bad },
            ADMIN,
          )
        ).status,
        bad,
      ).toBe(400)
  })
})

describe('event_aggregates when receiving', () => {
  it('each new event indexes its aggregate, related and affects, once, in the same transaction', async () => {
    const h = await m.newHub()
    const [a, b, c] = [newId(), newId(), newId()]
    const e1 = flatEvent(1, { aggregate_id: a, related: [b], affects: [c, 'mal'] })
    const e2 = flatEvent(2, { aggregate_id: b })
    await m.cloud.receiveEvents(h.hub, [e1, e2])
    await m.cloud.receiveEvents(h.hub, [e1, e2]) // resending does not duplicate
    const rows = (
      await m.db.query<{ event_id: string; aggregate_id: string; hub_id: string }>(
        'SELECT event_id, aggregate_id, hub_id FROM event_aggregates WHERE restaurant_id = $1 ORDER BY 1, 2',
        [h.restaurantId],
      )
    ).rows
    expect(rows).toEqual(
      [
        { event_id: e1.id, aggregate_id: a, hub_id: h.hub.id },
        { event_id: e1.id, aggregate_id: b, hub_id: h.hub.id },
        { event_id: e1.id, aggregate_id: c, hub_id: h.hub.id },
        { event_id: e2.id, aggregate_id: b, hub_id: h.hub.id },
      ].sort((x, y) => (x.event_id + x.aggregate_id).localeCompare(y.event_id + y.aggregate_id)),
    )
  })

  it('a divergent event does not add aggregates; event_aggregates is neither changed nor deleted', async () => {
    const h = await m.newHub()
    const e = flatEvent(1)
    await m.cloud.receiveEvents(h.hub, [e])
    const other = newId()
    await m.cloud.receiveEvents(h.hub, [{ ...e, related: [other], data: { x: 1 } }])
    const n = await m.db.query('SELECT 1 FROM event_aggregates WHERE aggregate_id = $1', [other])
    expect(n.rows).toEqual([])
    await expect(
      m.db.query('UPDATE event_aggregates SET hub_sequence = 9 WHERE restaurant_id = $1', [
        h.restaurantId,
      ]),
    ).rejects.toThrow(/solo se agregan filas/)
    await expect(
      m.db.query('DELETE FROM event_aggregates WHERE restaurant_id = $1', [h.restaurantId]),
    ).rejects.toThrow(/solo se agregan filas/)
  })
})

describe('row-level security of the new tables', () => {
  const TABLES = [
    'event_aggregates',
    'snapshots',
    'remote_users',
    'panel_sessions',
    'panel_attempts',
  ]

  it('inside a restaurant only its rows are seen; outside one, none; another’s cannot be written', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    for (const h of [a, b]) {
      await m.cloud.receiveEvents(h.hub, [flatEvent(1)])
      await m.db.query(
        `INSERT INTO snapshots VALUES ($1, $2, 'people', 'f', '[]', $3, now());
         `.trim(),
        [h.restaurantId, h.hub.locationId, h.hub.id],
      )
      await m.db.query(
        `INSERT INTO remote_users VALUES ($1, $2, $3, 'ana', 'Ana', 'v', ARRAY['remote_access'])`,
        [h.restaurantId, h.hub.locationId, newId()],
      )
      await m.db.query(
        `INSERT INTO panel_sessions VALUES ($1, $2, $3, 's', 'v', now(), now(), now(), NULL)`,
        [newId(), h.restaurantId, newId()],
      )
      await m.db.query(`INSERT INTO panel_attempts VALUES ($1, 'user:ana', 1, now(), now())`, [
        h.restaurantId,
      ])
    }
    for (const t of TABLES) {
      const seen = await asApi(a.restaurantId, (tx) =>
        tx.query<{ restaurant_id: string }>(`SELECT restaurant_id FROM ${t}`),
      )
      expect(seen.length, t).toBeGreaterThan(0)
      expect(new Set(seen.map((r) => r.restaurant_id)), t).toEqual(new Set([a.restaurantId]))
      expect(await asApi(null, (tx) => tx.query(`SELECT 1 FROM ${t}`)), t).toEqual([])
    }
    await expect(
      asApi(a.restaurantId, (tx) =>
        tx.query(`INSERT INTO panel_attempts VALUES ($1, 'user:x', 1, now(), now())`, [
          b.restaurantId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(
      asApi(a.restaurantId, (tx) =>
        tx.query(
          `INSERT INTO remote_users VALUES ($1, $2, $3, 'eva', 'Eva', 'v', ARRAY['remote_access'])`,
          [b.restaurantId, b.hub.locationId, newId()],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // Deleting another restaurant's users does nothing.
    await asApi(a.restaurantId, (tx) =>
      tx.query('DELETE FROM remote_users WHERE restaurant_id = $1', [b.restaurantId]),
    )
    expect(
      (await m.db.query('SELECT 1 FROM remote_users WHERE restaurant_id = $1', [b.restaurantId]))
        .rows,
    ).toHaveLength(1)
  })

  it('the API role cannot change the columns it does not need, delete sessions or read credentials', async () => {
    const h = await m.newHub()
    for (const q of [
      'UPDATE panel_sessions SET secret_hash = $2 WHERE restaurant_id = $1',
      'UPDATE panel_sessions SET user_id = $2 WHERE restaurant_id = $1',
      'UPDATE snapshots SET kind = $2 WHERE restaurant_id = $1',
      'UPDATE hubs SET location_id = $2 WHERE restaurant_id = $1',
      'UPDATE restaurants SET slug = $2 WHERE id = $1',
      'DELETE FROM panel_sessions WHERE restaurant_id = $1 AND $2 = $2',
      'SELECT credential_hash FROM hubs WHERE restaurant_id = $1 AND $2 = $2',
      'DELETE FROM snapshots WHERE restaurant_id = $1 AND $2 = $2',
    ])
      await expect(
        asApi(h.restaurantId, (tx) => tx.query(q, [h.restaurantId, 'x'])),
        q,
      ).rejects.toThrow(/permission denied/)
  })

  it('panel_session_restaurant says only which restaurant a session is from', async () => {
    const h = await m.newHub()
    const id = newId()
    await m.db.query(
      `INSERT INTO panel_sessions VALUES ($1, $2, $3, 's', 'v', now(), now(), now(), NULL)`,
      [id, h.restaurantId, newId()],
    )
    const [found] = await asApi(null, (tx) =>
      tx.query<{ r: string | null }>('SELECT panel_session_restaurant($1) AS r', [id]),
    )
    expect(found?.r).toBe(h.restaurantId)
    const [missing] = await asApi(null, (tx) =>
      tx.query<{ r: string | null }>('SELECT panel_session_restaurant($1) AS r', [newId()]),
    )
    expect(missing?.r).toBeNull()
  })
})
