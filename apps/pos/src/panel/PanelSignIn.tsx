import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { fieldClass } from '../ui/field'
import { Icon } from '../ui/icons'
import { Logo } from '../ui/Logo'
import { useTheme } from '../ui/theme'
import { type Me, type PanelApi, PanelError, waitInWords } from './api'
import { cleanSlug, rememberedRestaurant, rememberRestaurant } from './restaurant'

// «Entrar» to the owner's panel (docs/PANEL.md): restaurant, user and password, the same ones as the
// register. Only whoever has «Entrar desde fuera del local» gets in; the cloud says the same for
// any failure, so nobody can find out which users exist. The restaurant is typed by its name
// («La Spritzzería»): it becomes the slug here.

/** Said after any failed attempt, the same for all: it reveals nothing. */
export const PERMISSION_HINT =
  'Si la contraseña es la de la caja, pide al administrador el permiso «Entrar desde fuera del local».'

export function PanelSignIn({
  api,
  notice,
  onSignedIn,
}: {
  api: Pick<PanelApi, 'signIn'>
  /** Why the panel is here again (the session closed), if that was the case. */
  notice: string | null
  onSignedIn: (me: Me) => void
}) {
  const { dark, select } = useTheme()
  const [restaurant, setRestaurant] = useState(rememberedRestaurant)
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState<{ text: string; rateLimited: boolean } | null>(null)
  const [missing, setMissing] = useState<string | null>(null)
  const [taken, setTaken] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [waitMs, setWaitMs] = useState(0)
  const [remaining, setRemaining] = useState(0)
  const passwordField = useRef<HTMLInputElement>(null)
  const title = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    document.title = 'Entrar · Faro'
    // Back here because the session closed: focus goes to the title, and the notice is read next.
    if (notice) title.current?.focus()
  }, [notice])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` restarts the wait anyway
  useEffect(() => {
    setRemaining(waitMs)
    if (waitMs <= 0) return
    const end = Date.now() + waitMs
    const clock = setInterval(() => {
      const left = Math.max(0, end - Date.now())
      setRemaining(left)
      if (left === 0) clearInterval(clock)
    }, 250)
    return () => clearInterval(clock)
  }, [waitMs, attempt])

  const blocked = taken || remaining > 0
  const send = async (e: FormEvent) => {
    e.preventDefault()
    if (blocked) return
    const slug = cleanSlug(restaurant)
    const lacking = !slug
      ? 'Escribe el nombre del restaurante'
      : !user.trim()
        ? 'Escribe tu usuario'
        : !password
          ? 'Escribe tu contraseña'
          : null
    setMissing(lacking)
    if (lacking) return
    setTaken(true)
    setError(null)
    try {
      const me = await api.signIn({ restaurant: slug, username: user.trim(), password })
      // What was typed is remembered if it still leads to this restaurant (its name, usually).
      rememberRestaurant(
        cleanSlug(restaurant.trim()) === me.restaurant.slug
          ? restaurant.trim()
          : me.restaurant.slug,
      )
      onSignedIn(me)
    } catch (e) {
      setError({
        text: e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.',
        rateLimited: e instanceof PanelError && e.kind === 'rate_limited',
      })
      setWaitMs(e instanceof PanelError ? e.waitMs : 0)
      setAttempt((i) => i + 1)
      setTaken(false)
      // The password stays (it can be shown to check it); the field is ready to fix it.
      passwordField.current?.focus()
    }
  }

  const message = taken
    ? 'Comprobando…'
    : (missing ??
      (error ? (remaining > 0 && error.rateLimited ? 'Demasiados intentos.' : error.text) : ''))

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-4 pt-4 sm:px-6">
        <Logo />
        <Button
          variant="ghost"
          icon={dark ? 'sun' : 'moon'}
          aria-label="Modo oscuro"
          aria-pressed={dark}
          onClick={() => select(dark ? 'light' : 'dark')}
        />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-6 sm:items-center">
        <form
          onSubmit={send}
          aria-labelledby="panel-sign-in-title"
          className="flex w-full max-w-md flex-col gap-4 rounded-3xl border border-divider bg-surface p-5 shadow-float sm:p-8"
        >
          <div className="flex flex-col gap-1">
            <h1
              id="panel-sign-in-title"
              ref={title}
              tabIndex={-1}
              className="font-heading text-2xl font-bold tracking-tight outline-none"
            >
              Tu restaurante desde cualquier lugar
            </h1>
            <p className="text-muted">Entra con el usuario y la contraseña de la caja.</p>
          </div>
          {notice && (
            <p
              role="status"
              className="flex items-center gap-2 rounded-xl bg-progress-soft p-3 text-progress-text"
            >
              <Icon name="clock" className="shrink-0" />
              {notice}
            </p>
          )}
          <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1">
              <span className="font-semibold">Restaurante</span>
              <input
                className={fieldClass}
                value={restaurant}
                onChange={(e) => setRestaurant(e.target.value)}
                placeholder="Ej.: La Spritzzería"
                autoComplete="organization"
                autoCorrect="off"
                spellCheck={false}
                maxLength={60}
                aria-describedby="panel-restaurant-help"
              />
            </label>
            <p id="panel-restaurant-help" className="text-sm text-muted">
              El nombre de tu restaurante, como lo ves en la caja.
            </p>
          </div>
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Usuario</span>
            <input
              className={fieldClass}
              value={user}
              onChange={(e) => setUser(e.target.value)}
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={40}
            />
          </label>
          <div className="flex flex-col gap-1">
            <label htmlFor="panel-password" className="font-semibold">
              Contraseña
            </label>
            <div className="flex gap-2">
              <input
                id="panel-password"
                ref={passwordField}
                className={fieldClass}
                type={visible ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                maxLength={200}
              />
              <Button
                aria-pressed={visible}
                aria-controls="panel-password"
                onClick={() => setVisible(!visible)}
              >
                {visible ? 'Ocultar' : 'Mostrar'}
              </Button>
            </div>
          </div>
          {/* Only the message change is announced, not every second of the countdown. */}
          <div className="flex flex-col gap-1 text-center">
            <p key={attempt} className="min-h-6 text-alert-text" role="alert">
              {message}
            </p>
            {remaining > 0 && (
              <p className="figures text-muted" aria-hidden="true">
                {waitInWords(remaining)}
              </p>
            )}
            {error && !taken && <p className="text-sm text-muted">{PERMISSION_HINT}</p>}
          </div>
          <Button type="submit" variant="main" large disabled={blocked}>
            {taken ? 'Entrando…' : 'Entrar'}
          </Button>
        </form>
      </main>
    </div>
  )
}
