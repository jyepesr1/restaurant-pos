import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Icono } from './iconos'

// Avisos con "Deshacer" (brief §5, regla 5): lo que no es destructivo ni de dinero no pide
// confirmación; se hace de una vez y se puede deshacer durante unos segundos. Se ven hasta tres a
// la vez, cada uno con su Deshacer: quitar dos ítems seguidos no hace perder el primero. Mientras
// el dedo, el mouse o el foco están sobre un aviso, no corre su tiempo.

export const DURACION_AVISO_MS = 5000
const MAXIMO = 3

interface Aviso {
  id: number
  text: string
  undo?: () => void
}

type Avisar = (text: string, undo?: () => void) => void

const Contexto = createContext<Avisar | null>(null)

/** `avisar("Quitaste Aperol Spritz", () => volverAAgregarlo())`. */
export function useAvisar(): Avisar {
  const avisar = useContext(Contexto)
  if (!avisar) throw new Error('useAvisar necesita <ProveedorAvisos> más arriba')
  return avisar
}

export function ProveedorAvisos({ children }: { children: ReactNode }) {
  const [avisos, setAvisos] = useState<Aviso[]>([])
  const next = useRef(0)

  const avisar = useCallback<Avisar>((text, undo) => {
    next.current += 1
    const alert = { id: next.current, text, undo }
    setAvisos((a) => [...a, alert].slice(-MAXIMO))
  }, [])
  const remove = useCallback((id: number) => setAvisos((a) => a.filter((x) => x.id !== id)), [])

  return (
    <Contexto.Provider value={avisar}>
      {children}
      {/* En el celular, encima de la barra inferior (Pedido · Enviar): nunca la tapa. En tablet y
          caja, abajo a la izquierda, junto a la barra lateral: lejos del panel del pedido y su
          Enviar, a la derecha. */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 md:right-auto md:bottom-4 md:left-24 md:items-start md:px-0 lg:left-72"
        aria-live="polite"
      >
        {avisos.map((a) => (
          <TarjetaAviso key={a.id} alert={a} alTerminar={() => remove(a.id)} />
        ))}
      </div>
    </Contexto.Provider>
  )
}

function TarjetaAviso({ alert, alTerminar }: { alert: Aviso; alTerminar: () => void }) {
  const [pausado, setPausado] = useState(false)
  const restante = useRef(DURACION_AVISO_MS)
  const terminar = useRef(alTerminar)
  terminar.current = alTerminar

  useEffect(() => {
    if (pausado) return
    const start = Date.now()
    const t = setTimeout(() => terminar.current(), restante.current)
    return () => {
      clearTimeout(t)
      restante.current -= Date.now() - start
    }
  }, [pausado])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: solo pausa el tiempo; no es un control
    <div
      className="pointer-events-auto relative flex w-full max-w-md items-center gap-3 overflow-hidden rounded-2xl bg-neutro-texto py-2 pr-2 pl-4 text-superficie shadow-xl"
      onPointerEnter={() => setPausado(true)}
      onPointerLeave={() => setPausado(false)}
      onFocus={() => setPausado(true)}
      onBlur={() => setPausado(false)}
    >
      <Icono name="check" />
      <span className="flex-1">{alert.text}</span>
      {alert.undo && (
        <button
          type="button"
          className="inline-flex min-h-12 items-center gap-2 rounded-xl px-3 font-bold hover:bg-white/10 focus-visible:outline-3 focus-visible:outline-foco"
          onClick={() => {
            alert.undo?.()
            alTerminar()
          }}
        >
          <Icono name="undo" />
          Deshacer
        </button>
      )}
      <span
        className="aviso-tiempo absolute bottom-0 left-0 h-1 bg-accion-fuerte"
        style={{
          animationDuration: `${DURACION_AVISO_MS}ms`,
          animationPlayState: pausado ? 'paused' : 'running',
        }}
      />
    </div>
  )
}
