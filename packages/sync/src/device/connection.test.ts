import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceMessage } from '../protocol'
import { type Channel, ConnectionManager, type Handlers } from './connection'

// Scenario 13 of docs/SYNC.md: reconnecting when returning to the screen, with a simulated clock.

class FakeChannel implements Channel {
  sentList: DeviceMessage[] = []
  closed = false
  readonly handlers: Handlers
  constructor(handlers: Handlers) {
    this.handlers = handlers
  }
  send(m: DeviceMessage) {
    this.sentList.push(m)
  }
  close() {
    this.closed = true
  }
}

function setup() {
  const channels: FakeChannel[] = []
  const statuses: string[] = []
  const events = { connected: 0, disconnected: 0 }
  const connectionManager = new ConnectionManager({
    open: (m) => {
      const channel = new FakeChannel(m)
      channels.push(channel)
      return channel
    },
    onConnect: () => {
      events.connected += 1
    },
    onDisconnect: () => {
      events.disconnected += 1
    },
    onMessage: () => {},
    onStateChange: (e) => statuses.push(e),
    timerFns: {
      now: () => Date.now(),
      setTimeout: (t, ms) => setTimeout(t, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      setInterval: (t, ms) => setInterval(t, ms),
      clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    },
  })
  const latest = () => channels.at(-1) as FakeChannel
  return { connectionManager, channels, statuses, events, latest }
}

describe('connection manager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('connects and notifies', () => {
    const { connectionManager, latest, events, statuses } = setup()
    connectionManager.begin()
    latest().handlers.onOpen()

    expect(events.connected).toBe(1)
    expect(statuses).toEqual(['connecting', 'connected'])
  })

  it('an attempt that does not open within 4 s is abandoned and retried with increasing delay', () => {
    const { connectionManager, channels } = setup()
    connectionManager.begin()

    vi.advanceTimersByTime(3999)
    expect(channels).toHaveLength(1)
    vi.advanceTimersByTime(1) // 4 s: abandoned
    expect(channels[0]?.closed).toBe(true)
    vi.advanceTimersByTime(1000) // first retry after one second
    expect(channels).toHaveLength(2)
    vi.advanceTimersByTime(4000 + 1999)
    expect(channels).toHaveLength(2)
    vi.advanceTimersByTime(1) // second retry after 2 s
    expect(channels).toHaveLength(3)
  })

  it('the delay between retries grows up to 5 s at most', () => {
    const { connectionManager, channels, latest } = setup()
    connectionManager.begin()
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      latest().handlers.onClose()
      const before = channels.length
      let ms = 0
      while (channels.length === before) {
        vi.advanceTimersByTime(100)
        ms += 100
      }
      delays.push(ms)
    }
    expect(delays).toEqual([1000, 2000, 3000, 4000, 5000, 5000, 5000])
  })

  it('returning to the screen while disconnected reconnects immediately, even if the retry was far off', () => {
    const { connectionManager, channels, latest } = setup()
    connectionManager.begin()
    latest().handlers.onOpen()
    connectionManager.changeVisibility(false)
    for (let i = 0; i < 4; i++) latest().handlers.onClose() // several closes: 4 s delay
    const before = channels.length

    connectionManager.changeVisibility(true)

    expect(channels.length).toBe(before + 1)
  })

  it('returning with a channel that looks open but does not respond discards it after 3 s', () => {
    const { connectionManager, channels, latest, events } = setup()
    connectionManager.begin()
    latest().handlers.onOpen()
    connectionManager.changeVisibility(false)
    vi.advanceTimersByTime(60_000)

    connectionManager.changeVisibility(true)
    expect(latest().sentList.at(-1)).toMatchObject({ type: 'ping' })
    vi.advanceTimersByTime(2999)
    expect(channels).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(channels[0]?.closed).toBe(true)
    expect(events.disconnected).toBe(1)
    // Just returned: the retry goes out immediately.
    vi.advanceTimersByTime(1)
    expect(channels).toHaveLength(2)
  })

  it('if it answers the ping, the channel stays', () => {
    const { connectionManager, channels, latest } = setup()
    connectionManager.begin()
    latest().handlers.onOpen()
    connectionManager.changeVisibility(false)
    vi.advanceTimersByTime(10_000)
    connectionManager.changeVisibility(true)
    vi.advanceTimersByTime(100)
    latest().handlers.onMessage({ type: 'pong', brand: 'x' })
    vi.advanceTimersByTime(5000)

    expect(channels).toHaveLength(1)
    expect(channels[0]?.closed).toBe(false)
  })

  it('a close right after returning is retried immediately', () => {
    const { connectionManager, channels, latest } = setup()
    connectionManager.begin()
    latest().handlers.onOpen()
    connectionManager.changeVisibility(false)
    connectionManager.changeVisibility(true)
    latest().handlers.onClose() // Safari reports the close on return

    vi.advanceTimersByTime(1)
    expect(channels).toHaveLength(2)
  })

  it('after returning, only the first retry is immediate: the following ones wait', () => {
    const { connectionManager, channels, latest } = setup()
    connectionManager.begin()
    latest().handlers.onOpen()
    connectionManager.changeVisibility(false)
    connectionManager.changeVisibility(true)
    latest().handlers.onClose() // the hub is not there: closes instantly
    vi.advanceTimersByTime(1)
    expect(channels).toHaveLength(2)

    latest().handlers.onClose() // second attempt in a row: now it waits (2 s)
    vi.advanceTimersByTime(1999)
    expect(channels).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(channels).toHaveLength(3)
  })

  it('stopping reports that it is disconnected', () => {
    const { connectionManager, latest, statuses, events } = setup()
    connectionManager.begin()
    latest().handlers.onOpen()
    connectionManager.stop()
    connectionManager.stop()

    expect(statuses).toEqual(['connecting', 'connected', 'disconnected'])
    expect(events.disconnected).toBe(1)
  })

  it('a channel that reports opening inside `open` is still handled', () => {
    const connectedCount: Channel[] = []
    const connectionManager = new ConnectionManager({
      open: (m) => {
        const channel = new FakeChannel(m)
        m.onOpen()
        return channel
      },
      onConnect: (channel) => connectedCount.push(channel),
      onDisconnect: () => {},
      onMessage: () => {},
    })
    connectionManager.begin()

    expect(connectedCount).toHaveLength(1)
    connectionManager.stop()
  })

  it('with no heartbeats for 15 s and the screen visible, discards and reconnects; with the screen hidden, it does not', () => {
    const { connectionManager, channels, latest } = setup()
    connectionManager.begin()
    latest().handlers.onOpen()

    vi.advanceTimersByTime(14_000)
    latest().handlers.onMessage({ type: 'heartbeat' })
    vi.advanceTimersByTime(14_000)
    expect(channels).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(channels[0]?.closed).toBe(true)

    vi.advanceTimersByTime(1000)
    latest().handlers.onOpen()
    connectionManager.changeVisibility(false)
    vi.advanceTimersByTime(60_000)
    expect(channels).toHaveLength(2)
  })

  it('an old channel that reports late does not affect the current one, and stopping cuts everything', () => {
    const { connectionManager, channels, latest, events } = setup()
    connectionManager.begin()
    const oldOne = latest()
    vi.advanceTimersByTime(4000 + 1000)
    latest().handlers.onOpen()
    oldOne.handlers.onOpen()
    oldOne.handlers.onClose()
    expect(events.connected).toBe(1)

    connectionManager.stop()
    vi.advanceTimersByTime(60_000)
    expect(channels).toHaveLength(2)
    expect(channels[1]?.closed).toBe(true)
  })
})
