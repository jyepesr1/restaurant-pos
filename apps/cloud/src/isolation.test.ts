import { newId } from '@pos/core'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  batch,
  count,
  createWorld,
  flatEvent,
  SEED,
  savedEvents,
  ulid,
  type World,
} from './testing/world'

// Several restaurants in the same database (ADR-016): nothing from one shows up in another,
// neither through the API nor inside the database with the API role (row-level security).

let m: World
beforeAll(async () => {
  m = await createWorld()
})

/** Runs the job like the API does: in a single-restaurant transaction, with the limited role. */
const asApi = <T>(restaurantId: string | null, job: (tx: World['sql']) => Promise<T>) =>
  m.sql.transaction(async (tx) => {
    if (restaurantId !== null)
      await tx.query("SELECT set_config('faro.restaurant_id', $1, true)", [restaurantId])
    await tx.query('SET LOCAL ROLE faro_data')
    return job(tx)
  })

const insertEvent =
  (restaurantId: string, hubId: string, id = newId()) =>
  (tx: World['sql']) =>
    tx.query(
      `INSERT INTO events (restaurant_id, id, hub_id, type, aggregate_type, aggregate_id,
       hub_sequence, business_day, received_at, content, fingerprint)
     VALUES ($1, $2, $3, 't', 'order', $2, 1, '2026-10-26', now(), '{}', 'h')`,
      [restaurantId, id, hubId],
    )

describe('through the API', () => {
  it('with two restaurants uploading the same event id, each one saves and sees its own', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    // Same ids, but different content in each restaurant.
    const fromA = batch(1, 5).map((e) => ({ ...e, data: { owner: 'A' } }))
    const fromB = batch(1, 5).map((e) => ({ ...e, data: { owner: 'B' } }))
    const ra = await m.cloud.receiveEvents(a.hub, fromA)
    const rb = await m.cloud.receiveEvents(b.hub, fromB)
    // For B it is neither "already stored" nor "divergent": the id did not exist in its restaurant.
    expect(ra.map((r) => r.status)).toEqual(Array(5).fill('saved'))
    expect(rb.map((r) => r.status)).toEqual(Array(5).fill('saved'))
    expect(await count(m.db, 'divergent_events', a.restaurantId)).toBe(0)
    expect(await count(m.db, 'divergent_events', b.restaurantId)).toBe(0)
    for (const [h, owner] of [
      [a, 'A'],
      [b, 'B'],
    ] as const) {
      const rows = await savedEvents(m.db, h.restaurantId)
      expect(rows).toHaveLength(5)
      expect(
        rows.every((f) => (f.content as { data: { owner: string } }).data.owner === owner),
      ).toBe(true)
      expect(rows.every((f) => f.hub_id === h.hub.id)).toBe(true)
    }
  })

  it("one's last_sequence does not move because of what the other uploads", async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    await m.cloud.receiveEvents(a.hub, batch(1, 20))
    expect(await m.cloud.lastSequence(a.hub)).toBe(20)
    expect(await m.cloud.lastSequence(b.hub)).toBe(0)
    await m.cloud.receiveEvents(b.hub, batch(1, 3))
    expect(await m.cloud.lastSequence(a.hub)).toBe(20)
    expect(await m.cloud.lastSequence(b.hub)).toBe(3)
  })

  it("over HTTP: one's credential neither uploads nor reads anything of the other", async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    const r = await m.request('POST', '/v1/events', { events: batch(1, 4) }, a.credential)
    expect(r.status).toBe(200)
    const fromB = await (await m.request('GET', '/v1/events/last', undefined, b.credential)).json()
    expect(fromB).toEqual({ last_sequence: 0 })
    expect(await count(m.db, 'events', b.restaurantId)).toBe(0)
  })

  it("an event that declares another restaurant or hub in its body is saved in the uploading hub's restaurant", async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    const fake = flatEvent(1, {
      restaurant_id: b.restaurantId,
      hub_id: b.hub.id,
      data: { restaurant_id: b.restaurantId },
    })
    const [r] = await m.cloud.receiveEvents(a.hub, [fake])
    expect(r?.status).toBe('saved')
    expect(await count(m.db, 'events', b.restaurantId)).toBe(0)
    const [row] = await savedEvents(m.db, a.restaurantId)
    expect(row?.hub_id).toBe(a.hub.id)
  })

  it('property: with k restaurants and random batches, each one ends up with exactly its own', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uniqueArray(fc.integer({ min: 1, max: 30 }), { maxLength: 15 }), {
          minLength: 2,
          maxLength: 4,
        }),
        async (byRestaurant) => {
          const hubs = await Promise.all(byRestaurant.map(() => m.newHub()))
          await Promise.all(
            hubs.map((h, i) =>
              m.cloud.receiveEvents(
                h.hub,
                (byRestaurant[i] ?? []).map((n) => flatEvent(n, { data: { src: h.restaurantId } })),
              ),
            ),
          )
          for (const [i, h] of hubs.entries()) {
            const rows = await savedEvents(m.db, h.restaurantId)
            expect(rows.map((f) => f.id).sort()).toEqual(
              (byRestaurant[i] ?? []).map((n) => ulid(n, 'E')).sort(),
            )
            expect(
              rows.every(
                (f) => (f.content as { data: { src: string } }).data.src === h.restaurantId,
              ),
            ).toBe(true)
          }
        },
      ),
      { seed: SEED, numRuns: 15 },
    )
  })

  it("another restaurant's registration does not get mixed up: the code sets the restaurant", async () => {
    const a = await m.newHub()
    const rb = newId()
    await m.cloud.createRestaurant({ id: rb, name: 'B' })
    const cb = await m.cloud.createCode(rb)
    if (!cb) throw new Error('no code')
    const r = await m.cloud.registerHub({
      code: cb.code,
      restaurant_id: rb,
      hub_id: newId(),
      location_id: a.hub.locationId,
      name: 'Caja B',
      instance: 'i',
    })
    if (!r.ok) throw new Error(r.reason)
    expect(r.restaurantId).toBe(rb)
    const hub = await m.cloud.authenticate(r.credential)
    expect(hub?.restaurantId).toBe(rb)
  })
})

describe('inside the database, with the API role', () => {
  it('without stating the restaurant nothing is seen or written; with an empty or made-up string, neither', async () => {
    const a = await m.newHub()
    await m.cloud.receiveEvents(a.hub, batch(1, 3))
    for (const rest of [null, '', 'inventado', newId()]) {
      expect(await asApi(rest, (tx) => tx.query('SELECT 1 FROM events')), String(rest)).toEqual([])
      expect(
        await asApi(rest, (tx) => tx.query('SELECT 1 FROM divergent_events')),
        String(rest),
      ).toEqual([])
      await expect(asApi(rest, insertEvent(a.restaurantId, a.hub.id))).rejects.toThrow(
        /row-level security/,
      )
    }
  })

  it('read: a query without a filter, or one that deliberately asks for another restaurant, sees nothing foreign', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    await m.cloud.receiveEvents(a.hub, batch(1, 3))
    await m.cloud.receiveEvents(b.hub, batch(1, 4))
    const seenByA = await asApi(a.restaurantId, (tx) =>
      tx.query<{ r: string }>('SELECT DISTINCT restaurant_id AS r FROM events'),
    )
    expect(seenByA).toEqual([{ r: a.restaurantId }])
    const foreignRows = await asApi(a.restaurantId, (tx) =>
      tx.query('SELECT * FROM events WHERE restaurant_id = $1', [b.restaurantId]),
    )
    expect(foreignRows).toEqual([])
    const byHub = await asApi(a.restaurantId, (tx) =>
      tx.query('SELECT * FROM events WHERE hub_id = $1', [b.hub.id]),
    )
    expect(byHub).toEqual([])
    const [check] = await asApi(b.restaurantId, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM events'),
    )
    expect(check?.n).toBe(4)
  })

  it('write: the policy rejects an event or a conflict of another restaurant', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    await expect(asApi(a.restaurantId, insertEvent(b.restaurantId, b.hub.id))).rejects.toThrow(
      /row-level security/,
    )
    await expect(
      asApi(a.restaurantId, (tx) =>
        tx.query(
          `INSERT INTO divergent_events (restaurant_id, event_id, hub_id, content, fingerprint)
           VALUES ($1, $2, $3, '{}', 'h')`,
          [b.restaurantId, ulid(1, 'E'), b.hub.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    expect(await count(m.db, 'events', b.restaurantId)).toBe(0)
    expect(await count(m.db, 'divergent_events', b.restaurantId)).toBe(0)
  })

  it('writing with its own restaurant does work (the policy does not over-block)', async () => {
    const a = await m.newHub()
    await asApi(a.restaurantId, insertEvent(a.restaurantId, a.hub.id))
    expect(await count(m.db, 'events', a.restaurantId)).toBe(1)
  })

  it('the role cannot change or delete events, delete hubs or touch conflicts', async () => {
    const a = await m.newHub()
    await m.cloud.receiveEvents(a.hub, batch(1, 2))
    await m.cloud.receiveEvents(a.hub, [flatEvent(1, { data: { other: 1 } })])
    const statements = [
      "UPDATE events SET type = 'x'",
      'DELETE FROM events',
      "UPDATE divergent_events SET fingerprint = 'x'",
      'DELETE FROM divergent_events',
      'DELETE FROM hubs',
      'DELETE FROM restaurants',
      "UPDATE restaurants SET name = 'x'",
      'DELETE FROM registration_codes',
      `UPDATE hubs SET restaurant_id = '${ulid(1, 'R')}'`,
      "UPDATE hubs SET name = 'x'",
      'TRUNCATE events',
      'INSERT INTO migrations (version, name, fingerprint) VALUES (99, $$x$$, $$x$$)',
      'CREATE TABLE intruso (a int)',
      'ALTER TABLE events DISABLE ROW LEVEL SECURITY',
      'DROP POLICY events_of_restaurant ON events',
    ]
    for (const s of statements)
      await expect(
        asApi(a.restaurantId, (tx) => tx.query(s)),
        s,
      ).rejects.toThrow(/permission denied|must be owner|row-level security/)
    expect(await count(m.db, 'events', a.restaurantId)).toBe(2)
    expect(await count(m.db, 'hubs')).toBeGreaterThan(0)
  })

  it('even if the role tries to see another restaurant by switching role or setting, it leaves the limited role only if it is the owner', async () => {
    // The API role cannot become superuser again with RESET ROLE inside the API transaction (in
    // production its login role is faro_api, which only has faro_data). What is guaranteed here
    // is that the policies' role does not bypass row-level security.
    const [r] = (
      await m.db.query<{ rolbypassrls: boolean; rolsuper: boolean; rolcanlogin: boolean }>(
        "SELECT rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = 'faro_data'",
      )
    ).rows
    expect(r).toEqual({ rolbypassrls: false, rolsuper: false, rolcanlogin: false })
    const sqlTables = (
      await m.db.query<{ relname: string; relrowsecurity: boolean }>(
        "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('events', 'divergent_events')",
      )
    ).rows
    expect(sqlTables.map((t) => t.relrowsecurity)).toEqual([true, true])
  })

  it('last_sequence and the hub records do not depend on the active restaurant', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    await m.cloud.receiveEvents(a.hub, batch(1, 3))
    // Only each one's hub row is read.
    expect(await m.cloud.lastSequence(a.hub)).toBe(3)
    expect(await m.cloud.lastSequence(b.hub)).toBe(0)
  })
})
