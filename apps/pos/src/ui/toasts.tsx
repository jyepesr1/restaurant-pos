import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Icon } from './icons'

// Notices with "Deshacer" (brief §5, rule 5): what is neither destructive nor about money does not
// ask for confirmation; it is done at once and can be undone for a few seconds. Up to three show
// at a time, each with its Deshacer: removing two items in a row does not lose the first one. While
// the finger, the mouse or the focus is on a notice, its time does not run.

export const TOAST_DURATION_MS = 5000
const MAXIMUM = 3

interface Toast {
  id: number
  text: string
  undo?: () => void
}

type Notify = (text: string, undo?: () => void) => void

const ToastContext = createContext<Notify | null>(null)

/** `notify("Quitaste Aperol Spritz", () => addItBack())`. */
export function useNotify(): Notify {
  const notify = useContext(ToastContext)
  if (!notify) throw new Error('useNotify necesita <ToastProvider> más arriba')
  return notify
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [alerts, setAlerts] = useState<Toast[]>([])
  const next = useRef(0)

  const notify = useCallback<Notify>((text, undo) => {
    next.current += 1
    const alert = { id: next.current, text, undo }
    setAlerts((a) => [...a, alert].slice(-MAXIMUM))
  }, [])
  const remove = useCallback((id: number) => setAlerts((a) => a.filter((x) => x.id !== id)), [])

  return (
    <ToastContext.Provider value={notify}>
      {children}
      {/* On the phone, above the bottom bar (Pedido · Enviar): it never covers it. On tablet and
          register, at the bottom left, next to the sidebar: far from the order panel and its
          Enviar, on the right. */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 md:right-auto md:bottom-4 md:left-24 md:items-start md:px-0 lg:left-72"
        aria-live="polite"
      >
        {alerts.map((a) => (
          <ToastCard key={a.id} alert={a} onFinish={() => remove(a.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastCard({ alert, onFinish }: { alert: Toast; onFinish: () => void }) {
  const [paused, setPaused] = useState(false)
  const remaining = useRef(TOAST_DURATION_MS)
  const finish = useRef(onFinish)
  finish.current = onFinish

  useEffect(() => {
    if (paused) return
    const start = Date.now()
    const t = setTimeout(() => finish.current(), remaining.current)
    return () => {
      clearTimeout(t)
      remaining.current -= Date.now() - start
    }
  }, [paused])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only pauses the timer; not a control
    <div
      className="pointer-events-auto relative flex w-full max-w-md items-center gap-3 overflow-hidden rounded-2xl bg-neutral-text py-2 pr-2 pl-4 text-surface shadow-xl"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon name="check" />
      <span className="flex-1">{alert.text}</span>
      {alert.undo && (
        <button
          type="button"
          className="inline-flex min-h-12 items-center gap-2 rounded-xl px-3 font-bold hover:bg-white/10 focus-visible:outline-3 focus-visible:outline-focus"
          onClick={() => {
            alert.undo?.()
            onFinish()
          }}
        >
          <Icon name="undo" />
          Deshacer
        </button>
      )}
      <span
        className="notice-timer absolute bottom-0 left-0 h-1 bg-action-strong"
        style={{
          animationDuration: `${TOAST_DURATION_MS}ms`,
          animationPlayState: paused ? 'paused' : 'running',
        }}
      />
    </div>
  )
}
