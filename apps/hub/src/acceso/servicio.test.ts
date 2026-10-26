import { authorizableFingerprint, newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { asegurarAdministrador, asegurarRestaurante, asegurarRoles } from './inicial'
import { firmado, montarAcceso } from './montaje'
import { VIGENCIA_AUTORIZACION_MS, VIGENCIA_CODIGO_MS } from './servicio'

const open = { channel: 'dine_in', table_id: null, guests: 2 }

describe('arranque', () => {
  it('crea restaurante, sede, roles y administrador una sola vez', () => {
    const m = montarAcceso()
    const ahora = m.clock()
    expect(asegurarRestaurante(m.db, ahora)).toBe(m.restauranteId)
    expect(m.roles).toMatchObject(asegurarRoles(m.db, m.restauranteId, ahora))
    expect(asegurarAdministrador(m.db, m.access, m.roles.admin, false)).toEqual({
      pin: null,
      user: null,
      password: null,
      avisos: [],
    })

    const check = (tabla: string) =>
      Number(m.db.prepare(`SELECT count(*) AS n FROM ${tabla}`).get()?.n)
    expect(check('restaurants')).toBe(1)
    expect(check('locations')).toBe(1)
    expect(check('roles')).toBe(6)
    expect(m.access.permisosDe(m.people.waiter.userId)).toEqual([
      'mark_preparation',
      'remove_unsent_item',
      'take_order',
      'view_own_reports',
    ])
    // Cada registro de catálogo tomó una versión distinta del contador.
    const versiones = m.db.prepare('SELECT version FROM role_permissions').all()
    expect(new Set(versiones.map((f) => f.version)).size).toBe(versiones.length)
  })

  it('si se perdió la clave de los PIN, regenera el del administrador y avisa', () => {
    const m = montarAcceso()
    const r = asegurarAdministrador(m.db, m.access, m.roles.admin, true)

    expect(r.pin).toMatch(/^\d{4}$/)
    expect(r.avisos.join(' ')).toMatch(/clave de los PIN/)
    expect(
      m.access.crearEmparejamiento({ pin: m.people.admin.pin, name: 'X', type: 'register' }, null),
    ).toMatchObject({ ok: false })
    expect(
      m.access.crearEmparejamiento({ pin: r.pin as string, name: 'X', type: 'register' }, null),
    ).toMatchObject({ ok: true })
  })
})

describe('emparejar un dispositivo', () => {
  it('con PIN de administrador da un código; el código se cambia por un token una sola vez', () => {
    const m = montarAcceso()
    const code = m.access.crearEmparejamiento(
      { pin: m.people.admin.pin, name: 'Celular Ana', type: 'waiter' },
      null,
    )
    if (!code.ok) throw new Error(code.message)
    const r = m.access.emparejar(code.code.toLowerCase(), '10.0.0.6')
    if (!r.ok) throw new Error(r.message)

    expect(m.access.authenticate(r.token)).toEqual({
      dispositivoId: r.dispositivoId,
      type: 'waiter',
      revocadoEn: null,
    })
    expect(m.access.emparejar(code.code, '10.0.0.6')).toMatchObject({
      ok: false,
      code: 'invalid_code',
    })
    // En la base queda la huella del token, no el token.
    const credential = m.db.prepare('SELECT token_hash FROM device_credentials').get()
    expect(credential?.token_hash).not.toBe(r.token)
    expect(m.access.authenticate('other')).toBeNull()
  })

  it('el PIN de un mesero no aprueba, con el mismo mensaje que un PIN que no existe', () => {
    const m = montarAcceso()
    const conMesero = m.access.crearEmparejamiento(
      { pin: m.people.waiter.pin, name: 'X', type: 'waiter' },
      null,
    )
    expect(conMesero).toMatchObject({ ok: false, code: 'wrong_pin' })
    const nonexistent = m.access.crearEmparejamiento(
      { pin: '0001', name: 'X', type: 'waiter' },
      null,
    )
    expect(nonexistent).toMatchObject({ ok: false, code: 'wrong_pin' })
    expect(conMesero).toEqual(nonexistent)
  })

  it('el código vence a los 5 minutos', () => {
    const m = montarAcceso()
    const code = m.access.crearEmparejamiento(
      { pin: m.people.admin.pin, name: 'X', type: 'kds' },
      null,
    )
    if (!code.ok) throw new Error(code.message)
    m.avanzar(VIGENCIA_CODIGO_MS)
    expect(m.access.emparejar(code.code, 'ip')).toMatchObject({ code: 'invalid_code' })
  })

  it('rechaza nombre vacío o tipo desconocido', () => {
    const m = montarAcceso()
    const pin = m.people.admin.pin
    expect(m.access.crearEmparejamiento({ pin, name: '  ', type: 'register' }, null)).toMatchObject(
      {
        code: 'invalid_data',
      },
    )
    expect(m.access.crearEmparejamiento({ pin, name: 'X', type: 'tostadora' }, null)).toMatchObject(
      { code: 'invalid_data' },
    )
  })

  it('probar códigos al azar desde una IP la hace esperar', () => {
    const m = montarAcceso()
    for (let i = 0; i < 3; i++) m.access.emparejar('AAAAAAAA', '10.0.0.66')
    expect(m.access.emparejar('AAAAAAAA', '10.0.0.66')).toMatchObject({ code: 'wait' })
    expect(m.access.emparejar('AAAAAAAA', '10.0.0.67')).toMatchObject({ code: 'invalid_code' })
  })
})

describe('sesiones con PIN', () => {
  it('el PIN identifica a la persona y trae sus permisos', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const r = m.entrar(connection, 'cashier')

    expect(r.user).toMatchObject({ name: 'Carlos', role: 'Cajero' })
    expect(r.permissions).toContain('record_payment')
    expect(r.secret).not.toBe('')
    const fila = m.db.prepare('SELECT secret_hash FROM sessions').get()
    expect(fila?.secret_hash).not.toBe(r.secret)
  })

  it('tres PIN errados en un dispositivo lo hacen esperar; a los demás no', () => {
    const m = montarAcceso()
    const a = m.emparejar('waiter', 'A').connection
    const b = m.emparejar('waiter', 'B').connection
    const errado = ['0001', '0002', '0003']
    const r = errado.map((pin) => m.access.startSession(a, pin))

    expect(r.map((x) => (x.ok ? 'ok' : x.esperaMs))).toEqual([0, 0, 2000])
    expect(m.access.startSession(a, m.people.waiter.pin)).toMatchObject({ code: 'wait' })
    expect(m.access.startSession(b, m.people.waiter.pin)).toMatchObject({ ok: true })
    m.avanzar(2000)
    expect(m.access.startSession(a, m.people.waiter.pin)).toMatchObject({ ok: true })
  })

  it('escribir otro PIN cierra la sesión anterior del dispositivo', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const ana = m.entrar(connection, 'waiter')
    m.entrar(connection, 'waiter2')

    expect(m.access.cerrarSesion(connection, ana)).toMatchObject({ code: 'invalid_session' })
  })

  it('cerrar la sesión exige su secreto y el mismo dispositivo', () => {
    const m = montarAcceso()
    const a = m.emparejar().connection
    const b = m.emparejar().connection
    const s = m.entrar(a, 'waiter')

    expect(m.access.cerrarSesion(a, { ...s, secret: 'x' })).toMatchObject({ ok: false })
    expect(m.access.cerrarSesion(b, s)).toMatchObject({ ok: false })
    expect(m.access.cerrarSesion(a, s)).toEqual({ ok: true })
  })

  it('los PIN son únicos entre los activos; archivar libera el PIN y cierra sus sesiones', () => {
    const m = montarAcceso()
    const pins = new Set<string>()
    for (let i = 0; i < 300; i++)
      pins.add(m.access.crearUsuario({ name: `U${i}`, rolId: m.roles.waiter }).pin)
    expect(pins.size).toBe(300)

    const { connection } = m.emparejar()
    const s = m.entrar(connection, 'waiter')
    m.access.archivarUsuario(m.people.waiter.userId)
    expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({
      code: 'wrong_pin',
    })
    expect(m.access.cerrarSesion(connection, s)).toMatchObject({ code: 'invalid_session' })
  })

  it('regenerar el PIN invalida el anterior', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const fresh = m.access.regenerarPin(m.people.waiter.userId)
    expect(m.access.startSession(connection, m.people.waiter.pin).ok).toBe(
      fresh === m.people.waiter.pin,
    )
    expect(m.access.startSession(connection, fresh)).toMatchObject({ ok: true })
  })
})

describe('qué eventos puede crear cada quien', () => {
  it('el mesero toma pedidos; anular un ítem enviado le pide autorización', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const s = m.entrar(connection, 'waiter')

    expect(m.access.verify(connection, m.event(connection, s, 'OrderOpened', open), null)).toEqual({
      ok: true,
      authorizedById: null,
      autorizacionId: null,
    })
    expect(
      m.access.verify(connection, m.event(connection, s, 'ItemVoided', {}, { reason: 'x' }), null),
    ).toEqual({ ok: false, reason: 'no_permission' })
  })

  it('con el PIN de la gerente, el comprobante vale para ese evento, una vez', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const s = m.entrar(connection, 'waiter')
    const voidItem = m.event(connection, s, 'ItemVoided', {}, { reason: 'Se equivocó' })
    const a = m.access.autorizar(connection, {
      ...s,
      pin: m.people.manager.pin,
      action: 'void_sent_item',
      agregadoId: voidItem.aggregate_id,
      eventId: voidItem.id,
      fingerprint: authorizableFingerprint(voidItem),
    })
    if (!a.ok) throw new Error(a.message)
    expect(a.supervisor.name).toBe('Gloria')
    const conComprobante = firmado(s, { ...voidItem, authorization_id: a.autorizacionId })

    const v = m.access.verify(connection, conComprobante, null)
    expect(v).toEqual({
      ok: true,
      authorizedById: m.people.manager.userId,
      autorizacionId: a.autorizacionId,
    })
    if (v.ok) m.access.registrarUso(conComprobante, v)
    expect(m.access.verify(connection, conComprobante, null)).toEqual({
      ok: false,
      reason: 'invalid_authorization',
    })
    // La sesión del mesero sigue abierta.
    expect(m.access.cerrarSesion(connection, s)).toEqual({ ok: true })
  })

  it('el comprobante no sirve para otro evento, otro pedido, otra acción ni pasados 2 minutos', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const s = m.entrar(connection, 'waiter')
    const voidItem = m.event(connection, s, 'ItemVoided', {}, { reason: 'x' })
    const a = m.access.autorizar(connection, {
      ...s,
      pin: m.people.manager.pin,
      action: 'void_sent_item',
      agregadoId: voidItem.aggregate_id,
      eventId: voidItem.id,
      fingerprint: authorizableFingerprint(voidItem),
    })
    if (!a.ok) throw new Error(a.message)
    // Cada cambio se firma de nuevo, como lo haría un dispositivo modificado.
    const withIt = (changes: object) =>
      m.access.verify(
        connection,
        firmado(s, { ...voidItem, authorization_id: a.autorizacionId, ...changes }),
        null,
      )

    expect(withIt({ id: newId() })).toMatchObject({ reason: 'invalid_authorization' })
    expect(withIt({ aggregate_id: newId() })).toMatchObject({ reason: 'invalid_authorization' })
    expect(withIt({ type: 'OrderCanceled' })).toMatchObject({ reason: 'invalid_authorization' })
    const tarde = new Date(Date.parse(m.clock()) + VIGENCIA_AUTORIZACION_MS + 1).toISOString()
    expect(withIt({ hub_estimated_time: tarde })).toMatchObject({ reason: 'invalid_authorization' })
    expect(withIt({})).toMatchObject({ ok: true })
  })

  it('nadie se autoriza a sí mismo, y un PIN sin el permiso no autoriza', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const s = m.entrar(connection, 'manager')
    const data = {
      ...s,
      // El cajero puede autorizar anulaciones (ADR-013), no cortesías.
      action: 'comp',
      agregadoId: newId(),
      eventId: newId(),
      fingerprint: 'a'.repeat(64),
    }

    expect(m.access.autorizar(connection, { ...data, pin: m.people.manager.pin })).toMatchObject({
      code: 'self_authorization',
    })
    expect(m.access.autorizar(connection, { ...data, pin: m.people.cashier.pin })).toMatchObject({
      code: 'wrong_pin',
    })
    expect(m.access.autorizar(connection, { ...data, pin: m.people.admin.pin })).toMatchObject({
      ok: true,
    })
    expect(m.access.autorizar(connection, { ...data, pin: m.people.admin.pin })).toMatchObject({
      code: 'already_authorized',
    })
  })

  it('pagos y cierres solo desde la caja, aunque el usuario sea cajero (no desde la pantalla de cocina)', () => {
    const m = montarAcceso()
    // Un celular se vuelve de caja al entrar el cajero con contraseña (ADR-013); una pantalla de
    // cocina, no.
    const phone = m.emparejar('kds').connection
    const register = m.emparejar('register').connection
    const enCelular = m.entrar(phone, 'cashier')
    const enCaja = m.entrar(register, 'cashier')

    expect(m.access.verify(phone, m.event(phone, enCelular, 'OrderClosed', {}), null)).toEqual({
      ok: false,
      reason: 'register_only',
    })
    expect(
      m.access.verify(register, m.event(register, enCaja, 'OrderClosed', {}), null),
    ).toMatchObject({
      ok: true,
    })
  })

  it('el hub no cree lo que dice el evento: sesión, usuario y dispositivo deben cuadrar', () => {
    const m = montarAcceso()
    const a = m.emparejar().connection
    const b = m.emparejar().connection
    const sa = m.entrar(a, 'waiter')
    const ev = m.event(a, sa, 'OrderOpened', open)

    expect(m.access.verify(a, { ...ev, session_id: null }, null)).toMatchObject({
      reason: 'no_session',
    })
    expect(m.access.verify(b, ev, null)).toMatchObject({ reason: 'foreign_session' })
    expect(m.access.verify(a, { ...ev, user_id: m.people.manager.userId }, null)).toMatchObject({
      reason: 'user_mismatch',
    })
    expect(m.access.verify(a, { ...ev, session_id: newId() }, null)).toEqual({
      ok: false,
      reason: 'unknown_session',
      quarantine: true,
    })
    expect(
      m.access.verify(a, firmado(sa, { ...ev, type: 'RescueOrderCreated' } as typeof ev), null),
    ).toMatchObject({ reason: 'hub_only' })
  })

  it('la sesión se juzga a la hora del evento: lo hecho sin conexión antes del cierre vale', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const s = m.entrar(connection, 'waiter')
    const before = m.event(connection, s, 'OrderOpened', open)
    m.avanzar(40 * 60_000)
    m.access.cerrarSesion(connection, s)
    m.avanzar(5 * 60_000)
    const after = m.event(connection, s, 'OrderOpened', open)

    expect(m.access.verify(connection, before, null)).toMatchObject({ ok: true })
    expect(m.access.verify(connection, after, null)).toMatchObject({ reason: 'session_closed' })
  })

  it('el permiso se evalúa con el rol al recibir: un usuario archivado ya no crea nada', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const s = m.entrar(connection, 'waiter')
    const ev = m.event(connection, s, 'OrderOpened', open)
    m.access.archivarUsuario(m.people.waiter.userId)

    expect(m.access.verify(connection, ev, null)).toMatchObject({ reason: 'user_inactive' })
  })
})

describe('revocar un dispositivo', () => {
  it('solo el administrador, no el propio equipo, y avisa a la sala', () => {
    const m = montarAcceso()
    const register = m.emparejar('register').connection
    const phone = m.emparejar('waiter')
    const manager = m.entrar(register, 'manager')
    const data = { dispositivoId: phone.connection.dispositivoId }

    expect(m.access.revocarDispositivo(register, { ...manager, ...data })).toMatchObject({
      code: 'no_permission',
    })
    const admin = m.entrar(register, 'admin')
    expect(
      m.access.revocarDispositivo(register, { ...admin, dispositivoId: register.dispositivoId }),
    ).toMatchObject({ code: 'invalid_data' })
    const r = m.access.revocarDispositivo(register, { ...admin, ...data })

    expect(r).toEqual({ ok: true, revocadoEn: m.clock() })
    expect(m.revocados).toEqual([phone.connection.dispositivoId])
    expect(m.access.authenticate(phone.token)?.revocadoEn).toBe(m.clock())
    expect(
      m.access.startSession(m.access.authenticate(phone.token) as never, m.people.waiter.pin),
    ).toMatchObject({ code: 'revoked_device' })
  })
})
