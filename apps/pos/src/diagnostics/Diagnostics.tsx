import { useEffect, useRef, useState } from 'react'
import { deleteEvents, purgeOldEvents, readEvents, recordEvent, testIndexedDb } from './log'
import { type DiagnosticsSummary, summarizeEvents } from './summary'
import { type ChannelState, useWsConnection } from './useWsConnection'

const NAME_KEY = 'pos-diagnostics-name'
const SUMMARY_INTERVAL_MS = 3000
const IDEAL_LATENCY_MS = 200
const IDEAL_RECOVERY_MS = 3000

type SendStatus = 'ready' | 'sending' | 'sent' | 'error' | 'missing-name'
type Severity = 'ok' | 'error' | 'alert' | 'measuring' | 'info'

function detectCapabilities() {
  return {
    secureContext: window.isSecureContext,
    serviceWorker: 'serviceWorker' in navigator,
    vibration: 'vibrate' in navigator,
    screenOn: 'wakeLock' in navigator,
    // Without HTTPS the browser does not allow asking for permission, even if the API exists.
    notifications: 'Notification' in window && window.isSecureContext,
    persistentStorage: typeof navigator.storage?.persist === 'function',
  }
}

// Logged only once per page load, even if React mounts the component twice.
let loadRecorded = false
function recordLoad() {
  if (loadRecorded) return
  loadRecorded = true
  const navigation = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined
  recordEvent('load', {
    navigationType: navigation?.type ?? 'unknown',
    discarded: (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true,
  })
}

function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

let audioContext: AudioContext | undefined
function playSound() {
  // A single context: mobile browsers limit how many can be open at once.
  audioContext ??= new AudioContext()
  audioContext.resume()
  const oscillator = audioContext.createOscillator()
  oscillator.frequency.value = 880
  oscillator.connect(audioContext.destination)
  oscillator.start()
  oscillator.stop(audioContext.currentTime + 0.25)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return 'menos de 1 s'
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

const plural = (n: number, singular: string, many: string) => `${n} ${n === 1 ? singular : many}`

const levelStyles: Record<Severity, { icon: string; cssClass: string }> = {
  ok: { icon: '✓', cssClass: 'text-green-700 dark:text-green-400' },
  error: { icon: '✕', cssClass: 'text-red-700 dark:text-red-400' },
  alert: { icon: '⚠', cssClass: 'text-amber-700 dark:text-amber-400' },
  measuring: { icon: '…', cssClass: 'text-amber-700 dark:text-amber-400' },
  info: { icon: '', cssClass: 'text-slate-700 dark:text-slate-300' },
}

function Row({ title, severity, text }: { title: string; severity: Severity; text: string }) {
  const { icon, cssClass } = levelStyles[severity]
  return (
    <li className="flex items-start justify-between gap-4 border-b border-slate-200 py-3 dark:border-slate-800">
      <span className="font-medium">{title}</span>
      <span className={`text-right ${cssClass}`}>
        {icon && <span aria-hidden="true">{icon} </span>}
        {text}
      </span>
    </li>
  )
}

const channelText: Record<ChannelState, { severity: Severity; text: string }> = {
  connecting: { severity: 'measuring', text: 'Conectando' },
  connected: { severity: 'ok', text: 'Conectado' },
  'no-response': { severity: 'error', text: 'Sin respuesta, reconectando' },
  disconnected: { severity: 'error', text: 'Desconectado, reintentando' },
}

interface Verdict {
  severity: 'ok' | 'alert' | 'error'
  title: string
  points: string[]
}

function computeVerdict(
  channel: ChannelState,
  indexedDb: boolean | null,
  medianMs: number | null,
  summary: DiagnosticsSummary,
): Verdict {
  const errors: string[] = []
  const alerts: string[] = []
  if (channel !== 'connected') errors.push('No hay conexión en tiempo real con el hub.')
  if (indexedDb === false) errors.push('Este navegador no puede guardar datos locales.')
  if (summary.discards > 0) alerts.push('El navegador recargó la página solo al volver.')
  if (summary.hiddenPeriods.some((o) => o.connectionLost)) {
    alerts.push('En segundo plano se pierde la conexión (se recupera al volver).')
  }
  if (summary.hiddenPeriods.some((o) => (o.recoveryMs ?? 0) > IDEAL_RECOVERY_MS)) {
    alerts.push(`Al volver tardó más de ${IDEAL_RECOVERY_MS / 1000} s en reconectar.`)
  }
  if (medianMs !== null && medianMs >= IDEAL_LATENCY_MS) {
    alerts.push('El tiempo de respuesta es alto: revisa la señal del Wi-Fi.')
  }

  if (errors.length > 0) {
    return {
      severity: 'error',
      title: `Revisar: ${plural(errors.length, 'punto', 'puntos')}`,
      points: errors,
    }
  }
  if (indexedDb === null || medianMs === null || summary.hiddenPeriods.length === 0) {
    return { severity: 'alert', title: 'Prueba en curso: sigue los pasos', points: alerts }
  }
  if (alerts.length > 0) {
    return { severity: 'alert', title: 'Funciona, con avisos', points: alerts }
  }
  return { severity: 'ok', title: 'Listo para operar', points: [] }
}

const verdictClass: Record<Verdict['severity'], string> = {
  ok: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200',
  alert: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  error: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
}
const verdictIcon: Record<Verdict['severity'], string> = { ok: '✓', alert: '⚠', error: '✕' }

const buttonClass =
  'min-h-12 rounded-lg px-4 font-semibold transition active:scale-[0.98] disabled:opacity-50'
const secondaryClass = `${buttonClass} bg-slate-200 dark:bg-slate-800`

export function Diagnostics() {
  const capabilities = detectCapabilities()
  const { channel, latency } = useWsConnection()
  const [indexedDb, setIndexedDb] = useState<boolean | null>(null)
  const [summary, setSummary] = useState<DiagnosticsSummary>(() => summarizeEvents([]))
  const [name, setName] = useState(readName)
  const [submission, setSubmission] = useState<SendStatus>('ready')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const nameField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    recordLoad()
    purgeOldEvents()
    testIndexedDb().then(setIndexedDb)

    const update = () => readEvents().then((events) => setSummary(summarizeEvents(events)))
    update()
    const interval = setInterval(update, SUMMARY_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  function changeName(value: string) {
    setName(value)
    if (submission === 'missing-name') setSubmission('ready')
    try {
      localStorage.setItem(NAME_KEY, value)
    } catch {
      // Without local storage the name only lives on this screen.
    }
  }

  async function send() {
    if (name.trim() === '') {
      setSubmission('missing-name')
      nameField.current?.focus()
      return
    }
    setSubmission('sending')
    try {
      const events = await readEvents()
      const res = await fetch('/api/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          browser: navigator.userAgent,
          screen: `${screen.width}x${screen.height}`,
          capabilities,
          indexedDb,
          latency,
          summary: summarizeEvents(events),
          events,
        }),
      })
      setSubmission(res.ok ? 'sent' : 'error')
      if (res.ok) navigator.vibrate?.(100)
    } catch {
      setSubmission('error')
    }
  }

  async function erase() {
    await deleteEvents()
    setSummary(summarizeEvents([]))
    setSubmission('ready')
    setConfirmDelete(false)
  }

  const verdict = computeVerdict(channel, indexedDb, latency?.medianMs ?? null, summary)
  const latest = summary.hiddenPeriods.at(-1)

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <main className="mx-auto max-w-xl p-4 pb-44">
        <header className="mb-4 flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold">Diagnóstico del dispositivo</h1>
          <a
            href="/"
            className="min-h-12 content-center px-2 text-blue-700 underline dark:text-blue-400"
          >
            Volver
          </a>
        </header>

        <section
          className={`mb-4 rounded-lg p-4 ${verdictClass[verdict.severity]}`}
          aria-live="polite"
        >
          <p className="text-lg font-semibold">
            <span aria-hidden="true">{verdictIcon[verdict.severity]} </span>
            {verdict.title}
          </p>
          {verdict.points.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {verdict.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          )}
        </section>

        <ol className="mb-4 list-decimal space-y-1 pl-5 text-slate-700 dark:text-slate-300">
          <li>Escribe un nombre para este equipo.</li>
          <li>Toca «Probar vibración» y «Probar sonido».</li>
          <li>Bloquea el equipo 30 segundos y vuelve a esta pantalla. Repite con 5 minutos.</li>
          <li>Toca «Enviar resultados al hub».</li>
        </ol>

        <label className="mb-4 block">
          <span className="mb-1 block font-medium">Nombre de este equipo</span>
          <input
            ref={nameField}
            value={name}
            onChange={(e) => changeName(e.target.value)}
            placeholder="Ej.: iPhone de caja, Android mesero 1"
            aria-invalid={submission === 'missing-name'}
            className="min-h-12 w-full rounded-lg border border-slate-400 bg-white px-3 placeholder:text-slate-500 dark:border-slate-600 dark:bg-slate-900"
          />
        </label>

        <h2 className="mt-2 font-semibold text-slate-600 dark:text-slate-400">
          Conexión con el hub
        </h2>
        <ul>
          <Row title="Canal en tiempo real" {...channelText[channel]} />
          <Row
            title="Tiempo de respuesta"
            severity={
              latency === null ? 'measuring' : latency.medianMs < IDEAL_LATENCY_MS ? 'ok' : 'alert'
            }
            text={
              latency === null
                ? 'Midiendo'
                : `${latency.medianMs} ms (ideal: menos de ${IDEAL_LATENCY_MS} ms)`
            }
          />
          <Row
            title="Veces que se reconectó"
            severity="info"
            text={String(summary.reconnections)}
          />
          <Row
            title="Última vez en segundo plano"
            severity={latest ? (latest.connectionLost ? 'alert' : 'ok') : 'info'}
            text={
              latest
                ? `${formatDuration(latest.durationMs)}, ${
                    latest.reloaded
                      ? 'la página se recargó'
                      : latest.connectionLost
                        ? 'se perdió la conexión'
                        : 'sin cortes'
                  }${
                    latest.connectionLost
                      ? latest.recoveryMs === null
                        ? ' (aún reconectando)'
                        : ` (volvió en ${formatDuration(latest.recoveryMs)})`
                      : ''
                  }`
                : 'Aún no ha pasado'
            }
          />
          <Row
            title="El navegador recargó la página solo"
            severity={summary.discards === 0 ? 'ok' : 'alert'}
            text={`${plural(summary.discards, 'vez', 'veces')} en ${plural(summary.loads, 'carga', 'cargas')}`}
          />
        </ul>

        <h2 className="mt-6 font-semibold text-slate-600 dark:text-slate-400">
          Capacidades del navegador
        </h2>
        <ul>
          <Row
            title="Datos locales (IndexedDB)"
            severity={indexedDb === null ? 'measuring' : indexedDb ? 'ok' : 'error'}
            text={indexedDb === null ? 'Probando' : indexedDb ? 'Funciona' : 'No funciona'}
          />
          <Row
            title="Dirección segura (HTTPS)"
            severity={capabilities.secureContext ? 'ok' : 'info'}
            text={
              capabilities.secureContext
                ? 'Sí'
                : 'No: normal al abrir por IP; algunas funciones no estarán'
            }
          />
          <Row
            title="Vibración"
            severity={capabilities.vibration ? 'ok' : 'info'}
            text={capabilities.vibration ? 'Disponible' : 'No disponible en este equipo'}
          />
          <Row
            title="Mantener pantalla encendida"
            severity={capabilities.screenOn ? 'ok' : 'info'}
            text={capabilities.screenOn ? 'Disponible' : 'Se configura en el equipo'}
          />
          <Row
            title="Notificaciones del sistema"
            severity={capabilities.notifications ? 'ok' : 'info'}
            text={capabilities.notifications ? 'Disponible' : 'No disponible (requiere HTTPS)'}
          />
        </ul>

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => navigator.vibrate?.(200)}
            disabled={!capabilities.vibration}
            className={secondaryClass}
          >
            {capabilities.vibration ? 'Probar vibración' : 'Vibración no disponible'}
          </button>
          <button type="button" onClick={playSound} className={secondaryClass}>
            Probar sonido
          </button>
        </div>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Si no suena, revisa que el equipo no esté en silencio.
        </p>

        <div className="mt-8 border-t border-slate-200 pt-4 dark:border-slate-800">
          {confirmDelete ? (
            <div className="rounded-lg bg-red-50 p-3 dark:bg-red-950">
              <p className="mb-3 font-medium">
                ¿Borrar los resultados guardados en este equipo? No se puede deshacer.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className={secondaryClass}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={erase}
                  className={`${buttonClass} bg-red-700 text-white`}
                >
                  Borrar
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className={`${buttonClass} w-full text-red-700 underline dark:text-red-400`}
            >
              Borrar registro y empezar de nuevo
            </button>
          )}
        </div>
      </main>

      <footer className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
        <div className="mx-auto max-w-xl">
          <button
            type="button"
            onClick={send}
            disabled={submission === 'sending'}
            className={`${buttonClass} w-full bg-blue-700 text-white`}
          >
            {submission === 'sending' ? 'Enviando…' : 'Enviar resultados al hub'}
          </button>
          <p role="status" className="mt-2 min-h-6 text-center">
            {submission === 'sent' && '✓ Resultados enviados'}
            {submission === 'error' &&
              '✕ No llegó al hub. Revisa que el equipo esté en el Wi-Fi del local.'}
            {submission === 'missing-name' && 'Escribe un nombre para identificar este equipo.'}
          </p>
        </div>
      </footer>
    </div>
  )
}
