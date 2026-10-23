import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import { ARCHIVO_DIAGNOSTICOS } from './diagnostico'
import { crearServidor } from './servidor'

function siguienteMensaje(socket: WebSocket): Promise<string> {
  return new Promise((resolver) => socket.once('message', (datos) => resolver(datos.toString())))
}

describe('diagnóstico del dispositivo', () => {
  let app: ReturnType<typeof crearServidor> | undefined

  afterEach(async () => {
    await app?.close()
  })

  function crear(intervaloLatidoMs = 60_000) {
    const dirDatos = mkdtempSync(join(tmpdir(), 'pos-datos-'))
    app = crearServidor({ diagnostico: { dirDatos, intervaloLatidoMs } })
    return { app, dirDatos }
  }

  it('responde el ping por WebSocket con la misma marca', async () => {
    const { app } = crear()
    await app.ready()
    const socket = await app.injectWS('/api/diagnostico/ws')

    const respuesta = siguienteMensaje(socket)
    socket.send('ping:1234')

    expect(await respuesta).toBe('pong:1234')
    socket.terminate()
  })

  it('envía latidos numerados mientras el socket está abierto', async () => {
    const { app } = crear(10)
    await app.ready()
    const socket = await app.injectWS('/api/diagnostico/ws')

    expect(await siguienteMensaje(socket)).toBe('latido:1')
    expect(await siguienteMensaje(socket)).toBe('latido:2')
    socket.terminate()
  })

  it('guarda cada resultado como una línea JSON con la hora de recepción', async () => {
    const { app, dirDatos } = crear()

    const res = await app.inject({
      method: 'POST',
      url: '/api/diagnostico',
      payload: { dispositivo: 'Pixel 7', contextoSeguro: false },
    })

    expect(res.statusCode).toBe(200)
    const lineas = readFileSync(join(dirDatos, ARCHIVO_DIAGNOSTICOS), 'utf8').trim().split('\n')
    expect(lineas).toHaveLength(1)
    const registro = JSON.parse(lineas[0] ?? '')
    expect(registro.datos).toEqual({ dispositivo: 'Pixel 7', contextoSeguro: false })
    expect(typeof registro.recibidoEn).toBe('string')
  })

  it('rechaza un cuerpo que no es un objeto JSON', async () => {
    const { app } = crear()

    const res = await app.inject({ method: 'POST', url: '/api/diagnostico', payload: [1, 2] })

    expect(res.statusCode).toBe(400)
  })

  it('deja de guardar cuando el archivo llega al límite de tamaño', async () => {
    const dirDatos = mkdtempSync(join(tmpdir(), 'pos-datos-'))
    app = crearServidor({ diagnostico: { dirDatos, limiteBytes: 50 } })
    const enviar = () =>
      app?.inject({ method: 'POST', url: '/api/diagnostico', payload: { relleno: 'x'.repeat(60) } })

    expect((await enviar())?.statusCode).toBe(200)
    expect((await enviar())?.statusCode).toBe(507)
    const lineas = readFileSync(join(dirDatos, ARCHIVO_DIAGNOSTICOS), 'utf8').trim().split('\n')
    expect(lineas).toHaveLength(1)
  })

  it('sin la opción de diagnóstico no expone las rutas', async () => {
    app = crearServidor()

    const res = await app.inject({ method: 'POST', url: '/api/diagnostico', payload: {} })

    expect(res.statusCode).toBe(404)
  })
})
