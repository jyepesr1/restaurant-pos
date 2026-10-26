import { describe, expect, it } from 'vitest'
import { montarApi } from './montaje-api'
import { ABRIR, add, montarHub } from './montaje-hub'
import { administradores, guardarPersona, guardarRol } from './personal'
import { SISTEMA } from './registros'
import { huellaPin } from './secretos'

// Carreras y fallos a mitad en personal, roles y equipos autorregistrados (tarea 1.3b). El hub es
// un solo proceso con SQLite síncrono: «a la vez» son dos solicitudes en vuelo (`Promise.all`) que
// el hub atiende una tras otra; lo que se prueba es que el resultado sea coherente en cualquier
// orden y que lo que falla a mitad no deje nada.

const contar = (m: { db: ReturnType<typeof montarHub>['db'] }, sql: string, ...p: string[]) =>
  Number(m.db.prepare(sql).get(...p)?.n)

/** Foto de lo que un cambio fallido no debe tocar. */
function photo(m: ReturnType<typeof montarHub>) {
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

async function conDosAdmins() {
  const m = montarHub()
  const api = montarApi(m)
  const jefes = guardarRol(
    m.db,
    m.restauranteId,
    m.access,
    {
      name: 'Jefes',
      permissions: ['manage_users', 'manage_devices', 'take_order'],
    },
    SISTEMA,
    m.clock(),
  )
  const jefa = m.access.crearUsuario({
    name: 'Jefa',
    rolId: jefes,
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
  const persona = (quien: { token: string; session: object }, p: object) =>
    api.post('/api/staff/people', { ...quien.session, persona: p }, { token: quien.token })
  const role = (quien: { token: string; session: object }, p: object) =>
    api.post('/api/staff/roles', { ...quien.session, role: p }, { token: quien.token })
  return { m, api, x, y, jefa, jefes, persona, role }
}

describe('dos solicitudes a la vez', () => {
  it('dos equipos crean a la persona con el mismo usuario: una entra y la otra recibe «ya hay alguien»', async () => {
    const { m, x, y, persona } = await conDosAdmins()
    const before = contar(m, 'SELECT count(*) AS n FROM users')
    const newOne = (n: string) => ({
      name: `Carla ${n}`,
      role_id: m.roles.cashier,
      access: { type: 'password', user: 'carla', password: `clave-de-carla-${n}` },
    })
    const [a, b] = await Promise.all([persona(x, newOne('uno')), persona(y, newOne('dos'))])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400])
    const mala = a.statusCode === 400 ? a : b
    expect(mala.json().message).toMatch(/Ya hay alguien con el usuario «carla»/)
    expect(contar(m, 'SELECT count(*) AS n FROM users')).toBe(before + 1)
    expect(contar(m, "SELECT count(*) AS n FROM user_credentials WHERE username = 'carla'")).toBe(1)
    // Y sin huérfanos: cada usuario activo tiene su credencial.
    expect(
      contar(
        m,
        'SELECT count(*) AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = u.id)',
      ),
    ).toBe(0)
  })

  it('crear a «la misma persona» dos veces (doble envío) deja dos personas distintas con PIN distintos: no hay idempotencia', async () => {
    const { m, x, y, persona } = await conDosAdmins()
    const data = { name: 'Bruno', role_id: m.roles.waiter }
    const [a, b] = await Promise.all([persona(x, data), persona(y, data)])
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])
    expect(a.json().id).not.toBe(b.json().id)
    expect(a.json().pin).not.toBe(b.json().pin)
    expect(contar(m, "SELECT count(*) AS n FROM users WHERE name = 'Bruno'")).toBe(2)
  })

  it('40 meseros creados a la vez desde dos equipos: todos con PIN de 4 dígitos, distintos y que entran', async () => {
    const { m, api, x, y, persona } = await conDosAdmins()
    const batch = Array.from({ length: 40 }, (_, i) =>
      persona(i % 2 ? x : y, { name: `Mesero ${i}`, role_id: m.roles.waiter }),
    )
    const res = await Promise.all(batch)
    const pins = res.map((r) => r.json().pin as string)
    expect(res.every((r) => r.statusCode === 200)).toBe(true)
    expect(new Set(pins).size).toBe(40)
    for (const pin of pins) expect(pin).toMatch(/^\d{4}$/)
    // Cada PIN entra a su persona (IP distinta: no esperan).
    for (const [i, pin] of pins.slice(0, 6).entries()) {
      const r = await api.post('/api/sign-in', { pin }, { ip: `10.20.0.${i + 1}` })
      expect(r.statusCode).toBe(201)
    }
  })

  it('cada uno le quita a la rol del otro el permiso de administrar, a la vez: uno se acepta, el otro pierde su permiso, y queda uno', async () => {
    const { m, x, y, jefes, role } = await conDosAdmins()
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
      role(x, { id: jefes, name: 'Jefes', permissions: without(jefes) }),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 403])
    expect(administradores(m.db, m.restauranteId)).toHaveLength(1)
  })

  it('el administrador y la jefa se archivan el uno al otro a la vez: queda exactamente uno activo', async () => {
    const { m, x, y, jefa, persona } = await conDosAdmins()
    const [a, b] = await Promise.all([
      persona(x, {
        id: jefa.userId,
        name: 'Jefa',
        role_id: m.db.prepare('SELECT role_id FROM users WHERE id = ?').get(jefa.userId)
          ?.role_id as string,
        active: false,
      }),
      persona(y, {
        id: m.people.admin.userId,
        name: 'Administrador',
        role_id: m.roles.admin,
        active: false,
      }),
    ])
    const statuses = [a.statusCode, b.statusCode].sort()
    // El primero archiva al otro (200); el segundo ya no tiene sesión (401), o le queda ella sola.
    expect(statuses[0]).toBe(200)
    expect([400, 401, 403]).toContain(statuses[1])
    expect(administradores(m.db, m.restauranteId)).toHaveLength(1)
  })

  it('cada camino por separado para dejar a nadie administrando se rechaza y no deja nada a medias', async () => {
    const m = montarHub()
    const api = montarApi(m)
    const { token, session } = await api.signInAdmin()
    const adminId = m.people.admin.userId
    const persona = (p: object) =>
      api.post('/api/staff/people', { ...session, persona: p }, { token })
    const role = (p: object) => api.post('/api/staff/roles', { ...session, role: p }, { token })
    const before = photo(m)
    const caminos = {
      archivarla: () =>
        persona({ id: adminId, name: 'Administrador', role_id: m.roles.admin, active: false }),
      pasarla_a_mesero: () =>
        persona({ id: adminId, name: 'Administrador', role_id: m.roles.waiter }),
      quitarle_la_contrasena: () =>
        persona({
          id: adminId,
          name: 'Administrador',
          role_id: m.roles.admin,
          access: { type: 'pin' },
        }),
      quitarle_el_permiso_al_rol: () =>
        role({ id: m.roles.admin, name: 'Administrador', permissions: ['take_order'] }),
    }
    for (const [camino, hacer] of Object.entries(caminos)) {
      const r = await hacer()
      expect(r.statusCode, camino).toBe(400)
      expect(photo(m), camino).toBe(before)
    }
    // Y sigue pudiendo administrar.
    expect((await api.post('/api/staff/read', session, { token })).statusCode).toBe(200)
  })
})

describe('fallos a mitad de una operación (transacciones anidadas)', () => {
  it('crear a alguien con usuario inválido falla después de insertarlo: no queda persona, credencial ni versión gastada', () => {
    const m = montarHub()
    const before = photo(m)
    expect(() =>
      m.access.crearUsuario({
        name: 'Rosa',
        rolId: m.roles.cashier,
        user: 'x',
        password: 'clave-correcta-1',
      }),
    ).toThrow()
    expect(() =>
      m.access.crearUsuario({
        name: 'Rosa',
        rolId: m.roles.cashier,
        user: 'rosa',
        password: 'corta',
      }),
    ).toThrow()
    expect(photo(m)).toBe(before)
  })

  it('cambiar rol y usuario de alguien falla en el usuario (tomado): el rol tampoco cambia ni se cierran sus sesiones', async () => {
    const m = montarHub()
    const api = montarApi(m)
    const { token, session } = await api.signInAdmin()
    const enCaja = m.access.entrar(
      { user: 'carlos', password: 'clave-de-carlos' },
      null,
      '10.0.0.5',
    )
    expect(enCaja).toMatchObject({ ok: true })
    const before = photo(m)
    const r = await api.post(
      '/api/staff/people',
      {
        ...session,
        persona: {
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

  it('un rol cuyo cambio de permisos deja al restaurante sin administrador no archiva ni reactiva permisos a medias', () => {
    const m = montarHub()
    const before = photo(m)
    expect(() =>
      guardarRol(
        m.db,
        m.restauranteId,
        m.access,
        { id: m.roles.admin, name: 'Administrador', permissions: ['take_order', 'comp'] },
        SISTEMA,
        m.clock(),
      ),
    ).toThrow()
    expect(photo(m)).toBe(before)
  })

  it('entrar sin token y fallar al abrir la sesión: el navegador no queda registrado como equipo', () => {
    const m = montarHub()
    m.db.exec(
      "CREATE TRIGGER sesion_falla BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'disco lleno'); END",
    )
    const before = photo(m)
    expect(() => m.access.entrar({ pin: m.people.waiter.pin }, null, '10.0.0.6')).toThrow(
      /disco lleno/,
    )
    expect(photo(m)).toBe(before)
    expect(contar(m, 'SELECT count(*) AS n FROM device_credentials')).toBe(0)
    m.db.exec('DROP TRIGGER sesion_falla')
    // Ya sin la falla, entra normal: la base quedó utilizable.
    expect(m.access.entrar({ pin: m.people.waiter.pin }, null, '10.0.0.7')).toMatchObject({
      ok: true,
    })
  })

  it('subir un equipo de mesero a caja y fallar al abrir la sesión: el equipo sigue siendo de mesero', () => {
    const m = montarHub()
    const phone = m.access.entrar({ pin: m.people.waiter.pin }, null, '10.0.0.8')
    if (!phone.ok || !phone.device) throw new Error('no entró')
    const connection = m.access.authenticate(phone.device.token)
    if (!connection) throw new Error('sin conexión')
    m.db.exec(
      "CREATE TRIGGER sesion_falla BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'falla'); END",
    )
    const before = photo(m)
    expect(() =>
      m.access.entrar({ user: 'carlos', password: 'clave-de-carlos' }, connection, '10.0.0.9'),
    ).toThrow(/falla/)
    expect(photo(m)).toBe(before)
    expect(
      m.db.prepare('SELECT type FROM devices WHERE id = ?').get(connection.dispositivoId),
    ).toEqual({ type: 'waiter' })
  })

  // Lo encontró qa-pruebas en la 1.3b y ya está corregido: sin un manejador de errores propio, Fastify devuelve en un 500 el mensaje de la excepción:
  // aquí llegan textos de SQLite («UNIQUE constraint failed: user_credentials…», nombres de tablas
  // y columnas) a cualquier navegador de la red. Esperaba un mensaje genérico, sin detalles.
  it('un 500 no muestra el mensaje interno de la excepción', async () => {
    const m = montarHub()
    const api = montarApi(m)
    m.db.exec(
      "CREATE TRIGGER sesion_falla BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'secreto-interno'); END",
    )
    const r = await api.post('/api/sign-in', { pin: m.people.waiter.pin })
    expect(r.statusCode).toBe(500)
    expect(r.body).not.toContain('secreto-interno')
  })

  it('tras un 500 por dentro, el hub sigue sirviendo y no quedó nada a medias', async () => {
    const m = montarHub()
    const api = montarApi(m)
    m.db.exec(
      "CREATE TRIGGER sesion_falla BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'falla'); END",
    )
    const before = photo(m)
    expect((await api.post('/api/sign-in', { pin: m.people.waiter.pin })).statusCode).toBe(500)
    expect(photo(m)).toBe(before)
    m.db.exec('DROP TRIGGER sesion_falla')
    expect(
      (await api.post('/api/sign-in', { pin: m.people.waiter.pin }, { ip: '10.0.0.30' }))
        .statusCode,
    ).toBe(201)
  })
})

describe('equipo autorregistrado y revocación', () => {
  function phone() {
    const m = montarHub()
    const e = m.access.entrar({ pin: m.people.waiter.pin }, null, '10.0.5.1')
    if (!e.ok || !e.device) throw new Error('no entró')
    const connection = m.access.authenticate(e.device.token)
    if (!connection) throw new Error('sin conexión')
    const register = m.access.entrar(
      {
        user: m.people.admin.user as string,
        password: m.people.admin.password as string,
      },
      null,
      '10.0.5.2',
    )
    if (!register.ok || !register.device) throw new Error('no entró la caja')
    const conexionCaja = m.access.authenticate(register.device.token)
    if (!conexionCaja) throw new Error('sin conexión')
    const open = (time: string) =>
      m.event(connection, e, 'OrderOpened', ABRIR, {
        device_time: time,
        hub_estimated_time: time,
      })
    const revoke = () => {
      const r = m.access.revocarDispositivo(conexionCaja, {
        sesionId: register.sesionId,
        secret: register.secret,
        dispositivoId: connection.dispositivoId,
      })
      if (!r.ok) throw new Error(r.message)
      return r.revocadoEn
    }
    return { m, e, connection, register, conexionCaja, open, revoke }
  }

  it('revocarlo corta su token en todas las rutas de entrada y su sesión; avisa a la sala', () => {
    const c = phone()
    c.revoke()
    expect(c.m.revocados).toContain(c.connection.dispositivoId)
    const revocada = c.m.access.authenticate(c.e.device?.token as string)
    expect(revocada?.revocadoEn).not.toBeNull()
    expect(c.m.access.entrar({ pin: c.m.people.waiter2.pin }, revocada, '10.0.5.3')).toMatchObject({
      ok: false,
      code: 'revoked_device',
    })
    expect(c.m.access.startSession(revocada as never, c.m.people.waiter2.pin)).toMatchObject({
      ok: false,
      code: 'revoked_device',
    })
    expect(c.m.access.cerrarSesion(revocada as never, c.e)).toMatchObject({ ok: false })
  })

  it('lo que el celular creó antes de la revocación va a cuarentena; lo posterior, rechazado', () => {
    const c = phone()
    const before = c.open(c.m.clock())
    c.m.avanzar(5000)
    const revocadoEn = c.revoke()
    const after = c.open(add(revocadoEn, 1000))
    // La conexión que arma la sala al llegar el lote ya trae la revocación.
    const connection = c.m.access.authenticate(c.e.device?.token as string) as never
    const r = c.m.hub.recibirLote(connection, [before, after])
    expect(r.resultados.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
  })

  it('no se puede retirar el equipo desde el que se está entrando, ni uno ya retirado dos veces con fechas distintas', () => {
    const c = phone()
    expect(
      c.m.access.revocarDispositivo(c.conexionCaja, {
        sesionId: c.register.sesionId,
        secret: c.register.secret,
        dispositivoId: c.conexionCaja.dispositivoId,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_data' })
    const first = c.revoke()
    c.m.avanzar(60_000)
    expect(c.revoke()).toBe(first)
  })

  it('un mesero no puede retirar equipos: su sesión no tiene administrar_dispositivos', () => {
    const c = phone()
    const other = c.m.access.entrar({ pin: c.m.people.waiter2.pin }, null, '10.0.5.4')
    if (!other.ok || !other.device) throw new Error('no entró')
    const connection = c.m.access.authenticate(other.device.token) as never
    expect(
      c.m.access.revocarDispositivo(connection, {
        sesionId: other.sesionId,
        secret: other.secret,
        dispositivoId: c.connection.dispositivoId,
      }),
    ).toMatchObject({ ok: false, code: 'no_permission' })
  })

  it('el aparato retirado puede volver a registrarse si borra su token (la revocación es del token, no del aparato): riesgo aceptado', () => {
    const c = phone()
    c.revoke()
    const de_nuevo = c.m.access.entrar({ pin: c.m.people.waiter.pin }, null, '10.0.5.1')
    expect(de_nuevo).toMatchObject({ ok: true })
    if (de_nuevo.ok) expect(de_nuevo.device?.dispositivoId).not.toBe(c.connection.dispositivoId)
  })
})

describe('sesión abierta mientras cambian los permisos de su rol', () => {
  it('quitarle administrar_usuarios al rol de una sesión abierta corta la API de personal al instante', async () => {
    const { m, api, y, jefes, persona } = await conDosAdmins()
    expect((await api.post('/api/staff/read', y.session, { token: y.token })).statusCode).toBe(200)
    guardarRol(
      m.db,
      m.restauranteId,
      m.access,
      { id: jefes, name: 'Jefes', permissions: ['take_order'] },
      SISTEMA,
      m.clock(),
    )
    for (const url of ['/api/staff/read'])
      expect((await api.post(url, y.session, { token: y.token })).statusCode).toBe(403)
    expect((await persona(y, { name: 'Intruso', role_id: m.roles.waiter })).statusCode).toBe(403)
  })

  it('al mesero le quitan «tomar_pedido» con la sesión abierta: lo anterior va a cuarentena, lo posterior se rechaza', () => {
    const m = montarHub()
    const e = m.access.entrar({ pin: m.people.waiter.pin }, null, '10.0.6.1')
    if (!e.ok || !e.device) throw new Error('no entró')
    // El login trajo los permisos de ese momento; el hub juzga con los de ahora.
    expect(e.permissions).toContain('take_order')
    const connection = m.access.authenticate(e.device.token) as never
    const before = m.event(connection, e, 'OrderOpened', ABRIR)
    m.avanzar(10 * 60_000)
    guardarRol(
      m.db,
      m.restauranteId,
      m.access,
      { id: m.roles.waiter, name: 'Mesero', permissions: ['view_own_reports'] },
      SISTEMA,
      m.clock(),
    )
    const change = m.clock()
    m.avanzar(1000)
    const after = m.event(connection, e, 'OrderOpened', ABRIR, {
      device_time: add(change, 500),
      hub_estimated_time: add(change, 500),
    })
    const r = m.hub.recibirLote(connection, [before, after])
    expect(r.resultados.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
    expect(r.resultados[1]).toMatchObject({ reason: 'no_permission' })
  })

  it('al darle un permiso nuevo al rol, la sesión abierta lo usa sin volver a entrar', () => {
    const m = montarHub()
    const e = m.access.entrar({ pin: m.people.waiter.pin }, null, '10.0.6.2')
    if (!e.ok || !e.device) throw new Error('no entró')
    const connection = m.access.authenticate(e.device.token) as never
    expect(e.permissions).not.toContain('mark_product_sold_out')
    const before = m.access.usuarioConPermiso(connection, e, 'mark_product_sold_out')
    expect(before).toMatchObject({ ok: false, code: 'no_permission' })
    guardarRol(
      m.db,
      m.restauranteId,
      m.access,
      {
        id: m.roles.waiter,
        name: 'Mesero',
        permissions: [...e.permissions, 'mark_product_sold_out'],
      },
      SISTEMA,
      m.clock(),
    )
    expect(m.access.usuarioConPermiso(connection, e, 'mark_product_sold_out')).toMatchObject({
      ok: true,
    })
  })
})

describe('un mesero que pasa a tener contraseña con su sesión abierta', () => {
  it('su sesión se cierra, su PIN ya no entra pero sí autoriza, y entra con su contraseña', async () => {
    const { m, api, x } = await conDosAdmins()
    // Ana (PIN) con una sesión abierta en su celular y un evento hecho sin conexión.
    const e = m.access.entrar({ pin: m.people.waiter.pin }, null, '10.0.7.1')
    if (!e.ok || !e.device) throw new Error('no entró')
    const connection = m.access.authenticate(e.device.token) as never
    const hechoAntes = m.event(connection, e, 'OrderOpened', ABRIR)
    m.avanzar(60_000)
    const r = await api.post(
      '/api/staff/people',
      {
        ...x.session,
        persona: {
          id: m.people.waiter.userId,
          name: 'Ana',
          role_id: m.roles.cashier,
          access: { type: 'password', user: 'ana', password: 'clave-de-ana-1' },
        },
      },
      { token: x.token },
    )
    expect(r.statusCode).toBe(200)
    // Sesión cerrada: el celular debe volver a entrar.
    expect(m.access.cerrarSesion(connection, e)).toMatchObject({
      ok: false,
      code: 'invalid_session',
    })
    // Con el PIN ya no entra (ni sin token, ni con el token de su celular).
    expect(m.access.entrar({ pin: m.people.waiter.pin }, connection, '10.0.7.2')).toMatchObject({
      ok: false,
      code: 'wrong_pin',
    })
    // Con la contraseña sí, y el celular pasa a ser de caja (su rol cobra).
    const luego = m.access.entrar(
      { user: 'ANA', password: 'clave-de-ana-1' },
      connection,
      '10.0.7.3',
    )
    expect(luego).toMatchObject({ ok: true, type: 'register', user: { name: 'Ana' } })
    // Lo que hizo antes de cambiar, con la sesión de entonces, el hub lo aprueba.
    expect(m.hub.recibirLote(connection, [hechoAntes]).resultados[0]?.status).toBe('confirmed')
  })

  it('un evento firmado con la sesión cerrada, creado después del cambio, se rechaza', async () => {
    const { m, api, x } = await conDosAdmins()
    const e = m.access.entrar({ pin: m.people.waiter.pin }, null, '10.0.7.4')
    if (!e.ok || !e.device) throw new Error('no entró')
    const connection = m.access.authenticate(e.device.token) as never
    await api.post(
      '/api/staff/people',
      {
        ...x.session,
        persona: {
          id: m.people.waiter.userId,
          name: 'Ana',
          role_id: m.roles.waiter,
          access: { type: 'password', user: 'ana', password: 'clave-de-ana-1' },
        },
      },
      { token: x.token },
    )
    m.avanzar(5 * 60_000)
    const after = m.event(connection, e, 'OrderOpened', ABRIR)
    expect(m.hub.recibirLote(connection, [after]).resultados[0]).toMatchObject({
      status: 'rejected',
      reason: 'session_closed',
    })
  })

  it('el PIN de autorización de quien tiene contraseña sigue autorizando en el celular del mesero', () => {
    const m = montarHub()
    const e = m.access.entrar({ pin: m.people.waiter.pin }, null, '10.0.7.5')
    if (!e.ok || !e.device) throw new Error('no entró')
    const connection = m.access.authenticate(e.device.token) as never
    const r = m.access.autorizar(connection, {
      sesionId: e.sesionId,
      secret: e.secret,
      pin: m.people.cashier.pin,
      action: 'void_sent_item',
      agregadoId: '0'.repeat(26),
      eventId: '1'.repeat(26),
      fingerprint: 'a'.repeat(64),
    })
    expect(r).toMatchObject({ ok: true, supervisor: { name: 'Carlos' } })
  })
})

describe('reactivar a quien se archivó', () => {
  it('si su usuario lo tomó otra persona: error claro (400) y no queda activa a medias', async () => {
    const { m, api, x, persona } = await conDosAdmins()
    const carla = (
      await persona(x, {
        name: 'Carla',
        role_id: m.roles.cashier,
        access: { type: 'password', user: 'carla', password: 'clave-de-carla-1' },
      })
    ).json()
    await persona(x, { id: carla.id, name: 'Carla', role_id: m.roles.cashier, active: false })
    await persona(x, {
      name: 'Carla II',
      role_id: m.roles.cashier,
      access: { type: 'password', user: 'carla', password: 'clave-de-carla-2' },
    })
    const before = photo(m)
    const r = await persona(x, {
      id: carla.id,
      name: 'Carla',
      role_id: m.roles.cashier,
      active: true,
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toMatch(/ya lo tiene otra persona/)
    expect(photo(m)).toBe(before)
    // Dándole otro usuario con contraseña, sí.
    const fine = await persona(x, {
      id: carla.id,
      name: 'Carla',
      role_id: m.roles.cashier,
      active: true,
      access: { type: 'password', user: 'carla.vieja', password: 'clave-de-carla-3' },
    })
    expect(fine.statusCode).toBe(200)
    void api
  })

  it('si su PIN lo tomó otra persona mientras estaba archivada, al activarla recibe un PIN nuevo', async () => {
    const { m, x, persona } = await conDosAdmins()
    const bea = (await persona(x, { name: 'Bea', role_id: m.roles.waiter })).json()
    await persona(x, { id: bea.id, name: 'Bea', role_id: m.roles.waiter, active: false })
    // Otra persona recibe, por azar, el mismo PIN (se fuerza en la base).
    const cora = (await persona(x, { name: 'Cora', role_id: m.roles.waiter })).json()
    m.db
      .prepare('UPDATE user_credentials SET pin_hash = ? WHERE user_id = ?')
      .run(huellaPin(Buffer.alloc(32, 7), m.restauranteId, bea.pin), cora.id)
    const r = await persona(x, { id: bea.id, name: 'Bea', role_id: m.roles.waiter, active: true })
    expect(r.statusCode).toBe(200)
    expect(r.json().pin).toMatch(/^\d{4}$/)
    expect(r.json().pin).not.toBe(bea.pin)
    // Cada una entra con el suyo.
    expect(m.access.entrar({ pin: bea.pin }, null, '10.0.8.1')).toMatchObject({
      ok: true,
      user: { name: 'Cora' },
    })
    expect(m.access.entrar({ pin: r.json().pin }, null, '10.0.8.2')).toMatchObject({
      ok: true,
      user: { name: 'Bea' },
    })
  })
})

void guardarPersona
