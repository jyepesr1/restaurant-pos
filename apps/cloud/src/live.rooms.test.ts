import { newId } from '@pos/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { event } from '../../../packages/core/src/testing/factory'
import { type ApiEnv, handle } from './api'
import { roomOf, SESSION_ENDED } from './live-protocol'
import { SESSION_MS } from './panel'
import { cookieFrom, panelRequest, remoteUser, slugOf } from './testing/panel'
import { type Rooms, realRooms } from './testing/rooms'
import { PASSWORD, person, publish, signInAs } from './testing/session'
import { batch, createWorld, type TestHub, type World } from './testing/world'

// Who can see what in the live panel (task 1.11c-2): a person with only «Entrar desde fuera del
// local» against one who can also «Ver todos los reportes», a session revoked while its WebSocket is
// open, and the rooms of the Durable Object kept apart by restaurant and by location.

let m: World
let hub: TestHub
let rooms: Rooms
let environment: Partial<ApiEnv>

beforeEach(async () => {
  rooms = realRooms()
  environment = rooms.environment
  m = await createWorld()
  hub = await m.newHub()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const WS = { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZQ==' }
const get = (route: string, cookie: string | null, headers: Record<string, string> = {}) =>
  panelRequest(m, 'GET', route, { cookie, headers }, environment)
const roomOfHub = (h: TestHub) => roomOf(h.restaurantId, h.hub.locationId)

async function connect(cookie: string) {
  const r = await get('/v1/panel/live', cookie, WS)
  expect(r.status).toBe(101)
}

/** The hub uploads events (a notice goes to its room, after the answer). */
async function hubUploads(h: TestHub, from = 1) {
  const r = await handle(
    new Request('https://cloud.faro.test/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${h.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: batch(from, 3) }),
    }),
    { sql: m.sql, clock: () => m.clock.now, ...environment },
  )
  expect(r.status).toBe(200)
  await rooms.settle()
}

const heard = (socket: { sent: string[] }) =>
  socket.sent.map((s) => (JSON.parse(s) as { reason: string }).reason)

describe('«Entrar desde fuera del local» against «Ver todos los reportes»', () => {
  const ROUTES: [string, string, number, number][] = [
    // route, query, status with only remote_access, status with both
    ['/v1/panel/me', '', 200, 200],
    ['/v1/panel/floor', '', 200, 200],
    ['/v1/panel/summary', '', 403, 200],
    ['/v1/panel/register', '', 403, 200],
    ['/v1/panel/alerts', '', 403, 200],
    ['/v1/panel/alerts', '?day=2026-10-25', 403, 200],
    ['/v1/panel/reports', '', 403, 200],
    ['/v1/panel/reports', '?from=2026-10-20&until=2026-10-26', 403, 200],
  ]

  it('each route gives each person what their permissions allow, and a refusal carries no data', async () => {
    const watcher = person(['remote_access'], 'Vigilante')
    const owner = person(['remote_access', 'view_reports'], 'Dueña')
    await publish(m, hub, [watcher, owner])
    const [a, b] = [await signInAs(m, hub, watcher), await signInAs(m, hub, owner)]
    // Something in the restaurant worth leaking.
    await hubUploads(hub)
    for (const [route, query, onlyAccess, both] of ROUTES) {
      const x = await get(`${route}${query}`, a)
      expect(x.status, `${route}${query} (solo acceso)`).toBe(onlyAccess)
      if (onlyAccess === 403) {
        const body = (await x.json()) as Record<string, unknown>
        expect(Object.keys(body).sort()).toEqual(['error', 'message'])
        expect(body.error).toBe('no_permission')
      }
      expect((await get(`${route}${query}`, b)).status, `${route}${query} (completo)`).toBe(both)
    }
    // The WebSocket opens for both: it carries no data, only «changed».
    await connect(a)
    await connect(b)
  })

  it('permission is checked before the parameters: a refusal never reveals whether a date is valid', async () => {
    const watcher = person(['remote_access'])
    const owner = person(['remote_access', 'view_reports'])
    await publish(m, hub, [watcher, owner])
    const [a, b] = [await signInAs(m, hub, watcher), await signInAs(m, hub, owner)]
    expect((await get('/v1/panel/alerts?day=ayer', a)).status).toBe(403)
    expect((await get('/v1/panel/alerts?day=ayer', b)).status).toBe(400)
    expect((await get('/v1/panel/reports?from=basura', a)).status).toBe(403)
  })

  it('with only «Ver todos los reportes» (no remote_access) nobody gets in: same refusal as a wrong password', async () => {
    const reader = person(['view_reports'], 'Lector')
    await publish(m, hub, [reader])
    const slug = await slugOf(m, hub.restaurantId)
    const good = await panelRequest(m, 'POST', '/v1/panel/sign-in', {
      body: { restaurant: slug, username: reader.username, password: PASSWORD },
    })
    const wrong = await panelRequest(m, 'POST', '/v1/panel/sign-in', {
      body: { restaurant: slug, username: reader.username, password: 'otra-clave-x' },
    })
    expect(good.status).toBe(401)
    expect(await good.json()).toEqual(await wrong.json())
    expect(cookieFrom(good)).toBeNull()
  })

  it('whoever loses «Ver todos los reportes» keeps the floor but loses the rest at once', async () => {
    const owner = person(['remote_access', 'view_reports'], 'Dueña')
    await publish(m, hub, [owner])
    const cookie = await signInAs(m, hub, owner)
    expect((await get('/v1/panel/register', cookie)).status).toBe(200)
    // The administrator takes the permission away; the hub uploads the new list.
    await publish(m, hub, [{ ...owner, permissions: ['remote_access'] }])
    expect((await get('/v1/panel/register', cookie)).status).toBe(403)
    expect((await get('/v1/panel/alerts', cookie)).status).toBe(403)
    expect((await get('/v1/panel/floor', cookie)).status).toBe(200)
    // And whoever gets it back sees it again without signing in again.
    await publish(m, hub, [owner])
    expect((await get('/v1/panel/register', cookie)).status).toBe(200)
  })
})

describe('the socket’s first checks do not touch the database', () => {
  it('no upgrade (426), a foreign Origin (403) and no cookie at all (401 with the cookie’s absence) cost no query until the session is needed', async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error('the database was used')
        },
      },
    ) as never
    const call = (headers: Record<string, string>) =>
      handle(new Request('https://cloud.faro.test/v1/panel/live', { headers }), {
        sql: db,
        clock: () => m.clock.now,
        ...environment,
      })
    expect((await call({ origin: 'https://cloud.faro.test' })).status).toBe(426)
    expect((await call({ ...WS, origin: 'https://otro.test' })).status).toBe(403)
    expect((await call({ ...WS })).status).toBe(403)
    // Unknown panel routes are refused before the session too.
    const unknown = await handle(
      new Request('https://cloud.faro.test/v1/panel/nada', {
        headers: { origin: 'https://cloud.faro.test' },
      }),
      { sql: db, clock: () => m.clock.now, ...environment },
    )
    expect(unknown.status).toBe(404)
  })
})

describe('a session revoked with its WebSocket open', () => {
  const lose = {
    'loses remote_access': (u: ReturnType<typeof person>) => [
      { ...u, permissions: ['view_reports'] },
    ],
    'is archived (leaves the list)': () => [],
    'changes the password': (u: ReturnType<typeof person>) =>
      [remoteUser(u.username, 'una-clave-nueva-9', u.permissions, u.name)].map((r) => ({
        ...r,
        user_id: u.user_id,
      })),
  } as const

  for (const [what, change] of Object.entries(lose)) {
    it(`${what}: every route and a new socket answer 401; the open socket only ever hears «changed»`, async () => {
      const owner = person(['remote_access', 'view_reports'], 'Dueña')
      await publish(m, hub, [owner])
      const cookie = await signInAs(m, hub, owner)
      await connect(cookie)
      const socket = rooms.sockets(roomOfHub(hub)).at(-1)
      if (!socket) throw new Error('no socket')

      await publish(m, hub, change(owner), environment)
      await rooms.settle()
      // The snapshot told the room: the panel hears it and reads again…
      expect(heard(socket)).toEqual(['snapshot'])
      // …and the reading is refused, as is any new socket.
      for (const route of ['/v1/panel/floor', '/v1/panel/summary', '/v1/panel/me']) {
        expect((await get(route, cookie)).status, route).toBe(401)
      }
      expect((await get('/v1/panel/live', cookie, WS)).status).toBe(401)
      // What the old socket hears carries no restaurant data at all.
      await hubUploads(hub)
      for (const raw of socket.sent)
        expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['reason', 'type'])
    })
  }

  it('the revoked session’s socket is closed with 4401 at the first notice after its session expires', async () => {
    const owner = person(['remote_access'])
    await publish(m, hub, [owner])
    const cookie = await signInAs(m, hub, owner)
    await connect(cookie)
    const socket = rooms.sockets(roomOfHub(hub)).at(-1)
    if (!socket) throw new Error('no socket')
    m.clock.now = new Date(m.clock.now.getTime() + SESSION_MS + 1000)
    rooms.setNow(m.clock.now)
    // Keep the hub alive (a revoked/old hub would be a different story).
    await hubUploads(hub)
    expect(socket.sent).toEqual([])
    expect(socket.closed?.code).toBe(SESSION_ENDED)
  })

  it('an idle session (7 days without use) is dead for the routes even if its socket was never closed', async () => {
    const owner = person(['remote_access'])
    await publish(m, hub, [owner])
    const cookie = await signInAs(m, hub, owner)
    await connect(cookie)
    m.clock.now = new Date(m.clock.now.getTime() + 8 * 24 * 60 * 60 * 1000)
    rooms.setNow(m.clock.now)
    expect((await get('/v1/panel/floor', cookie)).status).toBe(401)
    expect((await get('/v1/panel/live', cookie, WS)).status).toBe(401)
  })

  it('signing out closes every tab of that session and none of the person’s other sessions', async () => {
    const owner = person(['remote_access'])
    await publish(m, hub, [owner])
    const [phone, laptop] = [await signInAs(m, hub, owner), await signInAs(m, hub, owner)]
    await connect(phone)
    await connect(phone)
    await connect(laptop)
    const [a, b, c] = rooms.sockets(roomOfHub(hub))
    const out = await panelRequest(m, 'POST', '/v1/panel/sign-out', { cookie: phone }, environment)
    expect(out.status).toBe(204)
    await rooms.settle()
    expect([a?.closed?.code, b?.closed?.code]).toEqual([SESSION_ENDED, SESSION_ENDED])
    expect(c?.closed).toBeNull()
    await hubUploads(hub)
    expect(heard(c as { sent: string[] })).toEqual(['events'])
    expect(a?.sent).toEqual([])
  })
})

describe('the rooms are kept apart', () => {
  it('another restaurant’s hub, and another location’s, only wake their own room', async () => {
    const other = await m.newHub()
    const mine = person(['remote_access'])
    const theirs = person(['remote_access'])
    await publish(m, hub, [mine])
    await publish(m, other, [theirs])
    const [c1, c2] = [await signInAs(m, hub, mine), await signInAs(m, other, theirs)]
    await connect(c1)
    await connect(c2)
    // A second location of my restaurant, with its own hub, which is the one that calls now.
    const sibling = await m.newHub(hub.restaurantId)
    const [s1, s2] = [rooms.sockets(roomOfHub(hub)), rooms.sockets(roomOfHub(other))]
    await hubUploads(sibling, 1)
    await hubUploads(other, 1)
    expect(s1.map(heard)).toEqual([[]])
    expect(s2.map(heard)).toEqual([['events']])
    expect(rooms.names().sort()).toEqual(
      [roomOfHub(hub), roomOfHub(other), roomOfHub(sibling)].sort(),
    )
    await hubUploads(hub, 10)
    expect(s1.map(heard)).toEqual([['events']])
    expect(s2.map(heard)).toEqual([['events']])
  })

  it('a session id of one restaurant closes nothing in another restaurant’s room', async () => {
    const other = await m.newHub()
    const [mine, theirs] = [person(['remote_access']), person(['remote_access'])]
    await publish(m, hub, [mine])
    await publish(m, other, [theirs])
    const [c1, c2] = [await signInAs(m, hub, mine), await signInAs(m, other, theirs)]
    await connect(c1)
    await connect(c2)
    const object = rooms.wake(roomOfHub(other))
    // The same room, asked to close the other restaurant’s session id: nothing there to close.
    expect(await object.closeSession(c1.split('.')[0] as string)).toBe(0)
    expect(rooms.sockets(roomOfHub(other)).every((s) => s.closed === null)).toBe(true)
    // And signing out of one session reaches only its own room.
    await panelRequest(m, 'POST', '/v1/panel/sign-out', { cookie: c1 }, environment)
    await rooms.settle()
    expect(rooms.sockets(roomOfHub(hub)).every((s) => s.closed?.code === SESSION_ENDED)).toBe(true)
    expect(rooms.sockets(roomOfHub(other)).every((s) => s.closed === null)).toBe(true)
  })

  it('the socket a session opens lands in the room of its own location, whatever the request says', async () => {
    const other = await m.newHub()
    const mine = person(['remote_access'])
    await publish(m, hub, [mine])
    const cookie = await signInAs(m, hub, mine)
    const forged = {
      ...WS,
      'x-faro-room': roomOfHub(other),
      'x-faro-session-id': '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      host: 'otro.faro.test',
    }
    const r = await get(
      `/v1/panel/live?room=${roomOfHub(other)}&restaurant=${other.restaurantId}`,
      cookie,
      forged,
    )
    expect(r.status).toBe(101)
    expect(rooms.names()).toEqual([roomOfHub(hub)])
    expect(rooms.sockets(roomOfHub(hub))[0]?.tags).toEqual([`session:${cookie.split('.')[0]}`])
  })
})

describe('two locations of the same restaurant', () => {
  const advance = (ms: number) => {
    m.clock.now = new Date(m.clock.now.getTime() + ms)
    rooms.setNow(m.clock.now)
  }
  const floor = async (cookie: string) => {
    const r = await get('/v1/panel/floor', cookie)
    return { status: r.status, body: (await r.json()) as { orders: { id: string }[] } }
  }

  /** An order opened by a hub, as one event with the day of the test clock. */
  async function uploadOrder(h: TestHub, order: string, from: number) {
    const opening = {
      ...event(
        order,
        'OrderOpened',
        { channel: 'takeout', table_id: null, guests: 1 },
        { business_day: '2026-10-26', received_at: '2026-10-26T14:00:00.000Z' },
      ),
      sequence: from,
    }
    const r = await handle(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${h.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: [opening] }),
      }),
      { sql: m.sql, clock: () => m.clock.now, ...environment },
    )
    expect(r.status).toBe(200)
  }

  it('the panel of the location it is on never shows the other location’s floor', async () => {
    const owner = person(['remote_access', 'view_reports'])
    await publish(m, hub, [owner])
    const cookie = await signInAs(m, hub, owner)
    advance(1000)
    const sibling = await m.newHub(hub.restaurantId)
    const [mine, theirs] = [newId(), newId()]
    await uploadOrder(sibling, theirs, 1)
    advance(1000)
    // The owner’s own location is the one that called last.
    await uploadOrder(hub, mine, 1)
    const { status, body } = await floor(cookie)
    expect(status).toBe(200)
    expect(body.orders.map((o) => o.id)).toEqual([mine])
    expect(JSON.stringify(await (await get('/v1/panel/summary', cookie)).json())).not.toContain(
      theirs,
    )
  })

  // The session carries its own location (the one of the remote user it signed in as): a call
  // from another location of the restaurant does not move it nor end it (review 1.11c-2, point 14).
  it('a call from the other location does not end the owner’s session', async () => {
    const owner = person(['remote_access', 'view_reports'])
    await publish(m, hub, [owner])
    const cookie = await signInAs(m, hub, owner)
    advance(1000)
    const sibling = await m.newHub(hub.restaurantId)
    advance(1000)
    const theirs = newId()
    await uploadOrder(sibling, theirs, 1)
    const r = await floor(cookie)
    expect(r.status).toBe(200)
    // Still the owner’s location: the other one’s order is not on its floor.
    expect(r.body.orders.map((o) => o.id)).not.toContain(theirs)
    const me = await get('/v1/panel/me', cookie)
    expect(me.status).toBe(200)
  })
})

describe('a deploy cuts every socket', () => {
  it('notices after it find an empty room (no error); a panel that reconnects hears the next one', async () => {
    const owner = person(['remote_access'])
    await publish(m, hub, [owner])
    const cookie = await signInAs(m, hub, owner)
    await connect(cookie)
    rooms.deploy()
    // The hub keeps uploading while every panel is reconnecting.
    await hubUploads(hub, 1)
    expect(rooms.sockets(roomOfHub(hub))).toEqual([])
    await connect(cookie)
    await hubUploads(hub, 4)
    const socket = rooms.sockets(roomOfHub(hub)).at(-1)
    expect(heard(socket as { sent: string[] })).toEqual(['events'])
  })

  it('a deploy in the middle of an upload does not change the hub’s answer', async () => {
    const owner = person(['remote_access'])
    await publish(m, hub, [owner])
    await connect(await signInAs(m, hub, owner))
    const failing: Partial<ApiEnv> = {
      live: {
        connect: async () => new Response(null, { status: 500 }),
        notify: async () => {
          throw new Error('Durable Object reset because its code was updated')
        },
        closeSession: async () => {
          throw new Error('Durable Object reset because its code was updated')
        },
      },
      waitUntil: (p) => void p,
    }
    const r = await handle(
      new Request('https://cloud.faro.test/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${hub.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch(1, 2) }),
      }),
      { sql: m.sql, clock: () => m.clock.now, ...failing },
    )
    expect(r.status).toBe(200)
    // Signing out still signs out, even if telling the room fails.
    const owner2 = person(['remote_access'])
    await publish(m, hub, [owner2])
    const cookie = await signInAs(m, hub, owner2)
    const out = await panelRequest(m, 'POST', '/v1/panel/sign-out', { cookie }, failing)
    expect(out.status).toBe(204)
    expect((await get('/v1/panel/floor', cookie)).status).toBe(401)
  })
})
