import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cookieFrom, PANEL_ORIGIN, putSnapshot, remoteUser, slugOf } from './testing/panel'
import { ADMIN, batch, createWorld, type TestHub, type World } from './testing/world'

// The Cloudflare Worker with a fake `pg.Client` that talks to PGlite: it connects only if the
// route uses the database, closes the connection when done and leaks nothing if the connection
// fails.

const status = vi.hoisted(() => ({
  db: null as unknown,
  createdList: [] as { connectionString: string }[],
  connectedCount: 0,
  finishedCount: 0,
  listeners: [] as string[],
  failing: null as Error | null,
  failOnEnd: false,
  failQuery: false,
}))

vi.mock('pg', () => ({
  Client: class {
    constructor(options: { connectionString: string }) {
      status.createdList.push(options)
    }
    on(event: string) {
      status.listeners.push(event)
    }
    async connect() {
      if (status.failing) throw status.failing
      status.connectedCount++
    }
    async query(text: string, params?: unknown[]) {
      if (status.failQuery) throw new Error('connection terminated')
      const db = status.db as PGlite
      if (params === undefined) {
        const r = await db.exec(text)
        return { rows: r.at(-1)?.rows ?? [] }
      }
      return db.query(text, params)
    }
    async end() {
      status.finishedCount++
      if (status.failOnEnd) throw new Error('already closed')
    }
  },
}))

import type { PanelLive } from './live-object'
import worker from './worker'

const CONNECTION_STRING = 'postgres://faro_api:clave-de-la-base@host.neon.tech/faro'

let m: World
let credential: string
let testHub: TestHub
beforeEach(async () => {
  m = await createWorld()
  status.db = m.db
  status.createdList.length = 0
  status.connectedCount = 0
  status.finishedCount = 0
  status.listeners.length = 0
  status.failing = null
  status.failOnEnd = false
  status.failQuery = false
  testHub = await m.newHub()
  credential = testHub.credential
})

function makeCall(route: string, options: RequestInit = {}) {
  const pendingList: Promise<unknown>[] = []
  const response = worker.fetch(
    new Request(`https://cloud.faro.test${route}`, options),
    { HYPERDRIVE: { connectionString: CONNECTION_STRING }, TOKEN_ADMIN: ADMIN },
    { waitUntil: (p) => void pendingList.push(p) },
  )
  return { response, pendingList }
}

describe('Worker', () => {
  it('health and routes that do not exist do not open a database connection', async () => {
    for (const route of ['/v1/health', '/v1/nothing']) {
      const { response, pendingList } = makeCall(route)
      await response
      await Promise.all(pendingList)
    }
    expect(status.createdList).toEqual([])
    expect(status.connectedCount).toBe(0)
    expect(status.finishedCount).toBe(0)
  })

  it('a route that uses the database connects once, with the Hyperdrive string, and closes when done', async () => {
    const { response, pendingList } = makeCall('/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}` },
      body: JSON.stringify({ events: batch(1, 3) }),
    })
    const r = await response
    expect(r.status).toBe(200)
    await Promise.all(pendingList)
    expect(status.createdList).toEqual([{ connectionString: CONNECTION_STRING }])
    expect(status.connectedCount).toBe(1)
    expect(status.finishedCount).toBe(1)
  })

  it('each request uses its own connection', async () => {
    for (let i = 0; i < 3; i++) {
      const { response, pendingList } = makeCall('/v1/events/last', {
        headers: { authorization: `Bearer ${credential}` },
      })
      expect((await response).status).toBe(200)
      await Promise.all(pendingList)
    }
    expect(status.connectedCount).toBe(3)
    expect(status.finishedCount).toBe(3)
  })

  it('a connection drop midway is handled (there is an error listener)', async () => {
    const { response, pendingList } = makeCall('/v1/events/last', {
      headers: { authorization: `Bearer ${credential}` },
    })
    await response
    await Promise.all(pendingList)
    expect(status.listeners).toContain('error')
  })

  it('if it cannot connect: generic 500, without the connection string or the reason', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    status.failing = new Error(`connect ECONNREFUSED ${CONNECTION_STRING}`)
    const { response, pendingList } = makeCall('/v1/events/last', {
      headers: { authorization: `Bearer ${credential}` },
    })
    const r = await response
    await Promise.all(pendingList)
    const text = await r.text()
    expect(r.status).toBeGreaterThanOrEqual(500)
    expect(text).not.toContain('clave-de-la-base')
    expect(text).not.toContain('ECONNREFUSED')
    expect(text).not.toContain('neon.tech')
    expect(r.headers.get('content-type')).toContain('application/json')
  })

  it('if closing the connection fails, the request still responds and no promise is left unhandled', async () => {
    status.failOnEnd = true
    const { response, pendingList } = makeCall('/v1/events/last', {
      headers: { authorization: `Bearer ${credential}` },
    })
    expect((await response).status).toBe(200)
    await expect(Promise.all(pendingList)).resolves.toBeDefined()
  })

  it('an internal API error (the query fails) responds 500 and still closes the connection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    status.failQuery = true
    const { response, pendingList } = makeCall('/v1/events/last', {
      headers: { authorization: `Bearer ${credential}` },
    })
    const r = await response
    await Promise.all(pendingList)
    expect(r.status).toBe(500)
    expect(status.connectedCount).toBe(1)
    expect(status.finishedCount).toBe(1)
  })

  it('the admin area works with the environment token and not without it', async () => {
    const without = makeCall('/v1/admin/restaurants', { method: 'POST', body: '{}' })
    expect((await without.response).status).toBe(401)
    await Promise.all(without.pendingList)
    const withIt = makeCall('/v1/admin/restaurants', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ id: '0'.repeat(26), name: 'R' }),
    })
    expect((await withIt.response).status).toBe(201)
    await Promise.all(withIt.pendingList)
  })

  it('without TOKEN_ADMIN in the environment there is no admin (even if a token is sent)', async () => {
    const pendingList: Promise<unknown>[] = []
    const r = await worker.fetch(
      new Request('https://cloud.faro.test/v1/admin/restaurants', {
        method: 'POST',
        headers: { authorization: 'Bearer cualquiera' },
        body: '{}',
      }),
      { HYPERDRIVE: { connectionString: CONNECTION_STRING } },
      { waitUntil: (p) => void pendingList.push(p) },
    )
    expect(r.status).toBe(401)
  })
})

describe('Worker with the live panel (PANEL_LIVE)', () => {
  /** A fake Durable Object namespace: records which room each call went to. */
  function fakeNamespace() {
    const calls: { room: string; kind: string; arg: unknown }[] = []
    const upgraded = { status: 101, webSocket: { end: 'client' }, headers: new Headers() }
    const namespace = {
      getByName(room: string) {
        return {
          fetch: async (request: Request) => {
            calls.push({ room, kind: 'fetch', arg: request.headers.get('x-faro-session-id') })
            return upgraded as unknown as Response
          },
          notify: async (reason: string) => {
            calls.push({ room, kind: 'notify', arg: reason })
            return 1
          },
          closeSession: async (sessionId: string) => {
            calls.push({ room, kind: 'closeSession', arg: sessionId })
            return 1
          },
        }
      },
    } as unknown as DurableObjectNamespace<PanelLive>
    return { calls, upgraded, namespace }
  }

  const room = () => `${testHub.restaurantId}:${testHub.hub.locationId}`

  async function call(
    live: ReturnType<typeof fakeNamespace>,
    route: string,
    options: RequestInit = {},
  ) {
    const pendingList: Promise<unknown>[] = []
    const r = await worker.fetch(
      new Request(`${PANEL_ORIGIN}${route}`, options),
      {
        HYPERDRIVE: { connectionString: CONNECTION_STRING },
        TOKEN_ADMIN: ADMIN,
        PANEL_LIVE: live.namespace,
      },
      { waitUntil: (p) => void pendingList.push(p) },
    )
    await Promise.all(pendingList)
    return r
  }

  it('an uploaded batch tells the location’s Durable Object by RPC, after answering', async () => {
    const live = fakeNamespace()
    const r = await call(live, '/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}` },
      body: JSON.stringify({ events: batch(1, 3) }),
    })
    expect(r.status).toBe(200)
    expect(live.calls).toEqual([{ room: room(), kind: 'notify', arg: 'events' }])
    expect(status.finishedCount).toBe(1)
  })

  it('the WebSocket goes to the session’s room by `fetch`, and its 101 comes back untouched', async () => {
    const live = fakeNamespace()
    const user = remoteUser('ana', 'clave-de-prueba-1', ['remote_access'])
    expect(await putSnapshot(m, testHub, 'remote_users', [user])).toBe(204)
    const signIn = await call(live, '/v1/panel/sign-in', {
      method: 'POST',
      headers: { origin: PANEL_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        restaurant: await slugOf(m, testHub.restaurantId),
        username: 'ana',
        password: 'clave-de-prueba-1',
      }),
    })
    expect(signIn.status).toBe(200)
    const cookie = cookieFrom(signIn) as string
    const r = await call(live, '/v1/panel/live', {
      headers: {
        origin: PANEL_ORIGIN,
        upgrade: 'websocket',
        cookie: `__Host-faro_panel=${cookie}`,
      },
    })
    expect(r).toBe(live.upgraded)
    expect(live.calls).toEqual([{ room: room(), kind: 'fetch', arg: cookie.split('.')[0] }])

    live.calls.length = 0
    const out = await call(live, '/v1/panel/sign-out', {
      method: 'POST',
      headers: { origin: PANEL_ORIGIN, cookie: `__Host-faro_panel=${cookie}` },
    })
    expect(out.status).toBe(204)
    expect(live.calls).toEqual([{ room: room(), kind: 'closeSession', arg: cookie.split('.')[0] }])
  })

  it('without a session the WebSocket never reaches a Durable Object', async () => {
    const live = fakeNamespace()
    const r = await call(live, '/v1/panel/live', {
      headers: { origin: PANEL_ORIGIN, upgrade: 'websocket' },
    })
    expect(r.status).toBe(401)
    expect(live.calls).toEqual([])
  })
})
