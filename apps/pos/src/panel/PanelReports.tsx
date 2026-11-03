import { useCallback, useEffect, useRef } from 'react'
import type { CheckoutRules } from '../floor/checks'
import type { Period } from '../floor/periods'
import { downloadCsv, ReportsBody, type ReportsState, useReports } from '../floor/ReportsView'
import { Button } from '../ui/Button'
import { useNotify } from '../ui/toasts'
import type { PanelApi } from './api'
import { type LiveFeed, useLiveFeed } from './live'
import { SLOW_GAP_MS } from './poller'
import { documentVisibility, type Visibility } from './visibility'

// The register's Reportes, with the cloud's numbers (docs/PANEL.md): the same screen and the same
// formulas, without reprinting the Z report (the panel has no printer).

/**
 * The longest period the cloud answers in task 1.11c-1: a longer one weighs too much in the Worker
 * (31 days were about 35 MB). The long ones come with 1.11c-3.
 */
export const PANEL_MAX_DAYS = 14

export function useCloudReports(api: Pick<PanelApi, 'reports'>): ReportsState {
  const fetchReport = useCallback((p: Period | null) => api.reports(p), [api])
  const state = useReports(fetchReport)
  const current = useRef(state)
  current.current = state
  const live = useLiveFeed()
  useEffect(() => (live ? refreshToday(live, () => current.current) : undefined), [live])
  return state
}

/** Whether the report shown reaches today (only then can something new change it). */
export function coversToday(state: Pick<ReportsState, 'requested' | 'shown'>): boolean {
  const today = state.shown?.report.today
  if (!today) return false
  return (state.requested?.until ?? today) >= today
}

/**
 * «Reportes» of a period that reaches today reads again when the cloud says something changed:
 * at most once every 10 s, never on top of a read in progress, and not while the tab is hidden.
 * Returns how to stop.
 */
export function refreshToday(
  live: LiveFeed,
  state: () => ReportsState,
  {
    visibility = documentVisibility,
    gapMs = SLOW_GAP_MS,
  }: { visibility?: Visibility; gapMs?: number } = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let last = Date.now()
  const reload = () => {
    timer = null
    const s = state()
    if (visibility.hidden() || !coversToday(s)) return
    // A read in progress (the person's or this one): try again after the gap.
    if (s.loading) {
      timer = setTimeout(reload, gapMs)
      return
    }
    last = Date.now()
    s.load(s.requested)
  }
  const stop = live.subscribe({
    changed: () => {
      if (timer || visibility.hidden()) return
      timer = setTimeout(reload, Math.max(0, last + gapMs - Date.now()))
    },
  })
  return () => {
    stop()
    if (timer) clearTimeout(timer)
  }
}

export function CsvButton({
  state,
  rules,
  restaurant,
}: {
  state: ReportsState
  rules: CheckoutRules | null
  restaurant: string
}) {
  const notify = useNotify()
  const { shown } = state
  if (!shown) return null
  return (
    <Button
      icon="receipt"
      onClick={() => notify(`Descargaste ${downloadCsv(shown, rules, restaurant)}`)}
    >
      Descargar CSV
    </Button>
  )
}

export function PanelReports({
  state,
  rules,
}: {
  state: ReportsState
  rules: CheckoutRules | null
}) {
  return <ReportsBody state={state} rules={rules} maxDays={PANEL_MAX_DAYS} />
}
