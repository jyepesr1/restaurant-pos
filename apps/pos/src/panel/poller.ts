import { useEffect, useState } from 'react'
import type { Polled } from './summary'

// Asks every so often while the tab is visible (task 1.11c-1: every 15 s). Hidden, it does not ask;
// back in view, it asks at once. A failure keeps the last good answer and says it failed, so the
// screen can say from when its data is. Requests never overlap: the next one is scheduled when
// the previous one finishes.

export interface Visibility {
  hidden(): boolean
  /** Calls `change` when the tab is shown or hidden; returns how to stop listening. */
  subscribe(change: () => void): () => void
}

export const documentVisibility: Visibility = {
  hidden: () => document.visibilityState === 'hidden',
  subscribe: (change) => {
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  },
}

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

export function startPolling<T>({
  fetch,
  everyMs,
  visibility,
  onChange,
  clock = () => new Date().toISOString(),
}: {
  fetch: () => Promise<T>
  everyMs: number
  visibility: Visibility
  onChange: (state: Polled<T>) => void
  clock?: () => string
}): () => void {
  let state: Polled<T> = EMPTY
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let stopped = false

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!stopped && !visibility.hidden()) timer = setTimeout(ask, everyMs)
  }
  async function ask() {
    timer = null
    if (stopped || inFlight || visibility.hidden()) return
    inFlight = true
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
    }
    if (stopped) return
    onChange(state)
    schedule()
  }

  const stopListening = visibility.subscribe(() => {
    if (visibility.hidden()) {
      if (timer) clearTimeout(timer)
      timer = null
    } else void ask()
  })
  void ask()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    stopListening()
  }
}

/** `startPolling` for a screen: it starts when it appears and stops when it goes. */
export function usePolling<T>(
  fetch: () => Promise<T>,
  everyMs: number,
  enabled = true,
  visibility: Visibility = documentVisibility,
): Polled<T> {
  const [state, setState] = useState<Polled<T>>(EMPTY)
  useEffect(() => {
    if (!enabled) return
    return startPolling({ fetch, everyMs, visibility, onChange: setState })
  }, [fetch, everyMs, enabled, visibility])
  return state
}
