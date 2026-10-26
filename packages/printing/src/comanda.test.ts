import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  COLUMNAS,
  type Comanda,
  codificar,
  comoTexto,
  escpos,
  type Linea,
  lineasComanda,
  lineasPrueba,
  PAGINAS_CODIGOS,
  partir,
} from './index'

const ticket: Comanda = {
  type: 'newOne',
  station: 'Cocina',
  numero: 12,
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
      course: 'entry',
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

const firstOne = ticket.items[0] as Comanda['items'][number]
const formato80 = { columnas: COLUMNAS[80], pagina: 'pc850' as const }

describe('comanda', () => {
  it('lleva estación, destino con número, datos del pedido y los productos por curso', () => {
    const text = comoTexto(lineasComanda(ticket, formato80), 48)
    expect(text).toContain('[COCINA]')
    expect(text).toMatch(/MESA 6 +#12/)
    expect(text).toContain('Pedido 3 · Ana · 8:42 p. m. · 4 pers.')
    expect(text.indexOf('ENTRADA')).toBeLessThan(text.indexOf('FUERTE'))
    expect(text).toContain('2 X BURRATA SPRITZ')
    expect(text).toContain('> Término medio')
    expect(text).toContain('[NOTA: bien caliente]')
  })

  it('la anulación y la reimpresión se distinguen arriba', () => {
    expect(comoTexto(lineasComanda({ ...ticket, type: 'voidEntry' }, formato80), 48)).toContain(
      '[ANULAR · COCINA]',
    )
    expect(comoTexto(lineasComanda({ ...ticket, type: 'reprinting' }, formato80), 48)).toContain(
      'REIMPRESIÓN',
    )
  })

  it('la nota del pedido sale arriba, resaltada', () => {
    const text = comoTexto(
      lineasComanda({ ...ticket, notaPedido: 'alérgico al maní' }, formato80),
      48,
    )
    expect(text).toContain('[NOTA DEL PEDIDO: alérgico al maní]')
    expect(text.indexOf('NOTA DEL PEDIDO')).toBeLessThan(text.indexOf('ENTRADA'))
  })

  it('avisa los cursos que siguen en espera', () => {
    const text = comoTexto(lineasComanda({ ...ticket, retenidos: ['dessert'] }, formato80), 48)
    expect(text).toContain('En espera: Postre')
  })

  it('ninguna línea pasa del ancho, para cualquier texto y ancho', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 120 }),
        fc.string({ maxLength: 60 }),
        fc.constantFrom(32, 48),
        fc.constantFrom(...PAGINAS_CODIGOS),
        (name, notes, columnas, pagina) => {
          const lines = lineasComanda(
            {
              ...ticket,
              target: name,
              items: [{ ...firstOne, name, notes, options: [notes] }],
            },
            { columnas, pagina },
          )
          for (const l of lines) {
            if (!('text' in l)) continue
            const width = l.large ? columnas / 2 : columnas
            expect(codificar(l.text, pagina).length).toBeLessThanOrEqual(width)
          }
        },
      ),
      { seed: 14, numRuns: 300 },
    )
  })
})

describe('caracteres', () => {
  it('pc850 imprime tildes y eñes con su byte', () => {
    expect(codificar('ñÑáéíóú¿¡', 'pc850')).toEqual([
      0xa4, 0xa5, 0xa0, 0x82, 0xa1, 0xa2, 0xa3, 0xa8, 0xad,
    ])
  })

  it('wpc1252 usa el byte latino', () => {
    expect(codificar('ñé', 'wpc1252')).toEqual([0xf1, 0xe9])
  })

  it('sin tildes quita la tilde y los signos de apertura', () => {
    expect(String.fromCharCode(...codificar('¿Señor Café?', 'no_accents'))).toBe('Senor Cafe?')
  })

  it('un nombre nunca le da órdenes a la impresora (sin bytes de control)', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 80 }),
        fc.constantFrom(...PAGINAS_CODIGOS),
        (t, p) => {
          for (const b of codificar(t, p)) {
            expect(b).toBeGreaterThanOrEqual(0x20)
            expect(b).not.toBe(0x7f)
            expect(b).toBeLessThanOrEqual(0xff)
          }
        },
      ),
      { seed: 7, numRuns: 500 },
    )
  })

  it('pc850 imprime las comillas latinas', () => {
    expect(codificar('«sin hielo»', 'pc850').slice(0, 1)).toEqual([0xae])
    expect(codificar('«sin hielo»', 'pc850').at(-1)).toBe(0xaf)
  })

  it('emoji y lo desconocido salen como «?»', () => {
    expect(String.fromCharCode(...codificar('Pizza 🍕', 'pc850'))).toBe('Pizza ?')
  })
})

describe('partir', () => {
  it('parte por palabras y corta una palabra larga', () => {
    expect(partir('una dos tres', 7, formato80)).toEqual(['una dos', 'tres'])
    expect(partir('abcdefghij', 4, formato80)).toEqual(['abcd', 'efgh', 'ij'])
  })
})

describe('escpos', () => {
  const lines: Linea[] = lineasComanda(ticket, formato80)

  it('empieza iniciando, elige la tabla y termina con avance y corte', () => {
    const b = [...escpos(lines, formato80)]
    expect(b.slice(0, 5)).toEqual([0x1b, 0x40, 0x1b, 0x74, 2])
    expect(b.slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x00])
  })

  it('sin tildes no cambia la tabla de fábrica', () => {
    const b = [...escpos(lines, { ...formato80, pagina: 'no_accents' })]
    expect(b.slice(0, 3)).toEqual([0x1b, 0x40, 0x1b])
    expect(b[3]).not.toBe(0x74)
  })

  it('la página de prueba trae una regla del ancho exacto', () => {
    const mockPrinter = lineasPrueba(
      { printer: 'Barra', stations: ['Barra'], time: '9:00 p. m.' },
      { columnas: 32, pagina: 'pc850' },
    )
    expect(
      mockPrinter.some((l) => 'text' in l && l.text === '12345678901234567890123456789012'),
    ).toBe(true)
  })
})

describe('lector', () => {
  it('lo que se imprime se lee igual, con tildes y un corte', async () => {
    const { leerEscpos } = await import('./lector')
    const leido = leerEscpos(escpos(lineasComanda(ticket, formato80), formato80))
    expect(leido.cortes).toBe(1)
    expect(leido.text).toContain('Término medio')
    expect(leido.text).toContain('Mesa 6')
  })
})
