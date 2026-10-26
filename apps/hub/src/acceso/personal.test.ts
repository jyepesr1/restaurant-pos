import { describe, expect, it } from 'vitest'
import { crearServidor } from '../servidor'
import { montarAcceso } from './montaje'
import { ErrorPersonal, guardarPersona, guardarRol, leerPersonal } from './personal'
import { SISTEMA } from './registros'

// Personal y roles (tarea 1.3b): el administrador decide los permisos de cada rol.

const montar = () => {
  const m = montarAcceso()
  const role = (data: Parameters<typeof guardarRol>[3]) =>
    guardarRol(m.db, m.restauranteId, m.access, data, SISTEMA, m.clock())
  const persona = (data: Parameters<typeof guardarPersona>[3]) =>
    guardarPersona(m.db, m.restauranteId, m.access, data, SISTEMA, m.clock())
  const leer = () => leerPersonal(m.db, m.restauranteId, m.access)
  return { ...m, role, persona, leer }
}

describe('roles', () => {
  it('se crea un rol con los permisos que se quieran, y quitar uno lo archiva sin borrarlo', () => {
    const m = montar()
    const id = m.role({ name: 'Bartender', permissions: ['take_order', 'mark_product_sold_out'] })
    const ana = m.persona({ name: 'Bea', rolId: id })
    expect(m.access.permisosDe(ana.userId)).toEqual(['mark_product_sold_out', 'take_order'])

    m.role({ id, name: 'Bartender', permissions: ['take_order'] })
    expect(m.access.permisosDe(ana.userId)).toEqual(['take_order'])
    const rows = m.db
      .prepare('SELECT permission, active FROM role_permissions WHERE role_id = ?')
      .all(id)
    expect(rows).toContainEqual({ permission: 'mark_product_sold_out', active: 0 })

    // Volver a darlo reactiva la misma fila.
    m.role({ id, name: 'Bartender', permissions: ['take_order', 'mark_product_sold_out'] })
    expect(
      m.db.prepare('SELECT count(*) AS n FROM role_permissions WHERE role_id = ?').get(id)?.n,
    ).toBe(2)
    expect(m.leer().roles.find((r) => r.id === id)).toMatchObject({
      name: 'Bartender',
      system: false,
      people: 1,
      permissions: ['mark_product_sold_out', 'take_order'],
    })
  })

  it('a un rol de fábrica se le cambian los permisos, pero no el nombre ni se archiva', () => {
    const m = montar()
    m.role({ id: m.roles.cashier, name: 'Cajero', permissions: ['take_order', 'comp'] })
    expect(m.access.permisosDe(m.people.cashier.userId)).toEqual(['comp', 'take_order'])
    expect(() => m.role({ id: m.roles.cashier, name: 'Caja', permissions: [] })).toThrow(
      /no se renombran/,
    )
    expect(() =>
      m.role({ id: m.roles.waiter, name: 'Mesero', permissions: [], active: false }),
    ).toThrow(/no se archivan/)
  })

  it('no hay dos roles activos con el mismo nombre, sin importar mayúsculas ni tildes iguales', () => {
    const m = montar()
    expect(() => m.role({ name: 'mesero', permissions: [] })).toThrow(/Ya hay un rol/)
    expect(() => m.role({ name: '  ', permissions: [] })).toThrow(ErrorPersonal)
    expect(() => m.role({ name: 'X', permissions: ['delete_all'] })).toThrow(/desconocido/)
  })

  it('un rol con personas no se archiva; vacío, sí', () => {
    const m = montar()
    expect(() =>
      m.role({ id: m.roles.manager, name: 'Gerente', permissions: [], active: false }),
    ).toThrow(/tiene personas/)
    const empty = m.role({ name: 'Temporada', permissions: ['take_order'] })
    m.role({ id: empty, name: 'Temporada', permissions: [], active: false })
    expect(m.leer().roles.find((r) => r.id === empty)?.active).toBe(false)
    // Con el nombre libre, se puede crear otro igual.
    expect(() => m.role({ name: 'Temporada', permissions: [] })).not.toThrow()
  })

  it('no deja al restaurante sin nadie que pueda administrar el personal', () => {
    const m = montar()
    const all = m.leer().roles.find((r) => r.id === m.roles.admin)?.permissions ?? []
    expect(() =>
      m.role({
        id: m.roles.admin,
        name: 'Administrador',
        permissions: all.filter((p) => p !== 'manage_users'),
      }),
    ).toThrow(/Tiene que quedar al menos una persona/)
    // Nada cambió: la transacción se deshizo.
    expect(m.access.permisosDe(m.people.admin.userId)).toContain('manage_users')
  })
})

describe('quien entra con PIN no puede tener permisos de caja ni de administración', () => {
  it('ni al crearla, ni al darle ese permiso a su rol', () => {
    const m = montar()
    expect(() => m.persona({ name: 'Pía', rolId: m.roles.cashier })).toThrow(
      /Pía entra con PIN y su rol permite «/,
    )
    expect(() =>
      m.role({
        id: m.roles.waiter,
        name: 'Mesero',
        permissions: ['take_order', 'record_payment'],
      }),
    ).toThrow(/entra con PIN y su rol permite «Cobrar»/)
    // Nada cambió.
    expect(m.access.permisosDe(m.people.waiter.userId)).not.toContain('record_payment')
    // Los permisos de pedidos sí se pueden dar a quien entra con PIN.
    expect(() =>
      m.role({
        id: m.roles.waiter,
        name: 'Mesero',
        permissions: ['take_order', 'apply_discount', 'void_sent_item'],
      }),
    ).not.toThrow()
  })

  it('el PIN de alguien con permisos de caja no abre sesión, aunque no tenga contraseña (base vieja)', () => {
    const m = montar()
    // Como quedaría un Gerente de antes de ADR-013: rol que cobra, persona sin contraseña.
    const ana = m.people.waiter
    m.db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(m.roles.cashier, ana.userId)
    const { connection } = m.emparejar('waiter')
    expect(m.access.startSession(connection, ana.pin)).toMatchObject({
      ok: false,
      message: 'PIN incorrecto',
    })
    expect(m.access.entrar({ pin: ana.pin }, null, 'ip-9')).toMatchObject({ ok: false })
  })
})

describe('volver a activar a alguien', () => {
  it('si su PIN quedó en otra persona, recibe uno nuevo; si su usuario, hay que ponerle otro', () => {
    const m = montar()
    const ana = m.people.waiter
    const data = { id: ana.userId, name: 'Ana', rolId: m.roles.waiter }
    m.persona({ ...data, active: false })
    // Su PIN lo toma otra persona mientras está archivada.
    const fingerprint = String(
      m.db.prepare('SELECT pin_hash FROM user_credentials WHERE user_id = ?').get(ana.userId)
        ?.pin_hash,
    )
    m.db
      .prepare('UPDATE user_credentials SET pin_hash = ? WHERE user_id = ?')
      .run(fingerprint, m.people.waiter2.userId)
    const r = m.persona({ ...data, active: true })
    expect(r.pin).toMatch(/^\d{4}$/)
    expect(m.leer().people.find((p) => p.id === ana.userId)?.active).toBe(true)

    const carlos = m.people.cashier
    const deCarlos = { id: carlos.userId, name: 'Carlos', rolId: m.roles.cashier }
    m.persona({ ...deCarlos, active: false })
    m.persona({
      name: 'Otro Carlos',
      rolId: m.roles.cashier,
      access: { type: 'password', user: 'carlos', password: 'otra-clave-1' },
    })
    expect(() => m.persona({ ...deCarlos, active: true })).toThrow(/ya lo tiene otra persona/)
    expect(() =>
      m.persona({
        ...deCarlos,
        active: true,
        access: { type: 'password', user: 'carlos.b', password: 'nueva-clave-2' },
      }),
    ).not.toThrow()
  })
})

describe('personas', () => {
  it('un mesero nuevo entra con su PIN; alguien de caja, con usuario y contraseña', () => {
    const m = montar()
    const waiter = m.persona({ name: 'Pedro', rolId: m.roles.waiter })
    expect(waiter.pin).toMatch(/^\d{4}$/)
    expect(m.access.entrar({ pin: waiter.pin as string }, null, 'ip-1')).toMatchObject({ ok: true })

    const register = m.persona({
      name: 'Carla',
      rolId: m.roles.cashier,
      access: { type: 'password', user: 'Carla', password: 'caja-segura-1' },
    })
    expect(
      m.access.entrar({ user: 'carla', password: 'caja-segura-1' }, null, 'ip-2'),
    ).toMatchObject({
      ok: true,
      user: { name: 'Carla' },
    })
    // Su PIN no abre sesión: solo autoriza.
    expect(m.access.entrar({ pin: register.pin as string }, null, 'ip-3')).toMatchObject({
      ok: false,
    })
    expect(m.leer().people.find((p) => p.id === register.userId)?.user).toBe('carla')
  })

  it('el usuario es único en el restaurante y la contraseña tiene al menos 8 caracteres', () => {
    const m = montar()
    const withIt = (user: string, password?: string) => () =>
      m.persona({
        name: 'X',
        rolId: m.roles.cashier,
        access: { type: 'password', user, password },
      })
    expect(withIt(String(m.people.admin.user), 'larga-12345')).toThrow(/Ya hay alguien/)
    expect(withIt('nuevo', 'corta')).toThrow(/al menos 8/)
    expect(withIt('con espacio', 'larga-12345')).toThrow(/de 3 a 40/)
    expect(withIt('nuevo')).toThrow(/Escribe una contraseña/)
    // Ninguno de esos intentos dejó a alguien creado.
    expect(m.leer().people.filter((p) => p.name === 'X')).toEqual([])
  })

  it('pasar a alguien de PIN a contraseña y de vuelta; cambiar el rol cierra su sesión', () => {
    const m = montar()
    const { connection } = m.emparejar('waiter')
    const session = m.entrar(connection, 'waiter')
    const data = { id: m.people.waiter.userId, name: 'Ana' }

    // Con PIN no puede quedar en un rol que cobra (ADR-013)…
    expect(() => m.persona({ ...data, rolId: m.roles.cashier })).toThrow(
      /Ana entra con PIN y su rol permite/,
    )
    // …en uno que no cobra, sí; y cambiar el rol cierra su sesión.
    const bar = m.role({ name: 'Barra', permissions: ['take_order'] })
    m.persona({ ...data, rolId: bar })
    expect(m.access.cerrarSesion(connection, session)).toMatchObject({ code: 'invalid_session' })

    m.persona({
      ...data,
      rolId: m.roles.cashier,
      access: { type: 'password', user: 'ana', password: 'ana-clave-99' },
    })
    expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({ ok: false })
    // Mismo usuario sin contraseña nueva: no cambia nada.
    expect(() =>
      m.persona({
        ...data,
        rolId: m.roles.cashier,
        access: { type: 'password', user: 'ana' },
      }),
    ).not.toThrow()
    expect(() =>
      m.persona({
        ...data,
        rolId: m.roles.cashier,
        access: { type: 'password', user: 'ana2' },
      }),
    ).toThrow(/escribe también una contraseña/)

    m.persona({ ...data, rolId: m.roles.waiter, access: { type: 'pin' } })
    m.avanzar(61_000)
    expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({ ok: true })
  })

  it('regenerar el PIN da uno nuevo y el viejo deja de servir; archivar libera el usuario', () => {
    const m = montar()
    const { connection } = m.emparejar('waiter')
    const data = { id: m.people.waiter.userId, name: 'Ana', rolId: m.roles.waiter }
    const r = m.persona({ ...data, regenerarPin: true })
    expect(r.pin).toMatch(/^\d{4}$/)
    if (r.pin !== m.people.waiter.pin)
      expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({ ok: false })
    m.avanzar(61_000)
    expect(m.access.startSession(connection, r.pin as string)).toMatchObject({ ok: true })

    m.persona({ ...data, active: false })
    m.avanzar(61_000)
    expect(m.access.startSession(connection, r.pin as string)).toMatchObject({ ok: false })
    expect(m.leer().people.find((p) => p.id === data.id)?.active).toBe(false)
  })

  it('no se archiva a la última persona que administra el personal', () => {
    const m = montar()
    expect(() =>
      m.persona({
        id: m.people.admin.userId,
        name: 'Administrador',
        rolId: m.roles.admin,
        active: false,
      }),
    ).toThrow(/Tiene que quedar al menos una persona/)
    expect(
      () =>
        m.persona({
          id: m.people.admin.userId,
          name: 'Administrador',
          rolId: m.roles.admin,
          access: { type: 'pin' },
        }),
      // Antes de quedarse sin administrador, choca con que un administrador no entra con PIN.
    ).toThrow(/entra con PIN y su rol permite/)
    expect(m.access.tieneContrasena(m.people.admin.userId)).toBe(true)
  })
})

describe('equipos en la pantalla de personal', () => {
  it('cada equipo con su último uso y quién; el retirado al final', () => {
    const m = montar()
    const phone = m.access.entrar({ pin: m.people.waiter.pin }, null, 'ip-1')
    const register = m.access.entrar({ user: 'carlos', password: 'clave-de-carlos' }, null, 'ip-2')
    if (!phone.ok || !register.ok || !phone.device || !register.device) throw new Error('no entró')
    m.avanzar(60_000)
    const admin = m.access.entrar(
      {
        user: String(m.people.admin.user),
        password: String(m.people.admin.password),
      },
      null,
      'ip-3',
    )
    if (!admin.ok || !admin.device) throw new Error('no entró')
    const connection = m.access.authenticate(admin.device.token)
    if (!connection) throw new Error('sin conexión')
    m.access.revocarDispositivo(connection, { ...admin, dispositivoId: phone.device.dispositivoId })

    const devices = m.leer().devices
    expect(devices.map((e) => [e.name, e.type, e.ultimaPersona, e.revocadoEn !== null])).toEqual([
      ['Equipo de Administrador', 'register', 'Administrador', false],
      ['Equipo de Carlos', 'register', 'Carlos', false],
      ['Equipo de Ana', 'waiter', 'Ana', true],
    ])
  })
})

describe('API de personal', () => {
  function montarApi() {
    const m = montar()
    const changes: number[] = []
    const app = crearServidor({
      access: m.access,
      catalog: {
        db: m.db,
        restauranteId: m.restauranteId,
        access: m.access,
        clock: m.clock,
        onChange: (v) => changes.push(v),
      },
    })
    const post = (url: string, cuerpo: unknown, token?: string) =>
      app.inject({
        method: 'POST',
        url,
        payload: cuerpo as object,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    return { ...m, post, changes }
  }

  it('el administrador lee, crea un rol y una persona; los equipos traen la carta de nuevo', async () => {
    const api = montarApi()
    const register = (
      await api.post('/api/sign-in', {
        user: api.people.admin.user,
        password: api.people.admin.password,
      })
    ).json()
    const session = { session_id: register.session_id, secret: register.secret }
    const token = register.device.token

    const leido = await api.post('/api/staff/read', session, token)
    expect(leido.statusCode).toBe(200)
    expect(leido.json().roles.map((r: { name: string }) => r.name)).toContain('Reportes')

    const role = await api.post(
      '/api/staff/roles',
      { ...session, role: { name: 'Barra', permissions: ['take_order'] } },
      token,
    )
    expect(role.statusCode).toBe(200)
    const persona = await api.post(
      '/api/staff/people',
      { ...session, persona: { name: 'Bruno', role_id: role.json().id } },
      token,
    )
    expect(persona.statusCode).toBe(200)
    expect(persona.json().pin).toMatch(/^\d{4}$/)
    expect(api.changes).toHaveLength(2)

    const repetido = await api.post(
      '/api/staff/roles',
      { ...session, role: { name: 'barra', permissions: [] } },
      token,
    )
    expect(repetido.statusCode).toBe(400)
    expect(repetido.json().message).toMatch(/Ya hay un rol/)
  })

  it('sin el permiso responde 403; sin sesión, 401; con datos raros, 400', async () => {
    const api = montarApi()
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
