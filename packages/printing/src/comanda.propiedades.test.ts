import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  aLosLados,
  anchoDe,
  COLUMNAS,
  type Comanda,
  type CursoComanda,
  caracteres,
  codificar,
  comoTexto,
  escpos,
  type ItemComanda,
  type Linea,
  leerEscpos,
  limpiar,
  lineasComanda,
  lineasPrueba,
  PAGINAS_CODIGOS,
  type PaginaCodigos,
  parrafo,
  partir,
  type TipoComanda,
} from './index'

// Propiedades de la comanda impresa (ADR-015): con cualquier texto que escriba el restaurante,
// ninguna línea pasa del ancho de la impresora y el texto nunca le da órdenes al papel.

const ANCHOS = [58, 80] as const
const TYPES: TipoComanda[] = ['newOne', 'reprinting', 'modification', 'voidEntry']
const COURSES: CursoComanda[] = ['entry', 'main', 'dessert']

/** Órdenes que un texto malicioso (o un nombre pegado de otra app) podría traer. */
const HOSTILES = [
  '\x1b@',
  '\x1bp\x00\x19\x19', // pulso del cajón
  '\x1dV\x00', // corte
  '\x1dV\x42\x00',
  '\x10\x04\x01', // estado en tiempo real
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
  { weight: 2, arbitrary: fc.constantFrom(...HOSTILES) },
  {
    weight: 2,
    arbitrary: fc
      .array(fc.oneof(fc.constantFrom(...HOSTILES), fc.string({ maxLength: 15 })), { maxLength: 5 })
      .map((a) => a.join(' ')),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom('ñÑáéíóú¿¡ü', 'Crème brûlée', '…€×·“”', 'ß ŉ Ǆ 🍕 漢字'),
  },
)

const item = fc.record<ItemComanda>({
  quantity: fc.integer({ min: 1, max: 999 }),
  name: text,
  guest: fc.option(fc.integer({ min: 1, max: 99 }), { nil: null }),
  course: fc.option(fc.constantFrom(...COURSES), { nil: null }),
  options: fc.array(text, { maxLength: 4 }),
  notes: fc.option(text, { nil: null }),
})

const ticket = fc.record<Comanda>({
  type: fc.constantFrom(...TYPES),
  station: text,
  numero: fc.option(fc.integer({ min: 1, max: 99_999 }), { nil: null }),
  target: text,
  order: fc.option(fc.integer({ min: 1, max: 99_999 }), { nil: null }),
  waiter: text,
  time: text,
  guests: fc.option(fc.integer({ min: 1, max: 200 }), { nil: null }),
  items: fc.array(item, { maxLength: 8 }),
  retenidos: fc.option(fc.subarray(COURSES), { nil: undefined }),
})

const pagina = fc.constantFrom(...PAGINAS_CODIGOS)
const width = fc.constantFrom(...ANCHOS)

/**
 * Lee las órdenes ESC/POS con rigor: solo acepta las que usa `escpos.ts`, con sus valores
 * posibles. Cualquier otra orden, o un byte de control suelto, es una orden inyectada.
 */
function analizar(bytes: Uint8Array) {
  const check = { iniciar: 0, tabla: 0, avance: 0, cortes: 0, saltos: 0, imprimibles: 0 }
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    const n = bytes[i + 1]
    const m = bytes[i + 2]
    if (b === 0x1b) {
      if (n === 0x40) {
        check.iniciar += 1
        i += 1
      } else if (n === 0x74 && (m === 2 || m === 16)) {
        check.tabla += 1
        i += 2
      } else if ((n === 0x61 || n === 0x45) && (m === 0 || m === 1)) i += 2
      else if (n === 0x64 && m === 4) {
        check.avance += 1
        i += 2
      } else throw new Error(`Orden ESC inesperada en ${i}: ${n} ${m}`)
    } else if (b === 0x1d) {
      if (n === 0x42 && (m === 0 || m === 1)) i += 2
      else if (n === 0x21 && (m === 0 || m === 0x11)) i += 2
      else if (n === 0x56 && m === 0x42 && bytes[i + 3] === 0) {
        check.cortes += 1
        i += 3
      } else throw new Error(`Orden GS inesperada en ${i}: ${n} ${m}`)
    } else if (b === 0x0a) check.saltos += 1
    else if (b >= 0x20 && b !== 0x7f) check.imprimibles += 1
    else throw new Error(`Byte de control suelto en ${i}: ${b}`)
  }
  return check
}

const textos = (lines: readonly Linea[]) =>
  lines.filter((l): l is Extract<Linea, { text: string }> => 'text' in l)

describe('propiedades: ninguna línea pasa del ancho', () => {
  it.each(ANCHOS)('la comanda de %i mm, con cualquier texto y tabla', (mm) => {
    const columnas = COLUMNAS[mm]
    fc.assert(
      fc.property(ticket, pagina, (c, p) => {
        const format = { columnas, pagina: p }
        for (const l of textos(lineasComanda(c, format))) {
          const caben = l.large ? Math.floor(columnas / 2) : columnas
          expect(codificar(l.text, p).length).toBeLessThanOrEqual(caben)
          expect(l.text.length).toBeLessThanOrEqual(caben)
        }
      }),
      { seed: 1401, numRuns: 400 },
    )
  })

  it.each(ANCHOS)('lo leído del papel de %i mm también cabe (lectura de los bytes)', (mm) => {
    const columnas = COLUMNAS[mm]
    fc.assert(
      fc.property(ticket, pagina, (c, p) => {
        const format = { columnas, pagina: p }
        const lines = lineasComanda(c, format)
        const leido = leerEscpos(escpos(lines, format))
        const impresas = leido.text.split('\n').slice(0, lines.length)
        impresas.forEach((impresa, i) => {
          const source = lines[i] as Linea
          const caben = 'text' in source && source.large ? Math.floor(columnas / 2) : columnas
          expect(impresa.length).toBeLessThanOrEqual(caben)
        })
      }),
      { seed: 1402, numRuns: 200 },
    )
  })

  it('el separador llena justo la línea y la regla de la página de prueba también', () => {
    for (const mm of ANCHOS) {
      const columnas = COLUMNAS[mm]
      for (const p of PAGINAS_CODIGOS) {
        const mockPrinter = lineasPrueba(
          { printer: 'Barra', stations: ['Barra', 'Cocina'], time: '9:00 p. m.' },
          { columnas, pagina: p },
        )
        const rule = textos(mockPrinter).find((l) => /^1234567890/.test(l.text))
        expect(rule?.text).toHaveLength(columnas)
        const leido = leerEscpos(escpos(mockPrinter, { columnas, pagina: p })).text.split('\n')
        expect(leido.filter((l) => l === '-'.repeat(columnas)).length).toBe(
          mockPrinter.filter((l) => 'separator' in l).length,
        )
        for (const l of textos(mockPrinter))
          expect(l.text.length).toBeLessThanOrEqual(l.large ? columnas / 2 : columnas)
      }
    }
  })

  it('la página de prueba cabe con nombres de impresora y estaciones arbitrarios', () => {
    fc.assert(
      fc.property(text, fc.array(text, { maxLength: 6 }), width, pagina, (name, est, mm, p) => {
        const format = { columnas: COLUMNAS[mm], pagina: p }
        for (const l of textos(lineasPrueba({ printer: name, stations: est, time: name }, format)))
          expect(l.text.length).toBeLessThanOrEqual(
            l.large ? Math.floor(format.columnas / 2) : format.columnas,
          )
      }),
      { seed: 1403, numRuns: 150 },
    )
  })

  it('partir: cada pedazo cabe y no se pierde ninguna letra', () => {
    fc.assert(
      fc.property(text, fc.integer({ min: 4, max: 48 }), pagina, (t, a, p) => {
        const format = { columnas: 48, pagina: p }
        const trozos = partir(t, a, format)
        for (const trozo of trozos) expect(trozo.length).toBeLessThanOrEqual(a)
        const original = caracteres(t, p).join('').replaceAll(' ', '')
        expect(trozos.join('').replaceAll(' ', '')).toBe(original)
        // Ninguna línea empieza ni termina en espacio, ni hay dobles.
        for (const trozo of trozos) {
          expect(trozo).toBe(trozo.trim())
          expect(trozo).not.toMatch(/ {2}/)
        }
      }),
      { seed: 1404, numRuns: 500 },
    )
  })

  it('aLosLados: cabe, no pierde la derecha y la deja pegada al borde si hay lugar', () => {
    fc.assert(
      fc.property(
        text,
        fc.constantFrom('', '#1', '#12', 'P3', '#99999'),
        width,
        fc.boolean(),
        pagina,
        (izq, der, mm, large, p) => {
          const format = { columnas: COLUMNAS[mm], pagina: p }
          const lines = textos(aLosLados(izq, der, format, { large }))
          const caben = anchoDe(format, { large })
          for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(caben)
          if (der) expect(lines.map((l) => l.text).join('\n')).toContain(der)
          // Cuando comparten línea, la derecha termina justo en el borde.
          const compartida = lines.find((l) => l.text.endsWith(der) && l.text.length > der.length)
          if (der && compartida && partir(izq, caben, format).length === lines.length)
            expect(compartida.text).toHaveLength(caben)
        },
      ),
      { seed: 1405, numRuns: 300 },
    )
  })
})

describe('propiedades: un texto nunca le da órdenes a la impresora', () => {
  it('limpiar no deja ningún carácter de control, de formato ni de dirección', () => {
    fc.assert(
      fc.property(text, (t) => {
        for (const c of limpiar(t)) {
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

  it('codificar: todo byte de un texto es imprimible (nunca < 0x20 ni 0x7f) y cabe en un byte', () => {
    fc.assert(
      fc.property(text, pagina, (t, p) => {
        for (const b of codificar(t, p)) {
          expect(Number.isInteger(b)).toBe(true)
          expect(b).toBeGreaterThanOrEqual(0x20)
          expect(b).toBeLessThanOrEqual(0xff)
          expect(b).not.toBe(0x7f)
        }
      }),
      { seed: 1407, numRuns: 500 },
    )
  })

  it.each(ANCHOS)('la comanda completa de %i mm solo trae las órdenes propias', (mm) => {
    fc.assert(
      fc.property(ticket, pagina, (c, p) => {
        const format = { columnas: COLUMNAS[mm], pagina: p }
        const bytes = escpos(lineasComanda(c, format), format)
        // Lanza si hay una orden que `escpos.ts` no emite o un byte de control suelto.
        const check = analizar(bytes)
        expect(check.iniciar).toBe(1)
        expect(check.cortes).toBe(1)
        expect(check.avance).toBe(1)
        expect(check.tabla).toBe(p === 'no_accents' ? 0 : 1)
        expect([...bytes.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00])
        expect(leerEscpos(bytes).cortes).toBe(1)
      }),
      { seed: 1408, numRuns: 400 },
    )
  })

  it('las órdenes de cajón y de corte escritas en un nombre salen como texto inofensivo', () => {
    const base: Comanda = {
      type: 'newOne',
      station: '\x1dV\x00Cocina',
      numero: 1,
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
    const format = { columnas: 48, pagina: 'pc850' as const }
    const bytes = escpos(lineasComanda(base, format), format)
    const check = analizar(bytes)
    expect(check.cortes).toBe(1)
    expect(check.iniciar).toBe(1)
    expect(leerEscpos(bytes).text).toContain('Pizza')
  })
})

describe('propiedades: leer lo impreso devuelve el texto', () => {
  it('cada línea leída es el texto de la línea, ya convertido a la tabla de la impresora', () => {
    fc.assert(
      fc.property(ticket, width, pagina, (c, mm, p) => {
        const format = { columnas: COLUMNAS[mm], pagina: p }
        const lines = lineasComanda(c, format)
        const leido = leerEscpos(escpos(lines, format))
        const rows = leido.text.split('\n')
        // Una fila por línea, 4 del avance y la marca del corte.
        expect(rows).toHaveLength(lines.length + 4 + 1)
        lines.forEach((l, i) => {
          if ('separator' in l) expect(rows[i]).toBe('-'.repeat(format.columnas))
          else if ('space' in l) expect(rows[i]).toBe('')
          else expect(rows[i]).toBe(caracteres(l.text, p).join(''))
        })
        expect(rows.slice(lines.length, lines.length + 4)).toEqual(['', '', '', ''])
        expect(leido.cortes).toBe(1)
      }),
      { seed: 1409, numRuns: 300 },
    )
  })

  it('un nombre con tildes se lee igual, tal cual lo escribió el restaurante, en pc850 y wpc1252', () => {
    const palabra = fc.constantFrom(
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
        fc.array(palabra, { minLength: 1, maxLength: 5 }).map((a) => a.join(' ')),
        fc.constantFrom('pc850', 'wpc1252') as fc.Arbitrary<PaginaCodigos>,
        width,
        fc.integer({ min: 1, max: 99 }),
        (name, p, mm, quantity) => {
          const format = { columnas: COLUMNAS[mm], pagina: p }
          const c: Comanda = {
            type: 'newOne',
            station: 'Cocina',
            numero: 7,
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
          const corrido = leerEscpos(escpos(lineasComanda(c, format), format))
            .text.replaceAll('\n', ' ')
            .replace(/ +/g, ' ')
          expect(corrido).toContain(`${quantity} x ${name}`)
          expect(corrido).toContain(`> ${name}`)
          expect(corrido).toContain(`NOTA: Ñandú ${name}`)
          expect(corrido).toContain('Mesa 6')
          expect(corrido).toContain('#7')
        },
      ),
      { seed: 1410, numRuns: 150 },
    )
  })

  it('imprimir dos veces lo mismo da los mismos bytes (sin hora ni azar)', () => {
    fc.assert(
      fc.property(ticket, width, pagina, (c, mm, p) => {
        const format = { columnas: COLUMNAS[mm], pagina: p }
        expect([...escpos(lineasComanda(c, format), format)]).toEqual([
          ...escpos(lineasComanda(JSON.parse(JSON.stringify(c)) as Comanda, format), format),
        ])
      }),
      { seed: 1411, numRuns: 100 },
    )
  })
})

// ── Casos concretos de cada tipo de comanda ────────────────────────────

const f80 = { columnas: COLUMNAS[80], pagina: 'pc850' as const }
const f58 = { columnas: COLUMNAS[58], pagina: 'pc850' as const }

const tagliata: ItemComanda = {
  quantity: 2,
  name: 'Tagliata',
  guest: 2,
  course: 'main',
  options: ['Término medio'],
  notes: null,
}
const newOne: Comanda = {
  type: 'newOne',
  station: 'Cocina',
  numero: 12,
  target: 'Mesa 6',
  order: 3,
  waiter: 'Ana',
  time: '8:42 p. m.',
  guests: 4,
  items: [tagliata],
}
const leer = (c: Comanda, f = f80) => comoTexto(lineasComanda(c, f), f.columnas)

describe('anulación, modificación y reimpresión', () => {
  it('la anulación pone ANULAR arriba, el número original y las cantidades con signo menos', () => {
    const text = leer({ ...newOne, type: 'voidEntry' })
    const rows = text.split('\n')
    expect(rows[0]).toContain('[ANULAR · COCINA]')
    expect(text).toMatch(/MESA 6 +#12/)
    expect(text).toContain('-2 X TAGLIATA')
    // La comanda nueva, en cambio, no lleva signo ni título extra.
    expect(leer(newOne)).not.toContain('-2 X')
    expect(leer(newOne).split('\n')[0]).toBe(leer(newOne).split('\n')[0]?.trimEnd())
    expect(leer(newOne)).not.toContain('ANULAR')
  })

  it('la anulación no pone el signo en las opciones ni en las notas, solo en la cantidad', () => {
    const text = leer({
      ...newOne,
      type: 'voidEntry',
      items: [{ ...tagliata, notes: 'sin sal', options: ['Sin rúgula'] }],
    })
    expect(text).toContain('> Sin rúgula')
    expect(text).toContain('[NOTA: sin sal]')
    expect(text.match(/-\d/g)).toHaveLength(1)
  })

  it('la modificación dice CAMBIO con la estación y trae el producto con sus opciones nuevas', () => {
    const text = leer({
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

  it('la reimpresión dice REIMPRESIÓN y conserva el número de la comanda original', () => {
    const text = leer({ ...newOne, type: 'reprinting', numero: 5 })
    expect(text.split('\n')[0]).toContain('[REIMPRESIÓN · COCINA]')
    expect(text).toMatch(/MESA 6 +#5/)
  })

  it('los cuatro tipos se distinguen en el encabezado, en cualquier ancho', () => {
    const titulos = [58, 80].flatMap((mm) =>
      TYPES.map((type) =>
        leer({ ...newOne, type }, { columnas: COLUMNAS[mm as 58 | 80], pagina: 'pc850' })
          .split('\n')
          .slice(0, 3)
          .join(' '),
      ),
    )
    expect(titulos[0]).not.toMatch(/ANULAR|CAMBIO|REIMPRESI/)
    expect(titulos[1]).toContain('REIMPRESI')
    expect(titulos[2]).toContain('CAMBIO')
    expect(titulos[3]).toContain('ANULAR')
    expect(new Set(titulos.slice(0, 4)).size).toBe(4)
  })

  it('sin número de comanda no se inventa un #', () => {
    expect(leer({ ...newOne, numero: null })).not.toContain('#')
    expect(leer({ ...newOne, numero: null })).toContain('MESA 6')
  })

  it('sin pedido, sin comensales y sin mesero la línea de datos no deja separadores sueltos', () => {
    const text = leer({ ...newOne, order: null, guests: null, waiter: '', time: '9:10 a. m.' })
    expect(text).toContain('9:10 a. m.')
    expect(text).not.toContain('Pedido')
    expect(text).not.toContain('pers.')
    expect(text).not.toMatch(/^ ?·|· ?$/m)
  })

  it('una comanda sin productos no falla y solo lleva el encabezado', () => {
    const lines = lineasComanda({ ...newOne, items: [] }, f80)
    expect(() => escpos(lines, f80)).not.toThrow()
    expect(comoTexto(lines, 48)).not.toContain('X')
  })

  it('el destino largo baja de línea y el número no se pierde (58 mm)', () => {
    const text = leer({ ...newOne, target: 'Mesa 6 terraza del segundo piso' }, f58)
    expect(text).toContain('#12')
    for (const fila of text.split('\n')) expect(fila.length).toBeLessThanOrEqual(32)
  })
})

describe('cursos', () => {
  const item = (name: string, course: CursoComanda | null): ItemComanda => ({
    ...tagliata,
    name,
    course,
    quantity: 1,
  })

  it('agrupa por curso en orden entrada, fuerte, postre, sin importar cómo vengan', () => {
    const text = leer({
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

  it('lo que no tiene curso sale primero y sin encabezado de curso', () => {
    const text = leer({ ...newOne, items: [item('Limonada', null), item('Tagliata', 'main')] })
    expect(text.indexOf('1 X LIMONADA')).toBeLessThan(text.indexOf('FUERTE'))
    expect(text).not.toContain('ENTRADA')
    expect(text).not.toContain('POSTRE')
  })

  it('si ningún producto tiene curso no sale ningún encabezado de curso', () => {
    const text = leer({ ...newOne, items: [item('Limonada', null), item('Cerveza', null)] })
    expect(text).not.toMatch(/ENTRADA|FUERTE|POSTRE/)
  })

  it('un curso sin productos no se imprime', () => {
    const text = leer({ ...newOne, items: [item('Burrata', 'entry')] })
    expect(text).toContain('ENTRADA')
    expect(text).not.toContain('FUERTE')
    expect(text).not.toContain('POSTRE')
  })

  it('avisa los cursos retenidos en el orden dado y solo en la comanda que los trae', () => {
    const text = leer({ ...newOne, retenidos: ['main', 'dessert'] })
    expect(text.replaceAll('\n', ' ')).toContain(
      'En espera: Fuerte, Postre. Sale cuando el mesero lo marche.',
    )
    expect(leer({ ...newOne, retenidos: [] })).not.toContain('En espera')
    expect(leer({ ...newOne })).not.toContain('En espera')
  })

  it('el aviso de cursos en espera cabe en 58 mm', () => {
    const text = leer({ ...newOne, retenidos: ['entry', 'main', 'dessert'] }, f58)
    for (const fila of text.split('\n')) expect(fila.length).toBeLessThanOrEqual(32)
    expect(text.replaceAll('\n', ' ')).toContain('En espera: Entrada, Fuerte, Postre.')
  })

  it('el aviso va al final, después del último separador', () => {
    const lines = lineasComanda({ ...newOne, retenidos: ['dessert'] }, f80)
    const ultimo = lines.at(-1)
    expect(ultimo && 'text' in ultimo && ultimo.text).toMatch(/marche\.$/)
    expect(lines.findLastIndex((l) => 'separator' in l)).toBeLessThan(lines.length - 1)
  })
})

describe('estilo de lo que la cocina no puede pasar por alto', () => {
  it('el encabezado va grande e invertido y centrado; las notas, invertidas; las opciones, en negrita', () => {
    const lines = lineasComanda(
      { ...newOne, items: [{ ...tagliata, notes: 'alergia al maní' }] },
      f80,
    )
    const t = textos(lines)
    expect(t[0]).toMatchObject({ large: true, reversed: true, centro: true, text: 'COCINA' })
    expect(t.find((l) => l.text.startsWith('NOTA:'))).toMatchObject({ reversed: true })
    expect(t.find((l) => l.text.startsWith('> '))).toMatchObject({ negrita: true })
    expect(t.find((l) => l.text.includes('x Tagliata'))).toMatchObject({ large: true })
  })

  it('la nota larga se parte y cada pedazo sigue invertido', () => {
    const lines = textos(
      lineasComanda(
        { ...newOne, items: [{ ...tagliata, notes: 'palabra '.repeat(20).trim() }] },
        f58,
      ),
    ).filter((l) => l.reversed && !l.large)
    expect(lines.length).toBeGreaterThan(1)
  })
})

describe('parrafo', () => {
  it('un texto vacío da una línea vacía (no desaparece la fila)', () => {
    expect(parrafo('', f80)).toEqual([{ text: '' }])
  })
})
