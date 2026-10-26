import type { ReactNode } from 'react'
import { Icon, type IconName } from './icons'

// Status label: color with meaning + icon + text (never color alone).

export type Tone = 'free' | 'progress' | 'warning' | 'action' | 'neutral'

export const SOFT_TONES: Record<Tone, string> = {
  free: 'bg-libre-suave text-libre-texto',
  progress: 'bg-proceso-suave text-proceso-texto',
  warning: 'bg-alerta-suave text-alerta-texto',
  action: 'bg-accion-suave text-accion-texto',
  neutral: 'bg-neutro-suave text-neutro-texto',
}

export const STRONG_TONES: Record<Tone, string> = {
  free: 'bg-libre-fuerte text-white',
  progress: 'bg-proceso-fuerte text-white',
  warning: 'bg-alerta-fuerte text-white',
  action: 'bg-accion-fuerte text-white',
  neutral: 'bg-neutro-fuerte text-white',
}

export function Label({
  tone,
  icon,
  main = false,
  children,
}: {
  tone: Tone
  icon?: IconName
  main?: boolean
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${(main ? STRONG_TONES : SOFT_TONES)[tone]}`}
    >
      {icon && <Icon name={icon} />}
      {children}
    </span>
  )
}
