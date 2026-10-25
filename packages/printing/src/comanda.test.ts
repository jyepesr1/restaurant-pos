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

const comanda: Comanda = {
  tipo: 'nueva',
  estacion: 'Cocina',
  numero: 12,
  destino: 'Mesa 6',
  pedido: 3,
  mesero: 'Ana',
  hora: '8:42 p. m.',
  comensales: 4,
  items: [
    {
      cantidad: 2,
      nombre: 'Burrata Spritz',
      comensal: 1,
      curso: 'entrada',
      opciones: ['Sin rúgula'],
      notas: null,
    },
    {
      cantidad: 1,
      nombre: 'Tagliata',
      comensal: 2,
      curso: 'fuerte',
      opciones: ['Término medio'],
      notas: 'bien caliente',
    },
  ],
}

const primero = comanda.items[0] as Comanda['items'][number]
const formato80 = { columnas: COLUMNAS[80], pagina: 'pc850' as const }

describe('comanda', () => {
  it('lleva estación, destino con número, datos del pedido y los productos por curso', () => {
    const texto = comoTexto(lineasComanda(comanda, formato80), 48)
    expect(texto).toContain('[COCINA]')
    expect(texto).toMatch(/MESA 6 +#12/)
    expect(texto).toContain('Pedido 3 · Ana · 8:42 p. m. · 4 pers.')
    expect(texto.indexOf('ENTRADA')).toBeLessThan(texto.indexOf('FUERTE'))
    expect(texto).toContain('2 X BURRATA SPRITZ')
    expect(texto).toContain('> Término medio')
    expect(texto).toContain('[NOTA: bien caliente]')
  })

  it('la anulación y la reimpresión se distinguen arriba', () => {
    expect(comoTexto(lineasComanda({ ...comanda, tipo: 'anulacion' }, formato80), 48)).toContain(
      '[ANULAR · COCINA]',
    )
    expect(comoTexto(lineasComanda({ ...comanda, tipo: 'reimpresion' }, formato80), 48)).toContain(
      'REIMPRESIÓN',
    )
  })

  it('avisa los cursos que siguen en espera', () => {
    const texto = comoTexto(lineasComanda({ ...comanda, retenidos: ['postre'] }, formato80), 48)
    expect(texto).toContain('En espera: Postre')
  })

  it('ninguna línea pasa del ancho, para cualquier texto y ancho', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 120 }),
        fc.string({ maxLength: 60 }),
        fc.constantFrom(32, 48),
        fc.constantFrom(...PAGINAS_CODIGOS),
        (nombre, notas, columnas, pagina) => {
          const lineas = lineasComanda(
            {
              ...comanda,
              destino: nombre,
              items: [{ ...primero, nombre, notas, opciones: [notas] }],
            },
            { columnas, pagina },
          )
          for (const l of lineas) {
            if (!('texto' in l)) continue
            const ancho = l.grande ? columnas / 2 : columnas
            expect(codificar(l.texto, pagina).length).toBeLessThanOrEqual(ancho)
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
    expect(String.fromCharCode(...codificar('¿Señor Café?', 'sin_tildes'))).toBe('Senor Cafe?')
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
  const lineas: Linea[] = lineasComanda(comanda, formato80)

  it('empieza iniciando, elige la tabla y termina con avance y corte', () => {
    const b = [...escpos(lineas, formato80)]
    expect(b.slice(0, 5)).toEqual([0x1b, 0x40, 0x1b, 0x74, 2])
    expect(b.slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x00])
  })

  it('sin tildes no cambia la tabla de fábrica', () => {
    const b = [...escpos(lineas, { ...formato80, pagina: 'sin_tildes' })]
    expect(b.slice(0, 3)).toEqual([0x1b, 0x40, 0x1b])
    expect(b[3]).not.toBe(0x74)
  })

  it('la página de prueba trae una regla del ancho exacto', () => {
    const prueba = lineasPrueba(
      { impresora: 'Barra', estaciones: ['Barra'], hora: '9:00 p. m.' },
      { columnas: 32, pagina: 'pc850' },
    )
    expect(prueba.some((l) => 'texto' in l && l.texto === '12345678901234567890123456789012')).toBe(
      true,
    )
  })
})

describe('lector', () => {
  it('lo que se imprime se lee igual, con tildes y un corte', async () => {
    const { leerEscpos } = await import('./lector')
    const leido = leerEscpos(escpos(lineasComanda(comanda, formato80), formato80))
    expect(leido.cortes).toBe(1)
    expect(leido.texto).toContain('Término medio')
    expect(leido.texto).toContain('Mesa 6')
  })
})
