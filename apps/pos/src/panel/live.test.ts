import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelError } from './api'
import {
  createLive,
  FAILURES_BEFORE_CHECK,
  type LiveState,
  liveUrl,
  type Network,
  PING_EVERY_MS,
  POLICY_VIOLATION,
  PONG_WITHIN_MS,
  RECONNECT_DELAYS_MS,
  SESSION_ENDED,
  type SocketLike,
  STABLE_AFTER_MS,
} from './live'
import type { Visibility } from './visibility'

// The panel's live socket (task 1.11c-2, docs/PANEL.md#aviso-en-vivo-websocket) with a fake WebSocket and fake
// timers: one socket per visible tab, the ping and the missing pong, reconnecting with growing
// waits, at once when coming back into view or online, and checking the session after a 4401 or
// three failures in a row.

class FakeSocket implements SocketLike {
  readyState = 0
  sent: string[] = []
  closedWith: number | null = null
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  readonly url: string
  constructor(url: string) {
    this.url = url
  }
  send(data: string) {
    this.sent.push(data)
  }
  close(code = 1000) {
    this.closedWith = code
    this.readyState = 3
  }
  // What the network does:
  opens() {
    this.readyState = 1
    this.onopen?.({})
  }
  says(data: unknown) {
    this.onmessage?.({ data })
  }
  closes(code = 1006) {
    this.readyState = 3
    this.onerror?.({})
    this.onclose?.({ code })
  }
}

function world({ hidden = false, random = 0.5 } = {}) {
  const sockets: FakeSocket[] = []
  let visibilityChange: (() => void) | null = null
  let online: (() => void) | null = null
  const visibility: Visibility = {
    hidden: () => hidden,
    subscribe: (change) => {
      visibilityChange = change
      return () => {
        visibilityChange = null
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
  const checkSession = vi.fn(async (): Promise<unknown> => ({}))
  const onSignedOut = vi.fn()
  const states: LiveState[] = []
  let changed = 0
  const live = createLive({
    url: 'wss://panel.faro.test/v1/panel/live',
    open: (url) => {
      const s = new FakeSocket(url)
      sockets.push(s)
      return s
    },
    visibility,
    network,
    checkSession,
    onSignedOut,
    random: () => random,
  })
  live.subscribe({
    changed: () => {
      changed++
    },
    state: (s) => states.push(s),
  })
  return {
    live,
    sockets,
    states,
    checkSession,
    onSignedOut,
    changed: () => changed,
    last: () => sockets.at(-1) as FakeSocket,
    open: () => sockets.filter((s) => s.readyState !== 3),
    setHidden(h: boolean) {
      hidden = h
      visibilityChange?.()
    },
    goOnline: () => online?.(),
    listening: () => visibilityChange !== null && online !== null,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('live connection', () => {
  it('the address: wss on https, ws on plain http (wrangler dev)', () => {
    expect(liveUrl({ protocol: 'https:', host: 'faro.app' })).toBe('wss://faro.app/v1/panel/live')
    expect(liveUrl({ protocol: 'http:', host: 'localhost:8787' })).toBe(
      'ws://localhost:8787/v1/panel/live',
    )
  })

  it('opens one socket when started; connecting, then live', () => {
    const w = world()
    w.live.start()
    expect(w.sockets).toHaveLength(1)
    expect(w.last().url).toBe('wss://panel.faro.test/v1/panel/live')
    expect(w.live.state()).toBe('connecting')
    w.last().opens()
    expect(w.live.state()).toBe('live')
    // Starting again does not open a second one.
    w.live.start()
    expect(w.sockets).toHaveLength(1)
  })

  it('a hidden tab opens nothing; in view it opens at once', () => {
    const w = world({ hidden: true })
    w.live.start()
    expect(w.sockets).toHaveLength(0)
    w.setHidden(false)
    expect(w.sockets).toHaveLength(1)
  })

  it('«changed» from the cloud reaches the screens; anything else is ignored', () => {
    const w = world()
    w.live.start()
    w.last().opens()
    w.last().says(JSON.stringify({ type: 'changed', reason: 'events' }))
    w.last().says(JSON.stringify({ type: 'other' }))
    w.last().says('not json')
    w.last().says('null')
    w.last().says(new ArrayBuffer(4))
    w.last().says('pong')
    expect(w.changed()).toBe(1)
  })

  it('pings every 25 s; without a pong in 10 s it drops the socket and reconnects', async () => {
    const w = world()
    w.live.start()
    const first = w.last()
    first.opens()
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS)
    expect(first.sent).toEqual(['ping'])
    first.says('pong')
    await vi.advanceTimersByTimeAsync(PONG_WITHIN_MS)
    expect(first.closedWith).toBeNull()
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS - PONG_WITHIN_MS)
    expect(first.sent).toEqual(['ping', 'ping'])
    // No answer this time.
    await vi.advanceTimersByTimeAsync(PONG_WITHIN_MS)
    expect(first.closedWith).not.toBeNull()
    expect(w.live.state()).toBe('down')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0] as number)
    expect(w.sockets).toHaveLength(2)
    // The dead socket's late close changes nothing.
    first.onclose?.({ code: 1006 })
    expect(w.sockets).toHaveLength(2)
  })

  it('reconnects after 1, 2, 5, 10, 20, 30, 30 s… (with ±20 % chance)', async () => {
    const w = world({ random: 0 })
    w.live.start()
    w.last().opens()
    w.last().closes()
    // Each failed attempt (never opened) waits longer; the third one in a row checks the session.
    const waits: number[] = []
    for (let i = 0; i < 7; i++) {
      const before = w.sockets.length
      let waited = 0
      while (w.sockets.length === before) {
        await vi.advanceTimersByTimeAsync(100)
        waited += 100
      }
      waits.push(waited)
      // The attempt fails without opening: the next wait is longer.
      w.last().closes()
    }
    // With random 0 each wait is 80 % of the base. The checks after 3 failures do not reset it.
    expect(waits).toEqual([800, 1600, 4000, 8000, 16_000, 24_000, 24_000])
  })

  it('the chance spreads the waits between 80 % and 120 %', async () => {
    const w = world({ random: 1 })
    w.live.start()
    w.last().opens()
    w.last().closes()
    await vi.advanceTimersByTimeAsync(1199)
    expect(w.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(w.sockets).toHaveLength(2)
  })

  it(`once live again for ${STABLE_AFTER_MS / 1000} s the wait starts over from 1 s`, async () => {
    const w = world({ random: 0.5 })
    w.live.start()
    w.last().closes()
    await vi.advanceTimersByTimeAsync(1000)
    w.last().closes()
    await vi.advanceTimersByTimeAsync(2000)
    w.last().opens()
    await vi.advanceTimersByTimeAsync(STABLE_AFTER_MS)
    w.last().closes()
    await vi.advanceTimersByTimeAsync(999)
    expect(w.sockets).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(w.sockets).toHaveLength(4)
  })

  it('a server that accepts and drops at once is not retried every second: the wait keeps growing', async () => {
    const w = world({ random: 0.5 })
    w.live.start()
    const waits: number[] = []
    for (let i = 0; i < 5; i++) {
      w.last().opens()
      w.last().closes()
      const before = w.sockets.length
      let waited = 0
      while (w.sockets.length === before) {
        await vi.advanceTimersByTimeAsync(100)
        waited += 100
      }
      waits.push(waited)
    }
    expect(waits).toEqual([1000, 2000, 5000, 10_000, 20_000])
    // It opened every time: none of them is a failure that asks for the session.
    expect(w.checkSession).not.toHaveBeenCalled()
  })

  it(`closed with ${POLICY_VIOLATION}: no reconnecting in a loop; it tries again back in view or online`, async () => {
    const w = world()
    w.live.start()
    w.last().opens()
    w.last().closes(POLICY_VIOLATION)
    expect(w.live.state()).toBe('down')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(w.sockets).toHaveLength(1)
    expect(w.checkSession).not.toHaveBeenCalled()
    w.goOnline()
    expect(w.sockets).toHaveLength(2)
    w.last().opens()
    w.last().closes(POLICY_VIOLATION)
    w.setHidden(true)
    w.setHidden(false)
    expect(w.sockets).toHaveLength(3)
    expect(w.onSignedOut).not.toHaveBeenCalled()
  })

  it('closed with 4401 after a while live (revalidation, or too many sockets): checks the session and opens another at once', async () => {
    const w = world({ random: 0.5 })
    w.live.start()
    w.last().opens()
    // Live for a while (less than a ping and its pong: the fake socket does not answer pings).
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS - 1)
    w.last().closes(SESSION_ENDED)
    await vi.advanceTimersByTimeAsync(0)
    expect(w.checkSession).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(w.sockets).toHaveLength(2)
    w.last().opens()
    expect(w.live.state()).toBe('live')
    expect(w.onSignedOut).not.toHaveBeenCalled()
  })

  it('«online» or back in view while the session is checked: once it is alive, connects at once', async () => {
    const w = world({ random: 0.5 })
    let alive: (v: unknown) => void = () => {}
    w.checkSession.mockImplementationOnce(() => new Promise((r) => (alive = r)))
    w.live.start()
    w.last().opens()
    w.last().closes(SESSION_ENDED)
    w.goOnline()
    // While checking it does not open: the session may be over.
    expect(w.sockets).toHaveLength(1)
    alive({})
    await vi.advanceTimersByTimeAsync(0)
    expect(w.sockets).toHaveLength(2)
  })

  it('«online» while the check finds the session over: out, without opening', async () => {
    const w = world()
    let over: (e: unknown) => void = () => {}
    w.checkSession.mockImplementationOnce(() => new Promise((_, r) => (over = r)))
    w.live.start()
    w.last().opens()
    w.last().closes(SESSION_ENDED)
    w.goOnline()
    over(new PanelError('unauthorized', 'x', 401))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.sockets).toHaveLength(1)
    expect(w.onSignedOut).toHaveBeenCalledTimes(1)
  })

  it('a reopen after a drop says «changed» (what happened meanwhile was not heard)', async () => {
    const w = world()
    w.live.start()
    w.last().opens()
    expect(w.changed()).toBe(0)
    w.last().closes()
    await vi.advanceTimersByTimeAsync(2000)
    w.last().opens()
    expect(w.changed()).toBe(1)
  })

  it('back online or back in view: tries at once instead of waiting', async () => {
    const w = world()
    w.live.start()
    w.last().opens()
    w.last().closes()
    expect(w.sockets).toHaveLength(1)
    w.goOnline()
    expect(w.sockets).toHaveLength(2)
    w.last().closes()
    w.setHidden(true)
    w.setHidden(false)
    expect(w.sockets).toHaveLength(3)
    // Online while a socket is open does not open another.
    w.last().opens()
    w.goOnline()
    expect(w.sockets).toHaveLength(3)
  })

  it('hidden: closes its socket and does not reconnect; in view: opens again, without «changed»', async () => {
    const w = world()
    w.live.start()
    const first = w.last()
    first.opens()
    w.setHidden(true)
    expect(first.closedWith).toBe(1000)
    expect(w.live.state()).toBe('down')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(w.sockets).toHaveLength(1)
    w.setHidden(false)
    expect(w.live.state()).toBe('connecting')
    w.last().opens()
    expect(w.sockets).toHaveLength(2)
    // The screens read at once when they come back into view: no extra notice.
    expect(w.changed()).toBe(0)
  })

  it('closed with 4401: checks the session and, if it is over, signs out and stops', async () => {
    const w = world()
    w.checkSession.mockRejectedValueOnce(new PanelError('unauthorized', 'x', 401))
    w.live.start()
    w.last().opens()
    w.last().closes(SESSION_ENDED)
    await vi.advanceTimersByTimeAsync(0)
    expect(w.checkSession).toHaveBeenCalledTimes(1)
    expect(w.onSignedOut).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.sockets).toHaveLength(1)
    expect(w.listening()).toBe(false)
  })

  it('closed with 4401 but the session is alive (or it is not known): keeps reconnecting', async () => {
    const w = world()
    w.checkSession.mockRejectedValueOnce(new PanelError('offline', 'x'))
    w.live.start()
    w.last().opens()
    w.last().closes(SESSION_ENDED)
    await vi.advanceTimersByTimeAsync(0)
    expect(w.onSignedOut).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1200)
    expect(w.sockets).toHaveLength(2)
    w.last().closes(SESSION_ENDED)
    await vi.advanceTimersByTimeAsync(0)
    expect(w.checkSession).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2400)
    expect(w.sockets).toHaveLength(3)
    expect(w.onSignedOut).not.toHaveBeenCalled()
  })

  it(`${FAILURES_BEFORE_CHECK} attempts in a row that never open: checks the session (a 401 on the upgrade looks like this)`, async () => {
    const w = world()
    w.checkSession.mockRejectedValueOnce(new PanelError('unauthorized', 'x', 401))
    w.live.start()
    w.last().closes()
    await vi.advanceTimersByTimeAsync(1200)
    w.last().closes()
    expect(w.checkSession).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2400)
    w.last().closes()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.checkSession).toHaveBeenCalledTimes(1)
    expect(w.onSignedOut).toHaveBeenCalledTimes(1)
  })

  it('a drop after being live is not a failure: no session check', async () => {
    const w = world()
    w.live.start()
    for (let i = 0; i < 5; i++) {
      w.last().opens()
      await vi.advanceTimersByTimeAsync(STABLE_AFTER_MS)
      w.last().closes()
      await vi.advanceTimersByTimeAsync(1200)
    }
    expect(w.sockets).toHaveLength(6)
    expect(w.checkSession).not.toHaveBeenCalled()
  })

  it('a WebSocket that cannot even be created counts as a failure and is retried', async () => {
    let calls = 0
    const live = createLive({
      url: 'wss://x/v1/panel/live',
      open: () => {
        calls++
        throw new Error('blocked')
      },
      visibility: { hidden: () => false, subscribe: () => () => {} },
      network: { subscribe: () => () => {} },
      checkSession: async () => ({}),
      onSignedOut: () => {},
      random: () => 0.5,
    })
    live.start()
    expect(live.state()).toBe('down')
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(2)
    live.stop()
  })

  it('stop closes the socket, stops the timers and listening', async () => {
    const w = world()
    w.live.start()
    w.last().opens()
    w.live.stop()
    expect(w.last().closedWith).toBe(1000)
    expect(w.listening()).toBe(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(w.sockets).toHaveLength(1)
    expect(w.last().sent).toEqual([])
    // It can start again (React's StrictMode mounts twice).
    w.live.start()
    expect(w.sockets).toHaveLength(2)
  })

  it('a listener that throws does not stop the others', () => {
    const w = world()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    w.live.subscribe({
      changed: () => {
        throw new Error('boom')
      },
    })
    let other = 0
    w.live.subscribe({ changed: () => other++ })
    w.live.start()
    w.last().opens()
    w.last().says('{"type":"changed","reason":"events"}')
    expect(other).toBe(1)
    expect(w.changed()).toBe(1)
    error.mockRestore()
  })

  it('the states it goes through, in order', async () => {
    const w = world()
    w.live.start()
    w.last().opens()
    w.last().closes()
    await vi.advanceTimersByTimeAsync(1200)
    w.last().opens()
    expect(w.states).toEqual(['live', 'down', 'live'])
  })
})
