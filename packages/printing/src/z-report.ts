import { type Format, type Line, paragraph, type Style, toSides } from './document'
import type { CodePage } from './encoding'
import { pesos } from './pre-bill'

// The Z report on paper (task 1.9, docs/KPIS.md#cierre-z-impreso): the shift reconciliation, the
// business day's sales, what was charged per method and what was voided. It prints on the pre-bill
// printer when the register closes and can be reprinted from Reportes. The hub builds `ZReport`
// with the amounts already calculated by `@pos/core`; this only decides order and style.

export interface ZReportMethod {
  name: string
  /** What the system recorded (sale + tip). */
  expected: number
  /** What the card terminal's or app's close says. */
  reported: number
  variance: number
}

export interface ZReport {
  restaurant: string
  /** The business day, already in words («sábado 24 de octubre de 2026»). */
  day: string
  /** Times already formatted in the restaurant's time zone. */
  opened: string
  closed: string
  openedByName: string
  closedByName: string
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
  otherMethods: ZReportMethod[]
  justification: string | null
  /** What was charged in the shift, per payment method. */
  charged: { name: string; sale: number; tip: number }[]
  /** Sales for the whole business day (not just the shift). */
  sales: {
    net: number
    taxes: { name: string; base: number; value: number }[]
    tips: number
    checks: number
    guests: number
    averageTicket: number
    /** Cash rounding adjustment: what was charged over or under when rounding. */
    settings?: number
    voided: number
    canceled: number
    discounts: number
  }
  /** Time of the reprint, if it is one. */
  reprinted: string | null
}

/** «Cuadra», «Sobran $1.000» or «Faltan $1.000», as on the register screen. */
const inWords = (n: number) =>
  n === 0 ? 'Cuadra' : n > 0 ? `Sobran ${pesos(n)}` : `Faltan ${pesos(-n)}`

/** The Z report split into lines for a printer of that width and that code page. */
export function zReportLines(z: ZReport, format: { columns: number; page: CodePage }): Line[] {
  const f: Format = format
  const row = (left: string, rightSide: string, style: Style = {}) =>
    toSides(left, rightSide, f, style)
  const title = (text: string) => [
    { separator: true } as Line,
    ...paragraph(text, f, { bold: true }),
  ]
  const e = z.cash
  const lines: Line[] = [
    ...paragraph(z.restaurant, f, { large: true, center: true }),
    ...paragraph('CIERRE DE CAJA', f, { reversed: true, center: true, bold: true }),
    ...(z.reprinted ? paragraph(`Reimpresión ${z.reprinted}`, f, { center: true }) : []),
    { space: true },
    ...paragraph(z.day, f, { bold: true }),
    ...paragraph(`Abrió ${z.openedByName} · ${z.opened}`, f),
    ...paragraph(`Cerró ${z.closedByName} · ${z.closed}`, f),

    ...title('Efectivo'),
    ...row('Base', pesos(e.base)),
    ...row('Cobrado', pesos(e.charged)),
  ]
  if (e.refunds) lines.push(...row('Devoluciones', `-${pesos(e.refunds)}`))
  if (e.entries) lines.push(...row('Entradas', pesos(e.entries)))
  if (e.outflows) lines.push(...row('Salidas', `-${pesos(e.outflows)}`))
  if (e.tipPayouts) lines.push(...row('Pago de propinas', `-${pesos(e.tipPayouts)}`))
  lines.push(
    ...row('Esperado', pesos(e.expected), { bold: true }),
    ...row('Contado', pesos(e.counted), { bold: true }),
    ...row('Diferencia', inWords(e.variance), { bold: true }),
  )

  if (z.otherMethods.length > 0) {
    lines.push(...title('Otros medios (según sistema / según cierre)'))
    for (const m of z.otherMethods) {
      lines.push(...row(m.name, `${pesos(m.expected)} / ${pesos(m.reported)}`))
      if (m.variance !== 0) lines.push(...row('  Diferencia', inWords(m.variance)))
    }
  }
  if (z.justification) lines.push(...title('Justificación'), ...paragraph(z.justification, f))

  if (z.charged.length > 0) {
    lines.push(...title('Cobrado en el turno'))
    for (const m of z.charged) {
      lines.push(...row(m.name, pesos(m.sale + m.tip)))
      if (m.tip !== 0) lines.push(...row('  de propina', pesos(m.tip)))
    }
  }

  const v = z.sales
  lines.push(...title('Ventas del día'), ...row('Ventas', pesos(v.net), { bold: true }))
  if (v.taxes.length > 0) {
    lines.push(...row('Base sin impuestos', pesos(v.taxes.reduce((a, i) => a + i.base, 0))))
    for (const i of v.taxes) if (i.value > 0) lines.push(...row(i.name, pesos(i.value)))
  }
  lines.push(
    ...(v.settings ? row('Ajuste por redondeo', pesos(v.settings)) : []),
    ...row('Propinas', pesos(v.tips)),
    ...row('Cuentas', String(v.checks)),
    ...row('Comensales', String(v.guests)),
    ...row('Ticket promedio', pesos(v.averageTicket)),
  )
  if (v.voided || v.canceled || v.discounts) {
    lines.push(...title('Anulado y descontado'))
    if (v.voided) lines.push(...row('Productos anulados', pesos(v.voided)))
    if (v.canceled) lines.push(...row('Pedidos cancelados', pesos(v.canceled)))
    if (v.discounts) lines.push(...row('Descuentos', pesos(v.discounts)))
  }
  lines.push(
    { separator: true },
    { space: true },
    ...paragraph('Firma cajero', f),
    { space: true },
    { space: true },
    ...paragraph('Firma de quien recibe', f),
  )
  return lines
}
