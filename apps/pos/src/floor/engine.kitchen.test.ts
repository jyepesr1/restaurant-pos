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
import { type Device, Floor, type Session } from './engine'
import { DeviceDatabase } from './store'
import { testCatalog } from './testing'

// The app engine with the kitchen (ADR-015): turning a device into a screen, a screen not
// expiring from inactivity, the «Cocina e impresoras» calls and the printers notice.

const floors: Floor[] = []
const databases: DeviceDatabase[] = []
afterEach(async () => {
  for (const s of floors.splice(0)) s.simulateOffline(true)
  vi.unstubAllGlobals()
  await new Promise((r) => setTimeout(r, 20))
  for (const b of databases.splice(0)) await b.delete()
})

const noNetwork = (): Channel => ({ send: () => {}, close: () => {} })
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Call {
  url: string
  httpMethod: string
  body: Record<string, unknown> | null
  token: string | null
}

/** The hub as a fake `fetch`: records each call and responds whatever `respond` says. */
function fakeHub(respond: (call: Call) => Response) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const call: Call = {
        url,
        httpMethod: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
        token: headers.authorization?.replace('Bearer ', '') ?? null,
      }
      calls.push(call)
      if (url === '/api/catalog') return json(testCatalog({ version: 9 }))
      return respond(call)
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

/** A floor with that device and that session already stored, without network. */
async function open(device: Device = register, session: Session | null = adminSession()) {
  const db = new DeviceDatabase(`prueba-${newId()}`)
  databases.push(db)
  await db.saveSetting('device', device)
  if (session) await db.saveSetting('session', session)
  await db.saveSetting('catalog', testCatalog())
  const floor = new Floor({ db, open: noNetwork })
  floors.push(floor)
  await floor.load()
  return { floor, db, session }
}

const screenResponse = () => ({
  session_id: newId(),
  secret: 'secreto-pantalla',
  user: { id: newId(), name: 'Cocina', role: 'Pantalla de cocina' },
  permissions: ['mark_product_sold_out', 'mark_preparation'],
  type: 'kds',
})

describe('Floor.convertToScreen', () => {
  it('sends the admin session, the name and the stations, with the device token', async () => {
    const calls = fakeHub(() => json(screenResponse(), 201))
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

  it('stores the device as kds, with its new name, and remembers it after restarting', async () => {
    fakeHub(() => json(screenResponse(), 201))
    const { floor, db } = await open()
    await floor.convertToScreen('Cocina caliente', ['E-COCINA'])
    const expected = { ...register, type: 'kds', name: 'Cocina caliente' }
    expect(floor.snapshot().device).toEqual(expected)
    expect(await db.readSetting<Device>('device')).toEqual(expected)
    const reopenedInstance = new Floor({ db, open: noNetwork })
    floors.push(reopenedInstance)
    await reopenedInstance.load()
    expect(reopenedInstance.snapshot().device).toEqual(expected)
  })

  it('replaces the admin session with the screen one, stored and with no inactivity error', async () => {
    const r = screenResponse()
    fakeHub(() => json(r, 201))
    const { floor, db } = await open()
    const before = Date.now()
    await floor.convertToScreen('Cocina', ['E-COCINA'])
    const session = floor.snapshot().session
    expect(session).toMatchObject({
      sessionId: r.session_id,
      secret: 'secreto-pantalla',
      user: r.user,
      permissions: ['mark_product_sold_out', 'mark_preparation'],
    })
    expect(session?.lastUsed).toBeGreaterThanOrEqual(before)
    expect(await db.readSetting<Session>('session')).toEqual(session)
    expect(floor.snapshot().sessionClosedBy).toBeNull()
  })

  it('requests the menu again when done', async () => {
    const calls = fakeHub(() => json(screenResponse(), 201))
    const { floor } = await open()
    const before = calls.filter((l) => l.url === '/api/catalog').length
    await floor.convertToScreen('Cocina', ['E-COCINA'])
    expect(calls.filter((l) => l.url === '/api/catalog').length).toBeGreaterThan(before)
    expect(floor.snapshot().catalog?.version).toBe(9)
  })

  it('if the menu fails afterwards, it is still converted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/screens') return json(screenResponse(), 201)
        throw new TypeError('Failed to fetch')
      }),
    )
    const { floor } = await open()
    await expect(floor.convertToScreen('Cocina', ['E-COCINA'])).resolves.toBeUndefined()
    expect(floor.snapshot().device?.type).toBe('kds')
  })

  it.each([
    ['no permission (403)', 403, 'no_permission'],
    ['invalid data (400)', 400, 'invalid_data'],
  ])(
    'if the hub says %s, the device and the session stay as they were',
    async (_, status, error) => {
      fakeHub(() => json({ error, message: 'No se pudo' }, status))
      const { floor, db, session } = await open()
      await expect(floor.convertToScreen('Cocina', ['E-COCINA'])).rejects.toMatchObject({
        code: error,
        message: 'No se pudo',
      })
      expect(floor.snapshot().device).toEqual(register)
      expect(floor.snapshot().session).toEqual(session)
      expect(await db.readSetting<Device>('device')).toEqual(register)
      expect(await db.readSetting<Session>('session')).toEqual(session)
    },
  )

  it('without a connection to the register nothing changes', async () => {
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
    expect(floor.snapshot().device).toEqual(register)
    expect(floor.snapshot().session).toEqual(session)
  })

  it('without a session it does not call the hub', async () => {
    const calls = fakeHub(() => json(screenResponse(), 201))
    const { floor } = await open(register, null)
    await expect(floor.convertToScreen('Cocina', ['E-COCINA'])).rejects.toThrow('Sin sesión')
    expect(calls.filter((l) => l.url === '/api/screens')).toEqual([])
  })

  it('if the hub says the session is no longer valid, the local session is closed', async () => {
    fakeHub(() => json({ error: 'invalid_session', message: 'La sesión se cerró' }, 401))
    const { floor } = await open()
    await expect(floor.convertToScreen('Cocina', ['E-COCINA'])).rejects.toMatchObject({
      code: 'invalid_session',
    })
    expect(floor.snapshot().session).toBeNull()
    expect(floor.snapshot().device).toEqual(register)
  })
})

describe('the kitchen screen does not expire from inactivity', () => {
  const ONE_DAY = 24 * 60 * 60_000

  it('a kds device keeps its session even after days without use', async () => {
    const { floor } = await open({ ...register, type: 'kds' })
    const session = floor.snapshot().session as Session
    floor.expireSessionIfDue(session.lastUsed + 30 * 60_000)
    floor.expireSessionIfDue(session.lastUsed + 3 * ONE_DAY)
    await new Promise((r) => setTimeout(r, 20))
    expect(floor.snapshot().session).toEqual(session)
    expect(floor.snapshot().sessionClosedBy).toBeNull()
  })

  it('a regular device does expire as time passes (control for the previous test)', async () => {
    const { floor } = await open({ ...register, type: 'waiter' })
    const session = floor.snapshot().session as Session
    floor.expireSessionIfDue(session.lastUsed + 29 * 60_000)
    expect(floor.snapshot().session).not.toBeNull()
    floor.expireSessionIfDue(session.lastUsed + 30 * 60_000)
    await new Promise((r) => setTimeout(r, 20))
    expect(floor.snapshot().session).toBeNull()
    expect(floor.snapshot().sessionClosedBy).toBe('inactivity')
  })

  it('a register is not a screen either: it expires all the same', async () => {
    const { floor } = await open({ ...register, type: 'register' })
    const session = floor.snapshot().session as Session
    floor.expireSessionIfDue(session.lastUsed + ONE_DAY)
    await new Promise((r) => setTimeout(r, 20))
    expect(floor.snapshot().session).toBeNull()
  })

  it('when reopening the app with a session from yesterday, the screen stays open (no PIN asked)', async () => {
    const old: Session = { ...adminSession(), lastUsed: Date.now() - 2 * ONE_DAY }
    const { floor } = await open({ ...register, type: 'kds' }, old)
    expect(floor.snapshot().session).toEqual(old)
  })

  it('when reopening the app, a regular device with a session from yesterday no longer has it', async () => {
    const old: Session = { ...adminSession(), lastUsed: Date.now() - 2 * ONE_DAY }
    const { floor } = await open({ ...register, type: 'waiter' }, old)
    await new Promise((r) => setTimeout(r, 20))
    expect(floor.snapshot().session).toBeNull()
  })

  it('a kds with a menu that says 1 minute of inactivity does not expire either', async () => {
    const db = new DeviceDatabase(`prueba-${newId()}`)
    databases.push(db)
    await db.saveSetting('device', { ...register, type: 'kds' })
    const session = adminSession()
    await db.saveSetting('session', session)
    await db.saveSetting('catalog', testCatalog({ restaurant: { name: 'P', sessionIdleMin: 1 } }))
    const floor = new Floor({ db, open: noNetwork })
    floors.push(floor)
    await floor.load()
    floor.expireSessionIfDue(session.lastUsed + 60 * 60_000)
    expect(floor.snapshot().session).toEqual(session)
  })
})

describe('«Cocina e impresoras» calls', () => {
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
    ['kitchenConfig', (s: Floor) => s.kitchenConfig(), '/api/kitchen/config', {}],
    ['savePrinter', (s: Floor) => s.savePrinter(printer), '/api/printers', { printer }],
    [
      'testPrinter',
      (s: Floor) => s.testPrinter('ID-IMP'),
      '/api/printers/test',
      { printer_id: 'ID-IMP' },
    ],
    ['pendingPrints', (s: Floor) => s.pendingPrints(), '/api/printing/pending', {}],
    [
      'discardJob',
      (s: Floor) => s.discardJob('ID-TRAB'),
      '/api/printing/discard',
      { job_id: 'ID-TRAB' },
    ],
    [
      'screenStations',
      (s: Floor) => s.screenStations('ID-DISP', ['E-COCINA']),
      '/api/screens/stations',
      { device_id: 'ID-DISP', station_ids: ['E-COCINA'] },
    ],
    [
      'kitchenTimers',
      (s: Floor) => s.kitchenTimers(8, 16),
      '/api/kitchen/timers',
      { yellow: 8, red: 16 },
    ],
  ])('%s calls %s with the session and the device token', async (_, makeCall, url, extra) => {
    const calls = fakeHub(() => json({ id: 'ID', job_id: 'T' }))
    const { floor, session } = await open()
    await makeCall(floor)
    const l = calls.find((x) => x.url === url)
    expect(l).toMatchObject({
      httpMethod: 'POST',
      token: 'token-caja',
      body: { session_id: session?.sessionId, secret: 'secreto-admin', ...extra },
    })
  })

  it('savePrinter returns the id the hub gave', async () => {
    fakeHub(() => json({ id: 'ID-NUEVA' }))
    const { floor } = await open()
    await expect(floor.savePrinter(printer)).resolves.toBe('ID-NUEVA')
  })

  it('a hub error arrives with its message; an invalid session closes the session', async () => {
    fakeHub(() => json({ error: 'invalid_data', message: 'Esa estación no existe' }, 400))
    const { floor } = await open()
    await expect(floor.savePrinter(printer)).rejects.toMatchObject({
      code: 'invalid_data',
      message: 'Esa estación no existe',
    })
    expect(floor.snapshot().session).not.toBeNull()
    fakeHub(() => json({ error: 'invalid_session', message: 'Vuelve a entrar' }, 401))
    await expect(floor.kitchenTimers(1, 2)).rejects.toMatchObject({ code: 'invalid_session' })
    expect(floor.snapshot().session).toBeNull()
  })

  it('without a session no call goes out', async () => {
    const calls = fakeHub(() => json({}))
    const { floor } = await open(register, null)
    await expect(floor.kitchenConfig()).rejects.toThrow('Sin sesión')
    await expect(floor.kitchenTimers(1, 2)).rejects.toThrow('Sin sesión')
    expect(calls.filter((l) => l.url.startsWith('/api/kitchen'))).toEqual([])
  })
})

// ── Printers notice and hub time, with a real hub ────────────────────────

const openAccess: AccessControl = {
  verify: () => ({ ok: true, authorizedById: null, authorizationId: null }),
  recordUse: () => {},
}

function setupHub(hubOffsetMs = 0) {
  const tokens = new Map<string, Device>()
  const hub = new HubSync(new MemoryStore(), {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-test',
    clock: () => new Date(Date.now() + hubOffsetMs).toISOString(),
    access: openAccess,
  })
  const hubFloor = new FloorSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { deviceId: e.deviceId, type: e.type, revokedAt: null } : null
  })
  const openChannel = (m: Handlers): Channel => {
    let link: ReturnType<FloorSync['connect']> | null = null
    setTimeout(() => {
      link = hubFloor.connect((msg) => {
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
  return { hub, tokens, hubFloor, openChannel }
}

async function isConnected(h: ReturnType<typeof setupHub>, device: Device = register) {
  h.tokens.set(device.token, device)
  const db = new DeviceDatabase(`prueba-${newId()}`)
  databases.push(db)
  await db.saveSetting('device', device)
  await db.saveSetting('session', adminSession())
  await db.saveSetting('catalog', testCatalog())
  const floor = new Floor({ db, open: h.openChannel })
  floors.push(floor)
  await floor.load()
  return floor
}

async function wait(condition: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error('Condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Waits for the floor to finish processing what it brought (the change counter stops rising). */
async function settle(floor: Floor) {
  let latest = -1
  let idleTicks = 0
  while (idleTicks < 4) {
    await floor.sync?.ready()
    await new Promise((r) => setTimeout(r, 25))
    const now = floor.snapshot().changes
    idleTicks = now === latest ? idleTicks + 1 : 0
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

describe('«printers» message', () => {
  it('the snapshot starts empty', async () => {
    const { floor } = await open()
    expect(floor.snapshot().printers).toEqual([])
  })

  it('updates the snapshot every time the hub notifies, and notifies the screen', async () => {
    const h = setupHub()
    const floor = await isConnected(h)
    await wait(() => floor.snapshot().connection === 'connected')
    let alerts = 0
    floor.subscribe(() => {
      alerts += 1
    })
    const firstOne = statuses('Barra', 'Cocina')
    h.hubFloor.notifyPrinters(firstOne)
    await wait(() => floor.snapshot().printers.length === 2)
    expect(floor.snapshot().printers).toEqual(firstOne)
    expect(alerts).toBeGreaterThan(0)

    const healthy = firstOne.map((e) => ({
      ...e,
      status: 'ready' as const,
      error: null,
      pendingList: 0,
    }))
    h.hubFloor.notifyPrinters(healthy)
    await wait(() => floor.snapshot().printers[0]?.status === 'ready')
    expect(floor.snapshot().printers).toEqual(healthy)

    h.hubFloor.notifyPrinters([])
    await wait(() => floor.snapshot().printers.length === 0)
  })

  it('a device that connects later receives the latest status', async () => {
    const h = setupHub()
    const latest = statuses('Barra')
    h.hubFloor.notifyPrinters(latest)
    const floor = await isConnected(h)
    await wait(() => floor.snapshot().printers.length === 1)
    expect(floor.snapshot().printers).toEqual(latest)
  })

  it('the notice does not change what the device has stored or its pending events', async () => {
    const h = setupHub()
    const floor = await isConnected(h)
    await wait(() => floor.snapshot().connection === 'connected')
    await settle(floor)
    const before = {
      pendingList: floor.snapshot().pendingList,
      changes: floor.snapshot().changes,
    }
    h.hubFloor.notifyPrinters(statuses('Cocina'))
    await wait(() => floor.snapshot().printers.length === 1)
    expect(floor.snapshot().pendingList).toBe(before.pendingList)
    expect(floor.snapshot().changes).toBe(before.changes)
    expect(await floor.sync?.locals()).toEqual([])
  })

  it('whoever is offline keeps the last known status', async () => {
    const h = setupHub()
    const floor = await isConnected(h)
    await wait(() => floor.snapshot().connection === 'connected')
    const latest = statuses('Cocina')
    h.hubFloor.notifyPrinters(latest)
    await wait(() => floor.snapshot().printers.length === 1)
    floor.simulateOffline(true)
    expect(floor.snapshot().printers).toEqual(latest)
  })
})

describe('Floor.hubNow', () => {
  it('offline it uses the device time', async () => {
    const { floor } = await open()
    expect(floor.hubNow(123_456)).toBe(123_456)
  })

  it('with the hub 5 minutes ahead, the hub time is 5 minutes ahead of the device time', async () => {
    const h = setupHub(5 * 60_000)
    const floor = await isConnected(h)
    await wait(() => Math.abs(floor.hubNow() - Date.now() - 5 * 60_000) < 2000)
    expect(floor.hubNow() - Date.now()).toBeGreaterThan(5 * 60_000 - 2000)
  })

  it('with the device ahead of the hub, the hub time is behind', async () => {
    const h = setupHub(-3 * 60_000)
    const floor = await isConnected(h)
    await wait(() => Math.abs(floor.hubNow() - Date.now() + 3 * 60_000) < 2000)
    expect(floor.hubNow() - Date.now()).toBeLessThan(-3 * 60_000 + 2000)
  })
})
