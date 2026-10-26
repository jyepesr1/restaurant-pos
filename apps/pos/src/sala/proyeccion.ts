import { type OrderItem, type OrderState, orderTotals, rebuild } from '@pos/core'
import { type EventoLocal, pedidosDe } from '@pos/sync'

// Lo que muestra la pantalla de demo, calculado de los eventos guardados en el dispositivo: los
// confirmados por el hub y, encima, los propios pendientes (docs/SYNC.md#orden-y-estado-local).

export interface PedidoVisible {
  status: OrderState
  /** Neto del pedido (lo que se cobra sin propina), en pesos. */
  total: number
  /** Ítems con algo que el hub aún no confirma: agregarlos o enviarlos a cocina. */
  itemsPorConfirmar: Set<string>
  /** Algún evento del pedido sigue pendiente aquí. */
  porConfirmar: boolean
}

/** Ítems que toca un evento pendiente que la pantalla marca "sin confirmar". */
function itemsOf({ event }: EventoLocal): string[] {
  if (event.type === 'ItemAdded') return [event.data.item_id]
  if (event.type === 'ItemsSent') return event.data.tickets.flatMap((c) => c.item_ids)
  return []
}

const current = (l: EventoLocal) => l.status === 'confirmed' || l.status === 'pending'

/** Los pedidos abiertos, del más antiguo al más nuevo. */
export function pedidosAbiertos(locales: readonly EventoLocal[]): PedidoVisible[] {
  const porPedido = new Map<string, EventoLocal[]>()
  for (const l of locales) {
    if (!current(l) || l.event.aggregate_type !== 'order') continue
    // Un evento puede tocar dos pedidos: mover productos va en el origen y llega al destino.
    for (const id of pedidosDe(l.event)) porPedido.set(id, [...(porPedido.get(id) ?? []), l])
  }
  const visibles: PedidoVisible[] = []
  for (const [id, events] of porPedido) {
    const status = rebuild(
      events.map((l) => l.event),
      id,
    )
    if (status?.status !== 'open') continue
    const pendingList = events.filter((l) => l.status === 'pending')
    visibles.push({
      status,
      total: orderTotals(status).net,
      itemsPorConfirmar: new Set(pendingList.flatMap((l) => itemsOf(l))),
      porConfirmar: pendingList.length > 0,
    })
  }
  return visibles.sort((a, b) => a.status.openedAt.localeCompare(b.status.openedAt))
}

export const itemsVigentes = (status: OrderState): OrderItem[] =>
  Object.values(status.items)
    .filter((i) => i.status !== 'voided')
    .sort((a, b) => a.position - b.position)

export type EstadoMesaDemo = 'free' | 'taking' | 'ready' | 'check' | 'in_kitchen' | 'served'

/**
 * Estado de la mesa en el plano, de lo más urgente a lo menos: con algo sin enviar es «tomando»;
 * con algo listo en cocina, «listo para llevar»; con la precuenta pedida o algo pagado, «pidió la
 * cuenta» (tarea 1.6); con algo en cocina, «en preparación»; con todo entregado, «servida»
 * (ADR-015).
 */
export function estadoMesa(orders: readonly PedidoVisible[]): EstadoMesaDemo {
  const items = orders.flatMap((p) => itemsVigentes(p.status))
  if (items.length === 0) return 'free'
  if (items.some((i) => i.status === 'pending' || i.status === 'held')) return 'taking'
  if (items.some((i) => i.status === 'ready')) return 'ready'
  // Ya pidió la cuenta (precuenta) o pagó una parte (tarea 1.6): lo que sigue es cobrar.
  if (orders.some((p) => p.status.lastPreBill || orderTotals(p.status).paid > 0)) return 'check'
  if (items.some((i) => i.status !== 'served')) return 'in_kitchen'
  return 'served'
}

/** Clave de lo agotado: el producto entero, o una de sus variantes (la botella, no la copa). */
export const claveAgotado = (productId: string, variantId: string | null = null) =>
  variantId ? `${productId}:${variantId}` : productId

/** Lo vigente de los tipos pedidos: lo confirmado en el orden del hub y después lo pendiente. */
function inOrder(locales: readonly EventoLocal[], types: readonly string[]): EventoLocal[] {
  const de = locales.filter((l) => current(l) && types.includes(l.event.type))
  return [
    ...de
      .filter((l) => l.status === 'confirmed')
      .sort((a, b) => (a.event.sequence ?? 0) - (b.event.sequence ?? 0)),
    ...de.filter((l) => l.status === 'pending'),
  ]
}

/**
 * Lo agotado (86) según los eventos guardados aquí: lo confirmado en el orden del hub y, encima,
 * lo propio pendiente. Así quien lo marca lo ve al instante, aun sin conexión.
 */
export function agotados(locales: readonly EventoLocal[]): Set<string> {
  const result = new Set<string>()
  for (const { event } of inOrder(locales, ['ProductSoldOut', 'ProductAvailable'])) {
    if (event.type !== 'ProductSoldOut' && event.type !== 'ProductAvailable') continue
    const key = claveAgotado(event.data.product_id, event.data.variant_id)
    if (event.type === 'ProductSoldOut') result.add(key)
    else result.delete(key)
  }
  return result
}

/**
 * Los productos que más se han pedido en este equipo (lo que ha visto), del más al menos. Cuenta
 * las unidades que quedan en cada línea: lo sumado a una línea igual (`ItemChanged`) cuenta, lo
 * quitado o anulado no.
 */
export function masPedidos(locales: readonly EventoLocal[], cuantos = 12): string[] {
  const lines = new Map<string, { product: string; quantity: number }>()
  for (const { event: e } of inOrder(locales, [
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
    .slice(0, cuantos)
    .map(([id]) => id)
}

/**
 * Si un pedido abierto ocupa su mesa: tiene algo vigente, o no tiene nada (se acaba de abrir, o
 * el mesero quitó lo que aún no enviaba). Uno que quedó vacío al pasar todo a otra mesa, o con
 * todo anulado, ya no (tarea 1.5; el hub aplica la misma regla).
 */
export const ocupaMesa = (p: OrderState) =>
  p.status === 'open' &&
  (itemsVigentes(p).length > 0 || (Object.keys(p.items).length === 0 && !p.emptiedOnMove))
