import type { OrderEvent, OrderItem, OrderState } from '@pos/core'
import {
  checkBalance,
  checkPendingTip,
  fullConfig,
  itemTotals,
  newId,
  orderTaxes,
  orderTip,
  orderTotals,
} from '@pos/core'
import type { Row, SqliteDatabase } from '@pos/db'
import { type PreBill, type Ticket, type TicketItem, type TicketType, taxName } from '@pos/printing'
import type { OrderChange } from '@pos/sync'
import { enqueueZReport } from '../reports/z-report'

// From an accepted event to the print jobs for its tickets (ADR-015). Runs inside the event's
// transaction (`ConfigHub.onSave`): if the hub goes down right after, the tickets are already in
// the queue. It only builds data; the queue (`queue.ts`) turns them into bytes when printing, at
// the width of the printer that ends up printing it (it may be the fallback one).

const IN_KITCHEN = new Set(['sent', 'in_preparation', 'ready'])

const CHANNELS: Record<string, string> = {
  dine_in: 'Mesa',
  takeout: 'Para llevar',
  delivery: 'Domicilio',
  bar: 'Barra',
}

/** A ticket already sent: which station it belongs to, what it had and its number for the day. */
interface SentTicket {
  ticketId: string
  stationId: string
  itemIds: string[]
  number: number | null
}

export interface TicketOptions {
  db: SqliteDatabase
  restaurantId: string
  timeZone: string
}

/** Creates the print jobs the event calls for. Returns how many it created. */
export function jobsForEvent(
  o: TicketOptions,
  event: OrderEvent,
  changes: readonly OrderChange[],
): number {
  // Closing the register prints the Z report (task 1.9).
  // A failure here is not a ticket's: it is logged separately and the report is reprinted from
  // Reportes.
  if (event.type === 'ShiftClosed') {
    try {
      return enqueueZReport(o, event.aggregate_id, { event }) === 'queued' ? 1 : 0
    } catch (error) {
      console.error(`No se pudo armar el cierre Z del turno ${event.aggregate_id}:`, error)
      return 0
    }
  }
  const change = changes[0]
  const before = change?.before ?? null
  const after = change?.after ?? null
  if (!after) return 0
  if (event.type === 'PreBillPrinted') return preBillJob(o, event, after)

  const toCreate: { ticketId: string; stationId: string; ticket: Ticket }[] = []
  const build = (
    type: TicketType,
    sent: SentTicket,
    items: TicketItem[],
    order: OrderState = after,
    from: string | null = null,
  ) => {
    if (items.length > 0)
      toCreate.push({
        ticketId: sent.ticketId,
        stationId: sent.stationId,
        ticket: { ...ticketData(o, event, order, type, sent, items), before: from },
      })
  }
  /** What is still in the kitchen for an order, grouped by the ticket it went out with. */
  const inKitchenByTicket = (order: OrderState, ids?: readonly string[]) => {
    const groups = new Map<string, { sent: SentTicket; items: TicketItem[] }>()
    for (const item of Object.values(order.items)) {
      if (ids && !ids.includes(item.id)) continue
      if (!IN_KITCHEN.has(item.status) || item.quantity <= item.voidedQuantity) continue
      const sent = sentTicketOf(o, order.id, item.id)
      if (!sent) continue
      const g = groups.get(sent.ticketId) ?? { sent, items: [] }
      g.items.push(ticketItem(item))
      groups.set(sent.ticketId, g)
    }
    return [...groups.values()]
  }

  switch (event.type) {
    case 'ItemsSent': {
      // Only what actually became sent: what another device already sent is not repeated.
      for (const c of event.data.tickets) {
        const items = c.item_ids
          .filter(
            (id) => before?.items[id]?.status === 'pending' && after.items[id]?.status === 'sent',
          )
          .map((id) => after.items[id])
          .filter((i): i is OrderItem => !!i)
          .map((i) => ticketItem(i))
        build(
          'newOne',
          {
            ticketId: c.ticket_id,
            stationId: c.station_id,
            itemIds: c.item_ids,
            number: event.assignments.ticket_numbers?.[c.ticket_id] ?? null,
          },
          items,
        )
      }
      break
    }
    case 'TicketReprinted': {
      // If its dishes moved to another table, the send is in the source order.
      const sent =
        sentTickets(o, after.id).find((e) => e.ticketId === event.data.ticket_id) ??
        globalSentTicket(o, event.data.ticket_id)
      if (!sent) break
      build('reprinting', sent, currentItems(after, sent.itemIds))
      break
    }
    case 'ItemVoided': {
      const item = before?.items[event.data.item_id]
      // What had not been sent is not in the kitchen, and what was served is already out: there
      // is nothing to tell them.
      if (!item || !['sent', 'in_preparation', 'ready'].includes(item.status)) break
      const sent = sentTicketOf(o, after.id, item.id)
      if (!sent) break
      build('voidEntry', sent, [
        ticketItem({ ...item, quantity: event.data.quantity, voidedQuantity: 0 }),
      ])
      break
    }
    case 'OrderCanceled': {
      // What the kitchen had from a canceled order goes out as a void.
      if (!before) break
      for (const g of inKitchenByTicket(before)) build('voidEntry', g.sent, g.items)
      break
    }
    case 'OrderMovedTable': {
      if (!before || before.tableId === after.tableId) break
      for (const g of inKitchenByTicket(after))
        build('move', g.sent, g.items, after, targetOf(o, before))
      break
    }
    case 'ItemsMoved': {
      // The event goes on the source order; the target one comes as related.
      const target = changes.find((c) => c.after?.id === event.data.target_order_id)?.after
      if (!before || !target) break
      const ids = event.data.items.map((m) => m.item.item_id)
      for (const g of inKitchenByTicket({ ...before, items: pickItems(before, ids) }))
        build('move', g.sent, g.items, target, targetOf(o, before))
      break
    }
    case 'OrderNoteChanged': {
      // With dishes already in the kitchen, the new (or removed) note is printed at each station
      // that has something pending for that order: an allergy cannot stay only on the screen.
      if ((before?.notes ?? null) === after.notes) break
      const byStation = new Map<string, SentTicket>()
      for (const e of sentTickets(o, after.id))
        if (e.itemIds.some((id) => IN_KITCHEN.has(after.items[id]?.status ?? '')))
          byStation.set(e.stationId, e)
      for (const e of byStation.values())
        toCreate.push({
          ticketId: e.ticketId,
          stationId: e.stationId,
          ticket: ticketData(o, event, after, 'note', e, []),
        })
      break
    }
    case 'ItemModifiedAfterSend': {
      const item = after.items[event.data.item_id]
      if (!item) break
      const sent = sentTicketOf(o, after.id, item.id)
      if (!sent) break
      build('modification', sent, [ticketItem(item)])
      break
    }
    default:
      return 0
  }

  // All or nothing: the event's transaction has no savepoints of its own (`inTransaction`), and a
  // half-printed ticket is worse than none (ADR-015).
  if (toCreate.length === 0) return 0
  o.db.exec('SAVEPOINT tickets')
  try {
    const createdList = insert(o, event, toCreate)
    o.db.exec('RELEASE tickets')
    return createdList
  } catch (error) {
    o.db.exec('ROLLBACK TO tickets')
    o.db.exec('RELEASE tickets')
    throw error
  }
}

function insert(
  o: TicketOptions,
  event: OrderEvent,
  toCreate: readonly { ticketId: string; stationId: string; ticket: Ticket }[],
): number {
  let createdList = 0
  for (const { ticketId, stationId, ticket } of toCreate) {
    for (const printerId of printersOf(o, stationId)) {
      o.db
        .prepare(
          `INSERT INTO print_jobs
             (id, restaurant_id, printer_id, type, event_id, ticket_id, content, created_at)
           VALUES (?, ?, ?, 'ticket', ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(
          newId(),
          o.restaurantId,
          printerId,
          event.id,
          ticketId,
          JSON.stringify(ticket),
          event.received_at,
        )
      createdList += 1
    }
  }
  return createdList
}

/**
 * The pre-bill goes to the printer chosen in «Caja y pagos» (task 1.6). Without a printer, or if
 * the chosen one is archived, it is only shown on screen: nothing is created.
 */
function preBillJob(
  o: TicketOptions,
  event: Extract<OrderEvent, { type: 'PreBillPrinted' }>,
  order: OrderState,
): number {
  const row = value(o, 'SELECT name, config FROM restaurants WHERE id = ?')
  const config = fullConfig(JSON.parse(String(row?.config ?? '{}')))
  const printerId = config.pre_bill_printer_id
  if (
    !printerId ||
    !value(o, 'SELECT 1 FROM printers WHERE restaurant_id = ? AND id = ? AND active = 1', printerId)
  )
    return 0
  const waiter = value(
    o,
    'SELECT name FROM users WHERE restaurant_id = ? AND id = ?',
    order.assignedWaiterId,
  )
  const totals = orderTotals(order)
  const check = event.data.check_id
    ? (order.checks?.find((c) => c.id === event.data.check_id) ?? null)
    : null
  // The hub computes what is owed from the order: the event only says which check was requested.
  // The tip is voluntary: it uses the one chosen when requesting the pre-bill (the suggested one,
  // none or another).
  const subtotal = check ? Math.max(0, checkBalance(order, check.id) ?? 0) : totals.balance
  const tip = event.data.suggested_tip
  const suggested = check ? checkPendingTip(check, subtotal) : orderTip(order, subtotal, config)
  const preBill: PreBill = {
    restaurant: String(row?.name ?? ''),
    target: targetOf(o, order),
    order: order.dayNumber,
    waiter: waiter ? String(waiter.name) : '',
    time: timeOf(o, event.received_at),
    guests: order.guests > 0 ? order.guests : null,
    lines: Object.values(order.items)
      .filter((i) => i.status !== 'voided' && i.quantity > i.voidedQuantity)
      .sort((a, b) => a.position - b.position)
      .map((i) => ({
        quantity: i.quantity - i.voidedQuantity,
        name: i.name,
        options: i.modifiers.map((m) => m.name),
        value: itemTotals(order, i).net,
      })),
    taxes: orderTaxes(order, config.rounding_mode).map((i) => ({
      name: taxName(i.type, i.rate),
      base: i.base,
      value: i.tax,
    })),
    total: totals.net,
    paid: totals.paid,
    check: check ? { name: check.name, amount: subtotal } : null,
    subtotal,
    tip,
    tipRate: tip === suggested ? config.suggested_tip : null,
  }
  o.db
    .prepare(
      `INSERT INTO print_jobs
         (id, restaurant_id, printer_id, type, event_id, ticket_id, content, created_at)
       VALUES (?, ?, ?, 'preBill', ?, 'preBill', ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(newId(), o.restaurantId, printerId, event.id, JSON.stringify(preBill), event.received_at)
  return 1
}

const timeOf = (o: TicketOptions, iso: string) =>
  new Intl.DateTimeFormat('es-CO', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: o.timeZone,
  }).format(new Date(iso))

/** Active printers that print that station. */
export function printersOf(o: TicketOptions, stationId: string): string[] {
  return o.db
    .prepare(
      `SELECT i.id FROM printers i, json_each(i.station_ids) e
       WHERE i.restaurant_id = ? AND i.active = 1 AND e.value = ?
       ORDER BY i.created_at, i.id`,
    )
    .all(o.restaurantId, stationId)
    .map((f) => String(f.id))
}

/**
 * The ticket an item went to the kitchen with. If the item was moved from another order
 * (`ItemsMoved` keeps its id), the send is in the source order: it searches the whole restaurant.
 */
function sentTicketOf(o: TicketOptions, orderId: string, itemId: string): SentTicket | undefined {
  const fromOrder = sentTickets(o, orderId).find((e) => e.itemIds.includes(itemId))
  if (fromOrder) return fromOrder
  const rows = o.db
    .prepare(
      `SELECT e.data, e.assignments FROM events e
       WHERE e.restaurant_id = ? AND e.type = 'ItemsSent'
         AND EXISTS (SELECT 1 FROM json_each(e.data, '$.tickets') c, json_each(c.value, '$.item_ids') i
                     WHERE i.value = ?)
       ORDER BY e.sequence DESC LIMIT 1`,
    )
    .all(o.restaurantId, itemId)
  return fromRows(rows).find((e) => e.itemIds.includes(itemId))
}

/** A ticket by its id, in any order of the restaurant. */
function globalSentTicket(o: TicketOptions, ticketId: string): SentTicket | undefined {
  const rows = o.db
    .prepare(
      `SELECT e.data, e.assignments FROM events e
       WHERE e.restaurant_id = ? AND e.type = 'ItemsSent'
         AND EXISTS (SELECT 1 FROM json_each(e.data, '$.tickets') c
                     WHERE json_extract(c.value, '$.ticket_id') = ?)
       LIMIT 1`,
    )
    .all(o.restaurantId, ticketId)
  return fromRows(rows).find((e) => e.ticketId === ticketId)
}

/** The tickets sent for that order, with their number for the day. */
function sentTickets(o: TicketOptions, orderId: string): SentTicket[] {
  const rows = o.db
    .prepare(
      `SELECT e.data, e.assignments FROM event_aggregates a
       JOIN events e ON e.restaurant_id = a.restaurant_id AND e.id = a.event_id
       WHERE a.restaurant_id = ? AND a.aggregate_id = ? AND e.type = 'ItemsSent'
       ORDER BY a.sequence`,
    )
    .all(o.restaurantId, orderId)
  return fromRows(rows)
}

function fromRows(rows: readonly Row[]): SentTicket[] {
  return rows.flatMap((f) => {
    const data = JSON.parse(String(f.data)) as {
      tickets: { ticket_id: string; station_id: string; item_ids: string[] }[]
    }
    const numbers = (
      JSON.parse(String(f.assignments)) as { ticket_numbers?: Record<string, number> }
    ).ticket_numbers
    return data.tickets.map((c) => ({
      ticketId: c.ticket_id,
      stationId: c.station_id,
      itemIds: c.item_ids,
      number: numbers?.[c.ticket_id] ?? null,
    }))
  })
}

/** What still stands on a ticket (without what was voided). */
function currentItems(order: OrderState, ids: readonly string[]): TicketItem[] {
  return ids
    .map((id) => order.items[id])
    .filter((i): i is OrderItem => !!i && i.status !== 'voided' && i.quantity > i.voidedQuantity)
    .map((i) => ticketItem(i))
}

function ticketItem(i: OrderItem): TicketItem {
  return {
    quantity: i.quantity - i.voidedQuantity,
    name: i.name,
    guest: i.guest,
    course: i.course,
    options: i.modifiers.map((m) => m.name),
    notes: i.notes,
  }
}

const value = (o: TicketOptions, sql: string, ...params: string[]) =>
  o.db.prepare(sql).get(o.restaurantId, ...params)

/** «Mesa 5», «Mesa 5 + 6» (a group with merged tables), «Para llevar»… */
function targetOf(o: TicketOptions, order: OrderState): string {
  if (!order.tableId) return CHANNELS[order.channel] ?? 'Pedido'
  const name = (id: string) =>
    value(o, 'SELECT name FROM dining_tables WHERE restaurant_id = ? AND id = ?', id)?.name
  const main = name(order.tableId)
  const merged = (order.mergedTables ?? []).map(name).filter((n) => n !== undefined)
  return main === undefined ? 'Mesa' : `Mesa ${[main, ...merged].map(String).join(' + ')}`
}

/** Only those items of the order. */
function pickItems(order: OrderState, ids: readonly string[]): OrderState['items'] {
  return Object.fromEntries(Object.entries(order.items).filter(([id]) => ids.includes(id)))
}

function ticketData(
  o: TicketOptions,
  event: OrderEvent,
  order: OrderState,
  type: TicketType,
  sent: SentTicket,
  items: TicketItem[],
): Ticket {
  const station = value(
    o,
    'SELECT name FROM stations WHERE restaurant_id = ? AND id = ?',
    sent.stationId,
  )
  const waiter = value(
    o,
    'SELECT name FROM users WHERE restaurant_id = ? AND id = ?',
    order.assignedWaiterId,
  )
  const target = targetOf(o, order)
  return {
    type,
    station: station ? String(station.name) : 'Estación',
    number: sent.number,
    target,
    order: order.dayNumber,
    waiter: waiter ? String(waiter.name) : '',
    time: timeOf(o, event.received_at),
    guests: order.guests > 0 ? order.guests : null,
    items,
    heldCourses: type === 'newOne' ? order.heldCourses.filter((c) => hasCourse(order, c)) : [],
    // On a void or a change, the order note is a distraction: it already went out with the
    // original ticket.
    orderNote: type === 'newOne' || type === 'reprinting' || type === 'note' ? order.notes : null,
  }
}

/** Whether the order has something from that course still held. */
const hasCourse = (order: OrderState, course: string) =>
  Object.values(order.items).some((i) => i.course === course && i.status === 'held')
