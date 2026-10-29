import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import {
  type AccessControl,
  type Channel,
  type CloudStatus,
  FloorSync,
  type Handlers,
  HubSync,
  MemoryStore,
} from '@pos/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Device, Floor, type Session } from './engine'
import { DeviceDatabase } from './store'
import { testCatalog } from './testing'

// The app engine with the cloud (task 1.11): the `cloud` message the hub sends, the status
// call and the connection with the code, with a fake `fetch` and a real in-memory hub.

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

const register: Device = { deviceId: newId(), token: 'token-caja', name: 'Caja', type: 'register' }
const adminSession = (): Session => ({
  sessionId: newId(),
  secret: 'secreto-admin',
  user: { id: newId(), name: 'Administrador', role: 'Administrador' },
  permissions: ['manage_devices', 'take_order'],
  lastUsed: Date.now(),
})

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

const STATUS: CloudStatus = { state: 'up_to_date', pending: 0, last_upload_at: null }

describe('Floor.cloudStatus', () => {
  it('asks the hub with the session and the device token, and keeps the answer in the snapshot', async () => {
    const calls = fakeHub(() => json(STATUS))
    const { floor, session } = await open()
    expect(floor.snapshot().cloud).toBeNull()
    expect(await floor.cloudStatus()).toEqual(STATUS)
    expect(calls.find((c) => c.url === '/api/cloud/status')).toMatchObject({
      httpMethod: 'POST',
      token: 'token-caja',
      body: { session_id: session?.sessionId, secret: 'secreto-admin' },
    })
    expect(floor.snapshot().cloud).toEqual(STATUS)
  })

  it('tells the screen it changed', async () => {
    fakeHub(() => json(STATUS))
    const { floor } = await open()
    let alerts = 0
    floor.subscribe(() => {
      alerts += 1
    })
    await floor.cloudStatus()
    expect(alerts).toBeGreaterThan(0)
  })

  it('without a session no call goes out', async () => {
    const calls = fakeHub(() => json(STATUS))
    const { floor } = await open(register, null)
    await expect(floor.cloudStatus()).rejects.toThrow('Sin sesión')
    expect(calls.filter((c) => c.url.startsWith('/api/cloud'))).toEqual([])
    expect(floor.snapshot().cloud).toBeNull()
  })

  it('an error leaves the last known status untouched', async () => {
    fakeHub(() => json(STATUS))
    const { floor } = await open()
    await floor.cloudStatus()
    fakeHub(() => json({ error: 'no_permission', message: 'No tienes permiso' }, 403))
    await expect(floor.cloudStatus()).rejects.toMatchObject({ code: 'no_permission' })
    expect(floor.snapshot().cloud).toEqual(STATUS)
  })

  it('with the hub unreachable it says so in Spanish and keeps what it had', async () => {
    fakeHub(() => json(STATUS))
    const { floor } = await open()
    await floor.cloudStatus()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    await expect(floor.cloudStatus()).rejects.toMatchObject({ code: 'offline' })
    expect(floor.snapshot().cloud).toEqual(STATUS)
  })

  it('an expired session closes it, like every other call', async () => {
    fakeHub(() => json({ error: 'invalid_session', message: 'Vuelve a entrar' }, 401))
    const { floor } = await open()
    await expect(floor.cloudStatus()).rejects.toMatchObject({ code: 'invalid_session' })
    expect(floor.snapshot().session).toBeNull()
  })
})

describe('Floor.connectCloud', () => {
  it('sends the code as typed with the session, and shows the status that comes back', async () => {
    const connected: CloudStatus = { state: 'uploading', pending: 8, last_upload_at: null }
    const calls = fakeHub(() => json(connected))
    const { floor, session } = await open()
    expect(await floor.connectCloud('K7PM-QX2R-9DHT')).toEqual(connected)
    expect(calls.find((c) => c.url === '/api/cloud/register')).toMatchObject({
      httpMethod: 'POST',
      token: 'token-caja',
      body: { session_id: session?.sessionId, secret: 'secreto-admin', code: 'K7PM-QX2R-9DHT' },
    })
    expect(floor.snapshot().cloud).toEqual(connected)
  })

  it.each([
    ['invalid_code', 400, 'El código no existe, ya se usó o venció. Revísalo o pide uno nuevo.'],
    ['other_restaurant', 400, 'Ese código es de otro restaurante. Pide uno para este restaurante.'],
    ['already_connected', 409, 'Este PC de caja ya está conectado a la nube.'],
    [
      'offline',
      503,
      'No hay conexión con la nube. Revisa el internet del PC de caja e intenta de nuevo.',
    ],
    ['cloud_error', 503, 'La nube tuvo un problema. Intenta de nuevo en unos minutos.'],
  ])(
    '%s: the hub message reaches the screen as it is and nothing changes',
    async (code, status, message) => {
      fakeHub(() => json({ error: code, message }, status))
      const { floor } = await open()
      await expect(floor.connectCloud('AAAA-BBBB-CCCC')).rejects.toMatchObject({ code, message })
      expect(floor.snapshot().cloud).toBeNull()
      expect(floor.snapshot().session).not.toBeNull()
    },
  )

  it('a reply with no message body still says something in Spanish', async () => {
    fakeHub(() => new Response('<html>', { status: 502 }))
    const { floor } = await open()
    await expect(floor.connectCloud('AAAA-BBBB-CCCC')).rejects.toThrow(
      /La caja respondió con un error/,
    )
  })

  it('without a session, or with the simulated outage, no call goes out', async () => {
    const calls = fakeHub(() => json(STATUS))
    const closed = await open(register, null)
    await expect(closed.floor.connectCloud('AAAA')).rejects.toThrow('Sin sesión')
    const { floor } = await open()
    floor.simulateOffline(true)
    await expect(floor.connectCloud('AAAA')).rejects.toMatchObject({ code: 'offline' })
    expect(calls.filter((c) => c.url.startsWith('/api/cloud'))).toEqual([])
  })

  it('the code is not kept anywhere in the snapshot', async () => {
    fakeHub(() => json(STATUS))
    const { floor } = await open()
    await floor.connectCloud('K7PM-QX2R-9DHT')
    expect(JSON.stringify(floor.snapshot())).not.toContain('K7PM-QX2R-9DHT')
  })
})

// ── The «cloud» message, with a real hub ─────────────────────────────────

const openAccess: AccessControl = {
  verify: () => ({ ok: true, authorizedById: null, authorizationId: null }),
  recordUse: () => {},
}

function setupHub() {
  const tokens = new Map<string, Device>()
  const hub = new HubSync(new MemoryStore(), {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-test',
    clock: () => new Date().toISOString(),
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
  return { tokens, hubFloor, openChannel }
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

describe('«cloud» message', () => {
  it('the snapshot starts without knowing', async () => {
    const { floor } = await open()
    expect(floor.snapshot().cloud).toBeNull()
  })

  it('updates the snapshot every time the hub notifies, and notifies the screen', async () => {
    fakeHub(() => json({}))
    const h = setupHub()
    const floor = await isConnected(h)
    await wait(() => floor.snapshot().connection === 'connected')
    let alerts = 0
    floor.subscribe(() => {
      alerts += 1
    })
    const states: CloudStatus[] = [
      { state: 'offline', pending: 3, last_upload_at: null },
      { state: 'uploading', pending: 2, last_upload_at: '2026-10-29T15:00:00.000Z' },
      { state: 'stuck', pending: 2, last_upload_at: '2026-10-29T15:00:00.000Z' },
      { state: 'revoked', pending: 9, last_upload_at: '2026-10-29T15:00:00.000Z' },
    ]
    for (const s of states) {
      h.hubFloor.notifyCloud(s)
      await wait(() => floor.snapshot().cloud?.state === s.state)
      expect(floor.snapshot().cloud).toEqual(s)
    }
    expect(alerts).toBeGreaterThan(0)
  })

  it('a device that connects later receives the latest status', async () => {
    fakeHub(() => json({}))
    const h = setupHub()
    h.hubFloor.notifyCloud({ state: 'offline', pending: 1, last_upload_at: null })
    h.hubFloor.notifyCloud({ state: 'up_to_date', pending: 0, last_upload_at: null })
    const floor = await isConnected(h)
    await wait(() => floor.snapshot().cloud !== null)
    expect(floor.snapshot().cloud).toEqual({
      state: 'up_to_date',
      pending: 0,
      last_upload_at: null,
    })
  })

  it("works on any kind of device, a waiter's phone included (the screen decides who sees it)", async () => {
    fakeHub(() => json({}))
    const h = setupHub()
    h.hubFloor.notifyCloud(STATUS)
    const waiter: Device = {
      deviceId: newId(),
      token: 'token-mesero',
      name: 'Celular',
      type: 'waiter',
    }
    const floor = await isConnected(h, waiter)
    await wait(() => floor.snapshot().cloud !== null)
    expect(floor.snapshot().cloud).toEqual(STATUS)
  })

  it('does not touch the orders, the pending events or the catalog', async () => {
    fakeHub(() => json({}))
    const h = setupHub()
    const floor = await isConnected(h)
    await wait(() => floor.snapshot().connection === 'connected')
    // The menu the hub brings on connecting has to be in before looking at what stays the same.
    await wait(() => floor.snapshot().catalog?.version === 9)
    const before = { ...floor.snapshot() }
    h.hubFloor.notifyCloud({ state: 'offline', pending: 4, last_upload_at: null })
    await wait(() => floor.snapshot().cloud !== null)
    const after = floor.snapshot()
    expect(after.catalog).toEqual(before.catalog)
    expect(after.pendingList).toEqual(before.pendingList)
    expect(after.session).toEqual(before.session)
  })

  it('when the link to the hub is lost the last status stays in the snapshot (the frame hides it)', async () => {
    fakeHub(() => json({}))
    const h = setupHub()
    const floor = await isConnected(h)
    await wait(() => floor.snapshot().connection === 'connected')
    h.hubFloor.notifyCloud(STATUS)
    await wait(() => floor.snapshot().cloud !== null)
    floor.simulateOffline(true)
    await wait(() => floor.snapshot().connection !== 'connected')
    expect(floor.snapshot().cloud).toEqual(STATUS)
  })
})
