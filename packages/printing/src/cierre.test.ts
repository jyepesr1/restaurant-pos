import { describe, expect, it } from 'vitest'
import { type CierreZ, COLUMNAS, comoTexto, escpos, leerEscpos, lineasCierreZ } from './index'

// El cierre Z en papel (tarea 1.9): 58 y 80 mm, con diferencias, demás medios y reimpresión.

const cierre: CierreZ = {
  restaurante: 'La Spritzzería',
  dia: 'sábado 24 de octubre de 2026',
  abierto: '11:02 a. m.',
  cerrado: '11:48 p. m.',
  abrio: 'Caja',
  cerro: 'Caja',
  efectivo: {
    base: 200_000,
    cobrado: 850_300,
    devoluciones: 40_900,
    entradas: 0,
    salidas: 30_000,
    pagosPropinas: 60_000,
    esperado: 919_400,
    contado: 918_400,
    diferencia: -1_000,
  },
  otrosMedios: [
    { nombre: 'Tarjeta crédito', esperado: 1_200_000, reportado: 1_200_000, diferencia: 0 },
    { nombre: 'Nequi', esperado: 95_000, reportado: 90_000, diferencia: -5_000 },
  ],
  justificacion: 'Faltan $1.000 de efectivo y $5.000 de Nequi: un cliente pagó de menos.',
  cobrado: [
    { nombre: 'Efectivo', venta: 800_000, propina: 50_300 },
    { nombre: 'Tarjeta crédito', venta: 1_100_000, propina: 100_000 },
    { nombre: 'Nequi', venta: 95_000, propina: 0 },
  ],
  ventas: {
    neto: 1_995_000,
    impuestos: [{ nombre: 'INC 8 %', base: 1_847_222, valor: 147_778 }],
    propinas: 150_300,
    cuentas: 31,
    comensales: 74,
    ticketPromedio: 64_355,
    anulado: 40_900,
    cancelado: 0,
    descuentos: 12_000,
  },
  reimpreso: null,
}

const texto = (z: CierreZ, ancho: 58 | 80 = 80) =>
  comoTexto(lineasCierreZ(z, { columnas: COLUMNAS[ancho], pagina: 'pc850' }), COLUMNAS[ancho])

describe('lineasCierreZ', () => {
  it('lleva el cuadre, los demás medios, la justificación, lo cobrado y las ventas del día', () => {
    const t = texto(cierre)
    for (const parte of [
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
      expect(t).toContain(parte)
    // Una diferencia en cero no se repite por medio; lo que no pasó no se imprime.
    expect(t).not.toContain('Pedidos cancelados')
    expect(t).not.toContain('Entradas')
    expect(t).not.toContain('Reimpresión')
  })

  it('una diferencia a favor dice Sobran, y la reimpresión dice cuándo', () => {
    const t = texto({
      ...cierre,
      efectivo: { ...cierre.efectivo, contado: 920_400, diferencia: 1_000 },
      reimpreso: '25 oct., 9:10 a. m.',
    })
    expect(t).toContain('Sobran $1.000')
    expect(t).toContain('Reimpresión 25 oct., 9:10 a. m.')
  })

  it('en 58 mm ninguna línea pasa del ancho y los bytes se leen igual', () => {
    const formato = { columnas: COLUMNAS[58], pagina: 'pc850' as const }
    const lineas = lineasCierreZ(cierre, formato)
    for (const l of lineas)
      if ('texto' in l) expect(l.texto.length).toBeLessThanOrEqual(l.grande ? 16 : 32)
    const leido = leerEscpos(escpos(lineas, formato))
    expect(leido.texto).toContain('CIERRE DE CAJA')
    expect(leido.texto).toContain('Firma cajero')
  })
})
