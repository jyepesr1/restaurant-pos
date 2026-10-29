import { newId } from '@pos/core'
import { fingerprint } from '@pos/sync'
import { beforeAll, describe, expect, it } from 'vitest'
import { handle } from './api'
import { putSnapshot, remoteUser, verifierFor } from './testing/panel'
import { batch, createWorld, type World } from './testing/world'

// What the hub uploads besides events for the panel (task 1.11c-1, docs/PANEL.md): read-only
// snapshots, the list of who can sign in, and the heartbeat with how far it has.

let m: World
beforeAll(async () => {
  m = await createWorld()
})

// biome-ignore lint/suspicious/noExplicitAny: rows of several tables, compared field by field
type AnyRow = Record<string, any>
const rowsOf = async (table: string, restaurantId: string) =>
  (await m.db.query<AnyRow>(`SELECT * FROM ${table} WHERE restaurant_id = $1`, [restaurantId])).rows

const people = [
  { id: newId(), name: 'Ana', role_id: newId(), active: true },
  { id: newId(), name: 'Luis', role_id: null, active: false },
]

describe('PUT /v1/snapshots/:kind', () => {
  it('saves each kind for the hub’s location; the same fingerprint again only updates who and when', async () => {
    const h = await m.newHub()
    const contents = {
      catalog: { categories: [], products: [{ id: newId(), name: 'Spritz' }] },
      config: { config: { business_day_start: '06:00' }, time_zone: 'America/Bogota' },
      people,
      roles: [{ id: newId(), name: 'Administrador', permissions: ['view_reports'], active: true }],
    }
    for (const [kind, content] of Object.entries(contents))
      expect(await putSnapshot(m, h, kind, content), kind).toBe(204)
    const stored = await rowsOf('snapshots', h.restaurantId)
    expect(stored.map((r) => r.kind).sort()).toEqual(['catalog', 'config', 'people', 'roles'])
    for (const r of stored) {
      expect(r.location_id).toBe(h.hub.locationId)
      expect(r.hub_id).toBe(h.hub.id)
      expect(r.content).toEqual(contents[r.kind as keyof typeof contents])
    }
    const before = (await rowsOf('snapshots', h.restaurantId)).find((r) => r.kind === 'people')
    m.clock.now = new Date(m.clock.now.getTime() + 60_000)
    expect(await putSnapshot(m, h, 'people', people)).toBe(204)
    const after = (await rowsOf('snapshots', h.restaurantId)).find((r) => r.kind === 'people')
    expect(after?.content).toEqual(before?.content)
    expect(after?.fingerprint).toBe(before?.fingerprint)
    expect(after?.uploaded_at).toEqual(m.clock.now)
  })

  it('the catalog with its version, and the kitchen screens’ users and hidden role, are accepted', async () => {
    const h = await m.newHub()
    const screenRole = newId()
    expect(
      await putSnapshot(m, h, 'catalog', { version: 12, restaurant: { name: 'R', brand: null } }),
    ).toBe(204)
    expect(
      await putSnapshot(m, h, 'roles', [
        {
          id: screenRole,
          name: 'Pantalla',
          permissions: ['mark_ready'],
          active: true,
          hidden: true,
        },
      ]),
    ).toBe(204)
    expect(
      await putSnapshot(m, h, 'people', [
        {
          id: newId(),
          name: 'Pantalla de cocina',
          role_id: screenRole,
          active: true,
          kind: 'screen',
        },
      ]),
    ).toBe(204)
  })

  it('a newer one replaces the previous one: only the last of each kind is kept', async () => {
    const h = await m.newHub()
    expect(await putSnapshot(m, h, 'people', people)).toBe(204)
    const more = [...people, { id: newId(), name: 'Sara', role_id: null, active: true }]
    expect(await putSnapshot(m, h, 'people', more)).toBe(204)
    const stored = await rowsOf('snapshots', h.restaurantId)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.content).toEqual(more)
    expect(stored[0]?.fingerprint).toBe(fingerprint(more))
  })

  it('fields the hub did not mean to share are not stored (a PIN, say)', async () => {
    const h = await m.newHub()
    const withPin = people.map((p) => ({ ...p, pin_hash: 'abc', password_hash: 'x' }))
    expect(await putSnapshot(m, h, 'people', withPin)).toBe(204)
    const [stored] = await rowsOf('snapshots', h.restaurantId)
    expect(JSON.stringify(stored?.content)).not.toMatch(/pin_hash|password_hash/)
  })

  it('remote_users replaces who can sign in, whole; its snapshot keeps only how many there are', async () => {
    const h = await m.newHub()
    const ana = remoteUser('ana', 'clave-de-ana-1')
    const luis = remoteUser('luis', 'clave-de-luis-1')
    expect(await putSnapshot(m, h, 'remote_users', [ana, luis])).toBe(204)
    expect((await rowsOf('remote_users', h.restaurantId)).map((u) => u.username).sort()).toEqual([
      'ana',
      'luis',
    ])
    expect(await putSnapshot(m, h, 'remote_users', [luis])).toBe(204)
    const users = await rowsOf('remote_users', h.restaurantId)
    expect(users).toEqual([
      {
        restaurant_id: h.restaurantId,
        location_id: h.hub.locationId,
        user_id: luis.user_id,
        username: 'luis',
        name: 'luis',
        verifier: luis.verifier,
        permissions: luis.permissions,
      },
    ])
    const [snapshot] = await rowsOf('snapshots', h.restaurantId)
    expect(snapshot?.content).toEqual({ users: 1 })
    expect(JSON.stringify(snapshot)).not.toContain('scrypt$')
    // Nobody left: the table is empty.
    expect(await putSnapshot(m, h, 'remote_users', [])).toBe(204)
    expect(await rowsOf('remote_users', h.restaurantId)).toEqual([])
  })

  it('formats it does not accept give 400 and change nothing', async () => {
    const h = await m.newHub()
    const ana = remoteUser('ana', 'clave-de-ana-1')
    expect(await putSnapshot(m, h, 'remote_users', [ana])).toBe(204)
    const bad: [string, unknown][] = [
      ['remote_users', [{ ...ana, verifier: 'texto-plano' }]],
      ['remote_users', [{ ...ana, verifier: `bcrypt$${ana.verifier.slice(7)}` }]],
      ['remote_users', [{ ...ana, username: 'Ana Pérez' }]],
      ['remote_users', [ana, { ...ana, user_id: newId() }]],
      ['remote_users', [ana, { ...ana, username: 'otra' }]],
      ['config', { config: {}, time_zone: 'Marte/Olympus' }],
      ['config', { config: {} }],
      ['people', [{ id: '', name: 'X', role_id: null, active: true }]],
      ['people', [{ id: newId(), name: 'X', role_id: null, active: 'yes' }]],
      ['people', { not: 'a list' }],
      ['catalog', ['a list']],
      ['catalog', { name: `con nulo ${String.fromCharCode(0)}` }],
    ]
    for (const [kind, content] of bad)
      expect(await putSnapshot(m, h, kind, content), JSON.stringify(content)).toBe(400)
    const malformed = [
      {},
      { content: [] },
      { fingerprint: '', content: [] },
      { fingerprint: 'x', content: [], extra: 1 },
    ]
    for (const body of malformed)
      expect(
        (await m.request('PUT', '/v1/snapshots/people', body, h.credential)).status,
        JSON.stringify(body),
      ).toBe(400)
    expect((await m.request('PUT', '/v1/snapshots/people', 'no json', h.credential)).status).toBe(
      400,
    )
    expect(
      (
        await m.request(
          'PUT',
          '/v1/snapshots/orders',
          { fingerprint: 'x', content: [] },
          h.credential,
        )
      ).status,
    ).toBe(400)
    expect((await rowsOf('remote_users', h.restaurantId)).map((u) => u.username)).toEqual(['ana'])
  })

  it('without a valid credential nothing is saved (401); over 2 MB gives 413', async () => {
    const h = await m.newHub()
    const body = { fingerprint: 'x', content: people }
    expect((await m.request('PUT', '/v1/snapshots/people', body)).status).toBe(401)
    expect((await m.request('PUT', '/v1/snapshots/people', body, 'inventada')).status).toBe(401)
    await m.cloud.revokeHub(h.hub.id)
    expect((await m.request('PUT', '/v1/snapshots/people', body, h.credential)).status).toBe(401)
    expect(await rowsOf('snapshots', h.restaurantId)).toEqual([])

    const g = await m.newHub()
    const big = { fingerprint: 'x', content: { text: 'x'.repeat(2 * 1024 * 1024) } }
    expect((await m.request('PUT', '/v1/snapshots/catalog', big, g.credential)).status).toBe(413)
    const fits = { fingerprint: 'y', content: { text: 'x'.repeat(1024 * 1024) } }
    expect((await m.request('PUT', '/v1/snapshots/catalog', fits, g.credential)).status).toBe(204)
  })

  it('two hubs of different restaurants each keep their own, even with the same fingerprint', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    expect(await putSnapshot(m, a, 'people', people)).toBe(204)
    expect(await putSnapshot(m, b, 'people', people)).toBe(204)
    expect(await rowsOf('snapshots', a.restaurantId)).toHaveLength(1)
    expect(await rowsOf('snapshots', b.restaurantId)).toHaveLength(1)
    const ana = remoteUser('ana', 'clave-1-de-ana')
    expect(await putSnapshot(m, a, 'remote_users', [ana])).toBe(204)
    expect(await putSnapshot(m, b, 'remote_users', [])).toBe(204)
    expect(await rowsOf('remote_users', a.restaurantId)).toHaveLength(1)
  })

  it('a verifier with an absurd cost is refused (it would not fit in a Worker)', async () => {
    const h = await m.newHub()
    const ana = remoteUser('ana', 'x')
    const absurd = { ...ana, verifier: ana.verifier.replace(/^scrypt\$4\$/, 'scrypt$999$') }
    expect(await putSnapshot(m, h, 'remote_users', [absurd])).toBe(400)
    expect(verifierFor('x')).toMatch(/^scrypt\$4\$8\$1\$/)
  })
})

describe('heartbeat', () => {
  const hubRow = async (id: string) =>
    (
      await m.db.query<{ last_seen_at: Date | null; hub_max_sequence: string | number | null }>(
        'SELECT last_seen_at, hub_max_sequence FROM hubs WHERE id = $1',
        [id],
      )
    ).rows[0]

  function fetchLast(credential: string, header?: string) {
    return handle(
      new Request('https://cloud.faro.test/v1/events/last', {
        headers: {
          authorization: `Bearer ${credential}`,
          ...(header === undefined ? {} : { 'x-faro-hub-max': header }),
        },
      }),
      { sql: m.sql, clock: () => m.clock.now },
    )
  }

  it('GET /v1/events/last saves when the hub called and how far it has', async () => {
    const h = await m.newHub()
    expect(await hubRow(h.hub.id)).toEqual({ last_seen_at: null, hub_max_sequence: null })
    m.clock.now = new Date('2026-10-29T18:00:00.000Z')
    const r = await fetchLast(h.credential, '42')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ last_sequence: 0 })
    const row = await hubRow(h.hub.id)
    expect(row?.last_seen_at?.toISOString()).toBe('2026-10-29T18:00:00.000Z')
    expect(Number(row?.hub_max_sequence)).toBe(42)
  })

  it('a missing or malformed header only updates the time, never the sequence', async () => {
    const h = await m.newHub()
    await fetchLast(h.credential, '7')
    for (const header of [undefined, '', '-1', '1.5', 'abc', '1e3', '99999999999999999999', ' ']) {
      m.clock.now = new Date(m.clock.now.getTime() + 1000)
      const r = await fetchLast(h.credential, header)
      expect(r.status, String(header)).toBe(200)
      const row = await hubRow(h.hub.id)
      expect(Number(row?.hub_max_sequence), String(header)).toBe(7)
      expect(row?.last_seen_at?.getTime()).toBe(m.clock.now.getTime())
    }
    await fetchLast(h.credential, '0')
    expect(Number((await hubRow(h.hub.id))?.hub_max_sequence)).toBe(0)
  })

  it('uploading events also counts as a heartbeat; a revoked hub does not update anything', async () => {
    const h = await m.newHub()
    m.clock.now = new Date('2026-10-29T19:00:00.000Z')
    const r = await m.request('POST', '/v1/events', { events: batch(1, 3) }, h.credential)
    expect(r.status).toBe(200)
    expect((await hubRow(h.hub.id))?.last_seen_at?.toISOString()).toBe('2026-10-29T19:00:00.000Z')
    await m.cloud.revokeHub(h.hub.id)
    m.clock.now = new Date('2026-10-29T20:00:00.000Z')
    expect((await fetchLast(h.credential, '99')).status).toBe(401)
    const row = await hubRow(h.hub.id)
    expect(row?.last_seen_at?.toISOString()).toBe('2026-10-29T19:00:00.000Z')
    expect(row?.hub_max_sequence).toBeNull()
  })
})
