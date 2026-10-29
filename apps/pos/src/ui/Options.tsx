import type { ReactNode } from 'react'
import { Icon } from './icons'

// Options chosen by tapping (category, payment method, who an item is for). The chosen one shows
// by its color and also by the ✓ and the border: never by color alone (brief §5, rule 11).

/** A group of options with its name for the screen reader. */
export function Group({
  label,
  className = '',
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <fieldset className={`m-0 min-w-0 border-0 p-0 ${className}`}>
      <legend className="sr-only">{label}</legend>
      {children}
    </fieldset>
  )
}

export function Option({
  selected,
  onChoose,
  shape = 'pastilla',
  detail,
  label,
  children,
}: {
  selected: boolean
  onChoose: () => void
  /** Pill (filters, categories) or card (options with a price). */
  shape?: 'pastilla' | 'card'
  detail?: string
  /** Name for the screen reader if the visible text is not enough. */
  label?: string
  children: ReactNode
}) {
  const base =
    'inline-flex shrink-0 items-center gap-2 border-2 font-semibold transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus'
  const color = selected
    ? 'border-action-strong bg-action-strong text-white'
    : 'border-border bg-surface text-foreground'
  const size =
    shape === 'pastilla'
      ? 'min-h-12 min-w-12 rounded-full px-4'
      : 'min-h-14 w-full rounded-xl px-3 py-2 text-left'
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={onChoose}
      className={`${base} ${color} ${size}`}
    >
      {selected && <Icon name="check" />}
      <span className="flex flex-1 flex-col">
        <span>{children}</span>
        {detail && <span className="figures text-sm font-normal">{detail}</span>}
      </span>
    </button>
  )
}
