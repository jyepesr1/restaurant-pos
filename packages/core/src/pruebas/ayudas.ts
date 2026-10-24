import type { EventoPedido } from '../eventos/pedido'
import { nuevoId } from '../id'
import { aplicarEvento } from '../pedido/aplicar'
import type { EstadoPedido } from '../pedido/estado'
import { enOrden, evento } from './fabrica'

/** Aplica eventos en orden y falla si alguno no se pudo aplicar. */
export function aplicarTodos(
  eventos: readonly EventoPedido[],
  inicial: EstadoPedido | null = null,
): EstadoPedido {
  return eventos.reduce<EstadoPedido | null>((estado, e) => {
    const r = aplicarEvento(estado, enOrden(e, estado?.ultimaSecuencia ?? 0))
    if (r.problema) throw new Error(`${e.tipo}: ${r.problema.tipo} (${r.problema.descripcion})`)
    return r.estado
  }, inicial) as EstadoPedido
}

/** Pedido de salón recién abierto. */
export function pedidoAbierto(pedido = nuevoId()) {
  return {
    pedido,
    estado: aplicarTodos([
      evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 2 }),
    ]),
  }
}

export const enviarItems = (pedido: string, itemIds: string[]) =>
  evento(pedido, 'ItemsEnviados', {
    comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: itemIds }],
  })

/** Tipo del problema al aplicar `e`, o undefined si se aplica. */
export const problemaDe = (estado: EstadoPedido | null, e: EventoPedido) =>
  aplicarEvento(estado, e).problema?.tipo
