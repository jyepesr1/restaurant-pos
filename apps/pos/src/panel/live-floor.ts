import { type OrderState, orderTotals } from '@pos/core'
import type { KitchenTicket, VisibleOrder } from '@pos/sync/views'
import type { KitchenPlace } from '../floor/KitchenCard'
import type { FloorPlace } from '../floor/TablesView'
import type { FloorPlan, LiveFloor, PanelApi } from './api'
import { type DataState, dataState, type Polled, timeOf } from './summary'

// What the panel's «Salón» and «Cocina» need from the cloud's answer, without drawing it (task
// 1.11c-2): the orders as the floor's components take them, the kitchen cards, the clock and
// whether the times are frozen because nothing is arriving.

/** The floor's answer, with the plan already filled in from the previous one when it did not come. */
export type FloorAnswer = Omit<LiveFloor, 'plan'> & { plan: FloorPlan }

export const EMPTY_PLAN: FloorPlan = { zones: [], tables: [], elements: [], stations: [] }

/**
 * Asks for the floor sending the version of the plan it already has: if it did not change, the
 * cloud does not send it and the last one is used.
 */
export function floorFetcher(api: Pick<PanelApi, 'floor'>): () => Promise<FloorAnswer> {
  let known: { version: string; plan: FloorPlan } | null = null
  return async () => {
    const r = await api.floor(known?.version ?? null)
    if (r.plan && r.plan_version) known = { version: r.plan_version, plan: r.plan }
    const plan =
      r.plan ?? (known && known.version === r.plan_version ? known.plan : null) ?? EMPTY_PLAN
    return { ...r, plan }
  }
}

/** The orders as the floor draws them: in the cloud everything is confirmed. */
export const visibleOrders = (orders: readonly OrderState[]): VisibleOrder[] =>
  orders.map((status) => ({
    status,
    total: orderTotals(status).net,
    itemsToConfirm: new Set<string>(),
    pendingConfirmation: false,
  }))

/** The kitchen cards with their order and items (an item no longer in the order is left out). */
export function kitchenOf(answer: FloorAnswer, orders: readonly VisibleOrder[]): KitchenTicket[] {
  const byId = new Map(orders.map((p) => [p.status.id, p]))
  return answer.tickets.flatMap((t) => {
    const order = byId.get(t.order_id)
    if (!order) return []
    const items = t.item_ids.flatMap((id) => {
      const item = order.status.items[id]
      return item ? [item] : []
    })
    if (items.length === 0) return []
    return [
      {
        key: t.key,
        ticketId: t.ticket_id,
        order,
        stationId: t.station_id,
        number: t.number,
        sentAt: t.sent_at,
        items,
        list: t.ready,
      },
    ]
  })
}

/** What the floor's and the kitchen's components need of the catalog, from the plan and names. */
export const placeOf = (answer: FloorAnswer): FloorPlace & KitchenPlace => ({
  ...answer.plan,
  staff: Object.entries(answer.users).map(([id, name]) => ({ id, name })),
})

/** The time the screens count with, and since when they are frozen. */
export interface LiveTime {
  /** The instant durations are measured to (ms). */
  now: number
  /** «9:41 p. m.» when the times are frozen (nothing arrives); null while they run. */
  frozenAt: string | null
}

/**
 * The cloud's clock estimated on the phone: its time in the last answer plus what passed here
 * since it arrived (the phone's clock may be off; only its difference counts).
 */
export function cloudNow(serverNow: string, receivedAt: string, deviceNow: number): number {
  return Date.parse(serverNow) + Math.max(0, deviceNow - Date.parse(receivedAt))
}

/**
 * From when the floor's data is (the same states as the dashboard), with the estimated clock: the
 * restaurant goes «sin noticias» even between answers.
 */
export function floorState(
  polled: Polled<FloorAnswer>,
  deviceNow: number,
  timeZone: string,
): { state: DataState; time: LiveTime } {
  const data = polled.data
  const now =
    data && polled.receivedAt ? cloudNow(data.server_now, polled.receivedAt, deviceNow) : deviceNow
  const state = dataState(
    data?.local ?? null,
    {
      failed: polled.failed,
      cause: polled.errorKind && polled.errorKind !== 'offline' ? 'other' : 'offline',
      receivedAt: data?.server_now ?? polled.receivedAt,
      now: data ? new Date(now).toISOString() : null,
    },
    timeZone,
  )
  // Without news, the times stop at the last news; without an answer, at the last answer.
  const frozen =
    state.kind === 'no_news'
      ? (data?.local.last_seen_at ?? null)
      : state.kind === 'offline' || state.kind === 'failed'
        ? (data?.server_now ?? null)
        : null
  return {
    state,
    time: frozen
      ? { now: Date.parse(frozen), frozenAt: timeOf(frozen, timeZone) }
      : { now, frozenAt: null },
  }
}

/** «12 min», or «12 min a las 9:41 p. m.» when frozen. */
export const at = (text: string, time: LiveTime) =>
  time.frozenAt ? `${text} a las ${time.frozenAt}` : text
