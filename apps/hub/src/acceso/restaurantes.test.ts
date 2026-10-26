import { newId, PERMISSIONS } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { crearServidor } from '../servidor'
import { asegurarAdministrador, asegurarRoles } from './inicial'
import { montarAcceso } from './montaje'
import { ErrorPersonal, guardarPersona, guardarRol, leerPersonal } from './personal'
import { insertVersioned, SISTEMA } from './registros'
import { huellaPin } from './secretos'
import { ServicioAcceso } from './servicio'

// Dos restaurantes en la misma base (ADR-013, multirestaurante): usuarios, roles, PIN, contraseñas,
// sesiones y equipos son por `restaurant_id`. Nada de uno debe verse ni cambiarse desde el otro,
// ni siquiera con la misma clave del hub (el peor caso: huellas calculadas con la misma clave).

const CLAVE = Buffer.alloc(32, 7)

function twoRestaurants() {
  const a = montarAcceso()
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
    SISTEMA,
    now,
  )
  const rolesB = asegurarRoles(db, idB, now)
  const accesoB = new ServicioAcceso({
    db,
    restaurantId: idB,
    key: CLAVE,
    clock: a.clock,
    costoContrasena: 1,
  })
  const adminB = accesoB.crearUsuario({
    name: 'Administrador B',
    rolId: rolesB.admin,
    user: 'admin',
    password: 'clave-del-admin-b',
  })
  const appA = crearServidor({
    access: a.access,
    catalog: { db, restaurantId: a.restaurantId, access: a.access, clock: a.clock },
  })
  const appB = crearServidor({
    access: accesoB,
    catalog: { db, restaurantId: idB, access: accesoB, clock: a.clock },
  })
  const llamar = (app: typeof appA) => (url: string, cuerpo: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: cuerpo as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  return {
    a,
    db,
    idA: a.restaurantId,
    idB,
    rolesB,
    accesoA: a.access,
    accesoB,
    adminB,
    postA: llamar(appA),
    postB: llamar(appB),
  }
}

const conCajaEnAmbos = () => {
  const m = twoRestaurants()
  const cajaA = m.accesoA.crearUsuario({
    name: 'Caja A',
    rolId: m.a.roles.cashier,
    user: 'caja',
    password: 'clave-de-la-caja-a',
  })
  const cajaB = m.accesoB.crearUsuario({
    name: 'Caja B',
    rolId: m.rolesB.cashier,
    user: 'caja',
    password: 'clave-de-la-caja-b',
  })
  return { ...m, cajaA, cajaB }
}

describe('el mismo usuario en dos restaurantes', () => {
  it('cada contraseña sirve solo en su restaurante, y entra la persona de ese restaurante', () => {
    const m = conCajaEnAmbos()
    const enA = m.accesoA.entrar({ user: 'caja', password: 'clave-de-la-caja-a' }, null, '10.0.0.1')
    const inB = m.accesoB.entrar({ user: 'caja', password: 'clave-de-la-caja-b' }, null, '10.0.0.1')
    expect(enA).toMatchObject({ ok: true, user: { id: m.cajaA.userId, name: 'Caja A' } })
    expect(inB).toMatchObject({ ok: true, user: { id: m.cajaB.userId, name: 'Caja B' } })
    // Cruzadas, no entran.
    expect(
      m.accesoA.entrar({ user: 'caja', password: 'clave-de-la-caja-b' }, null, '10.0.0.2'),
    ).toMatchObject({
      ok: false,
      code: 'invalid_credentials',
    })
    expect(
      m.accesoB.entrar({ user: 'caja', password: 'clave-de-la-caja-a' }, null, '10.0.0.2'),
    ).toMatchObject({
      ok: false,
      code: 'invalid_credentials',
    })
  })

  it('un usuario que solo existe en el otro restaurante falla igual que uno inventado', () => {
    const m = conCajaEnAmbos()
    const soloB = m.accesoB.crearUsuario({
      name: 'Solo B',
      rolId: m.rolesB.cashier,
      user: 'solo.b',
      password: 'clave-solo-b-1',
    })
    expect(soloB.userId).toBeTruthy()
    const dePrueba = m.accesoA.entrar(
      { user: 'solo.b', password: 'clave-solo-b-1' },
      null,
      '10.0.0.3',
    )
    const inventado = m.accesoA.entrar(
      { user: 'inventado', password: 'clave-solo-b-1' },
      null,
      '10.0.0.4',
    )
    expect(dePrueba).toEqual(inventado)
  })

  it('el administrador «admin» de cada restaurante es independiente: cambiar la contraseña de uno no toca al otro', () => {
    const m = conCajaEnAmbos()
    const adminA = m.a.people.admin
    m.accesoA.ponerContrasena(adminA.userId, 'admin', 'nueva-clave-de-a-1')
    expect(
      m.accesoB.entrar({ user: 'admin', password: 'clave-del-admin-b' }, null, '10.0.0.5'),
    ).toMatchObject({ ok: true })
    expect(
      m.accesoA.entrar({ user: 'admin', password: adminA.password as string }, null, '10.0.0.6'),
    ).toMatchObject({ ok: false })
    expect(
      m.accesoA.entrar({ user: 'admin', password: 'nueva-clave-de-a-1' }, null, '10.0.0.7'),
    ).toMatchObject({ ok: true })
  })

  it('archivar «caja» en un restaurante libera el usuario allí y no toca al «caja» del otro', () => {
    const m = conCajaEnAmbos()
    const sesionB = m.accesoB.entrar(
      { user: 'caja', password: 'clave-de-la-caja-b' },
      null,
      '10.0.0.8',
    )
    expect(sesionB).toMatchObject({ ok: true })
    m.accesoA.archivarUsuario(m.cajaA.userId)
    expect(
      m.accesoA.entrar({ user: 'caja', password: 'clave-de-la-caja-a' }, null, '10.0.0.9'),
    ).toMatchObject({ ok: false })
    expect(
      m.accesoB.entrar({ user: 'caja', password: 'clave-de-la-caja-b' }, null, '10.0.0.10'),
    ).toMatchObject({ ok: true })
    // Y el usuario queda libre en A para otra persona.
    expect(() =>
      m.accesoA.crearUsuario({
        name: 'Nueva caja',
        rolId: m.a.roles.cashier,
        user: 'caja',
        password: 'otra-clave-nueva-1',
      }),
    ).not.toThrow()
  })

  it('cambiar o quitar la contraseña de «caja» en A no cierra la sesión del «caja» de B', () => {
    const m = conCajaEnAmbos()
    const equipoB = m.accesoB.entrar(
      { user: 'caja', password: 'clave-de-la-caja-b' },
      null,
      '10.0.0.11',
    )
    if (!equipoB.ok || !equipoB.device) throw new Error('no entró')
    const conexionB = m.accesoB.authenticate(equipoB.device.token)
    if (!conexionB) throw new Error('sin conexión')
    m.accesoA.ponerContrasena(m.cajaA.userId, 'caja', 'clave-nueva-de-a-1')
    m.accesoA.quitarContrasena(m.cajaA.userId)
    const sesionAbierta = m.accesoB.usuarioConPermiso(
      conexionB,
      { sesionId: equipoB.sesionId, secret: equipoB.secret },
      'record_payment',
    )
    expect(sesionAbierta).toMatchObject({ ok: true, userId: m.cajaB.userId })
  })
})

describe('el mismo PIN en dos restaurantes', () => {
  /** Fuerza que dos personas de restaurantes distintos tengan los mismos 4 dígitos. */
  function mismoPin() {
    const m = twoRestaurants()
    const meseroA = m.accesoA.crearUsuario({ name: 'Mesera A', rolId: m.a.roles.waiter })
    const meseroB = m.accesoB.crearUsuario({ name: 'Mesera B', rolId: m.rolesB.waiter })
    const setFor = (restaurant: string, userId: string) =>
      m.db
        .prepare('UPDATE user_credentials SET pin_hash = ? WHERE user_id = ?')
        .run(huellaPin(CLAVE, restaurant, '4821'), userId)
    setFor(m.idA, meseroA.userId)
    setFor(m.idB, meseroB.userId)
    return { ...m, meseroA, meseroB }
  }

  it('el PIN lleva a la persona de ese restaurante, y la huella de uno no es la del otro', () => {
    const m = mismoPin()
    expect(huellaPin(CLAVE, m.idA, '4821')).not.toBe(huellaPin(CLAVE, m.idB, '4821'))
    expect(m.accesoA.entrar({ pin: '4821' }, null, '10.0.1.1')).toMatchObject({
      ok: true,
      user: { name: 'Mesera A' },
    })
    expect(m.accesoB.entrar({ pin: '4821' }, null, '10.0.1.2')).toMatchObject({
      ok: true,
      user: { name: 'Mesera B' },
    })
  })

  it('un PIN de B no entra en A si en A nadie lo tiene', () => {
    const m = mismoPin()
    const soloB = m.accesoB.crearUsuario({ name: 'Solo B', rolId: m.rolesB.waiter })
    expect(soloB.pin).toMatch(/^\d{4}$/)
    // Con 10 000 PIN posibles puede coincidir por azar con alguno de A; se compara contra A.
    const enA = m.accesoA.entrar({ pin: soloB.pin }, null, '10.0.1.3')
    const dueñoEnA = [
      m.a.people.waiter.pin,
      m.a.people.waiter2.pin,
      m.a.people.cashier.pin,
      m.a.people.manager.pin,
      '4821',
    ]
    if (!dueñoEnA.includes(soloB.pin)) expect(enA).toMatchObject({ ok: false, code: 'wrong_pin' })
  })

  it('archivar a la persona de A deja libre el PIN en A y no toca el de B', () => {
    const m = mismoPin()
    m.accesoA.archivarUsuario(m.meseroA.userId)
    expect(m.accesoA.entrar({ pin: '4821' }, null, '10.0.1.4')).toMatchObject({ ok: false })
    expect(m.accesoB.entrar({ pin: '4821' }, null, '10.0.1.5')).toMatchObject({ ok: true })
  })

  it('regenerar el PIN en A no cambia el de B', () => {
    const m = mismoPin()
    m.accesoA.regenerarPin(m.meseroA.userId)
    expect(m.accesoB.entrar({ pin: '4821' }, null, '10.0.1.6')).toMatchObject({
      ok: true,
      user: { name: 'Mesera B' },
    })
  })

  it('el PIN de autorización de un administrador de B no autoriza en A', () => {
    const m = mismoPin()
    const entry = m.accesoA.entrar({ pin: '4821' }, null, '10.0.1.7')
    if (!entry.ok || !entry.device) throw new Error('no entró')
    const connection = m.accesoA.authenticate(entry.device.token)
    if (!connection) throw new Error('sin conexión')
    const r = m.accesoA.autorizar(connection, {
      sesionId: entry.sesionId,
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

describe('sesiones, equipos y permisos no cruzan', () => {
  it('el token de un equipo de A no existe en B, ni al revés', () => {
    const m = conCajaEnAmbos()
    const a = m.accesoA.entrar({ pin: m.a.people.waiter.pin }, null, '10.0.2.1')
    const b = m.accesoB.entrar({ user: 'caja', password: 'clave-de-la-caja-b' }, null, '10.0.2.2')
    if (!a.ok || !a.device || !b.ok || !b.device) throw new Error('no entraron')
    expect(m.accesoA.authenticate(a.device.token)).not.toBeNull()
    expect(m.accesoB.authenticate(a.device.token)).toBeNull()
    expect(m.accesoA.authenticate(b.device.token)).toBeNull()
  })

  it('por la API: el token y la sesión de A en el servidor de B dan 401 en todo', async () => {
    const m = conCajaEnAmbos()
    const r = await m.postA('/api/sign-in', {
      user: m.a.people.admin.user,
      password: m.a.people.admin.password,
    })
    const cuerpo = r.json()
    const session = { session_id: cuerpo.session_id, secret: cuerpo.secret }
    const token = cuerpo.device.token
    for (const url of ['/api/staff/read', '/api/staff/roles', '/api/staff/people'])
      expect((await m.postB(url, session, token)).statusCode, url).toBe(401)
    expect((await m.postB('/api/sign-in', { pin: m.a.people.waiter.pin }, token)).statusCode).toBe(
      401,
    )
    expect((await m.postB('/api/sessions/close', session, token)).statusCode).toBe(401)
    // En A sí sirve.
    expect((await m.postA('/api/staff/read', session, token)).statusCode).toBe(200)
  })

  it('la sesión de B no vale en A ni con el equipo correcto de A (mismo token, sesión ajena)', async () => {
    const m = conCajaEnAmbos()
    const enA = m.accesoA.entrar(
      {
        user: m.a.people.admin.user as string,
        password: m.a.people.admin.password as string,
      },
      null,
      '10.0.2.3',
    )
    const inB = m.accesoB.entrar({ user: 'admin', password: 'clave-del-admin-b' }, null, '10.0.2.4')
    if (!enA.ok || !enA.device || !inB.ok) throw new Error('no entraron')
    const r = await m.postA(
      '/api/staff/read',
      { session_id: inB.sesionId, secret: inB.secret },
      enA.device.token,
    )
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'invalid_session' })
  })

  it('los permisos de un usuario de A son vacíos vistos desde B, y cambiar un rol de A no cambia el de B', () => {
    const m = conCajaEnAmbos()
    expect(m.accesoB.permisosDe(m.a.people.admin.userId)).toEqual([])
    expect(m.accesoA.permisosDe(m.adminB.userId)).toEqual([])
    const before = m.accesoB.permisosDe(m.cajaB.userId)
    guardarRol(
      m.db,
      m.idA,
      m.accesoA,
      { id: m.a.roles.cashier, name: 'Cajero', permissions: ['take_order'] },
      SISTEMA,
      m.a.clock(),
    )
    expect(m.accesoA.permisosDe(m.cajaA.userId)).toEqual(['take_order'])
    expect(m.accesoB.permisosDe(m.cajaB.userId)).toEqual(before)
    expect(before.length).toBeGreaterThan(5)
  })

  it('un rol de A tiene nombre repetido en B sin chocar: cada restaurante tiene su «Mesero» y su «Cajero»', () => {
    const m = twoRestaurants()
    const names = (id: string) =>
      m.db
        .prepare('SELECT name FROM roles WHERE restaurant_id = ? AND system = 1 ORDER BY name')
        .all(id)
        .map((f) => f.name)
    expect(names(m.idA)).toEqual(names(m.idB))
    expect(m.a.roles.waiter).not.toBe(m.rolesB.waiter)
  })

  it('dos restaurantes tienen su propio administrador y cada rol Administrador conserva todos los permisos', () => {
    const m = twoRestaurants()
    const esperados = PERMISSIONS.filter((p) => p !== 'view_own_reports').sort()
    expect(m.accesoA.permisosDe(m.a.people.admin.userId)).toEqual(esperados)
    expect(m.accesoB.permisosDe(m.adminB.userId)).toEqual(esperados)
  })

  it('revocar desde A un equipo de B: «ese equipo no existe», y B no se entera', () => {
    const m = conCajaEnAmbos()
    const a = m.accesoA.entrar(
      {
        user: m.a.people.admin.user as string,
        password: m.a.people.admin.password as string,
      },
      null,
      '10.0.2.5',
    )
    const b = m.accesoB.entrar({ pin: '0000' }, null, '10.0.2.6')
    expect(b).toMatchObject({ ok: false })
    const cajaB = m.accesoB.entrar(
      { user: 'caja', password: 'clave-de-la-caja-b' },
      null,
      '10.0.2.7',
    )
    if (!a.ok || !a.device || !cajaB.ok || !cajaB.device) throw new Error('no entraron')
    const conexionA = m.accesoA.authenticate(a.device.token)
    if (!conexionA) throw new Error('sin conexión')
    const r = m.accesoA.revocarDispositivo(conexionA, {
      sesionId: a.sesionId,
      secret: a.secret,
      deviceId: cajaB.device.deviceId,
    })
    expect(r).toMatchObject({ ok: false, code: 'invalid_data' })
    expect(m.accesoB.authenticate(cajaB.device.token)).toMatchObject({ revokedAt: null })
  })
})

describe('la API de personal de un restaurante no toca al otro', () => {
  const staff = (m: ReturnType<typeof twoRestaurants>, id: string, access: ServicioAcceso) =>
    leerPersonal(m.db, id, access)

  it('leer personal lista solo a la gente y los roles de su restaurante', () => {
    const m = conCajaEnAmbos()
    const a = staff(m, m.idA, m.accesoA)
    const b = staff(m, m.idB, m.accesoB)
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

  it('editar desde A una persona o un rol que es de B: «no existe», sin cambiar nada en B', () => {
    const m = conCajaEnAmbos()
    const before = JSON.stringify(
      m.db.prepare('SELECT * FROM users WHERE restaurant_id = ? ORDER BY id').all(m.idB),
    )
    const antesRoles = JSON.stringify(
      m.db.prepare('SELECT * FROM role_permissions WHERE restaurant_id = ? ORDER BY id').all(m.idB),
    )
    const person = (data: Parameters<typeof guardarPersona>[3]) => () =>
      guardarPersona(m.db, m.idA, m.accesoA, data, SISTEMA, m.a.clock())
    expect(person({ id: m.cajaB.userId, name: 'Cambiada', rolId: m.a.roles.waiter })).toThrow(
      /Esa persona no existe/,
    )
    expect(person({ name: 'Intrusa', rolId: m.rolesB.admin })).toThrow(/Ese rol no existe/)
    expect(
      person({ id: m.cajaB.userId, name: 'Cambiada', rolId: m.rolesB.waiter, active: false }),
    ).toThrow(ErrorPersonal)
    expect(() =>
      guardarRol(
        m.db,
        m.idA,
        m.accesoA,
        { id: m.rolesB.admin, name: 'Administrador', permissions: [] },
        SISTEMA,
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
    ).toBe(antesRoles)
  })

  it('el servicio de A no puede archivar, regenerar el PIN, quitar ni cambiar la contraseña de alguien de B', () => {
    const m = conCajaEnAmbos()
    const abierta = m.accesoB.entrar(
      { user: 'caja', password: 'clave-de-la-caja-b' },
      null,
      '10.0.3.1',
    )
    expect(abierta).toMatchObject({ ok: true })
    const pinAntes = m.db
      .prepare('SELECT pin_hash FROM user_credentials WHERE user_id = ?')
      .get(m.cajaB.userId)
    expect(() => m.accesoA.regenerarPin(m.cajaB.userId)).toThrow(/no tiene credencial/)
    expect(() => m.accesoA.ponerContrasena(m.cajaB.userId, 'otro', 'clave-intrusa-1')).toThrow(
      /no tiene credencial/,
    )
    m.accesoA.quitarContrasena(m.cajaB.userId)
    m.accesoA.archivarUsuario(m.cajaB.userId)
    expect(m.db.prepare('SELECT active FROM users WHERE id = ?').get(m.cajaB.userId)).toEqual({
      active: 1,
    })
    expect(
      m.db.prepare('SELECT pin_hash FROM user_credentials WHERE user_id = ?').get(m.cajaB.userId),
    ).toEqual(pinAntes)
    expect(m.accesoB.usuarioDe(m.cajaB.userId)).toBe('caja')
    expect(
      m.db
        .prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ? AND closed_at IS NULL')
        .get(m.cajaB.userId),
    ).toEqual({ n: 1 })
  })

  it('no se puede quitar al último administrador de A aunque B tenga el suyo', () => {
    const m = twoRestaurants()
    expect(() =>
      guardarPersona(
        m.db,
        m.idA,
        m.accesoA,
        {
          id: m.a.people.admin.userId,
          name: 'Administrador',
          rolId: m.a.roles.admin,
          active: false,
        },
        SISTEMA,
        m.a.clock(),
      ),
    ).toThrow(/al menos una persona/)
    expect(
      m.accesoA.entrar(
        {
          user: m.a.people.admin.user as string,
          password: m.a.people.admin.password as string,
        },
        null,
        '10.0.3.2',
      ),
    ).toMatchObject({ ok: true })
  })

  it('quitarle el permiso de administrar a B no depende de A: el de A sigue en pie y viceversa', () => {
    const m = twoRestaurants()
    expect(() =>
      guardarRol(
        m.db,
        m.idB,
        m.accesoB,
        { id: m.rolesB.admin, name: 'Administrador', permissions: ['take_order'] },
        SISTEMA,
        m.a.clock(),
      ),
    ).toThrow(/al menos una persona/)
    // Dentro de A sí se puede cuando hay otra persona con el permiso.
    const another = m.accesoA.crearUsuario({
      name: 'Otra admin',
      rolId: m.a.roles.admin,
      user: 'otra.admin',
      password: 'clave-de-otra-admin',
    })
    expect(another.userId).toBeTruthy()
    expect(() =>
      guardarPersona(
        m.db,
        m.idA,
        m.accesoA,
        {
          id: m.a.people.admin.userId,
          name: 'Administrador',
          rolId: m.a.roles.admin,
          active: false,
        },
        SISTEMA,
        m.a.clock(),
      ),
    ).not.toThrow()
  })
})

describe('arranque con un segundo restaurante en la base', () => {
  // Antes fallaba: `asegurarAdministrador` y `usuarioLibre` no filtraban por restaurante.
  it('un restaurante nuevo recibe su propio administrador aunque otro ya tenga el suyo', () => {
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
      SISTEMA,
      now,
    )
    const rolesC = asegurarRoles(m.db, idC, now)
    const accesoC = new ServicioAcceso({
      db: m.db,
      restaurantId: idC,
      key: CLAVE,
      clock: m.a.clock,
      costoContrasena: 1,
    })
    const r = asegurarAdministrador(m.db, accesoC, rolesC.admin, false)
    expect(r.user).toBe('admin')
    expect(
      accesoC.entrar({ user: 'admin', password: r.password as string }, null, '10.0.4.1'),
    ).toMatchObject({ ok: true })
  })
})
