import type { ShiftReconciliation } from '@pos/core'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { type ComandaEnCocina, comandasEnCocina } from './comandas'
import { cuadreDeCaja, type TurnoVisible, turnoDeCaja } from './cuentas'
import { type Instantanea, Sala } from './motor'
import { agotados, masPedidos, type PedidoVisible, pedidosAbiertos } from './proyeccion'

// Una sola sala por pestaña: la abre la app al arrancar y la comparten todas las pantallas.

export const floor = new Sala()

export function useSala(): Instantanea {
  return useSyncExternalStore(floor.suscribir, floor.instantanea)
}

export interface VistaLocal {
  orders: PedidoVisible[]
  /** Productos (o variantes) agotados: claves de `claveAgotado`. */
  agotados: Set<string>
  /** Ids de los productos más pedidos. */
  masPedidos: string[]
  /** Lo enviado a cocina que falta entregar, de lo más viejo a lo más nuevo (ADR-015). */
  tickets: ComandaEnCocina[]
  /** El turno abierto de la caja de este equipo, si tiene (tarea 1.6). */
  shift: TurnoVisible | null
  /** El cuadre de ese turno: lo cobrado por medio, los movimientos, los conteos y lo esperado. */
  reconciliation: ShiftReconciliation | null
}

/** Lo que sale de los eventos guardados aquí; se relee cada vez que algo cambia. */
export function useVistaLocal(): VistaLocal | null {
  const { changes, device: deEquipo } = useSala()
  const device = deEquipo?.deviceId ?? null
  const [vista, setVista] = useState<VistaLocal | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cambios` avisa que hay que releer
  useEffect(() => {
    let current = true
    floor.sync
      ?.locals()
      .then((locals) => {
        if (!current) return
        const orders = pedidosAbiertos(locals)
        const shift = device ? turnoDeCaja(locals, device) : null
        setVista({
          orders,
          agotados: agotados(locals),
          masPedidos: masPedidos(locals),
          tickets: comandasEnCocina(locals, orders),
          shift,
          reconciliation: shift ? cuadreDeCaja(locals, shift.id) : null,
        })
      })
      .catch((error) => console.error('No se pudieron leer los pedidos:', error))
    return () => {
      current = false
    }
  }, [changes, device])
  return vista
}

/** Los pedidos abiertos según lo guardado aquí. */
export function usePedidos(): PedidoVisible[] | null {
  return useVistaLocal()?.orders ?? null
}
