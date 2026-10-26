import { type EstadoPedido, type ItemPedido, reconstruir, totalesPedido } from '@pos/core'
import { type EventoLocal, pedidosDe } from '@pos/sync'

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
    if (!vigente(l) || l.evento.agregado_tipo !== 'pedido') continue
    // Un evento puede tocar dos pedidos: mover productos va en el origen y llega al destino.
    for (const id of pedidosDe(l.evento)) porPedido.set(id, [...(porPedido.get(id) ?? []), l])
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

export type EstadoMesaDemo = 'libre' | 'tomando' | 'listo' | 'en_cocina' | 'servida'

/**
 * Estado de la mesa en el plano, de lo más urgente a lo menos: con algo sin enviar es «tomando»;
 * con algo listo en cocina, «listo para llevar»; con algo en cocina, «en preparación»; con todo
 * entregado, «servida» (ADR-015).
 */
export function estadoMesa(pedidos: readonly PedidoVisible[]): EstadoMesaDemo {
  const items = pedidos.flatMap((p) => itemsVigentes(p.estado))
  if (items.length === 0) return 'libre'
  if (items.some((i) => i.estado === 'pendiente' || i.estado === 'retenido')) return 'tomando'
  if (items.some((i) => i.estado === 'listo')) return 'listo'
  if (items.some((i) => i.estado !== 'entregado')) return 'en_cocina'
  return 'servida'
}

/** Clave de lo agotado: el producto entero, o una de sus variantes (la botella, no la copa). */
export const claveAgotado = (productoId: string, varianteId: string | null = null) =>
  varianteId ? `${productoId}:${varianteId}` : productoId

/** Lo vigente de los tipos pedidos: lo confirmado en el orden del hub y después lo pendiente. */
function enOrden(locales: readonly EventoLocal[], tipos: readonly string[]): EventoLocal[] {
  const de = locales.filter((l) => vigente(l) && tipos.includes(l.evento.tipo))
  return [
    ...de
      .filter((l) => l.estado === 'confirmado')
      .sort((a, b) => (a.evento.secuencia ?? 0) - (b.evento.secuencia ?? 0)),
    ...de.filter((l) => l.estado === 'pendiente'),
  ]
}

/**
 * Lo agotado (86) según los eventos guardados aquí: lo confirmado en el orden del hub y, encima,
 * lo propio pendiente. Así quien lo marca lo ve al instante, aun sin conexión.
 */
export function agotados(locales: readonly EventoLocal[]): Set<string> {
  const resultado = new Set<string>()
  for (const { evento } of enOrden(locales, ['ProductoAgotado', 'ProductoDisponible'])) {
    if (evento.tipo !== 'ProductoAgotado' && evento.tipo !== 'ProductoDisponible') continue
    const clave = claveAgotado(evento.datos.producto_id, evento.datos.variante_id)
    if (evento.tipo === 'ProductoAgotado') resultado.add(clave)
    else resultado.delete(clave)
  }
  return resultado
}

/**
 * Los productos que más se han pedido en este equipo (lo que ha visto), del más al menos. Cuenta
 * las unidades que quedan en cada línea: lo sumado a una línea igual (`ItemCambiado`) cuenta, lo
 * quitado o anulado no.
 */
export function masPedidos(locales: readonly EventoLocal[], cuantos = 12): string[] {
  const lineas = new Map<string, { producto: string; cantidad: number }>()
  for (const { evento: e } of enOrden(locales, [
    'ItemAgregado',
    'ItemCambiado',
    'ItemQuitado',
    'ItemAnulado',
  ])) {
    if (e.tipo === 'ItemAgregado') {
      lineas.set(e.datos.item_id, { producto: e.datos.producto_id, cantidad: e.datos.cantidad })
    } else if (e.tipo === 'ItemCambiado' || e.tipo === 'ItemQuitado' || e.tipo === 'ItemAnulado') {
      const linea = lineas.get(e.datos.item_id)
      if (!linea) continue
      if (e.tipo === 'ItemQuitado') linea.cantidad = 0
      else if (e.tipo === 'ItemAnulado')
        linea.cantidad = Math.max(0, linea.cantidad - e.datos.cantidad)
      else if (e.datos.cantidad !== undefined) linea.cantidad = e.datos.cantidad
    }
  }
  const conteo = new Map<string, number>()
  for (const { producto, cantidad } of lineas.values())
    if (cantidad > 0) conteo.set(producto, (conteo.get(producto) ?? 0) + cantidad)
  return [...conteo]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cuantos)
    .map(([id]) => id)
}

/**
 * Si un pedido abierto ocupa su mesa: tiene algo vigente, o no tiene nada (se acaba de abrir, o
 * el mesero quitó lo que aún no enviaba). Uno que quedó vacío al pasar todo a otra mesa, o con
 * todo anulado, ya no (tarea 1.5; el hub aplica la misma regla).
 */
export const ocupaMesa = (p: EstadoPedido) =>
  p.estado === 'abierto' &&
  (itemsVigentes(p).length > 0 || (Object.keys(p.items).length === 0 && !p.vaciadoAlMover))
