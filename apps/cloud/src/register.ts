import type { ShiftReconciliation } from '@pos/core'
import { type ShiftClose, savedReconciliation, shiftClose } from '@pos/sync'
import { LIVE_MAX_ROUNDS } from './live'
import {
  type ClosingJson,
  CloudStore,
  closingJson,
  latestReceipt,
  loadMissing,
  type Scope,
  scopeFilter,
  untilComplete,
} from './reports'
import type { Sql } from './sql'

// The registers right now, for the owner's panel (task 1.11c-2, docs/PANEL.md#caja): the shifts
// still open with what each one should have, computed with the hub's own code
// (`savedReconciliation`), and the closes of the day. As with the open orders, there is no table of
// open shifts: they come out of the events.

/** The shifts whose last open or close since `since` (a business day) is an open. */
async function openShiftIds(tx: Sql, scope: Scope, since: string): Promise<string[]> {
  const f = scopeFilter(scope, 4)
  const rows = await tx.query<{ aggregate_id: string }>(
    `SELECT x.aggregate_id FROM (
       SELECT DISTINCT ON (e.aggregate_id) e.aggregate_id, e.type FROM events e
       WHERE e.restaurant_id = $1 AND e.hub_id = ANY($2::text[])
         AND e.type IN ('ShiftOpened', 'ShiftClosed') AND e.business_day >= $3::date${f.sql}
       ORDER BY e.aggregate_id, e.hub_sequence DESC
     ) x
     WHERE x.type = 'ShiftOpened'`,
    [scope.restaurantId, scope.hubIds, since, ...f.params],
  )
  return rows.map((r) => r.aggregate_id)
}

/** An open register: who opened it, when, and how it is going (the hub's reconciliation). */
export interface OpenRegister {
  shift_id: string
  /** The register device where it was opened (the cloud does not have its name). */
  register_id: string
  opened_at: string
  opened_by: string
  reconciliation: ShiftReconciliation
}

export interface RegistersNow {
  open: OpenRegister[]
  /** The day's closes, as the reports list them. */
  closed: ClosingJson[]
  /** The latest `received_at` among the events read (null without events). */
  asOf: string | null
  rounds: number
}

/**
 * The open shifts (their last open within `since`) and the closes of `today`. Each open shift's
 * reconciliation is the hub's `savedReconciliation` over its events, its charges and the payments
 * its voids reverse, loaded round after round until nothing is missing.
 */
export async function registersNow(
  tx: Sql,
  scopes: Scope | { open: Scope; closed: Scope },
  since: string,
  today: string,
): Promise<RegistersNow> {
  // The open ones are live (D1: not a revoked PC's); the closes are history (every hub).
  const { open: live, closed: scope } = 'open' in scopes ? scopes : { open: scopes, closed: scopes }
  if (scope.hubIds.length === 0) return { open: [], closed: [], asOf: null, rounds: 0 }
  const ids = live.hubIds.length === 0 ? [] : await openShiftIds(tx, live, since)
  const store = new CloudStore()
  // The open shifts' events and the day's closes up front; what they need comes round by round.
  await loadMissing(tx, scope, store, {
    aggregates: new Set(ids),
    shifts: new Map(),
    periods: [{ types: ['ShiftClosed'], from: today, until: today }],
  })
  const { result, rounds } = await untilComplete(
    store,
    LIVE_MAX_ROUNDS,
    () => ({
      open: ids.flatMap((id): OpenRegister[] => {
        const events = store.aggregateEvents(id)
        const opening = events.find((e) => e.type === 'ShiftOpened')
        const reconciliation = savedReconciliation(store, id, events)
        if (!opening || !reconciliation) return []
        return [
          {
            shift_id: id,
            register_id: reconciliation.registerId,
            opened_at: reconciliation.openedAt,
            opened_by: opening.user_id,
            reconciliation,
          },
        ]
      }),
      closed: store
        .periodEvents(['ShiftClosed'], today, today)
        .map((e) => shiftClose(store, e.aggregate_id))
        .filter((c): c is ShiftClose => c !== null),
    }),
    (missing) => loadMissing(tx, scope, store, missing),
    'La caja en vivo',
  )
  return {
    // By opening time; two at the same instant, by shift id (always the same order).
    open: result.open.sort((a, b) =>
      a.opened_at === b.opened_at
        ? a.shift_id < b.shift_id
          ? -1
          : a.shift_id > b.shift_id
            ? 1
            : 0
        : a.opened_at < b.opened_at
          ? -1
          : 1,
    ),
    closed: result.closed.map(closingJson),
    asOf: latestReceipt(store.eventsSince(0, Number.MAX_SAFE_INTEGER)),
    rounds,
  }
}
