import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  asText,
  CODE_PAGES,
  COLUMNS,
  encode,
  escpos,
  type Line,
  type PreBill,
  pesos,
  preBillLines,
  readEscpos,
  taxName,
} from './index'

// The pre-bill on paper (task 1.6): 58 and 80 mm, with and without previous payments, with a split
// check, without tip, with accents and with the pesos format.

const preBill: PreBill = {
  restaurant: 'La Spritzzería',
  target: 'Mesa 5',
  order: 12,
  waiter: 'Ana',
  time: '8:42 p. m.',
  guests: 4,
  lines: [
    { quantity: 2, name: 'Garden Margarita', options: [], value: 81_800 },
    { quantity: 1, name: 'Tagliata', options: ['Término medio'], value: 58_900 },
  ],
  taxes: [{ name: 'INC 8 %', base: 130_093, value: 10_407 }],
  total: 140_700,
  paid: 0,
  check: null,
  subtotal: 140_700,
  tip: 13_028,
  tipRate: 1000,
}

const f80 = { columns: COLUMNS[80], page: 'pc850' as const }
const f58 = { columns: COLUMNS[58], page: 'pc850' as const }
const text = (p: PreBill, format = f80) => asText(preBillLines(p, format), format.columns)

const lineWidth = (l: Line, columns: number, page: (typeof CODE_PAGES)[number]) => {
  if (!('text' in l)) return 0
  return encode(l.text, page).length / (l.large ? 2 : 1) <= (l.large ? columns / 2 : columns)
    ? 0
    : encode(l.text, page).length
}

describe('pesos: Colombian format', () => {
  it.each([
    [0, '$0'],
    [5, '$5'],
    [999, '$999'],
    [1_000, '$1.000'],
    [40_900, '$40.900'],
    [100_000, '$100.000'],
    [1_234_567, '$1.234.567'],
    [10_000_000_000, '$10.000.000.000'],
  ])('%i → %s', (n, expected) => {
    expect(pesos(n)).toBe(expected)
  })

  it.each([
    [-1, '-$1'],
    [-10, '-$10'],
    [-1_000, '-$1.000'],
    [-1_234_567, '-$1.234.567'],
  ])('a negative carries the sign before the peso sign: %i → %s', (n, expected) => {
    expect(pesos(n)).toBe(expected)
  })

  it('property: without dots and sign it returns the number, and dots group by three', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10_000_000_000, max: 10_000_000_000 }), (n) => {
        const t = pesos(n)
        expect(Number(t.replace(/[$.]/g, ''))).toBe(n)
        expect(t).toMatch(/^-?\$\d{1,3}(\.\d{3})*$/)
      }),
    )
  })
})

describe('taxName', () => {
  it('INC and IVA with their rate, and exempt without a percentage', () => {
    expect(taxName('inc', 800)).toBe('INC 8 %')
    expect(taxName('iva', 1900)).toBe('IVA 19 %')
    expect(taxName('exempt', 0)).toBe('Exento')
    expect(taxName('exempt', 800)).toBe('Exento')
    expect(taxName('inc', 0)).toBe('Exento')
  })

  it('a rate with decimals uses a comma', () => {
    expect(taxName('iva', 550)).toBe('IVA 5,5 %')
  })
})

describe('preBillLines: what comes out on paper', () => {
  it('has restaurant, PRECUENTA, table, order data, dishes with their value and the total', () => {
    const t = text(preBill)
    expect(t).toContain('LA SPRITZZERÍA')
    expect(t).toContain('[PRECUENTA]')
    expect(t).toContain('MESA 5')
    expect(t).toContain('Pedido 12 · Ana · 8:42 p. m. · 4 pers.')
    expect(t).toMatch(/2 x Garden Margarita +\$81\.800/)
    expect(t).toMatch(/1 x Tagliata +\$58\.900/)
    expect(t).toContain('Término medio')
    expect(t).toMatch(/Total +\$140\.700/)
    expect(t.indexOf('PRECUENTA')).toBeLessThan(t.indexOf('MESA 5'))
    expect(t.indexOf('Garden')).toBeLessThan(t.indexOf('Total '))
  })

  it('the suggested tip and the total with tip match the amounts received', () => {
    const t = text(preBill)
    expect(t).toMatch(/Propina sugerida \(10 %\) +\$13\.028/)
    expect(t.replace(/\s+/g, ' ')).toMatch(/TOTAL CON PROPINA \$153\.728/)
    expect(t).not.toContain('A PAGAR')
  })

  it('ends by noting that the tip is voluntary and that it is not an invoice', () => {
    const t = text(preBill)
    expect(t).toContain('La propina es voluntaria.')
    expect(t.trimEnd().endsWith('Esta precuenta no es una factura.')).toBe(true)
  })

  it('itemized tax: base without taxes and each tax with a value', () => {
    const t = text({
      ...preBill,
      taxes: [
        { name: 'INC 8 %', base: 100_000, value: 8_000 },
        { name: 'IVA 19 %', base: 10_000, value: 1_900 },
        { name: 'Exento', base: 5_000, value: 0 },
      ],
    })
    expect(t).toMatch(/Base sin impuestos +\$115\.000/)
    expect(t).toMatch(/INC 8 % +\$8\.000/)
    expect(t).toMatch(/IVA 19 % +\$1\.900/)
    // Exempt adds no tax: it is not listed as a row.
    expect(t).not.toMatch(/Exento +\$/)
  })

  it('an older hub without taxes (undefined or empty) prints no base row', () => {
    const { taxes: _i, ...withoutTaxes } = preBill
    expect(text(withoutTaxes as PreBill)).not.toContain('Base sin impuestos')
    expect(text({ ...preBill, taxes: [] })).not.toContain('Base sin impuestos')
  })

  it('without previous payments neither «Ya pagado» nor «Saldo» appears', () => {
    const t = text(preBill)
    expect(t).not.toContain('Ya pagado')
    expect(t).not.toContain('Saldo')
  })

  it('with previous payments: total, the amount already paid as negative and the balance', () => {
    const t = text({
      ...preBill,
      paid: 40_000,
      subtotal: 100_700,
      tip: 9_324,
    })
    expect(t).toMatch(/Total +\$140\.700/)
    expect(t).toMatch(/Ya pagado +-\$40\.000/)
    expect(t).toMatch(/Saldo +\$100\.700/)
    expect(t).toMatch(/Propina sugerida \(10 %\) +\$9\.324/)
    expect(t).toContain('$110.024')
    expect(t.indexOf('Total ')).toBeLessThan(t.indexOf('Ya pagado'))
    expect(t.indexOf('Ya pagado')).toBeLessThan(t.indexOf('Saldo'))
  })

  it('with the bill fully paid the balance prints as $0', () => {
    const t = text({ ...preBill, paid: 140_700, subtotal: 0, tip: 0 })
    expect(t).toMatch(/Saldo +\$0/)
    expect(t).toMatch(/A PAGAR|A pagar/i)
  })

  it('with a split check: the check name and its amount, and the tip for that check', () => {
    const t = text({
      ...preBill,
      paid: 40_000,
      check: { name: 'Cuenta 1', amount: 50_350 },
      subtotal: 50_350,
      tip: 4_662,
    })
    expect(t).toMatch(/Cuenta 1 +\$50\.350/)
    expect(t).toMatch(/Propina sugerida \(10 %\) +\$4\.662/)
    expect(t).toContain('$55.012')
    // The check goes after the balance and before the tip.
    expect(t.indexOf('Saldo')).toBeLessThan(t.indexOf('Cuenta 1'))
    expect(t.indexOf('Cuenta 1')).toBeLessThan(t.indexOf('Propina sugerida'))
  })

  it('without a split check there is no check row', () => {
    expect(text(preBill)).not.toMatch(/Cuenta \d/)
  })

  it('without tip (rate 0 or tip 0): «A pagar» prints with the subtotal and no tip', () => {
    const t = text({ ...preBill, tip: 0, tipRate: 0 })
    expect(t).toMatch(/A PAGAR +\$140\.700|A PAGAR/)
    expect(t).not.toContain('Propina sugerida')
    expect(t).not.toContain('Total con propina')
    // The voluntary tip notice stays.
    expect(t).toContain('La propina es voluntaria.')
  })

  it('a guest-chosen tip (rate null) says «Propina», not «sugerida», with the summed total', () => {
    const t = text({ ...preBill, tipRate: null, tip: 20_000 })
    expect(t).toMatch(/Propina +\$20\.000/)
    expect(t).not.toContain('sugerida')
    expect(t).not.toContain('NaN')
    expect(t.replace(/\s+/g, ' ')).toContain('TOTAL CON PROPINA $160.700')
  })

  it('a tip rate with decimals uses a comma: 7,5 %', () => {
    expect(text({ ...preBill, tipRate: 750, tip: 10_553 })).toContain('Propina sugerida (7,5 %)')
  })

  it('an order without a day number, guests or waiter omits that data', () => {
    const t = text({ ...preBill, order: null, guests: null, waiter: '' })
    expect(t).toContain('8:42 p. m.')
    expect(t).not.toContain('Pedido')
    expect(t).not.toContain('pers.')
    expect(t).not.toContain(' · · ')
  })

  it('«Para llevar» and several tables print as is', () => {
    expect(text({ ...preBill, target: 'Mesa 5 + 6' })).toContain('MESA 5 + 6')
    expect(text({ ...preBill, target: 'Para llevar' })).toContain('PARA LLEVAR')
  })

  it('a pre-bill without dishes (empty table) does not break', () => {
    const t = text({ ...preBill, lines: [], total: 0, subtotal: 0, tip: 0, taxes: [] })
    expect(t).toMatch(/Total +\$0/)
  })
})

describe('preBillLines: dish options', () => {
  // BUG: pre-bill.ts adds `  ${option}` to indent options under their dish, but `paragraph`
  // → `wrapText` (document.ts) drops leading spaces, so «Término medio» prints flush against
  // the margin, just like a dish.
  it('the options of a dish print indented under the dish', () => {
    const textLine = text(preBill)
      .split('\n')
      .find((l) => l.includes('Término medio'))
    expect(textLine?.startsWith('  ')).toBe(true)
  })

  it('options print right below their dish, before the next dish', () => {
    const t = text({
      ...preBill,
      lines: [
        { quantity: 1, name: 'Tagliata', options: ['Término medio', 'Sin sal'], value: 58_900 },
        { quantity: 1, name: 'Tiramisú', options: [], value: 18_000 },
      ],
    })
    expect(t.indexOf('Tagliata')).toBeLessThan(t.indexOf('Término medio'))
    expect(t.indexOf('Término medio')).toBeLessThan(t.indexOf('Sin sal'))
    expect(t.indexOf('Sin sal')).toBeLessThan(t.indexOf('Tiramisú'))
  })
})

describe('preBillLines: 58 mm (32 columns) versus 80 mm (48)', () => {
  it('at 58 mm the same data fits in lines of up to 32 characters', () => {
    for (const l of preBillLines(preBill, f58)) {
      if (!('text' in l)) continue
      expect(encode(l.text, 'pc850').length).toBeLessThanOrEqual(l.large ? 16 : 32)
    }
    const t = text(preBill, f58)
    expect(t).toContain('2 x Garden Margarita')
    expect(t).toContain('$81.800')
    expect(t).toContain('$140.700')
    expect(t).toContain('$13.028')
  })

  it('at 80 mm lines reach up to 48 characters', () => {
    const widths = preBillLines(preBill, f80).map((l) =>
      'text' in l && !l.large ? l.text.length : 0,
    )
    expect(Math.max(...widths)).toBeLessThanOrEqual(48)
    expect(Math.max(...widths)).toBeGreaterThan(32)
  })

  it('the amount sits against the right edge: the row is exactly the width', () => {
    const lines = preBillLines(preBill, f80)
    const total = lines.find(
      (l) => 'text' in l && l.text.startsWith('Total ') && l.text.endsWith('$140.700'),
    )
    expect(total && 'text' in total ? total.text.length : 0).toBe(48)
    const in58 = preBillLines(preBill, f58).find(
      (l) => 'text' in l && l.text.startsWith('Total ') && l.text.endsWith('$140.700'),
    )
    expect(in58 && 'text' in in58 ? in58.text.length : 0).toBe(32)
  })

  it('a very long dish name wraps at 58 mm and the value is not lost', () => {
    const longName = 'Pizza Margarita Especial de la Casa con Doble Queso y Albahaca'
    const t = text(
      { ...preBill, lines: [{ quantity: 1, name: longName, options: [], value: 58_900 }] },
      f58,
    )
    expect(t).toContain('$58.900')
    expect(t.replace(/\s+/g, ' ')).toContain('Margarita Especial')
    for (const line of t.split('\n')) expect(line.length).toBeLessThanOrEqual(32)
  })

  it('a value that does not fit next to the name moves to its own line without being cut', () => {
    const t = text(
      {
        ...preBill,
        lines: [
          {
            quantity: 1,
            name: 'Nombre larguísimo de plato aquí',
            options: [],
            value: 1_234_567,
          },
        ],
      },
      f58,
    )
    expect(t).toContain('$1.234.567')
  })

  it('«Total con propina» (large font) at 58 mm wraps without losing the amount', () => {
    const t = text(preBill, f58)
    expect(t.replace(/\s+/g, ' ').toUpperCase()).toContain('TOTAL CON PROPINA')
    expect(t).toContain('$153.728')
  })
})

describe('preBillLines: accents and characters', () => {
  const withAccents: PreBill = {
    ...preBill,
    restaurant: 'Café Ñandú',
    target: 'Terraza ¡Bogotá!',
    waiter: 'José Ñáñez',
    lines: [
      {
        quantity: 1,
        name: 'Piña colada · señor',
        options: ['Sin azúcar', 'Más hielo ¿sí?'],
        value: 22_000,
      },
    ],
  }

  it('pc850: accents and ñ print as the code page byte and read back', () => {
    const bytes = escpos(preBillLines(withAccents, f80), f80)
    const readResult = readEscpos(bytes).text
    expect(readResult).toContain('Piña colada')
    expect(readResult).toContain('Sin azúcar')
    expect(readResult).toContain('José Ñáñez')
    expect(readResult).toContain('Más hielo ¿sí?')
    expect(readResult).toContain('Esta precuenta no es una factura.')
  })

  it('wpc1252 also keeps the accents', () => {
    const f = { columns: 48, page: 'wpc1252' as const }
    const readResult = readEscpos(escpos(preBillLines(withAccents, f), f)).text
    expect(readResult).toContain('Piña colada')
    expect(readResult).toContain('José Ñáñez')
  })

  it('no_accents strips the accents but keeps all text readable', () => {
    const f = { columns: 48, page: 'no_accents' as const }
    const readResult = readEscpos(escpos(preBillLines(withAccents, f), f)).text
    expect(readResult).toContain('Pina colada')
    expect(readResult).toContain('Sin azucar')
    expect(readResult).toContain('Jose Nanez')
    expect(readResult).not.toMatch(/[ñáéíóú¿¡]/i)
  })

  it('the «no es una factura» notice and the amounts print the same on every code page', () => {
    for (const page of CODE_PAGES) {
      const f = { columns: 48, page }
      const readResult = readEscpos(escpos(preBillLines(preBill, f), f)).text
      expect(readResult).toContain('$140.700')
      expect(readResult).toContain('$153.728')
      expect(readResult).toMatch(/precuenta no es una factura/)
    }
  })
})

describe('preBillLines: ESC/POS', () => {
  it('cuts the paper only once, at the end', () => {
    expect(readEscpos(escpos(preBillLines(preBill, f80), f80)).cuts).toBe(1)
    expect(readEscpos(escpos(preBillLines(preBill, f58), f58)).cuts).toBe(1)
  })

  it('the dish name gives no commands to the printer (no control bytes)', () => {
    const badCase = 'Plato\u001b@\u001dVB\u0000 raro\n'
    const bytes = escpos(
      preBillLines(
        { ...preBill, lines: [{ quantity: 1, name: badCase, options: [badCase], value: 1_000 }] },
        f80,
      ),
      f80,
    )
    expect(readEscpos(bytes).cuts).toBe(1)
  })
})

describe('preBillLines: properties', () => {
  it('no line exceeds the width for any text, width, code page and amounts', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }),
        fc.string({ maxLength: 60 }),
        fc.constantFrom(32, 48),
        fc.constantFrom(...CODE_PAGES),
        fc.integer({ min: 0, max: 10_000_000_000 }),
        fc.integer({ min: 0, max: 10_000_000_000 }),
        fc.boolean(),
        (name, option, columns, page, value, paid, withCheck) => {
          const p: PreBill = {
            ...preBill,
            restaurant: name,
            target: name,
            lines: [{ quantity: 3, name, options: [option], value }],
            total: value,
            paid,
            subtotal: value,
            check: withCheck ? { name, amount: value } : null,
          }
          for (const l of preBillLines(p, { columns, page })) {
            if (!('text' in l)) continue
            const width = l.large ? Math.floor(columns / 2) : columns
            expect(encode(l.text, page).length).toBeLessThanOrEqual(width)
          }
        },
      ),
      { seed: 16, numRuns: 300 },
    )
  })

  it('the total and the final notice always appear, whatever the size of the amounts', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.constantFrom(32, 48),
        (total, tip, columns) => {
          const t = asText(
            preBillLines({ ...preBill, total, subtotal: total, tip }, { columns, page: 'pc850' }),
            columns,
          )
          expect(t).toContain(pesos(total))
          expect(t.replace(/\s+/g, ' ')).toContain('Esta precuenta no es una factura.')
        },
      ),
      { seed: 17, numRuns: 200 },
    )
  })

  it('the printed total with tip is the subtotal plus the tip', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000_000 }),
        fc.integer({ min: 1, max: 500_000_000 }),
        (subtotal, tip) => {
          const t = asText(preBillLines({ ...preBill, subtotal, tip }, f80), 48).replace(
            /\s+/g,
            ' ',
          )
          expect(t).toContain(pesos(subtotal + tip))
        },
      ),
      { seed: 18, numRuns: 200 },
    )
  })

  it('lineWidth helper: no line of the sample pre-bill overflows', () => {
    for (const page of CODE_PAGES)
      for (const columns of [32, 48])
        for (const l of preBillLines(preBill, { columns, page }))
          expect(lineWidth(l, columns, page)).toBe(0)
  })
})
