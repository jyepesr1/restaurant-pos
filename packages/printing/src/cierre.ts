import type { PaginaCodigos } from './codificacion'
import { aLosLados, type Estilo, type Formato, type Linea, parrafo } from './documento'
import { pesos } from './precuenta'

// El cierre Z en papel (tarea 1.9, docs/KPIS.md#cierre-z-impreso): el cuadre del turno, las ventas
// del día operativo, lo cobrado por medio y lo anulado. Sale en la impresora de precuentas al
// cerrar la caja y se puede reimprimir desde Reportes. El hub arma `CierreZ` con los montos ya
// calculados por `@pos/core`; aquí solo se decide el orden y el estilo.

export interface MedioCierreZ {
  name: string
  /** Lo registrado en el sistema (venta + propina). */
  expected: number
  /** Lo que dice el cierre del datáfono o la app. */
  reported: number
  variance: number
}

export interface CierreZ {
  restaurant: string
  /** El día operativo, ya en palabras («sábado 24 de octubre de 2026»). */
  day: string
  /** Horas ya formateadas en la zona horaria del restaurante. */
  opened: string
  closed: string
  abrio: string
  cerro: string
  cash: {
    base: number
    charged: number
    refunds: number
    entries: number
    outflows: number
    tipPayouts: number
    expected: number
    counted: number
    variance: number
  }
  otherMethods: MedioCierreZ[]
  justification: string | null
  /** Lo cobrado en el turno, por medio de pago. */
  charged: { name: string; sale: number; tip: number }[]
  /** Las ventas de todo el día operativo (no solo del turno). */
  sales: {
    net: number
    taxes: { name: string; base: number; value: number }[]
    tips: number
    checks: number
    guests: number
    averageTicket: number
    /** Ajuste por redondeo del efectivo: lo cobrado de más o de menos al redondear. */
    settings?: number
    voided: number
    canceled: number
    discounts: number
  }
  /** Hora de la reimpresión, si lo es. */
  reprinted: string | null
}

/** «Cuadra», «Sobran $1.000» o «Faltan $1.000», como en la pantalla de la caja. */
const enPalabras = (n: number) =>
  n === 0 ? 'Cuadra' : n > 0 ? `Sobran ${pesos(n)}` : `Faltan ${pesos(-n)}`

/** El cierre Z partido en líneas para una impresora de ese ancho y esa tabla de caracteres. */
export function lineasCierreZ(
  z: CierreZ,
  format: { columnas: number; pagina: PaginaCodigos },
): Linea[] {
  const f: Formato = format
  const fila = (izquierda: string, derecha: string, estilo: Estilo = {}) =>
    aLosLados(izquierda, derecha, f, estilo)
  const titulo = (text: string) => [
    { separator: true } as Linea,
    ...parrafo(text, f, { negrita: true }),
  ]
  const e = z.cash
  const lines: Linea[] = [
    ...parrafo(z.restaurant, f, { large: true, centro: true }),
    ...parrafo('CIERRE DE CAJA', f, { reversed: true, centro: true, negrita: true }),
    ...(z.reprinted ? parrafo(`Reimpresión ${z.reprinted}`, f, { centro: true }) : []),
    { space: true },
    ...parrafo(z.day, f, { negrita: true }),
    ...parrafo(`Abrió ${z.abrio} · ${z.opened}`, f),
    ...parrafo(`Cerró ${z.cerro} · ${z.closed}`, f),

    ...titulo('Efectivo'),
    ...fila('Base', pesos(e.base)),
    ...fila('Cobrado', pesos(e.charged)),
  ]
  if (e.refunds) lines.push(...fila('Devoluciones', `-${pesos(e.refunds)}`))
  if (e.entries) lines.push(...fila('Entradas', pesos(e.entries)))
  if (e.outflows) lines.push(...fila('Salidas', `-${pesos(e.outflows)}`))
  if (e.tipPayouts) lines.push(...fila('Pago de propinas', `-${pesos(e.tipPayouts)}`))
  lines.push(
    ...fila('Esperado', pesos(e.expected), { negrita: true }),
    ...fila('Contado', pesos(e.counted), { negrita: true }),
    ...fila('Diferencia', enPalabras(e.variance), { negrita: true }),
  )

  if (z.otherMethods.length > 0) {
    lines.push(...titulo('Otros medios (según sistema / según cierre)'))
    for (const m of z.otherMethods) {
      lines.push(...fila(m.name, `${pesos(m.expected)} / ${pesos(m.reported)}`))
      if (m.variance !== 0) lines.push(...fila('  Diferencia', enPalabras(m.variance)))
    }
  }
  if (z.justification) lines.push(...titulo('Justificación'), ...parrafo(z.justification, f))

  if (z.charged.length > 0) {
    lines.push(...titulo('Cobrado en el turno'))
    for (const m of z.charged) {
      lines.push(...fila(m.name, pesos(m.sale + m.tip)))
      if (m.tip !== 0) lines.push(...fila('  de propina', pesos(m.tip)))
    }
  }

  const v = z.sales
  lines.push(...titulo('Ventas del día'), ...fila('Ventas', pesos(v.net), { negrita: true }))
  if (v.taxes.length > 0) {
    lines.push(...fila('Base sin impuestos', pesos(v.taxes.reduce((a, i) => a + i.base, 0))))
    for (const i of v.taxes) if (i.value > 0) lines.push(...fila(i.name, pesos(i.value)))
  }
  lines.push(
    ...(v.settings ? fila('Ajuste por redondeo', pesos(v.settings)) : []),
    ...fila('Propinas', pesos(v.tips)),
    ...fila('Cuentas', String(v.checks)),
    ...fila('Comensales', String(v.guests)),
    ...fila('Ticket promedio', pesos(v.averageTicket)),
  )
  if (v.voided || v.canceled || v.discounts) {
    lines.push(...titulo('Anulado y descontado'))
    if (v.voided) lines.push(...fila('Productos anulados', pesos(v.voided)))
    if (v.canceled) lines.push(...fila('Pedidos cancelados', pesos(v.canceled)))
    if (v.discounts) lines.push(...fila('Descuentos', pesos(v.discounts)))
  }
  lines.push(
    { separator: true },
    { space: true },
    ...parrafo('Firma cajero', f),
    { space: true },
    { space: true },
    ...parrafo('Firma de quien recibe', f),
  )
  return lines
}
