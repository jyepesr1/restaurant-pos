import type { Alert, AlertOrder, AlertType, PaymentMethod } from '@pos/core'
import { type CheckoutRules, methodName } from '../floor/checks'
import { CHANNELS } from '../floor/order'
import { pointsAsPercent } from '../floor/periods'
import { pesos } from '../ui/format'
import type { IconName } from '../ui/icons'
import type { Tone } from '../ui/Label'

// How the panel tells each alert to the owner, without drawing it (task 1.11c-2): one sentence with
// who, what, how much and where («Ana anuló 1 Pinsa ($20.900) en la Mesa 3»), and the details
// apart (who authorized it, the reason).

/**
 * How each kind of alert is shown: its name in the filters, the label on each row, its icon and its
 * color. The rule is simple and goes in a legend on the screen: red for what took money away or
 * left the register off (voids, cancellations, voided payments, refunds, variances); amber for
 * what is worth a look but may be fine (discounts and courtesies, reopened accounts).
 */
export const ALERT_KINDS: Record<
  AlertType,
  { name: string; one: string; icon: IconName; tone: Tone }
> = {
  item_voided: { name: 'Productos anulados', one: 'Anulación', icon: 'erase', tone: 'warning' },
  order_canceled: {
    name: 'Pedidos cancelados',
    one: 'Cancelación',
    icon: 'close',
    tone: 'warning',
  },
  discount: {
    name: 'Descuentos y cortesías',
    one: 'Descuento',
    icon: 'receipt',
    tone: 'progress',
  },
  payment_voided: { name: 'Pagos anulados', one: 'Pago anulado', icon: 'card', tone: 'warning' },
  refund: { name: 'Devoluciones', one: 'Devolución', icon: 'undo', tone: 'warning' },
  order_reopened: {
    name: 'Cuentas reabiertas',
    one: 'Cuenta reabierta',
    icon: 'orders',
    tone: 'progress',
  },
  register_variance: {
    name: 'Descuadres de caja',
    one: 'Descuadre',
    icon: 'bill',
    tone: 'warning',
  },
}

/** The legend of the colors, as the screen shows it. */
export const ALERT_LEGEND = {
  warning: 'Rojo: salió dinero o la caja no cuadró',
  progress: 'Ámbar: para revisar',
} as const

/** The label of one row: a courtesy is not called a discount. */
export const kindLabel = (a: Alert) =>
  a.type === 'discount' && a.rule === 'comp' ? 'Cortesía' : ALERT_KINDS[a.type].one

/** What the sentences need to name people, tables and payment methods. */
export interface AlertPlace {
  users: Record<string, string>
  tables: Record<string, string>
  rules: CheckoutRules | null
  /** «9:41 p. m.» in the restaurant's time zone. */
  time: (iso: string) => string
}

export interface AlertText {
  /** «Ana anuló 1 Pinsa ($20.900) en la Mesa 3». */
  sentence: string
  /** «autorizó Carlos», «Motivo: Se quemó»… */
  details: string[]
}

/**
 * «la Mesa 3», «el pedido Para llevar #12», «el pedido #12», «un pedido sin mesa», «una mesa que ya
 * no está en el plano» or «un pedido» (when even the order is not known).
 */
function orderName(o: AlertOrder | null, tables: Record<string, string>): string {
  if (o?.tableId) {
    const table = tables[o.tableId]
    return table ? `la Mesa ${table}` : 'una mesa que ya no está en el plano'
  }
  const channel = o?.channel && o.channel !== 'dine_in' ? CHANNELS[o.channel] : null
  if (channel) return `el pedido ${channel}${o?.number ? ` #${o.number}` : ''}`
  if (o?.number) return `el pedido #${o.number}`
  return o ? 'un pedido sin mesa' : 'un pedido'
}

/** «en la Mesa 3», «en el pedido Para llevar #12». */
const inOrder = (o: AlertOrder | null, tables: Record<string, string>) =>
  `en ${orderName(o, tables)}`

/** «de la Mesa 3», «del pedido #12», «de un pedido sin mesa». */
function ofOrder(o: AlertOrder | null, tables: Record<string, string>): string {
  const name = orderName(o, tables)
  return name.startsWith('el ') ? `del ${name.slice(3)}` : `de ${name}`
}

const units = (n: number, name: string) => `${n} ${name}`

/** «+$50» or «-$50». */
const signed = (n: number) => `${n > 0 ? '+' : '-'}${pesos(Math.abs(n))}`

/** Common nouns go in lowercase inside a sentence («en efectivo»); names stay («en Nequi»). */
const COMMON_NOUNS = new Set(['cash', 'card', 'transfer', 'voucher'])
const methodInSentence = (
  method: PaymentMethod,
  customMethodId: string | null,
  rules: CheckoutRules | null,
) => {
  const name = methodName(method, customMethodId, rules)
  return COMMON_NOUNS.has(method) ? name.toLowerCase() : name
}

export function alertText(a: Alert, place: AlertPlace): AlertText {
  const who = (id: string) => place.users[id] ?? 'Alguien'
  const where = inOrder(a.order, place.tables)
  const details: string[] = []
  if (a.authorizedById && a.authorizedById !== a.userId)
    details.push(`autorizó ${who(a.authorizedById)}`)
  const sentence = ((): string => {
    switch (a.type) {
      case 'item_voided':
        if (a.alreadyPrepared) details.push('ya estaba preparado')
        return `${who(a.userId)} anuló ${units(a.units, a.name)} (${pesos(a.value)}) ${where}`
      case 'order_canceled': {
        const name = orderName(a.order, place.tables)
        const of = a.order?.tableId ? `el pedido de ${name}` : name
        return `${who(a.userId)} canceló ${of} (${pesos(a.value)})`
      }
      case 'discount': {
        // That it was removed goes in the sentence: it no longer takes anything away.
        const removed = a.removedAt
          ? ` (${a.rule === 'comp' ? 'quitada' : 'quitado'} a las ${place.time(a.removedAt)})`
          : ''
        if (a.removedAt && a.removedBy) details.push(`lo quitó ${who(a.removedBy)}`)
        const items = a.items.join(', ')
        if (a.rule === 'comp')
          return `${who(a.userId)} dio de cortesía ${units(a.units ?? 1, items)} (${pesos(a.value)}) ${where}${removed}`
        const to = a.scope === 'item' ? ` a ${items}` : ''
        return a.rule === 'percent' && a.basisPoints !== null
          ? `${who(a.userId)} hizo un descuento del ${pointsAsPercent(a.basisPoints)}${to} (${pesos(a.value)}) ${where}${removed}`
          : `${who(a.userId)} hizo un descuento de ${pesos(a.value)}${to} ${where}${removed}`
      }
      case 'payment_voided': {
        const method = a.method
          ? ` en ${methodInSentence(a.method, a.customMethodId, place.rules)}`
          : ''
        if (a.tip !== null && a.tip > 0) details.push(`incluye ${pesos(a.tip)} de propina`)
        if (a.roundingAdjustment !== null && a.roundingAdjustment !== 0)
          details.push(`incluye ${signed(a.roundingAdjustment)} de redondeo del efectivo`)
        const amount = a.value === null ? 'monto no disponible' : pesos(a.value)
        return `${who(a.userId)} anuló un pago${method} (${amount}) ${where}`
      }
      case 'refund':
        if (a.tip > 0) details.push(`incluye ${pesos(a.tip)} de propina`)
        return `${who(a.userId)} devolvió ${pesos(a.value)} en ${methodInSentence(a.method, a.customMethodId, place.rules)} ${ofOrder(a.order, place.tables)}`
      case 'order_reopened': {
        const name = orderName(a.order, place.tables)
        const of = a.order?.tableId ? `la cuenta de ${name}` : name
        return a.value === null
          ? `${who(a.userId)} reabrió ${of} (monto no disponible)`
          : `${who(a.userId)} reabrió ${of}, que había cerrado en ${pesos(a.value)}`
      }
      case 'register_variance': {
        const method = methodInSentence(a.method, a.customMethodId, place.rules)
        details.push(`cerró ${who(a.userId)}`)
        details.push(
          a.method === 'cash'
            ? `debería haber ${pesos(a.expected)} · contado ${pesos(a.counted)}`
            : `según el sistema ${pesos(a.expected)} · según su cierre ${pesos(a.counted)}`,
        )
        return `En la caja de ${who(a.openedBy)} ${a.value < 0 ? 'faltaron' : 'sobraron'} ${pesos(Math.abs(a.value))} en ${method}`
      }
    }
  })()
  if (a.reason)
    details.push(`${a.type === 'register_variance' ? 'Justificación' : 'Motivo'}: ${a.reason}`)
  return { sentence, details }
}
