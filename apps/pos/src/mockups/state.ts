import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ConnectionState } from '../ui/ConnectionIndicator'
import { useRoute } from '../ui/route'
import { initialTables, type Table } from './data'

// Shared state of the mockups (in memory): opening a table on the floor plan and sending the order
// shows the same on the floor plan, in the kitchen and at the register. Reloading resets it.

export interface Simulation {
  connection: ConnectionState
  pendingList: number
  failingPrinters: number
}

interface State {
  tables: Table[]
  simulation: Simulation
}

const initial = (): State => ({
  tables: initialTables(),
  simulation: { connection: 'local_only', pendingList: 0, failingPrinters: 0 },
})

let status = initial()
const subscribers = new Set<() => void>()
const subscribe = (s: () => void) => {
  subscribers.add(s)
  return () => {
    subscribers.delete(s)
  }
}
const patch = (fresh: State) => {
  status = fresh
  for (const s of subscribers) s()
}

export const useTables = (): Table[] => useSyncExternalStore(subscribe, () => status.tables)
export const useSimulation = (): Simulation =>
  useSyncExternalStore(subscribe, () => status.simulation)

export function changeTable(number: number, change: (table: Table) => Table) {
  patch({ ...status, tables: status.tables.map((m) => (m.number === number ? change(m) : m)) })
}

export function simulate(changes: Partial<Simulation>) {
  patch({ ...status, simulation: { ...status.simulation, ...changes } })
}

export const resetMockups = () => patch(initial())

/** The table number from the address (`?table=12`), or the default value. */
export function useRouteTable(defaultValue: number): number {
  const n = Number(useRoute().params.get('table'))
  return Number.isInteger(n) && n >= 1 && n <= 25 ? n : defaultValue
}

/** The time, for table and ticket timers: a single source for all screens. */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}
