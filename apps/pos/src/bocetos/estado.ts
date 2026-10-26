import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ConnectionState } from '../ui/IndicadorConexion'
import { useRuta } from '../ui/ruta'
import { type Mesa, mesasIniciales } from './datos'

// Estado compartido de los bocetos (en memoria): abrir una mesa en el plano y enviar el pedido se
// ve igual en el plano, en cocina y en la caja. Recargar la página lo reinicia.

export interface Simulacion {
  connection: ConnectionState
  pendingList: number
  impresorasConFalla: number
}

interface Estado {
  tables: Mesa[]
  simulacion: Simulacion
}

const initial = (): Estado => ({
  tables: mesasIniciales(),
  simulacion: { connection: 'local_only', pendingList: 0, impresorasConFalla: 0 },
})

let status = initial()
const suscritos = new Set<() => void>()
const suscribir = (s: () => void) => {
  suscritos.add(s)
  return () => {
    suscritos.delete(s)
  }
}
const patch = (fresh: Estado) => {
  status = fresh
  for (const s of suscritos) s()
}

export const useMesas = (): Mesa[] => useSyncExternalStore(suscribir, () => status.tables)
export const useSimulacion = (): Simulacion =>
  useSyncExternalStore(suscribir, () => status.simulacion)

export function cambiarMesa(number: number, change: (table: Mesa) => Mesa) {
  patch({ ...status, tables: status.tables.map((m) => (m.number === number ? change(m) : m)) })
}

export function simular(changes: Partial<Simulacion>) {
  patch({ ...status, simulacion: { ...status.simulacion, ...changes } })
}

export const reiniciarBocetos = () => patch(initial())

/** El número de mesa de la dirección (`?mesa=12`), o el valor por defecto. */
export function useMesaDeLaRuta(porDefecto: number): number {
  const n = Number(useRuta().params.get('table'))
  return Number.isInteger(n) && n >= 1 && n <= 25 ? n : porDefecto
}

/** La hora, para los tiempos de mesas y comandas: una sola fuente para todas las pantallas. */
export function useAhora(cadaMs = 15_000): number {
  const [now, setAhora] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), cadaMs)
    return () => clearInterval(t)
  }, [cadaMs])
  return now
}
