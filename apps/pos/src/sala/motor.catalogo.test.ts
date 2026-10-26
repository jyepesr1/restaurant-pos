import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import {
  type Catalog,
  type Channel,
  FloorSync,
  type Handlers,
  HubSync,
  MemoryStore,
} from '@pos/sync'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Device, Sala, type Session } from './motor'
import { catalogoDePrueba } from './pruebas'

// La carta se vuelve a pedir cuando el hub avisa que cambió (mensaje `catalogo`) y al reconectar;
// una respuesta rara, vieja o fallida nunca reemplaza la carta buena guardada. Hub en memoria,
// HTTP simulado: sin esperas fijas ni red real.

const TOKEN = 'token-del-equipo'

interface Call {
  httpMethod: string
  route: string
  token: string | null
  body: unknown
  responder: (r: Response | Error) => void
  respondida?: boolean
}

/** HTTP simulado: cada llamada queda pendiente hasta que la prueba decide qué responde. */
function montarHttp() {
  const calls: Call[] = []
  const fetchFalso = vi.fn((route: string, init: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const headers = (init.headers ?? {}) as Record<string, string>
      calls.push({
        httpMethod: String(init.method),
        route,
        token: headers.authorization?.replace('Bearer ', '') ?? null,
        body: init.body ? JSON.parse(String(init.body)) : null,
        responder: (r) => (r instanceof Error ? reject(r) : resolve(r)),
      })
    })
  })
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  return {
    calls,
    fetchFalso,
    json,
    cartas: () => calls.filter((l) => l.httpMethod === 'GET' && l.route === '/api/catalog'),
    /** Responde todas las peticiones de carta que estén pendientes con esa versión. */
    responderCartas(version: number) {
      const pendingList = this.cartas().filter((l) => !l.respondida)
      for (const l of pendingList) {
        l.respondida = true
        l.responder(json(catalogoDePrueba({ version })))
      }
    },
  }
}
const sinAcceso = {
  verify: () => ({ ok: true as const, authorizedById: null, authorizationId: null }),
  recordUse: () => {},
}

function setupHub() {
  const device: Device = { deviceId: newId(), token: TOKEN, name: 'Ana', type: 'waiter' }
  const hub = new HubSync(new MemoryStore(), {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-test',
    clock: () => new Date().toISOString(),
    access: sinAcceso,
  })
  let revokedAt: string | null = null
  const salaHub = new FloorSync(hub, (token) =>
    token === TOKEN ? { deviceId: device.deviceId, type: 'waiter', revokedAt } : null,
  )
  const h = {
    device,
    salaHub,
    down: false,
    revoke: () => {
      revokedAt = new Date().toISOString()
      salaHub.revoke(device.deviceId, revokedAt)
    },
    cut: [] as (() => void)[],
    open(m: Handlers): Channel {
      let link: ReturnType<FloorSync['connect']> | null = null
      let closed = false
      const cut = () => {
        if (closed) return
        closed = true
        link?.close()
        link = null
        m.onClose()
      }
      h.cut.push(cut)
      setTimeout(() => {
        if (closed) return
        if (h.down) return cut()
        link = salaHub.connect((msg) => {
          const copy = JSON.parse(JSON.stringify(msg))
          setTimeout(() => {
            if (!closed) m.onMessage(copy)
          })
        })
        m.onOpen()
      })
      return {
        send: (msg) => link?.receive(JSON.parse(JSON.stringify(msg))),
        close: () => {
          closed = true
          link?.close()
          link = null
        },
      }
    },
  }
  return h
}

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
let http: ReturnType<typeof montarHttp>

beforeEach(() => {
  http = montarHttp()
  vi.stubGlobal('fetch', http.fetchFalso)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  // Que terminen los trabajos de fondo antes de borrar la base.
  await vi.waitFor(() => {}, { timeout: 50 })
  for (const l of http.calls as Call[])
    if (!l.respondida) {
      l.respondida = true
      l.responder(new Error('fin de la prueba'))
    }
  await new Promise((r) => setTimeout(r, 20))
  for (const b of bases.splice(0)) await b.delete()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function device(
  h: ReturnType<typeof setupHub>,
  o: { session?: boolean; version?: number } = {},
) {
  const db = new BaseDispositivo(`catalog-${newId()}`)
  bases.push(db)
  await db.saveSetting('device', h.device)
  if (o.session !== false) {
    const sessionId = newId()
    const session: Session = {
      sessionId,
      secret: `secreto-${sessionId}`,
      user: { id: newId(), name: 'Ana', role: 'Gerente' },
      permissions: ['edit_catalog'],
      lastUsed: Date.now(),
    }
    await db.saveSetting('session', session)
  }
  await db.saveSetting('catalog', catalogoDePrueba({ version: o.version ?? 4 }))
  const floor = new Sala({ db, open: (m) => h.open(m) })
  salas.push(floor)
  await floor.load()
  return { floor, db }
}

const conectada = (s: Sala) => s.instantanea().connection === 'connected'
const versionOf = (s: Sala) => s.instantanea().catalog?.version
const saved = async (db: BaseDispositivo) => (await db.leerAjuste<Catalog>('catalog'))?.version

/** Espera a que haya `n` peticiones de carta, sin reloj: se reintenta hasta que se cumpla. */
const cartas = (n: number) =>
  vi.waitFor(() => expect(http.cartas().length).toBeGreaterThanOrEqual(n))

/** Deja que lo que ya llegó termine de procesarse: manda un ping y espera el pong. */
async function asentar(s: Sala) {
  const before = s.instantanea().changes
  await vi.waitFor(() => expect(s.instantanea().changes).toBeGreaterThanOrEqual(before))
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('el hub avisa que la carta cambió', () => {
  it('el equipo la vuelve a pedir con su token, la guarda y la muestra', async () => {
    const h = setupHub()
    const { floor, db } = await device(h)
    await vi.waitFor(() => expect(conectada(floor)).toBe(true))
    // Al conectar, pide la carta una vez; se responde con la misma versión que ya tenía.
    await cartas(1)
    http.responderCartas(4)
    await asentar(floor)
    const pedidas = http.cartas().length

    h.salaHub.notifyCatalog(9)
    await cartas(pedidas + 1)
    const peticion = http.cartas().at(-1)
    expect(peticion?.token).toBe(TOKEN)
    http.responderCartas(9)

    await vi.waitFor(() => expect(versionOf(floor)).toBe(9))
    await vi.waitFor(async () => expect(await saved(db)).toBe(9))
  })

  it('un aviso con la versión que ya tiene no pide nada', async () => {
    const h = setupHub()
    const { floor } = await device(h, { version: 7 })
    await vi.waitFor(() => expect(conectada(floor)).toBe(true))
    await cartas(1)
    http.responderCartas(7)
    await asentar(floor)
    const pedidas = http.cartas().length
    h.salaHub.notifyCatalog(7)
    await asentar(floor)
    // Un mensaje posterior sí llega: demuestra que el anterior ya se procesó.
    h.salaHub.notifyCatalog(8)
    await cartas(pedidas + 1)
    expect(http.cartas()).toHaveLength(pedidas + 1)
  })

  it('sin sesión abierta no pide la carta (el hub la exige con un equipo, no con una sesión, pero no hay quién la use)', async () => {
    const h = setupHub()
    const { floor } = await device(h, { session: false })
    await vi.waitFor(() => expect(conectada(floor)).toBe(true))
    await asentar(floor)
    h.salaHub.notifyCatalog(9)
    await asentar(floor)
    expect(http.cartas()).toHaveLength(0)
    expect(versionOf(floor)).toBe(4)
  })

  it('el aviso no cuenta como cambio de datos ni deja nada pendiente', async () => {
    const h = setupHub()
    const { floor } = await device(h)
    await vi.waitFor(() => expect(conectada(floor)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(floor)
    const before = floor.instantanea()
    h.salaHub.notifyCatalog(10)
    await cartas(2)
    http.responderCartas(10)
    await vi.waitFor(() => expect(versionOf(floor)).toBe(10))
    expect(floor.instantanea().pendingList).toBe(before.pendingList)
    expect(floor.instantanea().changes).toBe(before.changes)
  })

  it('sin red al pedirla: se queda la carta guardada y no se rompe nada', async () => {
    const h = setupHub()
    const { floor, db } = await device(h)
    await vi.waitFor(() => expect(conectada(floor)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(floor)
    const pedidas = http.cartas().length

    h.salaHub.notifyCatalog(9)
    await cartas(pedidas + 1)
    ;(http.calls.at(-1) as Call).respondida = true
    http.calls.at(-1)?.responder(new TypeError('Failed to fetch'))
    await asentar(floor)

    expect(versionOf(floor)).toBe(4)
    expect(await saved(db)).toBe(4)
    expect(floor.instantanea().connection).toBe('connected')
  })

  it.each([
    ['sin cuerpo (204)', () => new Response(null, { status: 204 })],
    ['un objeto vacío', () => http.json({})],
    ['una lista', () => http.json([])],
    ['sin mesas', () => http.json({ version: 99 })],
    ['con la versión como texto', () => http.json({ version: '99', tables: [] })],
    ['una página de error HTML', () => new Response('<html>502</html>', { status: 502 })],
    ['un 401 del hub', () => http.json({ error: 'invalid_token', message: 'x' }, 401)],
    ['un JSON roto', () => new Response('{roto', { status: 200 })],
  ])('si el hub responde %s, no reemplaza la carta buena', async (_case, response) => {
    const h = setupHub()
    const { floor, db } = await device(h)
    await vi.waitFor(() => expect(conectada(floor)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(floor)
    const pedidas = http.cartas().length

    h.salaHub.notifyCatalog(9)
    await cartas(pedidas + 1)
    ;(http.calls.at(-1) as Call).respondida = true
    http.calls.at(-1)?.responder(response())
    await asentar(floor)

    expect(versionOf(floor)).toBe(4)
    expect(floor.instantanea().catalog?.categories).toEqual([])
    expect(await saved(db)).toBe(4)
  })

  it('dos avisos seguidos y las respuestas en desorden: queda la versión más nueva', async () => {
    const h = setupHub()
    const { floor, db } = await device(h)
    await vi.waitFor(() => expect(conectada(floor)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(floor)
    const pedidas = http.cartas().length

    h.salaHub.notifyCatalog(8)
    await cartas(pedidas + 1)
    h.salaHub.notifyCatalog(9)
    await cartas(pedidas + 2)
    const [first, second] = http.cartas().slice(pedidas) as Call[]
    if (!first || !second) throw new Error('faltan peticiones')
    // La segunda (versión 9) llega antes que la primera (versión 8).
    second.respondida = true
    second.responder(http.json(catalogoDePrueba({ version: 9 })))
    await vi.waitFor(() => expect(versionOf(floor)).toBe(9))
    first.respondida = true
    first.responder(http.json(catalogoDePrueba({ version: 8 })))
    await asentar(floor)

    expect(versionOf(floor)).toBe(9)
    await vi.waitFor(async () => expect(await saved(db)).toBe(9))
  })

  it('avisos repetidos o fuera de orden: cada respuesta trae lo último y queda esa versión', async () => {
    const h = setupHub()
    const { floor } = await device(h)
    await vi.waitFor(() => expect(conectada(floor)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(floor)
    const pedidas = http.cartas().length

    // Los avisos 12, 11 y 10 llegan en ese orden; 12 repetido no pide de nuevo.
    for (const v of [12, 12, 11, 10]) h.salaHub.notifyCatalog(v)
    await vi.waitFor(() => expect(http.cartas().length).toBeGreaterThan(pedidas))
    // El hub contesta siempre con lo último que tiene, sea cual sea el aviso.
    await vi.waitFor(() => {
      http.responderCartas(12)
      expect(versionOf(floor)).toBe(12)
    })
    await asentar(floor)
    http.responderCartas(12)
    expect(versionOf(floor)).toBe(12)
  })

  it('al reconectar tras un corte pide la carta por si cambió mientras no había red', async () => {
    const h = setupHub()
    const { floor } = await device(h)
    await vi.waitFor(() => expect(conectada(floor)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(floor)

    floor.simularSinConexion(true)
    await vi.waitFor(() => expect(floor.instantanea().connection).toBe('disconnected'))
    const pedidas = http.cartas().length
    floor.simularSinConexion(false)
    await vi.waitFor(() => expect(conectada(floor)).toBe(true))
    await cartas(pedidas + 1)
    http.responderCartas(15)
    await vi.waitFor(() => expect(versionOf(floor)).toBe(15))
  })

  it('con el equipo retirado el hub ya no le manda avisos', async () => {
    const h = setupHub()
    const { floor } = await device(h)
    await vi.waitFor(() => expect(conectada(floor)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(floor)
    const pedidas = http.cartas().length
    h.revoke()
    await vi.waitFor(() => expect(floor.instantanea().errorHub?.code).toBe('revoked_token'))
    h.salaHub.notifyCatalog(9)
    await asentar(floor)
    expect(http.cartas()).toHaveLength(pedidas)
  })
})

describe('editar la carta desde la app', () => {
  async function ready() {
    const h = setupHub()
    const e = await device(h)
    await vi.waitFor(() => expect(conectada(e.floor)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(e.floor)
    return { h, ...e }
  }
  const change = {
    entity: 'products' as const,
    id: newId(),
    data: { price: 1_000 },
  }

  it('manda la sesión y los cambios, y trae la carta nueva al terminar', async () => {
    const { floor } = await ready()
    const session = floor.instantanea().session as Session
    const pedidas = http.cartas().length
    const save = floor.editarCatalogo([change])

    await vi.waitFor(() =>
      expect(http.calls.some((l) => l.route === '/api/catalog/changes')).toBe(true),
    )
    const post = http.calls.find((l) => l.route === '/api/catalog/changes') as Call
    expect(post.httpMethod).toBe('POST')
    expect(post.token).toBe(TOKEN)
    expect(post.body).toEqual({
      session_id: session.sessionId,
      secret: session.secret,
      changes: [change],
    })
    post.respondida = true
    post.responder(http.json({ version: 20, changedCount: 1 }))

    await cartas(pedidas + 1)
    http.responderCartas(20)
    await expect(save).resolves.toBe(20)
    expect(versionOf(floor)).toBe(20)
  })

  it('si el hub rechaza (400), el error llega con su mensaje y no pide la carta', async () => {
    const { floor } = await ready()
    const pedidas = http.cartas().length
    const save = floor.editarCatalogo([change])
    const result = save.then(
      () => null,
      (e: unknown) => e,
    )
    await vi.waitFor(() =>
      expect(http.calls.some((l) => l.route === '/api/catalog/changes')).toBe(true),
    )
    const post = http.calls.find((l) => l.route === '/api/catalog/changes') as Call
    post.respondida = true
    post.responder(
      http.json({ error: 'invalid_data', message: 'Cambio 1 (producto): precio mal' }, 400),
    )
    expect(await result).toMatchObject({
      code: 'invalid_data',
      message: 'Cambio 1 (producto): precio mal',
    })
    expect(http.cartas()).toHaveLength(pedidas)
    expect(versionOf(floor)).toBe(4)
  })

  it('sin red el cambio falla con aviso claro y no se da por hecho', async () => {
    const { floor } = await ready()
    const save = floor.editarCatalogo([change])
    await vi.waitFor(() =>
      expect(http.calls.some((l) => l.route === '/api/catalog/changes')).toBe(true),
    )
    const post = http.calls.find((l) => l.route === '/api/catalog/changes') as Call
    post.respondida = true
    post.responder(new TypeError('Failed to fetch'))
    await expect(save).rejects.toMatchObject({ code: 'offline' })
    expect(versionOf(floor)).toBe(4)
  })

  it('con la conexión simulada apagada no sale ninguna petición', async () => {
    const { floor } = await ready()
    floor.simularSinConexion(true)
    const before = http.calls.length
    await expect(floor.editarCatalogo([change])).rejects.toMatchObject({ code: 'offline' })
    expect(http.calls).toHaveLength(before)
  })

  it('sin sesión no se manda nada', async () => {
    const h = setupHub()
    const { floor } = await device(h, { session: false })
    await vi.waitFor(() => expect(conectada(floor)).toBe(true))
    await expect(floor.editarCatalogo([change])).rejects.toThrow('Sin sesión')
    expect(http.calls.some((l) => l.route === '/api/catalog/changes')).toBe(false)
  })

  it('si guardó pero la carta nueva no llega, el guardado cuenta y la carta vieja se queda', async () => {
    const { floor } = await ready()
    const pedidas = http.cartas().length
    const save = floor.editarCatalogo([change])
    await vi.waitFor(() =>
      expect(http.calls.some((l) => l.route === '/api/catalog/changes')).toBe(true),
    )
    const post = http.calls.find((l) => l.route === '/api/catalog/changes') as Call
    post.respondida = true
    post.responder(http.json({ version: 21, changedCount: 1 }))
    await cartas(pedidas + 1)
    ;(http.calls.at(-1) as Call).respondida = true
    http.calls.at(-1)?.responder(new TypeError('Failed to fetch'))
    await expect(save).resolves.toBe(21)
    expect(versionOf(floor)).toBe(4)
  })

  it('el editor lee el catálogo completo con el token del equipo', async () => {
    const { floor } = await ready()
    const parsed = floor.catalogForEditing()
    await vi.waitFor(() =>
      expect(http.calls.some((l) => l.route === '/api/catalog/editing')).toBe(true),
    )
    const get = http.calls.find((l) => l.route === '/api/catalog/editing') as Call
    expect(get.token).toBe(TOKEN)
    get.respondida = true
    get.responder(http.json({ version: 4, products: [] }))
    await expect(parsed).resolves.toMatchObject({ version: 4 })
  })
})
