import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId, signEvent } from '@pos/core'
import type { BaseSqlite } from '@pos/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { abrirDatos, prepararAcceso } from './arranque'
import { leerCarta } from './seed/carta'
import { sembrar } from './seed/sembrar'

// La regla «una mesa con un pedido abierto no se archiva» por la ruta real: el proceso del hub
// (`src/main.ts`, que es quien conecta la sala con la edición del catálogo), un pedido abierto de
// verdad por WebSocket y la edición por HTTP. Sin esto, un cambio en el cableado de `main.ts`
// dejaría la regla muerta sin que ninguna prueba lo note.

const DIR_HUB = fileURLToPath(new URL('..', import.meta.url))
const CARTA = readFileSync(
  fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)

function puertoLibre(): Promise<number> {
  return new Promise((resolver, reject) => {
    const servidor = createServer()
    servidor.once('error', reject)
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address() as { port: number }
      servidor.close(() => resolver(port))
    })
  })
}

interface Arrancado {
  child: ChildProcess
  output: () => string
  detener: () => Promise<void>
}

function arrancar(env: Record<string, string>): Promise<Arrancado> {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/main.ts'],
    { cwd: DIR_HUB, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let text = ''
  const acumular = (chunk: Buffer) => {
    text += String(chunk)
  }
  child.stdout?.on('data', acumular)
  child.stderr?.on('data', acumular)
  const terminado = new Promise<void>((resolver) => child.once('exit', () => resolver()))
  return new Promise((resolver, reject) => {
    const revisar = () => {
      if (!text.includes('Hub en marcha')) return
      child.stdout?.off('data', revisar)
      resolver({
        child,
        output: () => text,
        detener: async () => {
          child.kill('SIGKILL')
          await terminado
        },
      })
    }
    child.stdout?.on('data', revisar)
    child.once('exit', (code) =>
      reject(new Error(`El hub terminó con código ${code} antes de arrancar:\n${text}`)),
    )
  })
}

// biome-ignore lint/suspicious/noExplicitAny: respuestas JSON de la prueba, sin tipar.
type Json = Record<string, any>

/** Un equipo conectado por WebSocket: junta lo que llega y deja esperar un mensaje sin sleeps. */
function conectarWs(url: string, token: string) {
  const ws = new WebSocket(url)
  const recibidos: Json[] = []
  const esperando: { cumple: (m: Json) => boolean; resolver: (m: Json) => void }[] = []
  ws.addEventListener('message', (e) => {
    const message = JSON.parse(String(e.data)) as Json
    recibidos.push(message)
    for (const [i, w] of esperando.entries())
      if (w.cumple(message)) {
        esperando.splice(i, 1)
        w.resolver(message)
        break
      }
  })
  const opened = new Promise<void>((resolver, reject) => {
    ws.addEventListener('open', () => resolver())
    ws.addEventListener('error', () => reject(new Error('No abrió el WebSocket')))
  })
  const esperar = (type: string, cumple: (m: Json) => boolean = () => true) => {
    const already = recibidos.find((m) => m.type === type && cumple(m))
    if (already) return Promise.resolve(already)
    return new Promise<Json>((resolver) =>
      esperando.push({ cumple: (m) => m.type === type && cumple(m), resolver }),
    )
  }
  const send = (m: object) => ws.send(JSON.stringify(m))
  return {
    ws,
    recibidos,
    esperar,
    send,
    async saludar() {
      await opened
      send({ type: 'hello', token, hub_instancia: null, until: 0, version_app: 'prueba' })
      return esperar('welcome')
    },
    close: () => ws.close(),
  }
}

describe('mesa ocupada por la ruta real del hub (main.ts)', () => {
  let carpeta = ''
  let hub: Arrancado | undefined
  const abiertos: { close: () => void }[] = []

  beforeEach(() => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-ocupada-'))
  })
  afterEach(async () => {
    for (const c of abiertos.splice(0)) c.close()
    await hub?.detener()
    hub = undefined
    rmSync(carpeta, { recursive: true, force: true })
  })

  /** Siembra el salón (con personal) y deja la carpeta lista para que arranque el hub. */
  function prepararCarpeta() {
    const dirDatos = join(carpeta, 'data')
    const { db } = abrirDatos(dirDatos)
    const access = prepararAcceso(db, dirDatos)
    const { pins } = sembrar(
      db,
      access.access,
      { restauranteId: access.restauranteId, roles: access.roles, menu: leerCarta(CARTA) },
      new Date().toISOString(),
    )
    ;(db as BaseSqlite & { close(): void }).close()
    /** Con qué entra cada quien: usuario y contraseña si los tiene (ADR-013), si no su PIN. */
    const credencialesDe = (name: string) => {
      if (name === 'Administrador')
        return {
          user: access.admin.user as string,
          password: access.admin.password as string,
        }
      const p = pins.find((x) => x.name === name)
      return p?.user ? { user: p.user, password: p.password as string } : { pin: p?.pin as string }
    }
    return { dirDatos, credencialesDe }
  }

  async function spinUp(dirDatos: string, port: number) {
    hub = await arrancar({
      DATA_DIR: dirDatos,
      DIR_APP: join(carpeta, 'sin-app'),
      PORT: String(port),
    })
  }

  async function scenario() {
    const { dirDatos, credencialesDe } = prepararCarpeta()
    const port = await puertoLibre()
    await spinUp(dirDatos, port)
    const url = `http://127.0.0.1:${port}`
    const post = async (ruta: string, cuerpo: object, token?: string) => {
      const r = await fetch(url + ruta, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(cuerpo),
      })
      return { code: r.status, cuerpo: (await r.json()) as Json }
    }
    const get = async (ruta: string, token: string) =>
      (await (
        await fetch(url + ruta, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as Json

    // Entran sin emparejar (ADR-013): el hub registra cada equipo.
    const emparejar = async (type: 'register' | 'waiter', _nombre: string) => {
      const { cuerpo: r } = await post(
        '/api/sign-in',
        credencialesDe(type === 'register' ? 'Administrador' : 'Mesero 2'),
      )
      return r.device as { token: string; device_id: string }
    }
    const register = await emparejar('register', 'Caja')
    const phone = await emparejar('waiter', 'Celular')
    const session = async (device: { token: string }, name: string) =>
      (await post('/api/sign-in', credencialesDe(name), device.token)).cuerpo as Json
    const manager = await session(register, 'Administrador')
    const waiter = await session(phone, 'Mesero 1')

    const wsUrl = `${url.replace('http', 'ws')}/api/sync/ws`
    const enCelular = conectarWs(wsUrl, phone.token)
    const enCaja = conectarWs(wsUrl, register.token)
    abiertos.push(enCelular, enCaja)
    await enCelular.saludar()
    await enCaja.saludar()

    /** Evento firmado de un equipo; `base` es lo último que ese equipo conoce del hub. */
    const event = (
      quien: { device_id: string },
      s: Json,
      order: string,
      type: string,
      data: object,
      base: number,
    ) => {
      const ahora = new Date().toISOString()
      const e = {
        id: newId(),
        type,
        schema_version: 1,
        aggregate_type: 'order',
        aggregate_id: order,
        related: [],
        data,
        session_id: s.session_id,
        user_id: s.user.id,
        device_id: quien.device_id,
        authorization_id: null,
        reason: type === 'OrderCanceled' || type === 'OrderReopened' ? 'Prueba' : null,
        device_time: ahora,
        hub_estimated_time: ahora,
        base_sequence: base,
      }
      return { ...e, signature: signEvent(e as never, s.secret) }
    }
    const push = async (ws: ReturnType<typeof conectarWs>, e: Json): Promise<Json> => {
      const batch = newId()
      ws.send({ type: 'push', lote_id: batch, events: [e] })
      const r = await ws.esperar('result', (m) => m.lote_id === batch)
      return r.resultados[0]
    }
    const editar = (changes: object[]) =>
      post(
        '/api/catalog/changes',
        { session_id: manager.session_id, secret: manager.secret, changes },
        register.token,
      )
    const catalog = () => get('/api/catalog', register.token)
    const mesaPorNombre = async (name: string) => {
      const c = await catalog()
      const m = (c.tables as Json[]).find((x) => x.name === name)
      if (!m) throw new Error(`No está la mesa ${name}`)
      return m.id as string
    }
    return {
      dirDatos,
      port,
      post,
      register,
      phone,
      manager,
      waiter,
      enCaja,
      enCelular,
      event,
      push,
      editar,
      catalog,
      mesaPorNombre,
      session,
      wsUrl,
    }
  }

  const archive = (id: string) => [{ entity: 'dining_tables', id, data: { active: false } }]

  it('con un pedido abierto por WebSocket la mesa no se archiva; al cerrarlo, sí', async () => {
    const e = await scenario()
    const table = await e.mesaPorNombre('5')
    const order = newId()
    const opened = await e.push(
      e.enCelular,
      e.event(
        e.phone,
        e.waiter,
        order,
        'OrderOpened',
        { channel: 'dine_in', table_id: table, guests: 2 },
        0,
      ),
    )
    expect(opened.status).toBe('confirmed')

    const bloqueado = await e.editar(archive(table))
    expect(bloqueado.code).toBe(400)
    expect(bloqueado.cuerpo.message).toMatch(/la mesa 5 tiene un pedido abierto/)
    expect(((await e.catalog()).tables as Json[]).some((m) => m.id === table)).toBe(true)

    // Archivar una mesa libre junto con la ocupada tampoco pasa: el guardado es todo o nada.
    const another = await e.mesaPorNombre('6')
    const junto = await e.editar([...archive(another), ...archive(table)])
    expect(junto.code).toBe(400)
    expect(((await e.catalog()).tables as Json[]).some((m) => m.id === another)).toBe(true)

    // La caja cierra el pedido (vacío: saldo 0) y entonces la mesa queda libre.
    const closed = await e.push(
      e.enCaja,
      e.event(e.register, e.manager, order, 'OrderClosed', {}, opened.aceptacion.sequence),
    )
    expect(closed.status).toBe('confirmed')
    const free = await e.editar(archive(table))
    expect(free).toMatchObject({ code: 200, cuerpo: { cambiados: 1 } })
    expect(((await e.catalog()).tables as Json[]).some((m) => m.id === table)).toBe(false)
  })

  it('un pedido cancelado también libera la mesa', async () => {
    const e = await scenario()
    const table = await e.mesaPorNombre('8')
    const order = newId()
    const opened = await e.push(
      e.enCelular,
      e.event(
        e.phone,
        e.waiter,
        order,
        'OrderOpened',
        { channel: 'dine_in', table_id: table, guests: 1 },
        0,
      ),
    )
    expect((await e.editar(archive(table))).code).toBe(400)
    const canceled = await e.push(
      e.enCaja,
      e.event(e.register, e.manager, order, 'OrderCanceled', {}, opened.aceptacion.sequence),
    )
    expect(canceled.status).toBe('confirmed')
    expect((await e.editar(archive(table))).code).toBe(200)
  })

  it('al cambiar el pedido de mesa, la vieja se libera y la nueva queda protegida', async () => {
    const e = await scenario()
    const source = await e.mesaPorNombre('1')
    const target = await e.mesaPorNombre('2')
    const order = newId()
    const opened = await e.push(
      e.enCelular,
      e.event(
        e.phone,
        e.waiter,
        order,
        'OrderOpened',
        { channel: 'dine_in', table_id: source, guests: 1 },
        0,
      ),
    )
    const moved = await e.push(
      e.enCelular,
      e.event(
        e.phone,
        e.waiter,
        order,
        'OrderMovedTable',
        { target_table_id: target },
        opened.aceptacion.sequence,
      ),
    )
    expect(moved.status).toBe('confirmed')
    expect((await e.editar(archive(target))).code).toBe(400)
    expect((await e.editar(archive(source))).code).toBe(200)
  })

  it('una edición que sí se aplica avisa por WebSocket a los equipos conectados con la versión nueva', async () => {
    const e = await scenario()
    const table = await e.mesaPorNombre('10')
    const r = await e.editar([{ entity: 'dining_tables', id: table, data: { x: 900 } }])
    expect(r.code).toBe(200)
    const alert = await e.enCelular.esperar('catalog', (m) => m.version === r.cuerpo.version)
    expect(alert.version).toBe(r.cuerpo.version)
    // Una edición rechazada no avisa: el siguiente aviso que llega es el de la edición buena.
    const ocupada = await e.mesaPorNombre('11')
    const order = newId()
    await e.push(
      e.enCelular,
      e.event(
        e.phone,
        e.waiter,
        order,
        'OrderOpened',
        { channel: 'dine_in', table_id: ocupada, guests: 1 },
        0,
      ),
    )
    const before = e.enCelular.recibidos.filter((m) => m.type === 'catalog').length
    expect((await e.editar(archive(ocupada))).code).toBe(400)
    expect(e.enCelular.recibidos.filter((m) => m.type === 'catalog')).toHaveLength(before)
  })

  it('si el hub se apaga y vuelve con el pedido abierto, la mesa sigue protegida', async () => {
    const e = await scenario()
    const table = await e.mesaPorNombre('12')
    const order = newId()
    const opened = await e.push(
      e.enCelular,
      e.event(
        e.phone,
        e.waiter,
        order,
        'OrderOpened',
        { channel: 'dine_in', table_id: table, guests: 3 },
        0,
      ),
    )
    expect(opened.status).toBe('confirmed')
    expect(e.port).toBeGreaterThan(0)

    // Corte: el proceso muere sin avisar y vuelve a arrancar con la misma carpeta de datos.
    for (const c of abiertos.splice(0)) c.close()
    await hub?.detener()
    hub = undefined
    await spinUp(e.dirDatos, e.port)

    // Los equipos siguen emparejados y con su sesión: el hub guarda ambos.
    const r = await e.editar(archive(table))
    expect(r.code).toBe(400)
    expect(r.cuerpo.message).toMatch(/tiene un pedido abierto/)
  })
})
