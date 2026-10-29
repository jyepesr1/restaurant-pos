import { type OrderItem, type OrderState, orderTotals, rebuild } from '@pos/core'
import { type LocalEvent, ordersOf } from '@pos/sync'

// What the demo screen shows, computed from the events saved on the device: the ones
// confirmed by the hub and, on top, its own pending ones (docs/SYNC.md#orden-y-estado-local).

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

const current = (l: LocalEvent) => l.status === 'confirmed' || l.status === 'pending'

/** The open orders, oldest to newest. */
export function openOrders(locals: readonly LocalEvent[]): VisibleOrder[] {
  const byOrder = new Map<string, LocalEvent[]>()
  for (const l of locals) {
    if (!current(l) || l.event.aggregate_type !== 'order') continue
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

export type DemoTableStatus = 'free' | 'taking' | 'ready' | 'check' | 'in_kitchen' | 'served'

/**
 * State of the table on the floor plan, most to least urgent: with something unsent it is
 * `taking`; with something ready in the kitchen, `ready`; with the pre-bill requested or something
 * paid, `check` (task 1.6); with something in the kitchen, `in_kitchen`; with everything
 * delivered, `served` (ADR-015).
 */
export function tableStatus(orders: readonly VisibleOrder[]): DemoTableStatus {
  const items = orders.flatMap((p) => currentItems(p.status))
  if (items.length === 0) return 'free'
  if (items.some((i) => i.status === 'pending' || i.status === 'held')) return 'taking'
  if (items.some((i) => i.status === 'ready')) return 'ready'
  // Already asked for the check (pre-bill) or paid part of it (task 1.6): what follows is checkout.
  if (orders.some((p) => p.status.lastPreBill || orderTotals(p.status).paid > 0)) return 'check'
  if (items.some((i) => i.status !== 'served')) return 'in_kitchen'
  return 'served'
}

/** Sold-out key: the whole product, or one of its variants (the bottle, not the glass). */
export const soldOutKey = (productId: string, variantId: string | null = null) =>
  variantId ? `${productId}:${variantId}` : productId

/** What is current of the requested types: the confirmed in hub order and then the pending. */
function inOrder(locals: readonly LocalEvent[], types: readonly string[]): LocalEvent[] {
  const src = locals.filter((l) => current(l) && types.includes(l.event.type))
  return [
    ...src
      .filter((l) => l.status === 'confirmed')
      .sort((a, b) => (a.event.sequence ?? 0) - (b.event.sequence ?? 0)),
    ...src.filter((l) => l.status === 'pending'),
  ]
}

/**
 * What is sold out (86) according to the events saved here: the confirmed in hub order and, on
 * top, its own pending ones. So whoever marks it sees it instantly, even offline.
 */
export function soldOutIds(locals: readonly LocalEvent[]): Set<string> {
  const result = new Set<string>()
  for (const { event } of inOrder(locals, ['ProductSoldOut', 'ProductAvailable'])) {
    if (event.type !== 'ProductSoldOut' && event.type !== 'ProductAvailable') continue
    const key = soldOutKey(event.data.product_id, event.data.variant_id)
    if (event.type === 'ProductSoldOut') result.add(key)
    else result.delete(key)
  }
  return result
}

/**
 * The products ordered most on this device (what it has seen), from most to least. It counts
 * the units left on each line: what was added to an identical line (`ItemChanged`) counts, what
 * was removed or voided does not.
 */
export function moreOrders(locals: readonly LocalEvent[], howMany = 12): string[] {
  const lines = new Map<string, { product: string; quantity: number }>()
  for (const { event: e } of inOrder(locals, [
    'ItemAdded',
    'ItemChanged',
    'ItemRemoved',
    'ItemVoided',
  ])) {
    if (e.type === 'ItemAdded') {
      lines.set(e.data.item_id, { product: e.data.product_id, quantity: e.data.quantity })
    } else if (e.type === 'ItemChanged' || e.type === 'ItemRemoved' || e.type === 'ItemVoided') {
      const line = lines.get(e.data.item_id)
      if (!line) continue
      if (e.type === 'ItemRemoved') line.quantity = 0
      else if (e.type === 'ItemVoided') line.quantity = Math.max(0, line.quantity - e.data.quantity)
      else if (e.data.quantity !== undefined) line.quantity = e.data.quantity
    }
  }
  const tally = new Map<string, number>()
  for (const { product, quantity } of lines.values())
    if (quantity > 0) tally.set(product, (tally.get(product) ?? 0) + quantity)
  return [...tally]
    .sort((a, b) => b[1] - a[1])
    .slice(0, howMany)
    .map(([id]) => id)
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
