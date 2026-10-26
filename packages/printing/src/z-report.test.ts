import { describe, expect, it } from 'vitest'
import { asText, COLUMNS, escpos, readEscpos, type ZReport, zReportLines } from './index'

// The Z report on paper (task 1.9): 58 and 80 mm, with variances, other methods and reprint.

const closeout: ZReport = {
  restaurant: 'La Spritzzería',
  day: 'sábado 24 de octubre de 2026',
  opened: '11:02 a. m.',
  closed: '11:48 p. m.',
  openedByName: 'Caja',
  closedByName: 'Caja',
  cash: {
    base: 200_000,
    charged: 850_300,
    refunds: 40_900,
    entries: 0,
    outflows: 30_000,
    tipPayouts: 60_000,
    expected: 919_400,
    counted: 918_400,
    variance: -1_000,
  },
  otherMethods: [
    { name: 'Tarjeta crédito', expected: 1_200_000, reported: 1_200_000, variance: 0 },
    { name: 'Nequi', expected: 95_000, reported: 90_000, variance: -5_000 },
  ],
  justification: 'Faltan $1.000 de efectivo y $5.000 de Nequi: un cliente pagó de menos.',
  charged: [
    { name: 'Efectivo', sale: 800_000, tip: 50_300 },
    { name: 'Tarjeta crédito', sale: 1_100_000, tip: 100_000 },
    { name: 'Nequi', sale: 95_000, tip: 0 },
  ],
  sales: {
    net: 1_995_000,
    taxes: [{ name: 'INC 8 %', base: 1_847_222, value: 147_778 }],
    tips: 150_300,
    checks: 31,
    guests: 74,
    averageTicket: 64_355,
    voided: 40_900,
    canceled: 0,
    discounts: 12_000,
  },
  reprinted: null,
}

const text = (z: ZReport, width: 58 | 80 = 80) =>
  asText(zReportLines(z, { columns: COLUMNS[width], page: 'pc850' }), COLUMNS[width])

describe('zReportLines', () => {
  it('has the reconciliation, other methods, justification, amounts charged and day sales', () => {
    const t = text(closeout)
    for (const share of [
      'CIERRE DE CAJA',
      'sábado 24 de octubre de 2026',
      'Esperado',
      '$919.400',
      'Faltan $1.000',
      'Nequi',
      '$95.000 / $90.000',
      'Faltan $5.000',
      'cliente pagó de menos',
      'Cobrado en el turno',
      'Ventas del día',
      '$1.995.000',
      'INC 8 %',
      'Ticket promedio',
      'Productos anulados',
      'Firma cajero',
    ])
      expect(t).toContain(share)
    // A zero variance is not repeated per method; what did not happen is not printed.
    expect(t).not.toContain('Pedidos cancelados')
    expect(t).not.toContain('Entradas')
    expect(t).not.toContain('Reimpresión')
  })

  it('a positive variance says Sobran, and the reprint says when', () => {
    const t = text({
      ...closeout,
      cash: { ...closeout.cash, counted: 920_400, variance: 1_000 },
      reprinted: '25 oct., 9:10 a. m.',
    })
    expect(t).toContain('Sobran $1.000')
    expect(t).toContain('Reimpresión 25 oct., 9:10 a. m.')
  })

  it('at 58 mm no line exceeds the width and the bytes read back the same', () => {
    const format = { columns: COLUMNS[58], page: 'pc850' as const }
    const lines = zReportLines(closeout, format)
    for (const l of lines)
      if ('text' in l) expect(l.text.length).toBeLessThanOrEqual(l.large ? 16 : 32)
    const readResult = readEscpos(escpos(lines, format))
    expect(readResult.text).toContain('CIERRE DE CAJA')
    expect(readResult.text).toContain('Firma cajero')
  })
})
