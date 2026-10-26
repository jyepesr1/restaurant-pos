import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import {
  type AccessControl,
  type Channel,
  FloorSync,
  type Handlers,
  HubSync,
  MemoryStore,
  type PrinterStatus,
} from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import { type Device, Sala, type Session } from './motor'
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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Call {
  url: string
  httpMethod: string
  body: Record<string, unknown> | null
  token: string | null
}

/** El hub como un `fetch` falso: anota cada llamada y responde lo que diga `responder`. */
function hubFalso(responder: (llamada: Call) => Response) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const llamada: Call = {
        url,
        httpMethod: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
        token: headers.authorization?.replace('Bearer ', '') ?? null,
      }
      calls.push(llamada)
      if (url === '/api/catalog') return json(catalogoDePrueba({ version: 9 }))
      return responder(llamada)
    }),
  )
  return calls
}

const register: Device = {
  deviceId: newId(),
  token: 'token-caja',
  name: 'Caja',
  type: 'register',
}
const adminSession = (): Session => ({
  sessionId: newId(),
  secret: 'secreto-admin',
  user: { id: newId(), name: 'Administrador', role: 'Administrador' },
  permissions: ['manage_devices', 'take_order'],
  lastUsed: Date.now(),
})

/** Una sala con ese equipo y esa sesión ya guardados, sin red. */
async function open(device: Device = register, session: Session | null = adminSession()) {
  const db = new BaseDispositivo(`prueba-${newId()}`)
  bases.push(db)
  await db.saveSetting('device', device)
  if (session) await db.saveSetting('session', session)
  await db.saveSetting('catalog', catalogoDePrueba())
  const floor = new Sala({ db, open: sinRed })
  salas.push(floor)
  await floor.load()
  return { floor, db, session }
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
    const calls = hubFalso(() => json(respuestaPantalla(), 201))
    const { floor, session } = await open()
    await floor.convertToScreen('Cocina', ['E-COCINA', 'E-BARRA'])
    const order = calls.find((l) => l.url === '/api/screens')
    expect(order).toMatchObject({
      httpMethod: 'POST',
      token: 'token-caja',
      body: {
        session_id: session?.sessionId,
        secret: 'secreto-admin',
        name: 'Cocina',
        station_ids: ['E-COCINA', 'E-BARRA'],
      },
    })
  })

  it('guarda el equipo como kds, con su nombre nuevo, y lo recuerda tras reiniciar', async () => {
    hubFalso(() => json(respuestaPantalla(), 201))
    const { floor, db } = await open()
    await floor.convertToScreen('Cocina caliente', ['E-COCINA'])
    const expected = { ...register, type: 'kds', name: 'Cocina caliente' }
    expect(floor.instantanea().device).toEqual(expected)
    expect(await db.leerAjuste<Device>('device')).toEqual(expected)
    const reopenedInstance = new Sala({ db, open: sinRed })
    salas.push(reopenedInstance)
    await reopenedInstance.load()
    expect(reopenedInstance.instantanea().device).toEqual(expected)
  })

  it('cambia la sesión del administrador por la de la pantalla, guardada y sin error de inactividad', async () => {
    const r = respuestaPantalla()
    hubFalso(() => json(r, 201))
    const { floor, db } = await open()
    const before = Date.now()
    await floor.convertToScreen('Cocina', ['E-COCINA'])
    const session = floor.instantanea().session
    expect(session).toMatchObject({
      sessionId: r.session_id,
      secret: 'secreto-pantalla',
      user: r.user,
      permissions: ['mark_product_sold_out', 'mark_preparation'],
    })
    expect(session?.lastUsed).toBeGreaterThanOrEqual(before)
    expect(await db.leerAjuste<Session>('session')).toEqual(session)
    expect(floor.instantanea().sessionClosedBy).toBeNull()
  })

  it('vuelve a pedir la carta al terminar', async () => {
    const calls = hubFalso(() => json(respuestaPantalla(), 201))
    const { floor } = await open()
    const before = calls.filter((l) => l.url === '/api/catalog').length
    await floor.convertToScreen('Cocina', ['E-COCINA'])
    expect(calls.filter((l) => l.url === '/api/catalog').length).toBeGreaterThan(before)
    expect(floor.instantanea().catalog?.version).toBe(9)
  })

  it('si la carta falla después, igual queda convertida', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/screens') return json(respuestaPantalla(), 201)
        throw new TypeError('Failed to fetch')
      }),
    )
    const { floor } = await open()
    await expect(floor.convertToScreen('Cocina', ['E-COCINA'])).resolves.toBeUndefined()
    expect(floor.instantanea().device?.type).toBe('kds')
  })

  it.each([
    ['sin permiso (403)', 403, 'no_permission'],
    ['datos inválidos (400)', 400, 'invalid_data'],
  ])('si el hub dice %s, el equipo y la sesión quedan como estaban', async (_, status, error) => {
    hubFalso(() => json({ error, message: 'No se pudo' }, status))
    const { floor, db, session } = await open()
    await expect(floor.convertToScreen('Cocina', ['E-COCINA'])).rejects.toMatchObject({
      code: error,
      message: 'No se pudo',
    })
    expect(floor.instantanea().device).toEqual(register)
    expect(floor.instantanea().session).toEqual(session)
    expect(await db.leerAjuste<Device>('device')).toEqual(register)
    expect(await db.leerAjuste<Session>('session')).toEqual(session)
  })

  it('sin conexión con la caja no cambia nada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { floor, session } = await open()
    await expect(floor.convertToScreen('Cocina', ['E-COCINA'])).rejects.toMatchObject({
      code: 'offline',
    })
    expect(floor.instantanea().device).toEqual(register)
    expect(floor.instantanea().session).toEqual(session)
  })

  it('sin sesión no llama al hub', async () => {
    const calls = hubFalso(() => json(respuestaPantalla(), 201))
    const { floor } = await open(register, null)
    await expect(floor.convertToScreen('Cocina', ['E-COCINA'])).rejects.toThrow('Sin sesión')
    expect(calls.filter((l) => l.url === '/api/screens')).toEqual([])
  })

  it('si el hub dice que la sesión ya no vale, se cierra la sesión local', async () => {
    hubFalso(() => json({ error: 'invalid_session', message: 'La sesión se cerró' }, 401))
    const { floor } = await open()
    await expect(floor.convertToScreen('Cocina', ['E-COCINA'])).rejects.toMatchObject({
      code: 'invalid_session',
    })
    expect(floor.instantanea().session).toBeNull()
    expect(floor.instantanea().device).toEqual(register)
  })
})

describe('la pantalla de cocina no vence por inactividad', () => {
  const UN_DIA = 24 * 60 * 60_000

  it('un equipo kds conserva su sesión aunque pasen días sin uso', async () => {
    const { floor } = await open({ ...register, type: 'kds' })
    const session = floor.instantanea().session as Session
    floor.vencerSesionSiToca(session.lastUsed + 30 * 60_000)
    floor.vencerSesionSiToca(session.lastUsed + 3 * UN_DIA)
    await new Promise((r) => setTimeout(r, 20))
    expect(floor.instantanea().session).toEqual(session)
    expect(floor.instantanea().sessionClosedBy).toBeNull()
  })

  it('un equipo común sí vence al pasar el tiempo (control de la prueba anterior)', async () => {
    const { floor } = await open({ ...register, type: 'waiter' })
    const session = floor.instantanea().session as Session
    floor.vencerSesionSiToca(session.lastUsed + 29 * 60_000)
    expect(floor.instantanea().session).not.toBeNull()
    floor.vencerSesionSiToca(session.lastUsed + 30 * 60_000)
    await new Promise((r) => setTimeout(r, 20))
    expect(floor.instantanea().session).toBeNull()
    expect(floor.instantanea().sessionClosedBy).toBe('inactivity')
  })

  it('una caja tampoco es una pantalla: vence igual', async () => {
    const { floor } = await open({ ...register, type: 'register' })
    const session = floor.instantanea().session as Session
    floor.vencerSesionSiToca(session.lastUsed + UN_DIA)
    await new Promise((r) => setTimeout(r, 20))
    expect(floor.instantanea().session).toBeNull()
  })

  it('al reabrir la app con la sesión de ayer, la pantalla sigue abierta (no pide PIN)', async () => {
    const old: Session = { ...adminSession(), lastUsed: Date.now() - 2 * UN_DIA }
    const { floor } = await open({ ...register, type: 'kds' }, old)
    expect(floor.instantanea().session).toEqual(old)
  })

  it('al reabrir la app, un equipo común con sesión de ayer ya no la tiene', async () => {
    const old: Session = { ...adminSession(), lastUsed: Date.now() - 2 * UN_DIA }
    const { floor } = await open({ ...register, type: 'waiter' }, old)
    await new Promise((r) => setTimeout(r, 20))
    expect(floor.instantanea().session).toBeNull()
  })

  it('un kds con una carta que dice 1 minuto de inactividad tampoco vence', async () => {
    const db = new BaseDispositivo(`prueba-${newId()}`)
    bases.push(db)
    await db.saveSetting('device', { ...register, type: 'kds' })
    const session = adminSession()
    await db.saveSetting('session', session)
    await db.saveSetting(
      'catalog',
      catalogoDePrueba({ restaurant: { name: 'P', sessionIdleMin: 1 } }),
    )
    const floor = new Sala({ db, open: sinRed })
    salas.push(floor)
    await floor.load()
    floor.vencerSesionSiToca(session.lastUsed + 60 * 60_000)
    expect(floor.instantanea().session).toEqual(session)
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
      { job_id: 'ID-TRAB' },
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
      { yellow: 8, red: 16 },
    ],
  ])('%s llama a %s con la sesión y el token del equipo', async (_, makeCall, url, extra) => {
    const calls = hubFalso(() => json({ id: 'ID', job_id: 'T' }))
    const { floor, session } = await open()
    await makeCall(floor)
    const l = calls.find((x) => x.url === url)
    expect(l).toMatchObject({
      httpMethod: 'POST',
      token: 'token-caja',
      body: { session_id: session?.sessionId, secret: 'secreto-admin', ...extra },
    })
  })

  it('guardarImpresora devuelve el id que dio el hub', async () => {
    hubFalso(() => json({ id: 'ID-NUEVA' }))
    const { floor } = await open()
    await expect(floor.savePrinter(printer)).resolves.toBe('ID-NUEVA')
  })

  it('un error del hub llega con su mensaje; una sesión inválida cierra la sesión', async () => {
    hubFalso(() => json({ error: 'invalid_data', message: 'Esa estación no existe' }, 400))
    const { floor } = await open()
    await expect(floor.savePrinter(printer)).rejects.toMatchObject({
      code: 'invalid_data',
      message: 'Esa estación no existe',
    })
    expect(floor.instantanea().session).not.toBeNull()
    hubFalso(() => json({ error: 'invalid_session', message: 'Vuelve a entrar' }, 401))
    await expect(floor.kitchenTimers(1, 2)).rejects.toMatchObject({ code: 'invalid_session' })
    expect(floor.instantanea().session).toBeNull()
  })

  it('sin sesión ninguna llamada sale', async () => {
    const calls = hubFalso(() => json({}))
    const { floor } = await open(register, null)
    await expect(floor.kitchenConfig()).rejects.toThrow('Sin sesión')
    await expect(floor.kitchenTimers(1, 2)).rejects.toThrow('Sin sesión')
    expect(calls.filter((l) => l.url.startsWith('/api/kitchen'))).toEqual([])
  })
})

// ── Aviso de impresoras y hora del hub, con un hub de verdad ─────────────

const openAccess: AccessControl = {
  verify: () => ({ ok: true, authorizedById: null, authorizationId: null }),
  recordUse: () => {},
}

function setupHub(desfaseHubMs = 0) {
  const tokens = new Map<string, Device>()
  const hub = new HubSync(new MemoryStore(), {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-test',
    clock: () => new Date(Date.now() + desfaseHubMs).toISOString(),
    access: openAccess,
  })
  const salaHub = new FloorSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { deviceId: e.deviceId, type: e.type, revokedAt: null } : null
  })
  const abrirCanal = (m: Handlers): Channel => {
    let link: ReturnType<FloorSync['connect']> | null = null
    setTimeout(() => {
      link = salaHub.connect((msg) => {
        const copy = JSON.parse(JSON.stringify(msg))
        setTimeout(() => link && m.onMessage(copy))
      })
      m.onOpen()
    })
    return {
      send: (msg) => link?.receive(JSON.parse(JSON.stringify(msg))),
      close: () => {
        link?.close()
        link = null
      },
    }
  }
  return { hub, tokens, salaHub, abrirCanal }
}

async function conectada(h: ReturnType<typeof setupHub>, device: Device = register) {
  h.tokens.set(device.token, device)
  const db = new BaseDispositivo(`prueba-${newId()}`)
  bases.push(db)
  await db.saveSetting('device', device)
  await db.saveSetting('session', adminSession())
  await db.saveSetting('catalog', catalogoDePrueba())
  const floor = new Sala({ db, open: h.abrirCanal })
  salas.push(floor)
  await floor.load()
  return floor
}

async function wait(condicion: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!condicion()) {
    if (Date.now() > end) throw new Error('No se cumplió a tiempo')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Espera a que la sala termine de procesar lo que traía (el contador de cambios deja de subir). */
async function asentar(floor: Sala) {
  let latest = -1
  let quietos = 0
  while (quietos < 4) {
    await floor.sync?.ready()
    await new Promise((r) => setTimeout(r, 25))
    const now = floor.instantanea().changes
    quietos = now === latest ? quietos + 1 : 0
    latest = now
  }
}

const statuses = (...names: string[]): PrinterStatus[] =>
  names.map((name, i) => ({
    id: newId(),
    name,
    status: i === 0 ? 'failed' : 'ready',
    error: i === 0 ? 'La impresora no responde' : null,
    pendingList: i === 0 ? 2 : 0,
  }))

describe('mensaje «impresoras»', () => {
  it('la instantánea empieza vacía', async () => {
    const { floor } = await open()
    expect(floor.instantanea().printers).toEqual([])
  })

  it('actualiza la instantánea cada vez que el hub avisa, y avisa a la pantalla', async () => {
    const h = setupHub()
    const floor = await conectada(h)
    await wait(() => floor.instantanea().connection === 'connected')
    let alerts = 0
    floor.suscribir(() => {
      alerts += 1
    })
    const firstOne = statuses('Barra', 'Cocina')
    h.salaHub.notifyPrinters(firstOne)
    await wait(() => floor.instantanea().printers.length === 2)
    expect(floor.instantanea().printers).toEqual(firstOne)
    expect(alerts).toBeGreaterThan(0)

    const sano = firstOne.map((e) => ({
      ...e,
      status: 'ready' as const,
      error: null,
      pendingList: 0,
    }))
    h.salaHub.notifyPrinters(sano)
    await wait(() => floor.instantanea().printers[0]?.status === 'ready')
    expect(floor.instantanea().printers).toEqual(sano)

    h.salaHub.notifyPrinters([])
    await wait(() => floor.instantanea().printers.length === 0)
  })

  it('un equipo que se conecta después recibe el último estado', async () => {
    const h = setupHub()
    const latest = statuses('Barra')
    h.salaHub.notifyPrinters(latest)
    const floor = await conectada(h)
    await wait(() => floor.instantanea().printers.length === 1)
    expect(floor.instantanea().printers).toEqual(latest)
  })

  it('el aviso no cambia lo guardado ni los pendientes del equipo', async () => {
    const h = setupHub()
    const floor = await conectada(h)
    await wait(() => floor.instantanea().connection === 'connected')
    await asentar(floor)
    const before = {
      pendingList: floor.instantanea().pendingList,
      changes: floor.instantanea().changes,
    }
    h.salaHub.notifyPrinters(statuses('Cocina'))
    await wait(() => floor.instantanea().printers.length === 1)
    expect(floor.instantanea().pendingList).toBe(before.pendingList)
    expect(floor.instantanea().changes).toBe(before.changes)
    expect(await floor.sync?.locals()).toEqual([])
  })

  it('quien está sin conexión conserva el último estado conocido', async () => {
    const h = setupHub()
    const floor = await conectada(h)
    await wait(() => floor.instantanea().connection === 'connected')
    const latest = statuses('Cocina')
    h.salaHub.notifyPrinters(latest)
    await wait(() => floor.instantanea().printers.length === 1)
    floor.simularSinConexion(true)
    expect(floor.instantanea().printers).toEqual(latest)
  })
})

describe('Sala.ahoraHub', () => {
  it('sin conexión usa la hora del equipo', async () => {
    const { floor } = await open()
    expect(floor.ahoraHub(123_456)).toBe(123_456)
  })

  it('con el hub adelantado 5 minutos, la hora del hub va 5 minutos adelante de la del equipo', async () => {
    const h = setupHub(5 * 60_000)
    const floor = await conectada(h)
    await wait(() => Math.abs(floor.ahoraHub() - Date.now() - 5 * 60_000) < 2000)
    expect(floor.ahoraHub() - Date.now()).toBeGreaterThan(5 * 60_000 - 2000)
  })

  it('con el equipo adelantado respecto al hub, la hora del hub va atrás', async () => {
    const h = setupHub(-3 * 60_000)
    const floor = await conectada(h)
    await wait(() => Math.abs(floor.ahoraHub() - Date.now() + 3 * 60_000) < 2000)
    expect(floor.ahoraHub() - Date.now()).toBeLessThan(-3 * 60_000 + 2000)
  })
})
