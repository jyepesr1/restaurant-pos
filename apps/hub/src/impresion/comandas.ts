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
import { encolarCierreZ } from '../reportes/cierre-z'

// De un evento aceptado a los trabajos de impresión de sus comandas (ADR-015). Corre dentro de la
// transacción del evento (`ConfigHub.onSave`): si el hub se cae justo después, las comandas ya
// están en la cola. Solo arma datos; la cola (`cola.ts`) las convierte en bytes al imprimir, con
// el ancho de la impresora que finalmente la imprima (puede ser la de respaldo).

const EN_COCINA = new Set(['sent', 'in_preparation', 'ready'])

const CANALES: Record<string, string> = {
  dine_in: 'Mesa',
  takeout: 'Para llevar',
  delivery: 'Domicilio',
  bar: 'Barra',
}

/** Una comanda ya enviada: de qué estación es, qué llevaba y su número del día. */
interface Enviada {
  comandaId: string
  stationId: string
  itemIds: string[]
  number: number | null
}

export interface OpcionesComandas {
  db: SqliteDatabase
  restaurantId: string
  timeZone: string
}

/** Crea los trabajos de impresión que pide el evento. Devuelve cuántos creó. */
export function trabajosDeEvento(
  o: OpcionesComandas,
  event: OrderEvent,
  changes: readonly OrderChange[],
): number {
  // Al cerrar la caja sale el cierre Z (tarea 1.9).
  // Un fallo aquí no es de una comanda: se registra aparte y el cierre se reimprime desde Reportes.
  if (event.type === 'ShiftClosed') {
    try {
      return encolarCierreZ(o, event.aggregate_id, { event }) === 'queued' ? 1 : 0
    } catch (error) {
      console.error(`No se pudo armar el cierre Z del turno ${event.aggregate_id}:`, error)
      return 0
    }
  }
  const change = changes[0]
  const before = change?.before ?? null
  const after = change?.after ?? null
  if (!after) return 0
  if (event.type === 'PreBillPrinted') return trabajoDePrecuenta(o, event, after)

  const porCrear: { comandaId: string; stationId: string; ticket: Ticket }[] = []
  const build = (
    type: TicketType,
    sent: Enviada,
    items: TicketItem[],
    order: OrderState = after,
    from: string | null = null,
  ) => {
    if (items.length > 0)
      porCrear.push({
        comandaId: sent.comandaId,
        stationId: sent.stationId,
        ticket: { ...datosComanda(o, event, order, type, sent, items), before: from },
      })
  }
  /** Lo que sigue en cocina de un pedido, agrupado por la comanda con que salió. */
  const enCocinaPorComanda = (order: OrderState, ids?: readonly string[]) => {
    const groups = new Map<string, { sent: Enviada; items: TicketItem[] }>()
    for (const item of Object.values(order.items)) {
      if (ids && !ids.includes(item.id)) continue
      if (!EN_COCINA.has(item.status) || item.quantity <= item.voidedQuantity) continue
      const sent = enviadaDe(o, order.id, item.id)
      if (!sent) continue
      const g = groups.get(sent.comandaId) ?? { sent, items: [] }
      g.items.push(itemComanda(item))
      groups.set(sent.comandaId, g)
    }
    return [...groups.values()]
  }

  switch (event.type) {
    case 'ItemsSent': {
      // Solo lo que de verdad pasó a enviado: lo ya enviado por otro equipo no se repite.
      for (const c of event.data.tickets) {
        const items = c.item_ids
          .filter(
            (id) => before?.items[id]?.status === 'pending' && after.items[id]?.status === 'sent',
          )
          .map((id) => after.items[id])
          .filter((i): i is OrderItem => !!i)
          .map((i) => itemComanda(i))
        build(
          'newOne',
          {
            comandaId: c.ticket_id,
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
      // Si sus platos pasaron a otra mesa, el envío está en el pedido de origen.
      const sent =
        enviadas(o, after.id).find((e) => e.comandaId === event.data.ticket_id) ??
        enviadaGlobal(o, event.data.ticket_id)
      if (!sent) break
      build('reprinting', sent, itemsVigentes(after, sent.itemIds))
      break
    }
    case 'ItemVoided': {
      const item = before?.items[event.data.item_id]
      // Lo que no se había enviado no está en la cocina, y lo entregado ya salió: no hay nada
      // que avisar allá.
      if (!item || !['sent', 'in_preparation', 'ready'].includes(item.status)) break
      const sent = enviadaDe(o, after.id, item.id)
      if (!sent) break
      build('voidEntry', sent, [
        itemComanda({ ...item, quantity: event.data.quantity, voidedQuantity: 0 }),
      ])
      break
    }
    case 'OrderCanceled': {
      // Lo que la cocina tenía de un pedido cancelado sale como anulación.
      if (!before) break
      for (const g of enCocinaPorComanda(before)) build('voidEntry', g.sent, g.items)
      break
    }
    case 'OrderMovedTable': {
      if (!before || before.tableId === after.tableId) break
      for (const g of enCocinaPorComanda(after))
        build('move', g.sent, g.items, after, destinoDe(o, before))
      break
    }
    case 'ItemsMoved': {
      // El evento va en el pedido de origen; el de destino viene como relacionado.
      const target = changes.find((c) => c.after?.id === event.data.target_order_id)?.after
      if (!before || !target) break
      const ids = event.data.items.map((m) => m.item.item_id)
      for (const g of enCocinaPorComanda({ ...before, items: pickItems(before, ids) }))
        build('move', g.sent, g.items, target, destinoDe(o, before))
      break
    }
    case 'OrderNoteChanged': {
      // Con platos ya en cocina, la nota nueva (o que se quitó) sale en papel a cada estación que
      // tiene algo pendiente de ese pedido: una alergia no puede quedar solo en la pantalla.
      if ((before?.notes ?? null) === after.notes) break
      const porEstacion = new Map<string, Enviada>()
      for (const e of enviadas(o, after.id))
        if (e.itemIds.some((id) => EN_COCINA.has(after.items[id]?.status ?? '')))
          porEstacion.set(e.stationId, e)
      for (const e of porEstacion.values())
        porCrear.push({
          comandaId: e.comandaId,
          stationId: e.stationId,
          ticket: datosComanda(o, event, after, 'note', e, []),
        })
      break
    }
    case 'ItemModifiedAfterSend': {
      const item = after.items[event.data.item_id]
      if (!item) break
      const sent = enviadaDe(o, after.id, item.id)
      if (!sent) break
      build('modification', sent, [itemComanda(item)])
      break
    }
    default:
      return 0
  }

  // Todo o nada: la transacción del evento no tiene savepoints propios (`inTransaction`), y una
  // comanda a medias es peor que ninguna (ADR-015).
  if (porCrear.length === 0) return 0
  o.db.exec('SAVEPOINT comandas')
  try {
    const createdList = insert(o, event, porCrear)
    o.db.exec('RELEASE comandas')
    return createdList
  } catch (error) {
    o.db.exec('ROLLBACK TO comandas')
    o.db.exec('RELEASE comandas')
    throw error
  }
}

function insert(
  o: OpcionesComandas,
  event: OrderEvent,
  porCrear: readonly { comandaId: string; stationId: string; ticket: Ticket }[],
): number {
  let createdList = 0
  for (const { comandaId, stationId, ticket } of porCrear) {
    for (const printerId of impresorasDe(o, stationId)) {
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
          comandaId,
          JSON.stringify(ticket),
          event.received_at,
        )
      createdList += 1
    }
  }
  return createdList
}

/**
 * La precuenta va a la impresora elegida en «Caja y pagos» (tarea 1.6). Sin impresora, o si la
 * elegida está archivada, solo se ve en pantalla: no se crea nada.
 */
function trabajoDePrecuenta(
  o: OpcionesComandas,
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
  const totales = orderTotals(order)
  const check = event.data.check_id
    ? (order.checks?.find((c) => c.id === event.data.check_id) ?? null)
    : null
  // Lo que se debe lo calcula el hub con el pedido: el evento solo dice qué cuenta se pidió. La
  // propina es voluntaria: va la que se eligió al pedir la precuenta (la sugerida, ninguna u otra).
  const subtotal = check ? Math.max(0, checkBalance(order, check.id) ?? 0) : totales.balance
  const tip = event.data.suggested_tip
  const suggested = check ? checkPendingTip(check, subtotal) : orderTip(order, subtotal, config)
  const preBill: PreBill = {
    restaurant: String(row?.name ?? ''),
    target: destinoDe(o, order),
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
    total: totales.net,
    paid: totales.paid,
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

const timeOf = (o: OpcionesComandas, iso: string) =>
  new Intl.DateTimeFormat('es-CO', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: o.timeZone,
  }).format(new Date(iso))

/** Impresoras activas que imprimen esa estación. */
export function impresorasDe(o: OpcionesComandas, stationId: string): string[] {
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
 * La comanda con que salió a cocina un ítem. Si el ítem se pasó de otro pedido (`ItemsMoved`
 * conserva su id), el envío está en el pedido de origen: se busca en todo el restaurante.
 */
function enviadaDe(o: OpcionesComandas, orderId: string, itemId: string): Enviada | undefined {
  const fromOrder = enviadas(o, orderId).find((e) => e.itemIds.includes(itemId))
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
  return deFilas(rows).find((e) => e.itemIds.includes(itemId))
}

/** Una comanda por su id, en cualquier pedido del restaurante. */
function enviadaGlobal(o: OpcionesComandas, comandaId: string): Enviada | undefined {
  const rows = o.db
    .prepare(
      `SELECT e.data, e.assignments FROM events e
       WHERE e.restaurant_id = ? AND e.type = 'ItemsSent'
         AND EXISTS (SELECT 1 FROM json_each(e.data, '$.tickets') c
                     WHERE json_extract(c.value, '$.ticket_id') = ?)
       LIMIT 1`,
    )
    .all(o.restaurantId, comandaId)
  return deFilas(rows).find((e) => e.comandaId === comandaId)
}

/** Las comandas que se enviaron de ese pedido, con su número del día. */
function enviadas(o: OpcionesComandas, orderId: string): Enviada[] {
  const rows = o.db
    .prepare(
      `SELECT e.data, e.assignments FROM event_aggregates a
       JOIN events e ON e.restaurant_id = a.restaurant_id AND e.id = a.event_id
       WHERE a.restaurant_id = ? AND a.aggregate_id = ? AND e.type = 'ItemsSent'
       ORDER BY a.sequence`,
    )
    .all(o.restaurantId, orderId)
  return deFilas(rows)
}

function deFilas(rows: readonly Row[]): Enviada[] {
  return rows.flatMap((f) => {
    const data = JSON.parse(String(f.data)) as {
      tickets: { ticket_id: string; station_id: string; item_ids: string[] }[]
    }
    const numbers = (
      JSON.parse(String(f.assignments)) as { ticket_numbers?: Record<string, number> }
    ).ticket_numbers
    return data.tickets.map((c) => ({
      comandaId: c.ticket_id,
      stationId: c.station_id,
      itemIds: c.item_ids,
      number: numbers?.[c.ticket_id] ?? null,
    }))
  })
}

/** Lo que sigue en pie de una comanda (sin lo anulado). */
function itemsVigentes(order: OrderState, ids: readonly string[]): TicketItem[] {
  return ids
    .map((id) => order.items[id])
    .filter((i): i is OrderItem => !!i && i.status !== 'voided' && i.quantity > i.voidedQuantity)
    .map((i) => itemComanda(i))
}

function itemComanda(i: OrderItem): TicketItem {
  return {
    quantity: i.quantity - i.voidedQuantity,
    name: i.name,
    guest: i.guest,
    course: i.course,
    options: i.modifiers.map((m) => m.name),
    notes: i.notes,
  }
}

const value = (o: OpcionesComandas, sql: string, ...params: string[]) =>
  o.db.prepare(sql).get(o.restaurantId, ...params)

/** «Mesa 5», «Mesa 5 + 6» (un grupo con mesas unidas), «Para llevar»… */
function destinoDe(o: OpcionesComandas, order: OrderState): string {
  if (!order.tableId) return CANALES[order.channel] ?? 'Pedido'
  const name = (id: string) =>
    value(o, 'SELECT name FROM dining_tables WHERE restaurant_id = ? AND id = ?', id)?.name
  const main = name(order.tableId)
  const merged = (order.mergedTables ?? []).map(name).filter((n) => n !== undefined)
  return main === undefined ? 'Mesa' : `Mesa ${[main, ...merged].map(String).join(' + ')}`
}

/** Solo esos ítems del pedido. */
function pickItems(order: OrderState, ids: readonly string[]): OrderState['items'] {
  return Object.fromEntries(Object.entries(order.items).filter(([id]) => ids.includes(id)))
}

function datosComanda(
  o: OpcionesComandas,
  event: OrderEvent,
  order: OrderState,
  type: TicketType,
  sent: Enviada,
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
  const target = destinoDe(o, order)
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
    heldCourses: type === 'newOne' ? order.heldCourses.filter((c) => tieneCurso(order, c)) : [],
    // En una anulación o un cambio, la nota del pedido distrae: ya salió con la comanda original.
    orderNote: type === 'newOne' || type === 'reprinting' || type === 'note' ? order.notes : null,
  }
}

/** Si el pedido tiene algo de ese curso todavía retenido. */
const tieneCurso = (order: OrderState, course: string) =>
  Object.values(order.items).some((i) => i.course === course && i.status === 'held')
