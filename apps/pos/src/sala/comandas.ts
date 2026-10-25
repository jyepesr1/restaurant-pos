import type { ItemPedido } from '@pos/core'
import type { EventoLocal } from '@pos/sync'
import type { PedidoVisible } from './proyeccion'

// Lo que está en cocina (ADR-015), calculado de los eventos guardados en el equipo: cada comanda
// enviada con lo que falta entregar. Lo ven la pantalla de cocina y «Pedidos en cocina» en la
// caja. Una comanda sale de aquí cuando el mesero entrega todo lo suyo (o se anula).

export interface ComandaEnCocina {
  comandaId: string
  pedido: PedidoVisible
  estacionId: string
  /** Número del día que dio el hub; mientras no lo confirma, nada. */
  numero: number | null
  /** Desde cuándo está en cocina: cuando la recibió el hub (o se envió, si aún no llega). */
  enviadaEn: string
  /** Lo que falta entregar de esta comanda. */
  items: ItemPedido[]
  /** Todo lo que falta ya está listo para llevar a la mesa. */
  lista: boolean
}

const EN_COCINA = new Set(['enviado', 'en_preparacion', 'listo'])
const vigente = (l: EventoLocal) => l.estado === 'confirmado' || l.estado === 'pendiente'

export function comandasEnCocina(
  locales: readonly EventoLocal[],
  pedidos: readonly PedidoVisible[],
): ComandaEnCocina[] {
  const porId = new Map(pedidos.map((p) => [p.estado.id, p]))
  const comandas: ComandaEnCocina[] = []
  for (const l of locales) {
    if (!vigente(l) || l.evento.tipo !== 'ItemsEnviados') continue
    const pedido = porId.get(l.evento.agregado_id)
    if (!pedido) continue
    const numeros = l.evento.asignaciones?.numeros_comanda
    for (const c of l.evento.datos.comandas) {
      const items = c.item_ids
        .map((id) => pedido.estado.items[id])
        .filter(
          (i): i is ItemPedido => !!i && EN_COCINA.has(i.estado) && i.cantidad > i.cantidadAnulada,
        )
      if (items.length === 0) continue
      comandas.push({
        comandaId: c.comanda_id,
        pedido,
        estacionId: c.estacion_id,
        numero: numeros?.[c.comanda_id] ?? null,
        enviadaEn: l.evento.recibido_en ?? l.evento.hora_estimada_hub,
        items: items.sort((a, b) => a.orden - b.orden),
        lista: items.every((i) => i.estado === 'listo'),
      })
    }
  }
  return comandas.sort((a, b) => a.enviadaEn.localeCompare(b.enviadaEn))
}

export type Demora = 'a_tiempo' | 'demorada' | 'muy_demorada'

/** Cómo va de tiempo: ámbar desde `amarillo` minutos y rojo desde `rojo` (config del local). */
export function demora(
  enviadaEn: string,
  ahora: number,
  { amarillo, rojo }: { amarillo: number; rojo: number },
): Demora {
  const minutos = (ahora - Date.parse(enviadaEn)) / 60_000
  if (minutos >= rojo) return 'muy_demorada'
  if (minutos >= amarillo) return 'demorada'
  return 'a_tiempo'
}

/** Tiempos del local, o los de fábrica si el hub es de antes de la 1.4. */
export const tiemposDe = (restaurante: { cocinaAmarilloMin?: number; cocinaRojoMin?: number }) => ({
  amarillo: restaurante.cocinaAmarilloMin ?? 10,
  rojo: restaurante.cocinaRojoMin ?? 20,
})
