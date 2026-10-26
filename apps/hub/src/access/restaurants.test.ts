import { newId, PERMISSIONS } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { createAppServer } from '../server'
import { ensureAdmin, ensureRoles } from './initial'
import { insertVersioned, SYSTEM } from './records'
import { pinHash } from './secrets'
import { AccessService } from './service'
import { setupAccess } from './setup'
import { readStaff, StaffError, saveRole, saveStaffMember } from './staff'

// Two restaurants in the same database (ADR-013, multi-restaurant): users, roles, PINs, passwords,
// sessions and devices are per `restaurant_id`. Nothing from one may be seen or changed from the
// other, not even with the same hub key (the worst case: fingerprints computed with the same key).

const KEY = Buffer.alloc(32, 7)

function twoRestaurants() {
  const a = setupAccess()
  const { db } = a
  const now = a.clock()
  const idB = newId()
  db.prepare(
    `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
     VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
  ).run(idB, idB, now, now)
  db.prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)").run(idB)
  insertVersioned(
    db,
    'locations',
    idB,
    { name: 'Principal', address: null, time_zone: 'America/Bogota' },
    SYSTEM,
    now,
  )
  const rolesB = ensureRoles(db, idB, now)
  const accessB = new AccessService({
    db,
    restaurantId: idB,
    key: KEY,
    clock: a.clock,
    passwordCost: 1,
  })
  const adminB = accessB.createUser({
    name: 'Administrador B',
    roleId: rolesB.admin,
    user: 'admin',
    password: 'clave-del-admin-b',
  })
  const appA = createAppServer({
    access: a.access,
    catalog: { db, restaurantId: a.restaurantId, access: a.access, clock: a.clock },
  })
  const appB = createAppServer({
    access: accessB,
    catalog: { db, restaurantId: idB, access: accessB, clock: a.clock },
  })
  const makeCall = (app: typeof appA) => (url: string, body: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: body as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  return {
    a,
    db,
    idA: a.restaurantId,
    idB,
    rolesB,
    accessA: a.access,
    accessB,
    adminB,
    postA: makeCall(appA),
    postB: makeCall(appB),
  }
}

const withRegisterInBoth = () => {
  const m = twoRestaurants()
  const registerA = m.accessA.createUser({
    name: 'Caja A',
    roleId: m.a.roles.cashier,
    user: 'caja',
    password: 'clave-de-la-caja-a',
  })
  const registerB = m.accessB.createUser({
    name: 'Caja B',
    roleId: m.rolesB.cashier,
    user: 'caja',
    password: 'clave-de-la-caja-b',
  })
  return { ...m, registerA, registerB }
}

describe('the same user in two restaurants', () => {
  it('each password works only in its restaurant, and signs in the person of that restaurant', () => {
    const m = withRegisterInBoth()
    const inA = m.accessA.signIn({ user: 'caja', password: 'clave-de-la-caja-a' }, null, '10.0.0.1')
    const inB = m.accessB.signIn({ user: 'caja', password: 'clave-de-la-caja-b' }, null, '10.0.0.1')
    expect(inA).toMatchObject({ ok: true, user: { id: m.registerA.userId, name: 'Caja A' } })
    expect(inB).toMatchObject({ ok: true, user: { id: m.registerB.userId, name: 'Caja B' } })
    // Crossed, they do not sign in.
    expect(
      m.accessA.signIn({ user: 'caja', password: 'clave-de-la-caja-b' }, null, '10.0.0.2'),
    ).toMatchObject({
      ok: false,
      code: 'invalid_credentials',
    })
    expect(
      m.accessB.signIn({ user: 'caja', password: 'clave-de-la-caja-a' }, null, '10.0.0.2'),
    ).toMatchObject({
      ok: false,
      code: 'invalid_credentials',
    })
  })

  it('a user that exists only in the other restaurant fails the same as a made-up one', () => {
    const m = withRegisterInBoth()
    const onlyB = m.accessB.createUser({
      name: 'Solo B',
      roleId: m.rolesB.cashier,
      user: 'solo.b',
      password: 'clave-solo-b-1',
    })
    expect(onlyB.userId).toBeTruthy()
    const testSignIn = m.accessA.signIn(
      { user: 'solo.b', password: 'clave-solo-b-1' },
      null,
      '10.0.0.3',
    )
    const madeUp = m.accessA.signIn(
      { user: 'inventado', password: 'clave-solo-b-1' },
      null,
      '10.0.0.4',
    )
    expect(testSignIn).toEqual(madeUp)
  })

  it("each restaurant's admin «admin» is independent: changing one's password does not touch the other", () => {
    const m = withRegisterInBoth()
    const adminA = m.a.people.admin
    m.accessA.assignPassword(adminA.userId, 'admin', 'nueva-clave-de-a-1')
    expect(
      m.accessB.signIn({ user: 'admin', password: 'clave-del-admin-b' }, null, '10.0.0.5'),
    ).toMatchObject({ ok: true })
    expect(
      m.accessA.signIn({ user: 'admin', password: adminA.password as string }, null, '10.0.0.6'),
    ).toMatchObject({ ok: false })
    expect(
      m.accessA.signIn({ user: 'admin', password: 'nueva-clave-de-a-1' }, null, '10.0.0.7'),
    ).toMatchObject({ ok: true })
  })

  it('archiving «caja» in one restaurant frees the username there and does not touch the other «caja»', () => {
    const m = withRegisterInBoth()
    const sessionB = m.accessB.signIn(
      { user: 'caja', password: 'clave-de-la-caja-b' },
      null,
      '10.0.0.8',
    )
    expect(sessionB).toMatchObject({ ok: true })
    m.accessA.archiveUser(m.registerA.userId)
    expect(
      m.accessA.signIn({ user: 'caja', password: 'clave-de-la-caja-a' }, null, '10.0.0.9'),
    ).toMatchObject({ ok: false })
    expect(
      m.accessB.signIn({ user: 'caja', password: 'clave-de-la-caja-b' }, null, '10.0.0.10'),
    ).toMatchObject({ ok: true })
    // And the username is free in A for another person.
    expect(() =>
      m.accessA.createUser({
        name: 'Nueva caja',
        roleId: m.a.roles.cashier,
        user: 'caja',
        password: 'otra-clave-nueva-1',
      }),
    ).not.toThrow()
  })

  it("changing or removing «caja»'s password in A does not close the session of B's «caja»", () => {
    const m = withRegisterInBoth()
    const deviceB = m.accessB.signIn(
      { user: 'caja', password: 'clave-de-la-caja-b' },
      null,
      '10.0.0.11',
    )
    if (!deviceB.ok || !deviceB.device) throw new Error('did not sign in')
    const connectionB = m.accessB.authenticate(deviceB.device.token)
    if (!connectionB) throw new Error('no connection')
    m.accessA.assignPassword(m.registerA.userId, 'caja', 'clave-nueva-de-a-1')
    m.accessA.removePassword(m.registerA.userId)
    const activeSession = m.accessB.userWithPermission(
      connectionB,
      { sessionId: deviceB.sessionId, secret: deviceB.secret },
      'record_payment',
    )
    expect(activeSession).toMatchObject({ ok: true, userId: m.registerB.userId })
  })
})

describe('the same PIN in two restaurants', () => {
  /** Forces two people from different restaurants to have the same 4 digits. */
  function samePin() {
    const m = twoRestaurants()
    const waiterA = m.accessA.createUser({ name: 'Mesera A', roleId: m.a.roles.waiter })
    const waiterB = m.accessB.createUser({ name: 'Mesera B', roleId: m.rolesB.waiter })
    const setFor = (restaurant: string, userId: string) =>
      m.db
        .prepare('UPDATE user_credentials SET pin_hash = ? WHERE user_id = ?')
        .run(pinHash(KEY, restaurant, '4821'), userId)
    setFor(m.idA, waiterA.userId)
    setFor(m.idB, waiterB.userId)
    return { ...m, waiterA, waiterB }
  }

  it("the PIN leads to the person of that restaurant, and one's fingerprint is not the other's", () => {
    const m = samePin()
    expect(pinHash(KEY, m.idA, '4821')).not.toBe(pinHash(KEY, m.idB, '4821'))
    expect(m.accessA.signIn({ pin: '4821' }, null, '10.0.1.1')).toMatchObject({
      ok: true,
      user: { name: 'Mesera A' },
    })
    expect(m.accessB.signIn({ pin: '4821' }, null, '10.0.1.2')).toMatchObject({
      ok: true,
      user: { name: 'Mesera B' },
    })
  })

  it('a PIN from B does not sign in to A if nobody in A has it', () => {
    const m = samePin()
    const onlyB = m.accessB.createUser({ name: 'Solo B', roleId: m.rolesB.waiter })
    expect(onlyB.pin).toMatch(/^\d{4}$/)
    // With 10,000 possible PINs it may match one in A by chance; it is compared against A.
    const inA = m.accessA.signIn({ pin: onlyB.pin }, null, '10.0.1.3')
    const ownerInA = [
      m.a.people.waiter.pin,
      m.a.people.waiter2.pin,
      m.a.people.cashier.pin,
      m.a.people.manager.pin,
      '4821',
    ]
    if (!ownerInA.includes(onlyB.pin)) expect(inA).toMatchObject({ ok: false, code: 'wrong_pin' })
  })

  it('archiving the person in A frees the PIN in A and does not touch the one in B', () => {
    const m = samePin()
    m.accessA.archiveUser(m.waiterA.userId)
    expect(m.accessA.signIn({ pin: '4821' }, null, '10.0.1.4')).toMatchObject({ ok: false })
    expect(m.accessB.signIn({ pin: '4821' }, null, '10.0.1.5')).toMatchObject({ ok: true })
  })

  it('regenerating the PIN in A does not change the one in B', () => {
    const m = samePin()
    m.accessA.regeneratePin(m.waiterA.userId)
    expect(m.accessB.signIn({ pin: '4821' }, null, '10.0.1.6')).toMatchObject({
      ok: true,
      user: { name: 'Mesera B' },
    })
  })

  it('the authorization PIN of an admin in B does not authorize in A', () => {
    const m = samePin()
    const entry = m.accessA.signIn({ pin: '4821' }, null, '10.0.1.7')
    if (!entry.ok || !entry.device) throw new Error('did not sign in')
    const connection = m.accessA.authenticate(entry.device.token)
    if (!connection) throw new Error('no connection')
    const r = m.accessA.authorize(connection, {
      sessionId: entry.sessionId,
      secret: entry.secret,
      pin: m.adminB.pin,
      action: 'void_sent_item',
      aggregateId: '0'.repeat(26),
      eventId: '1'.repeat(26),
      fingerprint: 'a'.repeat(64),
    })
    expect(r).toMatchObject({ ok: false })
    if (!m.a.people.admin.pin.includes(m.adminB.pin)) expect(r).toMatchObject({ code: 'wrong_pin' })
  })
})

describe('sessions, devices and permissions do not cross over', () => {
  it('the token of a device in A does not exist in B, nor the other way around', () => {
    const m = withRegisterInBoth()
    const a = m.accessA.signIn({ pin: m.a.people.waiter.pin }, null, '10.0.2.1')
    const b = m.accessB.signIn({ user: 'caja', password: 'clave-de-la-caja-b' }, null, '10.0.2.2')
    if (!a.ok || !a.device || !b.ok || !b.device) throw new Error('they did not sign in')
    expect(m.accessA.authenticate(a.device.token)).not.toBeNull()
    expect(m.accessB.authenticate(a.device.token)).toBeNull()
    expect(m.accessA.authenticate(b.device.token)).toBeNull()
  })

  it("through the API: A's token and session on B's server get 401 on everything", async () => {
    const m = withRegisterInBoth()
    const r = await m.postA('/api/sign-in', {
      user: m.a.people.admin.user,
      password: m.a.people.admin.password,
    })
    const body = r.json()
    const session = { session_id: body.session_id, secret: body.secret }
    const token = body.device.token
    for (const url of ['/api/staff/read', '/api/staff/roles', '/api/staff/people'])
      expect((await m.postB(url, session, token)).statusCode, url).toBe(401)
    expect((await m.postB('/api/sign-in', { pin: m.a.people.waiter.pin }, token)).statusCode).toBe(
      401,
    )
    expect((await m.postB('/api/sessions/close', session, token)).statusCode).toBe(401)
    // In A it does work.
    expect((await m.postA('/api/staff/read', session, token)).statusCode).toBe(200)
  })

  it("B's session is not valid in A even with A's correct device (same token, foreign session)", async () => {
    const m = withRegisterInBoth()
    const inA = m.accessA.signIn(
      {
        user: m.a.people.admin.user as string,
        password: m.a.people.admin.password as string,
      },
      null,
      '10.0.2.3',
    )
    const inB = m.accessB.signIn({ user: 'admin', password: 'clave-del-admin-b' }, null, '10.0.2.4')
    if (!inA.ok || !inA.device || !inB.ok) throw new Error('they did not sign in')
    const r = await m.postA(
      '/api/staff/read',
      { session_id: inB.sessionId, secret: inB.secret },
      inA.device.token,
    )
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'invalid_session' })
  })

  it('the permissions of a user in A are empty as seen from B, and changing a role in A does not change the one in B', () => {
    const m = withRegisterInBoth()
    expect(m.accessB.permissionsOf(m.a.people.admin.userId)).toEqual([])
    expect(m.accessA.permissionsOf(m.adminB.userId)).toEqual([])
    const before = m.accessB.permissionsOf(m.registerB.userId)
    saveRole(
      m.db,
      m.idA,
      m.accessA,
      { id: m.a.roles.cashier, name: 'Cajero', permissions: ['take_order'] },
      SYSTEM,
      m.a.clock(),
    )
    expect(m.accessA.permissionsOf(m.registerA.userId)).toEqual(['take_order'])
    expect(m.accessB.permissionsOf(m.registerB.userId)).toEqual(before)
    expect(before.length).toBeGreaterThan(5)
  })

  it('a role in A has a repeated name in B without clashing: each restaurant has its own «Mesero» and «Cajero»', () => {
    const m = twoRestaurants()
    const names = (id: string) =>
      m.db
        .prepare('SELECT name FROM roles WHERE restaurant_id = ? AND system = 1 ORDER BY name')
        .all(id)
        .map((f) => f.name)
    expect(names(m.idA)).toEqual(names(m.idB))
    expect(m.a.roles.waiter).not.toBe(m.rolesB.waiter)
  })

  it('two restaurants have their own admin and each Administrador role keeps all permissions', () => {
    const m = twoRestaurants()
    const expectedList = PERMISSIONS.filter((p) => p !== 'view_own_reports').sort()
    expect(m.accessA.permissionsOf(m.a.people.admin.userId)).toEqual(expectedList)
    expect(m.accessB.permissionsOf(m.adminB.userId)).toEqual(expectedList)
  })

  it('revoking a device of B from A: «ese equipo no existe», and B does not notice', () => {
    const m = withRegisterInBoth()
    const a = m.accessA.signIn(
      {
        user: m.a.people.admin.user as string,
        password: m.a.people.admin.password as string,
      },
      null,
      '10.0.2.5',
    )
    const b = m.accessB.signIn({ pin: '0000' }, null, '10.0.2.6')
    expect(b).toMatchObject({ ok: false })
    const registerB = m.accessB.signIn(
      { user: 'caja', password: 'clave-de-la-caja-b' },
      null,
      '10.0.2.7',
    )
    if (!a.ok || !a.device || !registerB.ok || !registerB.device)
      throw new Error('they did not sign in')
    const connectionA = m.accessA.authenticate(a.device.token)
    if (!connectionA) throw new Error('no connection')
    const r = m.accessA.revokeDevice(connectionA, {
      sessionId: a.sessionId,
      secret: a.secret,
      deviceId: registerB.device.deviceId,
    })
    expect(r).toMatchObject({ ok: false, code: 'invalid_data' })
    expect(m.accessB.authenticate(registerB.device.token)).toMatchObject({ revokedAt: null })
  })
})

describe("one restaurant's staff API does not touch the other", () => {
  const staff = (m: ReturnType<typeof twoRestaurants>, id: string, access: AccessService) =>
    readStaff(m.db, id, access)

  it('reading staff lists only the people and roles of its restaurant', () => {
    const m = withRegisterInBoth()
    const a = staff(m, m.idA, m.accessA)
    const b = staff(m, m.idB, m.accessB)
    expect(a.people.map((p) => p.name)).toContain('Caja A')
    expect(a.people.map((p) => p.name)).not.toContain('Caja B')
    expect(b.people.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Caja B', 'Administrador B']),
    )
    expect(b.people.map((p) => p.name)).not.toContain('Caja A')
    const idsB = new Set(b.roles.map((r) => r.id))
    for (const r of a.roles) expect(idsB.has(r.id)).toBe(false)
    expect(b.roles.find((r) => r.id === m.rolesB.cashier)?.people).toBe(1)
  })

  it('editing from A a person or a role that belongs to B: «no existe», without changing anything in B', () => {
    const m = withRegisterInBoth()
    const before = JSON.stringify(
      m.db.prepare('SELECT * FROM users WHERE restaurant_id = ? ORDER BY id').all(m.idB),
    )
    const rolesBefore = JSON.stringify(
      m.db.prepare('SELECT * FROM role_permissions WHERE restaurant_id = ? ORDER BY id').all(m.idB),
    )
    const person = (data: Parameters<typeof saveStaffMember>[3]) => () =>
      saveStaffMember(m.db, m.idA, m.accessA, data, SYSTEM, m.a.clock())
    expect(person({ id: m.registerB.userId, name: 'Cambiada', roleId: m.a.roles.waiter })).toThrow(
      /Esa persona no existe/,
    )
    expect(person({ name: 'Intrusa', roleId: m.rolesB.admin })).toThrow(/Ese rol no existe/)
    expect(
      person({ id: m.registerB.userId, name: 'Cambiada', roleId: m.rolesB.waiter, active: false }),
    ).toThrow(StaffError)
    expect(() =>
      saveRole(
        m.db,
        m.idA,
        m.accessA,
        { id: m.rolesB.admin, name: 'Administrador', permissions: [] },
        SYSTEM,
        m.a.clock(),
      ),
    ).toThrow(/Ese rol no existe/)
    expect(
      JSON.stringify(
        m.db.prepare('SELECT * FROM users WHERE restaurant_id = ? ORDER BY id').all(m.idB),
      ),
    ).toBe(before)
    expect(
      JSON.stringify(
        m.db
          .prepare('SELECT * FROM role_permissions WHERE restaurant_id = ? ORDER BY id')
          .all(m.idB),
      ),
    ).toBe(rolesBefore)
  })

  it("A's service cannot archive, regenerate the PIN, remove or change the password of someone in B", () => {
    const m = withRegisterInBoth()
    const opened = m.accessB.signIn(
      { user: 'caja', password: 'clave-de-la-caja-b' },
      null,
      '10.0.3.1',
    )
    expect(opened).toMatchObject({ ok: true })
    const pinBefore = m.db
      .prepare('SELECT pin_hash FROM user_credentials WHERE user_id = ?')
      .get(m.registerB.userId)
    expect(() => m.accessA.regeneratePin(m.registerB.userId)).toThrow(/no tiene credencial/)
    expect(() => m.accessA.assignPassword(m.registerB.userId, 'otro', 'clave-intrusa-1')).toThrow(
      /no tiene credencial/,
    )
    m.accessA.removePassword(m.registerB.userId)
    m.accessA.archiveUser(m.registerB.userId)
    expect(m.db.prepare('SELECT active FROM users WHERE id = ?').get(m.registerB.userId)).toEqual({
      active: 1,
    })
    expect(
      m.db
        .prepare('SELECT pin_hash FROM user_credentials WHERE user_id = ?')
        .get(m.registerB.userId),
    ).toEqual(pinBefore)
    expect(m.accessB.userOf(m.registerB.userId)).toBe('caja')
    expect(
      m.db
        .prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ? AND closed_at IS NULL')
        .get(m.registerB.userId),
    ).toEqual({ n: 1 })
  })

  it('the last admin of A cannot be removed even if B has its own', () => {
    const m = twoRestaurants()
    expect(() =>
      saveStaffMember(
        m.db,
        m.idA,
        m.accessA,
        {
          id: m.a.people.admin.userId,
          name: 'Administrador',
          roleId: m.a.roles.admin,
          active: false,
        },
        SYSTEM,
        m.a.clock(),
      ),
    ).toThrow(/al menos una persona/)
    expect(
      m.accessA.signIn(
        {
          user: m.a.people.admin.user as string,
          password: m.a.people.admin.password as string,
        },
        null,
        '10.0.3.2',
      ),
    ).toMatchObject({ ok: true })
  })

  it("removing the manage permission in B does not depend on A: A's stays in place and vice versa", () => {
    const m = twoRestaurants()
    expect(() =>
      saveRole(
        m.db,
        m.idB,
        m.accessB,
        { id: m.rolesB.admin, name: 'Administrador', permissions: ['take_order'] },
        SYSTEM,
        m.a.clock(),
      ),
    ).toThrow(/al menos una persona/)
    // Within A it is possible when another person has the permission.
    const another = m.accessA.createUser({
      name: 'Otra admin',
      roleId: m.a.roles.admin,
      user: 'otra.admin',
      password: 'clave-de-otra-admin',
    })
    expect(another.userId).toBeTruthy()
    expect(() =>
      saveStaffMember(
        m.db,
        m.idA,
        m.accessA,
        {
          id: m.a.people.admin.userId,
          name: 'Administrador',
          roleId: m.a.roles.admin,
          active: false,
        },
        SYSTEM,
        m.a.clock(),
      ),
    ).not.toThrow()
  })
})

describe('startup with a second restaurant in the database', () => {
  // It used to fail: `ensureAdmin` and `freeUsername` did not filter by restaurant.
  it('a new restaurant gets its own admin even if another already has its own', () => {
    const m = twoRestaurants()
    const now = m.a.clock()
    const idC = newId()
    m.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Tercero', '{}')`,
      )
      .run(idC, idC, now, now)
    m.db
      .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)")
      .run(idC)
    insertVersioned(
      m.db,
      'locations',
      idC,
      { name: 'Principal', address: null, time_zone: 'America/Bogota' },
      SYSTEM,
      now,
    )
    const rolesC = ensureRoles(m.db, idC, now)
    const accessC = new AccessService({
      db: m.db,
      restaurantId: idC,
      key: KEY,
      clock: m.a.clock,
      passwordCost: 1,
    })
    const r = ensureAdmin(m.db, accessC, rolesC.admin, false)
    expect(r.user).toBe('admin')
    expect(
      accessC.signIn({ user: 'admin', password: r.password as string }, null, '10.0.4.1'),
    ).toMatchObject({ ok: true })
  })
})
