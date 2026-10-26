import { fullConfig, newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { readCatalog } from '../catalog'
import { type Device, setupPrinting } from './printing-setup'

// `POST /api/register/threshold` and what `/api/register/config` and the menu say about the
// variance threshold of the register close (task 1.7), plus the time zone and the day start in
// the menu.

type Json = Record<string, unknown>

function world(timeZone?: string) {
  const t = setupPrinting(timeZone ? { timeZone } : {})
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const waiter = t.device('waiter')
  const makeCall = (e: Device, url: string, extra: Json = {}) =>
    t.post(url, { ...e.sessionBody, ...extra }, e.token)
  const threshold = (pesos: unknown, e: Device = admin) =>
    makeCall(e, '/api/register/threshold', { pesos })
  const catalog = () => readCatalog(t.db, t.restaurantId)
  const saved = () =>
    fullConfig(
      JSON.parse(
        String(
          t.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(t.restaurantId)?.config,
        ),
      ),
    )
  const settings = async (e: Device = admin) =>
    (await makeCall(e, '/api/register/config')).json() as { register_variance_threshold: number }
  return { t, admin, cashier, waiter, makeCall, threshold, catalog, saved, settings }
}

describe('POST /api/register/threshold', () => {
  it.each([0, 1, 1000, 25_000, 1_000_000])(
    'saves $%i: 204, stored in the config and the menu',
    async (pesos) => {
      const m = world()
      const r = await m.threshold(pesos)
      expect(r.statusCode).toBe(204)
      expect(r.body).toBe('')
      expect(m.saved().register_variance_threshold).toBe(pesos)
      expect(m.catalog().restaurant.checkout?.varianceThreshold).toBe(pesos)
      expect((await m.settings()).register_variance_threshold).toBe(pesos)
    },
  )

  it('the default is $1.000, in the config and in the menu', async () => {
    const m = world()
    expect((await m.settings()).register_variance_threshold).toBe(1000)
    expect(m.catalog().restaurant.checkout?.varianceThreshold).toBe(1000)
  })

  it('notifies the change (bumps the menu version) and records the author', async () => {
    const m = world()
    const before = m.catalog().version
    await m.threshold(2_000)
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.t.catalogChanges).toEqual([m.catalog().version])
    const row = m.t.db
      .prepare('SELECT user_id, device_id FROM restaurants WHERE id = ?')
      .get(m.t.restaurantId)
    expect(row).toEqual({
      user_id: m.t.people.admin.userId,
      device_id: m.admin.connection.deviceId,
    })
  })

  it('the same value does not bump the version or notify', async () => {
    const m = world()
    const v = m.catalog().version
    await m.threshold(1000)
    expect(m.catalog().version).toBe(v)
    expect(m.t.catalogChanges).toEqual([])
  })

  it('does not touch the rest of the config', async () => {
    const m = world()
    const before = { ...m.saved(), register_variance_threshold: 0 }
    await m.threshold(0)
    expect(m.saved()).toEqual(before)
  })

  it.each([
    ['negative', -1],
    ['over the cap', 1_000_001],
    ['with decimals', 500.5],
    ['text', '1000'],
    ['null', null],
    ['NaN as text', 'NaN'],
    ['array', [1000]],
    ['missing', undefined],
  ])('rejects %s with 400 and changes nothing', async (_, pesos) => {
    const m = world()
    const r = await m.threshold(pesos)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({
      error: 'invalid_data',
      message: 'Escribe un valor entre 0 y 1.000.000',
    })
    expect(m.saved().register_variance_threshold).toBe(1000)
    expect(m.t.catalogChanges).toEqual([])
  })

  it('with extra fields: 400', async () => {
    const m = world()
    const r = await m.makeCall(m.admin, '/api/register/threshold', { pesos: 500, other: 1 })
    expect(r.statusCode).toBe(400)
    expect(m.saved().register_variance_threshold).toBe(1000)
  })

  it('no token: 401; made-up token: 401; no session: 400', async () => {
    const m = world()
    expect((await m.t.post('/api/register/threshold', { pesos: 1 })).statusCode).toBe(401)
    expect(
      (await m.t.post('/api/register/threshold', { ...m.admin.sessionBody, pesos: 1 }, 'inventado'))
        .statusCode,
    ).toBe(401)
    expect(
      (await m.t.post('/api/register/threshold', { pesos: 1 }, m.admin.token)).statusCode,
    ).toBe(400)
  })

  it('made-up session or another secret: 401', async () => {
    const m = world()
    for (const session of [
      { session_id: newId(), secret: 'inventado' },
      { session_id: m.admin.sessionBody.session_id, secret: 'other' },
    ]) {
      const r = await m.t.post('/api/register/threshold', { ...session, pesos: 1 }, m.admin.token)
      expect(r.statusCode).toBe(401)
    }
  })

  it('a session from another device does not work (401)', async () => {
    const m = world()
    const r = await m.t.post(
      '/api/register/threshold',
      { ...m.admin.sessionBody, pesos: 1 },
      m.waiter.token,
    )
    expect(r.statusCode).toBe(401)
  })

  it('the cashier and the waiter, who do not manage devices: 403 and change nothing', async () => {
    for (const who of ['cashier', 'waiter'] as const) {
      const m = world()
      const r = await m.threshold(5_000, m[who])
      expect(r.statusCode, who).toBe(403)
      expect(m.saved().register_variance_threshold).toBe(1000)
      expect(m.t.catalogChanges).toEqual([])
    }
  })

  it('a closed session: 401', async () => {
    const m = world()
    await m.t.post('/api/sessions/close', m.admin.sessionBody, m.admin.token)
    expect((await m.threshold(5_000)).statusCode).toBe(401)
  })

  it('a revoked device loses access', async () => {
    const m = world()
    await m.t.post(
      `/api/devices/${m.waiter.connection.deviceId}/revoke`,
      m.admin.sessionBody,
      m.admin.token,
    )
    expect((await m.threshold(5_000, m.waiter)).statusCode).toBe(401)
  })

  it('one restaurant threshold does not change another one', async () => {
    const m = world()
    const other = newId()
    m.t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(other, other, new Date(m.t.clock()).toISOString(), new Date(m.t.clock()).toISOString())
    m.t.db
      .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)")
      .run(other)
    await m.threshold(7_000)
    expect(readCatalog(m.t.db, other).restaurant.checkout?.varianceThreshold).toBe(1000)
    expect(m.catalog().restaurant.checkout?.varianceThreshold).toBe(7_000)
  })
})

describe('POST /api/register/config: the threshold', () => {
  it('returns it along with the payment methods, the tip and the card terminals', async () => {
    const m = world()
    await m.threshold(3_000)
    const r = (await m.makeCall(m.admin, '/api/register/config')).json() as Json
    expect(r).toMatchObject({ register_variance_threshold: 3_000, suggested_tip: 1000 })
    expect(Object.keys(r)).toEqual(
      expect.arrayContaining(['payment_methods', 'custom_methods', 'cardTerminals']),
    )
  })

  it('with an old config without the field, $1.000', async () => {
    const m = world()
    m.t.db.prepare("UPDATE restaurants SET config = '{}' WHERE id = ?").run(m.t.restaurantId)
    expect((await m.settings()).register_variance_threshold).toBe(1000)
  })

  it('the cashier does not see it (403)', async () => {
    const m = world()
    expect((await m.makeCall(m.cashier, '/api/register/config')).statusCode).toBe(403)
  })
})

describe('catalog: checkout.varianceThreshold, timeZone and businessDayStart', () => {
  it('returns the threshold from the saved config', () => {
    const m = world()
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ register_variance_threshold: 250 }), m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.varianceThreshold).toBe(250)
  })

  it('a $0 threshold arrives as 0 (not confused with «no threshold»)', () => {
    const m = world()
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ register_variance_threshold: 0 }), m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.varianceThreshold).toBe(0)
  })

  it('an old config without the field returns $1.000', () => {
    const m = world()
    m.t.db.prepare("UPDATE restaurants SET config = '{}' WHERE id = ?").run(m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.varianceThreshold).toBe(1000)
  })

  it('returns the location time zone and the business day start from the config', () => {
    const m = world()
    expect(m.catalog().restaurant.checkout).toMatchObject({
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
    })
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ business_day_start: '04:30' }), m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.businessDayStart).toBe('04:30')
  })

  it('the time zone follows the active location of the restaurant', () => {
    const m = world()
    m.t.db
      .prepare('UPDATE locations SET time_zone = ? WHERE restaurant_id = ?')
      .run('America/Mexico_City', m.t.restaurantId)
    expect(m.catalog().restaurant.checkout?.timeZone).toBe('America/Mexico_City')
  })

  it('a restaurant without a location falls back to America/Bogota', () => {
    const m = world()
    const other = newId()
    m.t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Sin sede', '{}')`,
      )
      .run(other, other, new Date(m.t.clock()).toISOString(), new Date(m.t.clock()).toISOString())
    m.t.db
      .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)")
      .run(other)
    expect(readCatalog(m.t.db, other).restaurant.checkout?.timeZone).toBe('America/Bogota')
  })
})
