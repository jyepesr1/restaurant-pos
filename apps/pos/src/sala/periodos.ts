import type { PaymentMethod } from '@pos/core'
import type { ReglasCobro } from './cuentas'
import { methodName } from './cuentas'
import type { Reporte } from './motor'

// Lo que calcula la pantalla Reportes (tarea 1.9) sin dibujar nada: los períodos que se eligen
// con un toque, las fechas en palabras y el CSV para Excel (docs/KPIS.md#exportar).

export type Atajo = 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth'

/** El período más largo que da el hub (`MAX_DIAS_REPORTE`). */
export const MAX_DIAS = 62

export interface Periodo {
  from: string
  until: string
}

/** El día operativo `dias` antes o después (AAAA-MM-DD, sin zona horaria). */
export function sumarDias(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Hoy, ayer, los últimos 7 días, este mes (hasta hoy) o el mes pasado, desde el día operativo de hoy. */
export function periodoDe(atajo: Atajo, today: string): Periodo {
  if (atajo === 'yesterday') return { from: sumarDias(today, -1), until: sumarDias(today, -1) }
  if (atajo === 'week') return { from: sumarDias(today, -6), until: today }
  const firstOne = `${today.slice(0, 8)}01`
  if (atajo === 'month') return { from: firstOne, until: today }
  if (atajo === 'lastMonth') {
    const latest = sumarDias(firstOne, -1)
    return { from: `${latest.slice(0, 8)}01`, until: latest }
  }
  return { from: today, until: today }
}

const format = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('es-CO', { ...options, timeZone: 'UTC' })
const aFecha = (day: string) => new Date(`${day}T12:00:00Z`)

/** «sábado, 24 de octubre de 2026» o «del 18–24 de octubre de 2026». */
export function periodoEnPalabras({ from, until }: Periodo): string {
  if (from === until)
    return format({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
      aFecha(from),
    )
  return `del ${format({ day: 'numeric', month: 'long', year: 'numeric' }).formatRange(
    aFecha(from),
    aFecha(until),
  )}`
}

/** «2026-10-24 20:15» en la zona del restaurante: Excel lo lee como fecha y hora. */
export function fechaHoraCsv(iso: string, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: timeZone,
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  )
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/** «24 oct.», para las filas de un período de varios días. */
export const diaCorto = (day: string) =>
  format({ day: 'numeric', month: 'short' }).format(aFecha(day))

/** Puntos básicos en porcentaje con coma: 1250 → «12,5 %». */
export const puntosEnPorcentaje = (bp: number) => `${(bp / 100).toLocaleString('es-CO')} %`

/** Porcentaje con un decimal, solo para mostrar (KPIS.md#por-producto). */
export function percent(share: number, total: number): string {
  if (total === 0) return '0 %'
  return `${(Math.round((share * 1000) / total) / 10).toLocaleString('es-CO')} %`
}

// ── CSV ────────────────────────────────────────────────────────────────

/**
 * Una celda del CSV. El texto que empieza con = + - @ va con un apóstrofo para que Excel no lo
 * tome como fórmula (un producto llamado «=HYPERLINK(…)» no se ejecuta al abrir el archivo).
 */
export function celda(value: string | number): string {
  if (typeof value === 'number') return String(value)
  const seguro = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[;"\n\r]/.test(seguro) ? `"${seguro.replaceAll('"', '""')}"` : seguro
}

const filaCsv = (values: (string | number)[]) => values.map(celda).join(';')

const NOMBRE_REGLA = { percent: 'Porcentaje', value: 'Valor', comp: 'Cortesía' } as const

/**
 * El reporte en CSV para Excel: separado por punto y coma, UTF-8 con BOM y montos enteros en
 * pesos, sin separador de miles. Una sección tras otra, con una línea en blanco entre ellas.
 */
export function csvDeReporte(
  r: Reporte,
  period: Periodo,
  reglas: ReglasCobro | null,
  restaurant: string,
): string {
  const { report: inf } = r
  const v = inf.sales
  const quien = (id: string | null) => (id ? (r.usuarios[id] ?? '') : '')
  const time = (iso: string) => fechaHoraCsv(iso, reglas?.timeZone ?? 'America/Bogota')
  const order = (n: number | null) => (n === null ? '' : n)
  const method = (m: { method: PaymentMethod; customMethodId: string | null }) =>
    methodName(m.method, m.customMethodId, reglas)
  const sections: (string | number)[][][] = [
    [
      ['Reporte', restaurant],
      ['Desde', period.from],
      ['Hasta', period.until],
    ],
    [
      ['Ventas', 'Pesos'],
      ['Bruto', v.gross],
      ['Anulado', v.voided],
      ['Descuentos', v.discounts],
      ['Neto', v.net],
      ['Ajuste por redondeo', v.settings],
      ...v.taxes.flatMap((i) => [
        [`Base ${i.type.toUpperCase()} ${puntosEnPorcentaje(i.rate)}`, i.base],
        [`Impuesto ${i.type.toUpperCase()} ${puntosEnPorcentaje(i.rate)}`, i.tax],
      ]),
      ['Propinas', v.tips],
      ['Cuentas', v.checks],
      ['Comensales', v.guests],
      ['Ticket promedio', v.averageTicket],
      ['Gasto por comensal', v.spendPerGuest],
    ],
    [
      ['Medio de pago', 'Venta', 'Propina', 'Pagos'],
      ...inf.byMethod.map((m) => [method(m), m.sale, m.tip, m.payments]),
    ],
    [
      ['Mesero', 'Neto', 'Cuentas', 'Ticket promedio'],
      ...inf.byWaiter.map((m) => [quien(m.userId), m.net, m.checks, m.averageTicket]),
    ],
    [['Producto', 'Unidades', 'Neto'], ...inf.byProduct.map((p) => [p.name, p.units, p.net])],
    [
      [
        'Anulación',
        'Pedido',
        'Unidades',
        'Valor',
        'Motivo',
        'Ya preparado',
        'Quién',
        'Autorizó',
        'Hora',
      ],
      ...inf.voids.map((a) => [
        a.name,
        order(a.orderNumber),
        a.units,
        a.value,
        a.reason ?? '',
        a.alreadyPrepared ? 'Sí' : 'No',
        quien(a.userId),
        quien(a.authorizedById),
        time(a.time),
      ]),
    ],
    [
      ['Pedido cancelado', 'Valor', 'Motivo', 'Quién', 'Autorizó', 'Hora'],
      ...inf.cancellations.map((c) => [
        order(c.orderNumber),
        c.value,
        c.reason ?? '',
        quien(c.userId),
        quien(c.authorizedById),
        time(c.time),
      ]),
    ],
    [
      ['Descuento', 'Pedido', 'Valor', 'Monto', 'Motivo'],
      ...inf.discounts.map((d) => [
        NOMBRE_REGLA[d.rule],
        order(d.orderNumber),
        d.rule === 'percent' ? puntosEnPorcentaje(d.value) : d.value,
        d.amount,
        d.reason ?? '',
      ]),
    ],
    [
      [
        'Cierre de caja',
        'Abrió',
        'Cerró',
        'Base',
        'Esperado',
        'Contado',
        'Diferencia',
        'Justificación',
      ],
      ...r.closings.map((c) => [
        c.businessDay,
        quien(c.abiertoPor),
        quien(c.cerradoPor),
        c.base,
        c.closed.expected,
        c.closed.counted,
        c.closed.variance,
        c.closed.justification ?? '',
      ]),
    ],
    [
      ['Cierre de caja', 'Otro medio', 'Según el sistema', 'Según su cierre', 'Diferencia'],
      ...r.closings.flatMap((c) =>
        c.closed.otherMethods.map((m) => [
          c.businessDay,
          method(m),
          m.expected,
          m.reported,
          m.variance,
        ]),
      ),
    ],
    [
      ['Fondo de propinas', 'Pesos'],
      ['Propinas registradas', inf.tipPool.tips],
      ['Pagadas desde la caja', inf.tipPool.paidOut],
      ['Saldo', inf.tipPool.balance],
    ],
  ]
  return `﻿${sections.map((s) => s.map(filaCsv).join('\r\n')).join('\r\n\r\n')}\r\n`
}

/** El nombre del archivo: «reporte-2026-10-24.csv» o «reporte-2026-10-18-a-2026-10-24.csv». */
export const nombreCsv = ({ from, until }: Periodo) =>
  from === until ? `reporte-${from}.csv` : `reporte-${from}-a-${until}.csv`
