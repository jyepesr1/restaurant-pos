import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Icon, type IconName } from './icons'

// Design system button. They all measure at least 48×48 px (brief §5, rule 3); the large one, 56.

export type Variant = 'main' | 'secondary' | 'success' | 'danger' | 'ghost'

const VARIANTS: Record<Variant, string> = {
  main: 'bg-accion-fuerte text-white hover:brightness-110',
  secondary: 'bg-superficie text-texto border border-borde hover:bg-superficie-2',
  success: 'bg-libre-fuerte text-white hover:brightness-110',
  danger: 'bg-alerta-fuerte text-white hover:brightness-110',
  ghost: 'bg-transparent text-texto hover:bg-superficie-2',
}

export const buttonClass = (variant: Variant = 'secondary', large = false) =>
  [
    'inline-flex items-center justify-center gap-2 rounded-xl font-semibold select-none',
    'transition active:scale-[0.97] disabled:opacity-45 disabled:active:scale-100',
    'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foco',
    large ? 'min-h-14 min-w-14 px-5 text-lg' : 'min-h-12 min-w-12 px-4 text-base',
    VARIANTS[variant],
  ].join(' ')

export function Button({
  variant = 'secondary',
  large = false,
  icon,
  className = '',
  children,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  /** In React 19 the ref arrives as just another prop (to move focus to the button). */
  ref?: Ref<HTMLButtonElement>
  variant?: Variant
  large?: boolean
  icon?: IconName
  children?: ReactNode
}) {
  return (
    <button type={type} className={`${buttonClass(variant, large)} ${className}`} {...props}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  )
}
