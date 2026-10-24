import { useEffect, useState, useSyncExternalStore } from 'react'
import type { EstadoConexion } from '../ui/IndicadorConexion'
import { useRuta } from '../ui/ruta'
import { type Mesa, mesasIniciales } from './datos'

// Estado compartido de los bocetos (en memoria): abrir una mesa en el plano y enviar el pedido se
// ve igual en el plano, en cocina y en la caja. Recargar la página lo reinicia.

export interface Simulacion {
  conexion: EstadoConexion
  pendientes: number
  impresorasConFalla: number
}

interface Estado {
  mesas: Mesa[]
  simulacion: Simulacion
}

const inicial = (): Estado => ({
  mesas: mesasIniciales(),
  simulacion: { conexion: 'solo_local', pendientes: 0, impresorasConFalla: 0 },
})

let estado = inicial()
const suscritos = new Set<() => void>()
const suscribir = (s: () => void) => {
  suscritos.add(s)
  return () => {
    suscritos.delete(s)
  }
}
const cambiar = (nuevo: Estado) => {
  estado = nuevo
  for (const s of suscritos) s()
}

export const useMesas = (): Mesa[] => useSyncExternalStore(suscribir, () => estado.mesas)
export const useSimulacion = (): Simulacion =>
  useSyncExternalStore(suscribir, () => estado.simulacion)

export function cambiarMesa(numero: number, cambio: (mesa: Mesa) => Mesa) {
  cambiar({ ...estado, mesas: estado.mesas.map((m) => (m.numero === numero ? cambio(m) : m)) })
}

export function simular(cambios: Partial<Simulacion>) {
  cambiar({ ...estado, simulacion: { ...estado.simulacion, ...cambios } })
}

export const reiniciarBocetos = () => cambiar(inicial())

/** El número de mesa de la dirección (`?mesa=12`), o el valor por defecto. */
export function useMesaDeLaRuta(porDefecto: number): number {
  const n = Number(useRuta().parametros.get('mesa'))
  return Number.isInteger(n) && n >= 1 && n <= 25 ? n : porDefecto
}

/** La hora, para los tiempos de mesas y comandas: una sola fuente para todas las pantallas. */
export function useAhora(cadaMs = 15_000): number {
  const [ahora, setAhora] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), cadaMs)
    return () => clearInterval(t)
  }, [cadaMs])
  return ahora
}
