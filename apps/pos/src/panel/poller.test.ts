import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startPolling, type Visibility } from './poller'
import type { Polled } from './summary'

// Asking the cloud every 15 s while the tab is in view (task 1.11c-1).

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
