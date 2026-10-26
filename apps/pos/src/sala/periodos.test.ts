import { describe, expect, it } from 'vitest'
import type { Reporte } from './motor'
import {
  celda,
  csvDeReporte,
  fechaHoraCsv,
  nombreCsv,
  periodoDe,
  periodoEnPalabras,
  porcentaje,
  sumarDias,
} from './periodos'

// La pantalla Reportes sin dibujar (tarea 1.9): períodos, fechas y el CSV para Excel.

describe('períodos', () => {
  it('suma y resta días, también al cambiar de mes y de año', () => {
    expect(sumarDias('2026-10-24', -1)).toBe('2026-10-23')
    expect(sumarDias('2026-03-01', -1)).toBe('2026-02-28')
    expect(sumarDias('2026-01-01', -1)).toBe('2025-12-31')
    expect(sumarDias('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('hoy, ayer y los últimos 7 días contados desde el día operativo del hub', () => {
    expect(periodoDe('hoy', '2026-10-24')).toEqual({ desde: '2026-10-24', hasta: '2026-10-24' })
    expect(periodoDe('ayer', '2026-10-24')).toEqual({ desde: '2026-10-23', hasta: '2026-10-23' })
    expect(periodoDe('semana', '2026-10-24')).toEqual({ desde: '2026-10-18', hasta: '2026-10-24' })
  })

  it('en palabras', () => {
    expect(periodoEnPalabras({ desde: '2026-10-24', hasta: '2026-10-24' })).toMatch(
      /sábado,? 24 de octubre de 2026/,
    )
    expect(periodoEnPalabras({ desde: '2026-10-18', hasta: '2026-10-24' })).toMatch(/^del 18/)
  })

  it('porcentaje con un decimal y 0 sin total', () => {
    expect(porcentaje(1, 3)).toBe('33,3 %')
    expect(porcentaje(0, 0)).toBe('0 %')
    expect(porcentaje(5, 5)).toBe('100 %')
  })

  it('fecha y hora en la zona del restaurante', () => {
    expect(fechaHoraCsv('2026-10-25T01:30:00.000Z', 'America/Bogota')).toBe('2026-10-24 20:30')
  })
})

describe('CSV', () => {
  it('celdas: números tal cual, texto con ; o comillas entre comillas, sin fórmulas', () => {
    expect(celda(-40_900)).toBe('-40900')
    expect(celda('Pizza; grande')).toBe('"Pizza; grande"')
    expect(celda('Dijo "no"')).toBe('"Dijo ""no"""')
    expect(celda('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(celda('-2 cervezas')).toBe("'-2 cervezas")
    expect(celda('@usuario')).toBe("'@usuario")
  })

  const vacio: Reporte = {
    hoy: '2026-10-24',
    usuarios: { ana: 'Ana' },
    impresora: false,
    cierres: [],
    informe: {
      desde: '2026-10-24',
      hasta: '2026-10-24',
      ventas: {
        bruto: 50_000,
        anulado: 0,
        descuentos: 0,
        neto: 50_000,
        ajustes: 0,
        impuestos: [{ tipo: 'inc', tarifa: 800, base: 46_296, impuesto: 3_704 }],
        propinas: 5_000,
        cuentas: 1,
        comensales: 2,
        ticketPromedio: 50_000,
        gastoPorComensal: 25_000,
      },
      porMedio: [
        { medio: 'efectivo', medioPropioId: null, venta: 50_000, propina: 5_000, pagos: 1 },
      ],
      porMesero: [{ usuarioId: 'ana', neto: 50_000, cuentas: 1, ticketPromedio: 50_000 }],
      porProducto: [
        { productoId: 'p', varianteId: null, nombre: 'Pizza; grande', unidades: 2, neto: 50_000 },
      ],
      anulaciones: [],
      cancelaciones: [],
      descuentos: [],
      fondoPropinas: { propinas: 5_000, pagadas: 0, saldo: 5_000 },
    },
  }

  it('UTF-8 con BOM, punto y coma, montos enteros y una sección tras otra', () => {
    const csv = csvDeReporte(
      vacio,
      { desde: '2026-10-24', hasta: '2026-10-24' },
      null,
      'La Spritzzería',
    )
    expect(csv.startsWith('﻿Reporte;La Spritzzería\r\n')).toBe(true)
    expect(csv).toContain('\r\nNeto;50000\r\n')
    expect(csv).toContain('Base INC 8 %;46296')
    expect(csv).toContain('Efectivo;50000;5000;1')
    expect(csv).toContain('Ana;50000;1;50000')
    expect(csv).toContain('"Pizza; grande";2;50000')
    expect(csv).toContain('\r\n\r\nFondo de propinas;Pesos')
    // Ningún monto lleva separador de miles.
    expect(csv).not.toMatch(/\d\.\d{3}/)
  })

  it('nombre del archivo', () => {
    expect(nombreCsv({ desde: '2026-10-24', hasta: '2026-10-24' })).toBe('reporte-2026-10-24.csv')
    expect(nombreCsv({ desde: '2026-10-18', hasta: '2026-10-24' })).toBe(
      'reporte-2026-10-18-a-2026-10-24.csv',
    )
  })
})
