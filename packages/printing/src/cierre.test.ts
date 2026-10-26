import { describe, expect, it } from 'vitest'
import { type CierreZ, COLUMNAS, comoTexto, escpos, leerEscpos, lineasCierreZ } from './index'

// El cierre Z en papel (tarea 1.9): 58 y 80 mm, con diferencias, demás medios y reimpresión.

const closeout: CierreZ = {
  restaurant: 'La Spritzzería',
  day: 'sábado 24 de octubre de 2026',
  opened: '11:02 a. m.',
  closed: '11:48 p. m.',
  abrio: 'Caja',
  cerro: 'Caja',
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

const text = (z: CierreZ, width: 58 | 80 = 80) =>
  comoTexto(lineasCierreZ(z, { columnas: COLUMNAS[width], pagina: 'pc850' }), COLUMNAS[width])

describe('lineasCierreZ', () => {
  it('lleva el cuadre, los demás medios, la justificación, lo cobrado y las ventas del día', () => {
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
    // Una diferencia en cero no se repite por medio; lo que no pasó no se imprime.
    expect(t).not.toContain('Pedidos cancelados')
    expect(t).not.toContain('Entradas')
    expect(t).not.toContain('Reimpresión')
  })

  it('una diferencia a favor dice Sobran, y la reimpresión dice cuándo', () => {
    const t = text({
      ...closeout,
      cash: { ...closeout.cash, counted: 920_400, variance: 1_000 },
      reprinted: '25 oct., 9:10 a. m.',
    })
    expect(t).toContain('Sobran $1.000')
    expect(t).toContain('Reimpresión 25 oct., 9:10 a. m.')
  })

  it('en 58 mm ninguna línea pasa del ancho y los bytes se leen igual', () => {
    const format = { columnas: COLUMNAS[58], pagina: 'pc850' as const }
    const lines = lineasCierreZ(closeout, format)
    for (const l of lines)
      if ('text' in l) expect(l.text.length).toBeLessThanOrEqual(l.large ? 16 : 32)
    const leido = leerEscpos(escpos(lines, format))
    expect(leido.text).toContain('CIERRE DE CAJA')
    expect(leido.text).toContain('Firma cajero')
  })
})
