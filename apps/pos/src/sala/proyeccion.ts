import { type EstadoPedido, type ItemPedido, reconstruir, totalesPedido } from '@pos/core'
import type { EventoLocal } from '@pos/sync'

// Lo que muestra la pantalla de demo, calculado de los eventos guardados en el dispositivo: los
// confirmados por el hub y, encima, los propios pendientes (docs/SYNC.md#orden-y-estado-local).

export interface PedidoVisible {
  estado: EstadoPedido
  /** Neto del pedido (lo que se cobra sin propina), en pesos. */
  total: number
  /** Ítems con algo que el hub aún no confirma: agregarlos o enviarlos a cocina. */
  itemsPorConfirmar: Set<string>
  /** Algún evento del pedido sigue pendiente aquí. */
  porConfirmar: boolean
}

/** Ítems que toca un evento pendiente que la pantalla marca "sin confirmar". */
function itemsDe({ evento }: EventoLocal): string[] {
  if (evento.tipo === 'ItemAgregado') return [evento.datos.item_id]
  if (evento.tipo === 'ItemsEnviados') return evento.datos.comandas.flatMap((c) => c.item_ids)
  return []
}

const vigente = (l: EventoLocal) => l.estado === 'confirmado' || l.estado === 'pendiente'

/** Los pedidos abiertos, del más antiguo al más nuevo. */
export function pedidosAbiertos(locales: readonly EventoLocal[]): PedidoVisible[] {
  const porPedido = new Map<string, EventoLocal[]>()
  for (const l of locales) {
    if (!vigente(l)) continue
    const id = l.evento.agregado_id
    porPedido.set(id, [...(porPedido.get(id) ?? []), l])
  }
  const visibles: PedidoVisible[] = []
  for (const [id, eventos] of porPedido) {
    const estado = reconstruir(
      eventos.map((l) => l.evento),
      id,
    )
    if (estado?.estado !== 'abierto') continue
    const pendientes = eventos.filter((l) => l.estado === 'pendiente')
    visibles.push({
      estado,
      total: totalesPedido(estado).neto,
      itemsPorConfirmar: new Set(pendientes.flatMap((l) => itemsDe(l))),
      porConfirmar: pendientes.length > 0,
    })
  }
  return visibles.sort((a, b) => a.estado.abiertoEn.localeCompare(b.estado.abiertoEn))
}

export const itemsVigentes = (estado: EstadoPedido): ItemPedido[] =>
  Object.values(estado.items)
    .filter((i) => i.estado !== 'anulado')
    .sort((a, b) => a.orden - b.orden)

export type EstadoMesaDemo = 'libre' | 'tomando' | 'en_cocina'

/** Estado de la mesa en el plano: con algo sin enviar es "tomando"; todo enviado, "en cocina". */
export function estadoMesa(pedidos: readonly PedidoVisible[]): EstadoMesaDemo {
  const items = pedidos.flatMap((p) => itemsVigentes(p.estado))
  if (items.length === 0) return 'libre'
  return items.some((i) => i.estado === 'pendiente' || i.estado === 'retenido')
    ? 'tomando'
    : 'en_cocina'
}
