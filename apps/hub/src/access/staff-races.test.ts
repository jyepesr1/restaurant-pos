import { describe, expect, it } from 'vitest'
import { setupApi } from './api-setup'
import { add, OPEN_ORDER, setupHub } from './hub-setup'
import { SYSTEM } from './records'
import { pinHash } from './secrets'
import { admins, saveRole, saveStaffMember } from './staff'

// Races and mid-operation failures in staff, roles and self-registered devices (task 1.3b). The hub
// is a single process with synchronous SQLite: «at the same time» means two requests in flight
// (`Promise.all`) that the hub handles one after the other; what is tested is that the result is
// consistent in any order and that whatever fails midway leaves nothing behind.

const count = (m: { db: ReturnType<typeof setupHub>['db'] }, sql: string, ...p: string[]) =>
  Number(m.db.prepare(sql).get(...p)?.n)

/** Snapshot of what a failed change must not touch. */
function photo(m: ReturnType<typeof setupHub>) {
  const t = (sql: string) => JSON.stringify(m.db.prepare(sql).all())
  return [
    t('SELECT * FROM users ORDER BY id'),
    t('SELECT * FROM user_credentials ORDER BY user_id'),
    t('SELECT * FROM roles ORDER BY id'),
    t('SELECT * FROM role_permissions ORDER BY id'),
    t('SELECT * FROM sessions ORDER BY id'),
    t('SELECT * FROM counters ORDER BY name'),
    t('SELECT * FROM devices ORDER BY id'),
  ].join('\n')
}

async function withTwoAdmins() {
  const m = setupHub()
  const api = setupApi(m)
  const bosses = saveRole(
    m.db,
    m.restaurantId,
    m.access,
    {
      name: 'Jefes',
      permissions: ['manage_users', 'manage_devices', 'take_order'],
    },
    SYSTEM,
    m.clock(),
  )
  const boss = m.access.createUser({
    name: 'Jefa',
    roleId: bosses,
    user: 'jefa',
    password: 'clave-de-la-jefa',
  })
  const x = await api.signInAdmin()
  const r = await api.post(
    '/api/sign-in',
    { user: 'jefa', password: 'clave-de-la-jefa' },
    { ip: '10.0.0.77' },
  )
  const y = {
    token: r.json().device.token as string,
    session: { session_id: r.json().session_id as string, secret: r.json().secret as string },
  }
  const person = (who: { token: string; session: object }, p: object) =>
    api.post('/api/staff/people', { ...who.session, person: p }, { token: who.token })
  const role = (who: { token: string; session: object }, p: object) =>
    api.post('/api/staff/roles', { ...who.session, role: p }, { token: who.token })
  return { m, api, x, y, boss, bosses, person, role }
}

describe('two requests at the same time', () => {
  it('two devices create a person with the same username: one gets in and the other gets «someone already has it»', async () => {
    const { m, x, y, person } = await withTwoAdmins()
    const before = count(m, 'SELECT count(*) AS n FROM users')
    const newOne = (n: string) => ({
      name: `Carla ${n}`,
      role_id: m.roles.cashier,
      access: { type: 'password', user: 'carla', password: `clave-de-carla-${n}` },
    })
    const [a, b] = await Promise.all([person(x, newOne('uno')), person(y, newOne('dos'))])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400])
    const bad = a.statusCode === 400 ? a : b
    expect(bad.json().message).toMatch(/Ya hay alguien con el usuario «carla»/)
    expect(count(m, 'SELECT count(*) AS n FROM users')).toBe(before + 1)
    expect(count(m, "SELECT count(*) AS n FROM user_credentials WHERE username = 'carla'")).toBe(1)
    // And no orphans: every active user has a credential.
    expect(
      count(
        m,
        'SELECT count(*) AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = u.id)',
      ),
    ).toBe(0)
  })

  it('creating «the same person» twice (double submit) leaves two different people with different PINs: no idempotency', async () => {
    const { m, x, y, person } = await withTwoAdmins()
    const data = { name: 'Bruno', role_id: m.roles.waiter }
    const [a, b] = await Promise.all([person(x, data), person(y, data)])
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])
    expect(a.json().id).not.toBe(b.json().id)
    expect(a.json().pin).not.toBe(b.json().pin)
    expect(count(m, "SELECT count(*) AS n FROM users WHERE name = 'Bruno'")).toBe(2)
  })

  it('40 waiters created at once from two devices: all with distinct 4-digit PINs that sign in', async () => {
    const { m, api, x, y, person } = await withTwoAdmins()
    const batch = Array.from({ length: 40 }, (_, i) =>
      person(i % 2 ? x : y, { name: `Mesero ${i}`, role_id: m.roles.waiter }),
    )
    const res = await Promise.all(batch)
    const pins = res.map((r) => r.json().pin as string)
    expect(res.every((r) => r.statusCode === 200)).toBe(true)
    expect(new Set(pins).size).toBe(40)
    for (const pin of pins) expect(pin).toMatch(/^\d{4}$/)
    // Each PIN signs in its person (different IP: no wait).
    for (const [i, pin] of pins.slice(0, 6).entries()) {
      const r = await api.post('/api/sign-in', { pin }, { ip: `10.20.0.${i + 1}` })
      expect(r.statusCode).toBe(201)
    }
  })

  it("each one removes the manage permission from the other's role at the same time: one is accepted, the other loses its permission, and one remains", async () => {
    const { m, x, y, bosses, role } = await withTwoAdmins()
    const without = (id: string) =>
      (
        m.db
          .prepare('SELECT permission FROM role_permissions WHERE role_id = ? AND active = 1')
          .all(id) as {
          permission: string
        }[]
      )
        .map((f) => f.permission)
        .filter((p) => p !== 'manage_users')
    const [a, b] = await Promise.all([
      role(y, { id: m.roles.admin, name: 'Administrador', permissions: without(m.roles.admin) }),
      role(x, { id: bosses, name: 'Jefes', permissions: without(bosses) }),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 403])
    expect(admins(m.db, m.restaurantId)).toHaveLength(1)
  })

  it('the admin and the boss archive each other at the same time: exactly one stays active', async () => {
    const { m, x, y, boss, person } = await withTwoAdmins()
    const [a, b] = await Promise.all([
      person(x, {
        id: boss.userId,
        name: 'Jefa',
        role_id: m.db.prepare('SELECT role_id FROM users WHERE id = ?').get(boss.userId)
          ?.role_id as string,
        active: false,
      }),
      person(y, {
        id: m.people.admin.userId,
        name: 'Administrador',
        role_id: m.roles.admin,
        active: false,
      }),
    ])
    const statuses = [a.statusCode, b.statusCode].sort()
    // The first archives the other (200); the second has no session left (401), or is the last one.
    expect(statuses[0]).toBe(200)
    expect([400, 401, 403]).toContain(statuses[1])
    expect(admins(m.db, m.restaurantId)).toHaveLength(1)
  })

  it('each separate path to leave nobody managing is rejected and leaves nothing half done', async () => {
    const m = setupHub()
    const api = setupApi(m)
    const { token, session } = await api.signInAdmin()
    const adminId = m.people.admin.userId
    const person = (p: object) =>
      api.post('/api/staff/people', { ...session, person: p }, { token })
    const role = (p: object) => api.post('/api/staff/roles', { ...session, role: p }, { token })
    const before = photo(m)
    const paths = {
      archiveIt: () =>
        person({ id: adminId, name: 'Administrador', role_id: m.roles.admin, active: false }),
      move_to_waiter: () => person({ id: adminId, name: 'Administrador', role_id: m.roles.waiter }),
      remove_password: () =>
        person({
          id: adminId,
          name: 'Administrador',
          role_id: m.roles.admin,
          access: { type: 'pin' },
        }),
      remove_permission_from_role: () =>
        role({ id: m.roles.admin, name: 'Administrador', permissions: ['take_order'] }),
    }
    for (const [path, act] of Object.entries(paths)) {
      const r = await act()
      expect(r.statusCode, path).toBe(400)
      expect(photo(m), path).toBe(before)
    }
    // And it can still manage.
    expect((await api.post('/api/staff/read', session, { token })).statusCode).toBe(200)
  })
})

describe('failures midway through an operation (nested transactions)', () => {
  it('creating someone with an invalid username fails after inserting: no person, credential or used-up version remains', () => {
    const m = setupHub()
    const before = photo(m)
    expect(() =>
      m.access.createUser({
        name: 'Rosa',
        roleId: m.roles.cashier,
        user: 'x',
        password: 'clave-correcta-1',
      }),
    ).toThrow()
    expect(() =>
      m.access.createUser({
        name: 'Rosa',
        roleId: m.roles.cashier,
        user: 'rosa',
        password: 'corta',
      }),
    ).toThrow()
    expect(photo(m)).toBe(before)
  })

  it("changing someone's role and username fails on the username (taken): the role does not change and their sessions are not closed", async () => {
    const m = setupHub()
    const api = setupApi(m)
    const { token, session } = await api.signInAdmin()
    const atRegister = m.access.signIn(
      { user: 'carlos', password: 'clave-de-carlos' },
      null,
      '10.0.0.5',
    )
    expect(atRegister).toMatchObject({ ok: true })
    const before = photo(m)
    const r = await api.post(
      '/api/staff/people',
      {
        ...session,
        person: {
          id: m.people.cashier.userId,
          name: 'Carlos Cambiado',
          role_id: m.roles.reports,
          access: {
            type: 'password',
            user: m.people.admin.user,
            password: 'otra-clave-larga',
          },
        },
      },
      { token },
    )
    expect(r.statusCode).toBe(400)
    expect(photo(m)).toBe(before)
  })

  it('a role whose permission change leaves the restaurant without an admin does not archive or reactivate permissions halfway', () => {
    const m = setupHub()
    const before = photo(m)
    expect(() =>
      saveRole(
        m.db,
        m.restaurantId,
        m.access,
        { id: m.roles.admin, name: 'Administrador', permissions: ['take_order', 'comp'] },
        SYSTEM,
        m.clock(),
      ),
    ).toThrow()
    expect(photo(m)).toBe(before)
  })

  it('signing in without a token and failing to open the session: the browser is not registered as a device', () => {
    const m = setupHub()
    m.db.exec(
      "CREATE TRIGGER sessions_fail BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'disco lleno'); END",
    )
    const before = photo(m)
    expect(() => m.access.signIn({ pin: m.people.waiter.pin }, null, '10.0.0.6')).toThrow(
      /disco lleno/,
    )
    expect(photo(m)).toBe(before)
    expect(count(m, 'SELECT count(*) AS n FROM device_credentials')).toBe(0)
    m.db.exec('DROP TRIGGER sessions_fail')
    // Without the fault, it signs in normally: the database is still usable.
    expect(m.access.signIn({ pin: m.people.waiter.pin }, null, '10.0.0.7')).toMatchObject({
      ok: true,
    })
  })

  it('upgrading a waiter device to register and failing to open the session: the device stays a waiter device', () => {
    const m = setupHub()
    const phone = m.access.signIn({ pin: m.people.waiter.pin }, null, '10.0.0.8')
    if (!phone.ok || !phone.device) throw new Error('did not sign in')
    const connection = m.access.authenticate(phone.device.token)
    if (!connection) throw new Error('no connection')
    m.db.exec(
      "CREATE TRIGGER sessions_fail BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'falla'); END",
    )
    const before = photo(m)
    expect(() =>
      m.access.signIn({ user: 'carlos', password: 'clave-de-carlos' }, connection, '10.0.0.9'),
    ).toThrow(/falla/)
    expect(photo(m)).toBe(before)
    expect(m.db.prepare('SELECT type FROM devices WHERE id = ?').get(connection.deviceId)).toEqual({
      type: 'waiter',
    })
  })

  // Found by qa-pruebas in 1.3b and already fixed: without its own error handler, Fastify returns
  // the exception message in a 500: SQLite texts («UNIQUE constraint failed: user_credentials…»,
  // table and column names) reach any browser on the network. A generic message was expected,
  // with no details.
  it("a 500 does not show the exception's internal message", async () => {
    const m = setupHub()
    const api = setupApi(m)
    m.db.exec(
      "CREATE TRIGGER sessions_fail BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'secreto-interno'); END",
    )
    const r = await api.post('/api/sign-in', { pin: m.people.waiter.pin })
    expect(r.statusCode).toBe(500)
    expect(r.body).not.toContain('secreto-interno')
  })

  it('after an internal 500, the hub keeps serving and nothing is left half done', async () => {
    const m = setupHub()
    const api = setupApi(m)
    m.db.exec(
      "CREATE TRIGGER sessions_fail BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'falla'); END",
    )
    const before = photo(m)
    expect((await api.post('/api/sign-in', { pin: m.people.waiter.pin })).statusCode).toBe(500)
    expect(photo(m)).toBe(before)
    m.db.exec('DROP TRIGGER sessions_fail')
    expect(
      (await api.post('/api/sign-in', { pin: m.people.waiter.pin }, { ip: '10.0.0.30' }))
        .statusCode,
    ).toBe(201)
  })
})

describe('self-registered device and revocation', () => {
  function phone() {
    const m = setupHub()
    const e = m.access.signIn({ pin: m.people.waiter.pin }, null, '10.0.5.1')
    if (!e.ok || !e.device) throw new Error('did not sign in')
    const connection = m.access.authenticate(e.device.token)
    if (!connection) throw new Error('no connection')
    const register = m.access.signIn(
      {
        user: m.people.admin.user as string,
        password: m.people.admin.password as string,
      },
      null,
      '10.0.5.2',
    )
    if (!register.ok || !register.device) throw new Error('register did not sign in')
    const registerConnection = m.access.authenticate(register.device.token)
    if (!registerConnection) throw new Error('no connection')
    const open = (time: string) =>
      m.event(connection, e, 'OrderOpened', OPEN_ORDER, {
        device_time: time,
        hub_estimated_time: time,
      })
    const revoke = () => {
      const r = m.access.revokeDevice(registerConnection, {
        sessionId: register.sessionId,
        secret: register.secret,
        deviceId: connection.deviceId,
      })
      if (!r.ok) throw new Error(r.message)
      return r.revokedAt
    }
    return { m, e, connection, register, registerConnection, open, revoke }
  }

  it('revoking it cuts off its token on every sign-in route and its session; notifies the floor', () => {
    const c = phone()
    c.revoke()
    expect(c.m.revokedIds).toContain(c.connection.deviceId)
    const revokedDevice = c.m.access.authenticate(c.e.device?.token as string)
    expect(revokedDevice?.revokedAt).not.toBeNull()
    expect(
      c.m.access.signIn({ pin: c.m.people.waiter2.pin }, revokedDevice, '10.0.5.3'),
    ).toMatchObject({
      ok: false,
      code: 'revoked_device',
    })
    expect(c.m.access.startSession(revokedDevice as never, c.m.people.waiter2.pin)).toMatchObject({
      ok: false,
      code: 'revoked_device',
    })
    expect(c.m.access.closeSession(revokedDevice as never, c.e)).toMatchObject({ ok: false })
  })

  it('what the phone created before the revocation goes to quarantine; anything later, rejected', () => {
    const c = phone()
    const before = c.open(c.m.clock())
    c.m.advance(5000)
    const revokedAt = c.revoke()
    const after = c.open(add(revokedAt, 1000))
    // The connection the floor builds when the batch arrives already carries the revocation.
    const connection = c.m.access.authenticate(c.e.device?.token as string) as never
    const r = c.m.hub.receiveBatch(connection, [before, after])
    expect(r.results.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
  })

  it('one cannot revoke the device one is signed in from, nor revoke one twice with different dates', () => {
    const c = phone()
    expect(
      c.m.access.revokeDevice(c.registerConnection, {
        sessionId: c.register.sessionId,
        secret: c.register.secret,
        deviceId: c.registerConnection.deviceId,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_data' })
    const first = c.revoke()
    c.m.advance(60_000)
    expect(c.revoke()).toBe(first)
  })

  it('a waiter cannot revoke devices: their session lacks manage_devices', () => {
    const c = phone()
    const other = c.m.access.signIn({ pin: c.m.people.waiter2.pin }, null, '10.0.5.4')
    if (!other.ok || !other.device) throw new Error('did not sign in')
    const connection = c.m.access.authenticate(other.device.token) as never
    expect(
      c.m.access.revokeDevice(connection, {
        sessionId: other.sessionId,
        secret: other.secret,
        deviceId: c.connection.deviceId,
      }),
    ).toMatchObject({ ok: false, code: 'no_permission' })
  })

  it('the revoked device can register again if it clears its token (revocation is of the token, not the hardware): accepted risk', () => {
    const c = phone()
    c.revoke()
    const re_entry = c.m.access.signIn({ pin: c.m.people.waiter.pin }, null, '10.0.5.1')
    expect(re_entry).toMatchObject({ ok: true })
    if (re_entry.ok) expect(re_entry.device?.deviceId).not.toBe(c.connection.deviceId)
  })
})

describe("open session while its role's permissions change", () => {
  it("removing manage_users from an open session's role cuts off the staff API instantly", async () => {
    const { m, api, y, bosses, person } = await withTwoAdmins()
    expect((await api.post('/api/staff/read', y.session, { token: y.token })).statusCode).toBe(200)
    saveRole(
      m.db,
      m.restaurantId,
      m.access,
      { id: bosses, name: 'Jefes', permissions: ['take_order'] },
      SYSTEM,
      m.clock(),
    )
    for (const url of ['/api/staff/read'])
      expect((await api.post(url, y.session, { token: y.token })).statusCode).toBe(403)
    expect((await person(y, { name: 'Intruso', role_id: m.roles.waiter })).statusCode).toBe(403)
  })

  it('the waiter loses «take_order» with the session open: earlier events go to quarantine, later ones are rejected', () => {
    const m = setupHub()
    const e = m.access.signIn({ pin: m.people.waiter.pin }, null, '10.0.6.1')
    if (!e.ok || !e.device) throw new Error('did not sign in')
    // Sign-in brought the permissions of that moment; the hub judges with the current ones.
    expect(e.permissions).toContain('take_order')
    const connection = m.access.authenticate(e.device.token) as never
    const before = m.event(connection, e, 'OrderOpened', OPEN_ORDER)
    m.advance(10 * 60_000)
    saveRole(
      m.db,
      m.restaurantId,
      m.access,
      { id: m.roles.waiter, name: 'Mesero', permissions: ['view_own_reports'] },
      SYSTEM,
      m.clock(),
    )
    const change = m.clock()
    m.advance(1000)
    const after = m.event(connection, e, 'OrderOpened', OPEN_ORDER, {
      device_time: add(change, 500),
      hub_estimated_time: add(change, 500),
    })
    const r = m.hub.receiveBatch(connection, [before, after])
    expect(r.results.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
    expect(r.results[1]).toMatchObject({ reason: 'no_permission' })
  })

  it('when the role gets a new permission, the open session uses it without signing in again', () => {
    const m = setupHub()
    const e = m.access.signIn({ pin: m.people.waiter.pin }, null, '10.0.6.2')
    if (!e.ok || !e.device) throw new Error('did not sign in')
    const connection = m.access.authenticate(e.device.token) as never
    expect(e.permissions).not.toContain('mark_product_sold_out')
    const before = m.access.userWithPermission(connection, e, 'mark_product_sold_out')
    expect(before).toMatchObject({ ok: false, code: 'no_permission' })
    saveRole(
      m.db,
      m.restaurantId,
      m.access,
      {
        id: m.roles.waiter,
        name: 'Mesero',
        permissions: [...e.permissions, 'mark_product_sold_out'],
      },
      SYSTEM,
      m.clock(),
    )
    expect(m.access.userWithPermission(connection, e, 'mark_product_sold_out')).toMatchObject({
      ok: true,
    })
  })
})

describe('a waiter who switches to a password with their session open', () => {
  it('their session closes, their PIN no longer signs in but still authorizes, and they sign in with the password', async () => {
    const { m, api, x } = await withTwoAdmins()
    // Ana (PIN) with an open session on her phone and an event made offline.
    const e = m.access.signIn({ pin: m.people.waiter.pin }, null, '10.0.7.1')
    if (!e.ok || !e.device) throw new Error('did not sign in')
    const connection = m.access.authenticate(e.device.token) as never
    const doneBefore = m.event(connection, e, 'OrderOpened', OPEN_ORDER)
    m.advance(60_000)
    const r = await api.post(
      '/api/staff/people',
      {
        ...x.session,
        person: {
          id: m.people.waiter.userId,
          name: 'Ana',
          role_id: m.roles.cashier,
          access: { type: 'password', user: 'ana', password: 'clave-de-ana-1' },
        },
      },
      { token: x.token },
    )
    expect(r.statusCode).toBe(200)
    // Session closed: the phone has to sign in again.
    expect(m.access.closeSession(connection, e)).toMatchObject({
      ok: false,
      code: 'invalid_session',
    })
    // The PIN no longer signs in (neither without a token nor with her phone's token).
    expect(m.access.signIn({ pin: m.people.waiter.pin }, connection, '10.0.7.2')).toMatchObject({
      ok: false,
      code: 'wrong_pin',
    })
    // The password does, and the phone becomes a register (her role charges).
    const later = m.access.signIn(
      { user: 'ANA', password: 'clave-de-ana-1' },
      connection,
      '10.0.7.3',
    )
    expect(later).toMatchObject({ ok: true, type: 'register', user: { name: 'Ana' } })
    // What she did before the change, with the session of that time, the hub approves.
    expect(m.hub.receiveBatch(connection, [doneBefore]).results[0]?.status).toBe('confirmed')
  })

  it('an event signed with the closed session, created after the change, is rejected', async () => {
    const { m, api, x } = await withTwoAdmins()
    const e = m.access.signIn({ pin: m.people.waiter.pin }, null, '10.0.7.4')
    if (!e.ok || !e.device) throw new Error('did not sign in')
    const connection = m.access.authenticate(e.device.token) as never
    await api.post(
      '/api/staff/people',
      {
        ...x.session,
        person: {
          id: m.people.waiter.userId,
          name: 'Ana',
          role_id: m.roles.waiter,
          access: { type: 'password', user: 'ana', password: 'clave-de-ana-1' },
        },
      },
      { token: x.token },
    )
    m.advance(5 * 60_000)
    const after = m.event(connection, e, 'OrderOpened', OPEN_ORDER)
    expect(m.hub.receiveBatch(connection, [after]).results[0]).toMatchObject({
      status: 'rejected',
      reason: 'session_closed',
    })
  })

  it("the authorization PIN of someone with a password still authorizes on the waiter's phone", () => {
    const m = setupHub()
    const e = m.access.signIn({ pin: m.people.waiter.pin }, null, '10.0.7.5')
    if (!e.ok || !e.device) throw new Error('did not sign in')
    const connection = m.access.authenticate(e.device.token) as never
    const r = m.access.authorize(connection, {
      sessionId: e.sessionId,
      secret: e.secret,
      pin: m.people.cashier.pin,
      action: 'void_sent_item',
      aggregateId: '0'.repeat(26),
      eventId: '1'.repeat(26),
      fingerprint: 'a'.repeat(64),
    })
    expect(r).toMatchObject({ ok: true, supervisor: { name: 'Carlos' } })
  })
})

describe('reactivating someone who was archived', () => {
  it('if someone else took their username: clear error (400) and they are not left half active', async () => {
    const { m, api, x, person } = await withTwoAdmins()
    const carla = (
      await person(x, {
        name: 'Carla',
        role_id: m.roles.cashier,
        access: { type: 'password', user: 'carla', password: 'clave-de-carla-1' },
      })
    ).json()
    await person(x, { id: carla.id, name: 'Carla', role_id: m.roles.cashier, active: false })
    await person(x, {
      name: 'Carla II',
      role_id: m.roles.cashier,
      access: { type: 'password', user: 'carla', password: 'clave-de-carla-2' },
    })
    const before = photo(m)
    const r = await person(x, {
      id: carla.id,
      name: 'Carla',
      role_id: m.roles.cashier,
      active: true,
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toMatch(/ya lo tiene otra persona/)
    expect(photo(m)).toBe(before)
    // Giving her another username with a password works.
    const fine = await person(x, {
      id: carla.id,
      name: 'Carla',
      role_id: m.roles.cashier,
      active: true,
      access: { type: 'password', user: 'carla.vieja', password: 'clave-de-carla-3' },
    })
    expect(fine.statusCode).toBe(200)
    void api
  })

  it('if someone else took her PIN while she was archived, she gets a new PIN on reactivation', async () => {
    const { m, x, person } = await withTwoAdmins()
    const bea = (await person(x, { name: 'Bea', role_id: m.roles.waiter })).json()
    await person(x, { id: bea.id, name: 'Bea', role_id: m.roles.waiter, active: false })
    // Another person gets the same PIN by chance (forced in the database).
    const cora = (await person(x, { name: 'Cora', role_id: m.roles.waiter })).json()
    m.db
      .prepare('UPDATE user_credentials SET pin_hash = ? WHERE user_id = ?')
      .run(pinHash(Buffer.alloc(32, 7), m.restaurantId, bea.pin), cora.id)
    const r = await person(x, { id: bea.id, name: 'Bea', role_id: m.roles.waiter, active: true })
    expect(r.statusCode).toBe(200)
    expect(r.json().pin).toMatch(/^\d{4}$/)
    expect(r.json().pin).not.toBe(bea.pin)
    // Each one signs in with her own.
    expect(m.access.signIn({ pin: bea.pin }, null, '10.0.8.1')).toMatchObject({
      ok: true,
      user: { name: 'Cora' },
    })
    expect(m.access.signIn({ pin: r.json().pin }, null, '10.0.8.2')).toMatchObject({
      ok: true,
      user: { name: 'Bea' },
    })
  })
})

void saveStaffMember
