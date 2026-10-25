import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import type { Geometria, TipoElemento } from './motor'

// Lienzo del plano: dibuja el salón a escala del ancho disponible (1 cm del plano puede ser menos
// o más de 1 px). Lo comparten el editor y la vista de mesas. Las mesas y elementos son HTML
// (botones), no un canvas: así se tocan, se enfocan y los lee el lector de pantalla.

export interface Caja {
  x: number
  y: number
  ancho: number
  alto: number
}

/** La escala que hace caber la caja en el ancho del contenedor (sin agrandar de más). */
export function useEscala(caja: Caja, maxima = 1.5) {
  const ref = useRef<HTMLDivElement>(null)
  const [ancho, setAncho] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const medir = () => setAncho(el.clientWidth)
    medir()
    const observador = new ResizeObserver(medir)
    observador.observe(el)
    return () => observador.disconnect()
  }, [])
  const escala = ancho > 0 ? Math.min(maxima, ancho / caja.ancho) : 0
  return { ref, escala }
}

/** Estilo para poner algo con su geometría dentro del lienzo. */
export function posicion(g: Geometria, caja: Caja, escala: number): CSSProperties {
  return {
    position: 'absolute',
    left: (g.x - caja.x) * escala,
    top: (g.y - caja.y) * escala,
    width: g.ancho * escala,
    height: g.alto * escala,
    transform: g.rotacion ? `rotate(${g.rotacion}deg)` : undefined,
  }
}

export function Lienzo({
  caja,
  escala,
  refContenedor,
  etiqueta,
  children,
  alTocarFondo,
}: {
  caja: Caja
  escala: number
  refContenedor: React.RefObject<HTMLDivElement | null>
  etiqueta: string
  children: ReactNode
  alTocarFondo?: () => void
}) {
  return (
    <div ref={refContenedor} className="w-full">
      {/* Tocar el fondo solo quita la selección del editor; con el teclado se hace con Escape. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: ver arriba */}
      <section
        aria-label={etiqueta}
        className="relative overflow-hidden rounded-2xl border border-borde bg-superficie-2 [background-image:radial-gradient(var(--color-borde)_1px,transparent_1px)]"
        style={{
          height: Math.max(200, caja.alto * escala),
          backgroundSize: `${50 * escala}px ${50 * escala}px`,
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) alTocarFondo?.()
        }}
      >
        {escala > 0 && children}
      </section>
    </div>
  )
}

const CLASE_ELEMENTO: Record<TipoElemento, string> = {
  pared: 'bg-texto/70',
  puerta: 'border-2 border-dashed border-texto-suave bg-superficie',
  planta: 'rounded-full bg-libre-suave border-2 border-libre-fuerte/50',
  barra: 'rounded-lg bg-neutro-suave border-2 border-neutro-fuerte/40',
  texto: 'text-texto-suave',
}

/** Lo que no es mesa: decoración del plano, con su forma reconocible. */
export function FiguraElemento({
  tipo,
  texto,
  escala,
}: {
  tipo: TipoElemento
  texto: string | null
  escala: number
}) {
  return (
    <span
      className={`flex h-full w-full items-center justify-center overflow-hidden text-center ${CLASE_ELEMENTO[tipo]}`}
      style={tipo === 'texto' ? { fontSize: Math.max(14, 20 * escala) } : undefined}
    >
      {tipo === 'texto' ? (
        texto
      ) : tipo === 'barra' ? (
        <span className="text-sm">Mostrador</span>
      ) : null}
    </span>
  )
}
