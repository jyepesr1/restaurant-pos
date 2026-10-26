import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Icon } from './icons'

// PIN pad (ADR-008: PIN only, 4 digits). On the fourth digit it submits itself: one tap fewer.
// Large keys (64 px) for one-handed use. It also accepts the register's physical keyboard.

export const DIGITS = 4

export function PinPad({
  title = 'Escribe tu PIN',
  error,
  attempt = 0,
  waitMs = 0,
  taken = false,
  onComplete,
}: {
  title?: string
  /** Message of the last failed attempt. */
  error?: string | null
  /** Changes on every failed attempt: so two identical errors in a row are noticed too. */
  attempt?: number
  /** While it lasts, the keypad accepts nothing (wait after errors, ADR-008). */
  waitMs?: number
  /** Waiting for the hub's response. */
  taken?: boolean
  /** Called only once per complete PIN. */
  onComplete: (pin: string) => void
}) {
  const titleId = useId()
  const [pin, setPin] = useState('')
  const [remaining, setRemaining] = useState(waitMs)
  const blocked = taken || remaining > 0
  // The PIN in progress, outside React state: so submitting does not depend on how many times
  // React runs an updater (in development it does it twice).
  const inProgress = useRef('')

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` restarts even an equal wait
  useEffect(() => {
    setRemaining(waitMs)
    if (waitMs <= 0) return
    const end = Date.now() + waitMs
    const interval = setInterval(() => {
      const hasRemaining = Math.max(0, end - Date.now())
      setRemaining(hasRemaining)
      if (hasRemaining === 0) clearInterval(interval)
    }, 250)
    return () => clearInterval(interval)
  }, [waitMs, attempt])

  const tap = useCallback(
    (digit: string) => {
      if (blocked || inProgress.current.length >= DIGITS) return
      const fresh = inProgress.current + digit
      if (fresh.length === DIGITS) {
        // It is submitted and ready for the next attempt.
        inProgress.current = ''
        setPin('')
        onComplete(fresh)
        return
      }
      inProgress.current = fresh
      setPin(fresh)
    },
    [onComplete, blocked],
  )
  const erase = useCallback(() => {
    if (blocked) return
    inProgress.current = inProgress.current.slice(0, -1)
    setPin(inProgress.current)
  }, [blocked])

  useEffect(() => {
    const onKeystroke = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      if (/^[0-9]$/.test(e.key)) tap(e.key)
      else if (e.key === 'Backspace') erase()
    }
    window.addEventListener('keydown', onKeystroke)
    return () => window.removeEventListener('keydown', onKeystroke)
  }, [tap, erase])

  const hotkey =
    'flex h-16 items-center justify-center rounded-2xl bg-superficie-2 text-2xl font-semibold text-texto active:scale-95 transition disabled:opacity-45 focus-visible:outline-3 focus-visible:outline-foco'
  const seconds = Math.ceil(remaining / 1000)

  return (
    <div className="mx-auto w-full max-w-xs">
      <p className="text-center text-lg font-semibold" id={titleId}>
        {title}
      </p>
      <output className="my-5 flex justify-center gap-4" aria-labelledby={titleId}>
        <span className="sr-only">{`${pin.length} de ${DIGITS} dígitos`}</span>
        {Array.from({ length: DIGITS }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed PIN positions
            key={i}
            className={`size-4 rounded-full border-2 ${i < pin.length ? 'border-accion-fuerte bg-accion-fuerte' : 'border-borde'}`}
          />
        ))}
      </output>
      {/* Only the message change is announced, not every second of the countdown. */}
      {/* `key`: the same error twice in a row is announced too. */}
      <p key={attempt} className="min-h-6 text-center text-alerta-texto" role="alert">
        {remaining > 0 ? 'Demasiados intentos.' : taken ? 'Comprobando…' : (error ?? '')}
      </p>
      <p className="cifras min-h-6 text-center text-texto-suave" aria-hidden="true">
        {remaining > 0 ? `Espera ${seconds} s` : ''}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            type="button"
            className={hotkey}
            disabled={blocked}
            onClick={() => tap(d)}
          >
            {d}
          </button>
        ))}
        <span />
        <button type="button" className={hotkey} disabled={blocked} onClick={() => tap('0')}>
          0
        </button>
        <button
          type="button"
          className={hotkey}
          disabled={blocked || pin.length === 0}
          onClick={erase}
          aria-label="Borrar el último dígito"
        >
          <Icon name="erase" />
        </button>
      </div>
    </div>
  )
}
