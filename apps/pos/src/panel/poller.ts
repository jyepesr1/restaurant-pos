import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type LiveFeed, useLiveFeed } from './live'
import type { Polled } from './summary'
import { documentVisibility, type Visibility } from './visibility'

// Asks every so often while the tab is visible (task 1.11c-1: every 15 s). Hidden, it does not ask;
// back in view, it asks at once. A failure keeps the last good answer and says it failed, so the
// screen can say from when its data is. Requests never overlap: the next one is scheduled when
// the previous one finishes. With the live socket (task 1.11c-2, live.ts) «changed» reads again,
// with a minimum gap so a burst of notices is one or two reads, and the backup read slows to 60 s.

export { documentVisibility, type Visibility } from './visibility'

export const EMPTY: Polled<never> = {
  data: null,
  receivedAt: null,
  failed: false,
  error: null,
  errorKind: null,
}

/** The `kind` of an error that has one (PanelError), without depending on the client. */
const kindOf = (e: unknown): string | null => {
  const kind = (e as { kind?: unknown } | null)?.kind
  return typeof kind === 'string' ? kind : null
}

/** With the socket live, a backup read this often (in case a notice was lost). */
export const LIVE_BACKUP_MS = 60_000
/** At most one read this often after «changed» on «Salón» and «Cocina»… */
export const FAST_GAP_MS = 3_000
/** …and on the other screens (Hoy, Caja, Alertas, Reportes de hoy). */
export const SLOW_GAP_MS = 10_000

export function startPolling<T>({
  fetch,
  everyMs,
  visibility,
  onChange,
  clock = () => new Date().toISOString(),
  live = null,
  liveEveryMs = LIVE_BACKUP_MS,
  minGapMs = SLOW_GAP_MS,
}: {
  fetch: () => Promise<T>
  /** The backup read without a live socket (15 s). */
  everyMs: number
  visibility: Visibility
  onChange: (state: Polled<T>) => void
  clock?: () => string
  /** The tab's live connection (live.ts): «changed» reads again, and the backup slows down. */
  live?: LiveFeed | null
  /** The backup read while the socket is live. */
  liveEveryMs?: number
  /** After «changed», never two reads closer than this (measured from when each one started). */
  minGapMs?: number
}): Polling {
  let state: Polled<T> = EMPTY
  let timer: ReturnType<typeof setTimeout> | null = null
  /** When the scheduled read runs (ms), to keep the earliest one, and why it is scheduled. */
  let dueAt = 0
  let kind: 'backup' | 'changed' = 'backup'
  let inFlight = false
  let stopped = false
  /** A «changed» arrived during a read: one more read when it ends. */
  let changedMeanwhile = false
  let lastStart = Number.NEGATIVE_INFINITY
  let lastEnd = Date.now()

  const backupMs = () => (live?.state() === 'live' ? liveEveryMs : everyMs)
  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const at = (when: number, why: typeof kind) => {
    cancel()
    if (stopped || visibility.hidden()) return
    dueAt = when
    kind = why
    timer = setTimeout(ask, Math.max(0, when - Date.now()))
  }
  /** The next backup read, counted from the end of the last one. */
  const schedule = () => at(lastEnd + backupMs(), 'backup')
  /** A read because something changed: as soon as the gap allows, unless one is already sooner. */
  const soon = () => {
    const when = Math.max(Date.now(), lastStart + minGapMs)
    if (timer && dueAt <= when) return
    at(when, 'changed')
  }

  async function ask() {
    timer = null
    if (stopped || inFlight || visibility.hidden()) return
    inFlight = true
    changedMeanwhile = false
    lastStart = Date.now()
    try {
      const data = await fetch()
      state = { data, receivedAt: clock(), failed: false, error: null, errorKind: null }
    } catch (e) {
      state = {
        ...state,
        failed: true,
        error: e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.',
        errorKind: kindOf(e),
      }
    } finally {
      inFlight = false
      lastEnd = Date.now()
    }
    if (stopped) return
    onChange(state)
    if (changedMeanwhile) soon()
    else schedule()
  }

  const stopListening = visibility.subscribe(() => {
    if (visibility.hidden()) cancel()
    else void ask()
  })
  const stopLive = live?.subscribe({
    changed: () => {
      // Hidden it does not ask: coming back into view reads at once anyway.
      if (stopped || visibility.hidden()) return
      if (inFlight) changedMeanwhile = true
      else soon()
    },
    // The socket went up or down: the backup read moves to 60 s or 15 s.
    state: () => {
      if (timer && kind === 'backup') schedule()
    },
  })
  void ask()

  const stop = () => {
    stopped = true
    cancel()
    stopListening()
    stopLive?.()
  }
  return Object.assign(stop, {
    now: () => {
      // «Intentar ahora»: never on top of a read in progress.
      if (stopped || inFlight) return
      cancel()
      void ask()
    },
  })
}

/** Stops the polling when called; `now()` reads at once («Intentar ahora»). */
export type Polling = (() => void) & { now: () => void }

/**
 * `startPolling` for a screen: it starts when it appears and stops when it goes. With the tab's
 * live connection (LiveContext) it reads again after «changed», at most once every `minGapMs`.
 */
export function usePolling<T>(
  fetch: () => Promise<T>,
  everyMs: number,
  {
    enabled = true,
    visibility = documentVisibility,
    minGapMs = SLOW_GAP_MS,
  }: { enabled?: boolean; visibility?: Visibility; minGapMs?: number } = {},
): Polled<T> {
  const [state, setState] = useState<Polled<T>>(EMPTY)
  const live = useLiveFeed()
  const polling = useRef<Polling | null>(null)
  useEffect(() => {
    if (!enabled) return
    const p = startPolling({ fetch, everyMs, visibility, onChange: setState, live, minGapMs })
    polling.current = p
    return () => {
      polling.current = null
      p()
    }
  }, [fetch, everyMs, enabled, visibility, live, minGapMs])
  const retry = useCallback(() => polling.current?.now(), [])
  return useMemo(() => ({ ...state, retry }), [state, retry])
}
