import type { ShiftReconciliation } from '@pos/core'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { registerReconciliation, shiftOfRegister, type VisibleShift } from './checks'
import { Floor, type Snapshot } from './engine'
import { moreOrders, openOrders, soldOutIds, type VisibleOrder } from './projection'
import { type KitchenTicket, kitchenTickets } from './tickets'

// A single floor per tab: the app opens it at startup and every screen shares it.

export const floor = new Floor()

export function useFloor(): Snapshot {
  return useSyncExternalStore(floor.subscribe, floor.snapshot)
}

export interface LocalView {
  orders: VisibleOrder[]
  /** Sold-out products (or variants): `soldOutKey` keys. */
  soldOutIds: Set<string>
  /** Ids of the most ordered products. */
  moreOrders: string[]
  /** What was sent to the kitchen and is still to be delivered, oldest to newest (ADR-015). */
  tickets: KitchenTicket[]
  /** The open shift of this device's register, if any (task 1.6). */
  shift: VisibleShift | null
  /** That shift's reconciliation: what was charged per method, movements, counts and expected. */
  reconciliation: ShiftReconciliation | null
}

/** What comes out of the events saved here; it is reread every time something changes. */
export function useLocalView(): LocalView | null {
  const { changes, device: floorDevice } = useFloor()
  const device = floorDevice?.deviceId ?? null
  const [view, setView] = useState<LocalView | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `changes` signals a reread is needed
  useEffect(() => {
    let current = true
    floor.sync
      ?.locals()
      .then((locals) => {
        if (!current) return
        const orders = openOrders(locals)
        const shift = device ? shiftOfRegister(locals, device) : null
        setView({
          orders,
          soldOutIds: soldOutIds(locals),
          moreOrders: moreOrders(locals),
          tickets: kitchenTickets(locals, orders),
          shift,
          reconciliation: shift ? registerReconciliation(locals, shift.id) : null,
        })
      })
      .catch((error) => console.error('No se pudieron leer los pedidos:', error))
    return () => {
      current = false
    }
  }, [changes, device])
  return view
}

/** The open orders according to what is saved here. */
export function useOrders(): VisibleOrder[] | null {
  return useLocalView()?.orders ?? null
}
