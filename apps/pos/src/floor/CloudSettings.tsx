import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/icons'
import { Label } from '../ui/Label'
import { useNotify } from '../ui/toasts'
import { cloudLabel } from './cloud'
import { floor, useFloor } from './context'
import { FloorFrame } from './FloorFrame'
import { fieldClass } from './SignIn'

// The register PC and the cloud (task 1.11, ADR-016): the admin connects it once with the code
// Faro gives, and from then on sees here how the upload is going.

const time = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
})

/** What each state means, in words for the admin. */
const EXPLANATION = {
  up_to_date: 'Todo lo del restaurante está guardado en la nube.',
  uploading: 'El PC de caja está subiendo lo que guardó mientras no había internet.',
  offline:
    'El PC de caja no tiene internet. El salón sigue igual: los cambios quedan guardados en este PC y se suben solos cuando vuelva la conexión.',
  revoked:
    'La nube ya no acepta este PC de caja. Pide a Faro un código nuevo y escríbelo abajo para conectarlo otra vez. Lo que falta por subir no se pierde.',
  stuck:
    'Un cambio no se pudo guardar en la nube y detiene la subida. Todo sigue guardado en este PC. Avisa a Faro para que lo revise.',
  not_connected:
    'Este PC de caja todavía no sube nada a la nube. Conéctalo con el código que te dio Faro.',
} as const

export function CloudSettings() {
  const { cloud } = useFloor()
  const notify = useNotify()
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const statusSection = useRef<HTMLElement>(null)

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    floor
      .cloudStatus()
      .catch((e) => {
        setLoadError(e instanceof Error ? e.message : 'No se pudo leer el estado de la nube')
      })
      .finally(() => setLoading(false))
  }, [])
  useEffect(load, [load])

  const connect = async (e: FormEvent) => {
    e.preventDefault()
    if (!code.trim() || sending) return
    setSending(true)
    setError(null)
    try {
      await floor.connectCloud(code)
      setCode('')
      notify('El PC de caja quedó conectado a la nube')
      // The form goes away: focus goes to the status, not to the page's start.
      requestAnimationFrame(() => statusSection.current?.focus())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo conectar')
    }
    setSending(false)
  }

  const label = cloud ? cloudLabel(cloud) : null
  const asksForCode = cloud?.state === 'not_connected' || cloud?.state === 'revoked'

  return (
    <FloorFrame title="Copia en la nube">
      <div className="mx-auto flex max-w-2xl flex-col gap-5 p-4 md:p-6">
        <p className="text-muted">
          La nube es la copia oficial del restaurante, con respaldos. El PC de caja sube cada cambio
          apenas lo guarda; sin internet, los guarda y los sube cuando vuelve la conexión.
        </p>

        {!cloud && loading && <p className="text-muted">Leyendo el estado…</p>}
        {!cloud && loadError && !loading && (
          <div
            className="flex flex-col gap-3 rounded-xl bg-alert-soft p-4 text-alert-text"
            role="alert"
          >
            <p>{loadError}</p>
            <Button large onClick={load}>
              Intentar de nuevo
            </Button>
          </div>
        )}

        {cloud && label && (
          <section
            ref={statusSection}
            tabIndex={-1}
            aria-labelledby="cloud-status"
            className="flex flex-col gap-3 rounded-2xl border border-divider bg-surface p-5 outline-none focus-visible:outline-3 focus-visible:outline-focus"
          >
            <h2 id="cloud-status" className="sr-only">
              Estado
            </h2>
            <div>
              <Label tone={label.tone} icon={label.icon}>
                {label.text}
              </Label>
            </div>
            <p>{EXPLANATION[cloud.state]}</p>
            {cloud.state !== 'not_connected' && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted">
                <dt>Por subir</dt>
                <dd className="figures font-semibold text-foreground">
                  {cloud.pending === 1 ? '1 cambio' : `${cloud.pending} cambios`}
                </dd>
                <dt>Última subida</dt>
                <dd className="text-foreground">
                  {cloud.last_upload_at
                    ? time.format(new Date(cloud.last_upload_at))
                    : 'Todavía no'}
                </dd>
              </dl>
            )}
          </section>
        )}

        {asksForCode && (
          <form
            onSubmit={connect}
            className="flex flex-col gap-3 rounded-2xl border border-divider bg-surface p-5"
          >
            <label className="font-semibold">
              Código de conexión
              <input
                className={`${fieldClass} figures mt-1 uppercase tracking-widest placeholder:normal-case placeholder:tracking-normal`}
                value={code}
                maxLength={20}
                placeholder="Escribe el código"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-describedby="code-help"
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <p id="code-help" className="text-sm text-muted">
              Son 12 letras y números, como K7PM-QX2R-9DHT. Pídelo a Faro: sirve una sola vez y
              vence a las 24 horas.
            </p>
            {error && (
              <p className="flex gap-2 rounded-xl bg-alert-soft p-3 text-alert-text" role="alert">
                <Icon name="warning" className="mt-0.5 size-5 shrink-0" />
                {error}
              </p>
            )}
            <Button type="submit" variant="main" large disabled={sending || !code.trim()}>
              {sending ? 'Conectando…' : 'Conectar a la nube'}
            </Button>
          </form>
        )}
      </div>
    </FloorFrame>
  )
}
