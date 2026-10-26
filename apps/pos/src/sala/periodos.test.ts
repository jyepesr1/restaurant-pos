import { describe, expect, it } from 'vitest'
import type { PeriodReport } from './motor'
import {
  celda,
  csvDeReporte,
  fechaHoraCsv,
  nombreCsv,
  percent,
  periodoDe,
  periodoEnPalabras,
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
    expect(periodoDe('today', '2026-10-24')).toEqual({ from: '2026-10-24', until: '2026-10-24' })
    expect(periodoDe('yesterday', '2026-10-24')).toEqual({
      from: '2026-10-23',
      until: '2026-10-23',
    })
    expect(periodoDe('week', '2026-10-24')).toEqual({ from: '2026-10-18', until: '2026-10-24' })
  })

  it('en palabras', () => {
    expect(periodoEnPalabras({ from: '2026-10-24', until: '2026-10-24' })).toMatch(
      /sábado,? 24 de octubre de 2026/,
    )
    expect(periodoEnPalabras({ from: '2026-10-18', until: '2026-10-24' })).toMatch(/^del 18/)
  })

  it('porcentaje con un decimal y 0 sin total', () => {
    expect(percent(1, 3)).toBe('33,3 %')
    expect(percent(0, 0)).toBe('0 %')
    expect(percent(5, 5)).toBe('100 %')
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

  const empty: PeriodReport = {
    today: '2026-10-24',
    usuarios: { ana: 'Ana' },
    printer: false,
    closings: [],
    report: {
      from: '2026-10-24',
      until: '2026-10-24',
      sales: {
        gross: 50_000,
        voided: 0,
        discounts: 0,
        net: 50_000,
        settings: 0,
        taxes: [{ type: 'inc', rate: 800, base: 46_296, tax: 3_704 }],
        tips: 5_000,
        checks: 1,
        guests: 2,
        averageTicket: 50_000,
        spendPerGuest: 25_000,
      },
      byMethod: [{ method: 'cash', customMethodId: null, sale: 50_000, tip: 5_000, payments: 1 }],
      byWaiter: [{ userId: 'ana', net: 50_000, checks: 1, averageTicket: 50_000 }],
      byProduct: [
        { productId: 'p', variantId: null, name: 'Pizza; grande', units: 2, net: 50_000 },
      ],
      voids: [],
      cancellations: [],
      discounts: [],
      tipPool: { tips: 5_000, paidOut: 0, balance: 5_000 },
    },
  }

  it('UTF-8 con BOM, punto y coma, montos enteros y una sección tras otra', () => {
    const csv = csvDeReporte(
      empty,
      { from: '2026-10-24', until: '2026-10-24' },
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
    expect(nombreCsv({ from: '2026-10-24', until: '2026-10-24' })).toBe('reporte-2026-10-24.csv')
    expect(nombreCsv({ from: '2026-10-18', until: '2026-10-24' })).toBe(
      'reporte-2026-10-18-a-2026-10-24.csv',
    )
  })
})
