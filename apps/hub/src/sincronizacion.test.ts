import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { firmarEvento, nuevoId } from '@pos/core'
import type { MensajeHub, SalaSync } from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { abrirDatos, instanciaDelHub, prepararAcceso, prepararSincronizacion } from './arranque'
import { leerCarta } from './seed/carta'
import { sembrar } from './seed/sembrar'
import { crearServidor } from './servidor'

// La 0.10 de punta a punta en el hub: emparejar, entrar con PIN, empujar un evento firmado por el
// WebSocket y que otro equipo lo reciba. Con la carta del piloto sembrada.

const CARTA = readFileSync(
  fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)

let carpeta = ''
afterEach(() => rmSync(carpeta, { recursive: true, force: true }))

async function montar(
  opciones: { esperaSaludoMs?: number; alFallo?: (error: unknown) => void } = {},
) {
  carpeta = mkdtempSync(join(tmpdir(), 'pos-sync-'))
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
  const app = crearServidor({
    acceso: acceso.acceso,
    sincronizacion: { sala, intervaloLatidoMs: 60_000, ...opciones },
    catalogo: { db, restauranteId: acceso.restauranteId, acceso: acceso.acceso },
  })
  await app.ready()
  /** Con qué entra cada quien: usuario y contraseña si los tiene (ADR-013), si no su PIN. */
  const credencialesDe = (nombre: string) => {
    if (nombre === 'Administrador')
      return {
        usuario: acceso.admin.usuario as string,
        contrasena: acceso.admin.contrasena as string,
      }
    const p = pines.find((x) => x.nombre === nombre)
    return p?.usuario
      ? { usuario: p.usuario, contrasena: p.contrasena as string }
      : { pin: p?.pin as string }
  }
  const post = async (url: string, cuerpo: object, token?: string) =>
    (
      await app.inject({
        method: 'POST',
        url,
        payload: cuerpo,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    ).json()

  /**
   * Un equipo como en el restaurante (ADR-013): entra sin emparejar y el hub lo registra. La caja
   * entra con la contraseña del administrador; el celular, con el PIN de un mesero.
   */
  async function equipo(tipo: 'mesero' | 'caja', _nombre: string) {
    const r = await post(
      '/api/entrar',
      credencialesDe(tipo === 'caja' ? 'Administrador' : 'Mesero 2'),
    )
    return { token: r.equipo.token as string, dispositivo_id: r.equipo.dispositivo_id as string }
  }

  /** Abre el WebSocket y junta lo que llega. */
  async function conectar(token: string) {
    const recibidos: MensajeHub[] = []
    const ws: WebSocket = await app.injectWS('/api/sync/ws')
    ws.on('message', (d) => recibidos.push(JSON.parse(d.toString())))
    const enviar = (m: object) => ws.send(JSON.stringify(m))
    enviar({ tipo: 'hola', token, hub_instancia: null, hasta: 0, version_app: 'prueba' })
    const esperar = async (tipo: string) => {
      for (let i = 0; i < 100 && !recibidos.some((m) => m.tipo === tipo); i++)
        await new Promise((r) => setTimeout(r, 10))
      return recibidos.find((m) => m.tipo === tipo)
    }
    return { ws, recibidos, enviar, esperar }
  }

  return { app, db, acceso, credencialesDe, post, equipo, conectar }
}

describe('WebSocket de sincronización', () => {
  it('un pedido firmado de un mesero llega confirmado y el otro equipo lo recibe', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular Ana')
    const sesion = await m.post('/api/entrar', m.credencialesDe('Mesero 1'), celular.token)

    const enCaja = await m.conectar(caja.token)
    const enCelular = await m.conectar(celular.token)
    const bienvenido = await enCelular.esperar('bienvenido')
    expect(bienvenido).toMatchObject({ tipo: 'bienvenido', secuencia_max: 0 })
    expect(typeof (bienvenido as { hub_instancia: string }).hub_instancia).toBe('string')

    const ahora = new Date().toISOString()
    const evento = {
      id: nuevoId(),
      tipo: 'PedidoAbierto',
      version_esquema: 1,
      agregado_tipo: 'pedido',
      agregado_id: nuevoId(),
      relacionados: [],
      datos: { canal: 'salon', mesa_id: null, comensales: 2 },
      sesion_id: sesion.sesion_id,
      usuario_id: sesion.usuario.id,
      dispositivo_id: celular.dispositivo_id,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: ahora,
      hora_estimada_hub: ahora,
      secuencia_base: 0,
    }
    const firmado = { ...evento, firma: firmarEvento(evento as never, sesion.secreto) }
    enCelular.enviar({ tipo: 'empujar', lote_id: 'l1', eventos: [firmado] })

    const resultado = await enCelular.esperar('resultado')
    expect(resultado).toMatchObject({
      lote_id: 'l1',
      resultados: [{ id: evento.id, estado: 'confirmado' }],
    })
    const nuevo = await enCaja.esperar('nuevo')
    expect(nuevo).toMatchObject({ evento: { id: evento.id, secuencia: 1, sesion_id: null } })

    enCaja.ws.terminate()
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('lo que no es JSON o no es un mensaje se responde con error sin cortar', async () => {
    const m = await montar()
    const equipo = await m.equipo('caja', 'Caja')
    const c = await m.conectar(equipo.token)
    await c.esperar('bienvenido')
    c.ws.send('esto no es json')
    const error = await c.esperar('error')
    expect(error).toMatchObject({ codigo: 'mensaje_invalido' })
    c.enviar({ tipo: 'ping', marca: 'x' })
    expect(await c.esperar('pong')).toMatchObject({ marca: 'x' })
    c.ws.terminate()
    await m.app.close()
  })
})

describe('catálogo para los equipos', () => {
  it('entrega mesas, estaciones y la carta sembrada, solo con token', async () => {
    const m = await montar()
    const equipo = await m.equipo('mesero', 'Celular')
    const sin = await m.app.inject({ method: 'GET', url: '/api/catalogo' })
    expect(sin.statusCode).toBe(401)

    const r = await m.app.inject({
      method: 'GET',
      url: '/api/catalogo',
      headers: { authorization: `Bearer ${equipo.token}` },
    })
    const catalogo = r.json()
    expect(catalogo.mesas).toHaveLength(25)
    expect(catalogo.estaciones.map((e: { nombre: string }) => e.nombre)).toEqual([
      'Cocina',
      'Barra',
    ])
    const productos = catalogo.categorias.flatMap((c: { productos: unknown[] }) => c.productos)
    expect(productos).toHaveLength(98)
    const vino = productos.find((p: { nombre: string }) => p.nombre === 'Ramón Bilbao Crianza')
    expect(vino.variantes.map((v: { nombre: string }) => v.nombre)).toEqual(['Copa', 'Botella'])
    expect(vino.impuesto).toEqual({ tipo: 'inc', tarifa: 800 })
    expect(catalogo.version).toBeGreaterThan(0)
    await m.app.close()
  })
})

describe('instancia del hub', () => {
  it('se crea una vez y se mantiene', () => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-instancia-'))
    const a = instanciaDelHub(carpeta)
    expect(instanciaDelHub(carpeta)).toBe(a)
  })
})

// ── Fallas del WebSocket ─────────────────────────────────────────────────────────────────────

/** Espera a que el socket se cierre y devuelve el código con que lo cerró el hub. */
const cierre = (ws: WebSocket) =>
  new Promise<number>((resolver) => ws.once('close', (codigo) => resolver(codigo)))

function eventoPedido(
  sesion: { sesion_id: string; secreto: string; usuario: { id: string } },
  dispositivoId: string,
) {
  const ahora = new Date().toISOString()
  const evento = {
    id: nuevoId(),
    tipo: 'PedidoAbierto',
    version_esquema: 1,
    agregado_tipo: 'pedido',
    agregado_id: nuevoId(),
    relacionados: [],
    datos: { canal: 'salon', mesa_id: null, comensales: 1 },
    sesion_id: sesion.sesion_id,
    usuario_id: sesion.usuario.id,
    dispositivo_id: dispositivoId,
    autorizacion_id: null,
    motivo: null,
    hora_dispositivo: ahora,
    hora_estimada_hub: ahora,
    secuencia_base: 0,
  }
  return { ...evento, firma: firmarEvento(evento as never, sesion.secreto) }
}

describe('WebSocket: mensajes enormes', () => {
  it('un mensaje de más de 1 MB cierra esa conexión (1009) y el hub sigue atendiendo a los demás', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular')
    const malo = await m.conectar(celular.token)
    await malo.esperar('bienvenido')
    const cerrado = cierre(malo.ws)
    malo.ws.send(JSON.stringify({ tipo: 'ping', marca: 'x'.repeat(1024 * 1024 + 1) }))
    expect(await cerrado).toBe(1009)

    const otro = await m.conectar(caja.token)
    expect(await otro.esperar('bienvenido')).toBeDefined()
    otro.enviar({ tipo: 'ping', marca: 'vivo' })
    expect(await otro.esperar('pong')).toMatchObject({ marca: 'vivo' })
    otro.ws.terminate()
    await m.app.close()
  })

  it('un mensaje grande pero bajo el límite se responde con error y no corta la conexión', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja')
    const c = await m.conectar(caja.token)
    await c.esperar('bienvenido')
    c.ws.send(JSON.stringify({ tipo: 'ping', marca: 'x'.repeat(900 * 1024) }))
    expect(await c.esperar('error')).toMatchObject({ codigo: 'mensaje_invalido' })
    c.enviar({ tipo: 'ping', marca: 'sigue' })
    expect(await c.esperar('pong')).toMatchObject({ marca: 'sigue' })
    c.ws.terminate()
    await m.app.close()
  })

  it('un lote de más de 100 eventos se responde con error de formato', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja')
    const c = await m.conectar(caja.token)
    await c.esperar('bienvenido')
    c.enviar({ tipo: 'empujar', lote_id: 'l', eventos: Array.from({ length: 101 }, () => ({})) })
    expect(await c.esperar('error')).toMatchObject({ codigo: 'mensaje_invalido' })
    c.ws.terminate()
    await m.app.close()
  })
})

describe('WebSocket: el socket se cierra a mitad', () => {
  it('si el dispositivo se corta justo tras empujar, el evento queda guardado y al reenviar no se duplica', async () => {
    const fallos: unknown[] = []
    const m = await montar({ alFallo: (e) => fallos.push(e) })
    const caja = await m.equipo('caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular')
    const sesion = await m.post('/api/entrar', m.credencialesDe('Mesero 1'), celular.token)
    const evento = eventoPedido(sesion, celular.dispositivo_id)

    const primero = await m.conectar(celular.token)
    await primero.esperar('bienvenido')
    primero.enviar({ tipo: 'empujar', lote_id: 'a', eventos: [evento] })
    const cerrado = cierre(primero.ws)
    primero.ws.terminate() // sin respuesta: el celular perdió la señal
    await cerrado

    // Reconecta y reenvía el mismo lote: el hub reconoce el evento, no lo guarda dos veces.
    const segundo = await m.conectar(celular.token)
    await segundo.esperar('bienvenido')
    segundo.enviar({ tipo: 'empujar', lote_id: 'b', eventos: [evento] })
    expect(await segundo.esperar('resultado')).toMatchObject({
      lote_id: 'b',
      resultados: [{ id: evento.id, estado: 'confirmado' }],
    })

    const enCaja = await m.conectar(caja.token)
    await enCaja.esperar('bienvenido')
    enCaja.enviar({ tipo: 'traer', desde: 0 })
    const traido = await enCaja.esperar('eventos')
    expect(traido).toMatchObject({ hasta: 1, hay_mas: false })
    expect((traido as { eventos: unknown[] }).eventos).toHaveLength(1)
    expect(fallos).toEqual([])

    segundo.ws.terminate()
    enCaja.ws.terminate()
    await m.app.close()
  })

  it('un equipo que se fue sin avisar no estorba al difundir lo que hace otro', async () => {
    const fallos: unknown[] = []
    const m = await montar({ alFallo: (e) => fallos.push(e) })
    const caja = await m.equipo('caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular')
    const sesion = await m.post('/api/entrar', m.credencialesDe('Mesero 1'), celular.token)

    const enCaja = await m.conectar(caja.token)
    await enCaja.esperar('bienvenido')
    const cerrado = cierre(enCaja.ws)
    enCaja.ws.terminate()
    await cerrado

    const enCelular = await m.conectar(celular.token)
    await enCelular.esperar('bienvenido')
    const evento = eventoPedido(sesion, celular.dispositivo_id)
    enCelular.enviar({ tipo: 'empujar', lote_id: 'l', eventos: [evento] })
    expect(await enCelular.esperar('resultado')).toMatchObject({
      resultados: [{ id: evento.id, estado: 'confirmado' }],
    })
    expect(fallos).toEqual([])
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('si el hub falla al procesar un mensaje, corta esa conexión (1011) y lo registra', async () => {
    const falla = new Error('el almacén no responde')
    const sala = {
      conectar: () => ({
        recibir: () => {
          throw falla
        },
        cerrar: vi.fn(),
      }),
      latir: () => {},
    } as unknown as SalaSync
    const fallos: unknown[] = []
    const app = crearServidor({ sincronizacion: { sala, alFallo: (e) => fallos.push(e) } })
    await app.ready()
    const ws: WebSocket = await app.injectWS('/api/sync/ws')
    const cerrado = cierre(ws)
    ws.send(JSON.stringify({ tipo: 'ping', marca: 'x' }))
    expect(await cerrado).toBe(1011)
    expect(fallos).toEqual([falla])
    await app.close()
  })

  it('una conexión que nunca saluda se cierra (1008) y se libera su lugar en la sala', async () => {
    const cerrar = vi.fn()
    const sala = {
      conectar: () => ({ recibir: () => {}, cerrar }),
      latir: () => {},
    } as unknown as SalaSync
    const app = crearServidor({ sincronizacion: { sala, esperaSaludoMs: 20 } })
    // Con un cliente real (el de `injectWS` deja el cierre a medias y el hub no ve el 'close').
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${port}/api/sync/ws`)
    const codigo = await new Promise<number>((resolver) =>
      ws.addEventListener('close', (e) => resolver(e.code)),
    )
    expect(codigo).toBe(1008)
    await vi.waitFor(() => expect(cerrar).toHaveBeenCalledTimes(1))
    await app.close()
  })
})

describe('WebSocket: token revocado con el equipo conectado', () => {
  it('avisa al equipo retirado, deja de mandarle el salón y lo que haga después no entra', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular')
    const admin = await m.post(
      '/api/entrar',
      { usuario: m.acceso.admin.usuario, contrasena: m.acceso.admin.contrasena },
      caja.token,
    )
    expect(admin.sesion_id).toBeDefined()
    const sesionMesero = await m.post('/api/entrar', m.credencialesDe('Mesero 1'), celular.token)

    const enCaja = await m.conectar(caja.token)
    const enCelular = await m.conectar(celular.token)
    await enCaja.esperar('bienvenido')
    await enCelular.esperar('bienvenido')

    // Estando conectado, la caja retira el celular.
    const r = await m.app.inject({
      method: 'POST',
      url: `/api/dispositivos/${celular.dispositivo_id}/revocar`,
      payload: { sesion_id: admin.sesion_id, secreto: admin.secreto },
      headers: { authorization: `Bearer ${caja.token}` },
    })
    expect(r.statusCode).toBe(200)
    expect(await enCelular.esperar('error')).toMatchObject({ codigo: 'token_revocado' })

    // Ya no lee el salón: ni lo nuevo ni lo que pide con `traer`.
    const delCaja = eventoPedido(admin, caja.dispositivo_id)
    enCaja.enviar({ tipo: 'empujar', lote_id: 'c', eventos: [delCaja] })
    await enCaja.esperar('resultado')
    enCelular.enviar({ tipo: 'traer', desde: 0 })
    await vi.waitFor(() =>
      expect(enCelular.recibidos.filter((x) => x.tipo === 'error')).toHaveLength(2),
    )
    expect(enCelular.recibidos.filter((x) => x.tipo === 'error')).toHaveLength(2)
    expect(enCelular.recibidos.some((x) => x.tipo === 'nuevo' || x.tipo === 'eventos')).toBe(false)

    // Lo que intente entregar después de la revocación no entra al salón.
    const tarde = eventoPedido(sesionMesero, celular.dispositivo_id)
    enCelular.enviar({ tipo: 'empujar', lote_id: 't', eventos: [tarde] })
    const resultado = await enCelular.esperar('resultado')
    expect(resultado).toMatchObject({ resultados: [{ id: tarde.id }] })
    expect((resultado as { resultados: { estado: string }[] }).resultados[0]?.estado).not.toBe(
      'confirmado',
    )
    expect(enCaja.recibidos.some((x) => x.tipo === 'nuevo' && x.evento.id === tarde.id)).toBe(false)

    enCaja.ws.terminate()
    enCelular.ws.terminate()
    await m.app.close()
  })

  it('con un token que ya estaba revocado al conectar no se le entrega el salón', async () => {
    const m = await montar()
    const caja = await m.equipo('caja', 'Caja')
    const celular = await m.equipo('mesero', 'Celular')
    const admin = await m.post(
      '/api/entrar',
      { usuario: m.acceso.admin.usuario, contrasena: m.acceso.admin.contrasena },
      caja.token,
    )
    await m.app.inject({
      method: 'POST',
      url: `/api/dispositivos/${celular.dispositivo_id}/revocar`,
      payload: { sesion_id: admin.sesion_id, secreto: admin.secreto },
      headers: { authorization: `Bearer ${caja.token}` },
    })
    const c = await m.conectar(celular.token)
    await c.esperar('bienvenido')
    c.enviar({ tipo: 'traer', desde: 0 })
    expect(await c.esperar('error')).toMatchObject({ codigo: 'token_revocado' })
    expect(c.recibidos.some((x) => x.tipo === 'eventos')).toBe(false)
    c.ws.terminate()
    await m.app.close()
  })
})
