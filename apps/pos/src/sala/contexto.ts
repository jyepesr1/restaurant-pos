import { useEffect, useState, useSyncExternalStore } from 'react'
import { type Instantanea, Sala } from './motor'
import { type PedidoVisible, pedidosAbiertos } from './proyeccion'

// Una sola sala por pestaña: la abre la app al arrancar y la comparten todas las pantallas.

export const sala = new Sala()

export function useSala(): Instantanea {
  return useSyncExternalStore(sala.suscribir, sala.instantanea)
}

/** Los pedidos abiertos según lo guardado aquí; se relee cada vez que algo cambia. */
export function usePedidos(): PedidoVisible[] | null {
  const { cambios } = useSala()
  const [pedidos, setPedidos] = useState<PedidoVisible[] | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cambios` avisa que hay que releer
  useEffect(() => {
    let vigente = true
    sala.sync
      ?.locales()
      .then((locales) => vigente && setPedidos(pedidosAbiertos(locales)))
      .catch((error) => console.error('No se pudieron leer los pedidos:', error))
    return () => {
      vigente = false
    }
  }, [cambios])
  return pedidos
}
