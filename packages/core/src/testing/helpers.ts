import type { OrderEvent } from '../events/order'
import { newId } from '../id'
import { applyEvent } from '../order/apply'
import type { OrderState } from '../order/state'
import { event, inOrder } from './factory'

/** Applies events in order and fails if any could not be applied. */
export function applyAll(
  events: readonly OrderEvent[],
  initial: OrderState | null = null,
): OrderState {
  return events.reduce<OrderState | null>((status, e) => {
    const r = applyEvent(status, inOrder(e, status?.lastSequence ?? 0))
    if (r.issue) throw new Error(`${e.type}: ${r.issue.type} (${r.issue.description})`)
    return r.status
  }, initial) as OrderState
}

/** Freshly opened dine-in order. */
export function orderOpened(order = newId()) {
  return {
    order,
    status: applyAll([
      event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }),
    ]),
  }
}

export const sendItems = (order: string, itemIds: string[]) =>
  event(order, 'ItemsSent', {
    tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: itemIds }],
  })

/** Type of the issue when applying `e`, or undefined if it applies. */
export const issueOf = (status: OrderState | null, e: OrderEvent) =>
  applyEvent(status, e).issue?.type
