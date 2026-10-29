import { newId } from '@pos/core'
import { fingerprint } from '@pos/sync'
import { beforeAll, describe, expect, it } from 'vitest'
import { handle } from './api'
import { MAX_SNAPSHOT_BYTES, saveSnapshot } from './snapshots'
import { putSnapshot, remoteUser } from './testing/panel'
import { createWorld, type World } from './testing/world'

// The edges of what the hub uploads for the panel (task 1.11c-1): the size limit to the byte,
// bodies without a length, odd routes and odd content, and two uploads at the same time.

let m: World
beforeAll(async () => {
  m = await createWorld()
})

const put = (path: string, body: BodyInit | null, credential: string, extra: RequestInit = {}) =>
  handle(
    new Request(`https://cloud.faro.test${path}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body,
      ...extra,
    }),
    { sql: m.sql, clock: () => m.clock.now },
  )

/** A `catalog` body whose JSON is exactly `bytes` bytes long. */
function bodyOfSize(bytes: number) {
  const frame = JSON.stringify({ fingerprint: 'tamaño', content: { text: '' } })
  return JSON.stringify({
    fingerprint: 'tamaño',
    content: { text: 'x'.repeat(bytes - new TextEncoder().encode(frame).length) },
  })
}

describe('the size limit', () => {
  it('2 MiB to the byte is accepted and one byte more is refused', async () => {
    const h = await m.newHub()
    const exactly = bodyOfSize(MAX_SNAPSHOT_BYTES)
    expect(new TextEncoder().encode(exactly).length).toBe(MAX_SNAPSHOT_BYTES)
    expect((await put('/v1/snapshots/catalog', exactly, h.credential)).status).toBe(204)
    const over = bodyOfSize(MAX_SNAPSHOT_BYTES + 1)
    expect((await put('/v1/snapshots/catalog', over, h.credential)).status).toBe(413)
  })

  it('without Content-Length (a stream) the limit is still counted while reading', async () => {
    const h = await m.newHub()
    const chunks = (text: string, size: number) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(text)
          for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size))
          controller.close()
        },
      })
    const over = await put(
      '/v1/snapshots/catalog',
      chunks(bodyOfSize(MAX_SNAPSHOT_BYTES + 1), 64 * 1024),
      h.credential,
      { duplex: 'half' } as RequestInit,
    )
    expect(over.status).toBe(413)
    const fits = await put(
      '/v1/snapshots/catalog',
      chunks(bodyOfSize(100_000), 7_000),
      h.credential,
      { duplex: 'half' } as RequestInit,
    )
    expect(fits.status).toBe(204)
  })

  it('a refused big one leaves the previous snapshot as it was', async () => {
    const h = await m.newHub()
    const before = { version: 1, products: ['Spritz'] }
    expect(await putSnapshot(m, h, 'catalog', before)).toBe(204)
    expect(
      (await put('/v1/snapshots/catalog', bodyOfSize(MAX_SNAPSHOT_BYTES + 10), h.credential))
        .status,
    ).toBe(413)
    const [row] = (
      await m.db.query<{ content: unknown; fingerprint: string }>(
        "SELECT content, fingerprint FROM snapshots WHERE restaurant_id = $1 AND kind = 'catalog'",
        [h.restaurantId],
      )
    ).rows
    expect(row?.content).toEqual(before)
    expect(row?.fingerprint).toBe(fingerprint(before))
  })

  it('a thousand people fit; 1.001 do not', async () => {
    const h = await m.newHub()
    const people = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: newId(),
        name: `Persona ${i}`,
        role_id: null,
        active: true,
      }))
    expect(await putSnapshot(m, h, 'people', people(1_000))).toBe(204)
    const users = Array.from({ length: 1_001 }, (_, i) => ({
      ...remoteUser(`usuario${i}`, 'clave'),
    }))
    expect(await putSnapshot(m, h, 'remote_users', users)).toBe(400)
  })
})

describe('routes and verbs', () => {
  it('only PUT /v1/snapshots/<known kind> exists: no reading back, no other verbs, no odd paths', async () => {
    const h = await m.newHub()
    const body = JSON.stringify({ fingerprint: 'x', content: [] })
    const cases: [string, string, number][] = [
      ['GET', '/v1/snapshots/people', 404],
      ['POST', '/v1/snapshots/people', 404],
      ['DELETE', '/v1/snapshots/people', 404],
      ['PUT', '/v1/snapshots/', 404],
      ['PUT', '/v1/snapshots', 404],
      ['PUT', '/v1/snapshots/people/', 404],
      ['PUT', '/v1/snapshots/people/extra', 404],
      ['PUT', '/v1/snapshots/People', 404],
      ['PUT', '/v1/snapshots/people%20', 404],
      ['PUT', `/v1/snapshots/${'a'.repeat(31)}`, 404],
      ['PUT', '/v1/snapshots/unknown', 400],
      ['PUT', '/v1/snapshots/events', 400],
      ['PUT', '/v1/snapshots/__proto__', 400],
    ]
    for (const [method, path, status] of cases) {
      const r = await handle(
        new Request(`https://cloud.faro.test${path}`, {
          method,
          headers: { authorization: `Bearer ${h.credential}`, 'content-type': 'application/json' },
          body: method === 'GET' || method === 'DELETE' ? undefined : body,
        }),
        { sql: m.sql },
      )
      expect(r.status, `${method} ${path}`).toBe(status)
    }
    expect(
      (await m.db.query('SELECT 1 FROM snapshots WHERE restaurant_id = $1', [h.restaurantId])).rows,
    ).toEqual([])
  })

  it('a bad credential gets the same 401 for every kind and nothing about the kind', async () => {
    const h = await m.newHub()
    const body = JSON.stringify({ fingerprint: 'x', content: [] })
    const answers = await Promise.all(
      ['people', 'remote_users', 'nada'].map(async (kind) => {
        const r = await put(`/v1/snapshots/${kind}`, body, `${h.credential}x`)
        return [r.status, await r.text()]
      }),
    )
    // An unknown kind with a bad credential is still 401 (the credential is checked first).
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1)
    expect(answers[0]?.[0]).toBe(401)
  })
})

describe('odd content', () => {
  it('keys like __proto__ are stored as data and pollute nothing', async () => {
    const h = await m.newHub()
    const body =
      '{"fingerprint":"p","content":{"__proto__":{"polluted":true},"constructor":{"x":1}}}'
    const r = await put('/v1/snapshots/catalog', body, h.credential)
    expect(r.status).toBe(204)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('text Postgres cannot keep (a NUL, half a Unicode pair) is a 400, also inside nested data', async () => {
    const h = await m.newHub()
    const raw = (content: string) => `{"fingerprint":"n","content":${content}}`
    for (const content of [
      '{"a":{"b":["\\u0000"]}}',
      '{"a":"\\ud800"}',
      '{"a":"\\udc00 x"}',
      '{"\\u0000":1}',
    ])
      expect((await put('/v1/snapshots/catalog', raw(content), h.credential)).status, content).toBe(
        400,
      )
    // A well-formed pair and every kind of accent is fine.
    expect(
      (await put('/v1/snapshots/catalog', raw('{"a":"ñandú 🍹 café"}'), h.credential)).status,
    ).toBe(204)
  })

  it('deep nesting is a clean answer (accepted or 400), never a 500', async () => {
    const h = await m.newHub()
    for (const depth of [50, 500, 5_000, 50_000]) {
      const body = `{"fingerprint":"d${depth}","content":${'['.repeat(depth)}${']'.repeat(depth)}}`
      const r = await put('/v1/snapshots/catalog', body, h.credential)
      expect([204, 400], `depth ${depth}`).toContain(r.status)
    }
  })

  it('a catalog that is an object with huge numbers and unicode keys is stored faithfully', async () => {
    const h = await m.newHub()
    const content = {
      ñ: 1,
      big: 9_007_199_254_740_991,
      neg: -1.5e-7,
      nested: { 'a b': [null, true, 'x'] },
    }
    expect(await putSnapshot(m, h, 'catalog', content)).toBe(204)
    const [row] = (
      await m.db.query<{ content: unknown }>(
        "SELECT content FROM snapshots WHERE restaurant_id = $1 AND kind = 'catalog'",
        [h.restaurantId],
      )
    ).rows
    expect(row?.content).toEqual(content)
  })

  it('the stored `remote_users` snapshot never holds a verifier or a password hash', async () => {
    const h = await m.newHub()
    const ana = remoteUser('ana', 'clave-de-ana-2026')
    expect(await putSnapshot(m, h, 'remote_users', [ana])).toBe(204)
    const [row] = (
      await m.db.query<{ content: unknown }>(
        "SELECT content::text AS content FROM snapshots WHERE restaurant_id = $1 AND kind = 'remote_users'",
        [h.restaurantId],
      )
    ).rows
    expect(String(row?.content)).not.toContain('scrypt')
    expect(String(row?.content)).not.toContain(ana.verifier.split('$')[5] as string)
    // The log of an error carries no row values either.
    expect(
      await putSnapshot(m, h, 'remote_users', [{ ...ana, verifier: `${ana.verifier}!` }]),
    ).toBe(400)
  })

  it('an unknown field in a person or a user is dropped, never stored', async () => {
    const h = await m.newHub()
    const ana = { ...remoteUser('ana', 'x'), pin: '1234', password: 'clave-en-claro' }
    expect(await putSnapshot(m, h, 'remote_users', [ana])).toBe(204)
    const people = [{ id: newId(), name: 'Ana', role_id: null, active: true, pin: '4321' }]
    expect(await putSnapshot(m, h, 'people', people)).toBe(204)
    const dump = (
      await m.db.query<{ t: string }>(
        `SELECT (SELECT coalesce(string_agg(row_to_json(u)::text, ''), '') FROM remote_users u WHERE restaurant_id = $1)
             || (SELECT coalesce(string_agg(content::text, ''), '') FROM snapshots WHERE restaurant_id = $1) AS t`,
        [h.restaurantId],
      )
    ).rows[0]?.t as string
    expect(dump).not.toContain('1234')
    expect(dump).not.toContain('4321')
    expect(dump).not.toContain('clave-en-claro')
  })
})

describe('two uploads at the same time', () => {
  it('different lists of users: what is left is one of them whole, and its fingerprint says which', async () => {
    const h = await m.newHub()
    const one = [remoteUser('ana', 'clave-1'), remoteUser('luis', 'clave-2')]
    const two = [remoteUser('maria', 'clave-3')]
    const statuses = await Promise.all([
      putSnapshot(m, h, 'remote_users', one),
      putSnapshot(m, h, 'remote_users', two),
    ])
    expect(statuses).toEqual([204, 204])
    const names = (
      await m.db.query<{ username: string }>(
        'SELECT username FROM remote_users WHERE restaurant_id = $1 ORDER BY username',
        [h.restaurantId],
      )
    ).rows.map((r) => r.username)
    const [snapshot] = (
      await m.db.query<{ fingerprint: string; content: { users: number } }>(
        "SELECT fingerprint, content FROM snapshots WHERE restaurant_id = $1 AND kind = 'remote_users'",
        [h.restaurantId],
      )
    ).rows
    const wasOne = names.join() === 'ana,luis'
    expect(wasOne || names.join() === 'maria').toBe(true)
    expect(snapshot?.fingerprint).toBe(fingerprint(wasOne ? one : two))
    expect(snapshot?.content).toEqual({ users: wasOne ? 2 : 1 })
  })

  it('the same list twice at once leaves one copy of each user', async () => {
    const h = await m.newHub()
    const list = [remoteUser('ana', 'clave-1'), remoteUser('luis', 'clave-2')]
    await Promise.all([1, 2, 3].map(() => putSnapshot(m, h, 'remote_users', list)))
    const n = (
      await m.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM remote_users WHERE restaurant_id = $1',
        [h.restaurantId],
      )
    ).rows[0]?.n
    expect(n).toBe(2)
  })

  it('an upload and a revocation at the same time never leave users for a location without PCs', async () => {
    const h = await m.newHub()
    const list = [remoteUser('ana', 'clave-1')]
    await Promise.allSettled([putSnapshot(m, h, 'remote_users', list), m.cloud.revokeHub(h.hub.id)])
    // Whichever came first, once the PC is revoked the list must be empty or the upload refused.
    const left = (
      await m.db.query('SELECT 1 FROM remote_users WHERE restaurant_id = $1', [h.restaurantId])
    ).rows.length
    const [hub] = (
      await m.db.query<{ revoked_at: unknown }>('SELECT revoked_at FROM hubs WHERE id = $1', [
        h.hub.id,
      ])
    ).rows
    expect(hub?.revoked_at).not.toBeNull()
    expect(left).toBe(0)
  })

  // `api.ts` checks the credential and then, in another transaction, `saveSnapshot` writes: a PC
  // revoked in between must not get its users saved (a location without active PCs would open the
  // panel again). `saveSnapshot` checks `hubs.revoked_at` again with the row locked (FOR SHARE).
  // Simulated by using the hub object from before the revocation.
  it('an upload that was already authenticated when the PC got revoked does not bring the users back', async () => {
    const h = await m.newHub()
    expect(await putSnapshot(m, h, 'remote_users', [])).toBe(204)
    await m.cloud.revokeHub(h.hub.id)
    const list = [remoteUser('ana', 'clave-1')]
    await saveSnapshot(
      m.sql,
      h.hub,
      'remote_users',
      { fingerprint: fingerprint(list), content: list },
      m.clock.now,
    )
    const left = (
      await m.db.query('SELECT 1 FROM remote_users WHERE restaurant_id = $1', [h.restaurantId])
    ).rows.length
    expect(left).toBe(0)
  })
})
