import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import {
  AlmacenMemoria,
  type Channel,
  type ControlAcceso,
  type EstadoImpresora,
  HubSync,
  type Manejadores,
  SalaSync,
} from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Equipo, Sala, type Sesion } from './motor'
import { catalogoDePrueba } from './pruebas'

// El motor de la app con la cocina (ADR-015): convertir un equipo en pantalla, que una pantalla no
// venza por inactividad, las llamadas de «Cocina e impresoras» y el aviso de las impresoras.

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  vi.unstubAllGlobals()
  await new Promise((r) => setTimeout(r, 20))
  for (const b of bases.splice(0)) await b.delete()
})

const sinRed = (): Channel => ({ send: () => {}, close: () => {} })
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

interface Llamada {
  url: string
  metodo: string
  cuerpo: Record<string, unknown> | null
  token: string | null
}

/** El hub como un `fetch` falso: anota cada llamada y responde lo que diga `responder`. */
function hubFalso(responder: (llamada: Llamada) => Response) {
  const llamadas: Llamada[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const llamada: Llamada = {
        url,
        metodo: init?.method ?? 'GET',
        cuerpo: init?.body ? JSON.parse(String(init.body)) : null,
        token: headers.authorization?.replace('Bearer ', '') ?? null,
      }
      llamadas.push(llamada)
      if (url === '/api/catalog') return json(catalogoDePrueba({ version: 9 }))
      return responder(llamada)
    }),
  )
  return llamadas
}

const register: Equipo = {
  dispositivoId: newId(),
  token: 'token-caja',
  name: 'Caja',
  type: 'register',
}
const sesionAdmin = (): Sesion => ({
  sesionId: newId(),
  secret: 'secreto-admin',
  user: { id: newId(), name: 'Administrador', role: 'Administrador' },
  permissions: ['manage_devices', 'take_order'],
  ultimoUso: Date.now(),
})

/** Una sala con ese equipo y esa sesión ya guardados, sin red. */
async function open(device: Equipo = register, session: Sesion | null = sesionAdmin()) {
  const db = new BaseDispositivo(`prueba-${newId()}`)
  bases.push(db)
  await db.saveSetting('device', device)
  if (session) await db.saveSetting('session', session)
  await db.saveSetting('catalog', catalogoDePrueba())
  const sala = new Sala({ db, open: sinRed })
  salas.push(sala)
  await sala.cargar()
  return { sala, db, session }
}

const respuestaPantalla = () => ({
  session_id: newId(),
  secret: 'secreto-pantalla',
  user: { id: newId(), name: 'Cocina', role: 'Pantalla de cocina' },
  permissions: ['mark_product_sold_out', 'mark_preparation'],
  type: 'kds',
})

describe('Sala.convertirEnPantalla', () => {
  it('manda la sesión del administrador, el nombre y las estaciones, con el token del equipo', async () => {
    const llamadas = hubFalso(() => json(respuestaPantalla(), 201))
    const { sala, session } = await open()
    await sala.convertirEnPantalla('Cocina', ['E-COCINA', 'E-BARRA'])
    const order = llamadas.find((l) => l.url === '/api/screens')
    expect(order).toMatchObject({
      metodo: 'POST',
      token: 'token-caja',
      cuerpo: {
        session_id: session?.sesionId,
        secret: 'secreto-admin',
        name: 'Cocina',
        station_ids: ['E-COCINA', 'E-BARRA'],
      },
    })
  })

  it('guarda el equipo como kds, con su nombre nuevo, y lo recuerda tras reiniciar', async () => {
    hubFalso(() => json(respuestaPantalla(), 201))
    const { sala, db } = await open()
    await sala.convertirEnPantalla('Cocina caliente', ['E-COCINA'])
    const expected = { ...register, type: 'kds', name: 'Cocina caliente' }
    expect(sala.instantanea().device).toEqual(expected)
    expect(await db.leerAjuste<Equipo>('device')).toEqual(expected)
    const reabierta = new Sala({ db, open: sinRed })
    salas.push(reabierta)
    await reabierta.cargar()
    expect(reabierta.instantanea().device).toEqual(expected)
  })

  it('cambia la sesión del administrador por la de la pantalla, guardada y sin error de inactividad', async () => {
    const r = respuestaPantalla()
    hubFalso(() => json(r, 201))
    const { sala, db } = await open()
    const before = Date.now()
    await sala.convertirEnPantalla('Cocina', ['E-COCINA'])
    const session = sala.instantanea().session
    expect(session).toMatchObject({
      sesionId: r.session_id,
      secret: 'secreto-pantalla',
      user: r.user,
      permissions: ['mark_product_sold_out', 'mark_preparation'],
    })
    expect(session?.ultimoUso).toBeGreaterThanOrEqual(before)
    expect(await db.leerAjuste<Sesion>('session')).toEqual(session)
    expect(sala.instantanea().sessionClosedBy).toBeNull()
  })

  it('vuelve a pedir la carta al terminar', async () => {
    const llamadas = hubFalso(() => json(respuestaPantalla(), 201))
    const { sala } = await open()
    const before = llamadas.filter((l) => l.url === '/api/catalog').length
    await sala.convertirEnPantalla('Cocina', ['E-COCINA'])
    expect(llamadas.filter((l) => l.url === '/api/catalog').length).toBeGreaterThan(before)
    expect(sala.instantanea().catalog?.version).toBe(9)
  })

  it('si la carta falla después, igual queda convertida', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/screens') return json(respuestaPantalla(), 201)
        throw new TypeError('Failed to fetch')
      }),
    )
    const { sala } = await open()
    await expect(sala.convertirEnPantalla('Cocina', ['E-COCINA'])).resolves.toBeUndefined()
    expect(sala.instantanea().device?.type).toBe('kds')
  })

  it.each([
    ['sin permiso (403)', 403, 'no_permission'],
    ['datos inválidos (400)', 400, 'invalid_data'],
  ])('si el hub dice %s, el equipo y la sesión quedan como estaban', async (_, status, error) => {
    hubFalso(() => json({ error, message: 'No se pudo' }, status))
    const { sala, db, session } = await open()
    await expect(sala.convertirEnPantalla('Cocina', ['E-COCINA'])).rejects.toMatchObject({
      code: error,
      message: 'No se pudo',
    })
    expect(sala.instantanea().device).toEqual(register)
    expect(sala.instantanea().session).toEqual(session)
    expect(await db.leerAjuste<Equipo>('device')).toEqual(register)
    expect(await db.leerAjuste<Sesion>('session')).toEqual(session)
  })

  it('sin conexión con la caja no cambia nada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { sala, session } = await open()
    await expect(sala.convertirEnPantalla('Cocina', ['E-COCINA'])).rejects.toMatchObject({
      code: 'offline',
    })
    expect(sala.instantanea().device).toEqual(register)
    expect(sala.instantanea().session).toEqual(session)
  })

  it('sin sesión no llama al hub', async () => {
    const llamadas = hubFalso(() => json(respuestaPantalla(), 201))
    const { sala } = await open(register, null)
    await expect(sala.convertirEnPantalla('Cocina', ['E-COCINA'])).rejects.toThrow('Sin sesión')
    expect(llamadas.filter((l) => l.url === '/api/screens')).toEqual([])
  })

  it('si el hub dice que la sesión ya no vale, se cierra la sesión local', async () => {
    hubFalso(() => json({ error: 'invalid_session', message: 'La sesión se cerró' }, 401))
    const { sala } = await open()
    await expect(sala.convertirEnPantalla('Cocina', ['E-COCINA'])).rejects.toMatchObject({
      code: 'invalid_session',
    })
    expect(sala.instantanea().session).toBeNull()
    expect(sala.instantanea().device).toEqual(register)
  })
})

describe('la pantalla de cocina no vence por inactividad', () => {
  const UN_DIA = 24 * 60 * 60_000

  it('un equipo kds conserva su sesión aunque pasen días sin uso', async () => {
    const { sala } = await open({ ...register, type: 'kds' })
    const session = sala.instantanea().session as Sesion
    sala.vencerSesionSiToca(session.ultimoUso + 30 * 60_000)
    sala.vencerSesionSiToca(session.ultimoUso + 3 * UN_DIA)
    await new Promise((r) => setTimeout(r, 20))
    expect(sala.instantanea().session).toEqual(session)
    expect(sala.instantanea().sessionClosedBy).toBeNull()
  })

  it('un equipo común sí vence al pasar el tiempo (control de la prueba anterior)', async () => {
    const { sala } = await open({ ...register, type: 'waiter' })
    const session = sala.instantanea().session as Sesion
    sala.vencerSesionSiToca(session.ultimoUso + 29 * 60_000)
    expect(sala.instantanea().session).not.toBeNull()
    sala.vencerSesionSiToca(session.ultimoUso + 30 * 60_000)
    await new Promise((r) => setTimeout(r, 20))
    expect(sala.instantanea().session).toBeNull()
    expect(sala.instantanea().sessionClosedBy).toBe('inactivity')
  })

  it('una caja tampoco es una pantalla: vence igual', async () => {
    const { sala } = await open({ ...register, type: 'register' })
    const session = sala.instantanea().session as Sesion
    sala.vencerSesionSiToca(session.ultimoUso + UN_DIA)
    await new Promise((r) => setTimeout(r, 20))
    expect(sala.instantanea().session).toBeNull()
  })

  it('al reabrir la app con la sesión de ayer, la pantalla sigue abierta (no pide PIN)', async () => {
    const vieja: Sesion = { ...sesionAdmin(), ultimoUso: Date.now() - 2 * UN_DIA }
    const { sala } = await open({ ...register, type: 'kds' }, vieja)
    expect(sala.instantanea().session).toEqual(vieja)
  })

  it('al reabrir la app, un equipo común con sesión de ayer ya no la tiene', async () => {
    const vieja: Sesion = { ...sesionAdmin(), ultimoUso: Date.now() - 2 * UN_DIA }
    const { sala } = await open({ ...register, type: 'waiter' }, vieja)
    await new Promise((r) => setTimeout(r, 20))
    expect(sala.instantanea().session).toBeNull()
  })

  it('un kds con una carta que dice 1 minuto de inactividad tampoco vence', async () => {
    const db = new BaseDispositivo(`prueba-${newId()}`)
    bases.push(db)
    await db.saveSetting('device', { ...register, type: 'kds' })
    const session = sesionAdmin()
    await db.saveSetting('session', session)
    await db.saveSetting(
      'catalog',
      catalogoDePrueba({ restaurant: { name: 'P', sesionInactividadMin: 1 } }),
    )
    const sala = new Sala({ db, open: sinRed })
    salas.push(sala)
    await sala.cargar()
    sala.vencerSesionSiToca(session.ultimoUso + 60 * 60_000)
    expect(sala.instantanea().session).toEqual(session)
  })
})

describe('llamadas de «Cocina e impresoras»', () => {
  const printer = {
    name: 'Cocina',
    connection: 'network' as const,
    address: '192.168.1.50',
    port: 9100,
    width: 80 as const,
    code_page: 'pc850' as const,
    fallback_id: null,
    station_ids: ['E-COCINA'],
    active: true,
  }

  it.each([
    ['kitchenConfig', (s: Sala) => s.kitchenConfig(), '/api/kitchen/config', {}],
    ['savePrinter', (s: Sala) => s.savePrinter(printer), '/api/printers', { printer }],
    [
      'testPrinter',
      (s: Sala) => s.testPrinter('ID-IMP'),
      '/api/printers/test',
      { printer_id: 'ID-IMP' },
    ],
    ['pendingPrints', (s: Sala) => s.pendingPrints(), '/api/printing/pending', {}],
    [
      'discardJob',
      (s: Sala) => s.discardJob('ID-TRAB'),
      '/api/printing/discard',
      { trabajo_id: 'ID-TRAB' },
    ],
    [
      'screenStations',
      (s: Sala) => s.screenStations('ID-DISP', ['E-COCINA']),
      '/api/screens/stations',
      { device_id: 'ID-DISP', station_ids: ['E-COCINA'] },
    ],
    [
      'kitchenTimers',
      (s: Sala) => s.kitchenTimers(8, 16),
      '/api/kitchen/timers',
      { amarillo: 8, rojo: 16 },
    ],
  ])('%s llama a %s con la sesión y el token del equipo', async (_, llamar, url, extra) => {
    const llamadas = hubFalso(() => json({ id: 'ID', trabajo_id: 'T' }))
    const { sala, session } = await open()
    await llamar(sala)
    const l = llamadas.find((x) => x.url === url)
    expect(l).toMatchObject({
      metodo: 'POST',
      token: 'token-caja',
      cuerpo: { session_id: session?.sesionId, secret: 'secreto-admin', ...extra },
    })
  })

  it('guardarImpresora devuelve el id que dio el hub', async () => {
    hubFalso(() => json({ id: 'ID-NUEVA' }))
    const { sala } = await open()
    await expect(sala.savePrinter(printer)).resolves.toBe('ID-NUEVA')
  })

  it('un error del hub llega con su mensaje; una sesión inválida cierra la sesión', async () => {
    hubFalso(() => json({ error: 'invalid_data', message: 'Esa estación no existe' }, 400))
    const { sala } = await open()
    await expect(sala.savePrinter(printer)).rejects.toMatchObject({
      code: 'invalid_data',
      message: 'Esa estación no existe',
    })
    expect(sala.instantanea().session).not.toBeNull()
    hubFalso(() => json({ error: 'invalid_session', message: 'Vuelve a entrar' }, 401))
    await expect(sala.kitchenTimers(1, 2)).rejects.toMatchObject({ code: 'invalid_session' })
    expect(sala.instantanea().session).toBeNull()
  })

  it('sin sesión ninguna llamada sale', async () => {
    const llamadas = hubFalso(() => json({}))
    const { sala } = await open(register, null)
    await expect(sala.kitchenConfig()).rejects.toThrow('Sin sesión')
    await expect(sala.kitchenTimers(1, 2)).rejects.toThrow('Sin sesión')
    expect(llamadas.filter((l) => l.url.startsWith('/api/kitchen'))).toEqual([])
  })
})

// ── Aviso de impresoras y hora del hub, con un hub de verdad ─────────────

const accesoLibre: ControlAcceso = {
  verify: () => ({ ok: true, authorizedById: null, autorizacionId: null }),
  registrarUso: () => {},
}

function montarHub(desfaseHubMs = 0) {
  const tokens = new Map<string, Equipo>()
  const hub = new HubSync(new AlmacenMemoria(), {
    restauranteId: newId(),
    timeZone: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-test',
    clock: () => new Date(Date.now() + desfaseHubMs).toISOString(),
    access: accesoLibre,
  })
  const salaHub = new SalaSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { dispositivoId: e.dispositivoId, type: e.type, revocadoEn: null } : null
  })
  const abrirCanal = (m: Manejadores): Channel => {
    let enlace: ReturnType<SalaSync['connect']> | null = null
    setTimeout(() => {
      enlace = salaHub.connect((msg) => {
        const copy = JSON.parse(JSON.stringify(msg))
        setTimeout(() => enlace && m.alMensaje(copy))
      })
      m.alAbrir()
    })
    return {
      send: (msg) => enlace?.recibir(JSON.parse(JSON.stringify(msg))),
      close: () => {
        enlace?.close()
        enlace = null
      },
    }
  }
  return { hub, tokens, salaHub, abrirCanal }
}

async function conectada(h: ReturnType<typeof montarHub>, device: Equipo = register) {
  h.tokens.set(device.token, device)
  const db = new BaseDispositivo(`prueba-${newId()}`)
  bases.push(db)
  await db.saveSetting('device', device)
  await db.saveSetting('session', sesionAdmin())
  await db.saveSetting('catalog', catalogoDePrueba())
  const sala = new Sala({ db, open: h.abrirCanal })
  salas.push(sala)
  await sala.cargar()
  return sala
}

async function esperar(condicion: () => boolean, ms = 3000) {
  const fin = Date.now() + ms
  while (!condicion()) {
    if (Date.now() > fin) throw new Error('No se cumplió a tiempo')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Espera a que la sala termine de procesar lo que traía (el contador de cambios deja de subir). */
async function asentar(sala: Sala) {
  let ultimo = -1
  let quietos = 0
  while (quietos < 4) {
    await sala.sync?.ready()
    await new Promise((r) => setTimeout(r, 25))
    const ahora = sala.instantanea().changes
    quietos = ahora === ultimo ? quietos + 1 : 0
    ultimo = ahora
  }
}

const statuses = (...names: string[]): EstadoImpresora[] =>
  names.map((name, i) => ({
    id: newId(),
    name,
    status: i === 0 ? 'failed' : 'ready',
    error: i === 0 ? 'La impresora no responde' : null,
    pendingList: i === 0 ? 2 : 0,
  }))

describe('mensaje «impresoras»', () => {
  it('la instantánea empieza vacía', async () => {
    const { sala } = await open()
    expect(sala.instantanea().printers).toEqual([])
  })

  it('actualiza la instantánea cada vez que el hub avisa, y avisa a la pantalla', async () => {
    const h = montarHub()
    const sala = await conectada(h)
    await esperar(() => sala.instantanea().connection === 'connected')
    let avisos = 0
    sala.suscribir(() => {
      avisos += 1
    })
    const firstOne = statuses('Barra', 'Cocina')
    h.salaHub.avisarImpresoras(firstOne)
    await esperar(() => sala.instantanea().printers.length === 2)
    expect(sala.instantanea().printers).toEqual(firstOne)
    expect(avisos).toBeGreaterThan(0)

    const sano = firstOne.map((e) => ({
      ...e,
      status: 'ready' as const,
      error: null,
      pendingList: 0,
    }))
    h.salaHub.avisarImpresoras(sano)
    await esperar(() => sala.instantanea().printers[0]?.status === 'ready')
    expect(sala.instantanea().printers).toEqual(sano)

    h.salaHub.avisarImpresoras([])
    await esperar(() => sala.instantanea().printers.length === 0)
  })

  it('un equipo que se conecta después recibe el último estado', async () => {
    const h = montarHub()
    const ultimo = statuses('Barra')
    h.salaHub.avisarImpresoras(ultimo)
    const sala = await conectada(h)
    await esperar(() => sala.instantanea().printers.length === 1)
    expect(sala.instantanea().printers).toEqual(ultimo)
  })

  it('el aviso no cambia lo guardado ni los pendientes del equipo', async () => {
    const h = montarHub()
    const sala = await conectada(h)
    await esperar(() => sala.instantanea().connection === 'connected')
    await asentar(sala)
    const before = {
      pendingList: sala.instantanea().pendingList,
      changes: sala.instantanea().changes,
    }
    h.salaHub.avisarImpresoras(statuses('Cocina'))
    await esperar(() => sala.instantanea().printers.length === 1)
    expect(sala.instantanea().pendingList).toBe(before.pendingList)
    expect(sala.instantanea().changes).toBe(before.changes)
    expect(await sala.sync?.locales()).toEqual([])
  })

  it('quien está sin conexión conserva el último estado conocido', async () => {
    const h = montarHub()
    const sala = await conectada(h)
    await esperar(() => sala.instantanea().connection === 'connected')
    const ultimo = statuses('Cocina')
    h.salaHub.avisarImpresoras(ultimo)
    await esperar(() => sala.instantanea().printers.length === 1)
    sala.simularSinConexion(true)
    expect(sala.instantanea().printers).toEqual(ultimo)
  })
})

describe('Sala.ahoraHub', () => {
  it('sin conexión usa la hora del equipo', async () => {
    const { sala } = await open()
    expect(sala.ahoraHub(123_456)).toBe(123_456)
  })

  it('con el hub adelantado 5 minutos, la hora del hub va 5 minutos adelante de la del equipo', async () => {
    const h = montarHub(5 * 60_000)
    const sala = await conectada(h)
    await esperar(() => Math.abs(sala.ahoraHub() - Date.now() - 5 * 60_000) < 2000)
    expect(sala.ahoraHub() - Date.now()).toBeGreaterThan(5 * 60_000 - 2000)
  })

  it('con el equipo adelantado respecto al hub, la hora del hub va atrás', async () => {
    const h = montarHub(-3 * 60_000)
    const sala = await conectada(h)
    await esperar(() => Math.abs(sala.ahoraHub() - Date.now() + 3 * 60_000) < 2000)
    expect(sala.ahoraHub() - Date.now()).toBeLessThan(-3 * 60_000 + 2000)
  })
})
