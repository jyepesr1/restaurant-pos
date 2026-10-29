import { newId, type OrderEvent } from '@pos/core'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../packages/core/src/testing/factory'
import { handle } from './api'
import { IDLE_MS, MAX_IP_WAIT_MS, MAX_USER_WAIT_MS, SESSION_MS } from './panel'
import {
  cookieFrom,
  PANEL_ORIGIN,
  panelRequest,
  putSnapshot,
  type RemoteUser,
  remoteUser,
  slugOf,
  verifierFor,
} from './testing/panel'
import { createWorld, NOW, type TestHub, type World } from './testing/world'

// Security of the owner's panel (task 1.11c-1): two restaurants with the same username, forged and
// tampered cookies, sessions at the edge of their life, the `Origin` check, the answers that must
// not tell a user or a restaurant that exists from one that does not, and guessing passwords.

let m: World
// One database for the whole file (creating and migrating one costs half a second): every test
// makes its own restaurants, so nothing is shared but the clock, which starts from NOW each time.
beforeAll(async () => {
  m = await createWorld()
})
beforeEach(() => {
  m.clock.now = NOW
})

const later = (ms: number) => {
  m.clock.now = new Date(m.clock.now.getTime() + ms)
}

interface Tenant {
  hub: TestHub
  slug: string
  ana: RemoteUser
  password: string
}

/** A restaurant with its hub and a user `ana` (the same user id and username in every one). */
async function tenant(password: string, anaId: string, name = 'ana'): Promise<Tenant> {
  const hub = await m.newHub()
  const ana = { ...remoteUser(name, password), user_id: anaId }
  expect(await putSnapshot(m, hub, 'remote_users', [ana])).toBe(204)
  expect(
    await putSnapshot(m, hub, 'config', {
      config: { business_day_start: '06:00' },
      time_zone: 'America/Bogota',
    }),
  ).toBe(204)
  return { hub, slug: await slugOf(m, hub.restaurantId), ana, password }
}

const signIn = (
  t: Tenant,
  body: Record<string, unknown> = {},
  o: { ip?: string; origin?: string | null } = {},
) =>
  panelRequest(m, 'POST', '/v1/panel/sign-in', {
    body: { restaurant: t.slug, username: 'ana', password: t.password, ...body },
    ...o,
  })

async function cookieOf(t: Tenant, body: Record<string, unknown> = {}): Promise<string> {
  const r = await signIn(t, body)
  expect(r.status).toBe(200)
  const cookie = cookieFrom(r)
  if (!cookie) throw new Error('no cookie')
  return cookie
}
const attemptRows = async (restaurantId: string) =>
  (
    await m.db.query<{ key: string; failures: number; blocked_until: Date }>(
      'SELECT key, failures, blocked_until FROM panel_attempts WHERE restaurant_id = $1 ORDER BY key',
      [restaurantId],
    )
  ).rows
const get = (route: string, cookie: string | null) => panelRequest(m, 'GET', route, { cookie })
const sessionRow = async (cookie: string) => {
  const row = (
    await m.db.query<{ revoked_at: Date | null; last_used_at: Date; expires_at: Date }>(
      'SELECT revoked_at, last_used_at, expires_at FROM panel_sessions WHERE id = $1',
      [cookie.split('.')[0]],
    )
  ).rows[0]
  return (
    row && {
      revoked_at: row.revoked_at && new Date(row.revoked_at).toISOString(),
      last_used_at: new Date(row.last_used_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
    }
  )
}

// ── Two restaurants, one username ────────────────────────────────────────

/** A paid order of a day, as the hub would store it. */
function paidOrder(day: string, at: string, price: number, user: string): OrderEvent[] {
  const order = newId()
  const fields = { business_day: day, received_at: at, user_id: user } as Partial<OrderEvent>
  return [
    event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }, fields),
    event(order, 'ItemAdded', itemCopy({ unit_price: price }), fields),
    event(order, 'PaymentRecorded', cashPaymentData(price), fields),
    event(order, 'OrderClosed', {}, fields),
  ]
}

describe('two restaurants with the same username and the same user id', () => {
  const anaId = newId()
  let a: Tenant
  let b: Tenant

  beforeEach(async () => {
    a = await tenant('clave-de-ana-en-a', anaId)
    b = await tenant('clave-de-ana-en-b', anaId)
    m.clock.now = new Date('2026-10-26T15:00:00.000Z')
    const sell = async (t: Tenant, price: number) => {
      const events = paidOrder('2026-10-26', '2026-10-26T14:00:00.000Z', price, anaId).map(
        (e, i) => ({ ...e, sequence: i + 1 }),
      )
      expect(
        (await m.cloud.receiveEvents(t.hub.hub, events)).every((r) => r.status === 'saved'),
      ).toBe(true)
    }
    await sell(a, 50_000)
    await sell(b, 70_000)
  })

  const net = async (cookie: string) =>
    (
      (await (await get('/v1/panel/summary', cookie)).json()) as {
        report: { sales: { net: number } }
      }
    ).report.sales.net

  it('each password opens only its own restaurant', async () => {
    expect((await signIn(a)).status).toBe(200)
    expect((await signIn(b)).status).toBe(200)
    expect((await signIn(a, { password: b.password }, { ip: '10.0.0.1' })).status).toBe(401)
    expect((await signIn(b, { password: a.password }, { ip: '10.0.0.2' })).status).toBe(401)
    // A slug is not a way to reach another restaurant's user.
    expect(
      (await signIn(a, { restaurant: b.slug, password: a.password }, { ip: '10.0.0.3' })).status,
    ).toBe(401)
  })

  it('each session reads only its own numbers', async () => {
    const ca = await cookieOf(a)
    const cb = await cookieOf(b)
    expect(await net(ca)).toBe(50_000)
    expect(await net(cb)).toBe(70_000)
    const me = (await (await get('/v1/panel/me', ca)).json()) as { restaurant: { id: string } }
    expect(me.restaurant.id).toBe(a.hub.restaurantId)
  })

  it('the id of one restaurant’s session with the secret of the other’s is nothing', async () => {
    const ca = await cookieOf(a)
    const cb = await cookieOf(b)
    const [idA, secretA] = ca.split('.') as [string, string]
    const [idB, secretB] = cb.split('.') as [string, string]
    for (const forged of [`${idA}.${secretB}`, `${idB}.${secretA}`]) {
      expect((await get('/v1/panel/me', forged)).status).toBe(401)
    }
    // Trying did not hurt the real sessions.
    expect((await get('/v1/panel/me', ca)).status).toBe(200)
    expect((await get('/v1/panel/me', cb)).status).toBe(200)
  })

  it('removing or changing the user in one restaurant does not touch the other’s session', async () => {
    const ca = await cookieOf(a)
    const cb = await cookieOf(b)
    expect(await putSnapshot(m, a.hub, 'remote_users', [])).toBe(204)
    expect((await get('/v1/panel/me', ca)).status).toBe(401)
    expect((await get('/v1/panel/me', cb)).status).toBe(200)
    expect(
      await putSnapshot(m, b.hub, 'remote_users', [
        { ...b.ana, verifier: verifierFor('otra-clave-de-ana') },
      ]),
    ).toBe(204)
    expect((await get('/v1/panel/me', cb)).status).toBe(401)
  })

  it('failed attempts in one restaurant do not make the other’s user wait', async () => {
    for (let i = 0; i < 6; i++) {
      await signIn(a, { password: 'mala-clave-1234' }, { ip: `10.7.0.${i}` })
      later(MAX_USER_WAIT_MS)
    }
    const blocked = await signIn(a, { password: 'mala-clave-1234' }, { ip: '10.7.1.1' })
    expect([401, 429]).toContain(blocked.status)
    expect((await signIn(b, {}, { ip: '10.7.1.1' })).status).toBe(200)
  })

  it('one restaurant’s snapshot cannot be read by the other: the same user id is two rows', async () => {
    const rows = (
      await m.db.query<{ restaurant_id: string }>(
        'SELECT restaurant_id FROM remote_users WHERE user_id = $1 AND restaurant_id = ANY($2) ORDER BY restaurant_id',
        [anaId, [a.hub.restaurantId, b.hub.restaurantId]],
      )
    ).rows
    expect(rows.map((r) => r.restaurant_id).sort()).toEqual(
      [a.hub.restaurantId, b.hub.restaurantId].sort(),
    )
  })
})

// ── Tampered cookies ─────────────────────────────────────────────────────

describe('tampered cookies', () => {
  let t: Tenant
  let cookie: string
  beforeEach(async () => {
    t = await tenant('clave-de-ana-2026', newId())
    cookie = await cookieOf(t)
  })

  it('every change to the value, in any position, is refused and the session survives', async () => {
    const [id, secret] = cookie.split('.') as [string, string]
    const flip = (s: string, i: number) =>
      s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)
    const forged = [
      ...[0, 1, 13, 25].map((i) => `${flip(id, i)}.${secret}`),
      ...[0, 1, 20, 42].map((i) => `${id}.${flip(secret, i)}`),
      `${id}.${secret}.`,
      `${id}.${secret}.${secret}`,
      `${id}${secret}`,
      `${id}.`,
      `.${secret}`,
      `${id.toLowerCase()}.${secret}`,
      `${id}.${secret.toUpperCase() === secret ? secret.toLowerCase() : secret.toUpperCase()}`,
      `${id}.${secret.slice(0, 42)}`,
      `${id}.${secret}A`,
      `${id.slice(0, 25)}.${secret}`,
      'x'.repeat(8_000),
      `${id}.${'A'.repeat(8_000)}`,
      "'; DROP TABLE panel_sessions;--",
      `${id}'.${secret}`,
      '%00',
      '\u0000',
    ]
    for (const f of forged) {
      const r = await get('/v1/panel/me', f.replaceAll('\u0000', ''))
      expect([401], JSON.stringify(f).slice(0, 80)).toContain(r.status)
    }
    expect((await get('/v1/panel/me', cookie)).status).toBe(200)
    expect((await sessionRow(cookie))?.revoked_at).toBeNull()
    expect(
      (
        await m.db.query('SELECT count(*)::int AS n FROM panel_sessions WHERE restaurant_id = $1', [
          t.hub.restaurantId,
        ])
      ).rows,
    ).toEqual([{ n: 1 }])
  })

  it('a wrong secret never ends the real session (nobody can log others out by guessing)', async () => {
    const [id] = cookie.split('.') as [string, string]
    for (let i = 0; i < 20; i++) await get('/v1/panel/me', `${id}.${'A'.repeat(43)}`)
    expect((await sessionRow(cookie))?.revoked_at).toBeNull()
    expect((await get('/v1/panel/me', cookie)).status).toBe(200)
  })

  it('only the cookie of that exact name counts', async () => {
    for (const name of ['faro_panel', '_Host-faro_panel', '__Secure-faro_panel', 'session']) {
      const r = await panelRequest(m, 'GET', '/v1/panel/me', {
        headers: { cookie: `${name}=${cookie}` },
      })
      expect(r.status, name).toBe(401)
      // Without the right cookie there is nothing to clear.
      expect(r.headers.get('set-cookie'), name).toBeNull()
    }
    // Amid other cookies it is found.
    const r = await panelRequest(m, 'GET', '/v1/panel/me', {
      headers: { cookie: `a=1; __Host-faro_panel=${cookie}; b=2` },
    })
    expect(r.status).toBe(200)
  })

  it('a bad cookie asks the browser to clear it; no cookie at all does not', async () => {
    const bad = await get('/v1/panel/me', `${cookie}x`)
    expect(bad.status).toBe(401)
    expect(bad.headers.get('set-cookie')).toContain('Max-Age=0')
    const none = await get('/v1/panel/me', null)
    expect(none.status).toBe(401)
    expect(none.headers.get('set-cookie')).toBeNull()
  })

  it('sign-out with a forged cookie does not end the real session', async () => {
    const [id] = cookie.split('.') as [string, string]
    const r = await panelRequest(m, 'POST', '/v1/panel/sign-out', {
      cookie: `${id}.${'B'.repeat(43)}`,
    })
    expect(r.status).toBe(204)
    expect((await get('/v1/panel/me', cookie)).status).toBe(200)
  })
})

// ── Sessions at the edge of their life ───────────────────────────────────

describe('session lifetime', () => {
  let t: Tenant
  beforeEach(async () => {
    t = await tenant('clave-de-ana-2026', newId())
  })

  it('idle: alive one millisecond before 7 days, dead at 7 days', async () => {
    const alive = await cookieOf(t)
    later(IDLE_MS - 1)
    expect((await get('/v1/panel/me', alive)).status).toBe(200)
    m.clock.now = NOW
    const dead = await cookieOf(t)
    later(IDLE_MS)
    const r = await get('/v1/panel/me', dead)
    expect(r.status).toBe(401)
    expect(r.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('absolute: alive one millisecond before 30 days even if used every day, dead at 30', async () => {
    const used = await cookieOf(t)
    for (let day = 1; day < 30; day++) {
      later(24 * 3_600_000)
      expect((await get('/v1/panel/me', used)).status).toBe(200)
    }
    later(24 * 3_600_000 - 1)
    expect(SESSION_MS).toBe(30 * 24 * 3_600_000)
    expect((await get('/v1/panel/me', used)).status).toBe(200)
    later(1)
    expect((await get('/v1/panel/me', used)).status).toBe(401)
  })

  it('a dead session is not revived by asking again, nor does asking move its last use', async () => {
    const cookie = await cookieOf(t)
    later(IDLE_MS)
    const before = (await sessionRow(cookie))?.last_used_at
    for (let i = 0; i < 3; i++) expect((await get('/v1/panel/me', cookie)).status).toBe(401)
    expect((await sessionRow(cookie))?.last_used_at).toBe(before)
    m.clock.now = new Date(m.clock.now.getTime() - IDLE_MS + 1000)
    // Even if the clock goes back inside its life, the use time was not touched: it lives again
    // only because time says so, not because someone asked.
    expect((await sessionRow(cookie))?.last_used_at).toBe(before)
  })

  it('polling every 15 s keeps it alive and touches the row at most once a minute', async () => {
    const cookie = await cookieOf(t)
    const writes = new Set<string>()
    for (let i = 0; i < 80; i++) {
      later(15_000)
      expect((await get('/v1/panel/me', cookie)).status).toBe(200)
      writes.add((await sessionRow(cookie))?.last_used_at as string)
    }
    // 20 minutes of polling: about 20 writes, not 80.
    expect(writes.size).toBeGreaterThanOrEqual(18)
    expect(writes.size).toBeLessThanOrEqual(21)
    later(IDLE_MS - 61_000)
    expect((await get('/v1/panel/me', cookie)).status).toBe(200)
  })

  it('the cloud clock going back an hour does not kill or extend a session', async () => {
    const cookie = await cookieOf(t)
    later(2 * 3_600_000)
    expect((await get('/v1/panel/me', cookie)).status).toBe(200)
    later(-3 * 3_600_000)
    expect((await get('/v1/panel/me', cookie)).status).toBe(200)
    const row = await sessionRow(cookie)
    expect(new Date(row?.expires_at as string).getTime()).toBe(NOW.getTime() + SESSION_MS)
  })

  it('a session that dies by expiry does not stop a new sign-in', async () => {
    const old = await cookieOf(t)
    later(IDLE_MS)
    const fresh = await cookieOf(t)
    expect((await get('/v1/panel/me', old)).status).toBe(401)
    expect((await get('/v1/panel/me', fresh)).status).toBe(200)
  })

  it('every sign-in is its own session; signing out one leaves the others', async () => {
    const one = await cookieOf(t)
    const two = await cookieOf(t)
    expect(one).not.toBe(two)
    expect((await panelRequest(m, 'POST', '/v1/panel/sign-out', { cookie: one })).status).toBe(204)
    expect((await get('/v1/panel/me', one)).status).toBe(401)
    expect((await get('/v1/panel/me', two)).status).toBe(200)
  })
})

// ── Origin and what a browser could be tricked into ──────────────────────

describe('Origin on POST', () => {
  let t: Tenant
  beforeEach(async () => {
    t = await tenant('clave-de-ana-2026', newId())
  })

  it('only the exact address of the panel is accepted, on sign-in and sign-out', async () => {
    const cookie = await cookieOf(t)
    const notExactly = [
      `${PANEL_ORIGIN}/`,
      `${PANEL_ORIGIN}:443`,
      `${PANEL_ORIGIN}:8443`,
      'HTTPS://CLOUD.FARO.TEST',
      'http://cloud.faro.test',
      'https://evil.cloud.faro.test',
      'https://cloud.faro.test.evil.com',
      'https://evilcloud.faro.test',
      'https://cloud.faro.test@evil.com',
      'null',
      'file://',
      '*',
      '',
    ]
    for (const origin of notExactly) {
      const inn = await signIn(t, {}, { origin })
      expect(inn.status, `sign-in with «${origin}»`).toBe(403)
      expect(cookieFrom(inn)).toBeNull()
      const out = await panelRequest(m, 'POST', '/v1/panel/sign-out', { cookie, origin })
      expect(out.status, `sign-out with «${origin}»`).toBe(403)
    }
    expect((await signIn(t, {}, { origin: null })).status).toBe(403)
    expect((await get('/v1/panel/me', cookie)).status).toBe(200)
  })

  it('a cross-site form (not JSON) is refused even from the right address', async () => {
    for (const type of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
    ]) {
      const r = await panelRequest(m, 'POST', '/v1/panel/sign-in', {
        body: { restaurant: t.slug, username: 'ana', password: t.password },
        headers: { 'content-type': type },
      })
      expect(r.status, type).toBe(400)
    }
    const ok = await panelRequest(m, 'POST', '/v1/panel/sign-in', {
      body: { restaurant: t.slug, username: 'ana', password: t.password },
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
    expect(ok.status).toBe(200)
  })

  it('there are no CORS headers on any answer, and a preflight leads nowhere', async () => {
    const cookie = await cookieOf(t)
    const responses = [
      await get('/v1/panel/me', cookie),
      await get('/v1/panel/me', null),
      await signIn(t),
      await signIn(t, { password: 'mala-clave-1234' }, { ip: '10.1.1.1' }),
      await panelRequest(m, 'OPTIONS', '/v1/panel/sign-in', {
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'POST',
        },
      }),
      await panelRequest(m, 'GET', '/v1/panel/me', {
        cookie,
        origin: 'https://evil.example',
      }),
    ]
    for (const r of responses)
      for (const [name] of r.headers) expect(name.startsWith('access-control-'), name).toBe(false)
    expect(responses[4]?.status).toBe(404)
  })

  it('other methods and verbs change nothing and say 404', async () => {
    const cookie = await cookieOf(t)
    for (const [method, route] of [
      ['GET', '/v1/panel/sign-in'],
      ['GET', '/v1/panel/sign-out'],
      ['PUT', '/v1/panel/me'],
      ['DELETE', '/v1/panel/me'],
      ['PATCH', '/v1/panel/summary'],
      ['POST', '/v1/panel/me'],
      ['POST', '/v1/panel/summary'],
      ['POST', '/v1/panel/reports'],
      ['GET', '/v1/panel/'],
      ['GET', '/v1/panel/admin'],
      ['GET', '/v1/panel/me/summary'],
    ] as const) {
      const r = await panelRequest(m, method, route, { cookie })
      expect(r.status, `${method} ${route}`).toBe(404)
    }
    expect((await get('/v1/panel/me', cookie)).status).toBe(200)
  })
})

// ── What the answers say ─────────────────────────────────────────────────

describe('sign-in answers', () => {
  let t: Tenant
  beforeEach(async () => {
    t = await tenant('clave-de-ana-2026', newId())
  })

  /** Status, body and every header but the date-like ones: what a stranger sees. */
  const seen = async (r: Response) => ({
    status: r.status,
    body: await r.text(),
    headers: [...r.headers].filter(([k]) => k !== 'date').sort(),
  })

  it('wrong password, unknown user, unknown restaurant and a malformed one look identical the first time', async () => {
    const cases: Record<string, unknown>[] = [
      { password: 'otra-clave-cualquiera' },
      { username: 'nadie' },
      { username: 'nadie-mas' },
      { restaurant: 'no-existe' },
      { restaurant: "x'; DROP TABLE restaurants;--" },
      { restaurant: 'Ñandú' },
      { username: "' OR 1=1 --" },
      { username: 'ab' },
      { username: 'a'.repeat(41) },
    ]
    const answers = []
    for (const [i, c] of cases.entries())
      answers.push(await seen(await signIn(t, c, { ip: `10.4.0.${i}` })))
    for (const a of answers) expect(a).toEqual(answers[0])
    expect(answers[0]?.status).toBe(401)
    const body = JSON.parse(answers[0]?.body ?? '{}') as { error: string; message: string }
    expect(body.error).toBe('invalid_credentials')
    expect(body.message.length).toBeGreaterThan(10)
    expect(Object.keys(body).sort()).toEqual(['error', 'message'])
  })

  it('the waits grow the same for a user that does not exist as for one that does', async () => {
    const waits = async (username: string, base: number) => {
      const out: number[] = []
      for (let i = 0; i < 6; i++) {
        const r = await signIn(
          t,
          { username, password: 'mala-clave-1234' },
          { ip: `10.${base}.0.${i}` },
        )
        if (r.status === 429) {
          out.push(-1)
        } else out.push(((await r.json()) as { wait_ms?: number }).wait_ms ?? 0)
        later(MAX_USER_WAIT_MS)
      }
      return out
    }
    const real = await waits('ana', 5)
    m.clock.now = NOW
    const ghost = await waits('fantasma', 6)
    expect(ghost).toEqual(real)
    expect(real.slice(0, 4)).toEqual([0, 0, 2000, 4000])
  })

  it('a restaurant or a username that cannot exist is refused without charging anything (no table grows with invented names)', async () => {
    for (let i = 0; i < 8; i++) {
      await signIn(t, { restaurant: `inventado-${i}` }, { ip: `10.8.0.${i}` })
      await signIn(t, { username: 'x' }, { ip: `10.8.1.${i}` })
    }
    expect((await attemptRows(t.hub.restaurantId)).map((r) => r.key)).toEqual([])
    // And they never get a wait: the slug is in the panel's address, it is not a secret.
    const r = await signIn(t, { restaurant: 'inventado-0' }, { ip: '10.8.0.0' })
    expect(r.status).toBe(401)
    expect(((await r.json()) as { wait_ms?: number }).wait_ms).toBeUndefined()
  })

  it('a long password, an empty one or one with a NUL is a 400 or a plain 401, never a 500', async () => {
    for (const password of ['x'.repeat(201), '', 'a\u0000b', 'ñ'.repeat(200)]) {
      const r = await signIn(t, { password }, { ip: `10.3.${password.length}.1` })
      expect([400, 401], JSON.stringify(password).slice(0, 20)).toContain(r.status)
    }
  })

  it('the same password typed with another Unicode form still opens (NFC, as the hub)', async () => {
    const accent = 'contraseña-ñandú-2026'
    const user = { ...remoteUser('ana', accent), user_id: t.ana.user_id }
    expect(await putSnapshot(m, t.hub, 'remote_users', [user])).toBe(204)
    expect((await signIn(t, { password: accent.normalize('NFC') })).status).toBe(200)
    expect((await signIn(t, { password: accent.normalize('NFD') })).status).toBe(200)
  })

  it('the Rate Limiting binding failing (throwing) does not leave the door open or return a 500', async () => {
    const limiter = {
      limit: async () => {
        throw new Error('the binding is down')
      },
    }
    const r = await handle(
      new Request(`${PANEL_ORIGIN}/v1/panel/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: PANEL_ORIGIN },
        body: JSON.stringify({ restaurant: t.slug, username: 'ana', password: 'mala-clave-1234' }),
      }),
      { sql: m.sql, clock: () => m.clock.now, limiter },
    )
    // Either way it is not a successful sign-in with a wrong password.
    expect(r.status).not.toBe(200)
  })
})

// ── Guessing passwords ───────────────────────────────────────────────────

describe('guessing passwords', () => {
  let t: Tenant
  beforeEach(async () => {
    t = await tenant('clave-de-ana-2026', newId())
  })

  const bad = (o: { ip?: string; username?: string } = {}) =>
    signIn(t, { username: o.username ?? 'ana', password: 'mala-clave-1234' }, { ip: o.ip })

  it('one IP trying many users reaches the IP cap and not a second more', async () => {
    const ip = '10.20.30.40'
    let last = 0
    for (let i = 0; i < 16; i++) {
      const r = await bad({ ip, username: `usuario${i}` })
      if (r.status === 401) last = ((await r.json()) as { wait_ms?: number }).wait_ms ?? 0
      later(MAX_IP_WAIT_MS)
    }
    expect(last).toBe(MAX_IP_WAIT_MS)
  })

  it('hammering while blocked does not stretch the wait', async () => {
    for (let i = 0; i < 3; i++) await bad({ ip: `10.30.0.${i}` })
    const blockedUntil = async () => {
      const row = (await attemptRows(t.hub.restaurantId)).find((r) => r.key === 'user:ana')
      return row && new Date(row.blocked_until).toISOString()
    }
    const first = await blockedUntil()
    for (let i = 0; i < 25; i++) expect((await bad({ ip: `10.31.0.${i}` })).status).toBe(429)
    expect(await blockedUntil()).toBe(first)
    later(MAX_USER_WAIT_MS)
    expect((await signIn(t, {}, { ip: '10.32.0.1' })).status).toBe(200)
  })

  it('failures are forgotten after ten quiet minutes', async () => {
    for (let i = 0; i < 5; i++) {
      await bad({ ip: `10.40.0.${i}` })
      later(MAX_USER_WAIT_MS)
    }
    later(11 * 60_000)
    const r = await bad({ ip: '10.40.1.1' })
    expect(r.status).toBe(401)
    expect(((await r.json()) as { wait_ms?: number }).wait_ms).toBeUndefined()
  })

  it('a good sign-in clears the failures of that user and that IP, and only theirs', async () => {
    await bad({ ip: '10.50.0.1' })
    await bad({ ip: '10.50.0.1' })
    await bad({ ip: '10.50.0.9', username: 'otro-usuario' })
    expect((await signIn(t, {}, { ip: '10.50.0.1' })).status).toBe(200)
    const rows = (await attemptRows(t.hub.restaurantId)).map((r) => ({
      key: r.key,
      failures: r.failures,
    }))
    expect(rows).toEqual([
      { key: 'ip:10.50.0.1', failures: 0 },
      { key: 'ip:10.50.0.9', failures: 1 },
      { key: 'user:ana', failures: 0 },
      { key: 'user:otro-usuario', failures: 1 },
    ])
    // The next failure starts from one: no wait.
    const next = await bad({ ip: '10.50.0.1' })
    expect(((await next.json()) as { wait_ms?: number }).wait_ms).toBeUndefined()
  })

  it('a user’s attempts do not leave rows in other restaurants’ attempts', async () => {
    const other = await tenant('clave-ajena-2026', newId())
    for (let i = 0; i < 4; i++) {
      await bad({ ip: `10.60.0.${i}` })
      later(MAX_USER_WAIT_MS)
    }
    expect((await attemptRows(t.hub.restaurantId)).length).toBeGreaterThan(0)
    expect(await attemptRows(other.hub.restaurantId)).toEqual([])
  })

  it('twenty guesses sent at the same time: only the first three are tried, the rest wait, and each tried one is counted', async () => {
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) => bad({ ip: `10.70.0.${i}` })),
    )
    const tried = answers.filter((r) => r.status === 401).length
    expect(tried).toBe(3)
    expect(answers.filter((r) => r.status === 429)).toHaveLength(17)
    const row = (await attemptRows(t.hub.restaurantId)).find((r) => r.key === 'user:ana')
    expect(row?.failures).toBe(3)
  })

  it('a good password sent together with wrong ones still opens if it is among the first', async () => {
    const answers = await Promise.all([
      bad({ ip: '10.72.0.1' }),
      signIn(t, {}, { ip: '10.72.0.2' }),
      bad({ ip: '10.72.0.3' }),
    ])
    expect(answers.map((r) => r.status).sort()).toEqual([200, 401, 401])
  })

  it('the right password opens the very millisecond the wait ends, not before', async () => {
    let wait = 0
    for (let i = 0; i < 6; i++) {
      const r = await bad({ ip: `10.80.0.${i}` })
      wait = ((await r.json()) as { wait_ms?: number }).wait_ms ?? 0
      // Wait out each one but the last.
      if (i < 5) later(wait)
    }
    expect(wait).toBe(16_000)
    later(wait - 1)
    expect((await signIn(t, {}, { ip: '10.80.1.2' })).status).toBe(429)
    later(1)
    expect((await signIn(t, {}, { ip: '10.80.1.3' })).status).toBe(200)
  })

  it('the waits stop growing at the cap of each kind', async () => {
    let last = 0
    for (let i = 0; i < 16; i++) {
      const r = await bad({ ip: `10.81.0.${i}` })
      if (r.status === 401) last = ((await r.json()) as { wait_ms?: number }).wait_ms ?? 0
      later(MAX_IP_WAIT_MS)
    }
    expect(last).toBe(MAX_USER_WAIT_MS)
    expect(MAX_USER_WAIT_MS).toBeLessThanOrEqual(MAX_IP_WAIT_MS)
  })

  it('old attempt rows are cleared by the next sign-in after a day', async () => {
    for (let i = 0; i < 3; i++) await bad({ ip: `10.82.0.${i}` })
    expect((await attemptRows(t.hub.restaurantId)).length).toBeGreaterThan(0)
    later(25 * 3_600_000)
    expect((await signIn(t, {}, { ip: '10.82.9.9' })).status).toBe(200)
    const keys = await attemptRows(t.hub.restaurantId)
    expect(keys.map((k) => k.key)).toEqual(['ip:10.82.9.9', 'user:ana'])
  })
})

// ── Reports and dashboard: odd input ─────────────────────────────────────

describe('odd input to the reports', () => {
  let cookie: string
  beforeEach(async () => {
    const t = await tenant('clave-de-ana-2026', newId())
    cookie = await cookieOf(t)
  })

  it('anything that is not a real date is a 400, never a 500', async () => {
    const odd = [
      "from=2026-10-26';DROP TABLE events;--",
      'from=2026-10-26&until=%00',
      'from=2026-13-01',
      'from=2026-02-29',
      'from=2026-10-26T00:00:00Z',
      'from=26-10-2026',
      `from=${'9'.repeat(5_000)}`,
      'from[]=2026-10-26',
      'from=2026-10-26&from=2026-10-27',
      'from=%F0%9F%98%80',
    ]
    for (const q of odd) {
      const r = await get(`/v1/panel/reports?${q}`, cookie)
      expect(r.status, q.slice(0, 60)).not.toBe(500)
      expect([200, 400], q.slice(0, 60)).toContain(r.status)
    }
  })

  // JavaScript has a year 0000 but Postgres does not (22008): `isDay` refuses it. The same `isDay` is
  // copied in the hub's route.
  it('year 0000 is a 400, not a 500', async () => {
    for (const q of ['from=0000-01-01', 'from=0000-01-01&until=0000-01-05', 'until=0000-12-31']) {
      const r = await get(`/v1/panel/reports?${q}`, cookie)
      expect(r.status, q).toBe(400)
    }
  })

  it('the far past and the far future are fine and empty', async () => {
    for (const q of [
      'from=0001-01-01&until=0001-01-14',
      'from=9999-12-18&until=9999-12-31',
      'from=2099-01-01',
    ]) {
      const r = await get(`/v1/panel/reports?${q}`, cookie)
      expect(r.status, q).toBe(200)
      const body = (await r.json()) as { report: { sales: { net: number } } }
      expect(body.report.sales.net).toBe(0)
    }
  })

  it('only `until`, only `from` and empty values behave', async () => {
    expect((await get('/v1/panel/reports?until=2026-10-26', cookie)).status).toBe(200)
    expect((await get('/v1/panel/reports?until=2026-10-01', cookie)).status).toBe(400)
    expect((await get('/v1/panel/reports?from=2026-10-26', cookie)).status).toBe(200)
    expect((await get('/v1/panel/reports?from=&until=', cookie)).status).toBe(200)
  })
})
