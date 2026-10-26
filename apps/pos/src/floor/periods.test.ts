import { describe, expect, it } from 'vitest'
import type { PeriodReport } from './engine'
import {
  addDays,
  cell,
  csvDateTime,
  csvName,
  percent,
  periodInWords,
  periodOf,
  reportCsv,
} from './periods'

// The Reportes screen without rendering (task 1.9): periods, dates and the CSV for Excel.

describe('periods', () => {
  it('adds and subtracts days, also across month and year changes', () => {
    expect(addDays('2026-10-24', -1)).toBe('2026-10-23')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('today, yesterday and the last 7 days counted from the hub business day', () => {
    expect(periodOf('today', '2026-10-24')).toEqual({ from: '2026-10-24', until: '2026-10-24' })
    expect(periodOf('yesterday', '2026-10-24')).toEqual({
      from: '2026-10-23',
      until: '2026-10-23',
    })
    expect(periodOf('week', '2026-10-24')).toEqual({ from: '2026-10-18', until: '2026-10-24' })
  })

  it('in words', () => {
    expect(periodInWords({ from: '2026-10-24', until: '2026-10-24' })).toMatch(
      /sábado,? 24 de octubre de 2026/,
    )
    expect(periodInWords({ from: '2026-10-18', until: '2026-10-24' })).toMatch(/^del 18/)
  })

  it('percentage with one decimal and 0 without a total', () => {
    expect(percent(1, 3)).toBe('33,3 %')
    expect(percent(0, 0)).toBe('0 %')
    expect(percent(5, 5)).toBe('100 %')
  })

  it('date and time in the restaurant time zone', () => {
    expect(csvDateTime('2026-10-25T01:30:00.000Z', 'America/Bogota')).toBe('2026-10-24 20:30')
  })
})

describe('CSV', () => {
  it('cells: numbers as is, text with ; or quotes wrapped in quotes, no formulas', () => {
    expect(cell(-40_900)).toBe('-40900')
    expect(cell('Pizza; grande')).toBe('"Pizza; grande"')
    expect(cell('Dijo "no"')).toBe('"Dijo ""no"""')
    expect(cell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(cell('-2 cervezas')).toBe("'-2 cervezas")
    expect(cell('@usuario')).toBe("'@usuario")
  })

  const empty: PeriodReport = {
    today: '2026-10-24',
    users: { ana: 'Ana' },
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

  it('UTF-8 with BOM, semicolons, whole amounts and one section after another', () => {
    const csv = reportCsv(
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
    // No amount carries a thousands separator.
    expect(csv).not.toMatch(/\d\.\d{3}/)
  })

  it('file name', () => {
    expect(csvName({ from: '2026-10-24', until: '2026-10-24' })).toBe('reporte-2026-10-24.csv')
    expect(csvName({ from: '2026-10-18', until: '2026-10-24' })).toBe(
      'reporte-2026-10-18-a-2026-10-24.csv',
    )
  })
})
