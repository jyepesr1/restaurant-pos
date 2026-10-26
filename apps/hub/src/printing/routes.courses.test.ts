import { fullConfig } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { readCatalog } from '../catalog'
import { type Device, setupPrinting } from './printing-setup'

// `POST /api/kitchen/courses`: turn courses (starter, main, dessert) on or off for the whole
// restaurant. Only with manage_devices. The catalog version goes up only if the value
// changes (so devices do not fetch the menu again for nothing).

type Json = Record<string, unknown>

function world() {
  const t = setupPrinting()
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const manager = t.device('manager', 'register')
  const waiter = t.device('waiter')
  const makeCall = (e: Device, url: string, extra: Json = {}) =>
    t.post(url, { ...e.sessionBody, ...extra }, e.token)
  const courses = (enabled: unknown, e: Device = admin) =>
    makeCall(e, '/api/kitchen/courses', { enabled })
  const catalog = () => readCatalog(t.db, t.restaurantId)
  const config = async () => (await makeCall(admin, '/api/kitchen/config')).json()
  const savedConfig = () =>
    JSON.parse(
      String(
        t.db.prepare('SELECT config FROM restaurants WHERE id = ?').get(t.restaurantId)?.config,
      ),
    ) as Record<string, unknown>
  return { t, admin, cashier, manager, waiter, makeCall, courses, catalog, config, savedConfig }
}

describe('POST /api/kitchen/courses: who can', () => {
  it('without a token it replies 401, even if the body is garbage', async () => {
    const { t } = world()
    for (const body of [{}, { enabled: true }, 'text', [1]]) {
      const r = await t.post('/api/kitchen/courses', body)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'invalid_token' })
    }
  })

  it('with a made-up token it replies 401', async () => {
    const { t, admin } = world()
    const r = await t.post(
      '/api/kitchen/courses',
      { ...admin.sessionBody, enabled: true },
      'inventado',
    )
    expect(r.statusCode).toBe(401)
  })

  it('with a made-up session or another secret it replies 401 and changes nothing', async () => {
    const m = world()
    for (const session of [
      { session_id: '01JB0000000000000000000000', secret: 'inventado' },
      { session_id: m.admin.sessionBody.session_id, secret: 'otro-secreto' },
    ]) {
      const r = await m.t.post('/api/kitchen/courses', { ...session, enabled: true }, m.admin.token)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ error: 'invalid_session' })
    }
    expect(m.catalog().restaurant.coursesEnabled).toBe(false)
  })

  it('without the session data it replies 400', async () => {
    const m = world()
    const r = await m.t.post('/api/kitchen/courses', { enabled: true }, m.admin.token)
    expect(r.statusCode).toBe(400)
  })

  it('a session from another device does not work (401)', async () => {
    const m = world()
    const r = await m.t.post(
      '/api/kitchen/courses',
      { ...m.admin.sessionBody, enabled: true },
      m.waiter.token,
    )
    expect(r.statusCode).toBe(401)
  })

  it.each(['cashier', 'manager', 'waiter'] as const)(
    '%s does not have manage_devices: 403 and changes nothing',
    async (who) => {
      const m = world()
      const before = m.catalog().version
      const r = await m.courses(true, m[who])
      expect(r.statusCode).toBe(403)
      expect(r.json()).toMatchObject({ error: 'no_permission' })
      expect(m.catalog().restaurant.coursesEnabled).toBe(false)
      expect(m.catalog().version).toBe(before)
      expect(m.t.catalogChanges).toEqual([])
    },
  )

  it('a revoked device loses access', async () => {
    const m = world()
    await m.t.post(
      `/api/devices/${m.waiter.connection.deviceId}/revoke`,
      m.admin.sessionBody,
      m.admin.token,
    )
    const r = await m.t.post(
      '/api/kitchen/courses',
      { ...m.waiter.sessionBody, enabled: true },
      m.waiter.token,
    )
    expect(r.statusCode).toBe(401)
  })

  it('a closed session is rejected with 401', async () => {
    const m = world()
    await m.t.post('/api/sessions/close', m.admin.sessionBody, m.admin.token)
    expect((await m.courses(true)).statusCode).toBe(401)
  })
})

describe('POST /api/kitchen/courses: invalid data', () => {
  it.each([
    ['text "true"', 'true'],
    ['number 1', 1],
    ['number 0', 0],
    ['null', null],
    ['array', [true]],
    ['object', { enabled: true }],
    ['empty string', ''],
  ])('rejects enabled = %s with 400 and changes nothing', async (_, value) => {
    const m = world()
    const before = m.catalog().version
    const r = await m.courses(value)
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'invalid_data' })
    expect(m.catalog().restaurant.coursesEnabled).toBe(false)
    expect(m.catalog().version).toBe(before)
  })

  it('rejects the body without `enabled` and with extra fields', async () => {
    const m = world()
    expect((await m.makeCall(m.admin, '/api/kitchen/courses', {})).statusCode).toBe(400)
    expect(
      (await m.makeCall(m.admin, '/api/kitchen/courses', { enabled: true, other: 1 })).statusCode,
    ).toBe(400)
    expect(m.catalog().restaurant.coursesEnabled).toBe(false)
  })
})

describe('POST /api/kitchen/courses: effect', () => {
  it('by default the restaurant does not use courses, in the menu and in the config', async () => {
    const m = world()
    expect(m.catalog().restaurant.coursesEnabled).toBe(false)
    expect((await m.config()).courses_enabled).toBe(false)
  })

  it('turning on: 204, saves it, sends it in the menu and notifies devices', async () => {
    const m = world()
    const before = m.catalog().version
    const r = await m.courses(true)
    expect(r.statusCode).toBe(204)
    expect(r.body).toBe('')
    expect(m.catalog().restaurant.coursesEnabled).toBe(true)
    expect((await m.config()).courses_enabled).toBe(true)
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.t.catalogChanges).toEqual([m.catalog().version])
  })

  it('turning on and off again: each change bumps the version', async () => {
    const m = world()
    await m.courses(true)
    const v1 = m.catalog().version
    await m.courses(false)
    const v2 = m.catalog().version
    expect(v2).toBeGreaterThan(v1)
    expect(m.catalog().restaurant.coursesEnabled).toBe(false)
    expect(m.t.catalogChanges).toHaveLength(2)
  })

  it('repeating the same value replies 204 but does NOT bump the version or notify', async () => {
    const m = world()
    await m.courses(true)
    const v = m.catalog().version
    const alerts = m.t.catalogChanges.length
    for (let i = 0; i < 3; i++) expect((await m.courses(true)).statusCode).toBe(204)
    expect(m.catalog().version).toBe(v)
    expect(m.t.catalogChanges).toHaveLength(alerts)
  })

  it('turning off when already off (the default) does not bump the version', async () => {
    const m = world()
    const before = m.catalog().version
    expect((await m.courses(false)).statusCode).toBe(204)
    expect(m.catalog().version).toBe(before)
    expect(m.t.catalogChanges).toEqual([])
  })

  it('an old config without the field counts as off: turning off changes nothing, turning on does', async () => {
    const m = world()
    const { courses_enabled: _, ...old } = fullConfig({})
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify(old), m.t.restaurantId)
    expect(m.catalog().restaurant.coursesEnabled).toBe(false)
    const before = m.catalog().version
    await m.courses(false)
    expect(m.catalog().version).toBe(before)
    await m.courses(true)
    expect(m.catalog().version).toBeGreaterThan(before)
    expect(m.catalog().restaurant.coursesEnabled).toBe(true)
  })

  it('with an empty config ({}) it fills it in with the default values', async () => {
    const m = world()
    m.t.db.prepare("UPDATE restaurants SET config = '{}' WHERE id = ?").run(m.t.restaurantId)
    await m.courses(true)
    expect(m.savedConfig()).toMatchObject({
      courses_enabled: true,
      kitchen_yellow_min: 10,
      kitchen_red_min: 20,
    })
  })

  it('keeps the rest of the config and records who changed it', async () => {
    const m = world()
    m.t.db.prepare('UPDATE restaurants SET config = ? WHERE id = ?').run(
      JSON.stringify({
        ...fullConfig({}),
        session_idle_min: 45,
        brand: 'la-spritzzeria',
      }),
      m.t.restaurantId,
    )
    await m.courses(true)
    expect(m.savedConfig()).toMatchObject({
      session_idle_min: 45,
      brand: 'la-spritzzeria',
      courses_enabled: true,
    })
    const row = m.t.db
      .prepare('SELECT user_id, device_id FROM restaurants WHERE id = ?')
      .get(m.t.restaurantId)
    expect(row?.user_id).toBe(m.admin.session.user.id)
  })

  it('changing the timers does not touch the courses, and the courses do not touch the timers', async () => {
    const m = world()
    await m.courses(true)
    await m.makeCall(m.admin, '/api/kitchen/timers', { yellow: 7, red: 15 })
    expect(m.catalog().restaurant).toMatchObject({
      coursesEnabled: true,
      kitchenYellowMin: 7,
      kitchenRedMin: 15,
    })
    await m.courses(false)
    expect(m.catalog().restaurant).toMatchObject({
      coursesEnabled: false,
      kitchenYellowMin: 7,
      kitchenRedMin: 15,
    })
  })

  it('two admins at once with different values: the last one wins and a single value remains', async () => {
    const m = world()
    const [a, b] = await Promise.all([m.courses(true), m.courses(false)])
    expect([a.statusCode, b.statusCode]).toEqual([204, 204])
    expect(typeof m.catalog().restaurant.coursesEnabled).toBe('boolean')
    expect(m.savedConfig().courses_enabled).toBe(m.catalog().restaurant.coursesEnabled)
  })
})

describe('POST /api/kitchen/timers: without changes it does not bump the version', () => {
  it('repeating the same minutes replies 204 and does not bump the version or notify', async () => {
    const m = world()
    await m.makeCall(m.admin, '/api/kitchen/timers', { yellow: 7, red: 15 })
    const v = m.catalog().version
    const alerts = m.t.catalogChanges.length
    const r = await m.makeCall(m.admin, '/api/kitchen/timers', { yellow: 7, red: 15 })
    expect(r.statusCode).toBe(204)
    expect(m.catalog().version).toBe(v)
    expect(m.t.catalogChanges).toHaveLength(alerts)
  })

  it('sending the default values (10 and 20) to a new restaurant does not bump the version', async () => {
    const m = world()
    const v = m.catalog().version
    expect(
      (await m.makeCall(m.admin, '/api/kitchen/timers', { yellow: 10, red: 20 })).statusCode,
    ).toBe(204)
    expect(m.catalog().version).toBe(v)
  })

  it('changing a single minute does bump it', async () => {
    const m = world()
    const v = m.catalog().version
    await m.makeCall(m.admin, '/api/kitchen/timers', { yellow: 11, red: 20 })
    expect(m.catalog().version).toBeGreaterThan(v)
  })

  it('«red ≤ yellow» gives 400 with the new message and changes nothing', async () => {
    const m = world()
    const v = m.catalog().version
    const r = await m.makeCall(m.admin, '/api/kitchen/timers', { yellow: 10, red: 10 })
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toBe('«Muy demorada» debe llegar después de «demorada»')
    expect(m.catalog().version).toBe(v)
  })
})
