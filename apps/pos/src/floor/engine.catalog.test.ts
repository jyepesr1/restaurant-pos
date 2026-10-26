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
import { type Device, Floor, type Session } from './engine'
import { DeviceDatabase } from './store'
import { testCatalog } from './testing'

// The menu is requested again when the hub announces it changed (`catalog` message) and on
// reconnecting; an odd, old or failed response never replaces the good saved menu. In-memory hub,
// simulated HTTP: no fixed waits and no real network.

const TOKEN = 'token-del-equipo'

interface Call {
  httpMethod: string
  route: string
  token: string | null
  body: unknown
  respond: (r: Response | Error) => void
  answered?: boolean
}

/** Simulated HTTP: each call stays pending until the test decides what it answers. */
function setupHttp() {
  const calls: Call[] = []
  const fakeFetch = vi.fn((route: string, init: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const headers = (init.headers ?? {}) as Record<string, string>
      calls.push({
        httpMethod: String(init.method),
        route,
        token: headers.authorization?.replace('Bearer ', '') ?? null,
        body: init.body ? JSON.parse(String(init.body)) : null,
        respond: (r) => (r instanceof Error ? reject(r) : resolve(r)),
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
    fakeFetch,
    json,
    menus: () => calls.filter((l) => l.httpMethod === 'GET' && l.route === '/api/catalog'),
    /** Answers all pending menu requests with that version. */
    respondMenus(version: number) {
      const pendingList = this.menus().filter((l) => !l.answered)
      for (const l of pendingList) {
        l.answered = true
        l.respond(json(testCatalog({ version })))
      }
    },
  }
}
const noAccess = {
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
    access: noAccess,
  })
  let revokedAt: string | null = null
  const hubFloor = new FloorSync(hub, (token) =>
    token === TOKEN ? { deviceId: device.deviceId, type: 'waiter', revokedAt } : null,
  )
  const h = {
    device,
    hubFloor,
    down: false,
    revoke: () => {
      revokedAt = new Date().toISOString()
      hubFloor.revoke(device.deviceId, revokedAt)
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
        link = hubFloor.connect((msg) => {
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

const floors: Floor[] = []
const databases: DeviceDatabase[] = []
let http: ReturnType<typeof setupHttp>

beforeEach(() => {
  http = setupHttp()
  vi.stubGlobal('fetch', http.fakeFetch)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  for (const s of floors.splice(0)) s.simulateOffline(true)
  // Let background jobs finish before deleting the database.
  await vi.waitFor(() => {}, { timeout: 50 })
  for (const l of http.calls as Call[])
    if (!l.answered) {
      l.answered = true
      l.respond(new Error('end of test'))
    }
  await new Promise((r) => setTimeout(r, 20))
  for (const b of databases.splice(0)) await b.delete()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function device(
  h: ReturnType<typeof setupHub>,
  o: { session?: boolean; version?: number } = {},
) {
  const db = new DeviceDatabase(`catalog-${newId()}`)
  databases.push(db)
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
  await db.saveSetting('catalog', testCatalog({ version: o.version ?? 4 }))
  const floor = new Floor({ db, open: (m) => h.open(m) })
  floors.push(floor)
  await floor.load()
  return { floor, db }
}

const isConnected = (s: Floor) => s.snapshot().connection === 'connected'
const versionOf = (s: Floor) => s.snapshot().catalog?.version
const saved = async (db: DeviceDatabase) => (await db.readSetting<Catalog>('catalog'))?.version

/** Waits until there are `n` menu requests, without a clock: it retries until it holds. */
const menus = (n: number) => vi.waitFor(() => expect(http.menus().length).toBeGreaterThanOrEqual(n))

/** Lets what already arrived finish processing: sends a ping and waits for the pong. */
async function settle(s: Floor) {
  const before = s.snapshot().changes
  await vi.waitFor(() => expect(s.snapshot().changes).toBeGreaterThanOrEqual(before))
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('the hub announces that the menu changed', () => {
  it('the device requests it again with its token, saves it and shows it', async () => {
    const h = setupHub()
    const { floor, db } = await device(h)
    await vi.waitFor(() => expect(isConnected(floor)).toBe(true))
    // On connecting, it requests the menu once; the answer has the same version it already had.
    await menus(1)
    http.respondMenus(4)
    await settle(floor)
    const requested = http.menus().length

    h.hubFloor.notifyCatalog(9)
    await menus(requested + 1)
    const lastRequest = http.menus().at(-1)
    expect(lastRequest?.token).toBe(TOKEN)
    http.respondMenus(9)

    await vi.waitFor(() => expect(versionOf(floor)).toBe(9))
    await vi.waitFor(async () => expect(await saved(db)).toBe(9))
  })

  it('an announcement with the version it already has requests nothing', async () => {
    const h = setupHub()
    const { floor } = await device(h, { version: 7 })
    await vi.waitFor(() => expect(isConnected(floor)).toBe(true))
    await menus(1)
    http.respondMenus(7)
    await settle(floor)
    const requested = http.menus().length
    h.hubFloor.notifyCatalog(7)
    await settle(floor)
    // A later message does arrive: it shows the previous one was already processed.
    h.hubFloor.notifyCatalog(8)
    await menus(requested + 1)
    expect(http.menus()).toHaveLength(requested + 1)
  })

  it('without an open session it does not request the menu (the hub requires a device, not a session, but there is no one to use it)', async () => {
    const h = setupHub()
    const { floor } = await device(h, { session: false })
    await vi.waitFor(() => expect(isConnected(floor)).toBe(true))
    await settle(floor)
    h.hubFloor.notifyCatalog(9)
    await settle(floor)
    expect(http.menus()).toHaveLength(0)
    expect(versionOf(floor)).toBe(4)
  })

  it('the announcement does not count as a data change nor leaves anything pending', async () => {
    const h = setupHub()
    const { floor } = await device(h)
    await vi.waitFor(() => expect(isConnected(floor)).toBe(true))
    await menus(1)
    http.respondMenus(4)
    await settle(floor)
    const before = floor.snapshot()
    h.hubFloor.notifyCatalog(10)
    await menus(2)
    http.respondMenus(10)
    await vi.waitFor(() => expect(versionOf(floor)).toBe(10))
    expect(floor.snapshot().pendingList).toBe(before.pendingList)
    expect(floor.snapshot().changes).toBe(before.changes)
  })

  it('offline when requesting it: the saved menu stays and nothing breaks', async () => {
    const h = setupHub()
    const { floor, db } = await device(h)
    await vi.waitFor(() => expect(isConnected(floor)).toBe(true))
    await menus(1)
    http.respondMenus(4)
    await settle(floor)
    const requested = http.menus().length

    h.hubFloor.notifyCatalog(9)
    await menus(requested + 1)
    ;(http.calls.at(-1) as Call).answered = true
    http.calls.at(-1)?.respond(new TypeError('Failed to fetch'))
    await settle(floor)

    expect(versionOf(floor)).toBe(4)
    expect(await saved(db)).toBe(4)
    expect(floor.snapshot().connection).toBe('connected')
  })

  it.each([
    ['no body (204)', () => new Response(null, { status: 204 })],
    ['an empty object', () => http.json({})],
    ['a list', () => http.json([])],
    ['no tables', () => http.json({ version: 99 })],
    ['the version as text', () => http.json({ version: '99', tables: [] })],
    ['an HTML error page', () => new Response('<html>502</html>', { status: 502 })],
    ['a 401 from the hub', () => http.json({ error: 'invalid_token', message: 'x' }, 401)],
    ['broken JSON', () => new Response('{roto', { status: 200 })],
  ])('if the hub responds with %s, it does not replace the good menu', async (_case, response) => {
    const h = setupHub()
    const { floor, db } = await device(h)
    await vi.waitFor(() => expect(isConnected(floor)).toBe(true))
    await menus(1)
    http.respondMenus(4)
    await settle(floor)
    const requested = http.menus().length

    h.hubFloor.notifyCatalog(9)
    await menus(requested + 1)
    ;(http.calls.at(-1) as Call).answered = true
    http.calls.at(-1)?.respond(response())
    await settle(floor)

    expect(versionOf(floor)).toBe(4)
    expect(floor.snapshot().catalog?.categories).toEqual([])
    expect(await saved(db)).toBe(4)
  })

  it('two announcements in a row and the responses out of order: the newest version stays', async () => {
    const h = setupHub()
    const { floor, db } = await device(h)
    await vi.waitFor(() => expect(isConnected(floor)).toBe(true))
    await menus(1)
    http.respondMenus(4)
    await settle(floor)
    const requested = http.menus().length

    h.hubFloor.notifyCatalog(8)
    await menus(requested + 1)
    h.hubFloor.notifyCatalog(9)
    await menus(requested + 2)
    const [first, second] = http.menus().slice(requested) as Call[]
    if (!first || !second) throw new Error('missing requests')
    // The second one (version 9) arrives before the first one (version 8).
    second.answered = true
    second.respond(http.json(testCatalog({ version: 9 })))
    await vi.waitFor(() => expect(versionOf(floor)).toBe(9))
    first.answered = true
    first.respond(http.json(testCatalog({ version: 8 })))
    await settle(floor)

    expect(versionOf(floor)).toBe(9)
    await vi.waitFor(async () => expect(await saved(db)).toBe(9))
  })

  it('repeated or out-of-order announcements: each response brings the latest and that version stays', async () => {
    const h = setupHub()
    const { floor } = await device(h)
    await vi.waitFor(() => expect(isConnected(floor)).toBe(true))
    await menus(1)
    http.respondMenus(4)
    await settle(floor)
    const requested = http.menus().length

    // Announcements 12, 11 and 10 arrive in that order; a repeated 12 does not request again.
    for (const v of [12, 12, 11, 10]) h.hubFloor.notifyCatalog(v)
    await vi.waitFor(() => expect(http.menus().length).toBeGreaterThan(requested))
    // The hub always answers with the latest it has, whatever the announcement.
    await vi.waitFor(() => {
      http.respondMenus(12)
      expect(versionOf(floor)).toBe(12)
    })
    await settle(floor)
    http.respondMenus(12)
    expect(versionOf(floor)).toBe(12)
  })

  it('on reconnecting after an outage it requests the menu in case it changed while offline', async () => {
    const h = setupHub()
    const { floor } = await device(h)
    await vi.waitFor(() => expect(isConnected(floor)).toBe(true))
    await menus(1)
    http.respondMenus(4)
    await settle(floor)

    floor.simulateOffline(true)
    await vi.waitFor(() => expect(floor.snapshot().connection).toBe('disconnected'))
    const requested = http.menus().length
    floor.simulateOffline(false)
    await vi.waitFor(() => expect(isConnected(floor)).toBe(true))
    await menus(requested + 1)
    http.respondMenus(15)
    await vi.waitFor(() => expect(versionOf(floor)).toBe(15))
  })

  it('with the device removed the hub no longer sends it announcements', async () => {
    const h = setupHub()
    const { floor } = await device(h)
    await vi.waitFor(() => expect(isConnected(floor)).toBe(true))
    await menus(1)
    http.respondMenus(4)
    await settle(floor)
    const requested = http.menus().length
    h.revoke()
    await vi.waitFor(() => expect(floor.snapshot().hubError?.code).toBe('revoked_token'))
    h.hubFloor.notifyCatalog(9)
    await settle(floor)
    expect(http.menus()).toHaveLength(requested)
  })
})

describe('editing the menu from the app', () => {
  async function ready() {
    const h = setupHub()
    const e = await device(h)
    await vi.waitFor(() => expect(isConnected(e.floor)).toBe(true))
    await menus(1)
    http.respondMenus(4)
    await settle(e.floor)
    return { h, ...e }
  }
  const change = {
    entity: 'products' as const,
    id: newId(),
    data: { price: 1_000 },
  }

  it('sends the session and the changes, and fetches the new menu when done', async () => {
    const { floor } = await ready()
    const session = floor.snapshot().session as Session
    const requested = http.menus().length
    const save = floor.editCatalog([change])

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
    post.answered = true
    post.respond(http.json({ version: 20, changedCount: 1 }))

    await menus(requested + 1)
    http.respondMenus(20)
    await expect(save).resolves.toBe(20)
    expect(versionOf(floor)).toBe(20)
  })

  it('if the hub rejects (400), the error arrives with its message and it does not request the menu', async () => {
    const { floor } = await ready()
    const requested = http.menus().length
    const save = floor.editCatalog([change])
    const result = save.then(
      () => null,
      (e: unknown) => e,
    )
    await vi.waitFor(() =>
      expect(http.calls.some((l) => l.route === '/api/catalog/changes')).toBe(true),
    )
    const post = http.calls.find((l) => l.route === '/api/catalog/changes') as Call
    post.answered = true
    post.respond(
      http.json({ error: 'invalid_data', message: 'Cambio 1 (producto): precio mal' }, 400),
    )
    expect(await result).toMatchObject({
      code: 'invalid_data',
      message: 'Cambio 1 (producto): precio mal',
    })
    expect(http.menus()).toHaveLength(requested)
    expect(versionOf(floor)).toBe(4)
  })

  it('offline the change fails with a clear notice and is not taken as done', async () => {
    const { floor } = await ready()
    const save = floor.editCatalog([change])
    await vi.waitFor(() =>
      expect(http.calls.some((l) => l.route === '/api/catalog/changes')).toBe(true),
    )
    const post = http.calls.find((l) => l.route === '/api/catalog/changes') as Call
    post.answered = true
    post.respond(new TypeError('Failed to fetch'))
    await expect(save).rejects.toMatchObject({ code: 'offline' })
    expect(versionOf(floor)).toBe(4)
  })

  it('with the simulated connection off no request goes out', async () => {
    const { floor } = await ready()
    floor.simulateOffline(true)
    const before = http.calls.length
    await expect(floor.editCatalog([change])).rejects.toMatchObject({ code: 'offline' })
    expect(http.calls).toHaveLength(before)
  })

  it('without a session nothing is sent', async () => {
    const h = setupHub()
    const { floor } = await device(h, { session: false })
    await vi.waitFor(() => expect(isConnected(floor)).toBe(true))
    await expect(floor.editCatalog([change])).rejects.toThrow('Sin sesión')
    expect(http.calls.some((l) => l.route === '/api/catalog/changes')).toBe(false)
  })

  it('if it saved but the new menu does not arrive, the save counts and the old menu stays', async () => {
    const { floor } = await ready()
    const requested = http.menus().length
    const save = floor.editCatalog([change])
    await vi.waitFor(() =>
      expect(http.calls.some((l) => l.route === '/api/catalog/changes')).toBe(true),
    )
    const post = http.calls.find((l) => l.route === '/api/catalog/changes') as Call
    post.answered = true
    post.respond(http.json({ version: 21, changedCount: 1 }))
    await menus(requested + 1)
    ;(http.calls.at(-1) as Call).answered = true
    http.calls.at(-1)?.respond(new TypeError('Failed to fetch'))
    await expect(save).resolves.toBe(21)
    expect(versionOf(floor)).toBe(4)
  })

  it("the editor reads the full catalog with the device's token", async () => {
    const { floor } = await ready()
    const parsed = floor.catalogForEditing()
    await vi.waitFor(() =>
      expect(http.calls.some((l) => l.route === '/api/catalog/editing')).toBe(true),
    )
    const get = http.calls.find((l) => l.route === '/api/catalog/editing') as Call
    expect(get.token).toBe(TOKEN)
    get.answered = true
    get.respond(http.json({ version: 4, products: [] }))
    await expect(parsed).resolves.toMatchObject({ version: 4 })
  })
})
