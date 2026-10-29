import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { PinPad } from '../ui/PinPad'
import { ApiError } from './api'
import { floor, useFloor } from './context'
import { FloorFrame } from './FloorFrame'

// Sign in (ADR-013). From any browser on the network, without pairing it: waiters with their PIN;
// administration, register and reports with user and password. The hub checks it: a connection
// is needed to sign in, not to work afterwards (what is done offline with the session open counts).

export const fieldClass =
  'min-h-12 w-full rounded-xl border border-border bg-surface px-3 text-lg disabled:opacity-60 focus-visible:outline-3 focus-visible:outline-focus'

type Mode = 'pin' | 'password'

/** How this device signed in last time: next time it opens the same way. */
const MODE_KEY = 'pos:sign-in-with'
function rememberedMode(): Mode | null {
  try {
    const m = localStorage.getItem(MODE_KEY)
    return m === 'pin' || m === 'password' ? m : null
  } catch {
    return null
  }
}
function rememberMode(m: Mode) {
  try {
    localStorage.setItem(MODE_KEY, m)
  } catch {
    // Without storage it just does not remember it.
  }
}

export function SignIn() {
  const { device, sessionClosedBy, catalog } = useFloor()
  // Like last time on this device; if there is none, password on the register and PIN on a phone.
  const [mode, setMode] = useState<Mode>(
    () => rememberedMode() ?? (device?.type === 'register' ? 'password' : 'pin'),
  )
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [waitMs, setWaitMs] = useState(0)
  const [taken, setTaken] = useState(false)

  const tryAction = async (data: string | { user: string; password: string }) => {
    setTaken(true)
    try {
      await floor.signIn(data)
      rememberMode(typeof data === 'string' ? 'pin' : 'password')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')
      setWaitMs(e instanceof ApiError ? e.waitMs : 0)
      setAttempt((i) => i + 1)
      setTaken(false)
    }
  }
  const changeMode = (m: Mode) => {
    setMode(m)
    setError(null)
    setWaitMs(0)
  }

  const dueToInactivity = sessionClosedBy === 'inactivity'
  return (
    <FloorFrame title={catalog?.restaurant.name ?? device?.name ?? 'Entrar'}>
      <div className="mx-3 my-4 flex max-w-md sm:mx-auto flex-col gap-6 rounded-3xl border border-divider bg-surface p-5 shadow-float sm:my-10 sm:p-8">
        {mode === 'pin' ? (
          <>
            <PinPad
              title={
                dueToInactivity
                  ? 'Se cerró tu sesión por no usarla un rato. Escribe tu PIN'
                  : 'Escribe tu PIN'
              }
              error={error}
              attempt={attempt}
              waitMs={waitMs}
              taken={taken}
              onComplete={(pin) => void tryAction(pin)}
            />
            <Button variant="ghost" onClick={() => changeMode('password')}>
              Caja, administración o reportes: entrar con usuario y contraseña
            </Button>
          </>
        ) : (
          <>
            <WithPassword
              title={dueToInactivity ? 'Se cerró tu sesión por no usarla un rato' : 'Entrar'}
              error={error}
              attempt={attempt}
              waitMs={waitMs}
              taken={taken}
              onSend={(user, password) => void tryAction({ user, password })}
            />
            <Button variant="ghost" onClick={() => changeMode('pin')}>
              Mesero: entrar con PIN
            </Button>
            <p className="text-sm text-muted">
              ¿Olvidaste tu contraseña? Pídele a otra persona que administre el personal que te
              ponga una nueva. Si no hay nadie, quien instaló el sistema te la cambia desde el
              computador de la caja.
            </p>
          </>
        )}
      </div>
    </FloorFrame>
  )
}

function WithPassword({
  title,
  error,
  attempt,
  waitMs,
  taken,
  onSend,
}: {
  title: string
  error: string | null
  attempt: number
  waitMs: number
  taken: boolean
  onSend: (user: string, password: string) => void
}) {
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [remaining, setRemaining] = useState(0)
  const passwordField = useRef<HTMLInputElement>(null)
  const [missing, setMissing] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` restarts the wait anyway
  useEffect(() => {
    setRemaining(waitMs)
    if (waitMs <= 0) return
    const end = Date.now() + waitMs
    const clock = setInterval(() => {
      const hasRemaining = Math.max(0, end - Date.now())
      setRemaining(hasRemaining)
      if (hasRemaining === 0) clearInterval(clock)
    }, 250)
    return () => clearInterval(clock)
  }, [waitMs, attempt])

  // After an error the password is typed again; the user is kept.
  useEffect(() => {
    if (attempt === 0) return
    setPassword('')
    passwordField.current?.focus()
  }, [attempt])

  const blocked = taken || remaining > 0
  const send = (e: FormEvent) => {
    e.preventDefault()
    if (blocked) return
    if (!user.trim() || !password) {
      setMissing(!user.trim() ? 'Escribe tu usuario' : 'Escribe tu contraseña')
      return
    }
    setMissing(null)
    onSend(user, password)
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={send} aria-labelledby="title-sign-in">
      <h2 id="title-sign-in" className="text-center text-xl font-semibold">
        {title}
      </h2>
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Usuario</span>
        <input
          className={fieldClass}
          value={user}
          onChange={(e) => setUser(e.target.value)}
          autoComplete="username"
          // biome-ignore lint/a11y/noAutofocus: it is the only thing to do on this screen
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={40}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Contraseña</span>
        <input
          className={fieldClass}
          ref={passwordField}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          enterKeyHint="go"
          maxLength={200}
        />
      </label>
      {/* Only the message change is announced, not every second of the countdown. */}
      <p key={attempt} className="min-h-6 text-center text-alert-text" role="alert">
        {remaining > 0 ? 'Demasiados intentos.' : taken ? 'Comprobando…' : (missing ?? error ?? '')}
      </p>
      {remaining > 0 && (
        <p className="figures text-center text-muted" aria-hidden="true">
          {`Espera ${Math.ceil(remaining / 1000)} s`}
        </p>
      )}
      <Button type="submit" variant="main" large disabled={blocked}>
        {taken ? 'Entrando…' : 'Entrar'}
      </Button>
    </form>
  )
}
