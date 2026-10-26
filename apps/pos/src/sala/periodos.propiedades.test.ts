import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ReglasCobro } from './cuentas'
import type { CierreReporte, Reporte } from './motor'
import {
  type Atajo,
  celda,
  csvDeReporte,
  MAX_DIAS,
  periodoDe,
  puntosEnPorcentaje,
  sumarDias,
} from './periodos'

// Propiedades de lo que calcula la pantalla Reportes (tarea 1.9): los períodos y el CSV para Excel.

const CONFIG = { seed: 20_261_061, numRuns: 300 }
const ATAJOS: Atajo[] = ['today', 'yesterday', 'week', 'month', 'lastMonth']

const day = fc
  .date({
    min: new Date('2019-01-01T12:00:00Z'),
    max: new Date('2036-12-31T12:00:00Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10))

const entreDias = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

describe('períodos', () => {
  it('sumar y restar los mismos días vuelve al mismo día, y avanza uno a uno', () => {
    fc.assert(
      fc.property(day, fc.integer({ min: -4_000, max: 4_000 }), (d, n) => {
        expect(sumarDias(sumarDias(d, n), -n)).toBe(d)
        expect(sumarDias(d, n)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(entreDias(d, sumarDias(d, n))).toBe(n)
      }),
      CONFIG,
    )
  })

  it('todos los atajos dan fechas válidas, en orden y dentro de lo que acepta el hub', () => {
    fc.assert(
      fc.property(day, (today) => {
        for (const atajo of ATAJOS) {
          const { from, until } = periodoDe(atajo, today)
          expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
          expect(until).toMatch(/^\d{4}-\d{2}-\d{2}$/)
          expect(from <= until, atajo).toBe(true)
          expect(entreDias(from, until) + 1, atajo).toBeLessThanOrEqual(MAX_DIAS)
          // Ningún atajo mira al futuro.
          expect(until <= today, atajo).toBe(true)
        }
        expect(periodoDe('today', today)).toEqual({ from: today, until: today })
        expect(periodoDe('yesterday', today).until).toBe(sumarDias(today, -1))
        const week = periodoDe('week', today)
        expect(entreDias(week.from, week.until) + 1).toBe(7)
        expect(week.until).toBe(today)
      }),
      CONFIG,
    )
  })

  it('el mes va del 1 a hoy y el mes pasado del 1 al último día, sin huecos entre los dos', () => {
    fc.assert(
      fc.property(day, (today) => {
        const month = periodoDe('month', today)
        const pasado = periodoDe('lastMonth', today)
        expect(month.from.slice(0, 7)).toBe(today.slice(0, 7))
        expect(month.from.endsWith('-01')).toBe(true)
        expect(month.until).toBe(today)
        expect(pasado.from.endsWith('-01')).toBe(true)
        // El mes pasado termina el día antes de que empiece este, y es de un solo mes.
        expect(sumarDias(pasado.until, 1)).toBe(month.from)
        expect(pasado.from.slice(0, 7)).toBe(pasado.until.slice(0, 7))
        // El día siguiente al último no sigue en el mismo mes.
        expect(sumarDias(pasado.until, 1).slice(0, 7)).not.toBe(pasado.until.slice(0, 7))
      }),
      CONFIG,
    )
  })

  it('casos de calendario: enero, año bisiesto, fin de mes y mes de 31 días', () => {
    expect(periodoDe('lastMonth', '2026-01-15')).toEqual({
      from: '2025-12-01',
      until: '2025-12-31',
    })
    expect(periodoDe('lastMonth', '2028-03-01')).toEqual({
      from: '2028-02-01',
      until: '2028-02-29',
    })
    expect(periodoDe('lastMonth', '2026-03-31')).toEqual({
      from: '2026-02-01',
      until: '2026-02-28',
    })
    expect(periodoDe('month', '2026-10-01')).toEqual({ from: '2026-10-01', until: '2026-10-01' })
    expect(periodoDe('week', '2026-01-03')).toEqual({ from: '2025-12-28', until: '2026-01-03' })
    expect(periodoDe('yesterday', '2026-03-01')).toEqual({
      from: '2026-02-28',
      until: '2026-02-28',
    })
  })

  it('los puntos básicos salen en porcentaje con coma', () => {
    expect(puntosEnPorcentaje(1000)).toBe('10 %')
    expect(puntosEnPorcentaje(800)).toBe('8 %')
    expect(puntosEnPorcentaje(1250)).toBe('12,5 %')
    expect(puntosEnPorcentaje(0)).toBe('0 %')
    expect(puntosEnPorcentaje(1900)).toBe('19 %')
  })
})

// ── CSV ────────────────────────────────────────────────────────────────

/** Lee un CSV con punto y coma, comillas dobles (con saltos de línea dentro) y CRLF. */
function leerCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let celdaActual = ''
  let entreComillas = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i] as string
    if (entreComillas) {
      if (c === '"' && csv[i + 1] === '"') {
        celdaActual += '"'
        i += 1
      } else if (c === '"') entreComillas = false
      else celdaActual += c
    } else if (c === '"') entreComillas = true
    else if (c === ';') {
      row.push(celdaActual)
      celdaActual = ''
    } else if (c === '\r' && csv[i + 1] === '\n') {
      row.push(celdaActual)
      rows.push(row)
      row = []
      celdaActual = ''
      i += 1
    } else celdaActual += c
  }
  if (celdaActual !== '' || row.length > 0) {
    row.push(celdaActual)
    rows.push(row)
  }
  return rows
}

/** Las secciones: grupos de filas separados por una fila vacía. */
function sections(csv: string): string[][][] {
  const allRows = leerCsv(csv.replace('﻿', ''))
  const groups: string[][][] = [[]]
  for (const f of allRows) {
    if (f.length === 1 && f[0] === '') groups.push([])
    else groups[groups.length - 1]?.push(f)
  }
  return groups.filter((g) => g.length > 0)
}

const HOSTILE = [
  '=HYPERLINK("http://x","clic")',
  '+1+1',
  '-2+3',
  '@SUM(A1)',
  '\t=1',
  '\r=1',
  'dos;columnas',
  'con "comillas"',
  'varias\nlíneas',
  'varias\r\nlíneas;y "todo"',
  '"empieza con comilla',
  ';',
  '',
  ' =no es fórmula',
  "'=ya tenía apóstrofo",
  'ñandú café 🍕',
]
const text = fc.oneof(
  fc.constantFrom(...HOSTILE),
  fc.string({ unit: 'grapheme', maxLength: 30 }),
  fc.string({ unit: 'binary', maxLength: 20 }),
)
const amount = fc.integer({ min: -9_999_999_999, max: 9_999_999_999 })
const time = fc
  .date({
    min: new Date('2026-01-01T00:00:00Z'),
    max: new Date('2026-12-31T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString())

const report = fc.record({
  product: fc.array(text, { maxLength: 5 }),
  waiter: fc.array(text, { maxLength: 3 }),
  reason: fc.array(text, { maxLength: 3 }),
  justification: fc.option(text, { nil: null }),
  restaurant: text,
  medioPropio: text,
  nets: fc.array(amount, { minLength: 8, maxLength: 8 }),
  time,
  rate: fc.constantFrom(0, 800, 1900, 1250),
})
type Caso = typeof report extends fc.Arbitrary<infer T> ? T : never

const ID_PROPIO = '01JB0000000000000000000099'
const REGLAS = (c: Caso) =>
  ({
    timeZone: 'America/Bogota',
    mediosPropios: [{ id: ID_PROPIO, name: c.medioPropio }],
  }) as unknown as ReglasCobro

function build(c: Caso): Reporte {
  const [n0, n1, n2, n3, n4, n5, n6, n7] = c.nets as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const usuarios = Object.fromEntries(c.waiter.map((n, i) => [`u${i}`, n]))
  const closeout: CierreReporte = {
    shiftId: 't1',
    businessDay: '2026-10-24',
    openedAt: c.time,
    abiertoPor: 'u0',
    cerradoPor: 'u0',
    base: n0,
    byMethod: [],
    closed: {
      expected: n1,
      counted: n2,
      variance: n3,
      justification: c.justification,
      otherMethods: [
        { method: 'other', customMethodId: ID_PROPIO, expected: n4, reported: n5, variance: n6 },
      ] as never,
      time: c.time,
    },
  }
  return {
    today: '2026-10-24',
    usuarios,
    printer: false,
    closings: [closeout],
    report: {
      from: '2026-10-24',
      until: '2026-10-24',
      sales: {
        gross: n0,
        voided: n1,
        discounts: n2,
        net: n3,
        settings: n4,
        taxes: [{ type: 'inc', rate: c.rate, base: n5, tax: n6 }],
        tips: n7,
        checks: 3,
        guests: 5,
        averageTicket: n0,
        spendPerGuest: n1,
      },
      byMethod: [{ method: 'other', customMethodId: ID_PROPIO, sale: n2, tip: n3, payments: 2 }],
      byWaiter: c.waiter.map((_, i) => ({
        userId: `u${i}`,
        net: n0,
        checks: 1,
        averageTicket: n0,
      })),
      byProduct: c.product.map((name, i) => ({
        productId: `p${i}`,
        variantId: null,
        name,
        units: i + 1,
        net: n1,
      })),
      voids: c.reason.map((m, i) => ({
        eventId: `e${i}`,
        orderId: 'x',
        orderNumber: i % 2 === 0 ? i + 1 : null,
        name: c.product[0] ?? 'Producto',
        units: 1,
        value: n2,
        reason: m,
        alreadyPrepared: i % 2 === 0,
        userId: 'u0',
        authorizedById: i % 2 === 0 ? 'u0' : null,
        time: c.time,
      })),
      cancellations: c.reason.map((m, i) => ({
        eventId: `c${i}`,
        orderId: 'x',
        orderNumber: null,
        value: n3,
        reason: m,
        userId: 'u0',
        authorizedById: null,
        time: c.time,
      })),
      discounts: [
        {
          orderId: 'x',
          orderNumber: 4,
          rule: 'percent',
          value: c.rate,
          amount: n4,
          reason: c.reason[0] ?? null,
        },
        { orderId: 'x', orderNumber: null, rule: 'value', value: n5, amount: n5, reason: null },
      ],
      tipPool: { tips: n5, paidOut: n6, balance: n7 },
    },
  }
}

/** Lo que debe leer Excel de un texto: el mismo, con un apóstrofo delante si parecería fórmula. */
const neutralizado = (t: string) => (/^[=+\-@\t\r]/.test(t) ? `'${t}` : t)

describe('CSV: una celda', () => {
  it('un texto nunca queda como fórmula y se lee igual que se escribió', () => {
    fc.assert(
      fc.property(text, (t) => {
        const rows = leerCsv(`${celda(t)}\r\n`)
        const leida = rows[0]?.[0] ?? ''
        expect(rows).toHaveLength(1)
        expect(rows[0]).toHaveLength(1)
        expect(leida).toBe(neutralizado(t))
        expect(/^[=+\-@\t\r]/.test(leida)).toBe(false)
        // Lo que va sin comillas no tiene nada que parta la fila.
        if (!celda(t).startsWith('"')) expect(celda(t)).not.toMatch(/[;"\n\r]/)
      }),
      CONFIG,
    )
  })

  it('un número va tal cual, entero y sin separador de miles, también negativo', () => {
    fc.assert(
      fc.property(fc.integer({ min: -9_999_999_999, max: 9_999_999_999 }), (n) => {
        expect(celda(n)).toBe(String(n))
        expect(celda(n)).toMatch(/^-?\d+$/)
      }),
      CONFIG,
    )
  })

  it('casos concretos de Excel', () => {
    expect(celda('=1+1')).toBe("'=1+1")
    expect(celda('+57 300')).toBe("'+57 300")
    expect(celda('-')).toBe("'-")
    expect(celda('@x')).toBe("'@x")
    expect(celda('\tx')).toBe("'\tx")
    expect(celda('a;b')).toBe('"a;b"')
    expect(celda('a\nb')).toBe('"a\nb"')
    expect(celda('a\r\nb')).toBe('"a\r\nb"')
    expect(celda('"')).toBe('""""')
    expect(celda('=a;b')).toBe(`"'=a;b"`)
    expect(celda('')).toBe('')
  })
})

describe('CSV: el reporte entero', () => {
  const period = { from: '2026-10-24', until: '2026-10-24' }

  it('con cualquier texto: BOM al inicio, mismas secciones, filas parejas y nada que sea fórmula', () => {
    fc.assert(
      fc.property(report, (c) => {
        const csv = csvDeReporte(build(c), period, REGLAS(c), c.restaurant)
        expect(csv.startsWith('﻿')).toBe(true)
        expect(csv.indexOf('﻿', 1)).toBe(-1)
        expect(csv.endsWith('\r\n')).toBe(true)
        const groups = sections(csv)
        // Tantas secciones como en un reporte vacío de textos (los textos no crean ni quitan).
        const referencia = sections(
          csvDeReporte(
            build({ ...c, product: [], waiter: [], reason: [] }),
            period,
            REGLAS(c),
            'R',
          ),
        )
        // Las secciones con filas de datos pueden quedar solo con encabezado, pero siguen ahí.
        expect(groups.length).toBe(referencia.length)
        for (const g of groups) {
          const width = g[0]?.length
          for (const f of g) expect(f.length, g[0]?.[0]).toBe(width)
        }
        // Ninguna celda leída empieza como fórmula, salvo números con signo.
        for (const g of groups)
          for (const f of g)
            for (const x of f)
              if (!/^-?\d+$/.test(x)) expect(/^[=+\-@\t\r]/.test(x), JSON.stringify(x)).toBe(false)
      }),
      CONFIG,
    )
  })

  it('los textos del restaurante vuelven iguales (con apóstrofo si parecían fórmula)', () => {
    fc.assert(
      fc.property(report, (c) => {
        const r = build(c)
        const groups = sections(csvDeReporte(r, period, REGLAS(c), c.restaurant))
        expect(groups[0]?.[0]).toEqual(['Reporte', neutralizado(c.restaurant)].map((x) => x))
        const products = groups.find((g) => g[0]?.[0] === 'Producto') ?? []
        expect(products.slice(1).map((f) => f[0])).toEqual(c.product.map(neutralizado))
        const waiters = groups.find((g) => g[0]?.[0] === 'Mesero') ?? []
        expect(waiters.slice(1).map((f) => f[0])).toEqual(c.waiter.map(neutralizado))
        const voids = groups.find((g) => g[0]?.[0] === 'Anulación') ?? []
        expect(voids.slice(1).map((f) => f[4])).toEqual(c.reason.map(neutralizado))
        const medios = groups.find((g) => g[0]?.[0] === 'Medio de pago') ?? []
        expect(medios[1]?.[0]).toBe(neutralizado(c.medioPropio))
        const closings =
          groups.find((g) => g[0]?.[0] === 'Cierre de caja' && g[0]?.[1] === 'Abrió') ?? []
        expect(closings[1]?.[7]).toBe(neutralizado(c.justification ?? ''))
      }),
      CONFIG,
    )
  })

  it('los montos salen como enteros en pesos, sin separador de miles ni decimales', () => {
    fc.assert(
      fc.property(report, (c) => {
        const r = build(c)
        const v = r.report.sales
        const groups = sections(csvDeReporte(r, period, REGLAS(c), 'R'))
        const sales = new Map(
          (groups.find((g) => g[0]?.[0] === 'Ventas') ?? []).map((f) => [f[0], f[1]]),
        )
        expect(sales.get('Neto')).toBe(String(v.net))
        expect(sales.get('Bruto')).toBe(String(v.gross))
        expect(sales.get('Ajuste por redondeo')).toBe(String(v.settings))
        expect(sales.get('Propinas')).toBe(String(v.tips))
        expect(sales.get('Ticket promedio')).toBe(String(v.averageTicket))
        // Las filas de cifras (todas menos el encabezado y los nombres de la sección) son enteros.
        for (const g of groups)
          if (['Ventas', 'Fondo de propinas'].includes(g[0]?.[0] ?? ''))
            for (const f of g.slice(1)) expect(f[1], f[0]).toMatch(/^-?\d+$/)
        const medios = groups.find((g) => g[0]?.[0] === 'Medio de pago') ?? []
        for (const f of medios.slice(1)) for (const x of f.slice(1)) expect(x).toMatch(/^-?\d+$/)
        const closeout =
          groups.find((g) => g[0]?.[0] === 'Cierre de caja' && g[0]?.[1] === 'Abrió') ?? []
        for (const x of (closeout[1] ?? []).slice(3, 7)) expect(x).toMatch(/^-?\d+$/)
        const others = groups.find((g) => g[0]?.[1] === 'Otro medio') ?? []
        expect(others).toHaveLength(2)
        for (const x of (others[1] ?? []).slice(2)) expect(x).toMatch(/^-?\d+$/)
        // Los impuestos llevan la tarifa con coma en el nombre, no en el monto.
        expect(sales.get(`Impuesto INC ${puntosEnPorcentaje(c.rate)}`)).toBe(
          String(r.report.sales.taxes[0]?.tax),
        )
      }),
      CONFIG,
    )
  })

  it('el descuento por porcentaje lleva el valor en porcentaje con coma y trae su pedido', () => {
    fc.assert(
      fc.property(report, (c) => {
        const groups = sections(csvDeReporte(build(c), period, REGLAS(c), 'R'))
        const d = groups.find((g) => g[0]?.[0] === 'Descuento') ?? []
        expect(d[0]).toEqual(['Descuento', 'Pedido', 'Valor', 'Monto', 'Motivo'])
        expect(d[1]?.slice(0, 3)).toEqual(['Porcentaje', '4', puntosEnPorcentaje(c.rate)])
        expect(d[2]?.slice(0, 2)).toEqual(['Valor', ''])
      }),
      { ...CONFIG, numRuns: 100 },
    )
  })

  it('un reporte vacío sigue siendo un CSV válido, con BOM', () => {
    const empty: Reporte = {
      today: '2026-10-24',
      usuarios: {},
      printer: false,
      closings: [],
      report: {
        from: '2026-10-24',
        until: '2026-10-24',
        sales: {
          gross: 0,
          voided: 0,
          discounts: 0,
          net: 0,
          settings: 0,
          taxes: [],
          tips: 0,
          checks: 0,
          guests: 0,
          averageTicket: 0,
          spendPerGuest: 0,
        },
        byMethod: [],
        byWaiter: [],
        byProduct: [],
        voids: [],
        cancellations: [],
        discounts: [],
        tipPool: { tips: 0, paidOut: 0, balance: 0 },
      },
    }
    const csv = csvDeReporte(empty, period, null, '')
    expect(csv.startsWith('﻿Reporte;')).toBe(true)
    expect(csv).toContain('Neto;0')
    expect(csv).not.toMatch(/NaN|undefined|null/)
  })
})
