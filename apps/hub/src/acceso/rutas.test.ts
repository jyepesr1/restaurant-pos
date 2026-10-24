import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { crearServidor } from '../servidor'
import { montarAcceso } from './montaje'

function montarApi() {
  const m = montarAcceso()
  const app = crearServidor({ acceso: m.acceso })
  const post = (url: string, cuerpo: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: cuerpo as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  return { ...m, app, post }
}

/** El primero se aprueba sin token; los demás, desde un equipo ya emparejado. */
async function emparejarPorApi(api: ReturnType<typeof montarApi>, tipo = 'mesero', desde?: string) {
  const codigo = await api.post(
    '/api/emparejamientos',
    { pin: api.personas.admin.pin, nombre: 'Celular', tipo },
    desde,
  )
  expect(codigo.statusCode).toBe(201)
  const r = await api.post('/api/emparejar', { codigo: codigo.json().codigo })
  expect(r.statusCode).toBe(201)
  return r.json() as { token: string; dispositivo_id: string }
}

describe('API de acceso', () => {
  it('emparejar, entrar con PIN y cerrar sesión', async () => {
    const api = montarApi()
    const { token } = await emparejarPorApi(api)

    const sesion = await api.post('/api/sesiones', { pin: api.personas.mesero.pin }, token)
    expect(sesion.statusCode).toBe(201)
    expect(sesion.json()).toMatchObject({ usuario: { nombre: 'Ana', rol: 'Mesero' } })
    expect(sesion.json().permisos).toContain('tomar_pedido')

    const { sesion_id, secreto } = sesion.json()
    const cerrar = await api.post('/api/sesiones/cerrar', { sesion_id, secreto }, token)
    expect(cerrar.statusCode).toBe(204)
  })

  it('sin token, o con uno falso, responde 401', async () => {
    const api = montarApi()
    expect((await api.post('/api/sesiones', { pin: '4821' })).statusCode).toBe(401)
    const falso = await api.post('/api/sesiones', { pin: '4821' }, 'inventado')
    expect(falso.statusCode).toBe(401)
    expect(falso.json()).toMatchObject({ error: 'token_invalido' })
  })

  it('PIN errado: 401; tras tres, 429 con Retry-After', async () => {
    const api = montarApi()
    const { token } = await emparejarPorApi(api)
    const r1 = await api.post('/api/sesiones', { pin: '0001' }, token)
    await api.post('/api/sesiones', { pin: '0002' }, token)
    const r3 = await api.post('/api/sesiones', { pin: '0003' }, token)
    const r4 = await api.post('/api/sesiones', { pin: api.personas.mesero.pin }, token)

    expect(r1.statusCode).toBe(401)
    expect(r3.json()).toMatchObject({ error: 'pin_incorrecto', espera_ms: 2000 })
    expect(r4.statusCode).toBe(429)
    expect(r4.headers['retry-after']).toBe('2')
  })

  it('autorización de supervisor y revocación por API', async () => {
    const api = montarApi()
    const caja = await emparejarPorApi(api, 'caja')
    const celular = await emparejarPorApi(api, 'mesero', caja.token)
    const mesero = (
      await api.post('/api/sesiones', { pin: api.personas.mesero.pin }, celular.token)
    ).json()

    const autorizacion = await api.post(
      '/api/autorizaciones',
      {
        sesion_id: mesero.sesion_id,
        secreto: mesero.secreto,
        pin: api.personas.gerente.pin,
        accion: 'anular_item_enviado',
        agregado_id: nuevoId(),
        evento_id: nuevoId(),
        huella: 'b'.repeat(64),
      },
      celular.token,
    )
    expect(autorizacion.statusCode).toBe(201)
    expect(autorizacion.json().supervisor.nombre).toBe('Gloria')

    const admin = (
      await api.post('/api/sesiones', { pin: api.personas.admin.pin }, caja.token)
    ).json()
    const revocar = await api.post(
      `/api/dispositivos/${celular.dispositivo_id}/revocar`,
      { sesion_id: admin.sesion_id, secreto: admin.secreto },
      caja.token,
    )
    expect(revocar.statusCode).toBe(200)
    const despues = await api.post('/api/sesiones', { pin: api.personas.mesero.pin }, celular.token)
    expect(despues.statusCode).toBe(403)
    expect(despues.json()).toMatchObject({ error: 'dispositivo_revocado' })
  })

  it('un cuerpo con formato inesperado responde 400 sin tocar nada', async () => {
    const api = montarApi()
    const r = await api.post('/api/emparejamientos', { pin: 1234, nombre: 'X', tipo: 'caja' })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'datos_invalidos' })
    const extra = await api.post('/api/emparejar', { codigo: 'X', otro: 1 })
    expect(extra.statusCode).toBe(400)
  })
})
