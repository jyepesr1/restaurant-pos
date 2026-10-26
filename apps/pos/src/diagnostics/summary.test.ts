import { describe, expect, it } from 'vitest'
import type { DiagnosticEvent } from './log'
import { FORCED_RELOAD_THRESHOLD_MS, summarizeEvents } from './summary'

describe('summarizeEvents', () => {
  it('counts loads, discards and reconnections', () => {
    const events: DiagnosticEvent[] = [
      { time: 1, type: 'load', detail: { discarded: false } },
      { time: 2, type: 'ws-open', detail: { reconnections: 0 } },
      { time: 3, type: 'ws-open', detail: { reconnections: 1 } },
      { time: 4, type: 'load', detail: { discarded: true } },
    ]

    expect(summarizeEvents(events)).toMatchObject({ loads: 2, discards: 1, reconnections: 1 })
  })

  it('measures each hide and whether the connection was lost meanwhile', () => {
    const events: DiagnosticEvent[] = [
      { time: 1000, type: 'hidden' },
      { time: 4000, type: 'visible' },
      { time: 10_000, type: 'hidden' },
      { time: 12_000, type: 'ws-closed', detail: { code: 1006 } },
      { time: 70_000, type: 'visible' },
    ]

    expect(summarizeEvents(events).hiddenPeriods).toEqual([
      { durationMs: 3000, connectionLost: false, reloaded: false, recoveryMs: null },
      { durationMs: 60_000, connectionLost: true, reloaded: false, recoveryMs: null },
    ])
  })

  it('uses the check made on return and the real duration the event carries', () => {
    const events: DiagnosticEvent[] = [
      { time: 1000, type: 'hidden' },
      // Logged 3 s after returning, after waiting for the hub's response.
      { time: 34_000, type: 'visible', detail: { durationMs: 30_000, keptConnection: false } },
    ]

    expect(summarizeEvents(events).hiddenPeriods).toEqual([
      { durationMs: 30_000, connectionLost: true, reloaded: false, recoveryMs: null },
    ])
  })

  it('counts a load that arrives after being hidden as a forced reload (Safari on iPhone)', () => {
    const events: DiagnosticEvent[] = [
      { time: 1000, type: 'load', detail: { discarded: false } },
      { time: 2000, type: 'hidden' },
      { time: 300_000, type: 'load', detail: { discarded: false } },
    ]

    const summary = summarizeEvents(events)
    expect(summary.discards).toBe(1)
    expect(summary.hiddenPeriods).toEqual([
      { durationMs: 298_000, connectionLost: true, reloaded: true, recoveryMs: null },
    ])
  })

  it('does not count a manual reload as forced (hidden only for an instant)', () => {
    const events: DiagnosticEvent[] = [
      { time: 1000, type: 'hidden' },
      { time: 1000 + FORCED_RELOAD_THRESHOLD_MS - 1, type: 'load', detail: { discarded: false } },
    ]

    const summary = summarizeEvents(events)
    expect(summary.discards).toBe(0)
    expect(summary.hiddenPeriods).toEqual([])
  })

  it('with events in the same millisecond keeps the logging order (id)', () => {
    const events: DiagnosticEvent[] = [
      { id: 2, time: 500, type: 'ws-closed', detail: { code: 1006 } },
      { id: 1, time: 500, type: 'hidden' },
      { id: 3, time: 9000, type: 'visible' },
    ]

    expect(summarizeEvents(events).hiddenPeriods[0]?.connectionLost).toBe(true)
  })

  it('measures how long it took to reconnect after returning, even if logged before "visible"', () => {
    const events: DiagnosticEvent[] = [
      { time: 1000, type: 'hidden' },
      { time: 6000, type: 'ws-closed', detail: { code: 1006 } },
      // Returns at 46,000; reconnects 800 ms later; "visible" is logged when the check finishes.
      { time: 46_800, type: 'ws-open', detail: { reconnections: 1, msSinceVisible: 800 } },
      { time: 49_000, type: 'visible', detail: { durationMs: 45_000, keptConnection: false } },
    ]

    expect(summarizeEvents(events).hiddenPeriods).toEqual([
      { durationMs: 45_000, connectionLost: true, reloaded: false, recoveryMs: 800 },
    ])
  })

  it('measures recovery when the reconnection arrives after "visible"', () => {
    const events: DiagnosticEvent[] = [
      { time: 1000, type: 'hidden' },
      { time: 34_000, type: 'visible', detail: { durationMs: 30_000, keptConnection: false } },
      { time: 61_000, type: 'ws-open', detail: { reconnections: 1, msSinceVisible: 30_000 } },
    ]

    expect(summarizeEvents(events).hiddenPeriods[0]?.recoveryMs).toBe(30_000)
  })

  it('after a forced reload measures from the load until the connection opens', () => {
    const events: DiagnosticEvent[] = [
      { time: 2000, type: 'hidden' },
      { time: 300_000, type: 'load', detail: { discarded: false } },
      { time: 300_400, type: 'ws-open', detail: { reconnections: 0 } },
    ]

    expect(summarizeEvents(events).hiddenPeriods[0]?.recoveryMs).toBe(400)
  })

  it('if it reconnected on its own while hidden, recovery is 0', () => {
    const events: DiagnosticEvent[] = [
      { time: 1000, type: 'hidden' },
      { time: 2000, type: 'ws-closed', detail: { code: 1006 } },
      { time: 3000, type: 'ws-open', detail: { reconnections: 1 } },
      { time: 9000, type: 'visible', detail: { durationMs: 5000, keptConnection: false } },
    ]

    expect(summarizeEvents(events).hiddenPeriods[0]?.recoveryMs).toBe(0)
  })

  it('with several hides in a row, each reconnection is assigned to its own hide', () => {
    const events: DiagnosticEvent[] = [
      { time: 1000, type: 'hidden' },
      { time: 2000, type: 'ws-closed', detail: { code: 1006 } },
      { time: 3000, type: 'visible', detail: { durationMs: 2000, keptConnection: false } },
      { time: 3500, type: 'ws-open', detail: { reconnections: 1, msSinceVisible: 500 } },
      { time: 10_000, type: 'hidden' },
      { time: 11_000, type: 'ws-closed', detail: { code: 1006 } },
      { time: 14_000, type: 'visible', detail: { durationMs: 4000, keptConnection: false } },
      { time: 18_000, type: 'ws-open', detail: { reconnections: 2, msSinceVisible: 4000 } },
    ]

    expect(summarizeEvents(events).hiddenPeriods).toEqual([
      { durationMs: 2000, connectionLost: true, reloaded: false, recoveryMs: 500 },
      { durationMs: 4000, connectionLost: true, reloaded: false, recoveryMs: 4000 },
    ])
  })

  it('when hiding and returning several times offline, only the last return takes the reconnection', () => {
    const events: DiagnosticEvent[] = [
      { time: 1000, type: 'hidden' },
      { time: 1100, type: 'ws-closed', detail: { code: 1006 } },
      // Each "visible" is logged instantly because the next hide cuts the check short.
      { time: 1200, type: 'visible', detail: { durationMs: 200, keptConnection: false } },
      { time: 1300, type: 'hidden' },
      { time: 1400, type: 'visible', detail: { durationMs: 100, keptConnection: false } },
      { time: 1500, type: 'hidden' },
      { time: 1600, type: 'ws-open', detail: { reconnections: 1, msSinceVisible: 80 } },
      { time: 4700, type: 'visible', detail: { durationMs: 100, keptConnection: false } },
    ]

    const recoveries = summarizeEvents(events).hiddenPeriods.map((o) => o.recoveryMs)
    expect(recoveries).toEqual([null, null, 80])
  })

  it('a normal reconnection without "msSinceVisible" does not change the recovery already measured', () => {
    const events: DiagnosticEvent[] = [
      { time: 1000, type: 'hidden' },
      { time: 2000, type: 'ws-closed', detail: { code: 1006 } },
      { time: 4000, type: 'ws-open', detail: { reconnections: 1, msSinceVisible: 900 } },
      { time: 5000, type: 'visible', detail: { durationMs: 4000, keptConnection: false } },
      // A later drop with the screen on: not part of the lock.
      { time: 20_000, type: 'ws-closed', detail: { code: 1006 } },
      { time: 21_000, type: 'ws-open', detail: { reconnections: 2 } },
    ]

    const summary = summarizeEvents(events)
    expect(summary.hiddenPeriods[0]?.recoveryMs).toBe(900)
    expect(summary.reconnections).toBe(2)
  })

  it('if the connection survived the lock it does not invent a recovery', () => {
    const events: DiagnosticEvent[] = [
      { time: 1000, type: 'hidden' },
      { time: 4000, type: 'visible', detail: { durationMs: 3000, keptConnection: true } },
      // A separate drop, with the screen already on, that also carries "msSinceVisible".
      { time: 9000, type: 'ws-open', detail: { reconnections: 1, msSinceVisible: 700 } },
    ]

    expect(summarizeEvents(events).hiddenPeriods).toEqual([
      { durationMs: 3000, connectionLost: false, reloaded: false, recoveryMs: null },
    ])
  })

  it('a "visible" without reconnection leaves recovery pending (still reconnecting)', () => {
    const events: DiagnosticEvent[] = [
      { time: 1000, type: 'hidden' },
      { time: 2000, type: 'ws-closed', detail: { code: 1006 } },
      {
        time: 8000,
        type: 'visible',
        detail: { durationMs: 6000, keptConnection: false, openOnReturn: false },
      },
      // Failed attempts on return: they close without ever opening.
      { time: 8500, type: 'ws-closed', detail: { code: 1011 } },
      { time: 9500, type: 'ws-closed', detail: { code: 1011 } },
    ]

    expect(summarizeEvents(events).hiddenPeriods).toEqual([
      { durationMs: 6000, connectionLost: true, reloaded: false, recoveryMs: null },
    ])
  })

  it('with no events returns an empty summary', () => {
    expect(summarizeEvents([])).toEqual({
      loads: 0,
      discards: 0,
      reconnections: 0,
      hiddenPeriods: [],
    })
  })
})
