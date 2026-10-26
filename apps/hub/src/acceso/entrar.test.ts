import { PERMISSIONS } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { crearServidor } from '../servidor'
import { asegurarAdministrador, asegurarRoles } from './inicial'
import { montarAcceso } from './montaje'
import { insertVersioned, SISTEMA } from './registros'

// Entrar sin emparejar (tarea 1.3b, ADR-013): meseros con PIN desde cualquier navegador; quien
// tiene usuario, con usuario y contraseña. Los roles de antes se convierten al arrancar.

function montarApi() {
  const m = montarAcceso()
  const app = crearServidor({
    access: m.access,
    catalog: { db: m.db, restaurantId: m.restaurantId, access: m.access, clock: m.clock },
  })
  const post = (url: string, cuerpo: unknown, token?: string, ip = '10.0.0.20') =>
    app.inject({
      method: 'POST',
      url,
      payload: cuerpo as object,
      remoteAddress: ip,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  const admin = { user: m.people.admin.user, password: m.people.admin.password }
  return { ...m, app, post, admin }
}

const tipoGuardado = (m: ReturnType<typeof montarAcceso>, id: string) =>
  m.db.prepare('SELECT type, name FROM devices WHERE id = ?').get(id)

describe('entrar sin emparejar', () => {
  it('un mesero con su PIN: el hub registra el navegador como equipo de mesero y abre la sesión', async () => {
    const api = montarApi()
    const r = await api.post('/api/sign-in', { pin: api.people.waiter.pin })
    expect(r.statusCode).toBe(201)
    const cuerpo = r.json()
    expect(cuerpo).toMatchObject({
      type: 'waiter',
      user: { name: 'Ana', role: 'Mesero' },
      device: { type: 'waiter', name: 'Equipo de Ana' },
    })
    expect(cuerpo.permissions).toContain('take_order')
    expect(tipoGuardado(api, cuerpo.device.device_id)).toMatchObject({ type: 'waiter' })
    // Con ese token ya es un equipo: la vez siguiente no registra otro.
    const another = await api.post(
      '/api/sign-in',
      { pin: api.people.waiter2.pin },
      cuerpo.device.token,
    )
    expect(another.json()).toMatchObject({ device: null, user: { name: 'Luis' } })
    // Y cerró la sesión de Ana en ese equipo.
    const close = await api.post(
      '/api/sessions/close',
      { session_id: cuerpo.session_id, secret: cuerpo.secret },
      cuerpo.device.token,
    )
    expect(close.statusCode).toBe(401)
  })

  it('el PIN de quien tiene usuario no abre sesión: solo autoriza', async () => {
    const api = montarApi()
    const r = await api.post('/api/sign-in', { pin: api.people.admin.pin })
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'wrong_pin', message: 'PIN incorrecto' })
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM devices').get()?.n)).toBe(0)
  })

  it('con usuario y contraseña: equipo de caja, sin importar mayúsculas ni espacios en el usuario', async () => {
    const api = montarApi()
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

  it('contraseña errada y usuario inexistente dan la misma respuesta, sin registrar equipos', async () => {
    const api = montarApi()
    const bad = await api.post('/api/sign-in', {
      user: api.admin.user,
      password: 'no-es-esta',
    })
    const nadie = await api.post('/api/sign-in', { user: 'nadie', password: 'no-es-esta' })
    for (const r of [bad, nadie]) {
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({
        error: 'invalid_credentials',
        message: 'Usuario o contraseña incorrectos',
      })
    }
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM devices').get()?.n)).toBe(0)
  })

  it('probar contraseñas de una cuenta desde varias IP también espera', async () => {
    const api = montarApi()
    for (const [i, ip] of ['10.0.0.31', '10.0.0.32', '10.0.0.33'].entries())
      await api.post(
        '/api/sign-in',
        { user: api.admin.user, password: `mala-${i}-xxx` },
        undefined,
        ip,
      )
    const otraIp = await api.post('/api/sign-in', api.admin, undefined, '10.0.0.34')
    expect(otraIp.statusCode).toBe(429)
    expect(Number(otraIp.headers['retry-after'])).toBeGreaterThan(0)
    api.advance(61_000)
    expect((await api.post('/api/sign-in', api.admin, undefined, '10.0.0.34')).statusCode).toBe(201)
  })

  it('probar PIN sin token espera por IP; otra IP no hereda la espera', async () => {
    const api = montarApi()
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

  it('con contraseña en un celular de mesero, el equipo pasa a ser de caja', async () => {
    const api = montarApi()
    const phone = (await api.post('/api/sign-in', { pin: api.people.waiter.pin })).json()
    const r = await api.post('/api/sign-in', api.admin, phone.device.token)
    expect(r.json()).toMatchObject({ device: null, type: 'register' })
    expect(tipoGuardado(api, phone.device.device_id)).toMatchObject({ type: 'register' })
    // Un PIN de mesero después no lo devuelve a mesero.
    const luego = await api.post('/api/sign-in', { pin: api.people.waiter.pin }, phone.device.token)
    expect(luego.json()).toMatchObject({ type: 'register' })
  })

  it('con un token falso responde 401 y no registra otro equipo; con uno retirado, 403', async () => {
    const api = montarApi()
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

  it('un cuerpo con PIN y contraseña a la vez, o con campos de más, se rechaza', async () => {
    const api = montarApi()
    for (const cuerpo of [
      { pin: '1234', user: 'admin', password: 'x' },
      { user: 'admin' },
      { pin: 1234 },
      {},
    ])
      expect((await api.post('/api/sign-in', cuerpo)).statusCode, JSON.stringify(cuerpo)).toBe(400)
  })
})

describe('arranque de un hub de antes de ADR-013', () => {
  it('Contador pasa a ser Reportes; Gerente y Cocina quedan como roles propios, con su gente', () => {
    const m = montarAcceso()
    const oldOne = (name: string) =>
      insertVersioned(m.db, 'roles', m.restaurantId, { name, system: 1 }, SISTEMA, m.clock())
    // Una base vieja: sin Reportes y con los tres de antes.
    m.db.prepare("UPDATE roles SET name = 'Contador' WHERE id = ?").run(m.roles.reports)
    const manager = oldOne('Gerente')
    const kitchen = oldOne('Cocina')
    const gloria = m.access.crearUsuario({ name: 'Gloria V', rolId: manager })

    const roles = asegurarRoles(m.db, m.restaurantId, m.clock())
    expect(roles.reports).toBe(m.roles.reports)
    const row = (id: string) =>
      m.db.prepare('SELECT name, system, active FROM roles WHERE id = ?').get(id)
    expect(row(m.roles.reports)).toEqual({ name: 'Reportes', system: 1, active: 1 })
    expect(row(manager)).toEqual({ name: 'Gerente', system: 0, active: 1 })
    expect(row(kitchen)).toEqual({ name: 'Cocina', system: 0, active: 1 })
    expect(m.access.permisosDe(gloria.userId)).toEqual([])
    // Correrlo otra vez no cambia nada.
    expect(asegurarRoles(m.db, m.restaurantId, m.clock())).toEqual(roles)
  })

  it('un administrador que entraba con PIN recibe usuario y contraseña al arrancar', () => {
    const m = montarAcceso()
    m.access.quitarContrasena(m.people.admin.userId)
    const r = asegurarAdministrador(m.db, m.access, m.roles.admin, false)
    expect(r.user).toBe('admin')
    expect(r.password).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
    expect(r.pin).toBeNull()
    expect(r.alerts.join(' ')).toMatch(/usuario y contraseña/)
    const register = m.access.entrar({ user: 'admin', password: r.password as string }, null, 'ip')
    expect(register).toMatchObject({ ok: true, user: { name: 'Administrador' } })
  })

  it('si «admin» ya lo tiene otra persona, le da «admin2»', () => {
    const m = montarAcceso()
    m.access.quitarContrasena(m.people.admin.userId)
    m.access.ponerContrasena(m.people.cashier.userId, 'admin', 'otra-clave-123')
    expect(asegurarAdministrador(m.db, m.access, m.roles.admin, false).user).toBe('admin2')
  })
})

describe('todos los permisos existen en la pantalla de roles', () => {
  it('el rol Administrador de fábrica tiene todo menos «sus propias ventas»', () => {
    const m = montarAcceso()
    expect(m.access.permisosDe(m.people.admin.userId)).toEqual(
      PERMISSIONS.filter((p) => p !== 'view_own_reports').sort(),
    )
  })
})
