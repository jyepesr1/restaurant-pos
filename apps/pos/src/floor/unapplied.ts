import type { ApplicableEvent, NewEvent, OrderState } from '@pos/core'
import type { Catalog } from '@pos/sync'
import { pesos } from '../ui/format'
import { methodInSentence, rulesOf } from './checks'
import { CHANNELS } from './order'

// What the device tells whoever did something the hub saved but did not apply (task 1.7b,
// docs/SYNC.md#rechazos-cuarentena-y-conflictos): the order was already closed, the product was
// already voided… It is stored, but it changes nothing and its money does not count. One sentence
// per kind, in restaurant words, saying what to do (above all with the money).

/** What the hub did not apply and is not worth a notice: closing an order already closed. */
const HARMLESS: ReadonlySet<string> = new Set(['OrderClosed'])

/** Whether an unapplied event deserves a notice (and makes `recordConfirmed` fail). */
export const needsNotice = (event: Pick<NewEvent, 'type'>) => !HARMLESS.has(event.type)

/**
 * `recordConfirmed` fails with this when the hub saved the event without applying it: the screen
 * shows the message and does not take it as done (no «Pago registrado», no closing by itself).
 */
export class UnappliedError extends Error {
  override readonly name = 'UnappliedError'
}

/** What the check says after a charge the hub did not apply; the details are in the notice. */
export const NOT_CHARGED = 'No se cobró: la cuenta ya estaba cerrada. Mira el aviso de arriba.'
/** The same after voiding a payment. */
export const NOT_VOIDED =
  'No se anuló el pago: la cuenta ya estaba cerrada. Mira el aviso de arriba.'

export interface UnappliedPlace {
  catalog: Catalog | null
  /** The order as this device has it (the unapplied event changed nothing in it). */
  order: OrderState | null
  /** The hub's conflict type, when it came with the confirmation (`order_closed`…). */
  conflict?: string | null
}

/** Why it did not apply, in words (ending without a period). */
function why(conflict: string | null | undefined, order: OrderState | null): string {
  if (conflict === 'item_already_voided') return 'ya estaba anulado'
  if (conflict === 'item_not_found') return 'ese producto ya no estaba en la cuenta'
  if (conflict === 'item_already_sent') return 'ya se había enviado a cocina'
  if (conflict === 'order_closed' || order?.status === 'closed')
    return 'la cuenta ya estaba cerrada'
  if (order?.status === 'canceled') return 'el pedido ya estaba cancelado'
  return 'otro equipo cambió la cuenta antes'
}

/** «la Mesa 5», «el pedido Para llevar #12», «el pedido #12» or «el pedido». */
function orderName(order: OrderState | null, catalog: Catalog | null): string {
  if (order?.tableId) {
    const names = [order.tableId, ...order.mergedTables].map(
      (id) => catalog?.tables.find((m) => m.id === id)?.name ?? '?',
    )
    return names.includes('?') ? 'una mesa' : `la Mesa ${names.join(' + ')}`
  }
  const channel = order ? CHANNELS[order.channel as keyof typeof CHANNELS] : undefined
  const number = order?.dayNumber ? ` #${order.dayNumber}` : ''
  return channel ? `el pedido ${channel}${number}` : `el pedido${number}`
}

/** «de la Mesa 5», «del pedido #12». */
const ofOrder = (name: string) => (name.startsWith('el ') ? `del ${name.slice(3)}` : `de ${name}`)

/** What to do with food that did not reach the kitchen. */
const NOT_COOKED = 'Esa comida no fue a cocina. Reabre la cuenta y envíala otra vez.'

/** The notice for an event the hub saved without applying it. */
export function unappliedText(event: ApplicableEvent | NewEvent, place: UnappliedPlace): string {
  const { order, catalog } = place
  const rules = rulesOf(catalog)
  const name = orderName(order, catalog)
  const reason = why(place.conflict, order)
  const item = (id: string) => order?.items[id]?.name ?? 'un producto'
  switch (event.type) {
    case 'PaymentRecorded': {
      const p = event.data
      const total = p.amount + p.rounding_adjustment + p.tip
      return `El pago de ${pesos(total)} en ${methodInSentence(p.method, p.custom_method_id, rules)} ${ofOrder(name)} no se aplicó: ${reason}. Si ya recibiste ese dinero, devuélvelo al cliente. Si aún debe, reabre la cuenta y cobra otra vez.`
    }
    case 'PaymentVoided': {
      const p = order?.payments[event.data.payment_id]
      const what = p
        ? `del pago de ${pesos(p.amount + p.roundingAdjustment + p.tip)} en ${methodInSentence(p.method, p.customMethodId, rules)}`
        : 'de un pago'
      return `La anulación ${what} ${ofOrder(name)} no se aplicó: ${reason}. Si el pago sí debía anularse, reabre la cuenta y anúlalo otra vez. Si no, no entregues dinero.`
    }
    case 'RefundRecorded': {
      const r = event.data
      const p = order?.payments[r.payment_id]
      return `La devolución de ${pesos(r.sale_amount + r.tip_amount)} en ${methodInSentence(r.method, p?.customMethodId, rules)} ${ofOrder(name)} no se aplicó: ${reason}. Si ya entregaste ese dinero, explícalo al cerrar la caja. Si no lo has entregado, no lo entregues.`
    }
    case 'ItemVoided':
      return `La anulación de ${event.data.quantity} ${item(event.data.item_id)} en ${name} no se aplicó: ${reason}. No hay que hacer nada.`
    case 'ItemAdded':
      return `${event.data.quantity} ${event.data.name} no se agregó a ${name}: ${reason}. ${NOT_COOKED}`
    case 'ItemsSent':
      // Sent again (an old resend): it already went the first time.
      return place.conflict === 'item_already_sent'
        ? `Lo que enviaste a cocina desde ${name} no se envió otra vez: ${reason}. No hay que hacer nada.`
        : `Lo que enviaste a cocina desde ${name} no se aplicó: ${reason}. ${NOT_COOKED}`
    case 'OrderCanceled':
      return `La cancelación ${ofOrder(name)} no se aplicó: ${reason}.`
    case 'DiscountApplied':
      return `El descuento en ${name} no se aplicó: ${reason}.`
    case 'DiscountRemoved':
      return `Quitar el descuento en ${name} no se aplicó: ${reason}.`
    default:
      return `Un cambio en ${name} no se aplicó: ${reason}. Revisa la cuenta.`
  }
}
