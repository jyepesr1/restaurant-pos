import { type OrderItem, type OrderState, orderTotals, rebuild } from '@pos/core'
import type { LocalEvent } from '../device/store'
import { ordersOf } from '../orders'

// What the floor shows, computed from the events: the confirmed ones and, on top, the device's own
// pending ones (docs/SYNC.md#orden-y-estado-local). The same functions run on the devices, over
// what they saved, and in the cloud for the owner's panel (task 1.11c-2), over what the hub
// uploaded: there every event is confirmed.

export interface VisibleOrder {
  status: OrderState
  /** Net of the order (what is charged without tip), in pesos. */
  total: number
  /** Items with something the hub has not confirmed yet: adding them or sending them to kitchen. */
  itemsToConfirm: Set<string>
  /** Some event of the order is still pending here. */
  pendingConfirmation: boolean
}

/** Items touched by a pending event, which the screen marks "sin confirmar" (unconfirmed). */
function itemsOf({ event }: LocalEvent): string[] {
  if (event.type === 'ItemAdded') return [event.data.item_id]
  if (event.type === 'ItemsSent') return event.data.tickets.flatMap((c) => c.item_ids)
  return []
}

export const isCurrent = (l: LocalEvent) => l.status === 'confirmed' || l.status === 'pending'

/** The open orders, oldest to newest. */
export function openOrders(locals: readonly LocalEvent[]): VisibleOrder[] {
  const byOrder = new Map<string, LocalEvent[]>()
  for (const l of locals) {
    if (!isCurrent(l) || l.event.aggregate_type !== 'order') continue
    // An event can touch two orders: moving products goes in the source and reaches the target.
    for (const id of ordersOf(l.event)) byOrder.set(id, [...(byOrder.get(id) ?? []), l])
  }
  const visible: VisibleOrder[] = []
  for (const [id, events] of byOrder) {
    const status = rebuild(
      events.map((l) => l.event),
      id,
    )
    if (status?.status !== 'open') continue
    const pendingList = events.filter((l) => l.status === 'pending')
    visible.push({
      status,
      total: orderTotals(status).net,
      itemsToConfirm: new Set(pendingList.flatMap((l) => itemsOf(l))),
      pendingConfirmation: pendingList.length > 0,
    })
  }
  return visible.sort((a, b) => a.status.openedAt.localeCompare(b.status.openedAt))
}

export const currentItems = (status: OrderState): OrderItem[] =>
  Object.values(status.items)
    .filter((i) => i.status !== 'voided')
    .sort((a, b) => a.position - b.position)

export type TableStatus = 'free' | 'taking' | 'ready' | 'check' | 'in_kitchen' | 'served'

/**
 * State of the table on the floor plan, most to least urgent: with something unsent it is
 * `taking`; with something ready in the kitchen, `ready`; with the pre-bill requested or something
 * paid, `check` (task 1.6); with something in the kitchen, `in_kitchen`; with everything
 * delivered, `served` (ADR-015).
 */
export function tableStatus(orders: readonly VisibleOrder[]): TableStatus {
  const items = orders.flatMap((p) => currentItems(p.status))
  if (items.length === 0) return 'free'
  if (items.some((i) => i.status === 'pending' || i.status === 'held')) return 'taking'
  if (items.some((i) => i.status === 'ready')) return 'ready'
  // Already asked for the check (pre-bill) or paid part of it (task 1.6): what follows is checkout.
  if (orders.some((p) => p.status.lastPreBill || orderTotals(p.status).paid > 0)) return 'check'
  if (items.some((i) => i.status !== 'served')) return 'in_kitchen'
  return 'served'
}

/**
 * Whether an open order occupies its table: it has something current, or it has nothing (it was
 * just opened, or the waiter removed what was not sent yet). One left empty after moving
 * everything to another table, or with everything voided, does not (task 1.5; the hub applies the
 * same rule).
 */
export const occupiesTable = (p: OrderState) =>
  p.status === 'open' &&
  (currentItems(p).length > 0 || (Object.keys(p.items).length === 0 && !p.emptiedOnMove))
