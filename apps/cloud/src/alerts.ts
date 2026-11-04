import {
  ALERT_EVENT_TYPES,
  type Alert,
  alerts,
  type OrderEvent,
  type Report,
  type RestaurantConfig,
  report,
} from '@pos/core'
import type { ReportData } from '@pos/sync'
import {
  type CloudStore,
  cloudReportData,
  latestReceipt,
  loadMissing,
  MAX_ROUNDS,
  type Scope,
  untilComplete,
} from './reports'
import type { Sql } from './sql'

// The day's alerts for the owner's panel (task 1.11c-2, docs/PANEL.md#alertas): `alerts()` of
// @pos/core over the hub's report of the day (its voids, cancellations, register closes and the
// money the hub did not apply, task 1.7b) and the day's discounts, voided payments, refunds and
// reopened orders, with every event of their orders.

/** How many days back the panel can look at the alerts (the reports' longest period). */
export const ALERT_DAYS = 14

/** What `report()` reads for voids and cancellations, and whose orders the alerts need. */
const REPORTED = new Set(['ItemVoided', 'OrderCanceled', 'PaymentVoided', 'RefundRecorded'])

export interface DayAlerts {
  alerts: Alert[]
  asOf: string | null
}

/**
 * The alerts of a business day. `loaded` is the day's report data already read (the dashboard has
 * it): its store is reused and only what is missing is read; with its `report()` already computed
 * (same config), it is not computed again.
 */
export async function dayAlerts(
  tx: Sql,
  scope: Scope,
  day: string,
  config: RestaurantConfig,
  loaded?: { data: ReportData; store: CloudStore; report?: Report },
): Promise<DayAlerts> {
  if (scope.hubIds.length === 0) return { alerts: [], asOf: null }
  const { data, store } = loaded ?? (await cloudReportData(tx, scope, day, day))
  const r =
    loaded?.report ??
    report({
      ...data,
      config: { sales_by_waiter: config.sales_by_waiter, rounding_mode: config.rounding_mode },
    })
  const { result: orders } = await untilComplete(
    store,
    MAX_ROUNDS,
    () => {
      const ids = new Set<string>()
      for (const e of store.periodEvents(ALERT_EVENT_TYPES, day, day)) ids.add(e.aggregate_id)
      for (const e of data.events) if (REPORTED.has(e.type)) ids.add(e.aggregate_id)
      // The unapplied money: its order says where it was (the table) and who authorized it.
      for (const u of r.unapplied) ids.add(u.orderId)
      return new Map<string, OrderEvent[]>([...ids].map((id) => [id, store.aggregateEvents(id)]))
    },
    (missing) => loadMissing(tx, scope, store, missing),
    'Las alertas',
  )
  return {
    alerts: alerts({
      day,
      voids: r.voids,
      cancellations: r.cancellations,
      orders,
      registerClosings: data.registerClosings,
      unapplied: r.unapplied,
      threshold: config.register_variance_threshold,
    }),
    asOf: latestReceipt(store.eventsSince(0, Number.MAX_SAFE_INTEGER)),
  }
}

/**
 * The names of those tables, from the catalog snapshot: only its `tables`, and of each table only
 * its id and name (a malformed one is left out).
 */
export async function tableNames(
  tx: Sql,
  restaurantId: string,
  locationId: string,
  ids: readonly string[],
): Promise<Record<string, string>> {
  if (ids.length === 0) return {}
  const [row] = await tx.query<{ tables: unknown }>(
    `SELECT content #> '{tables}' AS tables FROM snapshots
     WHERE restaurant_id = $1 AND location_id = $2 AND kind = 'catalog'`,
    [restaurantId, locationId],
  )
  const wanted = new Set(ids)
  const out: Record<string, string> = {}
  for (const t of Array.isArray(row?.tables) ? row.tables : []) {
    const { id, name } = (t ?? {}) as { id?: unknown; name?: unknown }
    if (typeof id === 'string' && typeof name === 'string' && wanted.has(id)) out[id] = name
  }
  return out
}
