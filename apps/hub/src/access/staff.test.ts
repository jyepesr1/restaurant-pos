import { describe, expect, it } from 'vitest'
import { createAppServer } from '../server'
import { SYSTEM } from './records'
import { setupAccess } from './setup'
import { readStaff, StaffError, saveRole, saveStaffMember } from './staff'

// Staff and roles (task 1.3b): the admin decides the permissions of each role.

const setup = () => {
  const m = setupAccess()
  const role = (data: Parameters<typeof saveRole>[3]) =>
    saveRole(m.db, m.restaurantId, m.access, data, SYSTEM, m.clock())
  const person = (data: Parameters<typeof saveStaffMember>[3]) =>
    saveStaffMember(m.db, m.restaurantId, m.access, data, SYSTEM, m.clock())
  const read = () => readStaff(m.db, m.restaurantId, m.access)
  return { ...m, role, person, read }
}

describe('roles', () => {
  it('a role is created with any permissions, and removing one archives it without deleting it', () => {
    const m = setup()
    const id = m.role({ name: 'Bartender', permissions: ['take_order', 'mark_product_sold_out'] })
    const ana = m.person({ name: 'Bea', roleId: id })
    expect(m.access.permissionsOf(ana.userId)).toEqual(['mark_product_sold_out', 'take_order'])

    m.role({ id, name: 'Bartender', permissions: ['take_order'] })
    expect(m.access.permissionsOf(ana.userId)).toEqual(['take_order'])
    const rows = m.db
      .prepare('SELECT permission, active FROM role_permissions WHERE role_id = ?')
      .all(id)
    expect(rows).toContainEqual({ permission: 'mark_product_sold_out', active: 0 })

    // Granting it again reactivates the same row.
    m.role({ id, name: 'Bartender', permissions: ['take_order', 'mark_product_sold_out'] })
    expect(
      m.db.prepare('SELECT count(*) AS n FROM role_permissions WHERE role_id = ?').get(id)?.n,
    ).toBe(2)
    expect(m.read().roles.find((r) => r.id === id)).toMatchObject({
      name: 'Bartender',
      system: false,
      people: 1,
      permissions: ['mark_product_sold_out', 'take_order'],
    })
  })

  it('a built-in role can change its permissions, but not its name, and cannot be archived', () => {
    const m = setup()
    m.role({ id: m.roles.cashier, name: 'Cajero', permissions: ['take_order', 'comp'] })
    expect(m.access.permissionsOf(m.people.cashier.userId)).toEqual(['comp', 'take_order'])
    expect(() => m.role({ id: m.roles.cashier, name: 'Caja', permissions: [] })).toThrow(
      /no se renombran/,
    )
    expect(() =>
      m.role({ id: m.roles.waiter, name: 'Mesero', permissions: [], active: false }),
    ).toThrow(/no se archivan/)
  })

  it('no two active roles share a name, regardless of case or matching accents', () => {
    const m = setup()
    expect(() => m.role({ name: 'mesero', permissions: [] })).toThrow(/Ya hay un rol/)
    expect(() => m.role({ name: '  ', permissions: [] })).toThrow(StaffError)
    expect(() => m.role({ name: 'X', permissions: ['delete_all'] })).toThrow(/desconocido/)
  })

  it('a role with people cannot be archived; an empty one can', () => {
    const m = setup()
    expect(() =>
      m.role({ id: m.roles.manager, name: 'Gerente', permissions: [], active: false }),
    ).toThrow(/tiene personas/)
    const empty = m.role({ name: 'Temporada', permissions: ['take_order'] })
    m.role({ id: empty, name: 'Temporada', permissions: [], active: false })
    expect(m.read().roles.find((r) => r.id === empty)?.active).toBe(false)
    // With the name free, another one with the same name can be created.
    expect(() => m.role({ name: 'Temporada', permissions: [] })).not.toThrow()
  })

  it('does not leave the restaurant without anyone who can manage staff', () => {
    const m = setup()
    const all = m.read().roles.find((r) => r.id === m.roles.admin)?.permissions ?? []
    expect(() =>
      m.role({
        id: m.roles.admin,
        name: 'Administrador',
        permissions: all.filter((p) => p !== 'manage_users'),
      }),
    ).toThrow(/Tiene que quedar al menos una persona/)
    // Nothing changed: the transaction was rolled back.
    expect(m.access.permissionsOf(m.people.admin.userId)).toContain('manage_users')
  })
})

describe('someone who signs in with a PIN cannot have register or admin permissions', () => {
  it('neither when creating them, nor when granting that permission to their role', () => {
    const m = setup()
    expect(() => m.person({ name: 'Pía', roleId: m.roles.cashier })).toThrow(
      /Pía entra con PIN y su rol permite «/,
    )
    expect(() =>
      m.role({
        id: m.roles.waiter,
        name: 'Mesero',
        permissions: ['take_order', 'record_payment'],
      }),
    ).toThrow(/entra con PIN y su rol permite «Cobrar»/)
    // Nothing changed.
    expect(m.access.permissionsOf(m.people.waiter.userId)).not.toContain('record_payment')
    // Order permissions can be granted to someone who signs in with a PIN.
    expect(() =>
      m.role({
        id: m.roles.waiter,
        name: 'Mesero',
        permissions: ['take_order', 'apply_discount', 'void_sent_item'],
      }),
    ).not.toThrow()
  })

  it('the PIN of someone with register permissions does not open a session, even without a password (old database)', () => {
    const m = setup()
    // Like a Gerente from before ADR-013: a role that charges, a person without a password.
    const ana = m.people.waiter
    m.db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(m.roles.cashier, ana.userId)
    const { connection } = m.pair('waiter')
    expect(m.access.startSession(connection, ana.pin)).toMatchObject({
      ok: false,
      message: 'PIN incorrecto',
    })
    expect(m.access.signIn({ pin: ana.pin }, null, 'ip-9')).toMatchObject({ ok: false })
  })
})

describe('reactivating someone', () => {
  it('if their PIN went to someone else, they get a new one; if their user did, they need another', () => {
    const m = setup()
    const ana = m.people.waiter
    const data = { id: ana.userId, name: 'Ana', roleId: m.roles.waiter }
    m.person({ ...data, active: false })
    // Someone else takes her PIN while she is archived.
    const fingerprint = String(
      m.db.prepare('SELECT pin_hash FROM user_credentials WHERE user_id = ?').get(ana.userId)
        ?.pin_hash,
    )
    m.db
      .prepare('UPDATE user_credentials SET pin_hash = ? WHERE user_id = ?')
      .run(fingerprint, m.people.waiter2.userId)
    const r = m.person({ ...data, active: true })
    expect(r.pin).toMatch(/^\d{4}$/)
    expect(m.read().people.find((p) => p.id === ana.userId)?.active).toBe(true)

    const carlos = m.people.cashier
    const carlosData = { id: carlos.userId, name: 'Carlos', roleId: m.roles.cashier }
    m.person({ ...carlosData, active: false })
    m.person({
      name: 'Otro Carlos',
      roleId: m.roles.cashier,
      access: { type: 'password', user: 'carlos', password: 'otra-clave-1' },
    })
    expect(() => m.person({ ...carlosData, active: true })).toThrow(/ya lo tiene otra persona/)
    expect(() =>
      m.person({
        ...carlosData,
        active: true,
        access: { type: 'password', user: 'carlos.b', password: 'nueva-clave-2' },
      }),
    ).not.toThrow()
  })
})

describe('people', () => {
  it('a new waiter signs in with their PIN; someone from the register, with user and password', () => {
    const m = setup()
    const waiter = m.person({ name: 'Pedro', roleId: m.roles.waiter })
    expect(waiter.pin).toMatch(/^\d{4}$/)
    expect(m.access.signIn({ pin: waiter.pin as string }, null, 'ip-1')).toMatchObject({ ok: true })

    const register = m.person({
      name: 'Carla',
      roleId: m.roles.cashier,
      access: { type: 'password', user: 'Carla', password: 'caja-segura-1' },
    })
    expect(
      m.access.signIn({ user: 'carla', password: 'caja-segura-1' }, null, 'ip-2'),
    ).toMatchObject({
      ok: true,
      user: { name: 'Carla' },
    })
    // Their PIN does not open a session: it only authorizes.
    expect(m.access.signIn({ pin: register.pin as string }, null, 'ip-3')).toMatchObject({
      ok: false,
    })
    expect(m.read().people.find((p) => p.id === register.userId)?.user).toBe('carla')
  })

  it('the user is unique in the restaurant and the password has at least 8 characters', () => {
    const m = setup()
    const withIt = (user: string, password?: string) => () =>
      m.person({
        name: 'X',
        roleId: m.roles.cashier,
        access: { type: 'password', user, password },
      })
    expect(withIt(String(m.people.admin.user), 'larga-12345')).toThrow(/Ya hay alguien/)
    expect(withIt('nuevo', 'corta')).toThrow(/al menos 8/)
    expect(withIt('con espacio', 'larga-12345')).toThrow(/de 3 a 40/)
    expect(withIt('nuevo')).toThrow(/Escribe una contraseña/)
    // None of those attempts left anyone created.
    expect(m.read().people.filter((p) => p.name === 'X')).toEqual([])
  })

  it('switching someone from PIN to password and back; changing the role closes their session', () => {
    const m = setup()
    const { connection } = m.pair('waiter')
    const session = m.signIn(connection, 'waiter')
    const data = { id: m.people.waiter.userId, name: 'Ana' }

    // With a PIN they cannot be in a role that charges (ADR-013)…
    expect(() => m.person({ ...data, roleId: m.roles.cashier })).toThrow(
      /Ana entra con PIN y su rol permite/,
    )
    // …in one that does not charge, they can; and changing the role closes their session.
    const bar = m.role({ name: 'Barra', permissions: ['take_order'] })
    m.person({ ...data, roleId: bar })
    expect(m.access.closeSession(connection, session)).toMatchObject({ code: 'invalid_session' })

    m.person({
      ...data,
      roleId: m.roles.cashier,
      access: { type: 'password', user: 'ana', password: 'ana-clave-99' },
    })
    expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({ ok: false })
    // Same user without a new password: nothing changes.
    expect(() =>
      m.person({
        ...data,
        roleId: m.roles.cashier,
        access: { type: 'password', user: 'ana' },
      }),
    ).not.toThrow()
    expect(() =>
      m.person({
        ...data,
        roleId: m.roles.cashier,
        access: { type: 'password', user: 'ana2' },
      }),
    ).toThrow(/escribe también una contraseña/)

    m.person({ ...data, roleId: m.roles.waiter, access: { type: 'pin' } })
    m.advance(61_000)
    expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({ ok: true })
  })

  it('regenerating the PIN gives a new one and the old one stops working; archiving frees the user', () => {
    const m = setup()
    const { connection } = m.pair('waiter')
    const data = { id: m.people.waiter.userId, name: 'Ana', roleId: m.roles.waiter }
    const r = m.person({ ...data, regeneratePin: true })
    expect(r.pin).toMatch(/^\d{4}$/)
    if (r.pin !== m.people.waiter.pin)
      expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({ ok: false })
    m.advance(61_000)
    expect(m.access.startSession(connection, r.pin as string)).toMatchObject({ ok: true })

    m.person({ ...data, active: false })
    m.advance(61_000)
    expect(m.access.startSession(connection, r.pin as string)).toMatchObject({ ok: false })
    expect(m.read().people.find((p) => p.id === data.id)?.active).toBe(false)
  })

  it('the last person who manages staff cannot be archived', () => {
    const m = setup()
    expect(() =>
      m.person({
        id: m.people.admin.userId,
        name: 'Administrador',
        roleId: m.roles.admin,
        active: false,
      }),
    ).toThrow(/Tiene que quedar al menos una persona/)
    expect(
      () =>
        m.person({
          id: m.people.admin.userId,
          name: 'Administrador',
          roleId: m.roles.admin,
          access: { type: 'pin' },
        }),
      // Before running out of admins, it hits the rule that an admin does not sign in with a PIN.
    ).toThrow(/entra con PIN y su rol permite/)
    expect(m.access.hasPassword(m.people.admin.userId)).toBe(true)
  })
})

describe('devices on the staff screen', () => {
  it('each device with its last use and by whom; the revoked one last', () => {
    const m = setup()
    const phone = m.access.signIn({ pin: m.people.waiter.pin }, null, 'ip-1')
    const register = m.access.signIn({ user: 'carlos', password: 'clave-de-carlos' }, null, 'ip-2')
    if (!phone.ok || !register.ok || !phone.device || !register.device)
      throw new Error('did not sign in')
    m.advance(60_000)
    const admin = m.access.signIn(
      {
        user: String(m.people.admin.user),
        password: String(m.people.admin.password),
      },
      null,
      'ip-3',
    )
    if (!admin.ok || !admin.device) throw new Error('did not sign in')
    const connection = m.access.authenticate(admin.device.token)
    if (!connection) throw new Error('no connection')
    m.access.revokeDevice(connection, { ...admin, deviceId: phone.device.deviceId })

    const devices = m.read().devices
    expect(devices.map((e) => [e.name, e.type, e.lastPerson, e.revokedAt !== null])).toEqual([
      ['Equipo de Administrador', 'register', 'Administrador', false],
      ['Equipo de Carlos', 'register', 'Carlos', false],
      ['Equipo de Ana', 'waiter', 'Ana', true],
    ])
  })
})

describe('staff API', () => {
  function setupApi() {
    const m = setup()
    const changes: number[] = []
    const app = createAppServer({
      access: m.access,
      catalog: {
        db: m.db,
        restaurantId: m.restaurantId,
        access: m.access,
        clock: m.clock,
        onChange: (v) => changes.push(v),
      },
    })
    const post = (url: string, body: unknown, token?: string) =>
      app.inject({
        method: 'POST',
        url,
        payload: body as object,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    return { ...m, post, changes }
  }

  it('the admin reads, creates a role and a person; devices fetch the menu again', async () => {
    const api = setupApi()
    const register = (
      await api.post('/api/sign-in', {
        user: api.people.admin.user,
        password: api.people.admin.password,
      })
    ).json()
    const session = { session_id: register.session_id, secret: register.secret }
    const token = register.device.token

    const readResult = await api.post('/api/staff/read', session, token)
    expect(readResult.statusCode).toBe(200)
    expect(readResult.json().roles.map((r: { name: string }) => r.name)).toContain('Reportes')

    const role = await api.post(
      '/api/staff/roles',
      { ...session, role: { name: 'Barra', permissions: ['take_order'] } },
      token,
    )
    expect(role.statusCode).toBe(200)
    const person = await api.post(
      '/api/staff/people',
      { ...session, person: { name: 'Bruno', role_id: role.json().id } },
      token,
    )
    expect(person.statusCode).toBe(200)
    expect(person.json().pin).toMatch(/^\d{4}$/)
    expect(api.changes).toHaveLength(2)

    const duplicate = await api.post(
      '/api/staff/roles',
      { ...session, role: { name: 'barra', permissions: [] } },
      token,
    )
    expect(duplicate.statusCode).toBe(400)
    expect(duplicate.json().message).toMatch(/Ya hay un rol/)
  })

  it('without the permission it replies 403; without a session, 401; with odd data, 400', async () => {
    const api = setupApi()
    const waiter = (await api.post('/api/sign-in', { pin: api.people.waiter.pin })).json()
    const session = { session_id: waiter.session_id, secret: waiter.secret }
    expect((await api.post('/api/staff/read', session, waiter.device.token)).statusCode).toBe(403)
    expect(
      (await api.post('/api/staff/read', { ...session, secret: 'other' }, waiter.device.token))
        .statusCode,
    ).toBe(401)
    expect((await api.post('/api/staff/read', session)).statusCode).toBe(401)
    expect(
      (await api.post('/api/staff/roles', { ...session, role: { name: 1 } }, waiter.device.token))
        .statusCode,
    ).toBe(400)
  })
})
