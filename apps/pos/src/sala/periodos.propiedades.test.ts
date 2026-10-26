import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ReglasCobro } from './cuentas'
import type { CierreReporte, Reporte } from './motor'
import {
  type Atajo,
  celda,
  csvDeReporte,
  MAX_DIAS,
  periodoDe,
  puntosEnPorcentaje,
  sumarDias,
} from './periodos'

// Propiedades de lo que calcula la pantalla Reportes (tarea 1.9): los períodos y el CSV para Excel.

const CONFIG = { seed: 20_261_061, numRuns: 300 }
const ATAJOS: Atajo[] = ['hoy', 'ayer', 'semana', 'mes', 'mesPasado']

const dia = fc
  .date({
    min: new Date('2019-01-01T12:00:00Z'),
    max: new Date('2036-12-31T12:00:00Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10))

const entreDias = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

describe('períodos', () => {
  it('sumar y restar los mismos días vuelve al mismo día, y avanza uno a uno', () => {
    fc.assert(
      fc.property(dia, fc.integer({ min: -4_000, max: 4_000 }), (d, n) => {
        expect(sumarDias(sumarDias(d, n), -n)).toBe(d)
        expect(sumarDias(d, n)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(entreDias(d, sumarDias(d, n))).toBe(n)
      }),
      CONFIG,
    )
  })

  it('todos los atajos dan fechas válidas, en orden y dentro de lo que acepta el hub', () => {
    fc.assert(
      fc.property(dia, (hoy) => {
        for (const atajo of ATAJOS) {
          const { desde, hasta } = periodoDe(atajo, hoy)
          expect(desde).toMatch(/^\d{4}-\d{2}-\d{2}$/)
          expect(hasta).toMatch(/^\d{4}-\d{2}-\d{2}$/)
          expect(desde <= hasta, atajo).toBe(true)
          expect(entreDias(desde, hasta) + 1, atajo).toBeLessThanOrEqual(MAX_DIAS)
          // Ningún atajo mira al futuro.
          expect(hasta <= hoy, atajo).toBe(true)
        }
        expect(periodoDe('hoy', hoy)).toEqual({ desde: hoy, hasta: hoy })
        expect(periodoDe('ayer', hoy).hasta).toBe(sumarDias(hoy, -1))
        const semana = periodoDe('semana', hoy)
        expect(entreDias(semana.desde, semana.hasta) + 1).toBe(7)
        expect(semana.hasta).toBe(hoy)
      }),
      CONFIG,
    )
  })

  it('el mes va del 1 a hoy y el mes pasado del 1 al último día, sin huecos entre los dos', () => {
    fc.assert(
      fc.property(dia, (hoy) => {
        const mes = periodoDe('mes', hoy)
        const pasado = periodoDe('mesPasado', hoy)
        expect(mes.desde.slice(0, 7)).toBe(hoy.slice(0, 7))
        expect(mes.desde.endsWith('-01')).toBe(true)
        expect(mes.hasta).toBe(hoy)
        expect(pasado.desde.endsWith('-01')).toBe(true)
        // El mes pasado termina el día antes de que empiece este, y es de un solo mes.
        expect(sumarDias(pasado.hasta, 1)).toBe(mes.desde)
        expect(pasado.desde.slice(0, 7)).toBe(pasado.hasta.slice(0, 7))
        // El día siguiente al último no sigue en el mismo mes.
        expect(sumarDias(pasado.hasta, 1).slice(0, 7)).not.toBe(pasado.hasta.slice(0, 7))
      }),
      CONFIG,
    )
  })

  it('casos de calendario: enero, año bisiesto, fin de mes y mes de 31 días', () => {
    expect(periodoDe('mesPasado', '2026-01-15')).toEqual({
      desde: '2025-12-01',
      hasta: '2025-12-31',
    })
    expect(periodoDe('mesPasado', '2028-03-01')).toEqual({
      desde: '2028-02-01',
      hasta: '2028-02-29',
    })
    expect(periodoDe('mesPasado', '2026-03-31')).toEqual({
      desde: '2026-02-01',
      hasta: '2026-02-28',
    })
    expect(periodoDe('mes', '2026-10-01')).toEqual({ desde: '2026-10-01', hasta: '2026-10-01' })
    expect(periodoDe('semana', '2026-01-03')).toEqual({ desde: '2025-12-28', hasta: '2026-01-03' })
    expect(periodoDe('ayer', '2026-03-01')).toEqual({ desde: '2026-02-28', hasta: '2026-02-28' })
  })

  it('los puntos básicos salen en porcentaje con coma', () => {
    expect(puntosEnPorcentaje(1000)).toBe('10 %')
    expect(puntosEnPorcentaje(800)).toBe('8 %')
    expect(puntosEnPorcentaje(1250)).toBe('12,5 %')
    expect(puntosEnPorcentaje(0)).toBe('0 %')
    expect(puntosEnPorcentaje(1900)).toBe('19 %')
  })
})

// ── CSV ────────────────────────────────────────────────────────────────

/** Lee un CSV con punto y coma, comillas dobles (con saltos de línea dentro) y CRLF. */
function leerCsv(csv: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let celdaActual = ''
  let entreComillas = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i] as string
    if (entreComillas) {
      if (c === '"' && csv[i + 1] === '"') {
        celdaActual += '"'
        i += 1
      } else if (c === '"') entreComillas = false
      else celdaActual += c
    } else if (c === '"') entreComillas = true
    else if (c === ';') {
      fila.push(celdaActual)
      celdaActual = ''
    } else if (c === '\r' && csv[i + 1] === '\n') {
      fila.push(celdaActual)
      filas.push(fila)
      fila = []
      celdaActual = ''
      i += 1
    } else celdaActual += c
  }
  if (celdaActual !== '' || fila.length > 0) {
    fila.push(celdaActual)
    filas.push(fila)
  }
  return filas
}

/** Las secciones: grupos de filas separados por una fila vacía. */
function secciones(csv: string): string[][][] {
  const todas = leerCsv(csv.replace('﻿', ''))
  const grupos: string[][][] = [[]]
  for (const f of todas) {
    if (f.length === 1 && f[0] === '') grupos.push([])
    else grupos[grupos.length - 1]?.push(f)
  }
  return grupos.filter((g) => g.length > 0)
}

const HOSTILES = [
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
const texto = fc.oneof(
  fc.constantFrom(...HOSTILES),
  fc.string({ unit: 'grapheme', maxLength: 30 }),
  fc.string({ unit: 'binary', maxLength: 20 }),
)
const monto = fc.integer({ min: -9_999_999_999, max: 9_999_999_999 })
const hora = fc
  .date({
    min: new Date('2026-01-01T00:00:00Z'),
    max: new Date('2026-12-31T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString())

const reporte = fc.record({
  producto: fc.array(texto, { maxLength: 5 }),
  mesero: fc.array(texto, { maxLength: 3 }),
  motivo: fc.array(texto, { maxLength: 3 }),
  justificacion: fc.option(texto, { nil: null }),
  restaurante: texto,
  medioPropio: texto,
  netos: fc.array(monto, { minLength: 8, maxLength: 8 }),
  hora,
  tarifa: fc.constantFrom(0, 800, 1900, 1250),
})
type Caso = typeof reporte extends fc.Arbitrary<infer T> ? T : never

const ID_PROPIO = '01JB0000000000000000000099'
const REGLAS = (c: Caso) =>
  ({
    zonaHoraria: 'America/Bogota',
    mediosPropios: [{ id: ID_PROPIO, nombre: c.medioPropio }],
  }) as unknown as ReglasCobro

function armar(c: Caso): Reporte {
  const [n0, n1, n2, n3, n4, n5, n6, n7] = c.netos as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const usuarios = Object.fromEntries(c.mesero.map((n, i) => [`u${i}`, n]))
  const cierre: CierreReporte = {
    turnoId: 't1',
    diaOperativo: '2026-10-24',
    abiertoEn: c.hora,
    abiertoPor: 'u0',
    cerradoPor: 'u0',
    base: n0,
    porMedio: [],
    cerrado: {
      esperado: n1,
      contado: n2,
      diferencia: n3,
      justificacion: c.justificacion,
      otrosMedios: [
        { medio: 'otro', medioPropioId: ID_PROPIO, esperado: n4, reportado: n5, diferencia: n6 },
      ] as never,
      hora: c.hora,
    },
  }
  return {
    hoy: '2026-10-24',
    usuarios,
    impresora: false,
    cierres: [cierre],
    informe: {
      desde: '2026-10-24',
      hasta: '2026-10-24',
      ventas: {
        bruto: n0,
        anulado: n1,
        descuentos: n2,
        neto: n3,
        ajustes: n4,
        impuestos: [{ tipo: 'inc', tarifa: c.tarifa, base: n5, impuesto: n6 }],
        propinas: n7,
        cuentas: 3,
        comensales: 5,
        ticketPromedio: n0,
        gastoPorComensal: n1,
      },
      porMedio: [{ medio: 'otro', medioPropioId: ID_PROPIO, venta: n2, propina: n3, pagos: 2 }],
      porMesero: c.mesero.map((_, i) => ({
        usuarioId: `u${i}`,
        neto: n0,
        cuentas: 1,
        ticketPromedio: n0,
      })),
      porProducto: c.producto.map((nombre, i) => ({
        productoId: `p${i}`,
        varianteId: null,
        nombre,
        unidades: i + 1,
        neto: n1,
      })),
      anulaciones: c.motivo.map((m, i) => ({
        eventoId: `e${i}`,
        pedidoId: 'x',
        pedidoNumero: i % 2 === 0 ? i + 1 : null,
        nombre: c.producto[0] ?? 'Producto',
        unidades: 1,
        valor: n2,
        motivo: m,
        yaPreparado: i % 2 === 0,
        usuarioId: 'u0',
        autorizadoPorId: i % 2 === 0 ? 'u0' : null,
        hora: c.hora,
      })),
      cancelaciones: c.motivo.map((m, i) => ({
        eventoId: `c${i}`,
        pedidoId: 'x',
        pedidoNumero: null,
        valor: n3,
        motivo: m,
        usuarioId: 'u0',
        autorizadoPorId: null,
        hora: c.hora,
      })),
      descuentos: [
        {
          pedidoId: 'x',
          pedidoNumero: 4,
          regla: 'porcentaje',
          valor: c.tarifa,
          monto: n4,
          motivo: c.motivo[0] ?? null,
        },
        { pedidoId: 'x', pedidoNumero: null, regla: 'valor', valor: n5, monto: n5, motivo: null },
      ],
      fondoPropinas: { propinas: n5, pagadas: n6, saldo: n7 },
    },
  }
}

/** Lo que debe leer Excel de un texto: el mismo, con un apóstrofo delante si parecería fórmula. */
const neutralizado = (t: string) => (/^[=+\-@\t\r]/.test(t) ? `'${t}` : t)

describe('CSV: una celda', () => {
  it('un texto nunca queda como fórmula y se lee igual que se escribió', () => {
    fc.assert(
      fc.property(texto, (t) => {
        const filas = leerCsv(`${celda(t)}\r\n`)
        const leida = filas[0]?.[0] ?? ''
        expect(filas).toHaveLength(1)
        expect(filas[0]).toHaveLength(1)
        expect(leida).toBe(neutralizado(t))
        expect(/^[=+\-@\t\r]/.test(leida)).toBe(false)
        // Lo que va sin comillas no tiene nada que parta la fila.
        if (!celda(t).startsWith('"')) expect(celda(t)).not.toMatch(/[;"\n\r]/)
      }),
      CONFIG,
    )
  })

  it('un número va tal cual, entero y sin separador de miles, también negativo', () => {
    fc.assert(
      fc.property(fc.integer({ min: -9_999_999_999, max: 9_999_999_999 }), (n) => {
        expect(celda(n)).toBe(String(n))
        expect(celda(n)).toMatch(/^-?\d+$/)
      }),
      CONFIG,
    )
  })

  it('casos concretos de Excel', () => {
    expect(celda('=1+1')).toBe("'=1+1")
    expect(celda('+57 300')).toBe("'+57 300")
    expect(celda('-')).toBe("'-")
    expect(celda('@x')).toBe("'@x")
    expect(celda('\tx')).toBe("'\tx")
    expect(celda('a;b')).toBe('"a;b"')
    expect(celda('a\nb')).toBe('"a\nb"')
    expect(celda('a\r\nb')).toBe('"a\r\nb"')
    expect(celda('"')).toBe('""""')
    expect(celda('=a;b')).toBe(`"'=a;b"`)
    expect(celda('')).toBe('')
  })
})

describe('CSV: el reporte entero', () => {
  const periodo = { desde: '2026-10-24', hasta: '2026-10-24' }

  it('con cualquier texto: BOM al inicio, mismas secciones, filas parejas y nada que sea fórmula', () => {
    fc.assert(
      fc.property(reporte, (c) => {
        const csv = csvDeReporte(armar(c), periodo, REGLAS(c), c.restaurante)
        expect(csv.startsWith('﻿')).toBe(true)
        expect(csv.indexOf('﻿', 1)).toBe(-1)
        expect(csv.endsWith('\r\n')).toBe(true)
        const grupos = secciones(csv)
        // Tantas secciones como en un reporte vacío de textos (los textos no crean ni quitan).
        const referencia = secciones(
          csvDeReporte(
            armar({ ...c, producto: [], mesero: [], motivo: [] }),
            periodo,
            REGLAS(c),
            'R',
          ),
        )
        // Las secciones con filas de datos pueden quedar solo con encabezado, pero siguen ahí.
        expect(grupos.length).toBe(referencia.length)
        for (const g of grupos) {
          const ancho = g[0]?.length
          for (const f of g) expect(f.length, g[0]?.[0]).toBe(ancho)
        }
        // Ninguna celda leída empieza como fórmula, salvo números con signo.
        for (const g of grupos)
          for (const f of g)
            for (const x of f)
              if (!/^-?\d+$/.test(x)) expect(/^[=+\-@\t\r]/.test(x), JSON.stringify(x)).toBe(false)
      }),
      CONFIG,
    )
  })

  it('los textos del restaurante vuelven iguales (con apóstrofo si parecían fórmula)', () => {
    fc.assert(
      fc.property(reporte, (c) => {
        const r = armar(c)
        const grupos = secciones(csvDeReporte(r, periodo, REGLAS(c), c.restaurante))
        expect(grupos[0]?.[0]).toEqual(['Reporte', neutralizado(c.restaurante)].map((x) => x))
        const productos = grupos.find((g) => g[0]?.[0] === 'Producto') ?? []
        expect(productos.slice(1).map((f) => f[0])).toEqual(c.producto.map(neutralizado))
        const meseros = grupos.find((g) => g[0]?.[0] === 'Mesero') ?? []
        expect(meseros.slice(1).map((f) => f[0])).toEqual(c.mesero.map(neutralizado))
        const anulaciones = grupos.find((g) => g[0]?.[0] === 'Anulación') ?? []
        expect(anulaciones.slice(1).map((f) => f[4])).toEqual(c.motivo.map(neutralizado))
        const medios = grupos.find((g) => g[0]?.[0] === 'Medio de pago') ?? []
        expect(medios[1]?.[0]).toBe(neutralizado(c.medioPropio))
        const cierres =
          grupos.find((g) => g[0]?.[0] === 'Cierre de caja' && g[0]?.[1] === 'Abrió') ?? []
        expect(cierres[1]?.[7]).toBe(neutralizado(c.justificacion ?? ''))
      }),
      CONFIG,
    )
  })

  it('los montos salen como enteros en pesos, sin separador de miles ni decimales', () => {
    fc.assert(
      fc.property(reporte, (c) => {
        const r = armar(c)
        const v = r.informe.ventas
        const grupos = secciones(csvDeReporte(r, periodo, REGLAS(c), 'R'))
        const ventas = new Map(
          (grupos.find((g) => g[0]?.[0] === 'Ventas') ?? []).map((f) => [f[0], f[1]]),
        )
        expect(ventas.get('Neto')).toBe(String(v.neto))
        expect(ventas.get('Bruto')).toBe(String(v.bruto))
        expect(ventas.get('Ajuste por redondeo')).toBe(String(v.ajustes))
        expect(ventas.get('Propinas')).toBe(String(v.propinas))
        expect(ventas.get('Ticket promedio')).toBe(String(v.ticketPromedio))
        // Las filas de cifras (todas menos el encabezado y los nombres de la sección) son enteros.
        for (const g of grupos)
          if (['Ventas', 'Fondo de propinas'].includes(g[0]?.[0] ?? ''))
            for (const f of g.slice(1)) expect(f[1], f[0]).toMatch(/^-?\d+$/)
        const medios = grupos.find((g) => g[0]?.[0] === 'Medio de pago') ?? []
        for (const f of medios.slice(1)) for (const x of f.slice(1)) expect(x).toMatch(/^-?\d+$/)
        const cierre =
          grupos.find((g) => g[0]?.[0] === 'Cierre de caja' && g[0]?.[1] === 'Abrió') ?? []
        for (const x of (cierre[1] ?? []).slice(3, 7)) expect(x).toMatch(/^-?\d+$/)
        const otros = grupos.find((g) => g[0]?.[1] === 'Otro medio') ?? []
        expect(otros).toHaveLength(2)
        for (const x of (otros[1] ?? []).slice(2)) expect(x).toMatch(/^-?\d+$/)
        // Los impuestos llevan la tarifa con coma en el nombre, no en el monto.
        expect(ventas.get(`Impuesto INC ${puntosEnPorcentaje(c.tarifa)}`)).toBe(
          String(r.informe.ventas.impuestos[0]?.impuesto),
        )
      }),
      CONFIG,
    )
  })

  it('el descuento por porcentaje lleva el valor en porcentaje con coma y trae su pedido', () => {
    fc.assert(
      fc.property(reporte, (c) => {
        const grupos = secciones(csvDeReporte(armar(c), periodo, REGLAS(c), 'R'))
        const d = grupos.find((g) => g[0]?.[0] === 'Descuento') ?? []
        expect(d[0]).toEqual(['Descuento', 'Pedido', 'Valor', 'Monto', 'Motivo'])
        expect(d[1]?.slice(0, 3)).toEqual(['Porcentaje', '4', puntosEnPorcentaje(c.tarifa)])
        expect(d[2]?.slice(0, 2)).toEqual(['Valor', ''])
      }),
      { ...CONFIG, numRuns: 100 },
    )
  })

  it('un reporte vacío sigue siendo un CSV válido, con BOM', () => {
    const vacio: Reporte = {
      hoy: '2026-10-24',
      usuarios: {},
      impresora: false,
      cierres: [],
      informe: {
        desde: '2026-10-24',
        hasta: '2026-10-24',
        ventas: {
          bruto: 0,
          anulado: 0,
          descuentos: 0,
          neto: 0,
          ajustes: 0,
          impuestos: [],
          propinas: 0,
          cuentas: 0,
          comensales: 0,
          ticketPromedio: 0,
          gastoPorComensal: 0,
        },
        porMedio: [],
        porMesero: [],
        porProducto: [],
        anulaciones: [],
        cancelaciones: [],
        descuentos: [],
        fondoPropinas: { propinas: 0, pagadas: 0, saldo: 0 },
      },
    }
    const csv = csvDeReporte(vacio, periodo, null, '')
    expect(csv.startsWith('﻿Reporte;')).toBe(true)
    expect(csv).toContain('Neto;0')
    expect(csv).not.toMatch(/NaN|undefined|null/)
  })
})
