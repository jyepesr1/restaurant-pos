import { type ReactNode, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button'

// Side panel (brief §5, rule 2: modifiers go in a panel, not in cascading windows). On the phone
// it slides up from the bottom and is reachable with the thumb; on tablet and register it comes in
// from the right and keeps the order visible. It closes with Escape, the X or by tapping outside.
//
// It is truly modal: while open, the page behind is inert (it gets no focus or taps, the screen
// reader does not read it) and it does not scroll.

// A panel can sit on top of another (the order and, above it, an item): Escape closes only the
// top one, and the background is released when the last one closes.
const stack: object[] = []
let previousOverflow = ''

function lockBackground(panel: object) {
  stack.push(panel)
  if (stack.length > 1) return
  document.getElementById('root')?.setAttribute('inert', '')
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
}

function releaseBackground(panel: object) {
  const i = stack.lastIndexOf(panel)
  if (i >= 0) stack.splice(i, 1)
  if (stack.length > 0) return
  document.getElementById('root')?.removeAttribute('inert')
  document.body.style.overflow = previousOverflow
}

export function SidePanel({
  opened,
  title,
  onClose,
  footer,
  onlyWithButton = false,
  descriptionId,
  children,
}: {
  opened: boolean
  title: string
  onClose: () => void
  /** Actions fixed at the bottom (e.g. "Agregar"). */
  footer?: ReactNode
  /**
   * No X, no Escape and no closing on outside tap: only with a footer button. For what must not
   * be lost, like a PIN that is shown only once.
   */
  onlyWithButton?: boolean
  /** What the screen reader reads on open, besides the title. */
  descriptionId?: string
  children: ReactNode
}) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  // Callers usually pass a new function on every render: if the effect depended on it, it would
  // run again on every keystroke and the field being typed in would lose focus.
  const close = useRef(onClose)
  close.current = onClose
  const onlyRef = useRef(onlyWithButton)
  onlyRef.current = onlyWithButton

  useEffect(() => {
    if (!opened) return
    const previous = document.activeElement as HTMLElement | null
    const panelToken = {}
    lockBackground(panelToken)
    panel.current?.focus()
    const onKeystroke = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stack.at(-1) === panelToken && !onlyRef.current) close.current()
    }
    window.addEventListener('keydown', onKeystroke)
    return () => {
      window.removeEventListener('keydown', onKeystroke)
      releaseBackground(panelToken)
      previous?.focus()
    }
  }, [opened])

  if (!opened) return null
  return createPortal(
    <div className="fixed inset-0 z-40">
      {/* Tapping the background closes it; the screen reader already has the panel's X. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="absolute inset-0 bg-black/40"
        onClick={() => {
          if (!onlyWithButton) close.current()
        }}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col rounded-t-3xl bg-surface shadow-2xl outline-none md:inset-y-0 md:right-0 md:left-auto md:max-h-none md:w-[26rem] md:rounded-none md:rounded-l-3xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border p-3 pl-5">
          <h2 id={id} className="text-xl font-semibold">
            {title}
          </h2>
          {!onlyWithButton && (
            <Button
              variant="ghost"
              icon="close"
              aria-label="Cerrar"
              onClick={() => close.current()}
            />
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="border-t border-border p-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
