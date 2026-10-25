import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MensajeHub } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { abrirDatos, prepararAcceso, prepararSincronizacion } from './arranque'
import { leerCarta } from './seed/carta'
import { sembrar } from './seed/sembrar'
import { crearServidor } from './servidor'

// Al editar la carta, el hub avisa por WebSocket a los equipos conectados (no a los retirados)
// y ellos vuelven a pedirla. Cableado igual que en `main.ts`.

const CARTA = readFileSync(
  fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)

let carpeta = ''
afterEach(() => rmSync(carpeta, { recursive: true, force: true }))

async function montar() {
  carpeta = mkdtempSync(join(tmpdir(), 'pos-aviso-'))
  const { db } = abrirDatos(carpeta)
  let sala: ReturnType<typeof prepararSincronizacion> | null = null
  const acceso = prepararAcceso(
    db,
    carpeta,
    () => {},
    (id, en) => sala?.revocar(id, en),
  )
  const { pines } = sembrar(
    db,
    acceso.acceso,
    { restauranteId: acceso.restauranteId, roles: acceso.roles, carta: leerCarta(CARTA) },
    new Date().toISOString(),
  )
  sala = prepararSincronizacion(db, carpeta, acceso.restauranteId, acceso.acceso)
  const salaFija = sala
  const app = crearServidor({
    acceso: acceso.acceso,
    sincronizacion: { sala, intervaloLatidoMs: 600_000 },
    catalogo: {
      db,
      restauranteId: acceso.restauranteId,
      acceso: acceso.acceso,
      alCambiar: (version) => salaFija.avisarCatalogo(version),
    },
  })
  await app.ready()
  const post = async (url: string, cuerpo: object, token?: string) =>
    (
      await app.inject({
        method: 'POST',
        url,
        payload: cuerpo,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    ).json()

  let caja: string | undefined
  /**
   * Un equipo como en el restaurante (ADR-013): la caja y el celular entran sin emparejar (el hub
   * los registra); la pantalla de cocina se empareja desde la caja.
   */
  async function equipo(tipo: 'mesero' | 'caja' | 'kds', nombre: string) {
    if (tipo === 'kds') {
      const { codigo } = await post(
        '/api/emparejamientos',
        { pin: acceso.admin.pin, nombre, tipo },
        caja,
      )
      return (await post('/api/emparejar', { codigo })) as { token: string; dispositivo_id: string }
    }
    const r = await post(
      '/api/entrar',
      tipo === 'caja'
        ? { usuario: acceso.admin.usuario, contrasena: acceso.admin.contrasena }
        : { pin: pines.find((p) => p.nombre === 'Mesero 1')?.pin },
    )
    if (tipo === 'caja') caja ??= r.equipo.token
    return { token: r.equipo.token as string, dispositivo_id: r.equipo.dispositivo_id as string }
  }

  async function conectar(token: string | null) {
    const recibidos: MensajeHub[] = []
    const ws: WebSocket = await app.injectWS('/api/sync/ws')
    ws.on('message', (d) => recibidos.push(JSON.parse(d.toString())))
    const enviar = (m: object) => ws.send(JSON.stringify(m))
    if (token) enviar({ tipo: 'hola', token, hub_instancia: null, hasta: 0, version_app: 'prueba' })
    const esperar = (tipo: string) =>
      esperarA(() => recibidos.find((m) => m.tipo === tipo) as MensajeHub)
    /** Un ping a modo de barrera: cuando vuelve el pong, todo lo anterior ya llegó. */
    const barrera = async () => {
      const marca = `b${recibidos.length}`
      enviar({ tipo: 'ping', marca })
      await esperarA(() => recibidos.find((m) => m.tipo === 'pong' && m.marca === marca))
    }
    const catalogos = () => recibidos.filter((m) => m.tipo === 'catalogo')
    return { ws, recibidos, enviar, esperar, barrera, catalogos }
  }

  const admin = async (caja: { token: string }) => {
    const r = await post(
      '/api/entrar',
      { usuario: acceso.admin.usuario, contrasena: acceso.admin.contrasena },
      caja.token,
    )
    return { sesion_id: String(r.sesion_id), secreto: String(r.secreto) }
  }
  const cambiar = async (caja: { token: string }, sesion: object, cambios: unknown[]) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/catalogo/cambios',
      payload: { ...sesion, cambios },
      headers: { authorization: `Bearer ${caja.token}` },
    })
    return { codigo: r.statusCode, cuerpo: r.json() }
  }
  const producto = () => {
    const f = db
      .prepare('SELECT id, precio FROM producto WHERE activo = 1 ORDER BY nombre LIMIT 1')
      .get()
    return { id: String(f?.id), precio: Number(f?.precio) }
  }
  return { app, db, acceso, post, equipo, conectar, admin, cambiar, producto }
}

const esperarA = <T>(fn: () => T | undefined) =>
  vi.waitFor(() => {
    const v = fn()
    if (!v) throw new Error('todavía no')
    return v
  })

describe('aviso de catálogo por WebSocket', () => {
  it('al editar, todos los conectados reciben la versión nueva, también quien editó', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular')
    const cocina = await m.equipo('kds', 'Cocina')
    const [enCaja, enCelular, enCocina] = await Promise.all([
      m.conectar(caja.token),
      m.conectar(celular.token),
      m.conectar(cocina.token),
    ])
    for (const c of [enCaja, enCelular, enCocina]) await c.esperar('bienvenido')

    const sesion = await m.admin(caja)
    const p = m.producto()
    const r = await m.cambiar(caja, sesion, [
      { entidad: 'producto', id: p.id, datos: { precio: p.precio + 1_000 } },
    ])
    expect(r.codigo).toBe(200)

    for (const c of [enCaja, enCelular, enCocina]) {
      await c.barrera()
      expect(c.catalogos()).toEqual([{ tipo: 'catalogo', version: r.cuerpo.version }])
    }
    // Y la carta que piden ya trae esa versión.
    const carta = await m.app.inject({
      method: 'GET',
      url: '/api/catalogo',
      headers: { authorization: `Bearer ${celular.token}` },
    })
    expect(carta.json().version).toBe(r.cuerpo.version)

    for (const c of [enCaja, enCelular, enCocina]) c.ws.terminate()
    await m.app.close()
  })

  it('cada edición manda su propio aviso, en orden y sin repetir versiones', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja')
    const c = await m.conectar(caja.token)
    await c.esperar('bienvenido')
    const sesion = await m.admin(caja)
    const p = m.producto()
    const versiones: number[] = []
    for (let i = 1; i <= 5; i++) {
      const r = await m.cambiar(caja, sesion, [
        { entidad: 'producto', id: p.id, datos: { precio: p.precio + i } },
      ])
      versiones.push(r.cuerpo.version)
    }
    await c.barrera()
    expect(c.catalogos().map((x) => (x as { version: number }).version)).toEqual(versiones)
    expect(new Set(versiones).size).toBe(5)
    c.ws.terminate()
    await m.app.close()
  })

  it('un equipo retirado estando conectado no recibe el aviso, y los demás sí', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular')
    const enCaja = await m.conectar(caja.token)
    const enCelular = await m.conectar(celular.token)
    await enCaja.esperar('bienvenido')
    await enCelular.esperar('bienvenido')
    const sesion = await m.admin(caja)

    const retiro = await m.app.inject({
      method: 'POST',
      url: `/api/dispositivos/${celular.dispositivo_id}/revocar`,
      payload: sesion,
      headers: { authorization: `Bearer ${caja.token}` },
    })
    expect(retiro.statusCode).toBe(200)
    await esperarA(() => enCelular.recibidos.find((x) => x.tipo === 'error'))

    const p = m.producto()
    const r = await m.cambiar(caja, sesion, [
      { entidad: 'producto', id: p.id, datos: { precio: p.precio + 1_000 } },
    ])
    expect(r.codigo).toBe(200)
    await enCaja.barrera()
    await enCelular.barrera()
    expect(enCaja.catalogos()).toHaveLength(1)
    expect(enCelular.catalogos()).toEqual([])

    enCaja.ws.terminate()
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('quien se conecta con un token ya retirado tampoco recibe avisos', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular')
    const sesion = await m.admin(caja)
    await m.app.inject({
      method: 'POST',
      url: `/api/dispositivos/${celular.dispositivo_id}/revocar`,
      payload: sesion,
      headers: { authorization: `Bearer ${caja.token}` },
    })
    const enCelular = await m.conectar(celular.token)
    await enCelular.esperar('bienvenido')
    const p = m.producto()
    await m.cambiar(caja, sesion, [
      { entidad: 'producto', id: p.id, datos: { precio: p.precio + 1_000 } },
    ])
    await enCelular.barrera()
    expect(enCelular.catalogos()).toEqual([])
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('una conexión que no saludó, o con un token inventado, no recibe nada', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja')
    const sinSaludar = await m.conectar(null)
    const inventado = await m.conectar('token-que-no-existe')
    await esperarA(() => inventado.recibidos.find((x) => x.tipo === 'error'))
    const sesion = await m.admin(caja)
    const p = m.producto()
    await m.cambiar(caja, sesion, [
      { entidad: 'producto', id: p.id, datos: { precio: p.precio + 1_000 } },
    ])
    await sinSaludar.barrera()
    await inventado.barrera()
    expect(sinSaludar.catalogos()).toEqual([])
    expect(inventado.catalogos()).toEqual([])
    sinSaludar.ws.terminate()
    inventado.ws.terminate()
    await m.app.close()
  })

  it('una edición rechazada, sin permiso o que no cambia nada no avisa a nadie', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja')
    const c = await m.conectar(caja.token)
    await c.esperar('bienvenido')
    const sesion = await m.admin(caja)
    const p = m.producto()

    // Inválida.
    expect(
      (await m.cambiar(caja, sesion, [{ entidad: 'producto', id: p.id, datos: { precio: -5 } }]))
        .codigo,
    ).toBe(400)
    // Sin sesión válida.
    expect(
      (
        await m.cambiar(caja, { ...sesion, secreto: 'x' }, [
          { entidad: 'producto', id: p.id, datos: { precio: p.precio + 1 } },
        ])
      ).codigo,
    ).toBe(401)
    // El mismo valor que ya tiene.
    const igual = await m.cambiar(caja, sesion, [
      { entidad: 'producto', id: p.id, datos: { precio: p.precio } },
    ])
    expect(igual.codigo).toBe(200)
    expect(igual.cuerpo.cambiados).toBe(0)

    await c.barrera()
    expect(c.catalogos()).toEqual([])
    c.ws.terminate()
    await m.app.close()
  })

  it('una conexión rota en medio no impide que las demás reciban el aviso', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular')
    const enCaja = await m.conectar(caja.token)
    const enCelular = await m.conectar(celular.token)
    await enCaja.esperar('bienvenido')
    await enCelular.esperar('bienvenido')
    // El celular pierde la red (corte sin cierre limpio).
    enCelular.ws.terminate()
    const sesion = await m.admin(caja)
    const p = m.producto()
    const r = await m.cambiar(caja, sesion, [
      { entidad: 'producto', id: p.id, datos: { precio: p.precio + 1_000 } },
    ])
    expect(r.codigo).toBe(200)
    await enCaja.barrera()
    expect(enCaja.catalogos()).toHaveLength(1)
    enCaja.ws.terminate()
    await m.app.close()
  })
})
