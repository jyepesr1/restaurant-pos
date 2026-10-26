import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Icono, type NombreIcono } from './iconos'

// Botón del design system. Todos miden al menos 48×48 px (brief §5, regla 3); el grande, 56.

export type Variante = 'main' | 'secondary' | 'success' | 'danger' | 'ghost'

const VARIANTES: Record<Variante, string> = {
  main: 'bg-accion-fuerte text-white hover:brightness-110',
  secondary: 'bg-superficie text-texto border border-borde hover:bg-superficie-2',
  success: 'bg-libre-fuerte text-white hover:brightness-110',
  danger: 'bg-alerta-fuerte text-white hover:brightness-110',
  ghost: 'bg-transparent text-texto hover:bg-superficie-2',
}

export const claseBoton = (variant: Variante = 'secondary', large = false) =>
  [
    'inline-flex items-center justify-center gap-2 rounded-xl font-semibold select-none',
    'transition active:scale-[0.97] disabled:opacity-45 disabled:active:scale-100',
    'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foco',
    large ? 'min-h-14 min-w-14 px-5 text-lg' : 'min-h-12 min-w-12 px-4 text-base',
    VARIANTES[variant],
  ].join(' ')

export function Boton({
  variant = 'secondary',
  large = false,
  icono,
  className = '',
  children,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  /** En React 19 la referencia llega como una propiedad más (para mover el foco al botón). */
  ref?: Ref<HTMLButtonElement>
  variant?: Variante
  large?: boolean
  icono?: NombreIcono
  children?: ReactNode
}) {
  return (
    <button type={type} className={`${claseBoton(variant, large)} ${className}`} {...props}>
      {icono && <Icono name={icono} />}
      {children}
    </button>
  )
}
