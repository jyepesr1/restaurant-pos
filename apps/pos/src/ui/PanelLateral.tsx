import { type ReactNode, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Boton } from './Boton'

// Panel lateral (brief §5, regla 2: los modificadores van en un panel, no en ventanas en
// cascada). En el celular sube desde abajo y se alcanza con el pulgar; en tablet y caja sale por
// la derecha y deja ver el pedido. Se cierra con Escape, con la X o tocando fuera.
//
// Es modal de verdad: mientras está abierto, la página de atrás queda inerte (no recibe foco ni
// toques ni la lee el lector de pantalla) y no se desplaza.

// Puede haber un panel encima de otro (el pedido y, sobre él, un ítem): Escape cierra solo el
// de arriba, y el fondo se libera cuando se cierra el último.
const pila: object[] = []
let desplazamientoPrevio = ''

function bloquearFondo(panel: object) {
  pila.push(panel)
  if (pila.length > 1) return
  document.getElementById('raiz')?.setAttribute('inert', '')
  desplazamientoPrevio = document.body.style.overflow
  document.body.style.overflow = 'hidden'
}

function liberarFondo(panel: object) {
  const i = pila.lastIndexOf(panel)
  if (i >= 0) pila.splice(i, 1)
  if (pila.length > 0) return
  document.getElementById('raiz')?.removeAttribute('inert')
  document.body.style.overflow = desplazamientoPrevio
}

export function PanelLateral({
  abierto,
  titulo,
  alCerrar,
  pie,
  children,
}: {
  abierto: boolean
  titulo: string
  alCerrar: () => void
  /** Acciones fijas abajo (p. ej. "Agregar"). */
  pie?: ReactNode
  children: ReactNode
}) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  // Quien llama suele pasar una función nueva en cada render: si el efecto dependiera de ella, se
  // repetiría con cada tecla y el campo que se está escribiendo perdería el foco.
  const cerrar = useRef(alCerrar)
  cerrar.current = alCerrar

  useEffect(() => {
    if (!abierto) return
    const previo = document.activeElement as HTMLElement | null
    const este = {}
    bloquearFondo(este)
    panel.current?.focus()
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && pila.at(-1) === este) cerrar.current()
    }
    window.addEventListener('keydown', alTeclear)
    return () => {
      window.removeEventListener('keydown', alTeclear)
      liberarFondo(este)
      previo?.focus()
    }
  }, [abierto])

  if (!abierto) return null
  return createPortal(
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        aria-label="Cerrar"
        tabIndex={-1}
        className="absolute inset-0 bg-black/40"
        onClick={() => cerrar.current()}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col rounded-t-3xl bg-superficie shadow-2xl outline-none md:inset-y-0 md:right-0 md:left-auto md:max-h-none md:w-[26rem] md:rounded-none md:rounded-l-3xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-borde p-3 pl-5">
          <h2 id={id} className="text-xl font-semibold">
            {titulo}
          </h2>
          <Boton
            variante="fantasma"
            icono="cerrar"
            aria-label="Cerrar"
            onClick={() => cerrar.current()}
          />
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {pie && <div className="border-t border-borde p-4">{pie}</div>}
      </div>
    </div>,
    document.body,
  )
}
