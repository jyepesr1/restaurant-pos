import type { ReactNode } from 'react'
import { Icono, type NombreIcono } from './iconos'

// Etiqueta de estado: color con significado + ícono + texto (nunca solo el color).

export type Tono = 'libre' | 'proceso' | 'alerta' | 'accion' | 'neutro'

export const TONOS_SUAVES: Record<Tono, string> = {
  libre: 'bg-libre-suave text-libre-texto',
  proceso: 'bg-proceso-suave text-proceso-texto',
  alerta: 'bg-alerta-suave text-alerta-texto',
  accion: 'bg-accion-suave text-accion-texto',
  neutro: 'bg-neutro-suave text-neutro-texto',
}

export const TONOS_FUERTES: Record<Tono, string> = {
  libre: 'bg-libre-fuerte text-white',
  proceso: 'bg-proceso-fuerte text-white',
  alerta: 'bg-alerta-fuerte text-white',
  accion: 'bg-accion-fuerte text-white',
  neutro: 'bg-neutro-fuerte text-white',
}

export function Etiqueta({
  tono,
  icono,
  fuerte = false,
  children,
}: {
  tono: Tono
  icono?: NombreIcono
  fuerte?: boolean
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${(fuerte ? TONOS_FUERTES : TONOS_SUAVES)[tono]}`}
    >
      {icono && <Icono nombre={icono} />}
      {children}
    </span>
  )
}
