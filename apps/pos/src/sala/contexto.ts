import { useEffect, useState, useSyncExternalStore } from 'react'
import { type ComandaEnCocina, comandasEnCocina } from './comandas'
import { type Instantanea, Sala } from './motor'
import { agotados, masPedidos, type PedidoVisible, pedidosAbiertos } from './proyeccion'

// Una sola sala por pestaña: la abre la app al arrancar y la comparten todas las pantallas.

export const sala = new Sala()

export function useSala(): Instantanea {
  return useSyncExternalStore(sala.suscribir, sala.instantanea)
}

export interface VistaLocal {
  pedidos: PedidoVisible[]
  /** Productos (o variantes) agotados: claves de `claveAgotado`. */
  agotados: Set<string>
  /** Ids de los productos más pedidos. */
  masPedidos: string[]
  /** Lo enviado a cocina que falta entregar, de lo más viejo a lo más nuevo (ADR-015). */
  comandas: ComandaEnCocina[]
}

/** Lo que sale de los eventos guardados aquí; se relee cada vez que algo cambia. */
export function useVistaLocal(): VistaLocal | null {
  const { cambios } = useSala()
  const [vista, setVista] = useState<VistaLocal | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cambios` avisa que hay que releer
  useEffect(() => {
    let vigente = true
    sala.sync
      ?.locales()
      .then((locales) => {
        if (!vigente) return
        const pedidos = pedidosAbiertos(locales)
        setVista({
          pedidos,
          agotados: agotados(locales),
          masPedidos: masPedidos(locales),
          comandas: comandasEnCocina(locales, pedidos),
        })
      })
      .catch((error) => console.error('No se pudieron leer los pedidos:', error))
    return () => {
      vigente = false
    }
  }, [cambios])
  return vista
}

/** Los pedidos abiertos según lo guardado aquí. */
export function usePedidos(): PedidoVisible[] | null {
  return useVistaLocal()?.pedidos ?? null
}
