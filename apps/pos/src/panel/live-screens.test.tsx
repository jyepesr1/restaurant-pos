import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReportsState } from '../floor/ReportsView'
import { LiveContext, type LiveFeed, type LiveListener, type LiveState, useLiveState } from './live'
import { SLOW_GAP_MS } from './poller'
import { periodReportOf } from './testing'
import type { Visibility } from './visibility'

// What the screens do with the live socket (task 1.11c-2): the quiet «En vivo» mark, and
// «Reportes» reading again only when the period shown reaches today.

vi.mock('../ui/theme', () => ({
  useTheme: () => ({ theme: 'system', dark: false, select: () => {} }),
}))
const { LiveMark } = await import('./PanelFrame')
const { coversToday, refreshToday } = await import('./PanelReports')

/** The mark as PanelFrame shows it, with the tab's connection. */
function Mark() {
  return <LiveMark state={useLiveState()} />
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function feedIn(state: LiveState) {
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
  }
}

describe('the «En vivo» mark', () => {
  it('says whether the screen updates by itself', () => {
    expect(text(renderToStaticMarkup(<LiveMark state="live" />))).toBe('En vivo')
    expect(text(renderToStaticMarkup(<LiveMark state="connecting" />))).toBe('Conectando…')
    // Down, the screen still reads by itself: it says how often, in gray, without alarm.
    expect(text(renderToStaticMarkup(<LiveMark state="down" />))).toBe('Se actualiza cada 15 s')
    expect(renderToStaticMarkup(<LiveMark state="down" />)).toContain('text-muted')
    // Never green: in Faro green is «libre» and «listo».
    for (const state of ['live', 'connecting', 'down'] as const)
      expect(renderToStaticMarkup(<LiveMark state={state} />)).not.toMatch(/free/)
  })

  it('without a connection (tests, the register) there is no mark', () => {
    expect(renderToStaticMarkup(<Mark />)).toBe('')
    expect(
      text(
        renderToStaticMarkup(
          <LiveContext.Provider value={feedIn('live').feed}>
            <Mark />
          </LiveContext.Provider>,
        ),
      ),
    ).toBe('En vivo')
  })
})

describe('«Reportes» with the live socket', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const reportsState = (over: Partial<ReportsState> = {}): ReportsState => ({
    shortcut: 'today',
    select: () => {},
    requested: null,
    shown: {
      report: periodReportOf(),
      period: { from: '2026-10-29', until: '2026-10-29' },
    },
    loading: false,
    error: null,
    load: vi.fn(),
    ...over,
  })
  const visible = (hidden = false): Visibility => ({
    hidden: () => hidden,
    subscribe: () => () => {},
  })

  it('a period reaches today when it ends today (or later); not before anything arrived', () => {
    expect(coversToday(reportsState())).toBe(true)
    expect(
      coversToday(reportsState({ requested: { from: '2026-10-20', until: '2026-10-29' } })),
    ).toBe(true)
    expect(
      coversToday(reportsState({ requested: { from: '2026-10-20', until: '2026-10-28' } })),
    ).toBe(false)
    expect(coversToday(reportsState({ shown: null }))).toBe(false)
  })

  it('today: reads again after «changed», at most once every 10 s', async () => {
    const state = reportsState()
    const l = feedIn('live')
    const stop = refreshToday(l.feed, () => state, { visibility: visible() })
    for (let i = 0; i < 5; i++) l.changed()
    await vi.advanceTimersByTimeAsync(SLOW_GAP_MS - 1)
    expect(state.load).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(state.load).toHaveBeenCalledTimes(1)
    expect(state.load).toHaveBeenCalledWith(null)
    l.changed()
    await vi.advanceTimersByTimeAsync(SLOW_GAP_MS - 1)
    expect(state.load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(state.load).toHaveBeenCalledTimes(2)
    stop()
  })

  it('a past period is not read again', async () => {
    const state = reportsState({ requested: { from: '2026-10-01', until: '2026-10-07' } })
    const l = feedIn('live')
    const stop = refreshToday(l.feed, () => state, { visibility: visible() })
    l.changed()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.load).not.toHaveBeenCalled()
    stop()
  })

  it('never on top of a read in progress, nor while hidden', async () => {
    let state = reportsState({ loading: true })
    const l = feedIn('live')
    const stop = refreshToday(l.feed, () => state, { visibility: visible() })
    l.changed()
    await vi.advanceTimersByTimeAsync(SLOW_GAP_MS)
    expect(state.load).not.toHaveBeenCalled()
    state = reportsState()
    await vi.advanceTimersByTimeAsync(SLOW_GAP_MS)
    expect(state.load).toHaveBeenCalledTimes(1)
    stop()

    const hidden = reportsState()
    const stopHidden = refreshToday(l.feed, () => hidden, { visibility: visible(true) })
    l.changed()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hidden.load).not.toHaveBeenCalled()
    stopHidden()
  })

  it('stopped: a pending read does not happen', async () => {
    const state = reportsState()
    const l = feedIn('live')
    const stop = refreshToday(l.feed, () => state, { visibility: visible() })
    l.changed()
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.load).not.toHaveBeenCalled()
  })
})
