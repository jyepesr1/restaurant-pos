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
const TIPOS: TipoComanda[] = ['nueva', 'reimpresion', 'modificacion', 'anulacion']
const CURSOS: CursoComanda[] = ['entrada', 'fuerte', 'postre']

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

const texto = fc.oneof(
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
  cantidad: fc.integer({ min: 1, max: 999 }),
  nombre: texto,
  comensal: fc.option(fc.integer({ min: 1, max: 99 }), { nil: null }),
  curso: fc.option(fc.constantFrom(...CURSOS), { nil: null }),
  opciones: fc.array(texto, { maxLength: 4 }),
  notas: fc.option(texto, { nil: null }),
})

const comanda = fc.record<Comanda>({
  tipo: fc.constantFrom(...TIPOS),
  estacion: texto,
  numero: fc.option(fc.integer({ min: 1, max: 99_999 }), { nil: null }),
  destino: texto,
  pedido: fc.option(fc.integer({ min: 1, max: 99_999 }), { nil: null }),
  mesero: texto,
  hora: texto,
  comensales: fc.option(fc.integer({ min: 1, max: 200 }), { nil: null }),
  items: fc.array(item, { maxLength: 8 }),
  retenidos: fc.option(fc.subarray(CURSOS), { nil: undefined }),
})

const pagina = fc.constantFrom(...PAGINAS_CODIGOS)
const ancho = fc.constantFrom(...ANCHOS)

/**
 * Lee las órdenes ESC/POS con rigor: solo acepta las que usa `escpos.ts`, con sus valores
 * posibles. Cualquier otra orden, o un byte de control suelto, es una orden inyectada.
 */
function analizar(bytes: Uint8Array) {
  const cuenta = { iniciar: 0, tabla: 0, avance: 0, cortes: 0, saltos: 0, imprimibles: 0 }
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    const n = bytes[i + 1]
    const m = bytes[i + 2]
    if (b === 0x1b) {
      if (n === 0x40) {
        cuenta.iniciar += 1
        i += 1
      } else if (n === 0x74 && (m === 2 || m === 16)) {
        cuenta.tabla += 1
        i += 2
      } else if ((n === 0x61 || n === 0x45) && (m === 0 || m === 1)) i += 2
      else if (n === 0x64 && m === 4) {
        cuenta.avance += 1
        i += 2
      } else throw new Error(`Orden ESC inesperada en ${i}: ${n} ${m}`)
    } else if (b === 0x1d) {
      if (n === 0x42 && (m === 0 || m === 1)) i += 2
      else if (n === 0x21 && (m === 0 || m === 0x11)) i += 2
      else if (n === 0x56 && m === 0x42 && bytes[i + 3] === 0) {
        cuenta.cortes += 1
        i += 3
      } else throw new Error(`Orden GS inesperada en ${i}: ${n} ${m}`)
    } else if (b === 0x0a) cuenta.saltos += 1
    else if (b >= 0x20 && b !== 0x7f) cuenta.imprimibles += 1
    else throw new Error(`Byte de control suelto en ${i}: ${b}`)
  }
  return cuenta
}

const textos = (lineas: readonly Linea[]) =>
  lineas.filter((l): l is Extract<Linea, { texto: string }> => 'texto' in l)

describe('propiedades: ninguna línea pasa del ancho', () => {
  it.each(ANCHOS)('la comanda de %i mm, con cualquier texto y tabla', (mm) => {
    const columnas = COLUMNAS[mm]
    fc.assert(
      fc.property(comanda, pagina, (c, p) => {
        const formato = { columnas, pagina: p }
        for (const l of textos(lineasComanda(c, formato))) {
          const caben = l.grande ? Math.floor(columnas / 2) : columnas
          expect(codificar(l.texto, p).length).toBeLessThanOrEqual(caben)
          expect(l.texto.length).toBeLessThanOrEqual(caben)
        }
      }),
      { seed: 1401, numRuns: 400 },
    )
  })

  it.each(ANCHOS)('lo leído del papel de %i mm también cabe (lectura de los bytes)', (mm) => {
    const columnas = COLUMNAS[mm]
    fc.assert(
      fc.property(comanda, pagina, (c, p) => {
        const formato = { columnas, pagina: p }
        const lineas = lineasComanda(c, formato)
        const leido = leerEscpos(escpos(lineas, formato))
        const impresas = leido.texto.split('\n').slice(0, lineas.length)
        impresas.forEach((impresa, i) => {
          const origen = lineas[i] as Linea
          const caben = 'texto' in origen && origen.grande ? Math.floor(columnas / 2) : columnas
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
        const prueba = lineasPrueba(
          { impresora: 'Barra', estaciones: ['Barra', 'Cocina'], hora: '9:00 p. m.' },
          { columnas, pagina: p },
        )
        const regla = textos(prueba).find((l) => /^1234567890/.test(l.texto))
        expect(regla?.texto).toHaveLength(columnas)
        const leido = leerEscpos(escpos(prueba, { columnas, pagina: p })).texto.split('\n')
        expect(leido.filter((l) => l === '-'.repeat(columnas)).length).toBe(
          prueba.filter((l) => 'separador' in l).length,
        )
        for (const l of textos(prueba))
          expect(l.texto.length).toBeLessThanOrEqual(l.grande ? columnas / 2 : columnas)
      }
    }
  })

  it('la página de prueba cabe con nombres de impresora y estaciones arbitrarios', () => {
    fc.assert(
      fc.property(texto, fc.array(texto, { maxLength: 6 }), ancho, pagina, (nombre, est, mm, p) => {
        const formato = { columnas: COLUMNAS[mm], pagina: p }
        for (const l of textos(
          lineasPrueba({ impresora: nombre, estaciones: est, hora: nombre }, formato),
        ))
          expect(l.texto.length).toBeLessThanOrEqual(
            l.grande ? Math.floor(formato.columnas / 2) : formato.columnas,
          )
      }),
      { seed: 1403, numRuns: 150 },
    )
  })

  it('partir: cada pedazo cabe y no se pierde ninguna letra', () => {
    fc.assert(
      fc.property(texto, fc.integer({ min: 4, max: 48 }), pagina, (t, a, p) => {
        const formato = { columnas: 48, pagina: p }
        const trozos = partir(t, a, formato)
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
        texto,
        fc.constantFrom('', '#1', '#12', 'P3', '#99999'),
        ancho,
        fc.boolean(),
        pagina,
        (izq, der, mm, grande, p) => {
          const formato = { columnas: COLUMNAS[mm], pagina: p }
          const lineas = textos(aLosLados(izq, der, formato, { grande }))
          const caben = anchoDe(formato, { grande })
          for (const l of lineas) expect(l.texto.length).toBeLessThanOrEqual(caben)
          if (der) expect(lineas.map((l) => l.texto).join('\n')).toContain(der)
          // Cuando comparten línea, la derecha termina justo en el borde.
          const compartida = lineas.find(
            (l) => l.texto.endsWith(der) && l.texto.length > der.length,
          )
          if (der && compartida && partir(izq, caben, formato).length === lineas.length)
            expect(compartida.texto).toHaveLength(caben)
        },
      ),
      { seed: 1405, numRuns: 300 },
    )
  })
})

describe('propiedades: un texto nunca le da órdenes a la impresora', () => {
  it('limpiar no deja ningún carácter de control, de formato ni de dirección', () => {
    fc.assert(
      fc.property(texto, (t) => {
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
      fc.property(texto, pagina, (t, p) => {
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
      fc.property(comanda, pagina, (c, p) => {
        const formato = { columnas: COLUMNAS[mm], pagina: p }
        const bytes = escpos(lineasComanda(c, formato), formato)
        // Lanza si hay una orden que `escpos.ts` no emite o un byte de control suelto.
        const cuenta = analizar(bytes)
        expect(cuenta.iniciar).toBe(1)
        expect(cuenta.cortes).toBe(1)
        expect(cuenta.avance).toBe(1)
        expect(cuenta.tabla).toBe(p === 'sin_tildes' ? 0 : 1)
        expect([...bytes.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00])
        expect(leerEscpos(bytes).cortes).toBe(1)
      }),
      { seed: 1408, numRuns: 400 },
    )
  })

  it('las órdenes de cajón y de corte escritas en un nombre salen como texto inofensivo', () => {
    const base: Comanda = {
      tipo: 'nueva',
      estacion: '\x1dV\x00Cocina',
      numero: 1,
      destino: '\x1bp\x00\x19\x19Mesa 1',
      pedido: 1,
      mesero: '\x10\x04\x01Ana',
      hora: '8:00',
      comensales: 2,
      items: [
        {
          cantidad: 1,
          nombre: '\x1b@\x1dV\x42\x00Pizza',
          comensal: null,
          curso: null,
          opciones: ['\x1bp\x01'],
          notas: '\x1b!\xff',
        },
      ],
    }
    const formato = { columnas: 48, pagina: 'pc850' as const }
    const bytes = escpos(lineasComanda(base, formato), formato)
    const cuenta = analizar(bytes)
    expect(cuenta.cortes).toBe(1)
    expect(cuenta.iniciar).toBe(1)
    expect(leerEscpos(bytes).texto).toContain('Pizza')
  })
})

describe('propiedades: leer lo impreso devuelve el texto', () => {
  it('cada línea leída es el texto de la línea, ya convertido a la tabla de la impresora', () => {
    fc.assert(
      fc.property(comanda, ancho, pagina, (c, mm, p) => {
        const formato = { columnas: COLUMNAS[mm], pagina: p }
        const lineas = lineasComanda(c, formato)
        const leido = leerEscpos(escpos(lineas, formato))
        const filas = leido.texto.split('\n')
        // Una fila por línea, 4 del avance y la marca del corte.
        expect(filas).toHaveLength(lineas.length + 4 + 1)
        lineas.forEach((l, i) => {
          if ('separador' in l) expect(filas[i]).toBe('-'.repeat(formato.columnas))
          else if ('espacio' in l) expect(filas[i]).toBe('')
          else expect(filas[i]).toBe(caracteres(l.texto, p).join(''))
        })
        expect(filas.slice(lineas.length, lineas.length + 4)).toEqual(['', '', '', ''])
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
        ancho,
        fc.integer({ min: 1, max: 99 }),
        (nombre, p, mm, cantidad) => {
          const formato = { columnas: COLUMNAS[mm], pagina: p }
          const c: Comanda = {
            tipo: 'nueva',
            estacion: 'Cocina',
            numero: 7,
            destino: 'Mesa 6',
            pedido: 3,
            mesero: 'Ana',
            hora: '8:42 p. m.',
            comensales: 2,
            items: [
              {
                cantidad,
                nombre,
                comensal: 1,
                curso: null,
                opciones: [nombre],
                notas: `Ñandú ${nombre}`,
              },
            ],
          }
          const corrido = leerEscpos(escpos(lineasComanda(c, formato), formato))
            .texto.replaceAll('\n', ' ')
            .replace(/ +/g, ' ')
          expect(corrido).toContain(`${cantidad} x ${nombre}`)
          expect(corrido).toContain(`> ${nombre}`)
          expect(corrido).toContain(`NOTA: Ñandú ${nombre}`)
          expect(corrido).toContain('Mesa 6')
          expect(corrido).toContain('#7')
        },
      ),
      { seed: 1410, numRuns: 150 },
    )
  })

  it('imprimir dos veces lo mismo da los mismos bytes (sin hora ni azar)', () => {
    fc.assert(
      fc.property(comanda, ancho, pagina, (c, mm, p) => {
        const formato = { columnas: COLUMNAS[mm], pagina: p }
        expect([...escpos(lineasComanda(c, formato), formato)]).toEqual([
          ...escpos(lineasComanda(JSON.parse(JSON.stringify(c)) as Comanda, formato), formato),
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
  cantidad: 2,
  nombre: 'Tagliata',
  comensal: 2,
  curso: 'fuerte',
  opciones: ['Término medio'],
  notas: null,
}
const nueva: Comanda = {
  tipo: 'nueva',
  estacion: 'Cocina',
  numero: 12,
  destino: 'Mesa 6',
  pedido: 3,
  mesero: 'Ana',
  hora: '8:42 p. m.',
  comensales: 4,
  items: [tagliata],
}
const leer = (c: Comanda, f = f80) => comoTexto(lineasComanda(c, f), f.columnas)

describe('anulación, modificación y reimpresión', () => {
  it('la anulación pone ANULAR arriba, el número original y las cantidades con signo menos', () => {
    const texto = leer({ ...nueva, tipo: 'anulacion' })
    const filas = texto.split('\n')
    expect(filas[0]).toContain('[ANULAR · COCINA]')
    expect(texto).toMatch(/MESA 6 +#12/)
    expect(texto).toContain('-2 X TAGLIATA')
    // La comanda nueva, en cambio, no lleva signo ni título extra.
    expect(leer(nueva)).not.toContain('-2 X')
    expect(leer(nueva).split('\n')[0]).toBe(leer(nueva).split('\n')[0]?.trimEnd())
    expect(leer(nueva)).not.toContain('ANULAR')
  })

  it('la anulación no pone el signo en las opciones ni en las notas, solo en la cantidad', () => {
    const texto = leer({
      ...nueva,
      tipo: 'anulacion',
      items: [{ ...tagliata, notas: 'sin sal', opciones: ['Sin rúgula'] }],
    })
    expect(texto).toContain('> Sin rúgula')
    expect(texto).toContain('[NOTA: sin sal]')
    expect(texto.match(/-\d/g)).toHaveLength(1)
  })

  it('la modificación dice CAMBIO con la estación y trae el producto con sus opciones nuevas', () => {
    const texto = leer({
      ...nueva,
      tipo: 'modificacion',
      estacion: 'Barra',
      items: [{ ...tagliata, opciones: ['Sin hielo'], notas: 'doble' }],
    })
    expect(texto.split('\n')[0]).toContain('[CAMBIO · BARRA]')
    expect(texto).toContain('> Sin hielo')
    expect(texto).toContain('[NOTA: doble]')
    expect(texto).toMatch(/MESA 6 +#12/)
  })

  it('la reimpresión dice REIMPRESIÓN y conserva el número de la comanda original', () => {
    const texto = leer({ ...nueva, tipo: 'reimpresion', numero: 5 })
    expect(texto.split('\n')[0]).toContain('[REIMPRESIÓN · COCINA]')
    expect(texto).toMatch(/MESA 6 +#5/)
  })

  it('los cuatro tipos se distinguen en el encabezado, en cualquier ancho', () => {
    const titulos = [58, 80].flatMap((mm) =>
      TIPOS.map((tipo) =>
        leer({ ...nueva, tipo }, { columnas: COLUMNAS[mm as 58 | 80], pagina: 'pc850' })
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
    expect(leer({ ...nueva, numero: null })).not.toContain('#')
    expect(leer({ ...nueva, numero: null })).toContain('MESA 6')
  })

  it('sin pedido, sin comensales y sin mesero la línea de datos no deja separadores sueltos', () => {
    const texto = leer({ ...nueva, pedido: null, comensales: null, mesero: '', hora: '9:10 a. m.' })
    expect(texto).toContain('9:10 a. m.')
    expect(texto).not.toContain('Pedido')
    expect(texto).not.toContain('pers.')
    expect(texto).not.toMatch(/^ ?·|· ?$/m)
  })

  it('una comanda sin productos no falla y solo lleva el encabezado', () => {
    const lineas = lineasComanda({ ...nueva, items: [] }, f80)
    expect(() => escpos(lineas, f80)).not.toThrow()
    expect(comoTexto(lineas, 48)).not.toContain('X')
  })

  it('el destino largo baja de línea y el número no se pierde (58 mm)', () => {
    const texto = leer({ ...nueva, destino: 'Mesa 6 terraza del segundo piso' }, f58)
    expect(texto).toContain('#12')
    for (const fila of texto.split('\n')) expect(fila.length).toBeLessThanOrEqual(32)
  })
})

describe('cursos', () => {
  const item = (nombre: string, curso: CursoComanda | null): ItemComanda => ({
    ...tagliata,
    nombre,
    curso,
    cantidad: 1,
  })

  it('agrupa por curso en orden entrada, fuerte, postre, sin importar cómo vengan', () => {
    const texto = leer({
      ...nueva,
      items: [item('Tiramisú', 'postre'), item('Tagliata', 'fuerte'), item('Burrata', 'entrada')],
    })
    const pos = (s: string) => texto.indexOf(s)
    expect(pos('ENTRADA')).toBeGreaterThan(-1)
    expect(pos('ENTRADA')).toBeLessThan(pos('1 X BURRATA'))
    expect(pos('1 X BURRATA')).toBeLessThan(pos('FUERTE'))
    expect(pos('FUERTE')).toBeLessThan(pos('1 X TAGLIATA'))
    expect(pos('1 X TAGLIATA')).toBeLessThan(pos('POSTRE'))
    expect(pos('POSTRE')).toBeLessThan(pos('1 X TIRAMISÚ'))
  })

  it('lo que no tiene curso sale primero y sin encabezado de curso', () => {
    const texto = leer({ ...nueva, items: [item('Limonada', null), item('Tagliata', 'fuerte')] })
    expect(texto.indexOf('1 X LIMONADA')).toBeLessThan(texto.indexOf('FUERTE'))
    expect(texto).not.toContain('ENTRADA')
    expect(texto).not.toContain('POSTRE')
  })

  it('si ningún producto tiene curso no sale ningún encabezado de curso', () => {
    const texto = leer({ ...nueva, items: [item('Limonada', null), item('Cerveza', null)] })
    expect(texto).not.toMatch(/ENTRADA|FUERTE|POSTRE/)
  })

  it('un curso sin productos no se imprime', () => {
    const texto = leer({ ...nueva, items: [item('Burrata', 'entrada')] })
    expect(texto).toContain('ENTRADA')
    expect(texto).not.toContain('FUERTE')
    expect(texto).not.toContain('POSTRE')
  })

  it('avisa los cursos retenidos en el orden dado y solo en la comanda que los trae', () => {
    const texto = leer({ ...nueva, retenidos: ['fuerte', 'postre'] })
    expect(texto.replaceAll('\n', ' ')).toContain(
      'En espera: Fuerte, Postre. Sale cuando el mesero lo marche.',
    )
    expect(leer({ ...nueva, retenidos: [] })).not.toContain('En espera')
    expect(leer({ ...nueva })).not.toContain('En espera')
  })

  it('el aviso de cursos en espera cabe en 58 mm', () => {
    const texto = leer({ ...nueva, retenidos: ['entrada', 'fuerte', 'postre'] }, f58)
    for (const fila of texto.split('\n')) expect(fila.length).toBeLessThanOrEqual(32)
    expect(texto.replaceAll('\n', ' ')).toContain('En espera: Entrada, Fuerte, Postre.')
  })

  it('el aviso va al final, después del último separador', () => {
    const lineas = lineasComanda({ ...nueva, retenidos: ['postre'] }, f80)
    const ultimo = lineas.at(-1)
    expect(ultimo && 'texto' in ultimo && ultimo.texto).toMatch(/marche\.$/)
    expect(lineas.findLastIndex((l) => 'separador' in l)).toBeLessThan(lineas.length - 1)
  })
})

describe('estilo de lo que la cocina no puede pasar por alto', () => {
  it('el encabezado va grande e invertido y centrado; las notas, invertidas; las opciones, en negrita', () => {
    const lineas = lineasComanda(
      { ...nueva, items: [{ ...tagliata, notas: 'alergia al maní' }] },
      f80,
    )
    const t = textos(lineas)
    expect(t[0]).toMatchObject({ grande: true, invertido: true, centro: true, texto: 'COCINA' })
    expect(t.find((l) => l.texto.startsWith('NOTA:'))).toMatchObject({ invertido: true })
    expect(t.find((l) => l.texto.startsWith('> '))).toMatchObject({ negrita: true })
    expect(t.find((l) => l.texto.includes('x Tagliata'))).toMatchObject({ grande: true })
  })

  it('la nota larga se parte y cada pedazo sigue invertido', () => {
    const lineas = textos(
      lineasComanda(
        { ...nueva, items: [{ ...tagliata, notas: 'palabra '.repeat(20).trim() }] },
        f58,
      ),
    ).filter((l) => l.invertido && !l.grande)
    expect(lineas.length).toBeGreaterThan(1)
  })
})

describe('parrafo', () => {
  it('un texto vacío da una línea vacía (no desaparece la fila)', () => {
    expect(parrafo('', f80)).toEqual([{ texto: '' }])
  })
})
