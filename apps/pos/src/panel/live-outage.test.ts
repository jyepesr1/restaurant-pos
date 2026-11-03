import { delay } from '@pos/sync/views'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LiveFloor, panelApi } from './api'
import { createLive, FAILURES_BEFORE_CHECK, type Network, type SocketLike } from './live'
import { type FloorAnswer, floorFetcher, floorState } from './live-floor'
import { FAST_GAP_MS, LIVE_BACKUP_MS, startPolling } from './poller'
import { EVERY_MS, NO_NEWS_MS, type Polled } from './summary'
import { floorAnswerOf, me } from './testing'
import type { Visibility } from './visibility'

// The panel's whole chain against a cloud that comes and goes (task 1.11c-2): the real client, the
// real poller, the real live connection and the real clock rules, with a fake WebSocket and fake
// timers. What the owner would see: «sin noticias» at two minutes, durations frozen while nothing
// arrives, a reread when the hub is back, the socket dying mid-service, a deploy cutting every
// socket, the tab hidden for a while and a phone with the wrong clock.

const ZONE = 'America/Bogota'
const MIN = 60_000
const SECOND = 1000
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const plain = (t: string | null) => (t ?? '').replace(/\s/g, ' ')

class FakeSocket implements SocketLike {
  readyState = 0
  sent: string[] = []
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  /** The Durable Object answers «ping» with «pong» without waking (unless the network is cut). */
  answersPings = true
  send(data: string) {
    this.sent.push(data)
    if (data === 'ping' && this.answersPings) queueMicrotask(() => this.says('pong'))
  }
  close() {
    this.readyState = 3
  }
  opens() {
    this.readyState = 1
    this.onopen?.({})
  }
  says(data: unknown) {
    this.onmessage?.({ data })
  }
  closes(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

/**
 * The cloud as the panel sees it. The hub's last call, its pending changes and whether the phone
 * can reach the cloud are set by the test; the cloud's clock is the phone's minus `phoneAhead`.
 */
function cloud(base: FloorAnswer, phoneAhead = 0) {
  const state = {
    hubSeenAt: base.local.last_seen_at as string | null,
    pending: 0,
    reachable: true,
    sessionAlive: true,
    orders: base.orders,
    tickets: base.tickets,
    floorCalls: 0,
    meCalls: 0,
  }
  const fetch = (async (input: RequestInfo | URL) => {
    if (!state.reachable) throw new TypeError('Failed to fetch')
    const url = new URL(String(input), 'https://panel.faro.test')
    if (!state.sessionAlive) return json(401, { error: 'unauthorized' })
    if (url.pathname === '/v1/panel/me') {
      state.meCalls++
      return json(200, me())
    }
    state.floorCalls++
    const known = url.searchParams.get('plan')
    return json(200, {
      ...base,
      server_now: new Date(Date.now() - phoneAhead).toISOString(),
      local: {
        last_seen_at: state.hubSeenAt,
        last_event_at: base.local.last_event_at,
        pending: state.pending,
      },
      plan: known === base.plan_version ? null : base.plan,
      orders: state.orders,
      tickets: state.tickets,
    } satisfies LiveFloor)
  }) as typeof globalThis.fetch
  return { state, fetch }
}

function panel(c: ReturnType<typeof cloud>, { hidden = false } = {}) {
  const sockets: FakeSocket[] = []
  const reachable = { open: true }
  let hiddenNow = hidden
  // The live connection and the poller both listen to the tab, as with the real document.
  const visibilityListeners = new Set<() => void>()
  let online: (() => void) | null = null
  const visibility: Visibility = {
    hidden: () => hiddenNow,
    subscribe: (change) => {
      visibilityListeners.add(change)
      return () => {
        visibilityListeners.delete(change)
      }
    },
  }
  const network: Network = {
    subscribe: (o) => {
      online = o
      return () => {
        online = null
      }
    },
  }
  const onSignedOut = vi.fn()
  const api = panelApi({ fetch: c.fetch, onUnauthorized: () => {} })
  const connection = createLive({
    url: 'wss://panel.faro.test/v1/panel/live',
    open: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    visibility,
    network,
    checkSession: () => api.me(),
    onSignedOut,
    random: () => 0.5,
  })
  const answers: Polled<FloorAnswer>[] = []
  connection.start()
  const stop = startPolling({
    fetch: floorFetcher(api),
    everyMs: EVERY_MS,
    visibility,
    onChange: (s) => answers.push(s),
    live: connection,
    minGapMs: FAST_GAP_MS,
  })
  return {
    connection,
    sockets,
    reachable,
    answers,
    onSignedOut,
    stop: () => {
      stop()
      connection.stop()
    },
    last: () => sockets.at(-1) as FakeSocket,
    /** What the screen would show right now, with the phone's clock. */
    view() {
      const polled = answers.at(-1) as Polled<FloorAnswer>
      const { state, time } = floorState(polled, Date.now(), ZONE)
      const data = polled.data as FloorAnswer
      const ticket = data.tickets[0]
      return {
        state,
        time,
        delay: ticket ? delay(ticket.sent_at, time.now, data.timers) : null,
      }
    },
    hide(h: boolean) {
      hiddenNow = h
      for (const change of [...visibilityListeners]) change()
    },
    goOnline: () => online?.(),
  }
}

let base: FloorAnswer
beforeEach(() => {
  vi.useFakeTimers()
  base = floorAnswerOf()
  vi.setSystemTime(new Date(base.server_now))
})
afterEach(() => vi.useRealTimers())

/** Lets the first read and the socket's opening happen. */
async function started(c: ReturnType<typeof cloud>, o?: Parameters<typeof panel>[1]) {
  const p = panel(c, o)
  await vi.advanceTimersByTimeAsync(0)
  p.last().opens()
  await vi.advanceTimersByTimeAsync(0)
  return p
}

describe('the hub goes quiet and comes back', () => {
  it('«sin noticias» only after two full minutes, durations frozen meanwhile, running again when it returns', async () => {
    const c = cloud(base)
    const p = await started(c)
    expect(p.view().state.kind).toBe('up_to_date')
    expect(p.view().delay).toBe('late')

    // The hub is silent. Exactly two minutes after its last call: still up to date.
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(p.view().state.kind).toBe('up_to_date')
    // One second more, between two reads, with no answer in between: already «sin noticias».
    await vi.advanceTimersByTimeAsync(SECOND)
    const quiet = p.view()
    expect(quiet.state.kind).toBe('no_news')
    expect(plain(quiet.state.text)).toBe('Sin noticias del restaurante desde las 10:20 a. m.')
    expect(plain(quiet.time.frozenAt)).toBe('10:20 a. m.')

    // Ten more minutes: the ticket sent at 10:00 does not turn red (30 min) while nothing arrives.
    await vi.advanceTimersByTimeAsync(10 * MIN)
    const frozen = p.view()
    expect(frozen.state.kind).toBe('no_news')
    expect(frozen.time.now).toBe(Date.parse(base.local.last_seen_at ?? ''))
    expect(frozen.delay).toBe('late')
    // What it had pending is not claimed while the hub is quiet.
    expect(frozen.state.pending).toBeNull()

    // The hub is back (it had 7 changes to upload) and the cloud tells the panel.
    c.state.hubSeenAt = new Date(Date.now()).toISOString()
    c.state.pending = 7
    const before = c.state.floorCalls
    p.last().says(JSON.stringify({ type: 'changed', reason: 'back_online' }))
    await vi.advanceTimersByTimeAsync(FAST_GAP_MS)
    expect(c.state.floorCalls).toBe(before + 1)
    const back = p.view()
    expect(back.state.kind).toBe('up_to_date')
    expect(back.state.pending).toBe('Faltan 7 datos del local por llegar')
    expect(back.time.frozenAt).toBeNull()
    expect(back.time.now).toBe(Date.now())
    expect(back.delay).toBe('very_late')
    p.stop()
  })

  it('a hub that never comes back keeps the panel quiet at the backup pace, not in a storm', async () => {
    const c = cloud(base)
    const p = await started(c)
    const start = c.state.floorCalls
    await vi.advanceTimersByTimeAsync(30 * MIN)
    // One backup read a minute while the socket is live.
    expect(c.state.floorCalls - start).toBe((30 * MIN) / LIVE_BACKUP_MS)
    expect(p.view().state.kind).toBe('no_news')
    expect(p.onSignedOut).not.toHaveBeenCalled()
    p.stop()
  })

  it('a burst of «changed» (the hub uploading its queue) is one or two reads, never one per notice', async () => {
    const c = cloud(base)
    const p = await started(c)
    // The hub's back after a long cut and uploads 40 batches: the cloud notifies once per batch.
    await vi.advanceTimersByTimeAsync(FAST_GAP_MS)
    const before = c.state.floorCalls
    for (let i = 0; i < 40; i++) {
      p.last().says(JSON.stringify({ type: 'changed', reason: 'events' }))
      await vi.advanceTimersByTimeAsync(100)
    }
    // 4 seconds of notices: at most 2 reads (one gap of 3 s apart).
    expect(c.state.floorCalls - before).toBeLessThanOrEqual(2)
    await vi.advanceTimersByTimeAsync(FAST_GAP_MS)
    // And the last notice is never lost: the panel ends up having read after it.
    expect(c.state.floorCalls - before).toBeGreaterThanOrEqual(1)
    p.stop()
  })
})

describe('the socket dies in the middle of service', () => {
  it('shows «Sin conexión en vivo», keeps polling at 15 s, reconnects in a second and reads what it missed', async () => {
    const c = cloud(base)
    const p = await started(c)
    expect(p.connection.state()).toBe('live')
    await vi.advanceTimersByTimeAsync(5 * SECOND)
    const before = c.state.floorCalls
    p.last().closes(1006)
    expect(p.connection.state()).toBe('down')
    // While it is down the backup read goes every 15 s (the next one was due in 60).
    await vi.advanceTimersByTimeAsync(RECONNECT_FIRST_MS - 1)
    expect(p.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(p.sockets).toHaveLength(2)
    // Something happened while it did not listen: opening again says «changed».
    c.state.orders = []
    c.state.tickets = []
    p.last().opens()
    await vi.advanceTimersByTimeAsync(FAST_GAP_MS)
    expect(c.state.floorCalls).toBeGreaterThan(before)
    expect(p.answers.at(-1)?.data?.orders).toEqual([])
    expect(p.connection.state()).toBe('live')
    expect(p.onSignedOut).not.toHaveBeenCalled()
    p.stop()
  })

  it('while it is down, the screen keeps up by itself every 15 s (the next backup is not 60 s away)', async () => {
    const c = cloud(base)
    const p = await started(c)
    // Half a minute of live socket: the next backup read is 60 s after the last one.
    await vi.advanceTimersByTimeAsync(30 * SECOND)
    p.last().closes(1006)
    // Reconnecting never works: the cloud is gone (new sockets close before opening).
    const before = c.state.floorCalls
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(EVERY_MS)
      p.last().closes(1006)
    }
    expect(c.state.floorCalls - before).toBeGreaterThanOrEqual(5)
    p.stop()
  })
})

const RECONNECT_FIRST_MS = 1000

describe('a deploy cuts every socket', () => {
  it('reconnects, tolerating a few refused upgrades, and never signs out because of them', async () => {
    const c = cloud(base)
    const p = await started(c)
    // The deploy: the socket is closed by the server (going away) and, for a few seconds, the
    // upgrades are refused (they never open).
    p.last().closes(1001)
    for (let i = 0; i < FAILURES_BEFORE_CHECK; i++) {
      await vi.advanceTimersByTimeAsync(60 * SECOND)
      p.last().closes(1006)
    }
    // After three failures it asks whether the session is alive; it is, so it keeps trying.
    await vi.advanceTimersByTimeAsync(0)
    expect(c.state.meCalls).toBeGreaterThanOrEqual(1)
    expect(p.onSignedOut).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60 * SECOND)
    // The new version is up: the next socket opens and the panel reads again.
    const before = c.state.floorCalls
    p.last().opens()
    await vi.advanceTimersByTimeAsync(FAST_GAP_MS)
    expect(p.connection.state()).toBe('live')
    expect(c.state.floorCalls).toBeGreaterThan(before)
    p.stop()
  })

  it('many panels cut together do not come back at the same second (the chance spreads the waits)', async () => {
    const waits: number[] = []
    for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
      const sockets: { at: number; socket: FakeSocket }[] = []
      const connection = createLive({
        url: 'wss://panel.faro.test/v1/panel/live',
        open: () => {
          const socket = new FakeSocket()
          sockets.push({ at: Date.now(), socket })
          return socket
        },
        visibility: { hidden: () => false, subscribe: () => () => {} },
        network: { subscribe: () => () => {} },
        checkSession: async () => ({}),
        onSignedOut: () => {},
        random: () => roll,
      })
      connection.start()
      sockets[0]?.socket.opens()
      // The deploy closes it (going away).
      sockets[0]?.socket.closes(1001)
      await vi.advanceTimersByTimeAsync(2000)
      connection.stop()
      expect(sockets).toHaveLength(2)
      waits.push((sockets[1]?.at ?? 0) - (sockets[0]?.at ?? 0))
    }
    expect(new Set(waits).size).toBe(5)
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(800)
    expect(Math.max(...waits)).toBeLessThanOrEqual(1200)
  })
})

describe('the phone loses its internet', () => {
  it('keeps the last floor flagged as old, never signs out, and recovers by itself when the internet returns', async () => {
    const c = cloud(base)
    const p = await started(c)
    c.state.reachable = false
    p.last().closes(1006)
    // Five minutes without internet: every read fails, every reconnection never opens.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(15 * SECOND)
      const s = p.last()
      if (s.readyState !== 3) s.closes(1006)
    }
    const offline = p.view()
    expect(offline.state.kind).toBe('offline')
    // The floor on screen is the last one that arrived, with the times stopped at that answer.
    expect(offline.time.now).toBe(Date.parse(base.server_now))
    expect(offline.delay).toBe('late')
    expect(p.answers.at(-1)?.data?.orders).toEqual(base.orders)
    expect(p.onSignedOut).not.toHaveBeenCalled()

    // The internet is back: the browser says «online», the socket opens and the panel reads.
    c.state.reachable = true
    // The hub never stopped calling the cloud: only the phone was cut.
    c.state.hubSeenAt = new Date(Date.now()).toISOString()
    c.state.orders = []
    c.state.tickets = []
    await vi.advanceTimersByTimeAsync(0)
    p.goOnline()
    p.last().opens()
    await vi.advanceTimersByTimeAsync(FAST_GAP_MS + 15 * SECOND)
    const online = p.view()
    expect(online.state.kind).toBe('up_to_date')
    expect(p.answers.at(-1)?.data?.orders).toEqual([])
    expect(p.connection.state()).toBe('live')
    p.stop()
  })

  it('the session really ended while it was out: the check that follows signs out', async () => {
    const c = cloud(base)
    const p = await started(c)
    c.state.sessionAlive = false
    p.last().closes(4401)
    await vi.advanceTimersByTimeAsync(0)
    expect(p.onSignedOut).toHaveBeenCalledTimes(1)
    expect(p.connection.state()).toBe('down')
    // And it stays quiet: no sockets, no reads after signing out.
    const sockets = p.sockets.length
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(p.sockets).toHaveLength(sockets)
    p.stop()
  })
})

describe('the tab goes to the background and comes back', () => {
  it('asks nothing while hidden and reads exactly once on coming back, with a new socket', async () => {
    const c = cloud(base)
    const p = await started(c)
    p.hide(true)
    const hiddenAt = c.state.floorCalls
    const socketsBefore = p.sockets.length
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(c.state.floorCalls).toBe(hiddenAt)
    expect(p.sockets).toHaveLength(socketsBefore)
    // Seen while hidden (the hub went quiet and came back): nothing is lost, it reads on return.
    c.state.hubSeenAt = new Date(Date.now()).toISOString()
    p.hide(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(c.state.floorCalls).toBe(hiddenAt + 1)
    expect(p.sockets).toHaveLength(socketsBefore + 1)
    p.last().opens()
    await vi.advanceTimersByTimeAsync(FAST_GAP_MS)
    // Coming back did not make it read twice.
    expect(c.state.floorCalls).toBe(hiddenAt + 1)
    expect(p.view().state.kind).toBe('up_to_date')
    p.stop()
  })

  it('hidden before the socket opened: the late opening of the old socket is ignored', async () => {
    const c = cloud(base)
    const p = panel(c)
    await vi.advanceTimersByTimeAsync(0)
    const stale = p.last()
    p.hide(true)
    stale.opens()
    expect(p.connection.state()).toBe('down')
    p.hide(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(p.sockets).toHaveLength(2)
    p.last().opens()
    expect(p.connection.state()).toBe('live')
    p.stop()
  })

  it('«changed» that arrives while hidden does not read; the tab does not wake for it', async () => {
    const c = cloud(base)
    const p = await started(c)
    const socket = p.last()
    p.hide(true)
    const before = c.state.floorCalls
    socket.says(JSON.stringify({ type: 'changed', reason: 'events' }))
    await vi.advanceTimersByTimeAsync(MIN)
    expect(c.state.floorCalls).toBe(before)
    p.stop()
  })
})

describe('a phone with the wrong clock', () => {
  for (const [name, hours] of [
    ['five hours ahead', 5],
    ['three days behind', -72],
  ] as const) {
    it(`${name}: durations and «sin noticias» follow the cloud’s clock`, async () => {
      const skew = hours * 60 * MIN
      vi.setSystemTime(new Date(Date.parse(base.server_now) + skew))
      const c = cloud(base, skew)
      const p = await started(c)
      expect(p.view().state.kind).toBe('up_to_date')
      expect(p.view().delay).toBe('late')
      await vi.advanceTimersByTimeAsync(2 * MIN + SECOND)
      expect(p.view().state.kind).toBe('no_news')
      // Frozen at the hub's last call, in the restaurant's time (not the phone’s).
      expect(plain(p.view().time.frozenAt)).toBe('10:20 a. m.')
      expect(Math.abs(p.view().time.now - Date.parse(base.local.last_seen_at ?? ''))).toBe(0)
      p.stop()
    })
  }

  it('the figures run with the cloud’s time plus what passed here, so a ticket turns red on time', async () => {
    const skew = 7 * 60 * MIN
    vi.setSystemTime(new Date(Date.parse(base.server_now) + skew))
    const c = cloud(base, skew)
    const p = await started(c)
    expect(p.view().delay).toBe('late')
    // The hub keeps calling: it is in touch, so the times run.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(MIN)
      c.state.hubSeenAt = new Date(Date.now() - skew).toISOString()
    }
    await vi.advanceTimersByTimeAsync(MIN)
    // 20 min at the start + 11 min: past the 30 min of red.
    expect(p.view().state.kind).toBe('up_to_date')
    expect(p.view().delay).toBe('very_late')
    p.stop()
  })
})

describe('the hub restarts with changes to upload', () => {
  it('shows what is still on its way and never invents the orders it has not sent', async () => {
    const c = cloud(base)
    const p = await started(c)
    // The hub restarts: its changes are queued; it calls the cloud (alive) but its new orders
    // have not arrived. The panel shows only what the cloud has, and says how many are missing.
    c.state.pending = 23
    c.state.hubSeenAt = new Date(Date.now()).toISOString()
    p.last().says(JSON.stringify({ type: 'changed', reason: 'back_online' }))
    await vi.advanceTimersByTimeAsync(FAST_GAP_MS)
    const view = p.view()
    expect(view.state.kind).toBe('up_to_date')
    expect(view.state.pending).toBe('Faltan 23 datos del local por llegar')
    expect(p.answers.at(-1)?.data?.orders).toEqual(base.orders)
    // The queue drains; the next notice brings the new order and the line goes away.
    c.state.pending = 0
    p.last().says(JSON.stringify({ type: 'changed', reason: 'events' }))
    await vi.advanceTimersByTimeAsync(FAST_GAP_MS)
    expect(p.view().state.pending).toBeNull()
    p.stop()
  })

  it(`the «sin noticias» threshold is the same ${NO_NEWS_MS / MIN} minutes after a restart`, () => {
    expect(NO_NEWS_MS).toBe(2 * MIN)
  })
})

describe('a socket that will not stay up', () => {
  it('opening and dropping every second never makes more than one read per gap', async () => {
    const c = cloud(base)
    const p = await started(c)
    const before = c.state.floorCalls
    // A server that accepts and drops at once, for two minutes.
    for (let i = 0; i < 100; i++) {
      p.last().closes(1006)
      await vi.advanceTimersByTimeAsync(RECONNECT_FIRST_MS * 1.2)
      if (p.last().readyState === 0) p.last().opens()
    }
    const seconds = (100 * RECONNECT_FIRST_MS * 1.2) / SECOND
    expect(c.state.floorCalls - before).toBeLessThanOrEqual(
      Math.ceil(seconds / (FAST_GAP_MS / SECOND)) + 1,
    )
    expect(p.onSignedOut).not.toHaveBeenCalled()
    p.stop()
  })

  it('never leaves more than one socket open, however the tab flips between hidden and visible', async () => {
    const c = cloud(base)
    const p = await started(c)
    for (let i = 0; i < 6; i++) {
      p.hide(true)
      p.hide(false)
      await vi.advanceTimersByTimeAsync(0)
      if (p.last().readyState === 0) p.last().opens()
    }
    expect(p.sockets.filter((s) => s.readyState !== 3)).toHaveLength(1)
    p.stop()
    expect(p.sockets.filter((s) => s.readyState !== 3)).toHaveLength(0)
  })

  it('a late «pong» from a socket already given up on is ignored', async () => {
    const c = cloud(base)
    const p = await started(c)
    const dead = p.last()
    dead.answersPings = false
    await vi.advanceTimersByTimeAsync(25_000 + 10_000 + RECONNECT_FIRST_MS)
    // No pong for 10 s: it dropped it and opened another one.
    expect(p.sockets).toHaveLength(2)
    dead.says('pong')
    dead.says(JSON.stringify({ type: 'changed', reason: 'events' }))
    const before = c.state.floorCalls
    await vi.advanceTimersByTimeAsync(FAST_GAP_MS)
    // The dead socket’s notice did not read; only the reconnection’s «changed» may have.
    expect(c.state.floorCalls - before).toBeLessThanOrEqual(1)
    p.stop()
  })

  // While the session check after three failures is in flight, the browser’s `online` is kept: when
  // the check ends it connects at once, not after the grown wait (the docs promise «al instante»).
  it('«online» while the session is being checked still reconnects at once', async () => {
    const c = cloud(base)
    const p = await started(c)
    c.state.reachable = false
    p.last().closes(1006)
    for (let i = 0; i < FAILURES_BEFORE_CHECK - 1; i++) {
      await vi.advanceTimersByTimeAsync(60 * SECOND)
      p.last().closes(1006)
    }
    // The third failure starts the check; the network comes back before it ends.
    await vi.advanceTimersByTimeAsync(60 * SECOND)
    p.last().closes(1006)
    c.state.reachable = true
    const before = p.sockets.length
    p.goOnline()
    await vi.advanceTimersByTimeAsync(1)
    expect(p.sockets.length).toBe(before + 1)
    p.stop()
  })
})
