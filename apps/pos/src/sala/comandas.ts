import type { OrderItem } from '@pos/core'
import type { EventoLocal } from '@pos/sync'
import type { PedidoVisible } from './proyeccion'

// Lo que está en cocina (ADR-015), calculado de los eventos guardados en el equipo: cada comanda
// enviada con lo que falta entregar. Lo ven la pantalla de cocina y «Pedidos en cocina» en la
// caja. Una comanda sale de aquí cuando el mesero entrega todo lo suyo (o se anula).

export interface ComandaEnCocina {
  /** Única por tarjeta: una comanda cuyos platos se repartieron en dos mesas da dos tarjetas. */
  key: string
  comandaId: string
  order: PedidoVisible
  estacionId: string
  /** Número del día que dio el hub; mientras no lo confirma, nada. */
  number: number | null
  /** Desde cuándo está en cocina: cuando la recibió el hub (o se envió, si aún no llega). */
  enviadaEn: string
  /** Lo que falta entregar de esta comanda. */
  items: OrderItem[]
  /** Todo lo que falta ya está listo para llevar a la mesa. */
  list: boolean
}

const EN_COCINA = new Set(['sent', 'in_preparation', 'ready'])
const current = (l: EventoLocal) => l.status === 'confirmed' || l.status === 'pending'

export function comandasEnCocina(
  locales: readonly EventoLocal[],
  orders: readonly PedidoVisible[],
): ComandaEnCocina[] {
  // Cada plato está en el pedido que lo tiene ahora: si se pasó a otra mesa, la comanda sigue
  // siendo la de su envío, pero la tarjeta muestra la mesa nueva.
  const dondeEsta = new Map<string, PedidoVisible>()
  for (const p of orders) for (const id of Object.keys(p.status.items)) dondeEsta.set(id, p)
  const tickets: ComandaEnCocina[] = []
  for (const l of locales) {
    if (!current(l) || l.event.type !== 'ItemsSent') continue
    const numeros = l.event.assignments?.ticket_numbers
    for (const c of l.event.data.tickets) {
      const porPedido = new Map<PedidoVisible, OrderItem[]>()
      for (const id of c.item_ids) {
        const order = dondeEsta.get(id)
        const i = order?.status.items[id]
        if (!order || !i || !EN_COCINA.has(i.status) || i.quantity <= i.voidedQuantity) continue
        porPedido.set(order, [...(porPedido.get(order) ?? []), i])
      }
      for (const [order, items] of porPedido)
        tickets.push({
          key: `${c.ticket_id}:${order.status.id}`,
          comandaId: c.ticket_id,
          order,
          estacionId: c.station_id,
          number: numeros?.[c.ticket_id] ?? null,
          enviadaEn: l.event.received_at ?? l.event.hub_estimated_time,
          items: items.sort((a, b) => a.position - b.position),
          list: items.every((i) => i.status === 'ready'),
        })
    }
  }
  return tickets.sort((a, b) => a.enviadaEn.localeCompare(b.enviadaEn))
}

export type Demora = 'on_time' | 'late' | 'very_late'

/** Cómo va de tiempo: ámbar desde `amarillo` minutos y rojo desde `rojo` (config del local). */
export function demora(
  enviadaEn: string,
  ahora: number,
  { amarillo, rojo }: { amarillo: number; rojo: number },
): Demora {
  const minutos = (ahora - Date.parse(enviadaEn)) / 60_000
  if (minutos >= rojo) return 'very_late'
  if (minutos >= amarillo) return 'late'
  return 'on_time'
}

/** Tiempos del local, o los de fábrica si el hub es de antes de la 1.4. */
export const tiemposDe = (restaurant: { cocinaAmarilloMin?: number; cocinaRojoMin?: number }) => ({
  amarillo: restaurant.cocinaAmarilloMin ?? 10,
  rojo: restaurant.cocinaRojoMin ?? 20,
})
