import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveFeed, LiveListener, LiveState } from './live'
import { FAST_GAP_MS, LIVE_BACKUP_MS, SLOW_GAP_MS, startPolling, type Visibility } from './poller'
import type { Polled } from './summary'

// Asking the cloud every 15 s while the tab is in view (task 1.11c-1), and with the live socket
// (task 1.11c-2): reading again after «changed» without bursts, and the backup at 60 s or 15 s.

function tab(hidden = false) {
  let listener: (() => void) | null = null
  const visibility: Visibility = {
    hidden: () => hidden,
    subscribe: (change) => {
      listener = change
      return () => {
        listener = null
      }
    },
  }
  return {
    visibility,
    set(h: boolean) {
      hidden = h
      listener?.()
    },
    listening: () => listener !== null,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('polling', () => {
  it('asks at once and then every 15 s', async () => {
    const fetch = vi.fn(async () => 'ok')
    const t = tab()
    const stop = startPolling({
      fetch,
      everyMs: 15_000,
      visibility: t.visibility,
      onChange: () => {},
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetch).toHaveBeenCalledTimes(4)
    stop()
  })

  it('hidden it does not ask; back in view it asks at once', async () => {
    const fetch = vi.fn(async () => 'ok')
    const t = tab()
    const stop = startPolling({
      fetch,
      everyMs: 15_000,
      visibility: t.visibility,
      onChange: () => {},
    })
    await vi.advanceTimersByTimeAsync(0)
    t.set(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    t.set(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fetch).toHaveBeenCalledTimes(3)
    stop()
  })

  it('opened in a hidden tab, it waits until it is shown', async () => {
    const fetch = vi.fn(async () => 'ok')
    const t = tab(true)
    const stop = startPolling({
      fetch,
      everyMs: 15_000,
      visibility: t.visibility,
      onChange: () => {},
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).not.toHaveBeenCalled()
    t.set(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledOnce()
    stop()
  })

  it('a failure keeps the last good data and says it failed; the next good answer clears it', async () => {
    const answers: (string | Error)[] = ['first', new Error('Sin conexión con la nube'), 'third']
    const fetch = vi.fn(async () => {
      const a = answers.shift()
      if (a instanceof Error) throw a
      return a ?? 'more'
    })
    const states: Polled<string>[] = []
    const clock = vi.fn(() => `t${states.length}`)
    const stop = startPolling({
      fetch,
      everyMs: 15_000,
      visibility: tab().visibility,
      onChange: (s) => states.push(s),
      clock,
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(states[0]).toEqual({
      data: 'first',
      receivedAt: 't0',
      failed: false,
      error: null,
      errorKind: null,
    })
    expect(states[1]).toEqual({
      data: 'first',
      receivedAt: 't0',
      failed: true,
      error: 'Sin conexión con la nube',
      errorKind: null,
    })
    expect(states[2]).toMatchObject({ data: 'third', failed: false, error: null })
    stop()
  })

  it('keeps the kind of the failure, to tell no internet from the rest', async () => {
    const states: Polled<string>[] = []
    const stop = startPolling({
      fetch: async () => {
        throw Object.assign(new Error('Tu sesión se cerró.'), { kind: 'unauthorized' })
      },
      everyMs: 15_000,
      visibility: tab().visibility,
      onChange: (s) => states.push(s),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(states[0]).toMatchObject({ failed: true, errorKind: 'unauthorized' })
    stop()
  })

  it('requests never overlap: a slow one delays the next', async () => {
    let finish: (v: string) => void = () => {}
    const fetch = vi.fn(() => new Promise<string>((r) => (finish = r)))
    const t = tab()
    const stop = startPolling({
      fetch,
      everyMs: 15_000,
      visibility: t.visibility,
      onChange: () => {},
    })
    await vi.advanceTimersByTimeAsync(60_000)
    // Shown again while the first one is still on its way: it does not ask twice.
    t.set(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    finish('ok')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    stop()
  })

  it('«Intentar ahora» asks at once, never on top of a read, and the next backup counts from it', async () => {
    let finish: (v: string) => void = () => {}
    const fetch = vi.fn(() => new Promise<string>((r) => (finish = r)))
    const t = tab()
    const polling = startPolling({
      fetch,
      everyMs: 15_000,
      visibility: t.visibility,
      onChange: () => {},
    })
    // The first read is still on its way: asking now does not ask twice.
    polling.now()
    expect(fetch).toHaveBeenCalledTimes(1)
    finish('ok')
    await vi.advanceTimersByTimeAsync(5_000)
    polling.now()
    expect(fetch).toHaveBeenCalledTimes(2)
    finish('ok')
    await vi.advanceTimersByTimeAsync(14_999)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(3)
    polling()
    polling.now()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('stopped, it asks no more, stops listening and does not report a late answer', async () => {
    let finish: (v: string) => void = () => {}
    const fetch = vi.fn(() => new Promise<string>((r) => (finish = r)))
    const onChange = vi.fn()
    const t = tab()
    const stop = startPolling({ fetch, everyMs: 15_000, visibility: t.visibility, onChange })
    stop()
    expect(t.listening()).toBe(false)
    finish('late')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onChange).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

/** A fake live connection: the test says when it is up and when something changed. */
function liveFeed(initial: LiveState = 'live') {
  let state = initial
  const listeners = new Set<LiveListener>()
  const feed: LiveFeed = {
    state: () => state,
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
  return {
    feed,
    changed: () => {
      for (const l of listeners) l.changed?.()
    },
    set(s: LiveState) {
      state = s
      for (const l of listeners) l.state?.(s)
    },
    listeners: () => listeners.size,
  }
}

describe('polling with the live socket (task 1.11c-2)', () => {
  /** A fetch that answers when the test says, to see what overlaps. */
  function slowFetch() {
    const pending: ((v: string) => void)[] = []
    const fetch = vi.fn(() => new Promise<string>((r) => pending.push(r)))
    return { fetch, finish: () => pending.shift()?.('ok') }
  }

  it('the backup read goes every 60 s while live and every 15 s when the socket is down', async () => {
    const fetch = vi.fn(async () => 'ok')
    const l = liveFeed('live')
    const stop = startPolling({
      fetch,
      everyMs: 15_000,
      visibility: tab().visibility,
      onChange: () => {},
      live: l.feed,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(LIVE_BACKUP_MS - 1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    // The socket drops 20 s after that read: the next one is due 15 s after it, so at once.
    await vi.advanceTimersByTimeAsync(20_000)
    l.set('down')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fetch).toHaveBeenCalledTimes(4)
    // Live again: back to 60 s from the last read.
    l.set('live')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fetch).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(fetch).toHaveBeenCalledTimes(5)
    stop()
  })

  it('«changed» reads again, at most once per gap; a burst is one read', async () => {
    const fetch = vi.fn(async () => 'ok')
    const l = liveFeed()
    const stop = startPolling({
      fetch,
      everyMs: 15_000,
      visibility: tab().visibility,
      onChange: () => {},
      live: l.feed,
      minGapMs: FAST_GAP_MS,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    // Right after the first read: it waits until 3 s after it started.
    await vi.advanceTimersByTimeAsync(1000)
    for (let i = 0; i < 10; i++) l.changed()
    await vi.advanceTimersByTimeAsync(1999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    // Long after: at once.
    await vi.advanceTimersByTimeAsync(10_000)
    l.changed()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(3)
    stop()
  })

  it('the other screens wait 10 s between reads after «changed»', async () => {
    const fetch = vi.fn(async () => 'ok')
    const l = liveFeed()
    const stop = startPolling({
      fetch,
      everyMs: 15_000,
      visibility: tab().visibility,
      onChange: () => {},
      live: l.feed,
    })
    await vi.advanceTimersByTimeAsync(0)
    l.changed()
    await vi.advanceTimersByTimeAsync(SLOW_GAP_MS - 1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    stop()
  })

  it('a «changed» during a read: never on top of it, and one more read after it', async () => {
    const { fetch, finish } = slowFetch()
    const l = liveFeed()
    const stop = startPolling({
      fetch,
      everyMs: 15_000,
      visibility: tab().visibility,
      onChange: () => {},
      live: l.feed,
      minGapMs: FAST_GAP_MS,
    })
    await vi.advanceTimersByTimeAsync(0)
    l.changed()
    l.changed()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    finish()
    // The read took longer than the gap: the final one goes at once.
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    finish()
    // Nothing else arrived: back to the backup pace.
    await vi.advanceTimersByTimeAsync(LIVE_BACKUP_MS - 1)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(3)
    stop()
  })

  it('a quick read with a «changed» during it waits for the gap before the final read', async () => {
    const { fetch, finish } = slowFetch()
    const l = liveFeed()
    const stop = startPolling({
      fetch,
      everyMs: 15_000,
      visibility: tab().visibility,
      onChange: () => {},
      live: l.feed,
      minGapMs: SLOW_GAP_MS,
    })
    await vi.advanceTimersByTimeAsync(0)
    l.changed()
    await vi.advanceTimersByTimeAsync(500)
    finish()
    await vi.advanceTimersByTimeAsync(SLOW_GAP_MS - 501)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    stop()
  })

  it('hidden it does not ask even with «changed»; back in view it asks at once, only once', async () => {
    const fetch = vi.fn(async () => 'ok')
    const l = liveFeed()
    const t = tab()
    const stop = startPolling({
      fetch,
      everyMs: 15_000,
      visibility: t.visibility,
      onChange: () => {},
      live: l.feed,
      minGapMs: FAST_GAP_MS,
    })
    await vi.advanceTimersByTimeAsync(0)
    t.set(true)
    l.changed()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    t.set(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(FAST_GAP_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
    stop()
  })

  it('«changed» does not push back a backup read that is already sooner', async () => {
    const fetch = vi.fn(async () => 'ok')
    const l = liveFeed('down')
    const stop = startPolling({
      fetch,
      everyMs: 15_000,
      visibility: tab().visibility,
      onChange: () => {},
      live: l.feed,
      minGapMs: SLOW_GAP_MS,
    })
    await vi.advanceTimersByTimeAsync(14_000)
    l.changed()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(2)
    stop()
  })

  it('stopped, it stops listening to the socket too', async () => {
    const l = liveFeed()
    const stop = startPolling({
      fetch: async () => 'ok',
      everyMs: 15_000,
      visibility: tab().visibility,
      onChange: () => {},
      live: l.feed,
    })
    expect(l.listeners()).toBe(1)
    stop()
    expect(l.listeners()).toBe(0)
  })
})
