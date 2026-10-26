import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import {
  AlmacenMemoria,
  type Catalogo,
  type Channel,
  HubSync,
  type Manejadores,
  SalaSync,
} from '@pos/sync'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Equipo, Sala, type Sesion } from './motor'
import { catalogoDePrueba } from './pruebas'

// La carta se vuelve a pedir cuando el hub avisa que cambió (mensaje `catalogo`) y al reconectar;
// una respuesta rara, vieja o fallida nunca reemplaza la carta buena guardada. Hub en memoria,
// HTTP simulado: sin esperas fijas ni red real.

const TOKEN = 'token-del-equipo'

interface Llamada {
  metodo: string
  ruta: string
  token: string | null
  cuerpo: unknown
  responder: (r: Response | Error) => void
  respondida?: boolean
}

/** HTTP simulado: cada llamada queda pendiente hasta que la prueba decide qué responde. */
function montarHttp() {
  const llamadas: Llamada[] = []
  const fetchFalso = vi.fn((ruta: string, init: RequestInit) => {
    return new Promise<Response>((resolver, reject) => {
      const cabeceras = (init.headers ?? {}) as Record<string, string>
      llamadas.push({
        metodo: String(init.method),
        ruta,
        token: cabeceras.authorization?.replace('Bearer ', '') ?? null,
        cuerpo: init.body ? JSON.parse(String(init.body)) : null,
        responder: (r) => (r instanceof Error ? reject(r) : resolver(r)),
      })
    })
  })
  const json = (cuerpo: unknown, status = 200) =>
    new Response(JSON.stringify(cuerpo), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  return {
    llamadas,
    fetchFalso,
    json,
    cartas: () => llamadas.filter((l) => l.metodo === 'GET' && l.ruta === '/api/catalog'),
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
  verify: () => ({ ok: true as const, authorizedById: null, autorizacionId: null }),
  registrarUso: () => {},
}

function montarHub() {
  const device: Equipo = { dispositivoId: newId(), token: TOKEN, name: 'Ana', type: 'waiter' }
  const hub = new HubSync(new AlmacenMemoria(), {
    restauranteId: newId(),
    timeZone: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-test',
    clock: () => new Date().toISOString(),
    access: sinAcceso,
  })
  let revocadoEn: string | null = null
  const salaHub = new SalaSync(hub, (token) =>
    token === TOKEN ? { dispositivoId: device.dispositivoId, type: 'waiter', revocadoEn } : null,
  )
  const h = {
    device,
    salaHub,
    caido: false,
    revoke: () => {
      revocadoEn = new Date().toISOString()
      salaHub.revoke(device.dispositivoId, revocadoEn)
    },
    cut: [] as (() => void)[],
    open(m: Manejadores): Channel {
      let enlace: ReturnType<SalaSync['connect']> | null = null
      let closed = false
      const cut = () => {
        if (closed) return
        closed = true
        enlace?.close()
        enlace = null
        m.alCerrar()
      }
      h.cut.push(cut)
      setTimeout(() => {
        if (closed) return
        if (h.caido) return cut()
        enlace = salaHub.connect((msg) => {
          const copy = JSON.parse(JSON.stringify(msg))
          setTimeout(() => {
            if (!closed) m.alMensaje(copy)
          })
        })
        m.alAbrir()
      })
      return {
        send: (msg) => enlace?.recibir(JSON.parse(JSON.stringify(msg))),
        close: () => {
          closed = true
          enlace?.close()
          enlace = null
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
  for (const l of http.llamadas as Llamada[])
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
  h: ReturnType<typeof montarHub>,
  o: { session?: boolean; version?: number } = {},
) {
  const db = new BaseDispositivo(`catalog-${newId()}`)
  bases.push(db)
  await db.saveSetting('device', h.device)
  if (o.session !== false) {
    const sesionId = newId()
    const session: Sesion = {
      sesionId,
      secret: `secreto-${sesionId}`,
      user: { id: newId(), name: 'Ana', role: 'Gerente' },
      permissions: ['edit_catalog'],
      ultimoUso: Date.now(),
    }
    await db.saveSetting('session', session)
  }
  await db.saveSetting('catalog', catalogoDePrueba({ version: o.version ?? 4 }))
  const sala = new Sala({ db, open: (m) => h.open(m) })
  salas.push(sala)
  await sala.cargar()
  return { sala, db }
}

const conectada = (s: Sala) => s.instantanea().connection === 'connected'
const versionDe = (s: Sala) => s.instantanea().catalog?.version
const guardada = async (db: BaseDispositivo) => (await db.leerAjuste<Catalogo>('catalog'))?.version

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
    const h = montarHub()
    const { sala, db } = await device(h)
    await vi.waitFor(() => expect(conectada(sala)).toBe(true))
    // Al conectar, pide la carta una vez; se responde con la misma versión que ya tenía.
    await cartas(1)
    http.responderCartas(4)
    await asentar(sala)
    const pedidas = http.cartas().length

    h.salaHub.avisarCatalogo(9)
    await cartas(pedidas + 1)
    const peticion = http.cartas().at(-1)
    expect(peticion?.token).toBe(TOKEN)
    http.responderCartas(9)

    await vi.waitFor(() => expect(versionDe(sala)).toBe(9))
    await vi.waitFor(async () => expect(await guardada(db)).toBe(9))
  })

  it('un aviso con la versión que ya tiene no pide nada', async () => {
    const h = montarHub()
    const { sala } = await device(h, { version: 7 })
    await vi.waitFor(() => expect(conectada(sala)).toBe(true))
    await cartas(1)
    http.responderCartas(7)
    await asentar(sala)
    const pedidas = http.cartas().length
    h.salaHub.avisarCatalogo(7)
    await asentar(sala)
    // Un mensaje posterior sí llega: demuestra que el anterior ya se procesó.
    h.salaHub.avisarCatalogo(8)
    await cartas(pedidas + 1)
    expect(http.cartas()).toHaveLength(pedidas + 1)
  })

  it('sin sesión abierta no pide la carta (el hub la exige con un equipo, no con una sesión, pero no hay quién la use)', async () => {
    const h = montarHub()
    const { sala } = await device(h, { session: false })
    await vi.waitFor(() => expect(conectada(sala)).toBe(true))
    await asentar(sala)
    h.salaHub.avisarCatalogo(9)
    await asentar(sala)
    expect(http.cartas()).toHaveLength(0)
    expect(versionDe(sala)).toBe(4)
  })

  it('el aviso no cuenta como cambio de datos ni deja nada pendiente', async () => {
    const h = montarHub()
    const { sala } = await device(h)
    await vi.waitFor(() => expect(conectada(sala)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(sala)
    const before = sala.instantanea()
    h.salaHub.avisarCatalogo(10)
    await cartas(2)
    http.responderCartas(10)
    await vi.waitFor(() => expect(versionDe(sala)).toBe(10))
    expect(sala.instantanea().pendingList).toBe(before.pendingList)
    expect(sala.instantanea().changes).toBe(before.changes)
  })

  it('sin red al pedirla: se queda la carta guardada y no se rompe nada', async () => {
    const h = montarHub()
    const { sala, db } = await device(h)
    await vi.waitFor(() => expect(conectada(sala)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(sala)
    const pedidas = http.cartas().length

    h.salaHub.avisarCatalogo(9)
    await cartas(pedidas + 1)
    ;(http.llamadas.at(-1) as Llamada).respondida = true
    http.llamadas.at(-1)?.responder(new TypeError('Failed to fetch'))
    await asentar(sala)

    expect(versionDe(sala)).toBe(4)
    expect(await guardada(db)).toBe(4)
    expect(sala.instantanea().connection).toBe('connected')
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
  ])('si el hub responde %s, no reemplaza la carta buena', async (_case, respuesta) => {
    const h = montarHub()
    const { sala, db } = await device(h)
    await vi.waitFor(() => expect(conectada(sala)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(sala)
    const pedidas = http.cartas().length

    h.salaHub.avisarCatalogo(9)
    await cartas(pedidas + 1)
    ;(http.llamadas.at(-1) as Llamada).respondida = true
    http.llamadas.at(-1)?.responder(respuesta())
    await asentar(sala)

    expect(versionDe(sala)).toBe(4)
    expect(sala.instantanea().catalog?.categories).toEqual([])
    expect(await guardada(db)).toBe(4)
  })

  it('dos avisos seguidos y las respuestas en desorden: queda la versión más nueva', async () => {
    const h = montarHub()
    const { sala, db } = await device(h)
    await vi.waitFor(() => expect(conectada(sala)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(sala)
    const pedidas = http.cartas().length

    h.salaHub.avisarCatalogo(8)
    await cartas(pedidas + 1)
    h.salaHub.avisarCatalogo(9)
    await cartas(pedidas + 2)
    const [first, segunda] = http.cartas().slice(pedidas) as Llamada[]
    if (!first || !segunda) throw new Error('faltan peticiones')
    // La segunda (versión 9) llega antes que la primera (versión 8).
    segunda.respondida = true
    segunda.responder(http.json(catalogoDePrueba({ version: 9 })))
    await vi.waitFor(() => expect(versionDe(sala)).toBe(9))
    first.respondida = true
    first.responder(http.json(catalogoDePrueba({ version: 8 })))
    await asentar(sala)

    expect(versionDe(sala)).toBe(9)
    await vi.waitFor(async () => expect(await guardada(db)).toBe(9))
  })

  it('avisos repetidos o fuera de orden: cada respuesta trae lo último y queda esa versión', async () => {
    const h = montarHub()
    const { sala } = await device(h)
    await vi.waitFor(() => expect(conectada(sala)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(sala)
    const pedidas = http.cartas().length

    // Los avisos 12, 11 y 10 llegan en ese orden; 12 repetido no pide de nuevo.
    for (const v of [12, 12, 11, 10]) h.salaHub.avisarCatalogo(v)
    await vi.waitFor(() => expect(http.cartas().length).toBeGreaterThan(pedidas))
    // El hub contesta siempre con lo último que tiene, sea cual sea el aviso.
    await vi.waitFor(() => {
      http.responderCartas(12)
      expect(versionDe(sala)).toBe(12)
    })
    await asentar(sala)
    http.responderCartas(12)
    expect(versionDe(sala)).toBe(12)
  })

  it('al reconectar tras un corte pide la carta por si cambió mientras no había red', async () => {
    const h = montarHub()
    const { sala } = await device(h)
    await vi.waitFor(() => expect(conectada(sala)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(sala)

    sala.simularSinConexion(true)
    await vi.waitFor(() => expect(sala.instantanea().connection).toBe('disconnected'))
    const pedidas = http.cartas().length
    sala.simularSinConexion(false)
    await vi.waitFor(() => expect(conectada(sala)).toBe(true))
    await cartas(pedidas + 1)
    http.responderCartas(15)
    await vi.waitFor(() => expect(versionDe(sala)).toBe(15))
  })

  it('con el equipo retirado el hub ya no le manda avisos', async () => {
    const h = montarHub()
    const { sala } = await device(h)
    await vi.waitFor(() => expect(conectada(sala)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(sala)
    const pedidas = http.cartas().length
    h.revoke()
    await vi.waitFor(() => expect(sala.instantanea().errorHub?.code).toBe('revoked_token'))
    h.salaHub.avisarCatalogo(9)
    await asentar(sala)
    expect(http.cartas()).toHaveLength(pedidas)
  })
})

describe('editar la carta desde la app', () => {
  async function ready() {
    const h = montarHub()
    const e = await device(h)
    await vi.waitFor(() => expect(conectada(e.sala)).toBe(true))
    await cartas(1)
    http.responderCartas(4)
    await asentar(e.sala)
    return { h, ...e }
  }
  const change = {
    entity: 'products' as const,
    id: newId(),
    data: { price: 1_000 },
  }

  it('manda la sesión y los cambios, y trae la carta nueva al terminar', async () => {
    const { sala } = await ready()
    const session = sala.instantanea().session as Sesion
    const pedidas = http.cartas().length
    const guardar = sala.editarCatalogo([change])

    await vi.waitFor(() =>
      expect(http.llamadas.some((l) => l.ruta === '/api/catalog/changes')).toBe(true),
    )
    const post = http.llamadas.find((l) => l.ruta === '/api/catalog/changes') as Llamada
    expect(post.metodo).toBe('POST')
    expect(post.token).toBe(TOKEN)
    expect(post.cuerpo).toEqual({
      session_id: session.sesionId,
      secret: session.secret,
      changes: [change],
    })
    post.respondida = true
    post.responder(http.json({ version: 20, cambiados: 1 }))

    await cartas(pedidas + 1)
    http.responderCartas(20)
    await expect(guardar).resolves.toBe(20)
    expect(versionDe(sala)).toBe(20)
  })

  it('si el hub rechaza (400), el error llega con su mensaje y no pide la carta', async () => {
    const { sala } = await ready()
    const pedidas = http.cartas().length
    const guardar = sala.editarCatalogo([change])
    const result = guardar.then(
      () => null,
      (e: unknown) => e,
    )
    await vi.waitFor(() =>
      expect(http.llamadas.some((l) => l.ruta === '/api/catalog/changes')).toBe(true),
    )
    const post = http.llamadas.find((l) => l.ruta === '/api/catalog/changes') as Llamada
    post.respondida = true
    post.responder(
      http.json({ error: 'invalid_data', message: 'Cambio 1 (producto): precio mal' }, 400),
    )
    expect(await result).toMatchObject({
      code: 'invalid_data',
      message: 'Cambio 1 (producto): precio mal',
    })
    expect(http.cartas()).toHaveLength(pedidas)
    expect(versionDe(sala)).toBe(4)
  })

  it('sin red el cambio falla con aviso claro y no se da por hecho', async () => {
    const { sala } = await ready()
    const guardar = sala.editarCatalogo([change])
    await vi.waitFor(() =>
      expect(http.llamadas.some((l) => l.ruta === '/api/catalog/changes')).toBe(true),
    )
    const post = http.llamadas.find((l) => l.ruta === '/api/catalog/changes') as Llamada
    post.respondida = true
    post.responder(new TypeError('Failed to fetch'))
    await expect(guardar).rejects.toMatchObject({ code: 'offline' })
    expect(versionDe(sala)).toBe(4)
  })

  it('con la conexión simulada apagada no sale ninguna petición', async () => {
    const { sala } = await ready()
    sala.simularSinConexion(true)
    const before = http.llamadas.length
    await expect(sala.editarCatalogo([change])).rejects.toMatchObject({ code: 'offline' })
    expect(http.llamadas).toHaveLength(before)
  })

  it('sin sesión no se manda nada', async () => {
    const h = montarHub()
    const { sala } = await device(h, { session: false })
    await vi.waitFor(() => expect(conectada(sala)).toBe(true))
    await expect(sala.editarCatalogo([change])).rejects.toThrow('Sin sesión')
    expect(http.llamadas.some((l) => l.ruta === '/api/catalog/changes')).toBe(false)
  })

  it('si guardó pero la carta nueva no llega, el guardado cuenta y la carta vieja se queda', async () => {
    const { sala } = await ready()
    const pedidas = http.cartas().length
    const guardar = sala.editarCatalogo([change])
    await vi.waitFor(() =>
      expect(http.llamadas.some((l) => l.ruta === '/api/catalog/changes')).toBe(true),
    )
    const post = http.llamadas.find((l) => l.ruta === '/api/catalog/changes') as Llamada
    post.respondida = true
    post.responder(http.json({ version: 21, cambiados: 1 }))
    await cartas(pedidas + 1)
    ;(http.llamadas.at(-1) as Llamada).respondida = true
    http.llamadas.at(-1)?.responder(new TypeError('Failed to fetch'))
    await expect(guardar).resolves.toBe(21)
    expect(versionDe(sala)).toBe(4)
  })

  it('el editor lee el catálogo completo con el token del equipo', async () => {
    const { sala } = await ready()
    const lectura = sala.catalogoParaEditar()
    await vi.waitFor(() =>
      expect(http.llamadas.some((l) => l.ruta === '/api/catalog/editing')).toBe(true),
    )
    const get = http.llamadas.find((l) => l.ruta === '/api/catalog/editing') as Llamada
    expect(get.token).toBe(TOKEN)
    get.respondida = true
    get.responder(http.json({ version: 4, products: [] }))
    await expect(lectura).resolves.toMatchObject({ version: 4 })
  })
})
