import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Icono } from './iconos'

// Teclado del PIN (ADR-008: solo PIN, 4 dígitos). Al cuarto dígito se envía solo: un toque menos.
// Teclas grandes (64 px) para usarlo con una mano. También acepta el teclado físico de la caja.

export const DIGITOS = 4

export function TecladoPin({
  title = 'Escribe tu PIN',
  error,
  attempt = 0,
  waitMs = 0,
  taken = false,
  alCompletar,
}: {
  title?: string
  /** Mensaje del último intento fallido. */
  error?: string | null
  /** Cambia en cada intento fallido: así dos errores iguales seguidos también se notan. */
  attempt?: number
  /** Mientras dure, el teclado no acepta nada (espera tras errores, ADR-008). */
  waitMs?: number
  /** Esperando la respuesta del hub. */
  taken?: boolean
  /** Se llama una sola vez por PIN completo. */
  alCompletar: (pin: string) => void
}) {
  const idTitulo = useId()
  const [pin, setPin] = useState('')
  const [restante, setRestante] = useState(waitMs)
  const blocked = taken || restante > 0
  // El PIN en curso, fuera del estado de React: así el envío no depende de cuántas veces React
  // ejecute un actualizador (en desarrollo lo hace dos veces).
  const inProgress = useRef('')

  // biome-ignore lint/correctness/useExhaustiveDependencies: `intento` reinicia la espera aunque dure lo mismo
  useEffect(() => {
    setRestante(waitMs)
    if (waitMs <= 0) return
    const end = Date.now() + waitMs
    const intervalo = setInterval(() => {
      const queda = Math.max(0, end - Date.now())
      setRestante(queda)
      if (queda === 0) clearInterval(intervalo)
    }, 250)
    return () => clearInterval(intervalo)
  }, [waitMs, attempt])

  const tocar = useCallback(
    (digito: string) => {
      if (blocked || inProgress.current.length >= DIGITOS) return
      const fresh = inProgress.current + digito
      if (fresh.length === DIGITOS) {
        // Se envía y queda listo para el próximo intento.
        inProgress.current = ''
        setPin('')
        alCompletar(fresh)
        return
      }
      inProgress.current = fresh
      setPin(fresh)
    },
    [alCompletar, blocked],
  )
  const erase = useCallback(() => {
    if (blocked) return
    inProgress.current = inProgress.current.slice(0, -1)
    setPin(inProgress.current)
  }, [blocked])

  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      if (/^[0-9]$/.test(e.key)) tocar(e.key)
      else if (e.key === 'Backspace') erase()
    }
    window.addEventListener('keydown', alTeclear)
    return () => window.removeEventListener('keydown', alTeclear)
  }, [tocar, erase])

  const tecla =
    'flex h-16 items-center justify-center rounded-2xl bg-superficie-2 text-2xl font-semibold text-texto active:scale-95 transition disabled:opacity-45 focus-visible:outline-3 focus-visible:outline-foco'
  const segundos = Math.ceil(restante / 1000)

  return (
    <div className="mx-auto w-full max-w-xs">
      <p className="text-center text-lg font-semibold" id={idTitulo}>
        {title}
      </p>
      <output className="my-5 flex justify-center gap-4" aria-labelledby={idTitulo}>
        <span className="sr-only">{`${pin.length} de ${DIGITOS} dígitos`}</span>
        {Array.from({ length: DIGITOS }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: posiciones fijas del PIN
            key={i}
            className={`size-4 rounded-full border-2 ${i < pin.length ? 'border-accion-fuerte bg-accion-fuerte' : 'border-borde'}`}
          />
        ))}
      </output>
      {/* Solo se anuncia el cambio de mensaje, no cada segundo de la cuenta atrás. */}
      {/* `key`: el mismo error dos veces seguidas también se anuncia. */}
      <p key={attempt} className="min-h-6 text-center text-alerta-texto" role="alert">
        {restante > 0 ? 'Demasiados intentos.' : taken ? 'Comprobando…' : (error ?? '')}
      </p>
      <p className="cifras min-h-6 text-center text-texto-suave" aria-hidden="true">
        {restante > 0 ? `Espera ${segundos} s` : ''}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            type="button"
            className={tecla}
            disabled={blocked}
            onClick={() => tocar(d)}
          >
            {d}
          </button>
        ))}
        <span />
        <button type="button" className={tecla} disabled={blocked} onClick={() => tocar('0')}>
          0
        </button>
        <button
          type="button"
          className={tecla}
          disabled={blocked || pin.length === 0}
          onClick={erase}
          aria-label="Borrar el último dígito"
        >
          <Icono name="erase" />
        </button>
      </div>
    </div>
  )
}
