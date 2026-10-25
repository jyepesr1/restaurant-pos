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
        className="relative overflow-hidden rounded-2xl border border-linea bg-superficie [background-image:radial-gradient(var(--color-linea)_1.5px,transparent_1.5px)]"
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

/**
 * Las sillas alrededor de una mesa, según sus puestos: en círculo si es redonda, a lo largo de los
 * lados largos (y una en cada cabecera si caben) si es cuadrada o rectangular, y todas al frente
 * si es un puesto de barra. Son dibujo: el botón de la mesa dice los puestos al lector.
 */
export function Sillas({
  forma,
  ancho,
  alto,
  puestos,
  clase,
}: {
  forma: string
  /** Medidas de la mesa en pantalla (px). */
  ancho: number
  alto: number
  puestos: number
  clase: string
}) {
  if (puestos <= 0) return null
  const largo = Math.max(8, Math.min(26, Math.min(ancho, alto) * 0.32))
  const fondo = Math.max(5, largo * 0.42)
  const aire = Math.max(3, largo * 0.18)
  const sillas: { x: number; y: number; giro: number }[] = []
  if (forma === 'redonda') {
    const radio = Math.max(ancho, alto) / 2 + aire + fondo / 2
    for (let i = 0; i < puestos; i++) {
      const angulo = -Math.PI / 2 + (2 * Math.PI * i) / puestos
      sillas.push({
        x: ancho / 2 + radio * Math.cos(angulo),
        y: alto / 2 + radio * Math.sin(angulo),
        giro: (angulo * 180) / Math.PI + 90,
      })
    }
  } else if (forma === 'barra') {
    for (let i = 0; i < puestos; i++)
      sillas.push({ x: (ancho * (i + 0.5)) / puestos, y: alto + aire + fondo / 2, giro: 0 })
  } else {
    const horizontal = ancho >= alto
    const [lado, cabecera] = horizontal ? [ancho, alto] : [alto, ancho]
    const cabeceras = puestos >= 6 && cabecera >= largo * 1.3 ? 2 : 0
    const enLados = puestos - cabeceras
    const arriba = Math.ceil(enLados / 2)
    const abajo = enLados - arriba
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
    fila(arriba, false)
    fila(abajo, true)
    if (cabeceras) {
      const medio = cabecera / 2
      const antes = -aire - fondo / 2
      const despues = lado + aire + fondo / 2
      sillas.push(
        horizontal ? { x: antes, y: medio, giro: 270 } : { x: medio, y: antes, giro: 0 },
        horizontal ? { x: despues, y: medio, giro: 90 } : { x: medio, y: despues, giro: 180 },
      )
    }
  }
  return (
    <>
      {sillas.map((s) => (
        <span
          key={`${s.x.toFixed(1)}-${s.y.toFixed(1)}`}
          aria-hidden="true"
          className={`pointer-events-none absolute rounded-md ${clase}`}
          style={{
            width: largo,
            height: fondo,
            left: s.x - largo / 2,
            top: s.y - fondo / 2,
            transform: `rotate(${s.giro}deg)`,
          }}
        />
      ))}
    </>
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
