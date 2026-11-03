import { newId, type OrderEvent, report } from '@pos/core'
import { MemoryStore, ordersOf, reportData } from '@pos/sync'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../packages/core/src/testing/factory'
import { handle, SECURITY_HEADERS } from './api'
import { MAX_USER_WAIT_MS } from './panel'
import { configFrom, periodReport } from './reports'
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

// The owner's panel (task 1.11c-1, docs/PANEL.md#rutas-del-panel-sesión-por-cookie): signing in
// with the location's username and password, the session cookie checked on every request, the
// attempt limit, the dashboard and the reports.

let m: World
let hub: TestHub
let slug: string
let ana: RemoteUser
const PASSWORD = 'clave-de-ana-2026'
const CHECKOUT = {
  paymentMethods: ['cash', 'card'],
  customMethods: [{ id: newId(), name: 'Sodexo' }],
  suggestedTip: 1000,
  roundingMode: 'half_up',
  cashRounding: 100,
  cashRoundingMode: 'nearest_half_down',
  printsPreBill: true,
}

beforeEach(async () => {
  m = await createWorld()
  hub = await m.newHub()
  slug = await slugOf(m, hub.restaurantId)
  ana = remoteUser('ana', PASSWORD, ['remote_access', 'view_reports'], 'Ana Pérez')
  expect(await putSnapshot(m, hub, 'remote_users', [ana])).toBe(204)
  expect(
    await putSnapshot(m, hub, 'config', {
      config: { business_day_start: '06:00' },
      time_zone: 'America/Bogota',
    }),
  ).toBe(204)
  expect(
    await putSnapshot(m, hub, 'catalog', {
      version: 3,
      restaurant: { name: 'R', sessionIdleMin: 5, brand: 'spritzzeria', checkout: CHECKOUT },
    }),
  ).toBe(204)
})

const signIn = (body: Record<string, unknown>, o: { ip?: string; origin?: string | null } = {}) =>
  panelRequest(m, 'POST', '/v1/panel/sign-in', {
    body: { restaurant: slug, username: 'ana', password: PASSWORD, ...body },
    ...o,
  })

async function signedIn(): Promise<string> {
  const r = await signIn({})
  expect(r.status).toBe(200)
  const cookie = cookieFrom(r)
  if (!cookie) throw new Error('no cookie')
  return cookie
}

const get = (route: string, cookie: string | null) => panelRequest(m, 'GET', route, { cookie })
const later = (ms: number) => {
  m.clock.now = new Date(m.clock.now.getTime() + ms)
}

describe('signing in', () => {
  it('with the right username and password: Me and the cookie', async () => {
    const r = await signIn({ username: '  ANA ', restaurant: slug.toUpperCase() })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      user: { id: ana.user_id, name: 'Ana Pérez', permissions: ['remote_access', 'view_reports'] },
      restaurant: {
        id: hub.restaurantId,
        name: 'Restaurante de prueba',
        slug,
        time_zone: 'America/Bogota',
        brand: 'spritzzeria',
        payment_methods: CHECKOUT,
      },
    })
    const header = r.headers.get('set-cookie') ?? ''
    expect(header).toMatch(/^__Host-faro_panel=[0-9A-Z]{26}\.[A-Za-z0-9_-]{43}; /)
    for (const part of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=2592000'])
      expect(header).toContain(part)
    expect(header).not.toContain('Domain')
    // Only the secret's fingerprint is stored.
    const [id, secret] = (cookieFrom(r) ?? '').split('.')
    const [row] = (
      await m.db.query<{ secret_hash: string; user_id: string }>(
        'SELECT secret_hash, user_id FROM panel_sessions WHERE id = $1',
        [id],
      )
    ).rows
    expect(row?.user_id).toBe(ana.user_id)
    expect(row?.secret_hash).not.toContain(secret as string)
    expect(row?.secret_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('wrong password, unknown user or restaurant, or without remote_access: the same 401', async () => {
    const noAccess = remoteUser('luis', 'clave-de-luis-1', ['view_reports'])
    expect(await putSnapshot(m, hub, 'remote_users', [ana, noAccess])).toBe(204)
    const cases = [
      { password: 'otra-clave-cualquiera' },
      { username: 'nadie' },
      { username: 'x' },
      { restaurant: 'no-existe' },
      { restaurant: '¡mal!' },
      { username: 'luis', password: 'clave-de-luis-1' },
    ]
    for (const c of cases) {
      const r = await signIn(c, { ip: `10.0.0.${cases.indexOf(c)}` })
      expect(r.status, JSON.stringify(c)).toBe(401)
      const body = (await r.json()) as { error: string; message: string }
      expect(body.error).toBe('invalid_credentials')
      expect(body.message).toBe('Revisa el restaurante, el usuario y la contraseña.')
      expect(cookieFrom(r)).toBeNull()
    }
    expect((await m.db.query('SELECT 1 FROM panel_sessions')).rows).toEqual([])
  })

  it('without the panel’s Origin, or not as JSON, nothing is checked', async () => {
    for (const origin of [null, 'null', 'https://otro.sitio', 'http://cloud.faro.test'])
      expect((await signIn({}, { origin })).status, String(origin)).toBe(403)
    const plain = await panelRequest(m, 'POST', '/v1/panel/sign-in', {
      body: { restaurant: slug, username: 'ana', password: PASSWORD },
      headers: { 'content-type': 'text/plain' },
    })
    expect(plain.status).toBe(400)
    for (const body of [
      {},
      { restaurant: slug, username: 'ana' },
      { restaurant: slug, username: 'ana', password: PASSWORD, extra: 1 },
    ])
      expect(
        (await panelRequest(m, 'POST', '/v1/panel/sign-in', { body })).status,
        JSON.stringify(body),
      ).toBe(400)
    // Another configured address for the panel.
    const r = await panelRequest(
      m,
      'POST',
      '/v1/panel/sign-in',
      {
        body: { restaurant: slug, username: 'ana', password: PASSWORD },
        origin: 'https://panel.faro.co',
      },
      { panelOrigin: 'https://panel.faro.co' },
    )
    expect(r.status).toBe(200)
  })

  it('failures add a growing wait per user, up to 60 s; meanwhile even the right password waits', async () => {
    const waits: number[] = []
    for (let i = 0; i < 8; i++) {
      const r = await signIn({ password: 'mala-clave-1234' }, { ip: `10.1.0.${i}` })
      if (r.status === 429) {
        expect(r.headers.get('retry-after')).toMatch(/^\d+$/)
        later(MAX_USER_WAIT_MS)
        continue
      }
      expect(r.status).toBe(401)
      waits.push(((await r.json()) as { wait_ms?: number }).wait_ms ?? 0)
      // Right away, even with the right password: 429.
      if ((waits.at(-1) ?? 0) > 0) {
        const blocked = await signIn({}, { ip: `10.2.0.${i}` })
        expect(blocked.status).toBe(429)
        expect(((await blocked.json()) as { error: string }).error).toBe('wait')
        later(waits.at(-1) ?? 0)
      }
    }
    expect(waits).toEqual([0, 0, 2000, 4000, 8000, 16_000, 32_000, 60_000])
    expect(Math.max(...waits)).toBe(MAX_USER_WAIT_MS)
    // After the wait, the right password works.
    expect((await signIn({})).status).toBe(200)
  })

  it('failures from one IP also wait for other users (up to 5 min), and are forgotten after 10 minutes', async () => {
    const luis = remoteUser('luis', 'clave-de-luis-1')
    expect(await putSnapshot(m, hub, 'remote_users', [ana, luis])).toBe(204)
    const ip = '10.9.9.9'
    for (const u of ['ana', 'luis', 'pedro', 'maria', 'sara']) {
      const r = await signIn({ username: u, password: 'mala-clave-1234' }, { ip })
      expect([401, 429]).toContain(r.status)
      later(MAX_USER_WAIT_MS)
    }
    // The sixth failure from that IP: 16 s; luis had only one before: it is the IP that waits.
    const r = await signIn({ username: 'luis', password: 'mala-clave-1234' }, { ip })
    expect(((await r.json()) as { wait_ms?: number }).wait_ms).toBe(16_000)
    expect((await signIn({ username: 'luis', password: 'clave-de-luis-1' }, { ip })).status).toBe(
      429,
    )
    later(11 * 60_000)
    const fresh = await signIn({ username: 'luis', password: 'mala-clave-1234' }, { ip })
    expect(((await fresh.json()) as { wait_ms?: number }).wait_ms).toBeUndefined()
  })

  it('with the Rate Limiting binding, a key over the limit gives 429 before checking anything', async () => {
    const limit = vi.fn(async ({ key }: { key: string }) => ({ success: !key.startsWith('ip:') }))
    const r = await panelRequest(
      m,
      'POST',
      '/v1/panel/sign-in',
      { body: { restaurant: slug, username: 'ana', password: PASSWORD }, ip: '1.2.3.4' },
      { limiter: { limit } },
    )
    expect(r.status).toBe(429)
    expect(limit).toHaveBeenCalledWith({ key: 'ip:1.2.3.4' })
    const ok = await panelRequest(
      m,
      'POST',
      '/v1/panel/sign-in',
      { body: { restaurant: slug, username: 'ana', password: PASSWORD } },
      { limiter: { limit } },
    )
    expect(ok.status).toBe(200)
    expect(limit).toHaveBeenCalledWith({ key: `user:${slug}:ana` })
  })

  it('a hub verifier with the production cost (2^15) also works', async () => {
    const strong = { ...ana, verifier: verifierFor(PASSWORD, 15) }
    expect(await putSnapshot(m, hub, 'remote_users', [strong])).toBe(204)
    expect((await signIn({})).status).toBe(200)
  })
})

describe('the session', () => {
  it('me answers with the cookie; without it, or with a tampered one, 401', async () => {
    const cookie = await signedIn()
    const r = await get('/v1/panel/me', cookie)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { user: { id: string } }).user.id).toBe(ana.user_id)
    const [id, secret] = cookie.split('.') as [string, string]
    const other = `${id}.${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`
    for (const c of [null, 'basura', other, `${newId()}.${secret}`]) {
      const bad = await get('/v1/panel/me', c)
      expect(bad.status, String(c)).toBe(401)
      expect(((await bad.json()) as { error: string }).error).toBe('no_session')
    }
  })

  it('dies when the person loses remote_access, is archived or changes the password', async () => {
    for (const change of [
      (u: RemoteUser) => [{ ...u, permissions: ['view_reports'] }],
      () => [],
      (u: RemoteUser) => [{ ...u, verifier: verifierFor('clave-nueva-2026') }],
    ]) {
      expect(await putSnapshot(m, hub, 'remote_users', [ana])).toBe(204)
      const cookie = await signedIn()
      expect((await get('/v1/panel/me', cookie)).status).toBe(200)
      expect(await putSnapshot(m, hub, 'remote_users', change(ana))).toBe(204)
      const r = await get('/v1/panel/me', cookie)
      expect(r.status).toBe(401)
      expect(r.headers.get('set-cookie')).toContain('Max-Age=0')
      // Even if the permission comes back, that session stays dead.
      expect(await putSnapshot(m, hub, 'remote_users', [ana])).toBe(204)
      expect((await get('/v1/panel/me', cookie)).status).toBe(401)
    }
  })

  it('expires after 7 days without use or 30 days anyway', async () => {
    const idle = await signedIn()
    later(7 * 24 * 3600_000 - 60_000)
    expect((await get('/v1/panel/me', idle)).status).toBe(200)
    later(7 * 24 * 3600_000 - 60_000)
    expect((await get('/v1/panel/me', idle)).status).toBe(200)
    later(7 * 24 * 3600_000)
    expect((await get('/v1/panel/me', idle)).status).toBe(401)

    m.clock.now = NOW
    const used = await signedIn()
    for (let d = 1; d < 30; d++) {
      later(24 * 3600_000)
      expect((await get('/v1/panel/me', used)).status, `day ${d}`).toBe(200)
    }
    later(24 * 3600_000)
    expect((await get('/v1/panel/me', used)).status).toBe(401)
  })

  it('sign-out ends it and clears the cookie; repeating it does not fail', async () => {
    const cookie = await signedIn()
    const r = await panelRequest(m, 'POST', '/v1/panel/sign-out', { cookie })
    expect(r.status).toBe(204)
    expect(r.headers.get('set-cookie')).toMatch(/^__Host-faro_panel=; .*Max-Age=0/)
    expect((await get('/v1/panel/me', cookie)).status).toBe(401)
    expect((await panelRequest(m, 'POST', '/v1/panel/sign-out', { cookie })).status).toBe(204)
    // From another site it is refused (and the session is not touched).
    const other = await signedIn()
    const foreign = await panelRequest(m, 'POST', '/v1/panel/sign-out', {
      cookie: other,
      origin: 'https://otro.sitio',
    })
    expect(foreign.status).toBe(403)
    expect((await get('/v1/panel/me', other)).status).toBe(200)
  })

  it('a session of one restaurant does not open another', async () => {
    const cookie = await signedIn()
    const other = await m.newHub()
    expect(await putSnapshot(m, other, 'remote_users', [ana])).toBe(204)
    const r = await get('/v1/panel/me', cookie)
    expect(((await r.json()) as { restaurant: { id: string } }).restaurant.id).toBe(
      hub.restaurantId,
    )
  })

  it('reports and the dashboard need view_reports', async () => {
    const reader = remoteUser('luis', 'clave-de-luis-1', ['remote_access'])
    expect(await putSnapshot(m, hub, 'remote_users', [ana, reader])).toBe(204)
    const r = await signIn({ username: 'luis', password: 'clave-de-luis-1' })
    const cookie = cookieFrom(r)
    expect((await get('/v1/panel/me', cookie)).status).toBe(200)
    expect((await get('/v1/panel/summary', cookie)).status).toBe(403)
    expect((await get('/v1/panel/reports', cookie)).status).toBe(403)
    expect((await get('/v1/panel/summary', null)).status).toBe(401)
    expect((await get('/v1/panel/otra', cookie)).status).toBe(404)
  })

  it('every response carries the security headers', async () => {
    const cookie = await signedIn()
    for (const r of [
      await get('/v1/panel/me', cookie),
      await get('/v1/panel/me', null),
      await signIn({}, { origin: null }),
      await panelRequest(m, 'POST', '/v1/panel/sign-out', { cookie }),
      await m.request('GET', '/v1/health'),
      await m.request('GET', '/v1/events/last', undefined, hub.credential),
    ])
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers.get(k), k).toBe(v)
  })
})

// ── Dashboard and reports ────────────────────────────────────────────────

/** An order of the day with one item, paid in cash and closed, as the hub would store it. */
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

const numbered = (events: OrderEvent[]) => events.map((e, i) => ({ ...e, sequence: i + 1 }))

describe('dashboard and reports', () => {
  const waiter = newId()

  // Now: Monday 26-oct-2026, 10:00 in Bogotá. A week earlier: 19-oct.
  const events = numbered([
    ...paidOrder('2026-10-19', '2026-10-19T14:00:00.000Z', 40_000, waiter), // before 10:00
    ...paidOrder('2026-10-19', '2026-10-19T20:00:00.000Z', 30_000, waiter), // after
    ...paidOrder('2026-10-26', '2026-10-26T14:30:00.000Z', 50_000, waiter),
  ])
  const hubReport = (from: string, until: string, list = events) => {
    const store = new MemoryStore()
    for (const e of list) store.saveEvent(e, e.id, ordersOf(e))
    return reportData(store, from, until)
  }

  beforeEach(async () => {
    expect(
      await putSnapshot(m, hub, 'people', [
        { id: waiter, name: 'Mesero Juan', role_id: null, active: true },
      ]),
    ).toBe(204)
    const r = await m.cloud.receiveEvents(hub.hub, events)
    expect(r.every((x) => x.status === 'saved')).toBe(true)
  })

  it('the dashboard: today so far, the same weekday a week ago up to now and complete, and the location', async () => {
    m.clock.now = new Date('2026-10-26T15:00:00.000Z')
    const heartbeat = await handle(
      new Request('https://cloud.faro.test/v1/events/last', {
        headers: {
          authorization: `Bearer ${hub.credential}`,
          'x-faro-hub-max': String(events.length + 4),
        },
      }),
      { sql: m.sql, clock: () => m.clock.now },
    )
    expect(heartbeat.status).toBe(200)
    const cookie = await signedIn()
    const r = await get('/v1/panel/summary', cookie)
    expect(r.status).toBe(200)
    const body = (await r.json()) as Record<string, unknown>
    const config = { sales_by_waiter: 'added_by', rounding_mode: 'half_up' } as const
    const json = (v: unknown) => JSON.parse(JSON.stringify(v))
    expect(body).toEqual({
      server_now: '2026-10-26T15:00:00.000Z',
      today: '2026-10-26',
      report: json(report({ ...hubReport('2026-10-26', '2026-10-26'), config })),
      last_week: {
        day: '2026-10-19',
        report_until_now: json(
          report({ ...hubReport('2026-10-19', '2026-10-19', events.slice(0, 4)), config }),
        ),
        report_full: json(report({ ...hubReport('2026-10-19', '2026-10-19'), config })),
      },
      users: { [waiter]: 'Mesero Juan' },
      local: {
        last_seen_at: '2026-10-26T15:00:00.000Z',
        last_event_at: '2026-10-26T14:30:00.000Z',
        pending: 4,
      },
      // Every order is closed: nothing open.
      open: { orders: 0, tables: 0, guests: 0, total: 0 },
      // No voids, discounts or variances today.
      alerts: 0,
    })
    const lastWeek = body.last_week as Record<string, { sales?: unknown }>
    expect(lastWeek.report_until_now).not.toEqual(lastWeek.report_full)
  })

  it('reports: the same as the hub’s /api/reports for any period of up to 14 days', async () => {
    const cookie = await signedIn()
    const r = await get('/v1/panel/reports?from=2026-10-19&until=2026-10-26', cookie)
    expect(r.status).toBe(200)
    const expected = periodReport(
      hubReport('2026-10-19', '2026-10-26'),
      configFrom({ business_day_start: '06:00' }),
      new Map([[waiter, 'Mesero Juan']]),
      '2026-10-26',
    )
    expect(await r.json()).toEqual(JSON.parse(JSON.stringify(expected)))
    // Without dates, today.
    const today = (await (await get('/v1/panel/reports', cookie)).json()) as { today: string }
    expect(today.today).toBe('2026-10-26')
    const bad = [
      '?from=2026-10-26&until=2026-10-19',
      '?from=2026-02-30',
      '?from=ayer',
      '?from=2026-09-01&until=2026-09-15',
    ]
    for (const q of bad) expect((await get(`/v1/panel/reports${q}`, cookie)).status, q).toBe(400)
    expect((await get('/v1/panel/reports?from=2026-09-01&until=2026-09-14', cookie)).status).toBe(
      200,
    )
  })

  it('with no config snapshot yet, it uses Bogotá and the default config', async () => {
    const g = await m.newHub()
    const user = remoteUser('caja', 'clave-de-caja-1')
    expect(await putSnapshot(m, g, 'remote_users', [user])).toBe(204)
    const r = await panelRequest(m, 'POST', '/v1/panel/sign-in', {
      body: {
        restaurant: await slugOf(m, g.restaurantId),
        username: 'caja',
        password: 'clave-de-caja-1',
      },
    })
    expect(r.status).toBe(200)
    const me = (await r.json()) as { restaurant: Record<string, unknown> }
    expect(me.restaurant.time_zone).toBe('America/Bogota')
    expect(me.restaurant.brand).toBeNull()
    expect(me.restaurant.payment_methods).toBeNull()
    const summary = await get('/v1/panel/summary', cookieFrom(r))
    expect(summary.status).toBe(200)
    expect(((await summary.json()) as { local: unknown }).local).toEqual({
      last_seen_at: null,
      last_event_at: null,
      pending: null,
    })
    expect(PANEL_ORIGIN).toBe('https://cloud.faro.test')
  })
})
