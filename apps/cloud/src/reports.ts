import { type OrderEvent, type RestaurantConfig, report } from '@pos/core'
import {
  CHARGE_TYPES,
  type Conflict,
  type HubStore,
  type Rejection,
  type ReportData,
  reportData,
  type ShiftClose,
} from '@pos/sync'
import { aggregatesOf } from './cloud'
import type { Sql } from './sql'

// The hub's reports, computed in the cloud with the same code (task 1.11c-1, docs/PANEL.md):
// `reportData()` and `report()` read a `HubStore`; here it is one in memory loaded from Postgres.
// What `reportData` asks for and was not loaded (another order's events, a shift's charges) is
// noted; it is fetched and the report is run again, up to MAX_ROUNDS times. The events are those
// of one location (all its hubs: a re-registered PC continues the same `hub_sequence` series),
// ordered by that sequence, as in the hub.

/**
 * A period is at most this long in 1.11c-1: 31 days at the pilot's volume load ~35 MB of events at
 * once, too close to a Worker's 128 MB. Longer periods come with the closing cache (1.11c-3).
 */
export const MAX_PANEL_DAYS = 14
/** How many times `reportData` runs at most. */
export const MAX_ROUNDS = 4

/** What `reportData` reads by business day: loaded up front with the orders they touch. */
const PERIOD_TYPES = [
  'OrderClosed',
  'ShiftClosed',
  'PaymentRecorded',
  'PaymentVoided',
  'RefundRecorded',
  'ItemVoided',
  'OrderCanceled',
  'CashMovementRecorded',
]

/** Whose events are read: a restaurant's location, optionally only up to a point. */
export interface Scope {
  restaurantId: string
  /** The location's hubs (all, also revoked ones: their events still count). */
  hubIds: readonly string[]
  /** Only the events up to this `hub_sequence` of the location; null or missing for all. */
  upTo?: number | null
  /**
   * Only what the hub had received up to this instant: it becomes the highest `hub_sequence` with
   * `received_at` up to then (`sequenceAt`), so the cut is the hub's own order, not its clock.
   */
  asOf?: string | null
  /**
   * What is live (D1, docs/PANEL.md#pc-de-caja-revocado): only the events of the location's active
   * hubs, and of a revoked one only those up to `acknowledged` (the furthest an active hub has
   * uploaded with no gaps: a PC registered again resends the old one's events). Without it, every
   * hub counts (the reports and the alerts: history).
   */
  live?: { activeHubIds: readonly string[]; acknowledged: number }
}

/** In the hub's order (its `sequence`). */
export const bySequence = (a: OrderEvent, b: OrderEvent) => a.sequence - b.sequence

/** The latest `received_at` among the events (null without them): the answers' `as_of`. */
export function latestReceipt(events: Iterable<OrderEvent>): string | null {
  let latest: string | null = null
  for (const e of events)
    if (e.received_at && (!latest || e.received_at > latest)) latest = e.received_at
  return latest
}

/** What was asked for and not loaded. */
export interface Missing {
  aggregates: Set<string>
  /** Shift → from which business day its charges are needed. */
  shifts: Map<string, string>
  periods: { types: string[]; from: string; until: string }[]
}

/** Read-only `HubStore` in memory, with what was loaded from Postgres. */
export class CloudStore implements HubStore {
  private readonly events = new Map<string, OrderEvent>()
  private readonly byAggregate = new Map<string, OrderEvent[]>()
  private readonly sorted = new Set<string>()
  private readonly loadedAggregates = new Set<string>()
  private readonly loadedShifts = new Map<string, string>()
  private readonly loadedPeriods: { types: Set<string>; from: string; until: string }[] = []
  missing: Missing = { aggregates: new Set(), shifts: new Map(), periods: [] }

  private readonly idOfSequence = new Map<number, string>()

  get size() {
    return this.events.size
  }

  /**
   * Adds loaded events. Two different events with the same sequence in the location would make
   * the report wrong (the order of the events is the sequence): it fails instead.
   */
  add(events: Iterable<OrderEvent>) {
    for (const e of events) {
      if (this.events.has(e.id)) continue
      const other = this.idOfSequence.get(e.sequence)
      if (other !== undefined && other !== e.id)
        throw new Error(
          `Dos eventos distintos (${other} y ${e.id}) tienen la misma secuencia ${e.sequence} en la sede: no se calcula el reporte`,
        )
      this.idOfSequence.set(e.sequence, e.id)
      this.events.set(e.id, e)
      for (const a of aggregatesOf(e)) {
        const list = this.byAggregate.get(a)
        if (list) list.push(e)
        else this.byAggregate.set(a, [e])
        this.sorted.delete(a)
      }
    }
  }

  markAggregates(ids: Iterable<string>) {
    for (const id of ids) this.loadedAggregates.add(id)
  }
  markShift(shiftId: string, from: string) {
    const loaded = this.loadedShifts.get(shiftId)
    if (!loaded || from < loaded) this.loadedShifts.set(shiftId, from)
  }
  markPeriod(types: readonly string[], from: string, until: string) {
    this.loadedPeriods.push({ types: new Set(types), from, until })
  }
  isComplete() {
    const m = this.missing
    return m.aggregates.size === 0 && m.shifts.size === 0 && m.periods.length === 0
  }
  resetMissing() {
    this.missing = { aggregates: new Set(), shifts: new Map(), periods: [] }
  }
  allAggregates(): string[] {
    return [...this.byAggregate.keys()]
  }

  /**
   * The same store with only the events up to that sequence. What was complete stays complete:
   * every load is the same one with fewer events.
   */
  upTo(sequence: number): CloudStore {
    const cut = new CloudStore()
    cut.add([...this.events.values()].filter((e) => e.sequence <= sequence))
    cut.markAggregates(this.loadedAggregates)
    for (const [id, from] of this.loadedShifts) cut.markShift(id, from)
    for (const p of this.loadedPeriods) cut.markPeriod([...p.types], p.from, p.until)
    return cut
  }

  transaction<T>(job: () => T): T {
    return job()
  }
  maxSequence(): number {
    let max = 0
    for (const e of this.events.values()) max = Math.max(max, e.sequence)
    return max
  }
  byId(id: string) {
    const event = this.events.get(id)
    return event ? { event, fingerprint: '' } : undefined
  }
  rejection(_eventId: string, _fingerprint: string): Rejection | undefined {
    return undefined
  }
  conflictOf(_eventId: string): Conflict | undefined {
    return undefined
  }
  lastSequenceOf(aggregates: readonly string[], except?: string): number {
    let max = 0
    for (const a of aggregates)
      for (const e of this.aggregateEvents(a))
        if (e.device_id !== except) max = Math.max(max, e.sequence)
    return max
  }
  aggregateEvents(aggregateId: string): OrderEvent[] {
    if (!this.loadedAggregates.has(aggregateId)) this.missing.aggregates.add(aggregateId)
    const list = this.byAggregate.get(aggregateId)
    if (!list) return []
    if (!this.sorted.has(aggregateId)) {
      list.sort(bySequence)
      this.sorted.add(aggregateId)
    }
    return [...list]
  }
  quarantinesOf(_deviceId: string): number {
    return 0
  }
  dayOpenings(day: string): number {
    let n = 0
    for (const e of this.events.values())
      if (e.type === 'OrderOpened' && e.business_day === day) n++
    return n
  }
  ticketsOfDay(day: string): number {
    let n = 0
    for (const e of this.events.values())
      if (e.type === 'ItemsSent' && e.business_day === day)
        n += Object.keys(e.assignments.ticket_numbers ?? {}).length
    return n
  }
  eventsSince(from: number, limit: number): OrderEvent[] {
    return [...this.events.values()]
      .filter((e) => e.sequence > from)
      .sort(bySequence)
      .slice(0, limit)
  }
  periodEvents(types: readonly string[], from: string, until: string): OrderEvent[] {
    const uncovered = types.filter(
      (t) => !this.loadedPeriods.some((p) => p.types.has(t) && p.from <= from && p.until >= until),
    )
    if (uncovered.length > 0) this.missing.periods.push({ types: uncovered, from, until })
    return [...this.events.values()]
      .filter((e) => types.includes(e.type) && e.business_day >= from && e.business_day <= until)
      .sort(bySequence)
  }
  shiftCharges(shiftId: string, from: string): OrderEvent[] {
    const loaded = this.loadedShifts.get(shiftId)
    if (loaded === undefined || loaded > from) {
      const asked = this.missing.shifts.get(shiftId)
      this.missing.shifts.set(shiftId, asked && asked < from ? asked : from)
    }
    return [...this.events.values()]
      .filter(
        (e) =>
          CHARGE_TYPES.includes(e.type) &&
          e.business_day >= from &&
          (e.data as { register_shift_id?: string }).register_shift_id === shiftId,
      )
      .sort(bySequence)
  }
  saveEvent(): void {
    throw new Error('El almacén de reportes de la nube es de solo lectura')
  }
  saveRejection(): void {
    throw new Error('El almacén de reportes de la nube es de solo lectura')
  }
  saveQuarantine(): void {
    throw new Error('El almacén de reportes de la nube es de solo lectura')
  }
  saveConflict(): void {
    throw new Error('El almacén de reportes de la nube es de solo lectura')
  }
  conflicts(): Conflict[] {
    return []
  }
}

// ── Loading from Postgres ────────────────────────────────────────────────

const contents = (rows: { content: unknown }[]) => rows.map((r) => r.content as OrderEvent)

/**
 * What the scope adds to a query over `events e` whose next parameter is `$n`: `AND
 * e.hub_sequence <= …` when it stops at a sequence, and only what is live with `live`.
 */
export function scopeFilter(scope: Scope, n: number): { sql: string; params: unknown[] } {
  let sql = ''
  const params: unknown[] = []
  if (scope.upTo !== null && scope.upTo !== undefined) {
    sql += ` AND e.hub_sequence <= $${n + params.length}::bigint`
    params.push(scope.upTo)
  }
  if (scope.live) {
    sql += ` AND (e.hub_id = ANY($${n + params.length}::text[]) OR e.hub_sequence <= $${n + params.length + 1}::bigint)`
    params.push(scope.live.activeHubIds, scope.live.acknowledged)
  }
  return { sql, params }
}

/**
 * The highest sequence of the location that the hub had received by that instant (0 if none). Each
 * hub's events are walked from the newest back to the first one received by then.
 */
export async function sequenceAt(
  tx: Sql,
  restaurantId: string,
  hubIds: readonly string[],
  instant: string,
): Promise<number> {
  if (hubIds.length === 0) return 0
  const [row] = await tx.query<{ s: string | number | null }>(
    `SELECT max(x.hub_sequence) AS s FROM unnest($2::text[]) AS h(id)
     CROSS JOIN LATERAL (
       SELECT e.hub_sequence FROM events e
       WHERE e.restaurant_id = $1 AND e.hub_id = h.id AND e.received_at <= $3::timestamptz
       ORDER BY e.hub_sequence DESC LIMIT 1
     ) x`,
    [restaurantId, hubIds, instant],
  )
  return Number(row?.s ?? 0)
}

async function loadPeriod(
  tx: Sql,
  scope: Scope,
  store: CloudStore,
  types: readonly string[],
  from: string,
  until: string,
) {
  const f = scopeFilter(scope, 6)
  const rows = await tx.query<{ content: unknown }>(
    `SELECT e.content FROM events e
     WHERE e.restaurant_id = $1 AND e.hub_id = ANY($2::text[]) AND e.type = ANY($3::text[])
       AND e.business_day BETWEEN $4::date AND $5::date${f.sql}`,
    [scope.restaurantId, scope.hubIds, types, from, until, ...f.params],
  )
  store.add(contents(rows))
  store.markPeriod(types, from, until)
}

/** Every event of those aggregates (orders or shifts), through `event_aggregates`. */
export async function loadAggregates(
  tx: Sql,
  scope: Scope,
  store: CloudStore,
  ids: readonly string[],
) {
  if (ids.length === 0) return
  const f = scopeFilter(scope, 4)
  const rows = await tx.query<{ content: unknown }>(
    `SELECT e.content FROM events e
     WHERE e.restaurant_id = $1 AND e.id IN (
       SELECT a.event_id FROM event_aggregates a
       WHERE a.restaurant_id = $1 AND a.hub_id = ANY($2::text[]) AND a.aggregate_id = ANY($3::text[])
     )${f.sql}`,
    [scope.restaurantId, scope.hubIds, ids, ...f.params],
  )
  store.add(contents(rows))
  store.markAggregates(ids)
}

async function loadShiftCharges(
  tx: Sql,
  scope: Scope,
  store: CloudStore,
  shifts: ReadonlyMap<string, string>,
) {
  if (shifts.size === 0) return
  const from = [...shifts.values()].sort()[0] as string
  // The types are written out so the events_by_shift index (migration 2) applies.
  const f = scopeFilter(scope, 5)
  const rows = await tx.query<{ content: unknown }>(
    `SELECT e.content FROM events e
     WHERE e.restaurant_id = $1 AND e.hub_id = ANY($2::text[])
       AND e.type IN ('PaymentRecorded', 'PaymentVoided', 'RefundRecorded')
       AND (e.content #>> '{data,register_shift_id}') = ANY($3::text[])
       AND e.business_day >= $4::date${f.sql}`,
    [scope.restaurantId, scope.hubIds, [...shifts.keys()], from, ...f.params],
  )
  store.add(contents(rows))
  for (const id of shifts.keys()) store.markShift(id, from)
}

/**
 * `reportData` of the hub over the location's events in Postgres. First it loads the period's
 * events and the orders and shifts they touch; then, while `reportData` asks for something not
 * loaded, it fetches it and runs again (at most MAX_ROUNDS runs).
 */
export async function cloudReportData(
  tx: Sql,
  requested: Scope,
  from: string,
  until: string,
  options: { store?: CloudStore; maxRounds?: number } = {},
): Promise<{ data: ReportData; rounds: number; events: number; store: CloudStore }> {
  const scope: Scope =
    requested.asOf && (requested.upTo === null || requested.upTo === undefined)
      ? {
          ...requested,
          upTo: await sequenceAt(tx, requested.restaurantId, requested.hubIds, requested.asOf),
        }
      : requested
  const maxRounds = options.maxRounds ?? MAX_ROUNDS
  const store = options.store ?? new CloudStore()
  if (options.store) {
    // Already loaded (the dashboard's cut of last week's day).
  } else if (scope.hubIds.length === 0) {
    store.markPeriod(PERIOD_TYPES, from, until)
  } else {
    await loadPeriod(tx, scope, store, PERIOD_TYPES, from, until)
    await loadAggregates(tx, scope, store, store.allAggregates())
  }
  const { result: data, rounds } = await untilComplete(
    store,
    maxRounds,
    () => reportData(store, from, until),
    (missing) => loadMissing(tx, scope, store, missing),
  )
  return { data, rounds, events: store.size, store }
}

/**
 * Loads what the store noted as missing: the periods, the shifts' charges and the aggregates. False
 * when there is nowhere to load from (a location without hubs).
 */
export async function loadMissing(
  tx: Sql,
  scope: Scope,
  store: CloudStore,
  { aggregates, shifts, periods }: Missing,
): Promise<boolean> {
  if (scope.hubIds.length === 0) return false
  for (const p of periods) await loadPeriod(tx, scope, store, p.types, p.from, p.until)
  await loadShiftCharges(tx, scope, store, shifts)
  await loadAggregates(tx, scope, store, [...aggregates])
  return true
}

/**
 * Runs `compute` over the store until it asks for nothing it does not have: each time it asks
 * for something (another order's events, a shift's charges, a period), `fetch` loads it and it
 * runs again, at most `maxRounds` times. `fetch` returns false when there is nowhere to load from.
 * It is the reports' loop (task 1.11c-1), shared with the live floor (`live.ts`).
 */
export async function untilComplete<T>(
  store: CloudStore,
  maxRounds: number,
  compute: () => T,
  fetch: (missing: Missing) => Promise<boolean>,
  /** What is being computed, for the error (it goes to the log, never to the panel). */
  what = 'El reporte',
): Promise<{ result: T; rounds: number }> {
  for (let round = 1; ; round++) {
    store.resetMissing()
    const result = compute()
    if (store.isComplete()) return { result, rounds: round }
    if (round >= maxRounds || !(await fetch(store.missing)))
      throw new Error(`${what} necesitó más de ${maxRounds} lecturas de la base`)
  }
}

/** The hub's location hubs (all of them: a revoked one's events still count in the reports). */
export async function hubsOfLocation(
  tx: Sql,
  restaurantId: string,
  locationId: string,
): Promise<string[]> {
  return (await locationHubs(tx, restaurantId, locationId)).map((r) => r.id)
}

async function locationHubs(tx: Sql, restaurantId: string, locationId: string) {
  return tx.query<{ id: string; revoked: boolean; contiguous: string | number }>(
    `SELECT id, revoked_at IS NOT NULL AS revoked, contiguous_sequence AS contiguous FROM hubs
     WHERE restaurant_id = $1 AND location_id = $2`,
    [restaurantId, locationId],
  )
}

/**
 * The location's two scopes, from one read of its hubs: `all` is every hub (the reports and the
 * alerts: history); `live` is what is live (D1): only what an active hub stands behind
 * (`Scope.live`). Without an active hub nothing is live: a revoked PC's open orders and shifts are
 * not on the floor nor at the register, though they stay in the reports.
 */
export async function locationScopes(
  tx: Sql,
  restaurantId: string,
  locationId: string,
): Promise<{ all: Scope; live: Scope }> {
  const hubs = await locationHubs(tx, restaurantId, locationId)
  const active = hubs.filter((h) => !h.revoked)
  const all: Scope = { restaurantId, hubIds: hubs.map((h) => h.id) }
  if (active.length === 0) return { all, live: { restaurantId, hubIds: [] } }
  return {
    all,
    live: {
      ...all,
      live: {
        activeHubIds: active.map((h) => h.id),
        acknowledged: Math.max(...active.map((h) => Number(h.contiguous))),
      },
    },
  }
}

// ── The response, with the same shape as the hub's /api/reports ──────────

export { configFrom } from './snapshots'

/** The hub's `POST /api/reports` (apps/hub/src/reports/routes.ts), without the printer. */
export function periodReport(
  data: ReportData,
  config: RestaurantConfig,
  names: ReadonlyMap<string, string>,
  today: string,
) {
  const result = report({
    ...data,
    config: { sales_by_waiter: config.sales_by_waiter, rounding_mode: config.rounding_mode },
  })
  const users = userNames(names, [
    ...result.byWaiter.map((m) => m.userId),
    ...result.voids.flatMap((a) => [a.userId, a.authorizedById ?? a.userId]),
    ...result.cancellations.flatMap((c) => [c.userId, c.authorizedById ?? c.userId]),
    ...data.registerClosings.flatMap((c) => [c.openedBy, c.closedBy]),
  ])
  return {
    today,
    report: result,
    closings: data.registerClosings.map(closingJson),
    users,
    printer: false,
  }
}

export type PeriodReport = ReturnType<typeof periodReport>

/** A register close as the hub's `/api/reports` lists it (`ReportClose` in apps/pos). */
export const closingJson = (c: ShiftClose) => ({
  shiftId: c.reconciliation.shiftId,
  businessDay: c.businessDay,
  openedAt: c.reconciliation.openedAt,
  openedBy: c.openedBy,
  closedBy: c.closedBy,
  base: c.reconciliation.base,
  byMethod: c.reconciliation.byMethod,
  closed: c.reconciliation.closed,
})

export type ClosingJson = ReturnType<typeof closingJson>

/** People's names, by id (those who are gone keep their name), as the hub's `userNames`. */
export function userNames(names: ReadonlyMap<string, string>, ids: Iterable<string>) {
  const out: Record<string, string> = {}
  for (const id of new Set(ids)) out[id] = names.get(id) ?? 'Alguien'
  return out
}
