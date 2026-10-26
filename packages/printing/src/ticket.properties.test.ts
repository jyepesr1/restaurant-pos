import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  asText,
  CODE_PAGES,
  COLUMNS,
  type CodePage,
  characters,
  clear,
  encode,
  escpos,
  type Line,
  paragraph,
  readEscpos,
  type Ticket,
  type TicketCourse,
  type TicketItem,
  type TicketType,
  testLines,
  ticketLines,
  toSides,
  widthOf,
  wrapText,
} from './index'

// Properties of the printed ticket (ADR-015): with any text the restaurant writes, no line
// exceeds the printer width and the text never gives commands to the paper.

const WIDTHS = [58, 80] as const
const TYPES: TicketType[] = ['newOne', 'reprinting', 'modification', 'voidEntry']
const COURSES: TicketCourse[] = ['entry', 'main', 'dessert']

/** Commands that a malicious text (or a name pasted from another app) could carry. */
const HOSTILE = [
  '\x1b@',
  '\x1bp\x00\x19\x19', // drawer pulse
  '\x1dV\x00', // cut
  '\x1dV\x42\x00',
  '\x10\x04\x01', // real-time status
  '\x1ba\x01\x1bE\x01',
  '\x1d!\x77',
  '\x1b!\xff',
  '‮No​Pagar⁠﻿',
  '\x00\x07\x08\x09\x0a\x0b\x0c\x0d\x7f\x80\x9f',
  '  ',
]

const text = fc.oneof(
  { weight: 4, arbitrary: fc.string({ unit: 'grapheme', maxLength: 70 }) },
  { weight: 3, arbitrary: fc.string({ unit: 'binary', maxLength: 70 }) },
  { weight: 2, arbitrary: fc.constantFrom(...HOSTILE) },
  {
    weight: 2,
    arbitrary: fc
      .array(fc.oneof(fc.constantFrom(...HOSTILE), fc.string({ maxLength: 15 })), { maxLength: 5 })
      .map((a) => a.join(' ')),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom('ñÑáéíóú¿¡ü', 'Crème brûlée', '…€×·“”', 'ß ŉ Ǆ 🍕 漢字'),
  },
)

const item = fc.record<TicketItem>({
  quantity: fc.integer({ min: 1, max: 999 }),
  name: text,
  guest: fc.option(fc.integer({ min: 1, max: 99 }), { nil: null }),
  course: fc.option(fc.constantFrom(...COURSES), { nil: null }),
  options: fc.array(text, { maxLength: 4 }),
  notes: fc.option(text, { nil: null }),
})

const ticket = fc.record<Ticket>({
  type: fc.constantFrom(...TYPES),
  station: text,
  number: fc.option(fc.integer({ min: 1, max: 99_999 }), { nil: null }),
  target: text,
  order: fc.option(fc.integer({ min: 1, max: 99_999 }), { nil: null }),
  waiter: text,
  time: text,
  guests: fc.option(fc.integer({ min: 1, max: 200 }), { nil: null }),
  items: fc.array(item, { maxLength: 8 }),
  heldCourses: fc.option(fc.subarray(COURSES), { nil: undefined }),
})

const page = fc.constantFrom(...CODE_PAGES)
const width = fc.constantFrom(...WIDTHS)

/**
 * Reads ESC/POS commands strictly: accepts only those `escpos.ts` uses, with their possible
 * values. Any other command, or a stray control byte, is an injected command.
 */
function parse(bytes: Uint8Array) {
  const check = { begin: 0, tableName: 0, feed: 0, cuts: 0, breaks: 0, printable: 0 }
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    const n = bytes[i + 1]
    const m = bytes[i + 2]
    if (b === 0x1b) {
      if (n === 0x40) {
        check.begin += 1
        i += 1
      } else if (n === 0x74 && (m === 2 || m === 16)) {
        check.tableName += 1
        i += 2
      } else if ((n === 0x61 || n === 0x45) && (m === 0 || m === 1)) i += 2
      else if (n === 0x64 && m === 4) {
        check.feed += 1
        i += 2
      } else throw new Error(`Unexpected ESC command at ${i}: ${n} ${m}`)
    } else if (b === 0x1d) {
      if (n === 0x42 && (m === 0 || m === 1)) i += 2
      else if (n === 0x21 && (m === 0 || m === 0x11)) i += 2
      else if (n === 0x56 && m === 0x42 && bytes[i + 3] === 0) {
        check.cuts += 1
        i += 3
      } else throw new Error(`Unexpected GS command at ${i}: ${n} ${m}`)
    } else if (b === 0x0a) check.breaks += 1
    else if (b >= 0x20 && b !== 0x7f) check.printable += 1
    else throw new Error(`Stray control byte at ${i}: ${b}`)
  }
  return check
}

const texts = (lines: readonly Line[]) =>
  lines.filter((l): l is Extract<Line, { text: string }> => 'text' in l)

describe('properties: no line exceeds the width', () => {
  it.each(WIDTHS)('the %i mm ticket, with any text and code page', (mm) => {
    const columns = COLUMNS[mm]
    fc.assert(
      fc.property(ticket, page, (c, p) => {
        const format = { columns, page: p }
        for (const l of texts(ticketLines(c, format))) {
          const fits = l.large ? Math.floor(columns / 2) : columns
          expect(encode(l.text, p).length).toBeLessThanOrEqual(fits)
          expect(l.text.length).toBeLessThanOrEqual(fits)
        }
      }),
      { seed: 1401, numRuns: 400 },
    )
  })

  it.each(WIDTHS)('what is read from the %i mm paper also fits (reading the bytes)', (mm) => {
    const columns = COLUMNS[mm]
    fc.assert(
      fc.property(ticket, page, (c, p) => {
        const format = { columns, page: p }
        const lines = ticketLines(c, format)
        const readResult = readEscpos(escpos(lines, format))
        const printedOnes = readResult.text.split('\n').slice(0, lines.length)
        printedOnes.forEach((printed, i) => {
          const source = lines[i] as Line
          const fits = 'text' in source && source.large ? Math.floor(columns / 2) : columns
          expect(printed.length).toBeLessThanOrEqual(fits)
        })
      }),
      { seed: 1402, numRuns: 200 },
    )
  })

  it('the separator fills exactly the line and so does the test page ruler', () => {
    for (const mm of WIDTHS) {
      const columns = COLUMNS[mm]
      for (const p of CODE_PAGES) {
        const mockPrinter = testLines(
          { printer: 'Barra', stations: ['Barra', 'Cocina'], time: '9:00 p. m.' },
          { columns, page: p },
        )
        const rule = texts(mockPrinter).find((l) => /^1234567890/.test(l.text))
        expect(rule?.text).toHaveLength(columns)
        const readResult = readEscpos(escpos(mockPrinter, { columns, page: p })).text.split('\n')
        expect(readResult.filter((l) => l === '-'.repeat(columns)).length).toBe(
          mockPrinter.filter((l) => 'separator' in l).length,
        )
        for (const l of texts(mockPrinter))
          expect(l.text.length).toBeLessThanOrEqual(l.large ? columns / 2 : columns)
      }
    }
  })

  it('the test page fits with arbitrary printer and station names', () => {
    fc.assert(
      fc.property(text, fc.array(text, { maxLength: 6 }), width, page, (name, est, mm, p) => {
        const format = { columns: COLUMNS[mm], page: p }
        for (const l of texts(testLines({ printer: name, stations: est, time: name }, format)))
          expect(l.text.length).toBeLessThanOrEqual(
            l.large ? Math.floor(format.columns / 2) : format.columns,
          )
      }),
      { seed: 1403, numRuns: 150 },
    )
  })

  it('wrapText: every chunk fits and no letter is lost', () => {
    fc.assert(
      fc.property(text, fc.integer({ min: 4, max: 48 }), page, (t, a, p) => {
        const format = { columns: 48, page: p }
        const chunks = wrapText(t, a, format)
        for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(a)
        const original = characters(t, p).join('').replaceAll(' ', '')
        expect(chunks.join('').replaceAll(' ', '')).toBe(original)
        // No line starts or ends with a space, and there are no double spaces.
        for (const chunk of chunks) {
          expect(chunk).toBe(chunk.trim())
          expect(chunk).not.toMatch(/ {2}/)
        }
      }),
      { seed: 1404, numRuns: 500 },
    )
  })

  it('toSides: fits, keeps the right side and puts it against the edge if there is room', () => {
    fc.assert(
      fc.property(
        text,
        fc.constantFrom('', '#1', '#12', 'P3', '#99999'),
        width,
        fc.boolean(),
        page,
        (leftPart, right, mm, large, p) => {
          const format = { columns: COLUMNS[mm], page: p }
          const lines = texts(toSides(leftPart, right, format, { large }))
          const fits = widthOf(format, { large })
          for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(fits)
          if (right) expect(lines.map((l) => l.text).join('\n')).toContain(right)
          // When they share a line, the right side ends exactly at the edge.
          const shared = lines.find((l) => l.text.endsWith(right) && l.text.length > right.length)
          if (right && shared && wrapText(leftPart, fits, format).length === lines.length)
            expect(shared.text).toHaveLength(fits)
        },
      ),
      { seed: 1405, numRuns: 300 },
    )
  })
})

describe('properties: a text never gives commands to the printer', () => {
  it('clear leaves no control, format or direction character', () => {
    fc.assert(
      fc.property(text, (t) => {
        for (const c of clear(t)) {
          const n = c.codePointAt(0) as number
          expect(n).toBeGreaterThanOrEqual(0x20)
          expect(n < 0x7f || n > 0x9f).toBe(true)
          expect(n >= 0x200b && n <= 0x200f).toBe(false)
          expect(n >= 0x2028 && n <= 0x202e).toBe(false)
          expect(n >= 0x2060 && n <= 0x206f).toBe(false)
          expect(n).not.toBe(0xfeff)
        }
      }),
      { seed: 1406, numRuns: 400 },
    )
  })

  it('encode: every byte of a text is printable (never < 0x20 or 0x7f) and fits in a byte', () => {
    fc.assert(
      fc.property(text, page, (t, p) => {
        for (const b of encode(t, p)) {
          expect(Number.isInteger(b)).toBe(true)
          expect(b).toBeGreaterThanOrEqual(0x20)
          expect(b).toBeLessThanOrEqual(0xff)
          expect(b).not.toBe(0x7f)
        }
      }),
      { seed: 1407, numRuns: 500 },
    )
  })

  it.each(WIDTHS)('the full %i mm ticket carries only its own commands', (mm) => {
    fc.assert(
      fc.property(ticket, page, (c, p) => {
        const format = { columns: COLUMNS[mm], page: p }
        const bytes = escpos(ticketLines(c, format), format)
        // Throws if there is a command `escpos.ts` does not emit or a stray control byte.
        const check = parse(bytes)
        expect(check.begin).toBe(1)
        expect(check.cuts).toBe(1)
        expect(check.feed).toBe(1)
        expect(check.tableName).toBe(p === 'no_accents' ? 0 : 1)
        expect([...bytes.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00])
        expect(readEscpos(bytes).cuts).toBe(1)
      }),
      { seed: 1408, numRuns: 400 },
    )
  })

  it('drawer and cut commands written in a name print as harmless text', () => {
    const base: Ticket = {
      type: 'newOne',
      station: '\x1dV\x00Cocina',
      number: 1,
      target: '\x1bp\x00\x19\x19Mesa 1',
      order: 1,
      waiter: '\x10\x04\x01Ana',
      time: '8:00',
      guests: 2,
      items: [
        {
          quantity: 1,
          name: '\x1b@\x1dV\x42\x00Pizza',
          guest: null,
          course: null,
          options: ['\x1bp\x01'],
          notes: '\x1b!\xff',
        },
      ],
    }
    const format = { columns: 48, page: 'pc850' as const }
    const bytes = escpos(ticketLines(base, format), format)
    const check = parse(bytes)
    expect(check.cuts).toBe(1)
    expect(check.begin).toBe(1)
    expect(readEscpos(bytes).text).toContain('Pizza')
  })
})

describe('properties: reading what was printed returns the text', () => {
  it('each line read is the line text, already converted to the printer code page', () => {
    fc.assert(
      fc.property(ticket, width, page, (c, mm, p) => {
        const format = { columns: COLUMNS[mm], page: p }
        const lines = ticketLines(c, format)
        const readResult = readEscpos(escpos(lines, format))
        const rows = readResult.text.split('\n')
        // One row per line, 4 from the feed and the cut mark.
        expect(rows).toHaveLength(lines.length + 4 + 1)
        lines.forEach((l, i) => {
          if ('separator' in l) expect(rows[i]).toBe('-'.repeat(format.columns))
          else if ('space' in l) expect(rows[i]).toBe('')
          else expect(rows[i]).toBe(characters(l.text, p).join(''))
        })
        expect(rows.slice(lines.length, lines.length + 4)).toEqual(['', '', '', ''])
        expect(readResult.cuts).toBe(1)
      }),
      { seed: 1409, numRuns: 300 },
    )
  })

  it('a name with accents reads back as the restaurant wrote it, in pc850 and wpc1252', () => {
    const word = fc.constantFrom(
      'Café',
      'Ñoquis',
      'Burrata',
      'Piña',
      'jalapeño',
      'Añejo',
      'Crème',
      'Sin',
      'cebolla',
      'Térmi',
      'ñandú',
      'Último',
    )
    fc.assert(
      fc.property(
        fc.array(word, { minLength: 1, maxLength: 5 }).map((a) => a.join(' ')),
        fc.constantFrom('pc850', 'wpc1252') as fc.Arbitrary<CodePage>,
        width,
        fc.integer({ min: 1, max: 99 }),
        (name, p, mm, quantity) => {
          const format = { columns: COLUMNS[mm], page: p }
          const c: Ticket = {
            type: 'newOne',
            station: 'Cocina',
            number: 7,
            target: 'Mesa 6',
            order: 3,
            waiter: 'Ana',
            time: '8:42 p. m.',
            guests: 2,
            items: [
              {
                quantity,
                name,
                guest: 1,
                course: null,
                options: [name],
                notes: `Ñandú ${name}`,
              },
            ],
          }
          const flattened = readEscpos(escpos(ticketLines(c, format), format))
            .text.replaceAll('\n', ' ')
            .replace(/ +/g, ' ')
          expect(flattened).toContain(`${quantity} x ${name}`)
          expect(flattened).toContain(`> ${name}`)
          expect(flattened).toContain(`NOTA: Ñandú ${name}`)
          expect(flattened).toContain('Mesa 6')
          expect(flattened).toContain('#7')
        },
      ),
      { seed: 1410, numRuns: 150 },
    )
  })

  it('printing the same thing twice gives the same bytes (no clock or randomness)', () => {
    fc.assert(
      fc.property(ticket, width, page, (c, mm, p) => {
        const format = { columns: COLUMNS[mm], page: p }
        expect([...escpos(ticketLines(c, format), format)]).toEqual([
          ...escpos(ticketLines(JSON.parse(JSON.stringify(c)) as Ticket, format), format),
        ])
      }),
      { seed: 1411, numRuns: 100 },
    )
  })
})

// ── Concrete cases for each ticket type ────────────────────────────────

const f80 = { columns: COLUMNS[80], page: 'pc850' as const }
const f58 = { columns: COLUMNS[58], page: 'pc850' as const }

const tagliata: TicketItem = {
  quantity: 2,
  name: 'Tagliata',
  guest: 2,
  course: 'main',
  options: ['Término medio'],
  notes: null,
}
const newOne: Ticket = {
  type: 'newOne',
  station: 'Cocina',
  number: 12,
  target: 'Mesa 6',
  order: 3,
  waiter: 'Ana',
  time: '8:42 p. m.',
  guests: 4,
  items: [tagliata],
}
const read = (c: Ticket, f = f80) => asText(ticketLines(c, f), f.columns)

describe('void, modification and reprint', () => {
  it('a void puts ANULAR at the top, the original number and quantities with a minus sign', () => {
    const text = read({ ...newOne, type: 'voidEntry' })
    const rows = text.split('\n')
    expect(rows[0]).toContain('[ANULAR · COCINA]')
    expect(text).toMatch(/MESA 6 +#12/)
    expect(text).toContain('-2 X TAGLIATA')
    // A new ticket, by contrast, has no sign or extra title.
    expect(read(newOne)).not.toContain('-2 X')
    expect(read(newOne).split('\n')[0]).toBe(read(newOne).split('\n')[0]?.trimEnd())
    expect(read(newOne)).not.toContain('ANULAR')
  })

  it('a void does not put the sign on options or notes, only on the quantity', () => {
    const text = read({
      ...newOne,
      type: 'voidEntry',
      items: [{ ...tagliata, notes: 'sin sal', options: ['Sin rúgula'] }],
    })
    expect(text).toContain('> Sin rúgula')
    expect(text).toContain('[NOTA: sin sal]')
    expect(text.match(/-\d/g)).toHaveLength(1)
  })

  it('a modification says CAMBIO with the station and has the product with its new options', () => {
    const text = read({
      ...newOne,
      type: 'modification',
      station: 'Barra',
      items: [{ ...tagliata, options: ['Sin hielo'], notes: 'doble' }],
    })
    expect(text.split('\n')[0]).toContain('[CAMBIO · BARRA]')
    expect(text).toContain('> Sin hielo')
    expect(text).toContain('[NOTA: doble]')
    expect(text).toMatch(/MESA 6 +#12/)
  })

  it('a reprint says REIMPRESIÓN and keeps the original ticket number', () => {
    const text = read({ ...newOne, type: 'reprinting', number: 5 })
    expect(text.split('\n')[0]).toContain('[REIMPRESIÓN · COCINA]')
    expect(text).toMatch(/MESA 6 +#5/)
  })

  it('the four types are distinguished in the header, at any width', () => {
    const titles = [58, 80].flatMap((mm) =>
      TYPES.map((type) =>
        read({ ...newOne, type }, { columns: COLUMNS[mm as 58 | 80], page: 'pc850' })
          .split('\n')
          .slice(0, 3)
          .join(' '),
      ),
    )
    expect(titles[0]).not.toMatch(/ANULAR|CAMBIO|REIMPRESI/)
    expect(titles[1]).toContain('REIMPRESI')
    expect(titles[2]).toContain('CAMBIO')
    expect(titles[3]).toContain('ANULAR')
    expect(new Set(titles.slice(0, 4)).size).toBe(4)
  })

  it('without a ticket number no # is made up', () => {
    expect(read({ ...newOne, number: null })).not.toContain('#')
    expect(read({ ...newOne, number: null })).toContain('MESA 6')
  })

  it('without order, guests or waiter the data line leaves no stray separators', () => {
    const text = read({ ...newOne, order: null, guests: null, waiter: '', time: '9:10 a. m.' })
    expect(text).toContain('9:10 a. m.')
    expect(text).not.toContain('Pedido')
    expect(text).not.toContain('pers.')
    expect(text).not.toMatch(/^ ?·|· ?$/m)
  })

  it('a ticket without products does not fail and has only the header', () => {
    const lines = ticketLines({ ...newOne, items: [] }, f80)
    expect(() => escpos(lines, f80)).not.toThrow()
    expect(asText(lines, 48)).not.toContain('X')
  })

  it('a long target wraps to the next line and the number is not lost (58 mm)', () => {
    const text = read({ ...newOne, target: 'Mesa 6 terraza del segundo piso' }, f58)
    expect(text).toContain('#12')
    for (const row of text.split('\n')) expect(row.length).toBeLessThanOrEqual(32)
  })
})

describe('courses', () => {
  const item = (name: string, course: TicketCourse | null): TicketItem => ({
    ...tagliata,
    name,
    course,
    quantity: 1,
  })

  it('groups by course in the order entry, main, dessert, regardless of input order', () => {
    const text = read({
      ...newOne,
      items: [item('Tiramisú', 'dessert'), item('Tagliata', 'main'), item('Burrata', 'entry')],
    })
    const pos = (s: string) => text.indexOf(s)
    expect(pos('ENTRADA')).toBeGreaterThan(-1)
    expect(pos('ENTRADA')).toBeLessThan(pos('1 X BURRATA'))
    expect(pos('1 X BURRATA')).toBeLessThan(pos('FUERTE'))
    expect(pos('FUERTE')).toBeLessThan(pos('1 X TAGLIATA'))
    expect(pos('1 X TAGLIATA')).toBeLessThan(pos('POSTRE'))
    expect(pos('POSTRE')).toBeLessThan(pos('1 X TIRAMISÚ'))
  })

  it('items without a course print first and without a course header', () => {
    const text = read({ ...newOne, items: [item('Limonada', null), item('Tagliata', 'main')] })
    expect(text.indexOf('1 X LIMONADA')).toBeLessThan(text.indexOf('FUERTE'))
    expect(text).not.toContain('ENTRADA')
    expect(text).not.toContain('POSTRE')
  })

  it('if no product has a course no course header prints', () => {
    const text = read({ ...newOne, items: [item('Limonada', null), item('Cerveza', null)] })
    expect(text).not.toMatch(/ENTRADA|FUERTE|POSTRE/)
  })

  it('a course without products is not printed', () => {
    const text = read({ ...newOne, items: [item('Burrata', 'entry')] })
    expect(text).toContain('ENTRADA')
    expect(text).not.toContain('FUERTE')
    expect(text).not.toContain('POSTRE')
  })

  it('notes the held courses in the given order and only on the ticket that carries them', () => {
    const text = read({ ...newOne, heldCourses: ['main', 'dessert'] })
    expect(text.replaceAll('\n', ' ')).toContain(
      'En espera: Fuerte, Postre. Sale cuando el mesero lo marche.',
    )
    expect(read({ ...newOne, heldCourses: [] })).not.toContain('En espera')
    expect(read({ ...newOne })).not.toContain('En espera')
  })

  it('the held courses notice fits at 58 mm', () => {
    const text = read({ ...newOne, heldCourses: ['entry', 'main', 'dessert'] }, f58)
    for (const row of text.split('\n')) expect(row.length).toBeLessThanOrEqual(32)
    expect(text.replaceAll('\n', ' ')).toContain('En espera: Entrada, Fuerte, Postre.')
  })

  it('the notice goes at the end, after the last separator', () => {
    const lines = ticketLines({ ...newOne, heldCourses: ['dessert'] }, f80)
    const latest = lines.at(-1)
    expect(latest && 'text' in latest && latest.text).toMatch(/marche\.$/)
    expect(lines.findLastIndex((l) => 'separator' in l)).toBeLessThan(lines.length - 1)
  })
})

describe('style of what the kitchen cannot miss', () => {
  it('the header is large, reversed and centered; notes, reversed; options, bold', () => {
    const lines = ticketLines(
      { ...newOne, items: [{ ...tagliata, notes: 'alergia al maní' }] },
      f80,
    )
    const t = texts(lines)
    expect(t[0]).toMatchObject({ large: true, reversed: true, center: true, text: 'COCINA' })
    expect(t.find((l) => l.text.startsWith('NOTA:'))).toMatchObject({ reversed: true })
    expect(t.find((l) => l.text.startsWith('> '))).toMatchObject({ bold: true })
    expect(t.find((l) => l.text.includes('x Tagliata'))).toMatchObject({ large: true })
  })

  it('a long note wraps and every chunk stays reversed', () => {
    const lines = texts(
      ticketLines(
        { ...newOne, items: [{ ...tagliata, notes: 'palabra '.repeat(20).trim() }] },
        f58,
      ),
    ).filter((l) => l.reversed && !l.large)
    expect(lines.length).toBeGreaterThan(1)
  })
})

describe('paragraph', () => {
  it('an empty text gives an empty line (the row does not disappear)', () => {
    expect(paragraph('', f80)).toEqual([{ text: '' }])
  })
})
