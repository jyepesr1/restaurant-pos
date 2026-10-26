import type { PaginaCodigos } from './codificacion'
import { aLosLados, type Formato, type Linea, parrafo } from './documento'

// La precuenta en papel (tarea 1.6, brief §4.5): lo que lleva la mesa, el total, lo ya pagado, la
// propina sugerida y el total con propina. El hub arma `Precuenta` con los montos ya calculados
// por `@pos/core`; aquí solo se decide el orden y el estilo.

export interface LineaPrecuenta {
  quantity: number
  name: string
  /** Opciones elegidas (término, adicionales). */
  options: string[]
  /** Neto de la línea en pesos: con impuesto, sin lo anulado ni los descuentos. */
  value: number
}

export interface Precuenta {
  restaurant: string
  /** «Mesa 6», «Mesa 5 + 6», «Para llevar». */
  target: string
  order: number | null
  waiter: string
  /** Ya formateada en la zona horaria del restaurante. */
  time: string
  guests: number | null
  lines: LineaPrecuenta[]
  /**
   * El impuesto discriminado, por tipo y tarifa («INC 8 %»): base sin impuesto e impuesto en
   * pesos. Los exentos van con impuesto 0. Un hub de antes no lo manda.
   */
  taxes?: { name: string; base: number; value: number }[]
  total: number
  paid: number
  /** En una cuenta dividida, cuál y cuánto le toca. */
  check: { name: string; amount: number } | null
  /** Lo que se cobra sin propina: el saldo, o lo de la cuenta. */
  subtotal: number
  tip: number
  /** Puntos básicos (1000 = 10 %) si es la sugerida; null si el cliente pidió otra. */
  tasaPropina: number | null
}

/** $40.900, con punto de miles como en Colombia. */
export const pesos = (n: number) =>
  `${n < 0 ? '-' : ''}$${String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`

const percent = (bp: number) => `${bp / 100}`.replace('.', ',')

/** La precuenta partida en líneas para una impresora de ese ancho y esa tabla de caracteres. */
export function lineasPrecuenta(
  p: Precuenta,
  format: { columnas: number; pagina: PaginaCodigos },
): Linea[] {
  const f: Formato = format
  const data = [
    p.order ? `Pedido ${p.order}` : null,
    p.waiter || null,
    p.time,
    p.guests ? `${p.guests} pers.` : null,
  ].filter((d): d is string => !!d)

  const lines: Linea[] = [
    ...parrafo(p.restaurant, f, { large: true, centro: true }),
    ...parrafo('PRECUENTA', f, { reversed: true, centro: true, negrita: true }),
    { space: true },
    ...parrafo(p.target, f, { large: true }),
    ...parrafo(data.join(' · '), f),
    { separator: true },
  ]
  for (const l of p.lines) {
    lines.push(...aLosLados(`${l.quantity} x ${l.name}`, pesos(l.value), f))
    // Las opciones van sangradas bajo su plato (`partir` quita los espacios del comienzo).
    for (const opcion of l.options)
      for (const line of parrafo(opcion, { ...f, columnas: f.columnas - 2 }))
        if ('text' in line) lines.push({ ...line, text: `  ${line.text}` })
  }
  lines.push({ separator: true })
  const taxes = p.taxes ?? []
  if (taxes.length > 0) {
    lines.push(...aLosLados('Base sin impuestos', pesos(taxes.reduce((a, i) => a + i.base, 0)), f))
    for (const i of taxes) if (i.value > 0) lines.push(...aLosLados(i.name, pesos(i.value), f))
  }
  lines.push(...aLosLados('Total', pesos(p.total), f, { negrita: true }))
  if (p.paid > 0) {
    lines.push(...aLosLados('Ya pagado', `-${pesos(p.paid)}`, f))
    lines.push(...aLosLados('Saldo', pesos(p.total - p.paid), f, { negrita: true }))
  }
  if (p.check) {
    lines.push({ separator: true })
    lines.push(...aLosLados(p.check.name, pesos(p.check.amount), f, { negrita: true }))
  }
  if (p.tip > 0) {
    lines.push(
      ...aLosLados(
        p.tasaPropina === null ? 'Propina' : `Propina sugerida (${percent(p.tasaPropina)} %)`,
        pesos(p.tip),
        f,
      ),
      ...aLosLados('Total con propina', pesos(p.subtotal + p.tip), f, {
        large: true,
      }),
    )
  } else {
    lines.push(...aLosLados('A pagar', pesos(p.subtotal), f, { large: true }))
  }
  lines.push(
    { separator: true },
    ...parrafo('La propina es voluntaria.', f, { centro: true }),
    ...parrafo('Esta precuenta no es una factura.', f, { centro: true }),
  )
  return lines
}

/** «INC 8 %», «IVA 19 %», «Exento». */
export function nombreImpuesto(type: 'inc' | 'iva' | 'exempt', rate: number): string {
  if (type === 'exempt' || rate === 0) return 'Exento'
  return `${type.toUpperCase()} ${percent(rate)} %`
}
