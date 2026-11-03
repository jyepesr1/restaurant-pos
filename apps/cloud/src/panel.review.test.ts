import { newId, type OrderEvent, report } from '@pos/core'
import { MemoryStore, ordersOf, reportData } from '@pos/sync'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../packages/core/src/testing/factory'
import { handle } from './api'
import { sha256 } from './cloud'
import { sameLocalTimeDaysAgo } from './panel'
import { configFrom, periodReport } from './reports'
import type { Sql } from './sql'
import {
  cookieFrom,
  panelRequest,
  putSnapshot,
  type RemoteUser,
  remoteUser,
  slugOf,
} from './testing/panel'
import { createWorld, flatEvent, type TestHub, type World } from './testing/world'

// What the reviews of 1.11c-1 asked of the cloud: a config the reports can read (and the same
// numbers as the hub with a non-default one), «the same time last week» in the restaurant's local
// time, attempts charged even without remote_access, aggregates for events stored by the old
// Worker, odd snapshot kinds, revoking the last hub of a location, the credential fingerprint
// hidden from the API role and a heartbeat that never sinks an upload.

let m: World
let hub: TestHub
let slug: string
let ana: RemoteUser
const PASSWORD = 'clave-de-ana-2026'

beforeEach(async () => {
  m = await createWorld()
  hub = await m.newHub()
  slug = await slugOf(m, hub.restaurantId)
  ana = remoteUser('ana', PASSWORD)
  expect(await putSnapshot(m, hub, 'remote_users', [ana])).toBe(204)
})

const signIn = (password = PASSWORD, ip?: string) =>
  panelRequest(m, 'POST', '/v1/panel/sign-in', {
    body: { restaurant: slug, username: 'ana', password },
    ip,
  })
async function cookie(): Promise<string> {
  const r = await signIn()
  expect(r.status).toBe(200)
  return cookieFrom(r) as string
}
const get = (route: string, c: string | null) => panelRequest(m, 'GET', route, { cookie: c })

function hubStore(events: readonly OrderEvent[]) {
  const store = new MemoryStore()
  for (const e of events) store.saveEvent(e, e.id, ordersOf(e))
  return store
}

function paidOrder(day: string, at: string, price: number): OrderEvent[] {
  const order = newId()
  const f = { business_day: day, received_at: at } as Partial<OrderEvent>
  return [
    event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }, f),
    event(order, 'ItemAdded', itemCopy({ unit_price: price }), f),
    event(order, 'PaymentRecorded', cashPaymentData(price), f),
    event(order, 'OrderClosed', {}, f),
  ]
}
const numbered = (list: OrderEvent[]) => list.map((e, i) => ({ ...e, sequence: i + 1 }))

describe('the config snapshot', () => {
  it('one the reports cannot read is refused with a clear message (unknown key or bad value)', async () => {
    for (const config of [
      { otra_clave: 1 },
      { sales_by_waiter: 'whoever' },
      { business_day_start: '25:00' },
      { rounding_mode: 'up' },
    ]) {
      const r = await m.request(
        'PUT',
        '/v1/snapshots/config',
        { fingerprint: 'f', content: { config, time_zone: 'America/Bogota' } },
        hub.credential,
      )
      expect(r.status, JSON.stringify(config)).toBe(400)
      const body = (await r.json()) as { message: string }
      expect(body.message).toContain('La configuración del restaurante no se puede leer')
      expect(body.message).toContain(Object.keys(config)[0] as string)
    }
  })

  it('with a non-default config the cloud gives what the hub gives (and its business day)', async () => {
    const config = {
      sales_by_waiter: 'assigned_waiter',
      business_day_start: '04:00',
      rounding_mode: 'half_even',
    }
    expect(await putSnapshot(m, hub, 'config', { config, time_zone: 'America/Bogota' })).toBe(204)
    const events = numbered([
      ...paidOrder('2026-10-26', '2026-10-26T09:10:00.000Z', 40_950),
      ...paidOrder('2026-10-25', '2026-10-26T08:50:00.000Z', 12_950),
    ])
    expect((await m.cloud.receiveEvents(hub.hub, events)).every((r) => r.status === 'saved')).toBe(
      true,
    )
    // 04:30 in Bogotá: with a 04:00 start it is already the 26th (with 06:00 it would be the 25th).
    m.clock.now = new Date('2026-10-26T09:30:00.000Z')
    const c = await cookie()
    const r = await get('/v1/panel/reports?from=2026-10-25&until=2026-10-26', c)
    const expected = periodReport(
      reportData(hubStore(events), '2026-10-25', '2026-10-26'),
      configFrom(config),
      new Map(),
      '2026-10-26',
    )
    expect(await r.json()).toEqual(JSON.parse(JSON.stringify(expected)))
    expect(configFrom(config).sales_by_waiter).toBe('assigned_waiter')
  })

  it('read for reports, a field that still cannot be read takes its default alone, and the log says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const read = configFrom({ business_day_start: '04:00', sales_by_waiter: 'whoever', nueva: 1 })
    expect(read.business_day_start).toBe('04:00')
    expect(read.sales_by_waiter).toBe('added_by')
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).toMatch(/sales_by_waiter/)
    warn.mockClear()
    // A stored one the API would refuse today (written by hand): the panel still opens the day.
    await m.db.query(`INSERT INTO snapshots VALUES ($1, $2, 'config', 'x', $3, $4, now())`, [
      hub.restaurantId,
      hub.hub.locationId,
      JSON.stringify({
        config: { business_day_start: '04:00', rounding_mode: 'mal' },
        time_zone: 'America/Bogota',
      }),
      hub.hub.id,
    ])
    m.clock.now = new Date('2026-10-26T09:30:00.000Z')
    const r = await get('/v1/panel/reports', await cookie())
    expect(r.status).toBe(200)
    expect(((await r.json()) as { today: string }).today).toBe('2026-10-26')
    expect(JSON.stringify(warn.mock.calls)).toMatch(/rounding_mode/)
    warn.mockRestore()
  })
})

describe('«the same time last week»', () => {
  it('is the same local time 7 days earlier, also across a daylight saving change', () => {
    // Bogotá has no daylight saving time: it is now − 7 × 24 h.
    const now = new Date('2026-10-26T15:00:00.000Z')
    expect(sameLocalTimeDaysAgo(now, 'America/Bogota', 7)).toBe('2026-10-19T15:00:00.000Z')
    // Santiago moves its clocks forward on 6-sep-2026: 21:00 on the 12th (UTC−3) a week earlier
    // is 21:00 on the 5th (UTC−4), one hour more than 7 × 24 h before.
    const santiago = new Date('2026-09-13T00:00:00.000Z')
    expect(sameLocalTimeDaysAgo(santiago, 'America/Santiago', 7)).toBe('2026-09-06T01:00:00.000Z')
    // And back in April (5-apr-2026, UTC−3 → UTC−4).
    const april = new Date('2026-04-11T01:00:00.000Z') // 21:00 on the 10th, UTC−4
    expect(sameLocalTimeDaysAgo(april, 'America/Santiago', 7)).toBe('2026-04-04T00:00:00.000Z')
    // Milliseconds are kept.
    expect(sameLocalTimeDaysAgo(new Date('2026-10-26T15:00:00.123Z'), 'UTC', 1)).toBe(
      '2026-10-25T15:00:00.123Z',
    )
  })

  it('the dashboard cuts last week at that local time, with a 04:00 business day in Santiago', async () => {
    expect(
      await putSnapshot(m, hub, 'config', {
        config: { business_day_start: '04:00' },
        time_zone: 'America/Santiago',
      }),
    ).toBe(204)
    // Last week's business day 4-sep runs until 04:00 on the 5th (UTC−4, before the change).
    const events = numbered([
      ...paidOrder('2026-09-04', '2026-09-05T05:00:00.000Z', 10_000), // 01:00 local: before
      ...paidOrder('2026-09-04', '2026-09-05T06:00:00.000Z', 20_000), // 02:00 local: before
      ...paidOrder('2026-09-04', '2026-09-05T07:00:00.000Z', 40_000), // 03:00 local: after
    ])
    expect((await m.cloud.receiveEvents(hub.hub, events)).every((r) => r.status === 'saved')).toBe(
      true,
    )
    // Saturday 12-sep at 02:30 in Santiago (UTC−3): business day 11-sep.
    m.clock.now = new Date('2026-09-12T05:30:00.000Z')
    const r = await get('/v1/panel/summary', await cookie())
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      today: string
      last_week: { day: string; report_until_now: unknown; report_full: unknown }
    }
    expect(body.today).toBe('2026-09-11')
    expect(body.last_week.day).toBe('2026-09-04')
    const config = { sales_by_waiter: 'added_by', rounding_mode: 'half_up' } as const
    const json = (v: unknown) => JSON.parse(JSON.stringify(v))
    // 02:30 local a week earlier: the first two orders (now − 7 × 24 h would leave only one).
    expect(body.last_week.report_until_now).toEqual(
      json(
        report({ ...reportData(hubStore(events.slice(0, 8)), '2026-09-04', '2026-09-04'), config }),
      ),
    )
    expect(body.last_week.report_full).toEqual(
      json(report({ ...reportData(hubStore(events), '2026-09-04', '2026-09-04'), config })),
    )
  })
})

describe('signing in', () => {
  it('a good password without remote_access is charged like any failure (it is not revealed)', async () => {
    const luis = remoteUser('luis', 'clave-de-luis-1', ['view_reports'])
    expect(await putSnapshot(m, hub, 'remote_users', [ana, luis])).toBe(204)
    const tries = []
    for (let i = 0; i < 3; i++)
      tries.push(
        await panelRequest(m, 'POST', '/v1/panel/sign-in', {
          body: { restaurant: slug, username: 'luis', password: 'clave-de-luis-1' },
          ip: `10.0.0.${i}`,
        }),
      )
    expect(tries.map((r) => r.status)).toEqual([401, 401, 401])
    const last = (await tries[2]?.json()) as { message: string; wait_ms?: number }
    expect(last.message).toBe('Revisa el restaurante, el usuario y la contraseña.')
    expect(last.wait_ms).toBe(2000)
  })

  it('the Rate Limiting key and the attempts use the normalized username', async () => {
    const keys: string[] = []
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key)
        return { success: true }
      },
    }
    await panelRequest(
      m,
      'POST',
      '/v1/panel/sign-in',
      { body: { restaurant: slug, username: '  ÁNA ', password: 'mala-clave-1' }, ip: '1.1.1.1' },
      { limiter },
    )
    expect(keys).toContain(`user:${slug}:ana`)
    const rows = (await m.db.query<{ key: string }>('SELECT key FROM panel_attempts ORDER BY key'))
      .rows
    expect(rows.map((r) => r.key)).toEqual(['ip:1.1.1.1', 'user:ana'])
  })
})

describe('the hub side', () => {
  it('events stored by the Worker from before migration 2 get their aggregates when resent', async () => {
    const order = newId()
    const other = newId()
    const e = flatEvent(1, { aggregate_id: order, related: [other] })
    expect((await m.cloud.receiveEvents(hub.hub, [e]))[0]?.status).toBe('saved')
    // As the old Worker left it: the event without its aggregates.
    await m.db.exec('ALTER TABLE event_aggregates DISABLE TRIGGER event_aggregates_append_only')
    await m.db.query('DELETE FROM event_aggregates WHERE event_id = $1', [e.id])
    await m.db.exec('ALTER TABLE event_aggregates ENABLE TRIGGER event_aggregates_append_only')
    expect((await m.cloud.receiveEvents(hub.hub, [e]))[0]?.status).toBe('already_stored')
    const rows = (
      await m.db.query<{ aggregate_id: string; hub_sequence: string | number }>(
        'SELECT aggregate_id, hub_sequence FROM event_aggregates WHERE event_id = $1 ORDER BY 1',
        [e.id],
      )
    ).rows.map((r) => [r.aggregate_id, Number(r.hub_sequence)])
    expect(rows).toEqual([order, other].sort().map((a) => [a, 1]))
    // A divergent one (other content) still adds nothing.
    const third = newId()
    await m.cloud.receiveEvents(hub.hub, [{ ...e, related: [third], data: { x: 2 } }])
    expect(
      (await m.db.query('SELECT 1 FROM event_aggregates WHERE aggregate_id = $1', [third])).rows,
    ).toEqual([])
  })

  it('kinds named like object properties are a 400, not a 500', async () => {
    for (const kind of ['constructor', '__proto__', 'tostring', 'hasownproperty', 'valueof'])
      expect(
        (
          await m.request(
            'PUT',
            `/v1/snapshots/${kind}`,
            { fingerprint: 'f', content: {} },
            hub.credential,
          )
        ).status,
        kind,
      ).toBe(400)
  })

  it('revoking the last hub of a location removes who can sign in and ends their sessions', async () => {
    const c = await cookie()
    expect((await get('/v1/panel/me', c)).status).toBe(200)
    expect(await m.cloud.revokeHub(hub.hub.id)).toBe(true)
    expect(
      (await m.db.query('SELECT 1 FROM remote_users WHERE restaurant_id = $1', [hub.restaurantId]))
        .rows,
    ).toEqual([])
    const [session] = (
      await m.db.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM panel_sessions WHERE restaurant_id = $1',
        [hub.restaurantId],
      )
    ).rows
    expect(session?.revoked_at).not.toBeNull()
    expect((await get('/v1/panel/me', c)).status).toBe(401)
    expect((await signIn()).status).toBe(401)
    // A new hub of the same location uploads the same list again: it is taken, not «unchanged».
    const code = await m.cloud.createCode(hub.restaurantId)
    if (!code) throw new Error('no code')
    const again = await m.cloud.registerHub({
      code: code.code,
      restaurant_id: hub.restaurantId,
      hub_id: newId(),
      location_id: hub.hub.locationId,
      name: 'Caja nueva',
      instance: 'i2',
    })
    if (!again.ok) throw new Error(again.reason)
    const next = await m.cloud.authenticate(again.credential)
    if (!next) throw new Error('no hub')
    expect(
      await putSnapshot(m, { ...hub, hub: next, credential: again.credential }, 'remote_users', [
        ana,
      ]),
    ).toBe(204)
    expect((await signIn()).status).toBe(200)
  })

  it('revoking one hub while another of the location is active keeps the users', async () => {
    const code = await m.cloud.createCode(hub.restaurantId)
    if (!code) throw new Error('no code')
    const r = await m.cloud.registerHub({
      code: code.code,
      restaurant_id: hub.restaurantId,
      hub_id: newId(),
      location_id: hub.hub.locationId,
      name: 'Segunda caja',
      instance: 'i3',
    })
    if (!r.ok) throw new Error(r.reason)
    const c = await cookie()
    expect(await m.cloud.revokeHub(hub.hub.id)).toBe(true)
    expect((await get('/v1/panel/me', c)).status).toBe(200)
    expect(await m.cloud.revokeHub(hub.hub.id)).toBe(false)
  })

  it('the API role finds a hub by its credential only through hub_by_credential', async () => {
    const asApi = <T>(job: (tx: Sql) => Promise<T>) =>
      m.sql.transaction(async (tx) => {
        await tx.query('SET LOCAL ROLE faro_data')
        return job(tx)
      })
    const found = await asApi((tx) =>
      sha256(hub.credential).then((h) =>
        tx.query<{ id: string; restaurant_id: string; location_id: string }>(
          'SELECT * FROM hub_by_credential($1)',
          [h],
        ),
      ),
    )
    expect(found).toEqual([
      { id: hub.hub.id, restaurant_id: hub.restaurantId, location_id: hub.hub.locationId },
    ])
    await expect(asApi((tx) => tx.query('SELECT credential_hash FROM hubs'))).rejects.toThrow(
      /permission denied/,
    )
    await expect(asApi((tx) => tx.query('SELECT * FROM hubs'))).rejects.toThrow(/permission denied/)
    expect(await asApi((tx) => tx.query('SELECT id, location_id FROM hubs LIMIT 1'))).toHaveLength(
      1,
    )
    await m.cloud.revokeHub(hub.hub.id)
    expect(
      await asApi((tx) =>
        sha256(hub.credential).then((h) => tx.query('SELECT * FROM hub_by_credential($1)', [h])),
      ),
    ).toEqual([])
  })

  it('a heartbeat that fails never makes the upload fail', async () => {
    const failing: Sql = {
      ...m.sql,
      query: (text, params) =>
        text.includes('last_seen_at = $2')
          ? Promise.reject(Object.assign(new Error('boom'), { code: '57014' }))
          : m.sql.query(text, params),
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await handle(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${hub.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: [flatEvent(1)] }),
      }),
      { sql: failing, clock: () => m.clock.now },
    )
    expect(r.status).toBe(200)
    expect(((await r.json()) as { last_sequence: number }).last_sequence).toBe(1)
    expect(JSON.stringify(error.mock.calls)).toMatch(/heartbeat/)
    error.mockRestore()
  })
})
