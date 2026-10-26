import type { ApplicableEvent, ItemCopy, OrderEventType } from '../events/order'
import { ORDER_TOTAL_LIMIT } from '../money/arithmetic'
import { chargedInCash } from '../money/cash'
import type { ItemStatus, OrderItem, OrderState, Payment } from './state'
import { checkBalance, hasCurrentPayments, itemTotals, orderTotals, pricePerUnit } from './totals'

/**
 * Why an event could not be applied (or was applied in part). The hub uses this to decide
 * whether it is a rejection or a conflict (docs/SYNC.md#rechazos-cuarentena-y-conflictos).
 */
export type IssueType =
  | 'foreign_event'
  | 'not_in_order'
  | 'event_already_applied'
  | 'order_not_found'
  | 'order_already_exists'
  | 'order_closed'
  | 'order_not_closed'
  | 'item_not_found'
  | 'item_already_exists'
  | 'item_already_sent'
  | 'item_not_sent'
  | 'item_already_voided'
  | 'items_omitted'
  | 'invalid_item_status'
  | 'invalid_quantity'
  | 'mismatched_copy'
  | 'total_exceeds'
  | 'has_discounts'
  | 'order_split'
  | 'order_not_split'
  | 'discount_not_found'
  | 'discount_already_exists'
  | 'invalid_discount'
  | 'discount_exceeds'
  | 'split_mismatch'
  | 'check_not_found'
  | 'payment_not_found'
  | 'payment_already_exists'
  | 'payment_already_voided'
  | 'payment_has_refunds'
  | 'payment_exceeds_balance'
  | 'invalid_adjustment'
  | 'refund_already_exists'
  | 'refund_exceeds'
  | 'method_mismatch'
  | 'use_void'
  | 'pending_balance'
  | 'negative_balance'
  | 'has_payments'
  | 'no_table'
  | 'tables_already_merged'
  | 'tables_not_merged'
  | 'invalid_event'

export interface Issue {
  type: IssueType
  description: string
}

export interface Result {
  status: OrderState | null
  /** Why it was not applied, or (with `items_omitted`) which part was not applied. */
  issue: Issue | null
}

const unchanged = (status: OrderState | null, type: IssueType, description: string): Result => ({
  status,
  issue: { type, description },
})
const ready = (status: OrderState): Result => ({ status, issue: null })

/** Deep copy: the previous projection is never modified. */
const clone = (status: OrderState): OrderState => structuredClone(status)

/** The item of a state copy (it exists because it was already validated on the original). */
function itemOf(status: OrderState, id: string): OrderItem {
  const item = status.items[id]
  if (!item) throw new Error('ítem ausente en la copia')
  return item
}

function paymentOf(status: OrderState, id: string): Payment {
  const payment = status.payments[id]
  if (!payment) throw new Error('pago ausente en la copia')
  return payment
}

const ACTIVE_ITEM_STATUSES: readonly ItemStatus[] = [
  'held',
  'pending',
  'sent',
  'in_preparation',
  'ready',
  'served',
]

/** Events that do not touch amounts and are valid with the order already closed or canceled. */
const NO_AMOUNTS: readonly OrderEventType[] = [
  'ItemInPreparation',
  'ItemReady',
  'ItemServed',
  'ItemReturnedToQueue',
  'TicketReprinted',
  'PreBillPrinted',
]

/** The event touches the order: it is its aggregate or names it in `related` or `affects`. */
export function affectsOrder(event: ApplicableEvent, orderId: string): boolean {
  return (
    event.aggregate_id === orderId ||
    event.related.includes(orderId) ||
    (event.affects ?? []).includes(orderId)
  )
}

/**
 * Applies an event to an order's state. It is total and deterministic: it never throws and gives
 * the same result on the phone, the hub and the cloud. It also accepts own events not yet
 * confirmed (no sequence). `status` is the order being projected, which may not be the event's
 * aggregate (target of ItemsMoved, source of OrdersMerged, rescue order in `affects`).
 */
export function applyEvent(status: OrderState | null, event: ApplicableEvent): Result {
  try {
    if (status && !affectsOrder(event, status.id)) {
      return unchanged(status, 'foreign_event', 'El evento es de otro pedido')
    }
    if (status && event.sequence !== undefined && event.sequence <= status.lastSequence) {
      return unchanged(status, 'event_already_applied', 'El evento ya estaba aplicado')
    }
    const result = apply(status, event)
    if (result.status && result.status !== status && event.sequence !== undefined) {
      result.status.lastSequence = Math.max(result.status.lastSequence, event.sequence)
    }
    return result
  } catch {
    // Fixed text: an error message varies across engines and would break equality between nodes.
    return unchanged(status, 'invalid_event', 'El evento trae datos inesperados')
  }
}

/** Rebuilds an order by applying, in sequence order, only the events that touch it. */
export function rebuild(events: readonly ApplicableEvent[], orderId: string): OrderState | null {
  const seenSet = new Set<string>()
  return events
    .filter((event) => {
      if (!affectsOrder(event, orderId) || seenSet.has(event.id)) return false
      seenSet.add(event.id)
      return true
    })
    .sort(
      (a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER),
    )
    .reduce<OrderState | null>((status, event) => applyEvent(status, event).status, null)
}

function newItem(copy: ItemCopy, addedBy: string, position: number, status: ItemStatus): OrderItem {
  return {
    id: copy.item_id,
    productId: copy.product_id,
    variantId: copy.variant_id,
    name: copy.name,
    unitPrice: copy.unit_price,
    taxType: copy.tax_type,
    rate: copy.rate,
    quantity: copy.quantity,
    voidedQuantity: 0,
    guest: copy.guest,
    course: copy.course,
    status,
    addedBy,
    notes: copy.notes,
    modifiers: copy.modifiers.map((m) => ({
      modifierId: m.modifier_id,
      name: m.name,
      extraPrice: m.extra_price,
    })),
    position,
  }
}

const hasDiscount = (status: OrderState, itemId: string) =>
  Object.values(status.discounts).some((d) => (d.amounts[itemId] ?? 0) > 0)

const exceedsCap = (status: OrderState) => orderTotals(status).gross > ORDER_TOTAL_LIMIT

/** Status of an unsent item depending on whether its course is held. */
const unsentStatus = (status: OrderState, course: OrderItem['course']): ItemStatus =>
  course !== null && status.heldCourses.includes(course) ? 'held' : 'pending'

interface Moved {
  item: ItemCopy
  status: ItemStatus
  voided_quantity: number
  added_by: string
}

/** Checks that the moved copy matches the real item of the source order. */
function sameCopy(item: OrderItem, moved: Moved): boolean {
  const c = moved.item
  return (
    c.product_id === item.productId &&
    c.unit_price === item.unitPrice &&
    c.tax_type === item.taxType &&
    c.rate === item.rate &&
    c.quantity === item.quantity &&
    moved.voided_quantity === item.voidedQuantity &&
    moved.status === item.status &&
    moved.added_by === item.addedBy &&
    c.modifiers.length === item.modifiers.length &&
    c.modifiers.every(
      (m, i) =>
        m.modifier_id === item.modifiers[i]?.modifierId &&
        m.extra_price === item.modifiers[i]?.extraPrice,
    )
  )
}

/**
 * Changes the status of several items. It applies to those that can; if any cannot, it reports
 * `items_omitted` (the rest still reach the kitchen). If none can, nothing changes.
 */
function transition(
  status: OrderState,
  itemIds: readonly string[],
  from: readonly ItemStatus[],
  toward: ItemStatus,
): Result {
  const validEntries = itemIds.filter((id) => {
    const item = status.items[id]
    return item !== undefined && from.includes(item.status)
  })
  if (validEntries.length === 0) {
    const nonexistent = itemIds.some((id) => !status.items[id])
    return unchanged(
      status,
      nonexistent ? 'item_not_found' : 'invalid_item_status',
      `Ningún ítem puede pasar a ${toward}`,
    )
  }
  const fresh = clone(status)
  for (const id of validEntries) itemOf(fresh, id).status = toward
  const omitted = itemIds.length - validEntries.length
  if (omitted === 0) return ready(fresh)
  return {
    status: fresh,
    issue: { type: 'items_omitted', description: `${omitted} ítem(s) no pasaron a ${toward}` },
  }
}

function apply(status: OrderState | null, event: ApplicableEvent): Result {
  const time = event.received_at ?? event.hub_estimated_time

  // A product event (sold out) or register event changes no order.
  if (event.aggregate_type !== 'order')
    return unchanged(status, 'not_in_order', `${event.type} no es de un pedido`)

  if (event.type === 'OrderOpened' || event.type === 'RescueOrderCreated') {
    if (status) return unchanged(status, 'order_already_exists', 'El pedido ya está abierto')
    const rescue = event.type === 'RescueOrderCreated'
    return ready({
      id: event.aggregate_id,
      channel: event.data.channel,
      tableId: event.data.table_id,
      guests: rescue ? 0 : event.data.guests,
      assignedWaiterId: rescue ? event.data.waiter_id : event.user_id,
      status: 'open',
      openedAt: time,
      closedAt: null,
      businessDay: null,
      dayNumber: event.assignments?.day_number ?? null,
      rescueOf: rescue ? event.data.original_order_id : null,
      mergedInto: null,
      notes: null,
      mergedTables: [],
      emptiedOnMove: false,
      items: {},
      discounts: {},
      heldCourses: [],
      checks: null,
      payments: {},
      lastPreBill: null,
      lastSequence: event.sequence ?? 0,
      nextPosition: 1,
    })
  }

  if (!status) return unchanged(null, 'order_not_found', 'El pedido no existe')

  if (event.type === 'OrderReopened') {
    if (status.status !== 'closed')
      return unchanged(status, 'order_not_closed', 'Solo se reabre un pedido cerrado')
    const fresh = clone(status)
    fresh.status = 'open'
    fresh.closedAt = null
    return ready(fresh)
  }

  if (status.status !== 'open' && !NO_AMOUNTS.includes(event.type)) {
    return unchanged(status, 'order_closed', `El pedido está ${status.status}: hay que reabrirlo`)
  }

  switch (event.type) {
    case 'WaiterAssigned': {
      const fresh = clone(status)
      fresh.assignedWaiterId = event.data.waiter_id
      return ready(fresh)
    }

    case 'GuestsChanged': {
      const fresh = clone(status)
      fresh.guests = event.data.guests
      return ready(fresh)
    }

    case 'OrderNoteChanged': {
      const fresh = clone(status)
      fresh.notes = event.data.notes?.trim() || null
      return ready(fresh)
    }

    case 'ItemAdded': {
      const { item_id, course } = event.data
      if (status.items[item_id])
        return unchanged(status, 'item_already_exists', 'El ítem ya existe')
      const fresh = clone(status)
      fresh.items[item_id] = newItem(
        event.data,
        event.user_id,
        fresh.nextPosition,
        unsentStatus(fresh, course),
      )
      fresh.nextPosition += 1
      fresh.emptiedOnMove = false
      // Ordering after the pre-bill makes it stale: the table is no longer «pidiendo la cuenta».
      fresh.lastPreBill = null
      if (exceedsCap(fresh))
        return unchanged(status, 'total_exceeds', 'El pedido pasaría del tope permitido')
      return ready(fresh)
    }

    case 'ItemChanged':
    case 'ItemRemoved': {
      const item = status.items[event.data.item_id]
      if (!item) return unchanged(status, 'item_not_found', 'El ítem no existe')
      if (item.status !== 'pending' && item.status !== 'held') {
        return unchanged(status, 'item_already_sent', `${item.name} ya se envió a cocina`)
      }
      // Only what changes amounts requires removing discounts or undoing the split.
      const changesAmount = event.type === 'ItemRemoved' || event.data.quantity !== undefined
      if (changesAmount && hasDiscount(status, item.id)) {
        return unchanged(status, 'has_discounts', 'Primero retira el descuento')
      }
      if (changesAmount && status.checks)
        return unchanged(status, 'order_split', 'Primero deshaz la división')
      const fresh = clone(status)
      if (event.type === 'ItemRemoved') {
        delete fresh.items[item.id]
      } else {
        const change = itemOf(fresh, item.id)
        const { quantity, guest, course, notes } = event.data
        if (quantity !== undefined) change.quantity = quantity
        if (guest !== undefined) change.guest = guest
        if (notes !== undefined) change.notes = notes
        if (course !== undefined) {
          change.course = course
          change.status = unsentStatus(fresh, course)
        }
      }
      if (orderTotals(fresh).balance < 0) {
        return unchanged(
          status,
          'negative_balance',
          'Ya se pagó: primero anula el pago o registra un reembolso',
        )
      }
      if (exceedsCap(fresh))
        return unchanged(status, 'total_exceeds', 'El pedido pasaría del tope permitido')
      return ready(fresh)
    }

    case 'ItemsSent':
      return transition(
        status,
        event.data.tickets.flatMap((c) => c.item_ids),
        ['pending'],
        'sent',
      )

    case 'ItemModifiedAfterSend': {
      const item = status.items[event.data.item_id]
      if (!item) return unchanged(status, 'item_not_found', 'El ítem no existe')
      if (item.status === 'pending' || item.status === 'held') {
        return unchanged(status, 'item_not_sent', 'El ítem aún no se envió: usa ItemCambiado')
      }
      if (item.status === 'voided')
        return unchanged(status, 'item_already_voided', 'El ítem está anulado')
      const { modifiers, notes } = event.data
      const currentExtras = item.modifiers.reduce((a, m) => a + m.extraPrice, 0)
      const changesPrice =
        modifiers !== undefined &&
        modifiers.reduce((a, m) => a + m.extra_price, 0) !== currentExtras
      if (changesPrice && hasDiscount(status, item.id))
        return unchanged(status, 'has_discounts', 'Primero retira el descuento')
      if (changesPrice && status.checks)
        return unchanged(status, 'order_split', 'Primero deshaz la división')
      const fresh = clone(status)
      const change = itemOf(fresh, item.id)
      if (notes !== undefined) change.notes = notes
      if (modifiers !== undefined) {
        change.modifiers = modifiers.map((m) => ({
          modifierId: m.modifier_id,
          name: m.name,
          extraPrice: m.extra_price,
        }))
      }
      if (orderTotals(fresh).balance < 0)
        return unchanged(status, 'negative_balance', 'El pedido quedaría con saldo negativo')
      if (exceedsCap(fresh))
        return unchanged(status, 'total_exceeds', 'El pedido pasaría del tope permitido')
      return ready(fresh)
    }

    case 'TicketReprinted':
      return ready({ ...status })

    case 'CourseHeld':
    case 'CourseFired': {
      const { course } = event.data
      const hold = event.type === 'CourseHeld'
      const fresh = clone(status)
      fresh.heldCourses = hold
        ? [...new Set([...fresh.heldCourses, course])]
        : fresh.heldCourses.filter((c) => c !== course)
      for (const item of Object.values(fresh.items)) {
        if (item.course !== course) continue
        if (hold && item.status === 'pending') item.status = 'held'
        if (!hold && item.status === 'held') item.status = 'pending'
      }
      return ready(fresh)
    }

    case 'ItemInPreparation':
      return transition(status, event.data.item_ids, ['sent'], 'in_preparation')
    case 'ItemReady':
      return transition(status, event.data.item_ids, ['sent', 'in_preparation'], 'ready')
    case 'ItemServed':
      // Without a KDS nobody marks "ready": the waiter can serve straight from sent.
      return transition(status, event.data.item_ids, ['sent', 'in_preparation', 'ready'], 'served')
    case 'ItemReturnedToQueue':
      return transition(status, event.data.item_ids, ['ready', 'served'], 'sent')

    case 'ItemVoided': {
      const item = status.items[event.data.item_id]
      if (!item) return unchanged(status, 'item_not_found', 'El ítem no existe')
      if (item.status === 'voided')
        return unchanged(status, 'item_already_voided', `${item.name} ya está anulado`)
      if (item.status === 'pending' || item.status === 'held') {
        return unchanged(status, 'item_not_sent', 'Un ítem no enviado se quita, no se anula')
      }
      if (event.data.quantity > item.quantity - item.voidedQuantity) {
        return unchanged(status, 'invalid_quantity', 'Se anulan más unidades de las que quedan')
      }
      if (hasDiscount(status, item.id))
        return unchanged(status, 'has_discounts', 'Primero retira el descuento')
      if (status.checks) return unchanged(status, 'order_split', 'Primero deshaz la división')
      const fresh = clone(status)
      const voided = itemOf(fresh, item.id)
      voided.voidedQuantity += event.data.quantity
      if (voided.voidedQuantity === voided.quantity) voided.status = 'voided'
      if (orderTotals(fresh).balance < 0) {
        return unchanged(
          status,
          'negative_balance',
          'Ya se pagó: primero anula el pago o registra un reembolso',
        )
      }
      return ready(fresh)
    }

    case 'ItemsMoved':
    case 'OrdersMerged': {
      const move = event.type === 'ItemsMoved'
      const sourceId = move ? event.aggregate_id : event.data.source_order_id
      const targetId = move ? event.data.target_order_id : event.aggregate_id
      const isSource = status.id === sourceId
      if (!isSource && status.id !== targetId)
        return unchanged(status, 'invalid_event', 'El pedido no es ni origen ni destino')
      if (status.checks) return unchanged(status, 'order_split', 'Primero deshaz la división')
      const fresh = clone(status)

      if (isSource) {
        if (!move) {
          if (hasCurrentPayments(status))
            return unchanged(status, 'has_payments', 'El pedido que se une tiene pagos')
          if (Object.keys(status.discounts).length > 0) {
            return unchanged(
              status,
              'has_discounts',
              'Primero retira los descuentos del pedido que se une',
            )
          }
          const activeRows = Object.values(status.items).filter((i) => i.status !== 'voided')
          if (activeRows.length !== event.data.items.length) {
            return unchanged(
              status,
              'mismatched_copy',
              'La unión no trae todos los ítems del pedido',
            )
          }
        }
        for (const moved of event.data.items) {
          const item = fresh.items[moved.item.item_id]
          if (!item || !ACTIVE_ITEM_STATUSES.includes(item.status)) {
            return unchanged(status, 'item_not_found', 'Un ítem que se mueve no está en el pedido')
          }
          if (hasDiscount(fresh, item.id))
            return unchanged(status, 'has_discounts', 'Primero retira el descuento')
          if (!sameCopy(item, moved))
            return unchanged(status, 'mismatched_copy', `La copia de ${item.name} no coincide`)
          delete fresh.items[item.id]
        }
        if (!move) {
          fresh.items = {}
          fresh.status = 'canceled'
          fresh.mergedInto = targetId
        } else if (orderTotals(fresh).balance < 0) {
          return unchanged(status, 'negative_balance', 'Se movería algo ya pagado')
        } else {
          fresh.emptiedOnMove = Object.keys(fresh.items).length === 0
        }
        return ready(fresh)
      }

      for (const moved of event.data.items) {
        const id = moved.item.item_id
        if (fresh.items[id])
          return unchanged(status, 'item_already_exists', 'El ítem ya está en el destino')
        const item = newItem(moved.item, moved.added_by, fresh.nextPosition, moved.status)
        item.voidedQuantity = moved.voided_quantity
        fresh.items[id] = item
        fresh.nextPosition += 1
      }
      fresh.emptiedOnMove = false
      if (exceedsCap(fresh))
        return unchanged(status, 'total_exceeds', 'El pedido pasaría del tope permitido')
      return ready(fresh)
    }

    case 'OrderMovedTable': {
      const fresh = clone(status)
      fresh.tableId = event.data.target_table_id
      // If moved to one of its merged tables, that one stops being counted separately.
      fresh.mergedTables = fresh.mergedTables.filter((m) => m !== fresh.tableId)
      return ready(fresh)
    }

    case 'TablesMerged': {
      if (!status.tableId) return unchanged(status, 'no_table', 'Un pedido sin mesa no une mesas')
      const fresh = clone(status)
      const newOnes = event.data.table_ids.filter(
        (m) => m !== status.tableId && !status.mergedTables.includes(m),
      )
      if (newOnes.length === 0)
        return unchanged(status, 'tables_already_merged', 'Esas mesas ya están unidas')
      fresh.mergedTables = [...fresh.mergedTables, ...newOnes]
      return ready(fresh)
    }

    case 'TablesSeparated': {
      const remove = new Set(event.data.table_ids)
      if (!status.mergedTables.some((m) => remove.has(m)))
        return unchanged(status, 'tables_not_merged', 'Esas mesas no están unidas a este pedido')
      const fresh = clone(status)
      fresh.mergedTables = fresh.mergedTables.filter((m) => !remove.has(m))
      return ready(fresh)
    }

    case 'DiscountApplied': {
      const { discount_id, amounts, scope, rule, value, unit_count } = event.data
      if (status.discounts[discount_id])
        return unchanged(status, 'discount_already_exists', 'El descuento ya existe')
      if (status.checks) return unchanged(status, 'order_split', 'Primero deshaz la división')
      for (const { item_id, amount } of amounts) {
        const item = status.items[item_id]
        if (!item || item.status === 'voided')
          return unchanged(status, 'item_not_found', 'No se puede descontar ese ítem')
        if (rule === 'comp') {
          const units = unit_count ?? 0
          if (
            units > item.quantity - item.voidedQuantity ||
            amount !== units * pricePerUnit(item)
          ) {
            return unchanged(
              status,
              'invalid_discount',
              'La cortesía no coincide con las unidades del ítem',
            )
          }
        }
      }
      const fresh = clone(status)
      fresh.discounts[discount_id] = {
        id: discount_id,
        scope,
        rule,
        value,
        amounts: Object.fromEntries(amounts.map((m) => [m.item_id, m.amount])),
        reason: event.reason,
      }
      for (const { item_id } of amounts) {
        if (itemTotals(fresh, itemOf(fresh, item_id)).net < 0) {
          return unchanged(
            status,
            'discount_exceeds',
            'El descuento deja una línea por debajo de 0',
          )
        }
      }
      if (orderTotals(fresh).balance < 0)
        return unchanged(status, 'negative_balance', 'El pedido ya está pagado')
      return ready(fresh)
    }

    case 'DiscountRemoved': {
      if (!status.discounts[event.data.discount_id]) {
        return unchanged(status, 'discount_not_found', 'El descuento no existe')
      }
      if (status.checks) return unchanged(status, 'order_split', 'Primero deshaz la división')
      const fresh = clone(status)
      delete fresh.discounts[event.data.discount_id]
      return ready(fresh)
    }

    case 'PreBillPrinted': {
      const fresh = clone(status)
      fresh.lastPreBill = {
        checkId: event.data.check_id,
        subtotal: event.data.subtotal,
        suggestedTip: event.data.suggested_tip,
      }
      return ready(fresh)
    }

    case 'CheckSplit': {
      if (status.checks) return unchanged(status, 'order_split', 'El pedido ya está dividido')
      const referenced = event.data.checks.flatMap((c) => c.items.map((i) => i.item_id))
      if (referenced.some((id) => !status.items[id])) {
        return unchanged(status, 'item_not_found', 'Una cuenta nombra un ítem que no está')
      }
      const assigned = event.data.checks.reduce((a, c) => a + c.amount, 0)
      if (assigned > orderTotals(status).balance) {
        return unchanged(status, 'split_mismatch', 'Las cuentas suman más que el saldo')
      }
      const fresh = clone(status)
      fresh.checks = event.data.checks.map((c) => ({
        id: c.check_id,
        name: c.name,
        amount: c.amount,
        suggestedTip: c.suggested_tip,
      }))
      return ready(fresh)
    }

    case 'SplitUndone': {
      if (!status.checks) return unchanged(status, 'order_not_split', 'El pedido no está dividido')
      const checks = new Set(status.checks.map((c) => c.id))
      const withPayments = Object.values(status.payments).some(
        (p) => !p.voided && p.checkId !== null && checks.has(p.checkId),
      )
      if (withPayments) return unchanged(status, 'has_payments', 'Hay cuentas con pagos')
      const fresh = clone(status)
      fresh.checks = null
      return ready(fresh)
    }

    case 'PaymentRecorded': {
      const d = event.data
      if (status.payments[d.payment_id])
        return unchanged(status, 'payment_already_exists', 'El pago ya está registrado')
      let available: number | null
      if (d.check_id === null && status.checks) {
        // No check on a split order: only what was left unassigned.
        const inChecks = status.checks.reduce(
          (a, c) => a + Math.max(0, checkBalance(status, c.id) ?? 0),
          0,
        )
        available = orderTotals(status).balance - inChecks
      } else {
        available = checkBalance(status, d.check_id)
      }
      if (available === null) return unchanged(status, 'check_not_found', 'La cuenta no existe')
      if (d.amount > available)
        return unchanged(
          status,
          'payment_exceeds_balance',
          `El pago supera el saldo (${available})`,
        )
      if (d.rounding !== null) {
        // Rounding only goes on the cash payment that brings the balance to 0, and its adjustment
        // must be exactly the rule's (docs/DINERO.md#pagos).
        const expected = chargedInCash(available, d.rounding.multiple, d.rounding.mode) - available
        if (d.amount !== available || d.rounding_adjustment !== expected) {
          return unchanged(
            status,
            'invalid_adjustment',
            'El ajuste no corresponde al redondeo del saldo',
          )
        }
      }
      const fresh = clone(status)
      fresh.payments[d.payment_id] = {
        id: d.payment_id,
        checkId: d.check_id,
        registerShiftId: d.register_shift_id,
        method: d.method,
        customMethodId: d.custom_method_id ?? null,
        amount: d.amount,
        tip: d.tip,
        roundingAdjustment: d.rounding_adjustment,
        voided: false,
        refundedSale: 0,
        refundedTip: 0,
        refundIds: [],
      }
      return ready(fresh)
    }

    case 'PaymentVoided': {
      const payment = status.payments[event.data.payment_id]
      if (!payment) return unchanged(status, 'payment_not_found', 'El pago no existe')
      if (payment.voided)
        return unchanged(status, 'payment_already_voided', 'El pago ya está anulado')
      // A void returns everything charged: with earlier refunds it would be returned twice.
      if (payment.refundedSale + payment.refundedTip > 0) {
        return unchanged(
          status,
          'payment_has_refunds',
          'El pago ya tiene reembolsos: reembolsa el resto',
        )
      }
      const fresh = clone(status)
      paymentOf(fresh, payment.id).voided = true
      return ready(fresh)
    }

    case 'RefundRecorded': {
      const d = event.data
      const payment = status.payments[d.payment_id]
      if (!payment) return unchanged(status, 'payment_not_found', 'El pago no existe')
      if (payment.voided) return unchanged(status, 'payment_already_voided', 'El pago está anulado')
      if (payment.refundIds.includes(d.refund_id))
        return unchanged(status, 'refund_already_exists', 'El reembolso ya se registró')
      if (d.method !== payment.method)
        return unchanged(status, 'method_mismatch', 'Se reembolsa por el mismo medio del pago')
      const sale = payment.refundedSale + d.sale_amount
      const tip = payment.refundedTip + d.tip_amount
      const charged = payment.amount + payment.roundingAdjustment + payment.tip
      if (sale > payment.amount || tip > payment.tip || sale + tip > charged) {
        return unchanged(status, 'refund_exceeds', 'El reembolso supera lo pagado')
      }
      // Refunding the whole sale of a cash payment with an adjustment would leave the adjustment
      // dangling: the payment is voided instead.
      if (
        payment.roundingAdjustment !== 0 &&
        sale >= payment.amount + Math.min(0, payment.roundingAdjustment)
      ) {
        return unchanged(status, 'use_void', 'Para devolver todo este pago, anúlalo')
      }
      const fresh = clone(status)
      const refunded = paymentOf(fresh, payment.id)
      refunded.refundedSale = sale
      refunded.refundedTip = tip
      refunded.refundIds.push(d.refund_id)
      return ready(fresh)
    }

    case 'OrderClosed': {
      const { balance } = orderTotals(status)
      if (balance !== 0) return unchanged(status, 'pending_balance', `Queda un saldo de ${balance}`)
      const fresh = clone(status)
      fresh.status = 'closed'
      fresh.closedAt = time
      fresh.businessDay ??= event.business_day ?? null
      return ready(fresh)
    }

    case 'OrderCanceled': {
      if (hasCurrentPayments(status))
        return unchanged(status, 'has_payments', 'Primero anula los pagos')
      const fresh = clone(status)
      fresh.status = 'canceled'
      return ready(fresh)
    }

    // Filtered above; here only so the switch covers every type.
    case 'ProductSoldOut':
    case 'ProductAvailable':
    case 'ShiftOpened':
    case 'CashMovementRecorded':
    case 'CashCountRecorded':
    case 'ShiftClosed':
      return unchanged(status, 'not_in_order', `${event.type} no es de un pedido`)
  }
}
