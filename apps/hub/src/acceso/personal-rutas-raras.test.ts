import { describe, expect, it } from 'vitest'
import { montarApi } from './montaje-api'

// La API de personal con datos raros y sin permiso (tarea 1.3b): siempre un 4xx claro, nunca un
// 500; lo rechazado no cambia la base, no avisa a los equipos y no repite secretos.

async function admin() {
  const api = montarApi()
  const { token, session } = await api.signInAdmin()
  const person = (p: unknown, extra: object = {}) =>
    api.post('/api/staff/people', { ...session, person: p, ...extra }, { token })
  const role = (r: unknown) => api.post('/api/staff/roles', { ...session, role: r }, { token })
  const version = () =>
    Number(api.db.prepare("SELECT value FROM counters WHERE name = 'catalog'").get()?.value)
  return { api, token, session, person, role, version }
}

const valida = (rolId: string) => ({ name: 'Bruno', role_id: rolId })

describe('personas con datos raros', () => {
  it('campos de más, de menos o de otro tipo: 400 y la base no cambia ni avisa', async () => {
    const { api, person, version } = await admin()
    const v = version()
    const raros: unknown[] = [
      null,
      42,
      'text',
      [],
      {},
      { name: 'X' },
      { role_id: api.roles.waiter },
      { ...valida(api.roles.waiter), extra: 1 },
      { ...valida(api.roles.waiter), name: 7 },
      { ...valida(api.roles.waiter), role_id: 7 },
      { ...valida(api.roles.waiter), role_id: 'corto' },
      { ...valida(api.roles.waiter), role_id: 'x'.repeat(27) },
      { ...valida(api.roles.waiter), id: 'no-es-ulid' },
      { ...valida(api.roles.waiter), active: 'yes' },
      { ...valida(api.roles.waiter), regenerar_pin: 1 },
      { ...valida(api.roles.waiter), access: 'pin' },
      { ...valida(api.roles.waiter), access: { type: 'other' } },
      { ...valida(api.roles.waiter), access: { type: 'pin', user: 'x' } },
      { ...valida(api.roles.waiter), access: { type: 'password' } },
      { ...valida(api.roles.waiter), access: { type: 'password', user: 5 } },
      {
        ...valida(api.roles.waiter),
        access: { type: 'password', user: 'u'.repeat(101), password: 'clave-larga-1' },
      },
      {
        ...valida(api.roles.waiter),
        access: { type: 'password', user: 'bruno', password: 'c'.repeat(201) },
      },
      { ...valida(api.roles.waiter), name: 'n'.repeat(101) },
    ]
    for (const p of raros) {
      const r = await person(p)
      expect(r.statusCode, JSON.stringify(p)).toBe(400)
    }
    expect(version()).toBe(v)
    expect(api.cambiosCatalogo).toEqual([])
  })

  it('nombres del servicio: vacío, solo espacios, 61 letras; y el mensaje es claro', async () => {
    const { api, person } = await admin()
    for (const name of ['', '   ', '\t\n', 'n'.repeat(61)]) {
      const r = await person({ name, role_id: api.roles.waiter })
      expect(r.statusCode, JSON.stringify(name)).toBe(400)
      expect(r.json().message).toMatch(/entre 1 y 60/)
    }
    expect((await person({ name: 'n'.repeat(60), role_id: api.roles.waiter })).statusCode).toBe(200)
  })

  it('nombres con Unicode, emoji, HTML o SQL se guardan como texto y vuelven iguales', async () => {
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
    const guardados = readResult.people.map((p: { name: string }) => p.name)
    for (const name of names) expect(guardados).toContain(name.trim())
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM users').get()?.n)).toBeGreaterThan(
      names.length,
    )
  })

  it('un nombre con un carácter nulo no rompe nada: se guarda o se rechaza, pero no hay 500', async () => {
    const { api, person } = await admin()
    const r = await person({ name: 'a\u0000b', role_id: api.roles.waiter })
    expect(r.statusCode).toBeLessThan(500)
  })

  it('rol que no existe, de otro tipo de id o archivado: 400 con mensaje', async () => {
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

  it('una contraseña nueva exigida y corta: mensajes claros; y nunca se repite en la respuesta', async () => {
    const { api, person } = await admin()
    const withoutKey = await person({
      name: 'Carla',
      role_id: api.roles.cashier,
      access: { type: 'password', user: 'carla' },
    })
    expect(withoutKey.statusCode).toBe(400)
    expect(withoutKey.json().message).toMatch(/contraseña/)
    const corta = await person({
      name: 'Carla',
      role_id: api.roles.cashier,
      access: { type: 'password', user: 'carla', password: 'corta' },
    })
    expect(corta.statusCode).toBe(400)
    expect(corta.body).not.toContain('"corta"')
    const ok = await person({
      name: 'Carla',
      role_id: api.roles.cashier,
      access: { type: 'password', user: 'carla', password: 'esta-es-la-clave-1' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.body).not.toContain('esta-es-la-clave-1')
    expect(ok.body).not.toMatch(/scrypt|huella/)
  })

  it('con PIN solo no se puede dar un rol que cobra o administra: error claro y nada guardado', async () => {
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

  it('leer personal no devuelve PIN, huellas ni contraseñas', async () => {
    const { api, session, token } = await admin()
    const cuerpo = (await api.post('/api/staff/read', session, { token })).body
    expect(cuerpo).not.toMatch(/huella|scrypt|pin_huella/)
    for (const p of Object.values(api.people))
      expect(cuerpo).not.toContain(p.password ?? 'sin-contrasena')
  })
})

describe('roles con datos raros', () => {
  it('permisos desconocidos, repetidos, demasiados o con nombres de Object: 400 o se limpian', async () => {
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
    const repetidos = await role({
      name: 'Repetidos',
      permissions: ['take_order', 'take_order', 'comp'],
    })
    expect(repetidos.statusCode).toBe(200)
    expect(
      Number(
        api.db
          .prepare('SELECT count(*) AS n FROM role_permissions WHERE role_id = ?')
          .get(repetidos.json().id)?.n,
      ),
    ).toBe(2)
  })

  it('nombres de rol: vacío, de 61, repetido con otra mayúscula o tilde distinta, y el de fábrica no se renombra', async () => {
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

  it('dar a un rol con gente por PIN un permiso que exige contraseña se rechaza y no cambia nada', async () => {
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

  it('un rol sin permisos es válido (y su gente no puede hacer nada)', async () => {
    const { api, role, person } = await admin()
    const id = (await role({ name: 'Observadores', permissions: [] })).json().id
    expect((await person({ name: 'Omar', role_id: id })).statusCode).toBe(200)
    expect(
      api.access.permisosDe(
        (api.db.prepare("SELECT id FROM users WHERE name = 'Omar'").get() as { id: string }).id,
      ),
    ).toEqual([])
  })
})

describe('sin permiso, sin sesión o con credenciales ajenas', () => {
  async function conCajaYReportes() {
    const a = await admin()
    const { api, person } = a
    await person({
      name: 'Rita',
      role_id: api.roles.reports,
      access: { type: 'password', user: 'rita', password: 'clave-de-rita-1' },
    })
    const entrar = async (cuerpo: object, ip: string) => {
      const r = (await api.post('/api/sign-in', cuerpo, { ip })).json()
      return {
        token: r.device.token as string,
        session: { session_id: r.session_id as string, secret: r.secret as string },
      }
    }
    return {
      ...a,
      cashier: await entrar({ user: 'carlos', password: 'clave-de-carlos' }, '10.0.9.1'),
      reports: await entrar({ user: 'rita', password: 'clave-de-rita-1' }, '10.0.9.2'),
      waiter: await entrar({ pin: api.people.waiter.pin }, '10.0.9.3'),
    }
  }
  const RUTAS = ['/api/staff/read', '/api/staff/roles', '/api/staff/people'] as const

  it('cajero, reportes y mesero: 403 en las tres rutas, sin efecto', async () => {
    const t = await conCajaYReportes()
    const before = JSON.stringify(t.api.db.prepare('SELECT * FROM users ORDER BY id').all())
    for (const quien of [t.cashier, t.reports, t.waiter])
      for (const url of RUTAS) {
        const cuerpo =
          url === '/api/staff/read'
            ? quien.session
            : url === '/api/staff/roles'
              ? { ...quien.session, role: { name: 'Colado', permissions: [] } }
              : { ...quien.session, person: { name: 'Colado', role_id: t.api.roles.waiter } }
        expect((await t.api.post(url, cuerpo, { token: quien.token })).statusCode, url).toBe(403)
      }
    expect(JSON.stringify(t.api.db.prepare('SELECT * FROM users ORDER BY id').all())).toBe(before)
  })

  it('sin token, token inventado, sesión de otro equipo, secreto errado o sesión cerrada: 401', async () => {
    const t = await conCajaYReportes()
    const { token, session } = t
    const cuerpo = (url: string, s: object) =>
      url === '/api/staff/read'
        ? s
        : url === '/api/staff/roles'
          ? { ...s, role: { name: 'Colado', permissions: [] } }
          : { ...s, person: { name: 'Colado', role_id: t.api.roles.waiter } }
    for (const url of RUTAS) {
      const attempts: [string, object, string | undefined][] = [
        ['sin token', session, undefined],
        ['inventado', session, 'inventado'],
        ['otro equipo', session, t.waiter.token],
        ['secret', { ...session, secret: 'other' }, token],
        ['sesión', { ...session, session_id: '0'.repeat(26) }, token],
      ]
      for (const [que, s, tk] of attempts)
        expect(
          (await t.api.post(url, cuerpo(url, s), { token: tk })).statusCode,
          `${url} ${que}`,
        ).toBe(401)
    }
    expect(
      Number(t.api.db.prepare("SELECT count(*) AS n FROM users WHERE name = 'Colado'").get()?.n),
    ).toBe(0)
    await t.api.post('/api/sessions/close', session, { token })
    expect((await t.api.post('/api/staff/read', session, { token })).statusCode).toBe(401)
  })

  it('«Bearer» en minúsculas, esquemas raros y tokens con espacios no pasan', async () => {
    const t = await conCajaYReportes()
    for (const authorization of [
      `bearer ${t.token}`,
      `Basic ${t.token}`,
      t.token,
      `Bearer  ${t.token}`,
      `Bearer ${t.waiter.token}x`,
    ]) {
      const r = await t.api.post('/api/staff/read', t.session, {
        cabeceras: { authorization: authorization },
      })
      expect(r.statusCode, authorization.slice(0, 20)).toBe(401)
    }
  })

  it('un equipo retirado ya no administra, aunque conserve su sesión', async () => {
    const t = await conCajaYReportes()
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

  it('una persona archivada con la sesión abierta ya no administra', async () => {
    const t = await conCajaYReportes()
    const jefa = await t.person({
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
    const suya = { session_id: e.session_id, secret: e.secret }
    expect((await t.api.post('/api/staff/read', suya, { token: e.device.token })).statusCode).toBe(
      200,
    )
    await t.person({
      id: jefa.json().id,
      name: 'Jefa',
      role_id: t.api.roles.admin,
      active: false,
    })
    expect((await t.api.post('/api/staff/read', suya, { token: e.device.token })).statusCode).toBe(
      401,
    )
  })

  it('JSON mal formado, vacío, con otro tipo de contenido o enorme: 4xx, nunca 5xx', async () => {
    const t = await conCajaYReportes()
    const send = (payload: string, type = 'application/json') =>
      t.api.app.inject({
        method: 'POST',
        url: '/api/staff/people',
        payload,
        headers: { 'content-type': type, authorization: `Bearer ${t.token}` },
      })
    for (const [cuerpo, type] of [
      ['{', 'application/json'],
      ['', 'application/json'],
      ['nulo', 'text/plain'],
      ['x'.repeat(2_000_000), 'application/json'],
      ['[[[[[[[[[[[[[[[[[[[[', 'application/json'],
    ] as const) {
      const r = await send(cuerpo, type)
      expect(r.statusCode, `${cuerpo.slice(0, 10)} ${type}`).toBeGreaterThanOrEqual(400)
      expect(r.statusCode).toBeLessThan(500)
    }
    for (const metodo of ['GET', 'PUT', 'DELETE'] as const) {
      const r = await t.api.app.inject({ method: metodo, url: '/api/staff/read' })
      expect(r.statusCode).toBeGreaterThanOrEqual(400)
      expect(r.statusCode).toBeLessThan(500)
    }
  })

  it('los errores de la API de personal no repiten la sesión, el token ni el secreto enviados', async () => {
    const t = await conCajaYReportes()
    const r = await t.api.post(
      '/api/staff/roles',
      { ...t.session, role: { name: 5 } },
      { token: t.token },
    )
    for (const secret of [t.session.secret, t.token, t.session.session_id])
      expect(r.body).not.toContain(secret)
    const mala = await t.api.post(
      '/api/staff/read',
      { ...t.session, secret: 'secreto-que-no-es' },
      { token: t.token },
    )
    expect(mala.body).not.toContain('secreto-que-no-es')
  })

  it('un aluvión de peticiones malas no tumba al hub: la buena después responde', async () => {
    const t = await conCajaYReportes()
    await Promise.all(Array.from({ length: 200 }, (_, i) => t.person({ name: i, role_id: 7 })))
    expect((await t.api.post('/api/staff/read', t.session, { token: t.token })).statusCode).toBe(
      200,
    )
  })
})
