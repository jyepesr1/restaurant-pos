import type { DiagnosticEvent } from './log'

/**
 * If the page loads again after being hidden longer than this, it was not a manual reload:
 * the browser discarded it (Safari on iPhone does not expose `document.wasDiscarded`).
 */
export const FORCED_RELOAD_THRESHOLD_MS = 2000

export interface HiddenPeriod {
  durationMs: number
  /** The connection to the hub dropped while the screen was hidden or locked. */
  connectionLost: boolean
  /** The browser reloaded the page on return. */
  reloaded: boolean
  /** If the connection was lost: how long it took to come back after returning to the screen. */
  recoveryMs: number | null
}

export interface DiagnosticsSummary {
  loads: number
  /** Loads in which the browser had discarded the page and had to reload it on its own. */
  discards: number
  reconnections: number
  hiddenPeriods: HiddenPeriod[]
}

const byRecordOrder = (a: DiagnosticEvent, b: DiagnosticEvent) =>
  a.time - b.time || (a.id ?? 0) - (b.id ?? 0)

/** Summarizes the event log (in any order) for the connection test report. */
export function summarizeEvents(events: DiagnosticEvent[]): DiagnosticsSummary {
  const hiddenPeriods: HiddenPeriod[] = []
  let loads = 0
  let discards = 0
  let reconnections = 0
  let hiddenSince: number | null = null
  let lostWhileHidden = false
  // The reconnection may be logged before the "visible" event (which waits for the check).
  let pendingRecovery: number | null = null
  let loadAfterReload: number | null = null

  for (const { type, time, detail } of [...events].sort(byRecordOrder)) {
    switch (type) {
      case 'load': {
        loads += 1
        const afterHide = hiddenSince !== null && time - hiddenSince > FORCED_RELOAD_THRESHOLD_MS
        if (hiddenSince !== null && afterHide) {
          hiddenPeriods.push({
            durationMs: time - hiddenSince,
            connectionLost: true,
            reloaded: true,
            recoveryMs: null,
          })
          loadAfterReload = time
        }
        if (afterHide || detail?.discarded === true) discards += 1
        hiddenSince = null
        break
      }
      case 'hidden':
        hiddenSince = time
        lostWhileHidden = false
        pendingRecovery = null
        break
      case 'visible':
        if (hiddenSince !== null) {
          // The event is logged after checking the connection: the real duration is in the detail.
          const durationMs =
            typeof detail?.durationMs === 'number' ? detail.durationMs : time - hiddenSince
          const connectionLost = lostWhileHidden || detail?.keptConnection === false
          hiddenPeriods.push({
            durationMs,
            connectionLost,
            reloaded: false,
            recoveryMs: connectionLost ? pendingRecovery : null,
          })
        }
        hiddenSince = null
        pendingRecovery = null
        break
      case 'ws-closed':
        if (hiddenSince !== null) lostWhileHidden = true
        break
      case 'ws-open': {
        if (typeof detail?.reconnections === 'number' && detail.reconnections > 0)
          reconnections += 1
        const latest = hiddenPeriods.at(-1)
        if (loadAfterReload !== null && latest?.reloaded) {
          latest.recoveryMs = time - loadAfterReload
          loadAfterReload = null
        } else if (typeof detail?.msSinceVisible === 'number') {
          if (hiddenSince !== null) {
            pendingRecovery = detail.msSinceVisible
          } else if (latest?.connectionLost && latest.recoveryMs === null) {
            latest.recoveryMs = detail.msSinceVisible
          }
        } else if (hiddenSince !== null && lostWhileHidden) {
          // It reconnected on its own before the user came back.
          pendingRecovery = 0
        }
        break
      }
    }
  }

  return { loads, discards, reconnections, hiddenPeriods }
}
