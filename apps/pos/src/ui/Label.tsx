import type { ReactNode } from 'react'
import { Icon, type IconName } from './icons'

// Status label: color with meaning + icon + text (never color alone).

export type Tone = 'free' | 'progress' | 'warning' | 'action' | 'neutral'

export const SOFT_TONES: Record<Tone, string> = {
  free: 'bg-free-soft text-free-text',
  progress: 'bg-progress-soft text-progress-text',
  warning: 'bg-alert-soft text-alert-text',
  action: 'bg-action-soft text-action-text',
  neutral: 'bg-neutral-soft text-neutral-text',
}

export const STRONG_TONES: Record<Tone, string> = {
  free: 'bg-free-strong text-white',
  progress: 'bg-progress-strong text-white',
  warning: 'bg-alert-strong text-white',
  action: 'bg-action-strong text-white',
  neutral: 'bg-neutral-strong text-white',
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
