import { PERMISSIONS } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { createAppServer } from '../server'
import { ensureAdmin, ensureRoles } from './initial'
import { insertVersioned, SYSTEM } from './records'
import { setupAccess } from './setup'

// Sign in without pairing (task 1.3b, ADR-013): waiters with a PIN from any browser; whoever
// has a user, with user and password. The old roles are converted at startup.

function setupApi() {
  const m = setupAccess()
  const app = createAppServer({
    access: m.access,
    catalog: { db: m.db, restaurantId: m.restaurantId, access: m.access, clock: m.clock },
  })
  const post = (url: string, body: unknown, token?: string, ip = '10.0.0.20') =>
    app.inject({
      method: 'POST',
      url,
      payload: body as object,
      remoteAddress: ip,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  const admin = { user: m.people.admin.user, password: m.people.admin.password }
  return { ...m, app, post, admin }
}

const savedType = (m: ReturnType<typeof setupAccess>, id: string) =>
  m.db.prepare('SELECT type, name FROM devices WHERE id = ?').get(id)

describe('sign in without pairing', () => {
  it('a waiter with their PIN: the hub registers the browser as a waiter device and opens the session', async () => {
    const api = setupApi()
    const r = await api.post('/api/sign-in', { pin: api.people.waiter.pin })
    expect(r.statusCode).toBe(201)
    const body = r.json()
    expect(body).toMatchObject({
      type: 'waiter',
      user: { name: 'Ana', role: 'Mesero' },
      device: { type: 'waiter', name: 'Equipo de Ana' },
    })
    expect(body.permissions).toContain('take_order')
    expect(savedType(api, body.device.device_id)).toMatchObject({ type: 'waiter' })
    // With that token it is already a device: next time it does not register another.
    const another = await api.post(
      '/api/sign-in',
      { pin: api.people.waiter2.pin },
      body.device.token,
    )
    expect(another.json()).toMatchObject({ device: null, user: { name: 'Luis' } })
    // And it closed Ana's session on that device.
    const close = await api.post(
      '/api/sessions/close',
      { session_id: body.session_id, secret: body.secret },
      body.device.token,
    )
    expect(close.statusCode).toBe(401)
  })

  it('the PIN of someone with a user does not open a session: it only authorizes', async () => {
    const api = setupApi()
    const r = await api.post('/api/sign-in', { pin: api.people.admin.pin })
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'wrong_pin', message: 'PIN incorrecto' })
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM devices').get()?.n)).toBe(0)
  })

  it('with user and password: register device, regardless of case or spaces in the user', async () => {
    const api = setupApi()
    const r = await api.post('/api/sign-in', {
      user: `  ${String(api.admin.user).toUpperCase()} `,
      password: api.admin.password,
    })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({
      type: 'register',
      user: { role: 'Administrador' },
      device: { type: 'register' },
    })
    expect(r.json().permissions).toContain('manage_users')
  })

  it('wrong password and nonexistent user give the same response, without registering devices', async () => {
    const api = setupApi()
    const bad = await api.post('/api/sign-in', {
      user: api.admin.user,
      password: 'no-es-esta',
    })
    const nobody = await api.post('/api/sign-in', { user: 'nadie', password: 'no-es-esta' })
    for (const r of [bad, nobody]) {
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({
        error: 'invalid_credentials',
        message: 'Usuario o contraseña incorrectos',
      })
    }
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM devices').get()?.n)).toBe(0)
  })

  it('trying passwords for one account from several IPs also waits', async () => {
    const api = setupApi()
    for (const [i, ip] of ['10.0.0.31', '10.0.0.32', '10.0.0.33'].entries())
      await api.post(
        '/api/sign-in',
        { user: api.admin.user, password: `mala-${i}-xxx` },
        undefined,
        ip,
      )
    const otherIp = await api.post('/api/sign-in', api.admin, undefined, '10.0.0.34')
    expect(otherIp.statusCode).toBe(429)
    expect(Number(otherIp.headers['retry-after'])).toBeGreaterThan(0)
    api.advance(61_000)
    expect((await api.post('/api/sign-in', api.admin, undefined, '10.0.0.34')).statusCode).toBe(201)
  })

  it('trying PINs without a token waits per IP; another IP does not inherit the wait', async () => {
    const api = setupApi()
    for (const pin of ['0001', '0002', '0003']) await api.post('/api/sign-in', { pin })
    expect((await api.post('/api/sign-in', { pin: api.people.waiter.pin })).statusCode).toBe(429)
    const another = await api.post(
      '/api/sign-in',
      { pin: api.people.waiter.pin },
      undefined,
      '10.0.0.99',
    )
    expect(another.statusCode).toBe(201)
  })

  it('with a password on a waiter phone, the device becomes a register', async () => {
    const api = setupApi()
    const phone = (await api.post('/api/sign-in', { pin: api.people.waiter.pin })).json()
    const r = await api.post('/api/sign-in', api.admin, phone.device.token)
    expect(r.json()).toMatchObject({ device: null, type: 'register' })
    expect(savedType(api, phone.device.device_id)).toMatchObject({ type: 'register' })
    // A waiter PIN afterwards does not turn it back into a waiter device.
    const later = await api.post('/api/sign-in', { pin: api.people.waiter.pin }, phone.device.token)
    expect(later.json()).toMatchObject({ type: 'register' })
  })

  it('with a fake token it replies 401 and registers no other device; with a revoked one, 403', async () => {
    const api = setupApi()
    const fake = await api.post('/api/sign-in', { pin: api.people.waiter.pin }, 'inventado')
    expect(fake.statusCode).toBe(401)
    expect(fake.json()).toMatchObject({ error: 'invalid_token' })

    const register = (await api.post('/api/sign-in', api.admin)).json()
    const phone = (
      await api.post('/api/sign-in', { pin: api.people.waiter.pin }, undefined, '10.0.0.50')
    ).json()
    const revoke = await api.post(
      `/api/devices/${phone.device.device_id}/revoke`,
      { session_id: register.session_id, secret: register.secret },
      register.device.token,
    )
    expect(revoke.statusCode).toBe(200)
    const after = await api.post('/api/sign-in', { pin: api.people.waiter.pin }, phone.device.token)
    expect(after.statusCode).toBe(403)
    expect(after.json()).toMatchObject({ error: 'revoked_device' })
  })

  it('a body with both PIN and password, or with extra fields, is rejected', async () => {
    const api = setupApi()
    for (const body of [
      { pin: '1234', user: 'admin', password: 'x' },
      { user: 'admin' },
      { pin: 1234 },
      {},
    ])
      expect((await api.post('/api/sign-in', body)).statusCode, JSON.stringify(body)).toBe(400)
  })
})

describe('startup of a hub from before ADR-013', () => {
  it('Contador becomes Reportes; Gerente and Cocina stay as custom roles, with their people', () => {
    const m = setupAccess()
    const legacyRole = (name: string) =>
      insertVersioned(m.db, 'roles', m.restaurantId, { name, system: 1 }, SYSTEM, m.clock())
    // An old database: without Reportes and with the three old ones.
    m.db.prepare("UPDATE roles SET name = 'Contador' WHERE id = ?").run(m.roles.reports)
    const manager = legacyRole('Gerente')
    const kitchen = legacyRole('Cocina')
    const gloria = m.access.createUser({ name: 'Gloria V', roleId: manager })

    const roles = ensureRoles(m.db, m.restaurantId, m.clock())
    expect(roles.reports).toBe(m.roles.reports)
    const row = (id: string) =>
      m.db.prepare('SELECT name, system, active FROM roles WHERE id = ?').get(id)
    expect(row(m.roles.reports)).toEqual({ name: 'Reportes', system: 1, active: 1 })
    expect(row(manager)).toEqual({ name: 'Gerente', system: 0, active: 1 })
    expect(row(kitchen)).toEqual({ name: 'Cocina', system: 0, active: 1 })
    expect(m.access.permissionsOf(gloria.userId)).toEqual([])
    // Running it again changes nothing.
    expect(ensureRoles(m.db, m.restaurantId, m.clock())).toEqual(roles)
  })

  it('an admin who signed in with a PIN gets a user and password at startup', () => {
    const m = setupAccess()
    m.access.removePassword(m.people.admin.userId)
    const r = ensureAdmin(m.db, m.access, m.roles.admin, false)
    expect(r.user).toBe('admin')
    expect(r.password).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
    expect(r.pin).toBeNull()
    expect(r.alerts.join(' ')).toMatch(/usuario y contraseña/)
    const register = m.access.signIn({ user: 'admin', password: r.password as string }, null, 'ip')
    expect(register).toMatchObject({ ok: true, user: { name: 'Administrador' } })
  })

  it('if someone else already has «admin», it gives «admin2»', () => {
    const m = setupAccess()
    m.access.removePassword(m.people.admin.userId)
    m.access.assignPassword(m.people.cashier.userId, 'admin', 'otra-clave-123')
    expect(ensureAdmin(m.db, m.access, m.roles.admin, false).user).toBe('admin2')
  })
})

describe('all permissions exist on the roles screen', () => {
  it('the built-in Administrador role has everything except «sus propias ventas»', () => {
    const m = setupAccess()
    expect(m.access.permissionsOf(m.people.admin.userId)).toEqual(
      PERMISSIONS.filter((p) => p !== 'view_own_reports').sort(),
    )
  })
})
