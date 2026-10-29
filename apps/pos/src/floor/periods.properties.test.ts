import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { CheckoutRules } from './checks'
import type { PeriodReport, ReportClose } from './engine'
import {
  addDays,
  cell,
  MAX_DAYS,
  periodOf,
  pointsAsPercent,
  reportCsv,
  type Shortcut,
} from './periods'

// Properties of what the Reportes screen computes (task 1.9): the periods and the CSV for Excel.

const CONFIG = { seed: 20_261_061, numRuns: 300 }
const SHORTCUTS: Shortcut[] = ['today', 'yesterday', 'week', 'month', 'lastMonth']

const day = fc
  .date({
    min: new Date('2019-01-01T12:00:00Z'),
    max: new Date('2036-12-31T12:00:00Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10))

const betweenDays = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

describe('periods', () => {
  it('adding and subtracting the same days returns to the same day, and steps one by one', () => {
    fc.assert(
      fc.property(day, fc.integer({ min: -4_000, max: 4_000 }), (d, n) => {
        expect(addDays(addDays(d, n), -n)).toBe(d)
        expect(addDays(d, n)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(betweenDays(d, addDays(d, n))).toBe(n)
      }),
      CONFIG,
    )
  })

  it('every shortcut gives valid dates, in order and within what the hub accepts', () => {
    fc.assert(
      fc.property(day, (today) => {
        for (const shortcut of SHORTCUTS) {
          const { from, until } = periodOf(shortcut, today)
          expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
          expect(until).toMatch(/^\d{4}-\d{2}-\d{2}$/)
          expect(from <= until, shortcut).toBe(true)
          expect(betweenDays(from, until) + 1, shortcut).toBeLessThanOrEqual(MAX_DAYS)
          // No shortcut looks into the future.
          expect(until <= today, shortcut).toBe(true)
        }
        expect(periodOf('today', today)).toEqual({ from: today, until: today })
        expect(periodOf('yesterday', today).until).toBe(addDays(today, -1))
        const week = periodOf('week', today)
        expect(betweenDays(week.from, week.until) + 1).toBe(7)
        expect(week.until).toBe(today)
      }),
      CONFIG,
    )
  })

  it('the month runs from the 1st to today and last month from the 1st to the last day, with no gaps between them', () => {
    fc.assert(
      fc.property(day, (today) => {
        const month = periodOf('month', today)
        const past = periodOf('lastMonth', today)
        expect(month.from.slice(0, 7)).toBe(today.slice(0, 7))
        expect(month.from.endsWith('-01')).toBe(true)
        expect(month.until).toBe(today)
        expect(past.from.endsWith('-01')).toBe(true)
        // Last month ends the day before this one starts, and spans a single month.
        expect(addDays(past.until, 1)).toBe(month.from)
        expect(past.from.slice(0, 7)).toBe(past.until.slice(0, 7))
        // The day after the last one is not in the same month.
        expect(addDays(past.until, 1).slice(0, 7)).not.toBe(past.until.slice(0, 7))
      }),
      CONFIG,
    )
  })

  it('calendar cases: January, leap year, end of month and 31-day month', () => {
    expect(periodOf('lastMonth', '2026-01-15')).toEqual({
      from: '2025-12-01',
      until: '2025-12-31',
    })
    expect(periodOf('lastMonth', '2028-03-01')).toEqual({
      from: '2028-02-01',
      until: '2028-02-29',
    })
    expect(periodOf('lastMonth', '2026-03-31')).toEqual({
      from: '2026-02-01',
      until: '2026-02-28',
    })
    expect(periodOf('month', '2026-10-01')).toEqual({ from: '2026-10-01', until: '2026-10-01' })
    expect(periodOf('week', '2026-01-03')).toEqual({ from: '2025-12-28', until: '2026-01-03' })
    expect(periodOf('yesterday', '2026-03-01')).toEqual({
      from: '2026-02-28',
      until: '2026-02-28',
    })
  })

  it('basis points come out as a percentage with a decimal comma', () => {
    expect(pointsAsPercent(1000)).toBe('10 %')
    expect(pointsAsPercent(800)).toBe('8 %')
    expect(pointsAsPercent(1250)).toBe('12,5 %')
    expect(pointsAsPercent(0)).toBe('0 %')
    expect(pointsAsPercent(1900)).toBe('19 %')
  })
})

// ── CSV ────────────────────────────────────────────────────────────────

/** Reads a CSV with semicolons, double quotes (with line breaks inside) and CRLF. */
function readCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let currentCell = ''
  let inQuotes = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i] as string
    if (inQuotes) {
      if (c === '"' && csv[i + 1] === '"') {
        currentCell += '"'
        i += 1
      } else if (c === '"') inQuotes = false
      else currentCell += c
    } else if (c === '"') inQuotes = true
    else if (c === ';') {
      row.push(currentCell)
      currentCell = ''
    } else if (c === '\r' && csv[i + 1] === '\n') {
      row.push(currentCell)
      rows.push(row)
      row = []
      currentCell = ''
      i += 1
    } else currentCell += c
  }
  if (currentCell !== '' || row.length > 0) {
    row.push(currentCell)
    rows.push(row)
  }
  return rows
}

/** The sections: groups of rows separated by an empty row. */
function sections(csv: string): string[][][] {
  const allRows = readCsv(csv.replace('﻿', ''))
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
  customMethod: text,
  nets: fc.array(amount, { minLength: 8, maxLength: 8 }),
  time,
  rate: fc.constantFrom(0, 800, 1900, 1250),
})
type Case = typeof report extends fc.Arbitrary<infer T> ? T : never

const CUSTOM_ID = '01JB0000000000000000000099'
const RULES = (c: Case) =>
  ({
    timeZone: 'America/Bogota',
    customMethods: [{ id: CUSTOM_ID, name: c.customMethod }],
  }) as unknown as CheckoutRules

function build(c: Case): PeriodReport {
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
  const users = Object.fromEntries(c.waiter.map((n, i) => [`u${i}`, n]))
  const closeout: ReportClose = {
    shiftId: 't1',
    businessDay: '2026-10-24',
    openedAt: c.time,
    openedBy: 'u0',
    closedBy: 'u0',
    base: n0,
    byMethod: [],
    closed: {
      expected: n1,
      counted: n2,
      variance: n3,
      justification: c.justification,
      otherMethods: [
        { method: 'other', customMethodId: CUSTOM_ID, expected: n4, reported: n5, variance: n6 },
      ] as never,
      time: c.time,
    },
  }
  return {
    today: '2026-10-24',
    users,
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
        roundingAdjustments: n4,
        taxes: [{ type: 'inc', rate: c.rate, base: n5, tax: n6 }],
        tips: n7,
        checks: 3,
        guests: 5,
        averageTicket: n0,
        spendPerGuest: n1,
      },
      byMethod: [{ method: 'other', customMethodId: CUSTOM_ID, sale: n2, tip: n3, payments: 2 }],
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

/** What Excel must read from a text: the same, with a leading apostrophe if it looks like a formula. */
const neutralized = (t: string) => (/^[=+\-@\t\r]/.test(t) ? `'${t}` : t)

describe('CSV: one cell', () => {
  it('a text never ends up as a formula and reads back the same as it was written', () => {
    fc.assert(
      fc.property(text, (t) => {
        const rows = readCsv(`${cell(t)}\r\n`)
        const readCell = rows[0]?.[0] ?? ''
        expect(rows).toHaveLength(1)
        expect(rows[0]).toHaveLength(1)
        expect(readCell).toBe(neutralized(t))
        expect(/^[=+\-@\t\r]/.test(readCell)).toBe(false)
        // What goes unquoted has nothing that would break the row.
        if (!cell(t).startsWith('"')) expect(cell(t)).not.toMatch(/[;"\n\r]/)
      }),
      CONFIG,
    )
  })

  it('a number goes as is, integer and without a thousands separator, negative too', () => {
    fc.assert(
      fc.property(fc.integer({ min: -9_999_999_999, max: 9_999_999_999 }), (n) => {
        expect(cell(n)).toBe(String(n))
        expect(cell(n)).toMatch(/^-?\d+$/)
      }),
      CONFIG,
    )
  })

  it('concrete Excel cases', () => {
    expect(cell('=1+1')).toBe("'=1+1")
    expect(cell('+57 300')).toBe("'+57 300")
    expect(cell('-')).toBe("'-")
    expect(cell('@x')).toBe("'@x")
    expect(cell('\tx')).toBe("'\tx")
    expect(cell('a;b')).toBe('"a;b"')
    expect(cell('a\nb')).toBe('"a\nb"')
    expect(cell('a\r\nb')).toBe('"a\r\nb"')
    expect(cell('"')).toBe('""""')
    expect(cell('=a;b')).toBe(`"'=a;b"`)
    expect(cell('')).toBe('')
  })
})

describe('CSV: the whole report', () => {
  const period = { from: '2026-10-24', until: '2026-10-24' }

  it('with any text: BOM at the start, same sections, even rows and nothing that is a formula', () => {
    fc.assert(
      fc.property(report, (c) => {
        const csv = reportCsv(build(c), period, RULES(c), c.restaurant)
        expect(csv.startsWith('﻿')).toBe(true)
        expect(csv.indexOf('﻿', 1)).toBe(-1)
        expect(csv.endsWith('\r\n')).toBe(true)
        const groups = sections(csv)
        // As many sections as in a report with empty texts (texts neither create nor remove them).
        const reference = sections(
          reportCsv(build({ ...c, product: [], waiter: [], reason: [] }), period, RULES(c), 'R'),
        )
        // Sections with data rows may end up with only a header, but they are still there.
        expect(groups.length).toBe(reference.length)
        for (const g of groups) {
          const width = g[0]?.length
          for (const f of g) expect(f.length, g[0]?.[0]).toBe(width)
        }
        // No cell read starts as a formula, except signed numbers.
        for (const g of groups)
          for (const f of g)
            for (const x of f)
              if (!/^-?\d+$/.test(x)) expect(/^[=+\-@\t\r]/.test(x), JSON.stringify(x)).toBe(false)
      }),
      CONFIG,
    )
  })

  it('the restaurant texts come back the same (with an apostrophe if they looked like a formula)', () => {
    fc.assert(
      fc.property(report, (c) => {
        const r = build(c)
        const groups = sections(reportCsv(r, period, RULES(c), c.restaurant))
        expect(groups[0]?.[0]).toEqual(['Reporte', neutralized(c.restaurant)].map((x) => x))
        const products = groups.find((g) => g[0]?.[0] === 'Producto') ?? []
        expect(products.slice(1).map((f) => f[0])).toEqual(c.product.map(neutralized))
        const waiters = groups.find((g) => g[0]?.[0] === 'Mesero') ?? []
        expect(waiters.slice(1).map((f) => f[0])).toEqual(c.waiter.map(neutralized))
        const voids = groups.find((g) => g[0]?.[0] === 'Anulación') ?? []
        expect(voids.slice(1).map((f) => f[4])).toEqual(c.reason.map(neutralized))
        const methods = groups.find((g) => g[0]?.[0] === 'Medio de pago') ?? []
        expect(methods[1]?.[0]).toBe(neutralized(c.customMethod))
        const closings =
          groups.find((g) => g[0]?.[0] === 'Cierre de caja' && g[0]?.[1] === 'Abrió') ?? []
        expect(closings[1]?.[7]).toBe(neutralized(c.justification ?? ''))
      }),
      CONFIG,
    )
  })

  it('amounts come out as whole pesos, without a thousands separator or decimals', () => {
    fc.assert(
      fc.property(report, (c) => {
        const r = build(c)
        const v = r.report.sales
        const groups = sections(reportCsv(r, period, RULES(c), 'R'))
        const sales = new Map(
          (groups.find((g) => g[0]?.[0] === 'Ventas') ?? []).map((f) => [f[0], f[1]]),
        )
        expect(sales.get('Neto')).toBe(String(v.net))
        expect(sales.get('Bruto')).toBe(String(v.gross))
        expect(sales.get('Ajuste por redondeo')).toBe(String(v.roundingAdjustments))
        expect(sales.get('Propinas')).toBe(String(v.tips))
        expect(sales.get('Ticket promedio')).toBe(String(v.averageTicket))
        // The figure rows (all but the header and the section names) are integers.
        for (const g of groups)
          if (['Ventas', 'Fondo de propinas'].includes(g[0]?.[0] ?? ''))
            for (const f of g.slice(1)) expect(f[1], f[0]).toMatch(/^-?\d+$/)
        const methods = groups.find((g) => g[0]?.[0] === 'Medio de pago') ?? []
        for (const f of methods.slice(1)) for (const x of f.slice(1)) expect(x).toMatch(/^-?\d+$/)
        const closeout =
          groups.find((g) => g[0]?.[0] === 'Cierre de caja' && g[0]?.[1] === 'Abrió') ?? []
        for (const x of (closeout[1] ?? []).slice(3, 7)) expect(x).toMatch(/^-?\d+$/)
        const others = groups.find((g) => g[0]?.[1] === 'Otro medio') ?? []
        expect(others).toHaveLength(2)
        for (const x of (others[1] ?? []).slice(2)) expect(x).toMatch(/^-?\d+$/)
        // Taxes carry the rate with a comma in the name, not in the amount.
        expect(sales.get(`Impuesto INC ${pointsAsPercent(c.rate)}`)).toBe(
          String(r.report.sales.taxes[0]?.tax),
        )
      }),
      CONFIG,
    )
  })

  it('a percentage discount carries the value as a percentage with a comma and includes its order', () => {
    fc.assert(
      fc.property(report, (c) => {
        const groups = sections(reportCsv(build(c), period, RULES(c), 'R'))
        const d = groups.find((g) => g[0]?.[0] === 'Descuento') ?? []
        expect(d[0]).toEqual(['Descuento', 'Pedido', 'Valor', 'Monto', 'Motivo'])
        expect(d[1]?.slice(0, 3)).toEqual(['Porcentaje', '4', pointsAsPercent(c.rate)])
        expect(d[2]?.slice(0, 2)).toEqual(['Valor', ''])
      }),
      { ...CONFIG, numRuns: 100 },
    )
  })

  it('an empty report is still a valid CSV, with a BOM', () => {
    const empty: PeriodReport = {
      today: '2026-10-24',
      users: {},
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
          roundingAdjustments: 0,
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
    const csv = reportCsv(empty, period, null, '')
    expect(csv.startsWith('﻿Reporte;')).toBe(true)
    expect(csv).toContain('Neto;0')
    expect(csv).not.toMatch(/NaN|undefined|null/)
  })
})
