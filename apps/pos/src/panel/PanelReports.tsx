import { useCallback } from 'react'
import type { CheckoutRules } from '../floor/checks'
import type { Period } from '../floor/periods'
import { downloadCsv, ReportsBody, type ReportsState, useReports } from '../floor/ReportsView'
import { Button } from '../ui/Button'
import { useNotify } from '../ui/toasts'
import type { PanelApi } from './api'

// The register's Reportes, with the cloud's numbers (docs/PANEL.md): the same screen and the same
// formulas, without reprinting the Z report (the panel has no printer).

/**
 * The longest period the cloud answers in task 1.11c-1: a longer one weighs too much in the Worker
 * (31 days were about 35 MB). The long ones come with 1.11c-3.
 */
export const PANEL_MAX_DAYS = 14

export function useCloudReports(api: Pick<PanelApi, 'reports'>): ReportsState {
  const fetchReport = useCallback((p: Period | null) => api.reports(p), [api])
  return useReports(fetchReport)
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
