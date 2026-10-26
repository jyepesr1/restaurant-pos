import type { ReactNode } from 'react'
import { Icono, type NombreIcono } from './iconos'

// Etiqueta de estado: color con significado + ícono + texto (nunca solo el color).

export type Tono = 'free' | 'progress' | 'warning' | 'action' | 'neutral'

export const TONOS_SUAVES: Record<Tono, string> = {
  free: 'bg-libre-suave text-libre-texto',
  progress: 'bg-proceso-suave text-proceso-texto',
  warning: 'bg-alerta-suave text-alerta-texto',
  action: 'bg-accion-suave text-accion-texto',
  neutral: 'bg-neutro-suave text-neutro-texto',
}

export const TONOS_FUERTES: Record<Tono, string> = {
  free: 'bg-libre-fuerte text-white',
  progress: 'bg-proceso-fuerte text-white',
  warning: 'bg-alerta-fuerte text-white',
  action: 'bg-accion-fuerte text-white',
  neutral: 'bg-neutro-fuerte text-white',
}

export function Etiqueta({
  tono,
  icono,
  main = false,
  children,
}: {
  tono: Tono
  icono?: NombreIcono
  main?: boolean
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${(main ? TONOS_FUERTES : TONOS_SUAVES)[tono]}`}
    >
      {icono && <Icono name={icono} />}
      {children}
    </span>
  )
}
