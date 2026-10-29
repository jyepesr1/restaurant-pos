import { newId } from '@pos/core'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { handle } from './api'
import { CODE_TTL_MS, normalizeCode } from './cloud'
import { ADMIN, batch, createWorld, NOW, SEED, type World } from './testing/world'

// Registering a hub with a code (ADR-016): a single hub per code, 24-hour validity, retries by
// the same hub, and credentials that do not work if made up or if the hub was revoked.

let m: World
beforeAll(async () => {
  m = await createWorld()
})

async function restaurantWithCode() {
  const restaurant = newId()
  await m.cloud.createRestaurant({ id: restaurant, name: 'R' })
  const c = await m.cloud.createCode(restaurant)
  if (!c) throw new Error('no code')
  restaurantOfCode.set(normalizeCode(c.code), restaurant)
  return { restaurant, code: c.code, expiresAt: c.expiresAt }
}

const newCodeFor = async (restaurant: string) => {
  const c = await m.cloud.createCode(restaurant)
  if (!c) throw new Error('no code')
  restaurantOfCode.set(normalizeCode(c.code), restaurant)
  return c.code
}

/** The code's restaurant, so `record` does not have to be told it every time. */
const restaurantOfCode = new Map<string, string>()

const record = (code: string, hubId = newId(), extras: Record<string, unknown> = {}) =>
  m.request('POST', '/v1/hubs/register', {
    code,
    restaurant_id: restaurantOfCode.get(normalizeCode(code)) ?? newId(),
    hub_id: hubId,
    location_id: newId(),
    name: 'Caja',
    instance: 'i',
    ...extras,
  })

const hubsOf = async (restaurant: string) =>
  (await m.db.query<{ id: string }>('SELECT id FROM hubs WHERE restaurant_id = $1', [restaurant]))
    .rows

describe('single-use code', () => {
  it('with concurrent registrations of the same code, only one wins', async () => {
    const { restaurant, code } = await restaurantWithCode()
    const responses = await Promise.all(Array.from({ length: 8 }, () => record(code)))
    const statuses = responses.map((r) => r.status).sort()
    expect(statuses).toEqual([201, 403, 403, 403, 403, 403, 403, 403])
    expect(await hubsOf(restaurant)).toHaveLength(1)
  })

  it('with the same code written in several ways at once, only one wins', async () => {
    const { restaurant, code } = await restaurantWithCode()
    const shapes = [
      code,
      code.toLowerCase(),
      code.replaceAll('-', ''),
      ` ${code} `,
      code.replaceAll('-', ' '),
    ]
    const responses = await Promise.all(shapes.map((c) => record(c)))
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1)
    expect(await hubsOf(restaurant)).toHaveLength(1)
  })

  it('the same hub repeating the registration at once with the same code: a single valid credential remains', async () => {
    const { restaurant, code } = await restaurantWithCode()
    const hubId = newId()
    const responses = await Promise.all(Array.from({ length: 4 }, () => record(code, hubId)))
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201])
    expect(await hubsOf(restaurant)).toHaveLength(1)
    const credentials = await Promise.all(
      responses.map(async (r) => ((await r.json()) as { credential: string }).credential),
    )
    const authenticated = await Promise.all(credentials.map((c) => m.cloud.authenticate(c)))
    expect(authenticated.filter((h) => h !== null)).toHaveLength(1)
  })

  it('a code used by another hub does not work for a third one', async () => {
    const { code } = await restaurantWithCode()
    expect((await record(code)).status).toBe(201)
    expect((await record(code)).status).toBe(403)
    expect((await record(code.toLowerCase())).status).toBe(403)
  })

  it('the same hub can repeat the registration with its code (lost response): new credential, the previous one stops working', async () => {
    const { restaurant, code } = await restaurantWithCode()
    const hubId = newId()
    const first = (await (await record(code, hubId)).json()) as { credential: string }
    const r2 = await record(code, hubId)
    expect(r2.status).toBe(201)
    const second = (await r2.json()) as { credential: string; restaurant_id: string }
    expect(second.restaurant_id).toBe(restaurant)
    expect(second.credential).not.toBe(first.credential)
    expect(await m.cloud.authenticate(first.credential)).toBeNull()
    expect((await m.cloud.authenticate(second.credential))?.id).toBe(hubId)
    expect(await hubsOf(restaurant)).toHaveLength(1)
  })

  it('retrying after the code expires no longer works', async () => {
    const { code } = await restaurantWithCode()
    const hubId = newId()
    expect((await record(code, hubId)).status).toBe(201)
    m.clock.now = new Date(NOW.getTime() + CODE_TTL_MS + 1)
    try {
      expect((await record(code, hubId)).status).toBe(403)
    } finally {
      m.clock.now = NOW
    }
  })

  it('the same hub with another code is 409 and the other code stays unused', async () => {
    const a = await restaurantWithCode()
    const hubId = newId()
    expect((await record(a.code, hubId)).status).toBe(201)
    const other = await newCodeFor(a.restaurant)
    expect((await record(other, hubId)).status).toBe(409)
    // The code that was not spent still works for a different hub.
    expect((await record(other)).status).toBe(201)
  })

  it('the same hub with two different codes at once: one wins and the other is 409, never 500', async () => {
    const a = await restaurantWithCode()
    const other = await newCodeFor(a.restaurant)
    const hubId = newId()
    const [r1, r2] = await Promise.all([record(a.code, hubId), record(other, hubId)])
    expect([r1.status, r2.status].sort()).toEqual([201, 409])
  })

  it('a revoked hub cannot register again with its code', async () => {
    const { code } = await restaurantWithCode()
    const hubId = newId()
    const { credential } = (await (await record(code, hubId)).json()) as { credential: string }
    expect(
      (await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: hubId }, ADMIN)).status,
    ).toBe(204)
    expect((await record(code, hubId)).status).toBe(403)
    expect(await m.cloud.authenticate(credential)).toBeNull()
  })

  it('neither the code nor the credential is stored in plain text: only their fingerprint', async () => {
    const { code } = await restaurantWithCode()
    const { credential } = (await (await record(code)).json()) as { credential: string }
    const saved = JSON.stringify([
      (await m.db.query('SELECT * FROM registration_codes')).rows,
      (await m.db.query('SELECT * FROM hubs')).rows,
    ])
    expect(saved).not.toContain(credential)
    expect(saved).not.toContain(normalizeCode(code))
    expect(saved).not.toContain(code)
  })
})

describe('mistyped code', () => {
  /** Mixes case, spaces and dashes without changing the code's characters. */
  const writeOp = fc.record({
    lowercase: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
    separators: fc.array(fc.constantFrom('', '', '', ' ', '-', '--', ' - ', '\t'), {
      minLength: 13,
      maxLength: 13,
    }),
  })

  it('property: uppercase, lowercase, spaces and dashes anywhere are still the same code', async () => {
    await fc.assert(
      fc.asyncProperty(writeOp, async ({ lowercase, separators }) => {
        const { restaurant, code } = await restaurantWithCode()
        const letters = code.replaceAll('-', '')
        const written = [...letters]
          .map((c, i) => `${separators[i]}${lowercase[i] ? c.toLowerCase() : c}`)
          .join('')
          .concat(separators[12] ?? '')
        expect(written.length).toBeLessThanOrEqual(40)
        const r = await record(written)
        expect(r.status, JSON.stringify(written)).toBe(201)
        expect(await hubsOf(restaurant)).toHaveLength(1)
      }),
      { seed: SEED, numRuns: 30 },
    )
  })

  it('a changed, missing or extra character, or confusable characters: 403 and the code still works', async () => {
    const { restaurant, code } = await restaurantWithCode()
    const letters = code.replaceAll('-', '')
    const another = letters[0] === 'A' ? 'B' : 'A'
    const badCodes = [
      `${another}${letters.slice(1)}`,
      letters.slice(1),
      letters.slice(0, -1),
      `${letters}A`,
      `A${letters}`,
      letters.replaceAll(/[A-Z]/g, '0'),
      letters.replaceAll(/[2-9]/g, 'O'),
      `${letters.slice(0, 6)}${letters.slice(6).toLowerCase().replace(/[a-z]/, 'l')}`,
    ].filter((c) => normalizeCode(c) !== letters)
    for (const badCase of badCodes) expect((await record(badCase)).status, badCase).toBe(403)
    expect(await hubsOf(restaurant)).toHaveLength(0)
    expect((await record(code)).status).toBe(201)
  })

  it('empty, only spaces or only dashes: 403 (or 400 if it does not even get there) without registering anything', async () => {
    const { restaurant } = await restaurantWithCode()
    for (const c of ['', ' ', '   ', '---', '- - -', '\t\n'])
      expect([400, 403], JSON.stringify(c)).toContain((await record(c)).status)
    expect(await hubsOf(restaurant)).toHaveLength(0)
  })

  it('a code longer than 40 characters is an invalid body', async () => {
    const r = await record('A'.repeat(41))
    expect(r.status).toBe(400)
    expect((await record('A'.repeat(100_000))).status).toBe(400)
  })

  it('property: arbitrary text never registers a hub', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 40 }), async (text) => {
        const before = (await m.db.query<{ n: number }>('SELECT count(*)::int AS n FROM hubs'))
          .rows[0]
        const r = await record(text)
        expect([400, 403]).toContain(r.status)
        const after = (await m.db.query<{ n: number }>('SELECT count(*)::int AS n FROM hubs'))
          .rows[0]
        expect(after?.n).toBe(before?.n)
      }),
      { seed: SEED, numRuns: 40 },
    )
  })

  it('the restaurant_id in the body cannot pick the restaurant: another one is refused', async () => {
    const { restaurant, code } = await restaurantWithCode()
    const r = await record(code, newId(), { restaurant_id: newId() })
    expect(r.status).toBe(403)
    expect(await hubsOf(restaurant)).toHaveLength(0)
  })
})

describe('code validity', () => {
  it('expires exactly at 24 hours: one millisecond before it works, at that exact instant it no longer does', async () => {
    const a = await restaurantWithCode()
    const b = await restaurantWithCode()
    expect(a.expiresAt).toBe(new Date(NOW.getTime() + CODE_TTL_MS).toISOString())
    try {
      m.clock.now = new Date(NOW.getTime() + CODE_TTL_MS - 1)
      expect((await record(a.code)).status).toBe(201)
      m.clock.now = new Date(NOW.getTime() + CODE_TTL_MS)
      expect((await record(b.code)).status).toBe(403)
    } finally {
      m.clock.now = NOW
    }
  })

  it('an expired code cannot register even if nobody used it, and a new one can', async () => {
    const { restaurant, code } = await restaurantWithCode()
    try {
      m.clock.now = new Date(NOW.getTime() + 3 * CODE_TTL_MS)
      expect((await record(code)).status).toBe(403)
      expect((await record(await newCodeFor(restaurant))).status).toBe(201)
    } finally {
      m.clock.now = NOW
    }
  })

  it('a clock running behind in the cloud does not expire a code early (compared against the cloud clock)', async () => {
    const { code } = await restaurantWithCode()
    try {
      // Clock far ahead = expired code; far behind = code still valid.
      m.clock.now = new Date(NOW.getTime() - 5 * CODE_TTL_MS)
      expect((await record(code)).status).toBe(201)
    } finally {
      m.clock.now = NOW
    }
  })
})

describe('code from another restaurant', () => {
  it("registers the hub in the code's restaurant, not another", async () => {
    const a = await restaurantWithCode()
    const b = await restaurantWithCode()
    const r = await record(b.code)
    expect(((await r.json()) as { restaurant_id: string }).restaurant_id).toBe(b.restaurant)
    expect(await hubsOf(a.restaurant)).toHaveLength(0)
    expect(await hubsOf(b.restaurant)).toHaveLength(1)
  })

  it('a hub of one restaurant with a code of another is refused and the code stays unused', async () => {
    const a = await restaurantWithCode()
    const b = await restaurantWithCode()
    const hubId = newId()
    const wrong = await record(b.code, hubId, { restaurant_id: a.restaurant })
    expect(wrong.status).toBe(403)
    expect(((await wrong.json()) as { error: string }).error).toBe('other_restaurant')
    expect(await hubsOf(a.restaurant)).toHaveLength(0)
    expect(await hubsOf(b.restaurant)).toHaveLength(0)
    // The code was not used up: its own restaurant's hub can still register with it.
    expect((await record(b.code)).status).toBe(201)
  })

  it('creating a code for a restaurant that does not exist leaves no trace', async () => {
    const r = await m.request('POST', '/v1/admin/codes', { restaurant_id: newId() }, ADMIN)
    expect(r.status).toBe(404)
  })
})

describe('credentials', () => {
  it('a made-up, empty or huge credential neither uploads events nor reads the sequence', async () => {
    const events = batch(1, 2)
    for (const token of [
      'inventada',
      'x',
      'A'.repeat(43),
      'A'.repeat(100_000),
      '0'.repeat(200),
      'Bearer',
    ]) {
      expect(
        (await m.request('POST', '/v1/events', { events }, token)).status,
        token.slice(0, 20),
      ).toBe(401)
      expect((await m.request('GET', '/v1/events/last', undefined, token)).status).toBe(401)
    }
  })

  it('odd authorization headers: without the Bearer scheme, empty or with extra parts', async () => {
    const { credential } = await m.newHub()
    const request = (authorization: string | null) =>
      handle(
        new Request('https://cloud.faro.test/v1/events/last', {
          headers: authorization === null ? {} : { authorization: authorization },
        }),
        { sql: m.sql },
      )
    expect((await request(null)).status).toBe(401)
    expect((await request('')).status).toBe(401)
    expect((await request('Bearer')).status).toBe(401)
    expect((await request('Bearer ')).status).toBe(401)
    expect((await request(credential)).status).toBe(401)
    expect((await request(`Basic ${credential}`)).status).toBe(401)
    expect((await request(`Token ${credential}`)).status).toBe(401)
    // The correct credential with the Bearer scheme does get in.
    expect((await request(`Bearer ${credential}`)).status).toBe(200)
  })

  it('property: any random credential is 401', async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[\x21-\x7e]{0,300}$/), async (token) => {
        const r = await m.request('GET', '/v1/events/last', undefined, token)
        expect(r.status).toBe(401)
      }),
      { seed: SEED, numRuns: 40 },
    )
  })

  it('a revoked hub neither uploads nor reads, but the other hubs keep going', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    expect(
      (await m.request('POST', '/v1/events', { events: batch(1, 2) }, a.credential)).status,
    ).toBe(200)
    expect(
      (await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: a.hub.id }, ADMIN)).status,
    ).toBe(204)
    expect(
      (await m.request('POST', '/v1/events', { events: batch(3, 2) }, a.credential)).status,
    ).toBe(401)
    expect((await m.request('GET', '/v1/events/last', undefined, a.credential)).status).toBe(401)
    expect(
      (await m.request('POST', '/v1/events', { events: batch(1, 2) }, b.credential)).status,
    ).toBe(200)
  })

  it('revoking twice or a hub that does not exist is 404, and the revocation date does not change', async () => {
    const a = await m.newHub()
    const token = ADMIN
    expect(
      (await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: a.hub.id }, token)).status,
    ).toBe(204)
    const [before] = (
      await m.db.query<{ r: string }>('SELECT revoked_at::text AS r FROM hubs WHERE id = $1', [
        a.hub.id,
      ])
    ).rows
    m.clock.now = new Date(NOW.getTime() + 60_000)
    try {
      expect(
        (await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: a.hub.id }, token)).status,
      ).toBe(404)
    } finally {
      m.clock.now = NOW
    }
    const [after] = (
      await m.db.query<{ r: string }>('SELECT revoked_at::text AS r FROM hubs WHERE id = $1', [
        a.hub.id,
      ])
    ).rows
    expect(after).toEqual(before)
    expect(
      (await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: newId() }, token)).status,
    ).toBe(404)
  })

  it("a revoked hub's credential keeps its earlier events (nothing is deleted)", async () => {
    const a = await m.newHub()
    await m.request('POST', '/v1/events', { events: batch(1, 3) }, a.credential)
    await m.request('POST', '/v1/admin/hubs/revoke', { hub_id: a.hub.id }, ADMIN)
    const n = (
      await m.db.query<{ n: number }>('SELECT count(*)::int AS n FROM events WHERE hub_id = $1', [
        a.hub.id,
      ])
    ).rows[0]
    expect(n?.n).toBe(3)
  })

  it('the admin token does not work as a hub credential, and the hub credential does not work as admin', async () => {
    const a = await m.newHub()
    expect((await m.request('GET', '/v1/events/last', undefined, ADMIN)).status).toBe(401)
    expect(
      (await m.request('POST', '/v1/admin/codes', { restaurant_id: a.restaurantId }, a.credential))
        .status,
    ).toBe(401)
  })

  it('a huge, empty or nearly identical admin token is 401', async () => {
    const { restaurantId } = await m.newHub()
    const body = { restaurant_id: restaurantId }
    for (const t of [
      '',
      'x',
      'A'.repeat(100_000),
      'token-de-administracion-de-prueb',
      'Token-de-administracion-de-prueba',
    ])
      expect((await m.request('POST', '/v1/admin/codes', body, t)).status, t.slice(0, 20)).toBe(401)
  })
})
