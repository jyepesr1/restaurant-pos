import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  asText,
  CODE_PAGES,
  COLUMNS,
  encode,
  escpos,
  type Line,
  type Ticket,
  testLines,
  ticketLines,
  wrapText,
} from './index'

const ticket: Ticket = {
  type: 'new',
  station: 'Cocina',
  number: 12,
  target: 'Mesa 6',
  order: 3,
  waiter: 'Ana',
  time: '8:42 p. m.',
  guests: 4,
  items: [
    {
      quantity: 2,
      name: 'Burrata Spritz',
      guest: 1,
      course: 'starter',
      options: ['Sin rúgula'],
      notes: null,
    },
    {
      quantity: 1,
      name: 'Tagliata',
      guest: 2,
      course: 'main',
      options: ['Término medio'],
      notes: 'bien caliente',
    },
  ],
}

const firstOne = ticket.items[0] as Ticket['items'][number]
const format80 = { columns: COLUMNS[80], page: 'pc850' as const }

describe('ticket', () => {
  it('has station, target with number, order data and the products by course', () => {
    const text = asText(ticketLines(ticket, format80), 48)
    expect(text).toContain('[COCINA]')
    expect(text).toMatch(/MESA 6 +#12/)
    expect(text).toContain('Pedido 3 · Ana · 8:42 p. m. · 4 pers.')
    expect(text.indexOf('ENTRADA')).toBeLessThan(text.indexOf('FUERTE'))
    expect(text).toContain('2 X BURRATA SPRITZ')
    expect(text).toContain('> Término medio')
    expect(text).toContain('[NOTA: bien caliente]')
  })

  it('void and reprint are marked at the top', () => {
    expect(asText(ticketLines({ ...ticket, type: 'void' }, format80), 48)).toContain(
      '[ANULAR · COCINA]',
    )
    expect(asText(ticketLines({ ...ticket, type: 'reprint' }, format80), 48)).toContain(
      'REIMPRESIÓN',
    )
  })

  it('the order note prints at the top, highlighted', () => {
    const text = asText(ticketLines({ ...ticket, orderNote: 'alérgico al maní' }, format80), 48)
    expect(text).toContain('[NOTA DEL PEDIDO: alérgico al maní]')
    expect(text.indexOf('NOTA DEL PEDIDO')).toBeLessThan(text.indexOf('ENTRADA'))
  })

  it('notes the courses still on hold', () => {
    const text = asText(ticketLines({ ...ticket, heldCourses: ['dessert'] }, format80), 48)
    expect(text).toContain('En espera: Postre')
  })

  it('no line exceeds the width, for any text and width', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 120 }),
        fc.string({ maxLength: 60 }),
        fc.constantFrom(32, 48),
        fc.constantFrom(...CODE_PAGES),
        (name, notes, columns, page) => {
          const lines = ticketLines(
            {
              ...ticket,
              target: name,
              items: [{ ...firstOne, name, notes, options: [notes] }],
            },
            { columns, page },
          )
          for (const l of lines) {
            if (!('text' in l)) continue
            const width = l.large ? columns / 2 : columns
            expect(encode(l.text, page).length).toBeLessThanOrEqual(width)
          }
        },
      ),
      { seed: 14, numRuns: 300 },
    )
  })
})

describe('characters', () => {
  it('pc850 prints accents and ñ with their byte', () => {
    expect(encode('ñÑáéíóú¿¡', 'pc850')).toEqual([
      0xa4, 0xa5, 0xa0, 0x82, 0xa1, 0xa2, 0xa3, 0xa8, 0xad,
    ])
  })

  it('wpc1252 uses the Latin byte', () => {
    expect(encode('ñé', 'wpc1252')).toEqual([0xf1, 0xe9])
  })

  it('without accents strips the accent and the opening marks', () => {
    expect(String.fromCharCode(...encode('¿Señor Café?', 'no_accents'))).toBe('Senor Cafe?')
  })

  it('a name never gives commands to the printer (no control bytes)', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 80 }),
        fc.constantFrom(...CODE_PAGES),
        (t, p) => {
          for (const b of encode(t, p)) {
            expect(b).toBeGreaterThanOrEqual(0x20)
            expect(b).not.toBe(0x7f)
            expect(b).toBeLessThanOrEqual(0xff)
          }
        },
      ),
      { seed: 7, numRuns: 500 },
    )
  })

  it('pc850 prints Latin quotation marks', () => {
    expect(encode('«sin hielo»', 'pc850').slice(0, 1)).toEqual([0xae])
    expect(encode('«sin hielo»', 'pc850').at(-1)).toBe(0xaf)
  })

  it('emoji and anything unknown print as «?»', () => {
    expect(String.fromCharCode(...encode('Pizza 🍕', 'pc850'))).toBe('Pizza ?')
  })
})

describe('wrapText', () => {
  it('wraps by words and cuts a long word', () => {
    expect(wrapText('una dos tres', 7, format80)).toEqual(['una dos', 'tres'])
    expect(wrapText('abcdefghij', 4, format80)).toEqual(['abcd', 'efgh', 'ij'])
  })
})

describe('escpos', () => {
  const lines: Line[] = ticketLines(ticket, format80)

  it('starts by initializing, picks the code page and ends with feed and cut', () => {
    const b = [...escpos(lines, format80)]
    expect(b.slice(0, 5)).toEqual([0x1b, 0x40, 0x1b, 0x74, 2])
    expect(b.slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x00])
  })

  it('without accents does not change the factory code page', () => {
    const b = [...escpos(lines, { ...format80, page: 'no_accents' })]
    expect(b.slice(0, 3)).toEqual([0x1b, 0x40, 0x1b])
    expect(b[3]).not.toBe(0x74)
  })

  it('the test page has a ruler of the exact width', () => {
    const mockPrinter = testLines(
      { printer: 'Barra', stations: ['Barra'], time: '9:00 p. m.' },
      { columns: 32, page: 'pc850' },
    )
    expect(
      mockPrinter.some((l) => 'text' in l && l.text === '12345678901234567890123456789012'),
    ).toBe(true)
  })
})

describe('reader', () => {
  it('what is printed reads back the same, with accents and one cut', async () => {
    const { readEscpos } = await import('./reader')
    const readResult = readEscpos(escpos(ticketLines(ticket, format80), format80))
    expect(readResult.cuts).toBe(1)
    expect(readResult.text).toContain('Término medio')
    expect(readResult.text).toContain('Mesa 6')
  })
})
