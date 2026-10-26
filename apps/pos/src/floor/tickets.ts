import type { OrderItem } from '@pos/core'
import type { LocalEvent } from '@pos/sync'
import type { VisibleOrder } from './projection'

// What is in the kitchen (ADR-015), computed from the events saved on the device: each ticket
// sent with what is still to be delivered. The kitchen screen and «Pedidos en cocina» at the
// register show it. A ticket leaves here when the waiter delivers all of it (or it is voided).

export interface KitchenTicket {
  /** Unique per card: a ticket whose dishes were split across two tables gives two cards. */
  key: string
  ticketId: string
  order: VisibleOrder
  stationId: string
  /** The day's number the hub assigned; until it confirms, nothing. */
  number: number | null
  /** Since when it is in the kitchen: when the hub received it (or when sent, if not there yet). */
  sentAt: string
  /** What is still to be delivered from this ticket. */
  items: OrderItem[]
  /** Everything still pending is ready to take to the table. */
  list: boolean
}

const IN_KITCHEN = new Set(['sent', 'in_preparation', 'ready'])
const current = (l: LocalEvent) => l.status === 'confirmed' || l.status === 'pending'

export function kitchenTickets(
  locals: readonly LocalEvent[],
  orders: readonly VisibleOrder[],
): KitchenTicket[] {
  // Each dish is in the order that has it now: if it was moved to another table, the ticket is
  // still the one it was sent with, but the card shows the new table.
  const whereIs = new Map<string, VisibleOrder>()
  for (const p of orders) for (const id of Object.keys(p.status.items)) whereIs.set(id, p)
  const tickets: KitchenTicket[] = []
  for (const l of locals) {
    if (!current(l) || l.event.type !== 'ItemsSent') continue
    const numbers = l.event.assignments?.ticket_numbers
    for (const c of l.event.data.tickets) {
      const byOrder = new Map<VisibleOrder, OrderItem[]>()
      for (const id of c.item_ids) {
        const order = whereIs.get(id)
        const i = order?.status.items[id]
        if (!order || !i || !IN_KITCHEN.has(i.status) || i.quantity <= i.voidedQuantity) continue
        byOrder.set(order, [...(byOrder.get(order) ?? []), i])
      }
      for (const [order, items] of byOrder)
        tickets.push({
          key: `${c.ticket_id}:${order.status.id}`,
          ticketId: c.ticket_id,
          order,
          stationId: c.station_id,
          number: numbers?.[c.ticket_id] ?? null,
          sentAt: l.event.received_at ?? l.event.hub_estimated_time,
          items: items.sort((a, b) => a.position - b.position),
          list: items.every((i) => i.status === 'ready'),
        })
    }
  }
  return tickets.sort((a, b) => a.sentAt.localeCompare(b.sentAt))
}

export type Delay = 'on_time' | 'late' | 'very_late'

/** How it is doing on time: amber from `yellow` minutes and red from `red` (location settings). */
export function delay(
  sentAt: string,
  now: number,
  { yellow, red }: { yellow: number; red: number },
): Delay {
  const minutes = (now - Date.parse(sentAt)) / 60_000
  if (minutes >= red) return 'very_late'
  if (minutes >= yellow) return 'late'
  return 'on_time'
}

/** The location's timers, or the factory defaults if the hub predates 1.4. */
export const timersOf = (restaurant: { kitchenYellowMin?: number; kitchenRedMin?: number }) => ({
  yellow: restaurant.kitchenYellowMin ?? 10,
  red: restaurant.kitchenRedMin ?? 20,
})
