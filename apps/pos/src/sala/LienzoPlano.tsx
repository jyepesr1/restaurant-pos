import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import type { Geometria, TipoElemento } from './motor'

// Lienzo del plano: dibuja el salón a escala del ancho disponible (1 cm del plano puede ser menos
// o más de 1 px). Lo comparten el editor y la vista de mesas. Las mesas y elementos son HTML
// (botones), no un canvas: así se tocan, se enfocan y los lee el lector de pantalla.

export interface Caja {
  x: number
  y: number
  width: number
  height: number
}

/** La escala que hace caber la caja en el ancho del contenedor (sin agrandar de más). */
export function useEscala(register: Caja, maxima = 1.5) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setAncho] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setAncho(el.clientWidth)
    measure()
    const observador = new ResizeObserver(measure)
    observador.observe(el)
    return () => observador.disconnect()
  }, [])
  const escala = width > 0 ? Math.min(maxima, width / register.width) : 0
  return { ref, escala }
}

/** Estilo para poner algo con su geometría dentro del lienzo. */
export function posicion(g: Geometria, register: Caja, escala: number): CSSProperties {
  return {
    position: 'absolute',
    left: (g.x - register.x) * escala,
    top: (g.y - register.y) * escala,
    width: g.width * escala,
    height: g.height * escala,
    transform: g.rotation ? `rotate(${g.rotation}deg)` : undefined,
  }
}

export function Lienzo({
  register,
  escala,
  refContenedor,
  etiqueta,
  children,
  alTocarFondo,
}: {
  register: Caja
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
        className="relative overflow-hidden rounded-2xl border border-linea bg-superficie [background-image:radial-gradient(var(--color-linea)_1.5px,transparent_1.5px)]"
        style={{
          height: Math.max(200, register.height * escala),
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

/**
 * Las sillas alrededor de una mesa, según sus puestos: en círculo si es redonda, a lo largo de los
 * lados largos (y una en cada cabecera si caben) si es cuadrada o rectangular, y todas al frente
 * si es un puesto de barra. Son dibujo: el botón de la mesa dice los puestos al lector.
 */
export function Sillas({
  shape,
  width,
  height,
  places,
  cssClass,
}: {
  shape: string
  /** Medidas de la mesa en pantalla (px). */
  width: number
  height: number
  places: number
  cssClass: string
}) {
  if (places <= 0) return null
  const length = Math.max(8, Math.min(26, Math.min(width, height) * 0.32))
  const fondo = Math.max(5, length * 0.42)
  const aire = Math.max(3, length * 0.18)
  const sillas: { x: number; y: number; giro: number }[] = []
  if (shape === 'round') {
    const radio = Math.max(width, height) / 2 + aire + fondo / 2
    for (let i = 0; i < places; i++) {
      const angulo = -Math.PI / 2 + (2 * Math.PI * i) / places
      sillas.push({
        x: width / 2 + radio * Math.cos(angulo),
        y: height / 2 + radio * Math.sin(angulo),
        giro: (angulo * 180) / Math.PI + 90,
      })
    }
  } else if (shape === 'bar') {
    for (let i = 0; i < places; i++)
      sillas.push({ x: (width * (i + 0.5)) / places, y: height + aire + fondo / 2, giro: 0 })
  } else {
    const horizontal = width >= height
    const [lado, cabecera] = horizontal ? [width, height] : [height, width]
    const cabeceras = places >= 6 && cabecera >= length * 1.3 ? 2 : 0
    const enLados = places - cabeceras
    const above = Math.ceil(enLados / 2)
    const below = enLados - above
    const fila = (cuantas: number, lejos: boolean) => {
      for (let i = 0; i < cuantas; i++) {
        const a = (lado * (i + 0.5)) / cuantas
        const b = lejos ? cabecera + aire + fondo / 2 : -aire - fondo / 2
        sillas.push(
          horizontal
            ? { x: a, y: b, giro: lejos ? 180 : 0 }
            : { x: b, y: a, giro: lejos ? 90 : 270 },
        )
      }
    }
    fila(above, false)
    fila(below, true)
    if (cabeceras) {
      const method = cabecera / 2
      const before = -aire - fondo / 2
      const after = lado + aire + fondo / 2
      sillas.push(
        horizontal ? { x: before, y: method, giro: 270 } : { x: method, y: before, giro: 0 },
        horizontal ? { x: after, y: method, giro: 90 } : { x: method, y: after, giro: 180 },
      )
    }
  }
  return (
    <>
      {sillas.map((s) => (
        <span
          key={`${s.x.toFixed(1)}-${s.y.toFixed(1)}`}
          aria-hidden="true"
          className={`pointer-events-none absolute rounded-md ${cssClass}`}
          style={{
            width: length,
            height: fondo,
            left: s.x - length / 2,
            top: s.y - fondo / 2,
            transform: `rotate(${s.giro}deg)`,
          }}
        />
      ))}
    </>
  )
}

const CLASE_ELEMENTO: Record<TipoElemento, string> = {
  wall: 'bg-texto/70',
  door: 'border-2 border-dashed border-texto-suave bg-superficie',
  plant: 'rounded-full bg-libre-suave border-2 border-libre-fuerte/50',
  bar: 'rounded-lg bg-neutro-suave border-2 border-neutro-fuerte/40',
  text: 'text-texto-suave',
}

/** Lo que no es mesa: decoración del plano, con su forma reconocible. */
export function FiguraElemento({
  type,
  text,
  escala,
}: {
  type: TipoElemento
  text: string | null
  escala: number
}) {
  return (
    <span
      className={`flex h-full w-full items-center justify-center overflow-hidden text-center ${CLASE_ELEMENTO[type]}`}
      style={type === 'text' ? { fontSize: Math.max(14, 20 * escala) } : undefined}
    >
      {type === 'text' ? text : type === 'bar' ? <span className="text-sm">Mostrador</span> : null}
    </span>
  )
}
