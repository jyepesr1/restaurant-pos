import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelLive } from './live-object'
import {
  EXPIRES_HEADER,
  MAX_SOCKETS_PER_SESSION,
  POLICY_VIOLATION,
  REVALIDATE_MS,
  SESSION_ENDED,
  SESSION_HEADER,
} from './live-protocol'
import { FakeSocket, FakeState, type RuntimeResponse, stubRuntime } from './testing/durable-object'
import { ulid } from './testing/world'

// The live panel's Durable Object with a fake `ctx` (no workerd): which tag and attachment each
// socket gets, the broadcast, closing expired sessions and a single session, and that nothing a
// browser sends changes anything.

let ctx: FakeState
let live: PanelLive
const NOW = new Date('2026-11-02T20:00:00.000Z')
const LATER = '2026-11-30T20:00:00.000Z'
const EARLIER = '2026-11-02T19:59:59.000Z'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  stubRuntime()
  ctx = new FakeState()
  live = new PanelLive(ctx, {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const upgrade = (sessionId: string, expiresAt: string, extra: Record<string, string> = {}) =>
  ({
    headers: new Headers({
      upgrade: 'websocket',
      [SESSION_HEADER]: sessionId,
      [EXPIRES_HEADER]: expiresAt,
      ...extra,
    }),
  }) as Request

async function connect(sessionId: string, expiresAt = LATER) {
  const r = (await live.fetch(upgrade(sessionId, expiresAt))) as unknown as RuntimeResponse
  expect(r.status).toBe(101)
  const server = ctx.sockets.at(-1) as FakeSocket
  return { response: r, server }
}

describe('PanelLive', () => {
  it('answers «ping» with «pong» without waking (auto-response set in the constructor)', () => {
    expect(ctx.autoResponse).toEqual({ request: 'ping', response: 'pong' })
  })

  it('accepts with the session tag and keeps only the session and its expiry', async () => {
    const session = ulid(1, 'S')
    const { response, server } = await connect(session)
    expect(server.tags).toEqual([`session:${session}`])
    expect(server.attachment).toEqual({
      sessionId: session,
      expiresAt: LATER,
      checkedAt: NOW.getTime(),
    })
    // The browser gets the other end, not the one the object keeps.
    expect(response.webSocket).not.toBe(server)
    expect(response.webSocket).toBeInstanceOf(FakeSocket)
  })

  it('refuses without upgrade (426) or without the session the Worker adds (400)', async () => {
    const plain = { headers: new Headers({}) } as Request
    expect(((await live.fetch(plain)) as unknown as RuntimeResponse).status).toBe(426)
    for (const [id, expires] of [
      ['', LATER],
      ['no-es-un-ulid', LATER],
      [ulid(1, 'S'), 'mañana'],
    ] as const) {
      const r = (await live.fetch(upgrade(id, expires))) as unknown as RuntimeResponse
      expect(r.status).toBe(400)
    }
    expect(ctx.sockets).toEqual([])
  })

  it('notify: tells every open panel «changed» with the reason, and nothing else', async () => {
    const a = await connect(ulid(1, 'S'))
    const b = await connect(ulid(2, 'S'))
    expect(await live.notify('events')).toBe(2)
    expect(await live.notify('back_online')).toBe(2)
    for (const s of [a.server, b.server]) {
      expect(s.sent.map((m) => JSON.parse(m))).toEqual([
        { type: 'changed', reason: 'events' },
        { type: 'changed', reason: 'back_online' },
      ])
      expect(s.closed).toBeNull()
    }
  })

  it('notify: an unknown reason tells nobody', async () => {
    const a = await connect(ulid(1, 'S'))
    expect(await live.notify('drop table' as never)).toBe(0)
    expect(a.server.sent).toEqual([])
  })

  it('notify closes with 4401 the sockets whose session already expired, and tells the rest', async () => {
    const valid = await connect(ulid(1, 'S'), LATER)
    const expired = await connect(ulid(2, 'S'), EARLIER)
    const exact = await connect(ulid(3, 'S'), NOW.toISOString())
    expect(await live.notify('snapshot')).toBe(1)
    expect(valid.server.sent).toHaveLength(1)
    for (const s of [expired.server, exact.server]) {
      expect(s.sent).toEqual([])
      expect(s.closed?.code).toBe(SESSION_ENDED)
    }
  })

  it('a socket without a readable attachment is closed, not told', async () => {
    const a = await connect(ulid(1, 'S'))
    a.server.attachment = { sessionId: 7 }
    expect(await live.notify('events')).toBe(0)
    expect(a.server.closed?.code).toBe(SESSION_ENDED)
  })

  it('a broken socket does not stop the others', async () => {
    const broken = await connect(ulid(1, 'S'))
    const brokenExpired = await connect(ulid(2, 'S'), EARLIER)
    const fine = await connect(ulid(3, 'S'))
    broken.server.broken = true
    brokenExpired.server.broken = true
    expect(await live.notify('events')).toBe(1)
    expect(fine.server.sent).toHaveLength(1)
  })

  it('closeSession closes only that session’s sockets (all of them), with 4401', async () => {
    const mine = ulid(1, 'S')
    const tab1 = await connect(mine)
    const tab2 = await connect(mine)
    const other = await connect(ulid(2, 'S'))
    expect(await live.closeSession(mine)).toBe(2)
    expect(tab1.server.closed?.code).toBe(SESSION_ENDED)
    expect(tab2.server.closed?.code).toBe(SESSION_ENDED)
    expect(other.server.closed).toBeNull()
    expect(await live.notify('events')).toBe(1)
    expect(other.server.sent).toHaveLength(1)
  })

  it('closeSession with something that is not a session id closes nothing', async () => {
    const a = await connect(ulid(1, 'S'))
    expect(await live.closeSession('')).toBe(0)
    expect(await live.closeSession('*')).toBe(0)
    expect(a.server.closed).toBeNull()
  })

  it('anything the browser sends besides «ping» closes that socket (1008) and changes nothing', async () => {
    const a = await connect(ulid(1, 'S'))
    const b = await connect(ulid(2, 'S'))
    await live.webSocketMessage(a.server, '{"type":"notify"}')
    expect(a.server.sent).toEqual([])
    expect(a.server.closed?.code).toBe(POLICY_VIOLATION)
    await live.webSocketMessage(b.server, new ArrayBuffer(4))
    expect(b.server.closed?.code).toBe(POLICY_VIOLATION)
    await live.webSocketError()
    expect(await live.notify('events')).toBe(0)
  })

  it('a «ping» that reaches the object (no auto-response) gets «pong» and the socket stays', async () => {
    const a = await connect(ulid(1, 'S'))
    await live.webSocketMessage(a.server, 'ping')
    expect(a.server.sent).toEqual(['pong'])
    expect(a.server.closed).toBeNull()
  })

  it('the browser closes: the close is answered with its code (1000 for one a frame cannot carry)', async () => {
    const a = await connect(ulid(1, 'S'))
    await live.webSocketClose(a.server, 4000, 'no pong')
    expect(a.server.closed).toEqual({ code: 4000, reason: 'no pong' })
    const b = await connect(ulid(2, 'S'))
    await live.webSocketClose(b.server, 1006, '')
    expect(b.server.closed).toEqual({ code: 1000, reason: '' })
    // A socket already gone does not throw.
    const c = await connect(ulid(3, 'S'))
    c.server.broken = true
    await expect(live.webSocketClose(c.server, 1001, 'away')).resolves.toBeUndefined()
  })

  it(`at most ${MAX_SOCKETS_PER_SESSION} sockets per session: a new one closes the oldest`, async () => {
    const session = ulid(1, 'S')
    const tabs: FakeSocket[] = []
    for (let i = 0; i < MAX_SOCKETS_PER_SESSION; i++) {
      vi.setSystemTime(NOW.getTime() + i * 1000)
      tabs.push((await connect(session)).server)
    }
    expect(tabs.every((t) => t.closed === null)).toBe(true)
    vi.setSystemTime(NOW.getTime() + 60_000)
    const newest = (await connect(session)).server
    expect(tabs[0]?.closed?.code).toBe(SESSION_ENDED)
    expect(tabs.slice(1).every((t) => t.closed === null)).toBe(true)
    expect(newest.closed).toBeNull()
    expect(ctx.getWebSockets(`session:${session}`)).toHaveLength(MAX_SOCKETS_PER_SESSION)
    // Another session is not touched.
    const other = await connect(ulid(2, 'S'))
    expect(other.server.closed).toBeNull()
  })

  it('a socket opened on a session check older than REVALIDATE_MS is closed with 4401 at the next notice', async () => {
    const old = await connect(ulid(1, 'S'))
    vi.setSystemTime(NOW.getTime() + REVALIDATE_MS - 1)
    const fresh = await connect(ulid(2, 'S'))
    expect(await live.notify('events')).toBe(2)
    vi.setSystemTime(NOW.getTime() + REVALIDATE_MS)
    expect(await live.notify('events')).toBe(1)
    expect(old.server.closed?.code).toBe(SESSION_ENDED)
    expect(fresh.server.closed).toBeNull()
  })

  it('after hibernation (a new object over the same sockets) it still knows each session', async () => {
    const session = ulid(1, 'S')
    const a = await connect(session)
    const woken = new PanelLive(ctx, {})
    expect(await woken.closeSession(session)).toBe(1)
    expect(a.server.closed?.code).toBe(SESSION_ENDED)
  })
})
