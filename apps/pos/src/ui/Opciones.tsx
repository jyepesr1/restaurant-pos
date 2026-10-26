import type { ReactNode } from 'react'
import { Icono } from './iconos'

// Opciones que se eligen tocando (categoría, medio de pago, para quién es un ítem). Lo elegido se
// nota por el color y también por el ✓ y el borde: nunca solo por el color (brief §5, regla 11).

/** Un grupo de opciones con su nombre para el lector de pantalla. */
export function Grupo({
  etiqueta,
  className = '',
  children,
}: {
  etiqueta: string
  className?: string
  children: ReactNode
}) {
  return (
    <fieldset className={`m-0 min-w-0 border-0 p-0 ${className}`}>
      <legend className="sr-only">{etiqueta}</legend>
      {children}
    </fieldset>
  )
}

export function Opcion({
  elegida,
  alElegir,
  shape = 'pastilla',
  detalle,
  etiqueta,
  children,
}: {
  elegida: boolean
  alElegir: () => void
  /** Pastilla (filtros, categorías) o tarjeta (opciones con precio). */
  shape?: 'pastilla' | 'card'
  detalle?: string
  /** Nombre para el lector de pantalla si el texto visible no basta. */
  etiqueta?: string
  children: ReactNode
}) {
  const base =
    'inline-flex shrink-0 items-center gap-2 border-2 font-semibold transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foco'
  const color = elegida
    ? 'border-accion-fuerte bg-accion-fuerte text-white'
    : 'border-borde bg-superficie text-texto'
  const size =
    shape === 'pastilla'
      ? 'min-h-12 min-w-12 rounded-full px-4'
      : 'min-h-14 w-full rounded-xl px-3 py-2 text-left'
  return (
    <button
      type="button"
      aria-pressed={elegida}
      aria-label={etiqueta}
      onClick={alElegir}
      className={`${base} ${color} ${size}`}
    >
      {elegida && <Icono name="check" />}
      <span className="flex flex-1 flex-col">
        <span>{children}</span>
        {detalle && <span className="cifras text-sm font-normal">{detalle}</span>}
      </span>
    </button>
  )
}
