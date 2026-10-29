import { describe, expect, it } from 'vitest'
import { setupApi } from './api-setup'

// The staff API with odd data and without permission (task 1.3b): always a clear 4xx, never a
// 500; what is rejected does not change the database, notify devices or echo secrets.

async function admin() {
  const api = setupApi()
  const { token, session } = await api.signInAdmin()
  const person = (p: unknown, extra: object = {}) =>
    api.post('/api/staff/people', { ...session, person: p, ...extra }, { token })
  const role = (r: unknown) => api.post('/api/staff/roles', { ...session, role: r }, { token })
  const version = () =>
    Number(api.db.prepare("SELECT value FROM counters WHERE name = 'catalog'").get()?.value)
  return { api, token, session, person, role, version }
}

const validBody = (roleId: string) => ({ name: 'Bruno', role_id: roleId })

describe('people with odd data', () => {
  it('extra, missing or wrongly typed fields: 400 and the database neither changes nor notifies', async () => {
    const { api, person, version } = await admin()
    const v = version()
    const invalid: unknown[] = [
      null,
      42,
      'text',
      [],
      {},
      { name: 'X' },
      { role_id: api.roles.waiter },
      { ...validBody(api.roles.waiter), extra: 1 },
      { ...validBody(api.roles.waiter), name: 7 },
      { ...validBody(api.roles.waiter), role_id: 7 },
      { ...validBody(api.roles.waiter), role_id: 'corto' },
      { ...validBody(api.roles.waiter), role_id: 'x'.repeat(27) },
      { ...validBody(api.roles.waiter), id: 'no-es-ulid' },
      { ...validBody(api.roles.waiter), active: 'yes' },
      { ...validBody(api.roles.waiter), regenerate_pin: 1 },
      { ...validBody(api.roles.waiter), access: 'pin' },
      { ...validBody(api.roles.waiter), access: { type: 'other' } },
      { ...validBody(api.roles.waiter), access: { type: 'pin', user: 'x' } },
      { ...validBody(api.roles.waiter), access: { type: 'password' } },
      { ...validBody(api.roles.waiter), access: { type: 'password', user: 5 } },
      {
        ...validBody(api.roles.waiter),
        access: { type: 'password', user: 'u'.repeat(101), password: 'clave-larga-1' },
      },
      {
        ...validBody(api.roles.waiter),
        access: { type: 'password', user: 'bruno', password: 'c'.repeat(201) },
      },
      { ...validBody(api.roles.waiter), name: 'n'.repeat(101) },
    ]
    for (const p of invalid) {
      const r = await person(p)
      expect(r.statusCode, JSON.stringify(p)).toBe(400)
    }
    expect(version()).toBe(v)
    expect(api.catalogChanges).toEqual([])
  })

  it('service name rules: empty, spaces only, 61 letters; and the message is clear', async () => {
    const { api, person } = await admin()
    for (const name of ['', '   ', '\t\n', 'n'.repeat(61)]) {
      const r = await person({ name, role_id: api.roles.waiter })
      expect(r.statusCode, JSON.stringify(name)).toBe(400)
      expect(r.json().message).toMatch(/entre 1 y 60/)
    }
    expect((await person({ name: 'n'.repeat(60), role_id: api.roles.waiter })).statusCode).toBe(200)
  })

  it('names with Unicode, emoji, HTML or SQL are stored as text and come back the same', async () => {
    const { api, person, session, token } = await admin()
    const names = [
      'María José Peña',
      '李小龍',
      '👩‍🍳 Chef',
      '<img src=x onerror=alert(1)>',
      "Robert'); DROP TABLE usuario;--",
      'مرحبا',
    ]
    for (const name of names)
      expect((await person({ name, role_id: api.roles.waiter })).statusCode, name).toBe(200)
    const readResult = (await api.post('/api/staff/read', session, { token })).json()
    const savedList = readResult.people.map((p: { name: string }) => p.name)
    for (const name of names) expect(savedList).toContain(name.trim())
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM users').get()?.n)).toBeGreaterThan(
      names.length,
    )
  })

  it('a name with a null character breaks nothing: it is stored or rejected, but no 500', async () => {
    const { api, person } = await admin()
    const r = await person({ name: 'a\u0000b', role_id: api.roles.waiter })
    expect(r.statusCode).toBeLessThan(500)
  })

  it('role that does not exist, with another kind of id, or archived: 400 with a message', async () => {
    const { api, person, role } = await admin()
    const empty = (await role({ name: 'Temporal', permissions: ['take_order'] })).json().id
    await role({ id: empty, name: 'Temporal', permissions: [], active: false })
    const nonexistent = '0'.repeat(26)
    expect((await person({ name: 'Bruno', role_id: nonexistent })).json().message).toMatch(
      /Ese rol no existe/,
    )
    expect((await person({ name: 'Bruno', role_id: empty })).json().message).toMatch(/archivado/)
    expect(
      (await person({ id: nonexistent, name: 'Bruno', role_id: api.roles.waiter })).json().message,
    ).toMatch(/no existe/)
  })

  it('a required new password, and a short one: clear messages; and it is never echoed in the response', async () => {
    const { api, person } = await admin()
    const withoutKey = await person({
      name: 'Carla',
      role_id: api.roles.cashier,
      access: { type: 'password', user: 'carla' },
    })
    expect(withoutKey.statusCode).toBe(400)
    expect(withoutKey.json().message).toMatch(/contraseña/)
    const short = await person({
      name: 'Carla',
      role_id: api.roles.cashier,
      access: { type: 'password', user: 'carla', password: 'corta' },
    })
    expect(short.statusCode).toBe(400)
    expect(short.body).not.toContain('"corta"')
    const ok = await person({
      name: 'Carla',
      role_id: api.roles.cashier,
      access: { type: 'password', user: 'carla', password: 'esta-es-la-clave-1' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.body).not.toContain('esta-es-la-clave-1')
    expect(ok.body).not.toMatch(/scrypt|pin_hash|password_hash/)
  })

  it('PIN-only access cannot be given a role that charges or administers: clear error and nothing saved', async () => {
    const { api, person, version } = await admin()
    const v = version()
    const r = await person({
      name: 'Cajero sin clave',
      role_id: api.roles.cashier,
      access: { type: 'pin' },
    })
    expect(r.statusCode).toBe(400)
    expect(version()).toBe(v)
    expect(
      Number(
        api.db.prepare("SELECT count(*) AS n FROM users WHERE name = 'Cajero sin clave'").get()?.n,
      ),
    ).toBe(0)
  })

  it('reading staff returns no PINs, hashes or passwords', async () => {
    const { api, session, token } = await admin()
    const body = (await api.post('/api/staff/read', session, { token })).body
    expect(body).not.toMatch(/password_hash|scrypt|pin_hash/)
    for (const p of Object.values(api.people))
      expect(body).not.toContain(p.password ?? 'sin-contrasena')
  })
})

describe('roles with odd data', () => {
  it('unknown, repeated, too many, or Object-named permissions: 400 or cleaned up', async () => {
    const { api, role, version } = await admin()
    const v = version()
    for (const permissions of [
      ['delete_all'],
      ['__proto__'],
      ['constructor'],
      ['take_order', 'toString'],
      Array.from({ length: 101 }, () => 'take_order'),
      [1],
      'take_order',
    ])
      expect(
        (await role({ name: 'Raro', permissions })).statusCode,
        JSON.stringify(permissions).slice(0, 40),
      ).toBe(400)
    expect(version()).toBe(v)
    const duplicates = await role({
      name: 'Repetidos',
      permissions: ['take_order', 'take_order', 'comp'],
    })
    expect(duplicates.statusCode).toBe(200)
    expect(
      Number(
        api.db
          .prepare('SELECT count(*) AS n FROM role_permissions WHERE role_id = ?')
          .get(duplicates.json().id)?.n,
      ),
    ).toBe(2)
  })

  it('role names: empty, 61 long, repeated with different case or accent, and the default one is not renamed', async () => {
    const { api, role } = await admin()
    expect((await role({ name: ' ', permissions: [] })).statusCode).toBe(400)
    expect((await role({ name: 'r'.repeat(61), permissions: [] })).statusCode).toBe(400)
    expect((await role({ name: 'MESERO', permissions: [] })).json().message).toMatch(
      /Ya hay un rol/,
    )
    expect(
      (await role({ id: api.roles.waiter, name: 'Camarero', permissions: [] })).json().message,
    ).toMatch(/no se renombran/)
    expect(
      (await role({ id: api.roles.waiter, name: 'Mesero', permissions: [], active: false })).json()
        .message,
    ).toMatch(/no se archivan/)
    expect(
      (await role({ id: '0'.repeat(26), name: 'Fantasma', permissions: [] })).json().message,
    ).toMatch(/no existe/)
  })

  it('giving a role with PIN people a permission that requires a password is rejected and changes nothing', async () => {
    const { api, role, version } = await admin()
    const v = version()
    const r = await role({
      id: api.roles.waiter,
      name: 'Mesero',
      permissions: ['take_order', 'record_payment'],
    })
    expect(r.statusCode).toBe(400)
    expect(version()).toBe(v)
  })

  it('a role without permissions is valid (and its people cannot do anything)', async () => {
    const { api, role, person } = await admin()
    const id = (await role({ name: 'Observadores', permissions: [] })).json().id
    expect((await person({ name: 'Omar', role_id: id })).statusCode).toBe(200)
    expect(
      api.access.permissionsOf(
        (api.db.prepare("SELECT id FROM users WHERE name = 'Omar'").get() as { id: string }).id,
      ),
    ).toEqual([])
  })
})

describe("without permission, without a session or with someone else's credentials", () => {
  async function withRegisterAndReports() {
    const a = await admin()
    const { api, person } = a
    await person({
      name: 'Rita',
      role_id: api.roles.reports,
      access: { type: 'password', user: 'rita', password: 'clave-de-rita-1' },
    })
    const signIn = async (body: object, ip: string) => {
      const r = (await api.post('/api/sign-in', body, { ip })).json()
      return {
        token: r.device.token as string,
        session: { session_id: r.session_id as string, secret: r.secret as string },
      }
    }
    return {
      ...a,
      cashier: await signIn({ user: 'carlos', password: 'clave-de-carlos' }, '10.0.9.1'),
      reports: await signIn({ user: 'rita', password: 'clave-de-rita-1' }, '10.0.9.2'),
      waiter: await signIn({ pin: api.people.waiter.pin }, '10.0.9.3'),
    }
  }
  const ROUTES = ['/api/staff/read', '/api/staff/roles', '/api/staff/people'] as const

  it('cashier, reports and waiter: 403 on all three routes, with no effect', async () => {
    const t = await withRegisterAndReports()
    const before = JSON.stringify(t.api.db.prepare('SELECT * FROM users ORDER BY id').all())
    for (const who of [t.cashier, t.reports, t.waiter])
      for (const url of ROUTES) {
        const body =
          url === '/api/staff/read'
            ? who.session
            : url === '/api/staff/roles'
              ? { ...who.session, role: { name: 'Colado', permissions: [] } }
              : { ...who.session, person: { name: 'Colado', role_id: t.api.roles.waiter } }
        expect((await t.api.post(url, body, { token: who.token })).statusCode, url).toBe(403)
      }
    expect(JSON.stringify(t.api.db.prepare('SELECT * FROM users ORDER BY id').all())).toBe(before)
  })

  it('no token, made-up token, session from another device, wrong secret or closed session: 401', async () => {
    const t = await withRegisterAndReports()
    const { token, session } = t
    const body = (url: string, s: object) =>
      url === '/api/staff/read'
        ? s
        : url === '/api/staff/roles'
          ? { ...s, role: { name: 'Colado', permissions: [] } }
          : { ...s, person: { name: 'Colado', role_id: t.api.roles.waiter } }
    for (const url of ROUTES) {
      const attempts: [string, object, string | undefined][] = [
        ['no token', session, undefined],
        ['made up', session, 'inventado'],
        ['other device', session, t.waiter.token],
        ['secret', { ...session, secret: 'other' }, token],
        ['session', { ...session, session_id: '0'.repeat(26) }, token],
      ]
      for (const [what, s, tk] of attempts)
        expect(
          (await t.api.post(url, body(url, s), { token: tk })).statusCode,
          `${url} ${what}`,
        ).toBe(401)
    }
    expect(
      Number(t.api.db.prepare("SELECT count(*) AS n FROM users WHERE name = 'Colado'").get()?.n),
    ).toBe(0)
    await t.api.post('/api/sessions/close', session, { token })
    expect((await t.api.post('/api/staff/read', session, { token })).statusCode).toBe(401)
  })

  it('lowercase «Bearer», odd schemes and tokens with spaces do not get through', async () => {
    const t = await withRegisterAndReports()
    for (const authorization of [
      `bearer ${t.token}`,
      `Basic ${t.token}`,
      t.token,
      `Bearer  ${t.token}`,
      `Bearer ${t.waiter.token}x`,
    ]) {
      const r = await t.api.post('/api/staff/read', t.session, {
        headers: { authorization: authorization },
      })
      expect(r.statusCode, authorization.slice(0, 20)).toBe(401)
    }
  })

  it('a removed device no longer administers, even if it keeps its session', async () => {
    const t = await withRegisterAndReports()
    const removed = await t.api.post(
      '/api/sign-in',
      { user: 'rita', password: 'clave-de-rita-1' },
      { ip: '10.0.9.9' },
    )
    expect(removed.statusCode).toBe(201)
    const id = removed.json().device.device_id
    const revoke = await t.api.post(`/api/devices/${id}/revoke`, t.session, {
      token: t.token,
    })
    expect(revoke.statusCode).toBe(200)
    const r = await t.api.post(
      '/api/staff/read',
      { session_id: removed.json().session_id, secret: removed.json().secret },
      { token: removed.json().device.token },
    )
    expect([401, 403]).toContain(r.statusCode)
  })

  it('an archived person with an open session no longer administers', async () => {
    const t = await withRegisterAndReports()
    const boss = await t.person({
      name: 'Jefa',
      role_id: t.api.roles.admin,
      access: { type: 'password', user: 'jefa', password: 'clave-de-la-jefa' },
    })
    const e = (
      await t.api.post(
        '/api/sign-in',
        { user: 'jefa', password: 'clave-de-la-jefa' },
        { ip: '10.0.9.10' },
      )
    ).json()
    const theirs = { session_id: e.session_id, secret: e.secret }
    expect(
      (await t.api.post('/api/staff/read', theirs, { token: e.device.token })).statusCode,
    ).toBe(200)
    await t.person({
      id: boss.json().id,
      name: 'Jefa',
      role_id: t.api.roles.admin,
      active: false,
    })
    expect(
      (await t.api.post('/api/staff/read', theirs, { token: e.device.token })).statusCode,
    ).toBe(401)
  })

  it('malformed, empty, other content type or huge JSON: 4xx, never 5xx', async () => {
    const t = await withRegisterAndReports()
    const send = (payload: string, type = 'application/json') =>
      t.api.app.inject({
        method: 'POST',
        url: '/api/staff/people',
        payload,
        headers: { 'content-type': type, authorization: `Bearer ${t.token}` },
      })
    for (const [body, type] of [
      ['{', 'application/json'],
      ['', 'application/json'],
      ['nulo', 'text/plain'],
      ['x'.repeat(2_000_000), 'application/json'],
      ['[[[[[[[[[[[[[[[[[[[[', 'application/json'],
    ] as const) {
      const r = await send(body, type)
      expect(r.statusCode, `${body.slice(0, 10)} ${type}`).toBeGreaterThanOrEqual(400)
      expect(r.statusCode).toBeLessThan(500)
    }
    for (const httpMethod of ['GET', 'PUT', 'DELETE'] as const) {
      const r = await t.api.app.inject({ method: httpMethod, url: '/api/staff/read' })
      expect(r.statusCode).toBeGreaterThanOrEqual(400)
      expect(r.statusCode).toBeLessThan(500)
    }
  })

  it('staff API errors do not echo the session, token or secret that were sent', async () => {
    const t = await withRegisterAndReports()
    const r = await t.api.post(
      '/api/staff/roles',
      { ...t.session, role: { name: 5 } },
      { token: t.token },
    )
    for (const secret of [t.session.secret, t.token, t.session.session_id])
      expect(r.body).not.toContain(secret)
    const bad = await t.api.post(
      '/api/staff/read',
      { ...t.session, secret: 'secreto-que-no-es' },
      { token: t.token },
    )
    expect(bad.body).not.toContain('secreto-que-no-es')
  })

  it('a flood of bad requests does not bring the hub down: the good one afterwards gets an answer', async () => {
    const t = await withRegisterAndReports()
    await Promise.all(Array.from({ length: 200 }, (_, i) => t.person({ name: i, role_id: 7 })))
    expect((await t.api.post('/api/staff/read', t.session, { token: t.token })).statusCode).toBe(
      200,
    )
  })
})
