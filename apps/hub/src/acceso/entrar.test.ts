import { PERMISOS } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { crearServidor } from '../servidor'
import { asegurarAdministrador, asegurarRoles } from './inicial'
import { montarAcceso } from './montaje'
import { insertarVersionado, SISTEMA } from './registros'

// Entrar sin emparejar (tarea 1.3b, ADR-013): meseros con PIN desde cualquier navegador; quien
// tiene usuario, con usuario y contraseña. Los roles de antes se convierten al arrancar.

function montarApi() {
  const m = montarAcceso()
  const app = crearServidor({
    acceso: m.acceso,
    catalogo: { db: m.db, restauranteId: m.restauranteId, acceso: m.acceso, reloj: m.reloj },
  })
  const post = (url: string, cuerpo: unknown, token?: string, ip = '10.0.0.20') =>
    app.inject({
      method: 'POST',
      url,
      payload: cuerpo as object,
      remoteAddress: ip,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  const admin = { usuario: m.personas.admin.usuario, contrasena: m.personas.admin.contrasena }
  return { ...m, app, post, admin }
}

const tipoGuardado = (m: ReturnType<typeof montarAcceso>, id: string) =>
  m.db.prepare('SELECT tipo, nombre FROM dispositivo WHERE id = ?').get(id)

describe('entrar sin emparejar', () => {
  it('un mesero con su PIN: el hub registra el navegador como equipo de mesero y abre la sesión', async () => {
    const api = montarApi()
    const r = await api.post('/api/entrar', { pin: api.personas.mesero.pin })
    expect(r.statusCode).toBe(201)
    const cuerpo = r.json()
    expect(cuerpo).toMatchObject({
      tipo: 'mesero',
      usuario: { nombre: 'Ana', rol: 'Mesero' },
      equipo: { tipo: 'mesero', nombre: 'Equipo de Ana' },
    })
    expect(cuerpo.permisos).toContain('tomar_pedido')
    expect(tipoGuardado(api, cuerpo.equipo.dispositivo_id)).toMatchObject({ tipo: 'mesero' })
    // Con ese token ya es un equipo: la vez siguiente no registra otro.
    const otra = await api.post(
      '/api/entrar',
      { pin: api.personas.mesero2.pin },
      cuerpo.equipo.token,
    )
    expect(otra.json()).toMatchObject({ equipo: null, usuario: { nombre: 'Luis' } })
    // Y cerró la sesión de Ana en ese equipo.
    const cerrar = await api.post(
      '/api/sesiones/cerrar',
      { sesion_id: cuerpo.sesion_id, secreto: cuerpo.secreto },
      cuerpo.equipo.token,
    )
    expect(cerrar.statusCode).toBe(401)
  })

  it('el PIN de quien tiene usuario no abre sesión: solo autoriza', async () => {
    const api = montarApi()
    const r = await api.post('/api/entrar', { pin: api.personas.admin.pin })
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'pin_incorrecto', mensaje: 'PIN incorrecto' })
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM dispositivo').get()?.n)).toBe(0)
  })

  it('con usuario y contraseña: equipo de caja, sin importar mayúsculas ni espacios en el usuario', async () => {
    const api = montarApi()
    const r = await api.post('/api/entrar', {
      usuario: `  ${String(api.admin.usuario).toUpperCase()} `,
      contrasena: api.admin.contrasena,
    })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({
      tipo: 'caja',
      usuario: { rol: 'Administrador' },
      equipo: { tipo: 'caja' },
    })
    expect(r.json().permisos).toContain('administrar_usuarios')
  })

  it('contraseña errada y usuario inexistente dan la misma respuesta, sin registrar equipos', async () => {
    const api = montarApi()
    const mala = await api.post('/api/entrar', {
      usuario: api.admin.usuario,
      contrasena: 'no-es-esta',
    })
    const nadie = await api.post('/api/entrar', { usuario: 'nadie', contrasena: 'no-es-esta' })
    for (const r of [mala, nadie]) {
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({
        error: 'credenciales_incorrectas',
        mensaje: 'Usuario o contraseña incorrectos',
      })
    }
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM dispositivo').get()?.n)).toBe(0)
  })

  it('probar contraseñas de una cuenta desde varias IP también espera', async () => {
    const api = montarApi()
    for (const [i, ip] of ['10.0.0.31', '10.0.0.32', '10.0.0.33'].entries())
      await api.post(
        '/api/entrar',
        { usuario: api.admin.usuario, contrasena: `mala-${i}-xxx` },
        undefined,
        ip,
      )
    const otraIp = await api.post('/api/entrar', api.admin, undefined, '10.0.0.34')
    expect(otraIp.statusCode).toBe(429)
    expect(Number(otraIp.headers['retry-after'])).toBeGreaterThan(0)
    api.avanzar(61_000)
    expect((await api.post('/api/entrar', api.admin, undefined, '10.0.0.34')).statusCode).toBe(201)
  })

  it('probar PIN sin token espera por IP; otra IP no hereda la espera', async () => {
    const api = montarApi()
    for (const pin of ['0001', '0002', '0003']) await api.post('/api/entrar', { pin })
    expect((await api.post('/api/entrar', { pin: api.personas.mesero.pin })).statusCode).toBe(429)
    const otra = await api.post(
      '/api/entrar',
      { pin: api.personas.mesero.pin },
      undefined,
      '10.0.0.99',
    )
    expect(otra.statusCode).toBe(201)
  })

  it('con contraseña en un celular de mesero, el equipo pasa a ser de caja', async () => {
    const api = montarApi()
    const celular = (await api.post('/api/entrar', { pin: api.personas.mesero.pin })).json()
    const r = await api.post('/api/entrar', api.admin, celular.equipo.token)
    expect(r.json()).toMatchObject({ equipo: null, tipo: 'caja' })
    expect(tipoGuardado(api, celular.equipo.dispositivo_id)).toMatchObject({ tipo: 'caja' })
    // Un PIN de mesero después no lo devuelve a mesero.
    const luego = await api.post(
      '/api/entrar',
      { pin: api.personas.mesero.pin },
      celular.equipo.token,
    )
    expect(luego.json()).toMatchObject({ tipo: 'caja' })
  })

  it('con un token falso responde 401 y no registra otro equipo; con uno retirado, 403', async () => {
    const api = montarApi()
    const falso = await api.post('/api/entrar', { pin: api.personas.mesero.pin }, 'inventado')
    expect(falso.statusCode).toBe(401)
    expect(falso.json()).toMatchObject({ error: 'token_invalido' })

    const caja = (await api.post('/api/entrar', api.admin)).json()
    const celular = (
      await api.post('/api/entrar', { pin: api.personas.mesero.pin }, undefined, '10.0.0.50')
    ).json()
    const revocar = await api.post(
      `/api/dispositivos/${celular.equipo.dispositivo_id}/revocar`,
      { sesion_id: caja.sesion_id, secreto: caja.secreto },
      caja.equipo.token,
    )
    expect(revocar.statusCode).toBe(200)
    const despues = await api.post(
      '/api/entrar',
      { pin: api.personas.mesero.pin },
      celular.equipo.token,
    )
    expect(despues.statusCode).toBe(403)
    expect(despues.json()).toMatchObject({ error: 'dispositivo_revocado' })
  })

  it('un cuerpo con PIN y contraseña a la vez, o con campos de más, se rechaza', async () => {
    const api = montarApi()
    for (const cuerpo of [
      { pin: '1234', usuario: 'admin', contrasena: 'x' },
      { usuario: 'admin' },
      { pin: 1234 },
      {},
    ])
      expect((await api.post('/api/entrar', cuerpo)).statusCode, JSON.stringify(cuerpo)).toBe(400)
  })
})

describe('arranque de un hub de antes de ADR-013', () => {
  it('Contador pasa a ser Reportes; Gerente y Cocina quedan como roles propios, con su gente', () => {
    const m = montarAcceso()
    const viejo = (nombre: string) =>
      insertarVersionado(m.db, 'rol', m.restauranteId, { nombre, sistema: 1 }, SISTEMA, m.reloj())
    // Una base vieja: sin Reportes y con los tres de antes.
    m.db.prepare("UPDATE rol SET nombre = 'Contador' WHERE id = ?").run(m.roles.reportes)
    const gerente = viejo('Gerente')
    const cocina = viejo('Cocina')
    const gloria = m.acceso.crearUsuario({ nombre: 'Gloria V', rolId: gerente })

    const roles = asegurarRoles(m.db, m.restauranteId, m.reloj())
    expect(roles.reportes).toBe(m.roles.reportes)
    const fila = (id: string) =>
      m.db.prepare('SELECT nombre, sistema, activo FROM rol WHERE id = ?').get(id)
    expect(fila(m.roles.reportes)).toEqual({ nombre: 'Reportes', sistema: 1, activo: 1 })
    expect(fila(gerente)).toEqual({ nombre: 'Gerente', sistema: 0, activo: 1 })
    expect(fila(cocina)).toEqual({ nombre: 'Cocina', sistema: 0, activo: 1 })
    expect(m.acceso.permisosDe(gloria.usuarioId)).toEqual([])
    // Correrlo otra vez no cambia nada.
    expect(asegurarRoles(m.db, m.restauranteId, m.reloj())).toEqual(roles)
  })

  it('un administrador que entraba con PIN recibe usuario y contraseña al arrancar', () => {
    const m = montarAcceso()
    m.acceso.quitarContrasena(m.personas.admin.usuarioId)
    const r = asegurarAdministrador(m.db, m.acceso, m.roles.admin, false)
    expect(r.usuario).toBe('admin')
    expect(r.contrasena).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
    expect(r.pin).toBeNull()
    expect(r.avisos.join(' ')).toMatch(/usuario y contraseña/)
    const caja = m.acceso.entrar(
      { usuario: 'admin', contrasena: r.contrasena as string },
      null,
      'ip',
    )
    expect(caja).toMatchObject({ ok: true, usuario: { nombre: 'Administrador' } })
  })

  it('si «admin» ya lo tiene otra persona, le da «admin2»', () => {
    const m = montarAcceso()
    m.acceso.quitarContrasena(m.personas.admin.usuarioId)
    m.acceso.ponerContrasena(m.personas.cajero.usuarioId, 'admin', 'otra-clave-123')
    expect(asegurarAdministrador(m.db, m.acceso, m.roles.admin, false).usuario).toBe('admin2')
  })
})

describe('todos los permisos existen en la pantalla de roles', () => {
  it('el rol Administrador de fábrica tiene todo menos «sus propias ventas»', () => {
    const m = montarAcceso()
    expect(m.acceso.permisosDe(m.personas.admin.usuarioId)).toEqual(
      PERMISOS.filter((p) => p !== 'ver_reportes_propios').sort(),
    )
  })
})
