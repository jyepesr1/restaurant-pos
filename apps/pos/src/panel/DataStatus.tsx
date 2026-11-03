import { useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/icons'
import { SOFT_TONES } from '../ui/Label'
import type { DataState, Polled } from './summary'

// From when the panel's data is, at the top of each screen (tasks 1.11c-1 and 1.11c-2): «Actualizado
// 9:41 p. m.», «Sin noticias del restaurante desde…» with why it may be, and what is still to come
// from the hub. Also what a screen says before its first answer: reading, or that it failed.

export function DataStatus({
  state,
  shown,
  onRetry,
}: {
  state: DataState
  shown: boolean
  /** «Intentar ahora» when the last read failed. */
  onRetry?: () => void
}) {
  const failed = state.kind === 'offline' || state.kind === 'failed'
  return (
    <>
      {/* Read aloud only when the state changes, not with every refresh of the time. */}
      <p aria-live="polite" className="sr-only">
        {shown ? state.announcement : ''}
      </p>
      {shown && (
        <div className="flex flex-col gap-2">
          {/* A block, not a pill: a long state wraps well on a narrow phone. */}
          <div
            className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3 py-2 text-sm sm:self-start ${SOFT_TONES[state.tone]}`}
          >
            <p className="flex min-w-0 flex-1 items-start gap-2">
              <Icon name={state.icon} className="mt-0.5 shrink-0" />
              <span className="flex min-w-0 flex-col">
                <span className="font-semibold">{state.text}</span>
                {state.detail && <span>{state.detail}</span>}
              </span>
            </p>
            {failed && onRetry && <RetryButton onRetry={onRetry} />}
          </div>
          {state.pending && (
            <p className="flex items-start gap-2 rounded-xl bg-progress-soft px-3 py-2 text-sm font-semibold text-progress-text sm:self-start">
              <Icon name="clock" className="mt-0.5 shrink-0" />
              {state.pending}
            </p>
          )}
        </div>
      )}
    </>
  )
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button icon="undo" onClick={onRetry} className="shrink-0">
      Intentar ahora
    </Button>
  )
}

/** After this long reading the first answer, it says it is taking longer than usual. */
export const SLOW_READ_MS = 5_000

/**
 * What a screen says before its first answer: «Leyendo el salón…» and, after 5 s, that it is
 * taking longer than usual; or, if it failed, why and that it keeps trying (only here: the status
 * line above is not shown too, so the notice is not said twice).
 */
export function FirstAnswer({
  polled,
  reading,
  failure,
  slow: initialSlow = false,
}: {
  polled: Polled<unknown>
  /** «Leyendo el salón…» */
  reading: string
  /** «No se pudo leer el salón.», when the failure has no message of its own. */
  failure: string
  /** Already slow (the tests: there are no timers on the server). */
  slow?: boolean
}) {
  const [slow, setSlow] = useState(initialSlow)
  useEffect(() => {
    if (slow || polled.failed) return
    const t = setTimeout(() => setSlow(true), SLOW_READ_MS)
    return () => clearTimeout(t)
  }, [slow, polled.failed])
  if (polled.failed)
    return (
      <div
        role="status"
        className="flex flex-col gap-3 rounded-2xl border border-alert-strong bg-alert-soft p-4 text-alert-text"
      >
        <p>{`${polled.error ?? failure} Lo intentamos de nuevo solos cada 15 s.`}</p>
        {polled.retry && (
          <span className="self-start">
            <RetryButton onRetry={polled.retry} />
          </span>
        )}
      </div>
    )
  return (
    <p role="status" className="text-muted">
      {reading}
      {slow && (
        <span className="block text-sm">
          Tarda más de lo normal: puede ser la conexión. Seguimos intentando.
        </span>
      )}
    </p>
  )
}
