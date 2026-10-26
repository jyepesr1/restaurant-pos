import type { PaymentMethod } from '@pos/core'
import type { CheckoutRules } from './checks'
import { methodName } from './checks'
import type { PeriodReport } from './engine'

// What the Reportes screen computes (task 1.9) without drawing anything: the periods picked
// with one tap, the dates in words and the CSV for Excel (docs/KPIS.md#exportar).

export type Shortcut = 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth'

/** The longest period the hub returns (`MAX_REPORT_DAYS`). */
export const MAX_DAYS = 62

export interface Period {
  from: string
  until: string
}

/** The business day `days` before or after (YYYY-MM-DD, without time zone). */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Today, yesterday, last 7 days, this month (to date) or last month, from today's business day. */
export function periodOf(shortcut: Shortcut, today: string): Period {
  if (shortcut === 'yesterday') return { from: addDays(today, -1), until: addDays(today, -1) }
  if (shortcut === 'week') return { from: addDays(today, -6), until: today }
  const firstOne = `${today.slice(0, 8)}01`
  if (shortcut === 'month') return { from: firstOne, until: today }
  if (shortcut === 'lastMonth') {
    const latest = addDays(firstOne, -1)
    return { from: `${latest.slice(0, 8)}01`, until: latest }
  }
  return { from: today, until: today }
}

const format = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('es-CO', { ...options, timeZone: 'UTC' })
const toDate = (day: string) => new Date(`${day}T12:00:00Z`)

/** «sábado, 24 de octubre de 2026» or «del 18–24 de octubre de 2026». */
export function periodInWords({ from, until }: Period): string {
  if (from === until)
    return format({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
      toDate(from),
    )
  return `del ${format({ day: 'numeric', month: 'long', year: 'numeric' }).formatRange(
    toDate(from),
    toDate(until),
  )}`
}

/** «2026-10-24 20:15» in the restaurant's time zone: Excel reads it as date and time. */
export function csvDateTime(iso: string, timeZone: string): string {
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

/** «24 oct.», for the rows of a multi-day period. */
export const shortDay = (day: string) =>
  format({ day: 'numeric', month: 'short' }).format(toDate(day))

/** Basis points as a percentage with a comma: 1250 → «12,5 %». */
export const pointsAsPercent = (bp: number) => `${(bp / 100).toLocaleString('es-CO')} %`

/** Percentage with one decimal, for display only (KPIS.md#por-producto). */
export function percent(share: number, total: number): string {
  if (total === 0) return '0 %'
  return `${(Math.round((share * 1000) / total) / 10).toLocaleString('es-CO')} %`
}

// ── CSV ────────────────────────────────────────────────────────────────

/**
 * A CSV cell. Text starting with = + - @ gets an apostrophe so Excel does not take it as a
 * formula (a product named «=HYPERLINK(…)» does not run when the file is opened).
 */
export function cell(value: string | number): string {
  if (typeof value === 'number') return String(value)
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[;"\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

const csvRow = (values: (string | number)[]) => values.map(cell).join(';')

const RULE_NAME = { percent: 'Porcentaje', value: 'Valor', comp: 'Cortesía' } as const

/**
 * The report as CSV for Excel: semicolon-separated, UTF-8 with BOM and whole-peso amounts,
 * without a thousands separator. One section after another, with a blank line between them.
 */
export function reportCsv(
  r: PeriodReport,
  period: Period,
  rules: CheckoutRules | null,
  restaurant: string,
): string {
  const { report: rpt } = r
  const v = rpt.sales
  const who = (id: string | null) => (id ? (r.users[id] ?? '') : '')
  const time = (iso: string) => csvDateTime(iso, rules?.timeZone ?? 'America/Bogota')
  const order = (n: number | null) => (n === null ? '' : n)
  const method = (m: { method: PaymentMethod; customMethodId: string | null }) =>
    methodName(m.method, m.customMethodId, rules)
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
        [`Base ${i.type.toUpperCase()} ${pointsAsPercent(i.rate)}`, i.base],
        [`Impuesto ${i.type.toUpperCase()} ${pointsAsPercent(i.rate)}`, i.tax],
      ]),
      ['Propinas', v.tips],
      ['Cuentas', v.checks],
      ['Comensales', v.guests],
      ['Ticket promedio', v.averageTicket],
      ['Gasto por comensal', v.spendPerGuest],
    ],
    [
      ['Medio de pago', 'Venta', 'Propina', 'Pagos'],
      ...rpt.byMethod.map((m) => [method(m), m.sale, m.tip, m.payments]),
    ],
    [
      ['Mesero', 'Neto', 'Cuentas', 'Ticket promedio'],
      ...rpt.byWaiter.map((m) => [who(m.userId), m.net, m.checks, m.averageTicket]),
    ],
    [['Producto', 'Unidades', 'Neto'], ...rpt.byProduct.map((p) => [p.name, p.units, p.net])],
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
      ...rpt.voids.map((a) => [
        a.name,
        order(a.orderNumber),
        a.units,
        a.value,
        a.reason ?? '',
        a.alreadyPrepared ? 'Sí' : 'No',
        who(a.userId),
        who(a.authorizedById),
        time(a.time),
      ]),
    ],
    [
      ['Pedido cancelado', 'Valor', 'Motivo', 'Quién', 'Autorizó', 'Hora'],
      ...rpt.cancellations.map((c) => [
        order(c.orderNumber),
        c.value,
        c.reason ?? '',
        who(c.userId),
        who(c.authorizedById),
        time(c.time),
      ]),
    ],
    [
      ['Descuento', 'Pedido', 'Valor', 'Monto', 'Motivo'],
      ...rpt.discounts.map((d) => [
        RULE_NAME[d.rule],
        order(d.orderNumber),
        d.rule === 'percent' ? pointsAsPercent(d.value) : d.value,
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
        who(c.openedBy),
        who(c.closedBy),
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
      ['Propinas registradas', rpt.tipPool.tips],
      ['Pagadas desde la caja', rpt.tipPool.paidOut],
      ['Saldo', rpt.tipPool.balance],
    ],
  ]
  return `﻿${sections.map((s) => s.map(csvRow).join('\r\n')).join('\r\n\r\n')}\r\n`
}

/** The file name: «reporte-2026-10-24.csv» or «reporte-2026-10-18-a-2026-10-24.csv». */
export const csvName = ({ from, until }: Period) =>
  from === until ? `reporte-${from}.csv` : `reporte-${from}-a-${until}.csv`
