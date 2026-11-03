import { affectsOrder, type OrderEvent, type OrderState, orderTotals, rebuild } from '@pos/core'
import {
  type Catalog,
  type KitchenTicket,
  kitchenTickets,
  type LocalEvent,
  occupiesTable,
  openOrders,
  timersOf,
  type VisibleOrder,
} from '@pos/sync'
import { z } from 'zod'
import { aggregatesOf } from './cloud'
import type { LocalState } from './panel'
import {
  bySequence,
  CloudStore,
  latestReceipt,
  loadAggregates,
  type Scope,
  scopeFilter,
  untilComplete,
} from './reports'
import type { Sql } from './sql'

// The location right now, for the owner's panel (task 1.11c-2, docs/PANEL.md#en-vivo-111c-2):
// the open orders and what is in the kitchen, computed in the cloud with the same projections the
// devices use (`openOrders` and `kitchenTickets` of @pos/sync), over the events the hub uploaded.
// There is no table of open orders: they come out of the events.

/**
 * Only orders whose last open, reopen, close or cancel is at most this many business days old
 * count as open. An order forgotten open for longer does not show up in the panel (the register
 * still has it): the panel never has to read the whole history. Owner's decision, 2-nov-2026.
 */
export const LIVE_WINDOW_DAYS = 31
/**
 * How many times the orders are loaded at most. Each round brings the other orders that the loaded
 * events touch (moving dishes, merging orders): a dish moved from an order already closed is
 * still on the ticket that order sent to the kitchen.
 */
export const LIVE_MAX_ROUNDS = 8

const LIFECYCLE = ['OrderOpened', 'OrderReopened', 'OrderClosed', 'OrderCanceled']

/**
 * The orders whose last lifecycle event since `since` (a business day) left them open. An order
 * merged into another (the source of `OrdersMerged`) is not open even if it was never closed.
 */
export async function candidates(tx: Sql, scope: Scope, since: string): Promise<string[]> {
  const f = scopeFilter(scope, 5)
  const rows = await tx.query<{ aggregate_id: string }>(
    `SELECT x.aggregate_id FROM (
       SELECT DISTINCT ON (e.aggregate_id) e.aggregate_id, e.type FROM events e
       WHERE e.restaurant_id = $1 AND e.hub_id = ANY($2::text[]) AND e.type = ANY($3::text[])
         AND e.business_day >= $4::date${f.sql}
       ORDER BY e.aggregate_id, e.hub_sequence DESC
     ) x
     WHERE x.type IN ('OrderOpened', 'OrderReopened')
       AND NOT EXISTS (
         SELECT 1 FROM events m
         WHERE m.restaurant_id = $1 AND m.hub_id = ANY($2::text[]) AND m.business_day >= $4::date
           AND m.type = 'OrdersMerged' AND (m.content #>> '{data,source_order_id}') = x.aggregate_id
       )`,
    [scope.restaurantId, scope.hubIds, LIFECYCLE, since, ...f.params],
  )
  return rows.map((r) => r.aggregate_id)
}

export interface LiveOrders {
  orders: VisibleOrder[]
  tickets: KitchenTicket[]
  /**
   * For each open order that was closed before (a reopened check), its net at its last close: that
   * is already in the sales of that close's day (D2, docs/KPIS.md#mesas-abiertas-panel).
   */
  closedNet: Map<string, number>
  /** The latest `received_at` among the events read (null without events). */
  asOf: string | null
  rounds: number
}

/**
 * The location's open orders and kitchen tickets. Loads every event of the candidate orders and,
 * round after round, of the orders those events touch, until nothing is missing; then it runs the
 * devices' projections over them, all confirmed and in the hub's order.
 */
export async function liveOrders(tx: Sql, scope: Scope, since: string): Promise<LiveOrders> {
  if (scope.hubIds.length === 0)
    return { orders: [], tickets: [], closedNet: new Map(), asOf: null, rounds: 0 }
  const start = await candidates(tx, scope, since)
  const store = new CloudStore()
  await loadAggregates(tx, scope, store, start)
  const { result: events, rounds } = await untilComplete(
    store,
    LIVE_MAX_ROUNDS,
    () => {
      // Every order reachable from the candidates through the events: each one read once.
      const found = new Map<string, OrderEvent>()
      const visited = new Set<string>()
      const queue = [...start]
      for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
        if (visited.has(id)) continue
        visited.add(id)
        for (const e of store.aggregateEvents(id)) {
          if (e.aggregate_type !== 'order') continue
          found.set(e.id, e)
          for (const other of aggregatesOf(e)) if (!visited.has(other)) queue.push(other)
        }
      }
      return [...found.values()].sort(bySequence)
    },
    async ({ aggregates }) => {
      await loadAggregates(tx, scope, store, [...aggregates])
      return true
    },
    'El salón en vivo',
  )
  const locals: LocalEvent[] = events.map((event, position) => ({
    event,
    status: 'confirmed',
    own: false,
    position,
  }))
  const orders = openOrders(locals)
  return {
    orders,
    tickets: kitchenTickets(locals, orders),
    closedNet: closedNets(events, orders),
    asOf: latestReceipt(events),
    rounds,
  }
}

/** Each reopened order's net at its last close (as the reports' `closings`, `reportData`). */
function closedNets(
  events: readonly OrderEvent[],
  orders: readonly VisibleOrder[],
): Map<string, number> {
  const out = new Map<string, number>()
  for (const { status } of orders) {
    const own = events.filter((e) => affectsOrder(e, status.id))
    const close = own.filter((e) => e.type === 'OrderClosed' && e.aggregate_id === status.id).at(-1)
    if (!close) continue
    const before = rebuild(
      own.filter((e) => e.sequence <= close.sequence),
      status.id,
    )
    if (before) out.set(status.id, orderTotals(before).net)
  }
  return out
}

/** «Mesas abiertas» on the dashboard: the orders that hold a table or go without one. */
export interface OpenSummary {
  /** Open orders that count (not the one emptied by moving everything to another table). */
  orders: number
  /** Tables they occupy, counting each merged table. */
  tables: number
  guests: number
  /**
   * What those orders add that is not in the sales yet (without tips), in pesos: each one's net, and
   * for a reopened check only its net now minus its net at its last close (D2, docs/KPIS.md). It can
   * be negative: a reopened check where something was voided.
   */
  total: number
}

export function openSummary(
  orders: readonly VisibleOrder[],
  closedNet: ReadonlyMap<string, number> = new Map(),
): OpenSummary {
  const counted = orders.filter((p) => occupiesTable(p.status))
  const tables = new Set(
    counted.flatMap((p) => (p.status.tableId ? [p.status.tableId, ...p.status.mergedTables] : [])),
  )
  return {
    orders: counted.length,
    tables: tables.size,
    guests: counted.reduce((s, p) => s + p.status.guests, 0),
    total: counted.reduce((s, p) => s + p.total - (closedNet.get(p.status.id) ?? 0), 0),
  }
}

/** A kitchen card as JSON: its order and items go by id (the order travels in `orders`). */
export interface LiveTicket {
  key: string
  ticket_id: string
  order_id: string
  station_id: string
  number: number | null
  sent_at: string
  item_ids: string[]
  /** Everything still pending is ready to take to the table. */
  ready: boolean
}

export const ticketJson = (t: KitchenTicket): LiveTicket => ({
  key: t.key,
  ticket_id: t.ticketId,
  order_id: t.order.status.id,
  station_id: t.stationId,
  number: t.number,
  sent_at: t.sentAt,
  item_ids: t.items.map((i) => i.id),
  ready: t.list,
})

// ── The floor plan, from the catalog snapshot ───────────────────────────

const Geometry = {
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  rotation: z.number(),
}
/**
 * What the panel draws. The catalog is not checked on upload: here it is, piece by piece, and each
 * zone, table, element or station that does not validate is left out alone (the rest still draws).
 */
const PLAN = {
  zones: z.object({ id: z.string(), name: z.string(), level: z.number() }),
  tables: z.object({
    id: z.string(),
    zoneId: z.string(),
    name: z.string(),
    ...Geometry,
    shape: z.enum(['round', 'square', 'rectangular', 'bar']),
    capacity: z.number(),
  }),
  elements: z.object({
    id: z.string(),
    zoneId: z.string(),
    type: z.enum(['wall', 'door', 'plant', 'bar', 'text']),
    text: z.string().nullable(),
    ...Geometry,
  }),
  stations: z.object({
    id: z.string(),
    name: z.string(),
    prints: z.boolean().optional(),
    screen: z.boolean().optional(),
  }),
}

export type FloorPlan = Pick<Catalog, 'zones' | 'tables' | 'elements' | 'stations'>

export interface PlanSnapshot {
  /** Changes whenever the catalog does (it is the snapshot's fingerprint); null without one. */
  version: string | null
  /** Null when the panel already has this version (`?plan=`) or there is no catalog. */
  plan: FloorPlan | null
  timers: { yellow: number; red: number }
}

/**
 * The location's floor plan and kitchen timers from the catalog snapshot, in a single read. Only
 * the fields it needs are read (the catalog can weigh up to 2 MB), and the plan only if the panel
 * does not have that version (`known`).
 */
export async function readPlan(
  tx: Sql,
  restaurantId: string,
  locationId: string,
  known: string | null,
): Promise<PlanSnapshot> {
  const [row] = await tx.query<
    { fingerprint: string; yellow: unknown; red: unknown } & Record<keyof FloorPlan, unknown>
  >(
    `SELECT fingerprint, content #> '{restaurant,kitchenYellowMin}' AS yellow,
            content #> '{restaurant,kitchenRedMin}' AS red,
            CASE WHEN fingerprint = $3 THEN NULL ELSE content #> '{zones}' END AS zones,
            CASE WHEN fingerprint = $3 THEN NULL ELSE content #> '{tables}' END AS tables,
            CASE WHEN fingerprint = $3 THEN NULL ELSE content #> '{elements}' END AS elements,
            CASE WHEN fingerprint = $3 THEN NULL ELSE content #> '{stations}' END AS stations
     FROM snapshots WHERE restaurant_id = $1 AND location_id = $2 AND kind = 'catalog'`,
    [restaurantId, locationId, known],
  )
  const minutes = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined)
  const timers = timersOf({
    kitchenYellowMin: minutes(row?.yellow),
    kitchenRedMin: minutes(row?.red),
  })
  if (!row) return { version: null, plan: null, timers }
  if (known === row.fingerprint) return { version: row.fingerprint, plan: null, timers }
  const plan: Record<string, unknown[]> = {}
  for (const key of Object.keys(PLAN) as (keyof FloorPlan)[]) {
    const value = row[key]
    const list = Array.isArray(value) ? value : []
    if (value !== null && value !== undefined && !Array.isArray(value))
      console.warn('Unreadable floor plan in the catalog snapshot', { restaurantId, key })
    let dropped = 0
    plan[key] = list.flatMap((piece) => {
      const r = PLAN[key].safeParse(piece)
      if (r.success) return [r.data]
      dropped++
      return []
    })
    if (dropped > 0)
      console.warn('Unreadable pieces of the floor plan left out', { restaurantId, key, dropped })
  }
  return { version: row.fingerprint, plan: plan as unknown as FloorPlan, timers }
}

/** `GET /v1/panel/floor`: the floor and the kitchen as the cloud has them. */
export interface LiveFloor {
  server_now: string
  today: string
  /** The latest receipt time among the events behind the answer (null without events). */
  as_of: string | null
  local: LocalState
  plan_version: string | null
  plan: FloorPlan | null
  timers: { yellow: number; red: number }
  orders: OrderState[]
  tickets: LiveTicket[]
  users: Record<string, string>
}

/** The people named on the floor: who serves each order and who added each item. */
export const namedOn = (orders: readonly VisibleOrder[]) =>
  orders.flatMap((p) => [
    p.status.assignedWaiterId,
    ...Object.values(p.status.items).map((i) => i.addedBy),
  ])
