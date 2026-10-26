import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type CierreZ,
  COLUMNAS,
  codificar,
  comoTexto,
  escpos,
  type Linea,
  leerEscpos,
  lineasCierreZ,
  PAGINAS_CODIGOS,
  pesos,
} from './index'

// El cierre Z en papel con cualquier dato (tarea 1.9): ninguna línea pasa del ancho, ningún texto
// del restaurante le da órdenes a la impresora y los montos salen completos.

const ANCHOS = [58, 80] as const
const HOSTILES = [
  '\x1b@',
  '\x1bp\x00\x19\x19', // pulso del cajón
  '\x1dV\x00', // corte
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
  { weight: 2, arbitrary: fc.constantFrom(...HOSTILES) },
  {
    weight: 1,
    arbitrary: fc.constantFrom('ñÑáéíóú¿¡ü', 'Crème brûlée', '🍕 漢字', 'x'.repeat(200)),
  },
)
// Montos de cero a miles de millones, y con signo donde el cierre lo permite.
const pesosArb = fc.oneof(
  fc.integer({ min: 0, max: 999 }),
  fc.integer({ min: 0, max: 99_999_999_999 }),
)
const conSigno = fc.integer({ min: -99_999_999, max: 99_999_999 })

const method = fc.record({
  name: text,
  expected: conSigno,
  reported: conSigno,
  variance: conSigno,
})
const closeout = fc.record<CierreZ>({
  restaurant: text,
  day: text,
  opened: text,
  closed: text,
  abrio: text,
  cerro: text,
  cash: fc.record({
    base: pesosArb,
    charged: pesosArb,
    refunds: pesosArb,
    entries: pesosArb,
    outflows: pesosArb,
    tipPayouts: pesosArb,
    expected: conSigno,
    counted: pesosArb,
    variance: conSigno,
  }),
  otherMethods: fc.array(method, { maxLength: 5 }),
  justification: fc.option(text, { nil: null }),
  charged: fc.array(fc.record({ name: text, sale: conSigno, tip: conSigno }), {
    maxLength: 6,
  }),
  sales: fc.record({
    net: pesosArb,
    taxes: fc.array(fc.record({ name: text, base: pesosArb, value: pesosArb }), {
      maxLength: 4,
    }),
    tips: conSigno,
    settings: conSigno,
    checks: fc.nat(9_999),
    guests: fc.nat(99_999),
    averageTicket: pesosArb,
    voided: pesosArb,
    canceled: pesosArb,
    discounts: pesosArb,
  }),
  reprinted: fc.option(text, { nil: null }),
})

const textos = (lines: readonly Linea[]) =>
  lines.filter((l): l is Extract<Linea, { text: string }> => 'text' in l)

/** Solo acepta las órdenes que usa `escpos.ts`; cualquier otra, o un byte de control, es inyección. */
function analizar(bytes: Uint8Array) {
  let cortes = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    const n = bytes[i + 1]
    const m = bytes[i + 2]
    if (b === 0x1b) {
      if (n === 0x40) i += 1
      else if (n === 0x74 && (m === 2 || m === 16)) i += 2
      else if ((n === 0x61 || n === 0x45) && (m === 0 || m === 1)) i += 2
      else if (n === 0x64 && m === 4) i += 2
      else throw new Error(`Orden ESC inesperada en ${i}: ${n} ${m}`)
    } else if (b === 0x1d) {
      if (n === 0x42 && (m === 0 || m === 1)) i += 2
      else if (n === 0x21 && (m === 0 || m === 0x11)) i += 2
      else if (n === 0x56 && m === 0x42 && bytes[i + 3] === 0) {
        cortes += 1
        i += 3
      } else throw new Error(`Orden GS inesperada en ${i}: ${n} ${m}`)
    } else if (b === 0x0a) continue
    else if (b >= 0x20 && b !== 0x7f) continue
    else throw new Error(`Byte de control suelto en ${i}: ${b}`)
  }
  return { cortes }
}

describe('propiedades del cierre Z impreso', () => {
  it.each(ANCHOS)('en %i mm ninguna línea pasa del ancho, con cualquier texto y tabla', (mm) => {
    const columnas = COLUMNAS[mm]
    fc.assert(
      fc.property(closeout, fc.constantFrom(...PAGINAS_CODIGOS), (z, p) => {
        for (const l of textos(lineasCierreZ(z, { columnas, pagina: p }))) {
          const caben = l.large ? Math.floor(columnas / 2) : columnas
          expect(l.text.length).toBeLessThanOrEqual(caben)
          expect(codificar(l.text, p).length).toBeLessThanOrEqual(caben)
        }
      }),
      { seed: 1901, numRuns: 300 },
    )
  })

  it.each(ANCHOS)('en %i mm lo leído de los bytes también cabe y no trae órdenes ajenas', (mm) => {
    const columnas = COLUMNAS[mm]
    fc.assert(
      fc.property(closeout, fc.constantFrom(...PAGINAS_CODIGOS), (z, p) => {
        const format = { columnas, pagina: p }
        const lines = lineasCierreZ(z, format)
        const bytes = escpos(lines, format)
        analizar(bytes)
        const impresas = leerEscpos(bytes).text.split('\n').slice(0, lines.length)
        impresas.forEach((impresa, i) => {
          const source = lines[i] as Linea
          const caben = 'text' in source && source.large ? Math.floor(columnas / 2) : columnas
          expect(impresa.length).toBeLessThanOrEqual(caben)
        })
      }),
      { seed: 1902, numRuns: 150 },
    )
  })

  it('lleva siempre el título, las firmas y los totales del efectivo, y no cambia con el ancho', () => {
    fc.assert(
      fc.property(closeout, (z) => {
        const t80 = comoTexto(
          lineasCierreZ(z, { columnas: COLUMNAS[80], pagina: 'pc850' }),
          COLUMNAS[80],
        )
        const t58 = comoTexto(
          lineasCierreZ(z, { columnas: COLUMNAS[58], pagina: 'pc850' }),
          COLUMNAS[58],
        )
        for (const t of [t80, t58]) {
          expect(t).toContain('CIERRE DE CAJA')
          expect(t).toContain('Firma cajero')
          expect(t).toContain('Firma de quien recibe')
        }
        // Los montos del efectivo salen completos aunque la línea se parta: en cada ancho, sin
        // espacios ni saltos, el monto aparece.
        const floorPlan = (t: string) => t.replace(/\s+/g, '')
        for (const amount of [z.cash.expected, z.cash.counted, z.cash.base])
          for (const t of [t80, t58])
            expect(floorPlan(t)).toContain(floorPlan(pesos(Math.abs(amount))))
        // Una reimpresión lo dice y un original no.
        expect(t80.includes('Reimpresión')).toBe(Boolean(z.reprinted))
      }),
      { seed: 1903, numRuns: 200 },
    )
  })

  it('la diferencia dice Cuadra, Sobran o Faltan según su signo', () => {
    const base = {
      restaurant: 'R',
      day: 'sábado 24 de octubre de 2026',
      opened: '1',
      closed: '2',
      abrio: 'A',
      cerro: 'B',
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
    } satisfies CierreZ
    const dice = (variance: number) =>
      comoTexto(
        lineasCierreZ(
          { ...base, cash: { ...base.cash, variance } },
          {
            columnas: COLUMNAS[80],
            pagina: 'pc850',
          },
        ),
        COLUMNAS[80],
      )
    expect(dice(0)).toContain('Cuadra')
    expect(dice(1_500)).toContain('Sobran $1.500')
    expect(dice(-1_500)).toContain('Faltan $1.500')
    expect(dice(-1_500)).not.toContain('Sobran')
    // Sin impuestos, anulaciones ni medios: no se imprimen secciones vacías.
    const t = dice(0)
    for (const share of ['Anulado', 'Otros medios', 'Justificación', 'Cobrado en el turno'])
      expect(t).not.toContain(share)
  })
})
