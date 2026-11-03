import type { LocalEvent } from '@pos/sync'
import { isCurrent } from '@pos/sync/views'

// What the demo screen shows, computed from the events saved on the device: the ones
// confirmed by the hub and, on top, its own pending ones (docs/SYNC.md#orden-y-estado-local).
// The floor's projections live in `@pos/sync/views` (task 1.11c-2: the owner's panel computes
// them in the cloud with the same code); they are re-exported here so nothing else changes.

export {
  currentItems,
  occupiesTable,
  openOrders,
  type TableStatus as DemoTableStatus,
  tableStatus,
  type VisibleOrder,
} from '@pos/sync/views'

/** Sold-out key: the whole product, or one of its variants (the bottle, not the glass). */
export const soldOutKey = (productId: string, variantId: string | null = null) =>
  variantId ? `${productId}:${variantId}` : productId

/** What is current of the requested types: the confirmed in hub order and then the pending. */
function inOrder(locals: readonly LocalEvent[], types: readonly string[]): LocalEvent[] {
  const src = locals.filter((l) => isCurrent(l) && types.includes(l.event.type))
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
