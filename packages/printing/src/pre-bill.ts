import { type Format, type Line, paragraph, toSides } from './document'
import type { CodePage } from './encoding'

// The pre-bill on paper (task 1.6, brief §4.5): what the table has ordered, the total, what is
// already paid, the suggested tip and the total with tip. The hub builds `PreBill` with the amounts
// already calculated by `@pos/core`; this only decides order and style.

export interface PreBillLine {
  quantity: number
  name: string
  /** Chosen options (doneness, add-ons). */
  options: string[]
  /** Net of the line in pesos: with tax, without voided amounts or discounts. */
  value: number
}

export interface PreBill {
  restaurant: string
  /** «Mesa 6», «Mesa 5 + 6», «Para llevar». */
  target: string
  order: number | null
  waiter: string
  /** Already formatted in the restaurant's time zone. */
  time: string
  guests: number | null
  lines: PreBillLine[]
  /**
   * The itemized tax, by type and rate («INC 8 %»): base without tax and tax in pesos. Exempt
   * ones go with tax 0. An older hub does not send it.
   */
  taxes?: { name: string; base: number; value: number }[]
  total: number
  paid: number
  /** In a split check, which one and how much it owes. */
  check: { name: string; amount: number } | null
  /** What is charged without tip: the balance, or the check's amount. */
  subtotal: number
  tip: number
  /** Basis points (1000 = 10 %) if it is the suggested one; null if the guest asked for another. */
  tipRate: number | null
}

/** $40.900, with a dot as thousands separator as in Colombia. */
export const pesos = (n: number) =>
  `${n < 0 ? '-' : ''}$${String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`

const percent = (bp: number) => `${bp / 100}`.replace('.', ',')

/** The pre-bill split into lines for a printer of that width and that code page. */
export function preBillLines(p: PreBill, format: { columns: number; page: CodePage }): Line[] {
  const f: Format = format
  const data = [
    p.order ? `Pedido ${p.order}` : null,
    p.waiter || null,
    p.time,
    p.guests ? `${p.guests} pers.` : null,
  ].filter((d): d is string => !!d)

  const lines: Line[] = [
    ...paragraph(p.restaurant, f, { large: true, center: true }),
    ...paragraph('PRECUENTA', f, { reversed: true, center: true, bold: true }),
    { space: true },
    ...paragraph(p.target, f, { large: true }),
    ...paragraph(data.join(' · '), f),
    { separator: true },
  ]
  for (const l of p.lines) {
    lines.push(...toSides(`${l.quantity} x ${l.name}`, pesos(l.value), f))
    // Options are indented under their dish (`wrapText` strips leading spaces).
    for (const option of l.options)
      for (const line of paragraph(option, { ...f, columns: f.columns - 2 }))
        if ('text' in line) lines.push({ ...line, text: `  ${line.text}` })
  }
  lines.push({ separator: true })
  const taxes = p.taxes ?? []
  if (taxes.length > 0) {
    lines.push(...toSides('Base sin impuestos', pesos(taxes.reduce((a, i) => a + i.base, 0)), f))
    for (const i of taxes) if (i.value > 0) lines.push(...toSides(i.name, pesos(i.value), f))
  }
  lines.push(...toSides('Total', pesos(p.total), f, { bold: true }))
  if (p.paid > 0) {
    lines.push(...toSides('Ya pagado', `-${pesos(p.paid)}`, f))
    lines.push(...toSides('Saldo', pesos(p.total - p.paid), f, { bold: true }))
  }
  if (p.check) {
    lines.push({ separator: true })
    lines.push(...toSides(p.check.name, pesos(p.check.amount), f, { bold: true }))
  }
  if (p.tip > 0) {
    lines.push(
      ...toSides(
        p.tipRate === null ? 'Propina' : `Propina sugerida (${percent(p.tipRate)} %)`,
        pesos(p.tip),
        f,
      ),
      ...toSides('Total con propina', pesos(p.subtotal + p.tip), f, {
        large: true,
      }),
    )
  } else {
    lines.push(...toSides('A pagar', pesos(p.subtotal), f, { large: true }))
  }
  lines.push(
    { separator: true },
    ...paragraph('La propina es voluntaria.', f, { center: true }),
    ...paragraph('Esta precuenta no es una factura.', f, { center: true }),
  )
  return lines
}

/** «INC 8 %», «IVA 19 %», «Exento». */
export function taxName(type: 'inc' | 'iva' | 'exempt', rate: number): string {
  if (type === 'exempt' || rate === 0) return 'Exento'
  return `${type.toUpperCase()} ${percent(rate)} %`
}
