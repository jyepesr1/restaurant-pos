import { useEffect, useRef, useState } from 'react'
import {
  borrarEventos,
  leerEventos,
  probarIndexedDb,
  purgarEventosAntiguos,
  registrarEvento,
} from './registro'
import { type ResumenDiagnostico, resumirEventos } from './resumen'
import { type EstadoCanal, useConexionWs } from './useConexionWs'

const CLAVE_NOMBRE = 'pos-diagnostics-name'
const INTERVALO_RESUMEN_MS = 3000
const LATENCIA_IDEAL_MS = 200
const RECUPERACION_IDEAL_MS = 3000

type EstadoEnvio = 'ready' | 'enviando' | 'sent' | 'error' | 'missing-name'
type Nivel = 'ok' | 'error' | 'alert' | 'measuring' | 'info'

function detectarCapacidades() {
  return {
    contextoSeguro: window.isSecureContext,
    serviceWorker: 'serviceWorker' in navigator,
    vibracion: 'vibrate' in navigator,
    pantallaEncendida: 'wakeLock' in navigator,
    // Sin HTTPS el navegador no deja pedir permiso, aunque la API exista.
    notificaciones: 'Notification' in window && window.isSecureContext,
    almacenamientoPersistente: typeof navigator.storage?.persist === 'function',
  }
}

// Se registra una sola vez por carga de la página, aunque React monte el componente dos veces.
let cargaRegistrada = false
function registrarCarga() {
  if (cargaRegistrada) return
  cargaRegistrada = true
  const navegacion = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined
  registrarEvento('load', {
    tipoNavegacion: navegacion?.type ?? 'unknown',
    descartada: (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true,
  })
}

function leerNombre(): string {
  try {
    return localStorage.getItem(CLAVE_NOMBRE) ?? ''
  } catch {
    return ''
  }
}

let contextoAudio: AudioContext | undefined
function sonar() {
  // Un solo contexto: los navegadores móviles limitan cuántos puede haber abiertos.
  contextoAudio ??= new AudioContext()
  contextoAudio.resume()
  const oscilador = contextoAudio.createOscillator()
  oscilador.frequency.value = 880
  oscilador.connect(contextoAudio.destination)
  oscilador.start()
  oscilador.stop(contextoAudio.currentTime + 0.25)
}

function formatearDuracion(ms: number): string {
  if (ms < 1000) return 'menos de 1 s'
  const segundos = Math.round(ms / 1000)
  return segundos < 60 ? `${segundos} s` : `${Math.floor(segundos / 60)} min ${segundos % 60} s`
}

const plural = (n: number, singular: string, varios: string) =>
  `${n} ${n === 1 ? singular : varios}`

const estilosNivel: Record<Nivel, { icono: string; cssClass: string }> = {
  ok: { icono: '✓', cssClass: 'text-green-700 dark:text-green-400' },
  error: { icono: '✕', cssClass: 'text-red-700 dark:text-red-400' },
  alert: { icono: '⚠', cssClass: 'text-amber-700 dark:text-amber-400' },
  measuring: { icono: '…', cssClass: 'text-amber-700 dark:text-amber-400' },
  info: { icono: '', cssClass: 'text-slate-700 dark:text-slate-300' },
}

function Fila({ titulo, severity, text }: { titulo: string; severity: Nivel; text: string }) {
  const { icono, cssClass } = estilosNivel[severity]
  return (
    <li className="flex items-start justify-between gap-4 border-b border-slate-200 py-3 dark:border-slate-800">
      <span className="font-medium">{titulo}</span>
      <span className={`text-right ${cssClass}`}>
        {icono && <span aria-hidden="true">{icono} </span>}
        {text}
      </span>
    </li>
  )
}

const textoCanal: Record<EstadoCanal, { severity: Nivel; text: string }> = {
  connecting: { severity: 'measuring', text: 'Conectando' },
  connected: { severity: 'ok', text: 'Conectado' },
  'no-response': { severity: 'error', text: 'Sin respuesta, reconectando' },
  disconnected: { severity: 'error', text: 'Desconectado, reintentando' },
}

interface Veredicto {
  severity: 'ok' | 'alert' | 'error'
  titulo: string
  puntos: string[]
}

function calcularVeredicto(
  channel: EstadoCanal,
  indexedDb: boolean | null,
  medianaMs: number | null,
  resumen: ResumenDiagnostico,
): Veredicto {
  const errors: string[] = []
  const avisos: string[] = []
  if (channel !== 'connected') errors.push('No hay conexión en tiempo real con el hub.')
  if (indexedDb === false) errors.push('Este navegador no puede guardar datos locales.')
  if (resumen.descartes > 0) avisos.push('El navegador recargó la página solo al volver.')
  if (resumen.ocultamientos.some((o) => o.conexionPerdida)) {
    avisos.push('En segundo plano se pierde la conexión (se recupera al volver).')
  }
  if (resumen.ocultamientos.some((o) => (o.recuperacionMs ?? 0) > RECUPERACION_IDEAL_MS)) {
    avisos.push(`Al volver tardó más de ${RECUPERACION_IDEAL_MS / 1000} s en reconectar.`)
  }
  if (medianaMs !== null && medianaMs >= LATENCIA_IDEAL_MS) {
    avisos.push('El tiempo de respuesta es alto: revisa la señal del Wi-Fi.')
  }

  if (errors.length > 0) {
    return {
      severity: 'error',
      titulo: `Revisar: ${plural(errors.length, 'punto', 'puntos')}`,
      puntos: errors,
    }
  }
  if (indexedDb === null || medianaMs === null || resumen.ocultamientos.length === 0) {
    return { severity: 'alert', titulo: 'Prueba en curso: sigue los pasos', puntos: avisos }
  }
  if (avisos.length > 0) {
    return { severity: 'alert', titulo: 'Funciona, con avisos', puntos: avisos }
  }
  return { severity: 'ok', titulo: 'Listo para operar', puntos: [] }
}

const claseVeredicto: Record<Veredicto['severity'], string> = {
  ok: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200',
  alert: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  error: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
}
const iconoVeredicto: Record<Veredicto['severity'], string> = { ok: '✓', alert: '⚠', error: '✕' }

const claseBoton =
  'min-h-12 rounded-lg px-4 font-semibold transition active:scale-[0.98] disabled:opacity-50'
const claseSecundario = `${claseBoton} bg-slate-200 dark:bg-slate-800`

export function Diagnostico() {
  const capacidades = detectarCapacidades()
  const { channel, latencia } = useConexionWs()
  const [indexedDb, setIndexedDb] = useState<boolean | null>(null)
  const [resumen, setResumen] = useState<ResumenDiagnostico>(() => resumirEventos([]))
  const [name, setNombre] = useState(leerNombre)
  const [envio, setEnvio] = useState<EstadoEnvio>('ready')
  const [confirmarBorrado, setConfirmarBorrado] = useState(false)
  const campoNombre = useRef<HTMLInputElement>(null)

  useEffect(() => {
    registrarCarga()
    purgarEventosAntiguos()
    probarIndexedDb().then(setIndexedDb)

    const actualizar = () => leerEventos().then((events) => setResumen(resumirEventos(events)))
    actualizar()
    const intervalo = setInterval(actualizar, INTERVALO_RESUMEN_MS)
    return () => clearInterval(intervalo)
  }, [])

  function cambiarNombre(value: string) {
    setNombre(value)
    if (envio === 'missing-name') setEnvio('ready')
    try {
      localStorage.setItem(CLAVE_NOMBRE, value)
    } catch {
      // Sin almacenamiento local el nombre solo vive en esta pantalla.
    }
  }

  async function send() {
    if (name.trim() === '') {
      setEnvio('missing-name')
      campoNombre.current?.focus()
      return
    }
    setEnvio('enviando')
    try {
      const events = await leerEventos()
      const res = await fetch('/api/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          navegador: navigator.userAgent,
          screen: `${screen.width}x${screen.height}`,
          capacidades,
          indexedDb,
          latencia,
          resumen: resumirEventos(events),
          events,
        }),
      })
      setEnvio(res.ok ? 'sent' : 'error')
      if (res.ok) navigator.vibrate?.(100)
    } catch {
      setEnvio('error')
    }
  }

  async function erase() {
    await borrarEventos()
    setResumen(resumirEventos([]))
    setEnvio('ready')
    setConfirmarBorrado(false)
  }

  const veredicto = calcularVeredicto(channel, indexedDb, latencia?.medianaMs ?? null, resumen)
  const ultimo = resumen.ocultamientos.at(-1)

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
          className={`mb-4 rounded-lg p-4 ${claseVeredicto[veredicto.severity]}`}
          aria-live="polite"
        >
          <p className="text-lg font-semibold">
            <span aria-hidden="true">{iconoVeredicto[veredicto.severity]} </span>
            {veredicto.titulo}
          </p>
          {veredicto.puntos.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {veredicto.puntos.map((punto) => (
                <li key={punto}>{punto}</li>
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
            ref={campoNombre}
            value={name}
            onChange={(e) => cambiarNombre(e.target.value)}
            placeholder="Ej.: iPhone de caja, Android mesero 1"
            aria-invalid={envio === 'missing-name'}
            className="min-h-12 w-full rounded-lg border border-slate-400 bg-white px-3 placeholder:text-slate-500 dark:border-slate-600 dark:bg-slate-900"
          />
        </label>

        <h2 className="mt-2 font-semibold text-slate-600 dark:text-slate-400">
          Conexión con el hub
        </h2>
        <ul>
          <Fila titulo="Canal en tiempo real" {...textoCanal[channel]} />
          <Fila
            titulo="Tiempo de respuesta"
            severity={
              latencia === null
                ? 'measuring'
                : latencia.medianaMs < LATENCIA_IDEAL_MS
                  ? 'ok'
                  : 'alert'
            }
            text={
              latencia === null
                ? 'Midiendo'
                : `${latencia.medianaMs} ms (ideal: menos de ${LATENCIA_IDEAL_MS} ms)`
            }
          />
          <Fila
            titulo="Veces que se reconectó"
            severity="info"
            text={String(resumen.reconexiones)}
          />
          <Fila
            titulo="Última vez en segundo plano"
            severity={ultimo ? (ultimo.conexionPerdida ? 'alert' : 'ok') : 'info'}
            text={
              ultimo
                ? `${formatearDuracion(ultimo.duracionMs)}, ${
                    ultimo.recargada
                      ? 'la página se recargó'
                      : ultimo.conexionPerdida
                        ? 'se perdió la conexión'
                        : 'sin cortes'
                  }${
                    ultimo.conexionPerdida
                      ? ultimo.recuperacionMs === null
                        ? ' (aún reconectando)'
                        : ` (volvió en ${formatearDuracion(ultimo.recuperacionMs)})`
                      : ''
                  }`
                : 'Aún no ha pasado'
            }
          />
          <Fila
            titulo="El navegador recargó la página solo"
            severity={resumen.descartes === 0 ? 'ok' : 'alert'}
            text={`${plural(resumen.descartes, 'vez', 'veces')} en ${plural(resumen.cargas, 'carga', 'cargas')}`}
          />
        </ul>

        <h2 className="mt-6 font-semibold text-slate-600 dark:text-slate-400">
          Capacidades del navegador
        </h2>
        <ul>
          <Fila
            titulo="Datos locales (IndexedDB)"
            severity={indexedDb === null ? 'measuring' : indexedDb ? 'ok' : 'error'}
            text={indexedDb === null ? 'Probando' : indexedDb ? 'Funciona' : 'No funciona'}
          />
          <Fila
            titulo="Dirección segura (HTTPS)"
            severity={capacidades.contextoSeguro ? 'ok' : 'info'}
            text={
              capacidades.contextoSeguro
                ? 'Sí'
                : 'No: normal al abrir por IP; algunas funciones no estarán'
            }
          />
          <Fila
            titulo="Vibración"
            severity={capacidades.vibracion ? 'ok' : 'info'}
            text={capacidades.vibracion ? 'Disponible' : 'No disponible en este equipo'}
          />
          <Fila
            titulo="Mantener pantalla encendida"
            severity={capacidades.pantallaEncendida ? 'ok' : 'info'}
            text={capacidades.pantallaEncendida ? 'Disponible' : 'Se configura en el equipo'}
          />
          <Fila
            titulo="Notificaciones del sistema"
            severity={capacidades.notificaciones ? 'ok' : 'info'}
            text={capacidades.notificaciones ? 'Disponible' : 'No disponible (requiere HTTPS)'}
          />
        </ul>

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => navigator.vibrate?.(200)}
            disabled={!capacidades.vibracion}
            className={claseSecundario}
          >
            {capacidades.vibracion ? 'Probar vibración' : 'Vibración no disponible'}
          </button>
          <button type="button" onClick={sonar} className={claseSecundario}>
            Probar sonido
          </button>
        </div>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Si no suena, revisa que el equipo no esté en silencio.
        </p>

        <div className="mt-8 border-t border-slate-200 pt-4 dark:border-slate-800">
          {confirmarBorrado ? (
            <div className="rounded-lg bg-red-50 p-3 dark:bg-red-950">
              <p className="mb-3 font-medium">
                ¿Borrar los resultados guardados en este equipo? No se puede deshacer.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setConfirmarBorrado(false)}
                  className={claseSecundario}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={erase}
                  className={`${claseBoton} bg-red-700 text-white`}
                >
                  Borrar
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmarBorrado(true)}
              className={`${claseBoton} w-full text-red-700 underline dark:text-red-400`}
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
            disabled={envio === 'enviando'}
            className={`${claseBoton} w-full bg-blue-700 text-white`}
          >
            {envio === 'enviando' ? 'Enviando…' : 'Enviar resultados al hub'}
          </button>
          <p role="status" className="mt-2 min-h-6 text-center">
            {envio === 'sent' && '✓ Resultados enviados'}
            {envio === 'error' &&
              '✕ No llegó al hub. Revisa que el equipo esté en el Wi-Fi del local.'}
            {envio === 'missing-name' && 'Escribe un nombre para identificar este equipo.'}
          </p>
        </div>
      </footer>
    </div>
  )
}
