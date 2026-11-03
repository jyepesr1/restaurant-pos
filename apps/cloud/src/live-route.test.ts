import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ApiEnv, BACK_ONLINE_AFTER_MS, handle } from './api'
import { PanelLive } from './live-object'
import {
  EXPIRES_HEADER,
  type LiveRooms,
  roomOf,
  SESSION_ENDED,
  SESSION_HEADER,
} from './live-protocol'
import { SESSION_MS } from './panel'
import { FakeSocket, FakeState, type RuntimeResponse, stubRuntime } from './testing/durable-object'
import {
  cookieFrom,
  PANEL_ORIGIN,
  panelRequest,
  putSnapshot,
  type RemoteUser,
  remoteUser,
  slugOf,
} from './testing/panel'
import { batch, createWorld, flatEvent, type TestHub, type World } from './testing/world'

// The live panel in the API (task 1.11c-2, docs/PANEL.md#aviso-en-vivo-websocket): who can open the WebSocket
// (`GET /v1/panel/live`) and which Durable Object it reaches, and when the Worker tells the
// panels that something changed. The Durable Object is a fake here (live-object.test.ts tests it).

const PASSWORD = 'clave-de-prueba-1'

let m: World
let hub: TestHub
let room: string

/** A fake set of live rooms that records every call, and the promises left to `waitUntil`. */
function fakeLive() {
  const calls: { kind: string; room: string; arg: unknown }[] = []
  const pending: Promise<unknown>[] = []
  /** What `connect` gives back: a 101 Node cannot build, so an object with its shape. */
  const upgraded = { status: 101, webSocket: { end: 'client' }, headers: new Headers() }
  let forwarded: Request | null = null
  const live = {
    connect: vi.fn(async (r: string, request: Request) => {
      calls.push({ kind: 'connect', room: r, arg: null })
      forwarded = request
      return upgraded as unknown as Response
    }),
    notify: vi.fn(async (r: string, reason: string) => {
      calls.push({ kind: 'notify', room: r, arg: reason })
    }),
    closeSession: vi.fn(async (r: string, sessionId: string) => {
      calls.push({ kind: 'closeSession', room: r, arg: sessionId })
    }),
  } satisfies LiveRooms
  const environment: Partial<ApiEnv> = { live, waitUntil: (p) => void pending.push(p) }
  return {
    live,
    calls,
    pending,
    upgraded,
    environment,
    forwarded: () => forwarded,
    settle: () => Promise.all(pending),
    clear: () => {
      calls.length = 0
      pending.length = 0
    },
  }
}

let f: ReturnType<typeof fakeLive>

beforeEach(async () => {
  m = await createWorld()
  hub = await m.newHub()
  room = roomOf(hub.restaurantId, hub.hub.locationId)
  f = fakeLive()
})

/** A request from the hub, with its credential, through the API with the fake live rooms. */
function fromHub(method: string, route: string, body?: unknown, environment = f.environment) {
  return handle(
    new Request(`https://cloud.faro.test${route}`, {
      method,
      headers: {
        authorization: `Bearer ${hub.credential}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { sql: m.sql, clock: () => m.clock.now, ...environment },
  )
}

async function signedIn(user: RemoteUser) {
  expect(await putSnapshot(m, hub, 'remote_users', [user])).toBe(204)
  const r = await panelRequest(m, 'POST', '/v1/panel/sign-in', {
    body: {
      restaurant: await slugOf(m, hub.restaurantId),
      username: user.username,
      password: PASSWORD,
    },
  })
  expect(r.status).toBe(200)
  return cookieFrom(r) as string
}

const WS = { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZQ==' }

const openLive = (
  cookie: string | null,
  o: { origin?: string | null; headers?: Record<string, string>; query?: string } = {},
  environment: Partial<ApiEnv> = f.environment,
) =>
  panelRequest(
    m,
    'GET',
    `/v1/panel/live${o.query ?? ''}`,
    { cookie, origin: o.origin, headers: o.headers ?? WS },
    environment,
  )

describe('GET /v1/panel/live', () => {
  let cookie: string
  beforeEach(async () => {
    cookie = await signedIn(remoteUser('ana', PASSWORD, ['remote_access']))
    f.clear()
  })

  it('with the session, from the panel: hands the WebSocket to the location’s room and returns its 101 untouched', async () => {
    const r = await openLive(cookie)
    expect(r).toBe(f.upgraded)
    expect(f.calls).toEqual([{ kind: 'connect', room, arg: null }])
  })

  it('without `Upgrade: websocket`: 426, and the room is not touched', async () => {
    for (const headers of [{}, { upgrade: 'h2c' }] as Record<string, string>[]) {
      const r = await openLive(cookie, { headers })
      expect(r.status).toBe(426)
      expect(r.headers.get('upgrade')).toBe('websocket')
      expect(r.headers.get('x-frame-options')).toBe('DENY')
    }
    expect(f.calls).toEqual([])
  })

  it('`Origin` missing, `null` or from another site: 403, even with a good session (CSWSH)', async () => {
    for (const origin of [null, 'null', 'https://otro-sitio.test', 'http://cloud.faro.test']) {
      const r = await openLive(cookie, { origin })
      expect(r.status).toBe(403)
      expect(((await r.json()) as { error: string }).error).toBe('invalid_origin')
    }
    expect(f.calls).toEqual([])
  })

  it('the panel’s own address when it is not the Worker’s (PANEL_ORIGIN)', async () => {
    const other = { ...f.environment, panelOrigin: 'https://panel.faro.test' }
    expect((await openLive(cookie, {}, other)).status).toBe(403)
    expect(await openLive(cookie, { origin: 'https://panel.faro.test' }, other)).toBe(f.upgraded)
  })

  it('without a valid session: 401 (and a bad cookie is cleared)', async () => {
    expect((await openLive(null)).status).toBe(401)
    const bad = await openLive(
      '01ARZ3NDEKTSV4RRFFQ69G5FAV.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    )
    expect(bad.status).toBe(401)
    expect(bad.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(f.calls).toEqual([])
  })

  it('a closed session cannot open it again', async () => {
    expect((await panelRequest(m, 'POST', '/v1/panel/sign-out', { cookie })).status).toBe(204)
    expect((await openLive(cookie)).status).toBe(401)
    expect(f.calls).toEqual([])
  })

  it('the room comes from the session, never from the address', async () => {
    const other = await m.newHub()
    const r = await openLive(cookie, {
      query: `?room=${roomOf(other.restaurantId, other.hub.locationId)}&restaurant=${other.restaurantId}`,
    })
    expect(r).toBe(f.upgraded)
    expect(f.calls[0]?.room).toBe(room)
    expect(f.forwarded()?.url).toBe(`${PANEL_ORIGIN}/v1/panel/live`)
  })

  it('the Durable Object gets the checked session, without the browser’s `x-faro-*` or its cookie', async () => {
    const r = await openLive(cookie, {
      headers: {
        ...WS,
        [SESSION_HEADER]: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        [EXPIRES_HEADER]: '2999-01-01T00:00:00.000Z',
        'x-faro-anything': 'made up',
      },
    })
    expect(r).toBe(f.upgraded)
    const forwarded = f.forwarded() as Request
    expect(forwarded.method).toBe('GET')
    expect(forwarded.headers.get(SESSION_HEADER)).toBe(cookie.split('.')[0])
    expect(forwarded.headers.get(EXPIRES_HEADER)).toBe(
      new Date(m.clock.now.getTime() + SESSION_MS).toISOString(),
    )
    expect(forwarded.headers.get('x-faro-anything')).toBeNull()
    expect(forwarded.headers.get('cookie')).toBeNull()
    expect(forwarded.headers.get('upgrade')).toBe('websocket')
    expect(forwarded.headers.get('sec-websocket-key')).toBe(WS['sec-websocket-key'])
  })

  it('with «Entrar desde fuera del local» it opens; whoever loses it can no longer open it', async () => {
    const boss = remoteUser('jefe', PASSWORD, ['remote_access', 'view_reports'])
    const both = await signedIn(boss)
    expect(await openLive(both)).toBe(f.upgraded)
    // The hub uploads the list again without the permission: the session dies (401), no socket
    // opens, and the ones it had open are closed (review 1.11c-2, point 8).
    expect(
      await putSnapshot(m, hub, 'remote_users', [{ ...boss, permissions: ['view_reports'] }]),
    ).toBe(204)
    f.clear()
    const r = await openLive(both)
    expect(r.status).toBe(401)
    expect(f.calls).toEqual([{ kind: 'closeSession', room, arg: both.split('.')[0] }])
    // Already revoked: the next try does not close anything again.
    f.clear()
    expect((await openLive(both)).status).toBe(401)
    expect(f.calls).toEqual([])
  })

  it('without the live rooms (as in the hub tests): 503 after the same checks, never a 500', async () => {
    const none = {}
    expect((await openLive(cookie, { headers: {} }, none)).status).toBe(426)
    expect((await openLive(cookie, { origin: null }, none)).status).toBe(403)
    expect((await openLive(null, {}, none)).status).toBe(401)
    expect((await openLive(cookie, {}, none)).status).toBe(503)
  })

  it('if handing it to the room fails: a plain 500', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    f.live.connect.mockRejectedValueOnce(new Error('room unavailable'))
    const r = await openLive(cookie)
    expect(r.status).toBe(500)
    expect(await r.text()).not.toContain('room unavailable')
    error.mockRestore()
  })
})

describe('notices to the live panel', () => {
  it('a batch with new events: one notice «events» to the location’s room, by waitUntil', async () => {
    const r = await fromHub('POST', '/v1/events', { events: batch(1, 5) })
    expect(r.status).toBe(200)
    await f.settle()
    expect(f.calls).toEqual([{ kind: 'notify', room, arg: 'events' }])
    expect(f.pending).toHaveLength(1)
  })

  it('a batch already stored, or only invalid events: no notice', async () => {
    await fromHub('POST', '/v1/events', { events: batch(1, 3) })
    await f.settle()
    f.clear()
    const again = await fromHub('POST', '/v1/events', { events: batch(1, 3) })
    const results = ((await again.json()) as { results: { status: string }[] }).results
    expect(results.map((x) => x.status)).toEqual([
      'already_stored',
      'already_stored',
      'already_stored',
    ])
    const invalid = await fromHub('POST', '/v1/events', {
      events: [{ ...flatEvent(9), id: 'no-es-un-id' }],
    })
    expect(((await invalid.json()) as { results: { status: string }[] }).results[0]?.status).toBe(
      'invalid',
    )
    const malformed = await fromHub('POST', '/v1/events', { events: [] })
    expect(malformed.status).toBe(400)
    await f.settle()
    expect(f.calls).toEqual([])
  })

  it('the answer to the hub is the same with or without the live panel', async () => {
    const withLive = await (await fromHub('POST', '/v1/events', { events: batch(1, 3) })).json()
    const other = await m.newHub()
    hub = other
    const without = await (await fromHub('POST', '/v1/events', { events: batch(1, 3) }, {})).json()
    expect(withLive).toEqual(without)
  })

  it('a notice that fails or never ends does not change or hold the hub’s answer', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    f.live.notify.mockRejectedValueOnce(new Error('room down'))
    const r = await fromHub('POST', '/v1/events', { events: batch(1, 2) })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { last_sequence: number }).last_sequence).toBe(2)
    await expect(f.settle()).resolves.toBeDefined()
    expect(JSON.stringify(error.mock.calls)).toMatch(/live panel/)
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/nota/)

    // Thrown right away, or a promise that never settles: the hub still gets its 200 at once.
    f.live.notify.mockImplementationOnce(() => {
      throw new Error('sync')
    })
    expect((await fromHub('POST', '/v1/events', { events: batch(3, 2) })).status).toBe(200)
    f.live.notify.mockImplementationOnce(() => new Promise(() => {}))
    expect((await fromHub('POST', '/v1/events', { events: batch(5, 2) })).status).toBe(200)
    error.mockRestore()
  })

  it('without waitUntil (Node) a notice still does not hold the answer', async () => {
    const r = await fromHub('POST', '/v1/events', { events: batch(1, 2) }, { live: f.live })
    expect(r.status).toBe(200)
    await vi.waitFor(() => expect(f.live.notify).toHaveBeenCalledWith(room, 'events'))
  })

  it('a snapshot saved: notice «snapshot»; the same one again: none', async () => {
    const content = [{ id: 'u1', name: 'Ana', role_id: null, active: true }]
    const put = () =>
      fromHub('PUT', '/v1/snapshots/people', {
        fingerprint: 'x'.repeat(10),
        content,
      })
    // putSnapshot computes the real fingerprint; a made-up one is also accepted as a version.
    expect((await put()).status).toBe(204)
    await f.settle()
    expect(f.calls).toEqual([{ kind: 'notify', room, arg: 'snapshot' }])
    f.clear()
    expect((await put()).status).toBe(204)
    await f.settle()
    expect(f.calls).toEqual([])
  })

  it('an invalid snapshot: no notice', async () => {
    expect(
      (await fromHub('PUT', '/v1/snapshots/people', { fingerprint: 'x', content: 7 })).status,
    ).toBe(400)
    await f.settle()
    expect(f.calls).toEqual([])
  })

  it('the hub back after more than 2 minutes silent: notice «back_online»; sooner, none', async () => {
    // Its first call ever also counts: the panel was saying it never heard from it.
    expect((await fromHub('GET', '/v1/events/last')).status).toBe(200)
    await f.settle()
    expect(f.calls).toEqual([{ kind: 'notify', room, arg: 'back_online' }])

    const at = (ms: number) => {
      m.clock.now = new Date(m.clock.now.getTime() + ms)
    }
    f.clear()
    at(30_000)
    await fromHub('GET', '/v1/events/last')
    at(BACK_ONLINE_AFTER_MS)
    await fromHub('GET', '/v1/events/last')
    await f.settle()
    expect(f.calls).toEqual([])

    at(BACK_ONLINE_AFTER_MS + 1000)
    await fromHub('GET', '/v1/events/last')
    await f.settle()
    expect(f.calls).toEqual([{ kind: 'notify', room, arg: 'back_online' }])
  })

  it('back with new events: only «events» (one notice is enough)', async () => {
    await fromHub('GET', '/v1/events/last')
    m.clock.now = new Date(m.clock.now.getTime() + 10 * 60_000)
    f.clear()
    await fromHub('POST', '/v1/events', { events: batch(1, 2) })
    await f.settle()
    expect(f.calls).toEqual([{ kind: 'notify', room, arg: 'events' }])
  })

  it('back with nothing new: «back_online»', async () => {
    await fromHub('POST', '/v1/events', { events: batch(1, 2) })
    m.clock.now = new Date(m.clock.now.getTime() + 10 * 60_000)
    f.clear()
    await fromHub('POST', '/v1/events', { events: batch(1, 2) })
    await f.settle()
    expect(f.calls).toEqual([{ kind: 'notify', room, arg: 'back_online' }])
  })

  it('a heartbeat that fails sends no «back_online» and does not fail the upload', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = {
      ...m.sql,
      query: ((text: string, params?: unknown[]) =>
        text.includes('last_seen_at = $2')
          ? Promise.reject(new Error('boom'))
          : m.sql.query(text, params)) as typeof m.sql.query,
    }
    const r = await handle(
      new Request('https://cloud.faro.test/v1/events/last', {
        headers: { authorization: `Bearer ${hub.credential}` },
      }),
      { sql: failing, clock: () => m.clock.now, ...f.environment },
    )
    expect(r.status).toBe(200)
    await f.settle()
    expect(f.calls).toEqual([])
    error.mockRestore()
  })

  it('a revoked or unknown hub: no notice', async () => {
    await m.cloud.revokeHub(hub.hub.id)
    expect((await fromHub('POST', '/v1/events', { events: batch(1, 2) })).status).toBe(401)
    await f.settle()
    expect(f.calls).toEqual([])
  })

  it('signing out closes that session’s sockets in its room', async () => {
    const cookie = await signedIn(remoteUser('ana', PASSWORD, ['remote_access']))
    f.clear()
    const r = await panelRequest(m, 'POST', '/v1/panel/sign-out', { cookie }, f.environment)
    expect(r.status).toBe(204)
    await f.settle()
    expect(f.calls).toEqual([{ kind: 'closeSession', room, arg: cookie.split('.')[0] }])
  })

  it('signing out without a session, or from another site: nothing to close', async () => {
    const cookie = await signedIn(remoteUser('ana', PASSWORD, ['remote_access']))
    f.clear()
    await panelRequest(m, 'POST', '/v1/panel/sign-out', { cookie: null }, f.environment)
    const foreign = await panelRequest(
      m,
      'POST',
      '/v1/panel/sign-out',
      { cookie, origin: 'https://otro-sitio.test' },
      f.environment,
    )
    expect(foreign.status).toBe(403)
    await f.settle()
    expect(f.calls).toEqual([])
  })
})

describe('end to end with the real Durable Object (fake runtime)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('a panel connects, the hub uploads an event, the panel hears «changed»; signing out closes it', async () => {
    stubRuntime()
    // The object compares the session’s expiry with the wall clock: with the real one this test
    // would start failing when the date passes the session’s 30 days from the test clock.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(m.clock.now)
    const states = new Map<string, FakeState>()
    const objects = new Map<string, PanelLive>()
    const object = (r: string) => {
      let o = objects.get(r)
      if (!o) {
        const state = new FakeState()
        states.set(r, state)
        o = new PanelLive(state, {})
        objects.set(r, o)
      }
      return o
    }
    const pending: Promise<unknown>[] = []
    const environment: Partial<ApiEnv> = {
      live: {
        connect: (r, request) => object(r).fetch(request),
        notify: (r, reason) => object(r).notify(reason),
        closeSession: (r, id) => object(r).closeSession(id),
      },
      waitUntil: (p) => void pending.push(p),
    }
    f.environment = environment
    const cookie = await signedIn(remoteUser('ana', PASSWORD, ['remote_access']))
    // Another restaurant with its own panel: it must hear nothing.
    const otherHub = await m.newHub()
    const otherRoom = roomOf(otherHub.restaurantId, otherHub.hub.locationId)
    object(otherRoom)
    const stranger = new FakeSocket()
    states.get(otherRoom)?.acceptWebSocket(stranger, ['session:01ARZ3NDEKTSV4RRFFQ69G5FAV'])
    stranger.serializeAttachment({
      sessionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      expiresAt: '2999-01-01T00:00:00.000Z',
    })

    const r = (await openLive(cookie, {}, environment)) as unknown as RuntimeResponse
    expect(r.status).toBe(101)
    const server = states.get(room)?.sockets[0] as FakeSocket
    expect(server.tags).toEqual([`session:${cookie.split('.')[0]}`])

    pending.length = 0
    expect((await fromHub('POST', '/v1/events', { events: batch(1, 4) }, environment)).status).toBe(
      200,
    )
    await Promise.all(pending)
    expect(server.sent.map((x) => JSON.parse(x))).toEqual([{ type: 'changed', reason: 'events' }])
    expect(stranger.sent).toEqual([])

    expect(
      (await panelRequest(m, 'POST', '/v1/panel/sign-out', { cookie }, environment)).status,
    ).toBe(204)
    await Promise.all(pending)
    expect(server.closed?.code).toBe(SESSION_ENDED)
    expect(stranger.closed).toBeNull()
  })
})
