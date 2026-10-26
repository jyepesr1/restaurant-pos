import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  asText,
  CODE_PAGES,
  COLUMNS,
  encode,
  escpos,
  type Line,
  pesos,
  readEscpos,
  type ZReport,
  zReportLines,
} from './index'

// The Z report on paper with any data (task 1.9): no line exceeds the width, no restaurant text
// gives commands to the printer and amounts print in full.

const WIDTHS = [58, 80] as const
const HOSTILE = [
  '\x1b@',
  '\x1bp\x00\x19\x19', // drawer pulse
  '\x1dV\x00', // cut
  '\x10\x04\x01',
  '\x1d!\x77',
  '‮No​Pagar⁠﻿',
  '\x00\x07\x08\x09\x0a\x0b\x0c\x0d\x7f\x80\x9f',
  '  ',
  '=HYPERLINK("x")',
]
const text = fc.oneof(
  { weight: 3, arbitrary: fc.string({ unit: 'grapheme', maxLength: 70 }) },
  { weight: 2, arbitrary: fc.string({ unit: 'binary', maxLength: 70 }) },
  { weight: 2, arbitrary: fc.constantFrom(...HOSTILE) },
  {
    weight: 1,
    arbitrary: fc.constantFrom('ñÑáéíóú¿¡ü', 'Crème brûlée', '🍕 漢字', 'x'.repeat(200)),
  },
)
// Amounts from zero to billions, and signed where the Z report allows it.
const pesosArb = fc.oneof(
  fc.integer({ min: 0, max: 999 }),
  fc.integer({ min: 0, max: 99_999_999_999 }),
)
const withSign = fc.integer({ min: -99_999_999, max: 99_999_999 })

const method = fc.record({
  name: text,
  expected: withSign,
  reported: withSign,
  variance: withSign,
})
const closeout = fc.record<ZReport>({
  restaurant: text,
  day: text,
  opened: text,
  closed: text,
  openedByName: text,
  closedByName: text,
  cash: fc.record({
    base: pesosArb,
    charged: pesosArb,
    refunds: pesosArb,
    entries: pesosArb,
    outflows: pesosArb,
    tipPayouts: pesosArb,
    expected: withSign,
    counted: pesosArb,
    variance: withSign,
  }),
  otherMethods: fc.array(method, { maxLength: 5 }),
  justification: fc.option(text, { nil: null }),
  charged: fc.array(fc.record({ name: text, sale: withSign, tip: withSign }), {
    maxLength: 6,
  }),
  sales: fc.record({
    net: pesosArb,
    taxes: fc.array(fc.record({ name: text, base: pesosArb, value: pesosArb }), {
      maxLength: 4,
    }),
    tips: withSign,
    settings: withSign,
    checks: fc.nat(9_999),
    guests: fc.nat(99_999),
    averageTicket: pesosArb,
    voided: pesosArb,
    canceled: pesosArb,
    discounts: pesosArb,
  }),
  reprinted: fc.option(text, { nil: null }),
})

const texts = (lines: readonly Line[]) =>
  lines.filter((l): l is Extract<Line, { text: string }> => 'text' in l)

/** Accepts only the commands `escpos.ts` uses; any other, or a control byte, is an injection. */
function parse(bytes: Uint8Array) {
  let cuts = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    const n = bytes[i + 1]
    const m = bytes[i + 2]
    if (b === 0x1b) {
      if (n === 0x40) i += 1
      else if (n === 0x74 && (m === 2 || m === 16)) i += 2
      else if ((n === 0x61 || n === 0x45) && (m === 0 || m === 1)) i += 2
      else if (n === 0x64 && m === 4) i += 2
      else throw new Error(`Unexpected ESC command at ${i}: ${n} ${m}`)
    } else if (b === 0x1d) {
      if (n === 0x42 && (m === 0 || m === 1)) i += 2
      else if (n === 0x21 && (m === 0 || m === 0x11)) i += 2
      else if (n === 0x56 && m === 0x42 && bytes[i + 3] === 0) {
        cuts += 1
        i += 3
      } else throw new Error(`Unexpected GS command at ${i}: ${n} ${m}`)
    } else if (b === 0x0a) continue
    else if (b >= 0x20 && b !== 0x7f) continue
    else throw new Error(`Stray control byte at ${i}: ${b}`)
  }
  return { cuts }
}

describe('printed Z report properties', () => {
  it.each(WIDTHS)('at %i mm no line exceeds the width, with any text and code page', (mm) => {
    const columns = COLUMNS[mm]
    fc.assert(
      fc.property(closeout, fc.constantFrom(...CODE_PAGES), (z, p) => {
        for (const l of texts(zReportLines(z, { columns, page: p }))) {
          const fits = l.large ? Math.floor(columns / 2) : columns
          expect(l.text.length).toBeLessThanOrEqual(fits)
          expect(encode(l.text, p).length).toBeLessThanOrEqual(fits)
        }
      }),
      { seed: 1901, numRuns: 300 },
    )
  })

  it.each(WIDTHS)('at %i mm the bytes read back fit and carry no foreign commands', (mm) => {
    const columns = COLUMNS[mm]
    fc.assert(
      fc.property(closeout, fc.constantFrom(...CODE_PAGES), (z, p) => {
        const format = { columns, page: p }
        const lines = zReportLines(z, format)
        const bytes = escpos(lines, format)
        parse(bytes)
        const printedOnes = readEscpos(bytes).text.split('\n').slice(0, lines.length)
        printedOnes.forEach((printed, i) => {
          const source = lines[i] as Line
          const fits = 'text' in source && source.large ? Math.floor(columns / 2) : columns
          expect(printed.length).toBeLessThanOrEqual(fits)
        })
      }),
      { seed: 1902, numRuns: 150 },
    )
  })

  it('always has the title, signatures and cash totals, whatever the width', () => {
    fc.assert(
      fc.property(closeout, (z) => {
        const t80 = asText(zReportLines(z, { columns: COLUMNS[80], page: 'pc850' }), COLUMNS[80])
        const t58 = asText(zReportLines(z, { columns: COLUMNS[58], page: 'pc850' }), COLUMNS[58])
        for (const t of [t80, t58]) {
          expect(t).toContain('CIERRE DE CAJA')
          expect(t).toContain('Firma cajero')
          expect(t).toContain('Firma de quien recibe')
        }
        // Cash amounts print in full even if the line wraps: at each width, without spaces or
        // line breaks, the amount appears.
        const floorPlan = (t: string) => t.replace(/\s+/g, '')
        for (const amount of [z.cash.expected, z.cash.counted, z.cash.base])
          for (const t of [t80, t58])
            expect(floorPlan(t)).toContain(floorPlan(pesos(Math.abs(amount))))
        // A reprint says so and an original does not.
        expect(t80.includes('Reimpresión')).toBe(Boolean(z.reprinted))
      }),
      { seed: 1903, numRuns: 200 },
    )
  })

  it('the variance says Cuadra, Sobran or Faltan depending on its sign', () => {
    const base = {
      restaurant: 'R',
      day: 'sábado 24 de octubre de 2026',
      opened: '1',
      closed: '2',
      openedByName: 'A',
      closedByName: 'B',
      cash: {
        base: 0,
        charged: 0,
        refunds: 0,
        entries: 0,
        outflows: 0,
        tipPayouts: 0,
        expected: 100,
        counted: 100,
        variance: 0,
      },
      otherMethods: [],
      justification: null,
      charged: [],
      sales: {
        net: 0,
        taxes: [],
        tips: 0,
        checks: 0,
        guests: 0,
        averageTicket: 0,
        voided: 0,
        canceled: 0,
        discounts: 0,
      },
      reprinted: null,
    } satisfies ZReport
    const says = (variance: number) =>
      asText(
        zReportLines(
          { ...base, cash: { ...base.cash, variance } },
          {
            columns: COLUMNS[80],
            page: 'pc850',
          },
        ),
        COLUMNS[80],
      )
    expect(says(0)).toContain('Cuadra')
    expect(says(1_500)).toContain('Sobran $1.500')
    expect(says(-1_500)).toContain('Faltan $1.500')
    expect(says(-1_500)).not.toContain('Sobran')
    // Without taxes, voids or methods: no empty sections are printed.
    const t = says(0)
    for (const share of ['Anulado', 'Otros medios', 'Justificación', 'Cobrado en el turno'])
      expect(t).not.toContain(share)
  })
})
