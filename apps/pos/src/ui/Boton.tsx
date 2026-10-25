import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Icono, type NombreIcono } from './iconos'

// Botón del design system. Todos miden al menos 48×48 px (brief §5, regla 3); el grande, 56.

export type Variante = 'principal' | 'secundario' | 'exito' | 'peligro' | 'fantasma'

const VARIANTES: Record<Variante, string> = {
  principal: 'bg-accion-fuerte text-white hover:brightness-110',
  secundario: 'bg-superficie text-texto border border-borde hover:bg-superficie-2',
  exito: 'bg-libre-fuerte text-white hover:brightness-110',
  peligro: 'bg-alerta-fuerte text-white hover:brightness-110',
  fantasma: 'bg-transparent text-texto hover:bg-superficie-2',
}

export const claseBoton = (variante: Variante = 'secundario', grande = false) =>
  [
    'inline-flex items-center justify-center gap-2 rounded-xl font-semibold select-none',
    'transition active:scale-[0.97] disabled:opacity-45 disabled:active:scale-100',
    'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foco',
    grande ? 'min-h-14 min-w-14 px-5 text-lg' : 'min-h-12 min-w-12 px-4 text-base',
    VARIANTES[variante],
  ].join(' ')

export function Boton({
  variante = 'secundario',
  grande = false,
  icono,
  className = '',
  children,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  /** En React 19 la referencia llega como una propiedad más (para mover el foco al botón). */
  ref?: Ref<HTMLButtonElement>
  variante?: Variante
  grande?: boolean
  icono?: NombreIcono
  children?: ReactNode
}) {
  return (
    <button type={type} className={`${claseBoton(variante, grande)} ${className}`} {...props}>
      {icono && <Icono nombre={icono} />}
      {children}
    </button>
  )
}
