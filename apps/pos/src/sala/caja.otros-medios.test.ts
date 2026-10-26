import { type CobradoPorMedio, type CuadreTurno, nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { conSigno, mediosDelCierre } from './Caja'
import { nombreDeMedio, type ReglasCobro } from './cuentas'
import { catalogoDePrueba } from './pruebas'

// Los medios que pide el cierre de caja (tarea 1.8): `mediosDelCierre`, el texto con signo de lo
// escrito y el nombre de un medio propio archivado.

const SODEXO = nuevoId()
const QR = nuevoId()
const VIEJO = nuevoId()

const reglas = (campos: Partial<ReglasCobro> = {}): ReglasCobro => ({
  mediosPago: ['efectivo', 'tarjeta', 'nequi'],
  propinaSugerida: 1000,
  redondeoModo: 'mitad_arriba',
  redondeoEfectivo: 100,
  redondeoEfectivoModo: 'cercano_mitad_abajo',
  imprimePrecuenta: false,
  ...campos,
})

const cobrado = (
  medio: CobradoPorMedio['medio'],
  venta = 1_000,
  medioPropioId: string | null = null,
): CobradoPorMedio => ({ medio, medioPropioId, venta, propina: 0, pagos: 1 })

const cuadreCon = (porMedio: CobradoPorMedio[] = []): CuadreTurno => ({
  turnoId: nuevoId(),
  cajaId: nuevoId(),
  base: 0,
  abiertoEn: '2026-10-26T13:00:00Z',
  porMedio,
  movimientos: [],
  arqueos: [],
  efectivo: { cobrado: 0, devoluciones: 0, entradas: 0, salidas: 0, pagosPropinas: 0, esperado: 0 },
  cerrado: null,
})

const catalogoCon = (proveedores: (string | undefined)[]) =>
  catalogoDePrueba({
    datafonos: proveedores.map((proveedor, i) => ({
      id: nuevoId(),
      nombre: `Datáfono ${i + 1}`,
      ...(proveedor ? { proveedor } : {}),
    })),
  })

const claves = (m: ReturnType<typeof mediosDelCierre>) => m.map((x) => x.clave)

describe('mediosDelCierre: la tarjeta en una sola línea', () => {
  it('con dos datáfonos del mismo proveedor, una sola línea de tarjeta', () => {
    const m = mediosDelCierre(reglas(), cuadreCon(), catalogoCon(['bold', 'bold']))
    expect(m.filter((x) => x.medio === 'tarjeta')).toHaveLength(1)
  })

  it('con tarjeta crédito y débito cobradas, sigue una sola línea de tarjeta', () => {
    const m = mediosDelCierre(
      reglas(),
      cuadreCon([cobrado('tarjeta', 5_000), cobrado('tarjeta', 7_000)]),
      catalogoCon(['bold']),
    )
    expect(claves(m)).toEqual(['tarjeta:', 'nequi:'])
  })

  it('la clave de la tarjeta es «tarjeta:» y la del medio propio «otro:<id>»', () => {
    const m = mediosDelCierre(
      reglas({ mediosPropios: [{ id: SODEXO, nombre: 'Sodexo' }] }),
      cuadreCon(),
      null,
    )
    expect(claves(m)).toEqual(['tarjeta:', 'nequi:', `otro:${SODEXO}`])
    expect(m.at(-1)).toMatchObject({ medio: 'otro', medioPropioId: SODEXO, nombre: 'Sodexo' })
  })
})

describe('mediosDelCierre: la etiqueta de la tarjeta', () => {
  it.each([
    ['bold', 'Cierre de Bold (total con propinas)'],
    ['redeban', 'Cierre de Redeban (total con propinas)'],
    ['credibanco', 'Cierre de Credibanco (total con propinas)'],
  ])('un proveedor (%s): «Cierre de …»', (proveedor, etiqueta) => {
    const m = mediosDelCierre(reglas(), cuadreCon(), catalogoCon([proveedor, proveedor]))
    expect(m.find((x) => x.medio === 'tarjeta')?.etiqueta).toBe(etiqueta)
  })

  it('varios proveedores: la etiqueta genérica, con la suma', () => {
    const m = mediosDelCierre(reglas(), cuadreCon(), catalogoCon(['bold', 'redeban']))
    expect(m.find((x) => x.medio === 'tarjeta')?.etiqueta).toBe(
      'Cierre de los datáfonos (la suma, con propinas)',
    )
  })

  it('un proveedor que no se conoce o sin proveedor: la genérica', () => {
    for (const proveedores of [['wompi'], [undefined], [undefined, undefined]])
      expect(
        mediosDelCierre(reglas(), cuadreCon(), catalogoCon(proveedores)).find(
          (x) => x.medio === 'tarjeta',
        )?.etiqueta,
      ).toBe('Cierre de los datáfonos (la suma, con propinas)')
  })

  it('un proveedor conocido y otro sin proveedor son dos: la genérica', () => {
    const m = mediosDelCierre(reglas(), cuadreCon(), catalogoCon(['bold', undefined]))
    expect(m.find((x) => x.medio === 'tarjeta')?.etiqueta).toContain('datáfonos')
  })

  it('sin datáfonos o sin catálogo: la genérica', () => {
    expect(
      mediosDelCierre(reglas(), cuadreCon(), catalogoCon([])).find((x) => x.medio === 'tarjeta')
        ?.etiqueta,
    ).toBe('Cierre de los datáfonos (la suma, con propinas)')
    expect(
      mediosDelCierre(reglas(), cuadreCon(), null).find((x) => x.medio === 'tarjeta')?.etiqueta,
    ).toBe('Cierre de los datáfonos (la suma, con propinas)')
  })

  it('las apps dicen «Llegó por …» con su nombre', () => {
    const m = mediosDelCierre(
      reglas({ mediosPago: ['efectivo', 'nequi', 'daviplata', 'breb', 'transferencia'] }),
      cuadreCon(),
      null,
    )
    expect(m.map((x) => x.etiqueta)).toEqual([
      'Llegó por Nequi',
      'Llegó por Daviplata',
      'Llegó por Bre-B',
      'Llegó por Transferencia',
    ])
  })
})

describe('mediosDelCierre: qué medios entran', () => {
  it('el efectivo nunca entra', () => {
    const m = mediosDelCierre(reglas(), cuadreCon([cobrado('efectivo', 50_000)]), null)
    expect(
      m.some((x) => (x.medio as string) === 'efectivo' || x.clave.startsWith('efectivo')),
    ).toBe(false)
  })

  it('un medio apagado con pagos en el turno entra, y uno apagado sin pagos no', () => {
    // Daviplata ya no se recibe, pero se cobró en este turno.
    const m = mediosDelCierre(reglas(), cuadreCon([cobrado('daviplata', 8_000)]), null)
    expect(claves(m)).toEqual(['tarjeta:', 'nequi:', 'daviplata:'])
    expect(mediosDelCierre(reglas(), cuadreCon(), null).some((x) => x.medio === 'daviplata')).toBe(
      false,
    )
  })

  it('un medio propio archivado con pagos entra con su nombre; sin pagos, no', () => {
    const r = reglas({ mediosPropiosArchivados: [{ id: VIEJO, nombre: 'Bono de la casa' }] })
    const con = mediosDelCierre(r, cuadreCon([cobrado('otro', 4_000, VIEJO)]), null)
    expect(con.at(-1)).toMatchObject({
      clave: `otro:${VIEJO}`,
      nombre: 'Bono de la casa',
      etiqueta: 'Llegó por Bono de la casa',
    })
    expect(mediosDelCierre(r, cuadreCon(), null).some((x) => x.medioPropioId === VIEJO)).toBe(false)
  })

  it('un medio propio que ya no está ni archivado (no se conoce) entra como «Otro»', () => {
    const m = mediosDelCierre(reglas(), cuadreCon([cobrado('otro', 4_000, VIEJO)]), null)
    expect(m.at(-1)).toMatchObject({
      clave: `otro:${VIEJO}`,
      nombre: 'Otro',
      etiqueta: 'Llegó por Otro',
    })
  })

  it('un «otro» sin id de medio propio no entra (un reembolso sin su pago aquí)', () => {
    const m = mediosDelCierre(reglas(), cuadreCon([cobrado('otro', -2_000, null)]), null)
    expect(m.some((x) => x.medio === 'otro')).toBe(false)
  })

  it('varios medios propios: cada uno en su línea, activos primero y luego los de los pagos', () => {
    const r = reglas({
      mediosPropios: [
        { id: SODEXO, nombre: 'Sodexo' },
        { id: QR, nombre: 'QR del banco' },
      ],
    })
    const m = mediosDelCierre(
      r,
      cuadreCon([cobrado('otro', 1_000, VIEJO), cobrado('otro', 1_000, QR)]),
      null,
    )
    expect(claves(m)).toEqual([
      'tarjeta:',
      'nequi:',
      `otro:${SODEXO}`,
      `otro:${QR}`,
      `otro:${VIEJO}`,
    ])
  })

  it('sin repetidos: un medio que está en las reglas y en los pagos sale una vez', () => {
    const m = mediosDelCierre(
      reglas(),
      cuadreCon([cobrado('nequi'), cobrado('nequi', 3_000), cobrado('tarjeta')]),
      null,
    )
    expect(claves(m)).toEqual(['tarjeta:', 'nequi:'])
  })

  it('sin reglas de cobro (un hub viejo): solo los medios de los pagos', () => {
    expect(mediosDelCierre(null, cuadreCon(), null)).toEqual([])
    expect(claves(mediosDelCierre(null, cuadreCon([cobrado('nequi')]), null))).toEqual(['nequi:'])
  })

  it('el orden de las reglas manda: los medios en el orden en que el restaurante los recibe', () => {
    const m = mediosDelCierre(
      reglas({ mediosPago: ['nequi', 'efectivo', 'tarjeta'] }),
      cuadreCon(),
      null,
    )
    expect(claves(m)).toEqual(['nequi:', 'tarjeta:'])
  })

  it('los nombres de cada medio', () => {
    const m = mediosDelCierre(
      reglas({ mediosPago: ['efectivo', 'tarjeta', 'nequi', 'bono'] }),
      cuadreCon(),
      null,
    )
    expect(m.map((x) => x.nombre)).toEqual(['Tarjeta', 'Nequi', 'Bono'])
  })
})

describe('nombreDeMedio: medios propios archivados', () => {
  it('un medio propio activo, uno archivado y uno desconocido', () => {
    const r = reglas({
      mediosPropios: [{ id: SODEXO, nombre: 'Sodexo' }],
      mediosPropiosArchivados: [{ id: VIEJO, nombre: 'Bono de la casa' }],
    })
    expect(nombreDeMedio('otro', SODEXO, r)).toBe('Sodexo')
    expect(nombreDeMedio('otro', VIEJO, r)).toBe('Bono de la casa')
    expect(nombreDeMedio('otro', QR, r)).toBe('Otro')
    expect(nombreDeMedio('otro', null, r)).toBe('Otro')
    expect(nombreDeMedio('otro', undefined, null)).toBe('Otro')
  })

  it('un hub que no manda los archivados: el medio se llama «Otro»', () => {
    expect(
      nombreDeMedio('otro', VIEJO, reglas({ mediosPropios: [{ id: SODEXO, nombre: 'Sodexo' }] })),
    ).toBe('Otro')
  })

  it('los medios estándar no dependen de los propios', () => {
    expect(nombreDeMedio('nequi', null, reglas())).toBe('Nequi')
    expect(nombreDeMedio('tarjeta', null, null)).toBe('Tarjeta')
  })

  it('un id que está en los dos (activo y archivado): gana el activo', () => {
    const r = reglas({
      mediosPropios: [{ id: SODEXO, nombre: 'Sodexo' }],
      mediosPropiosArchivados: [{ id: SODEXO, nombre: 'Sodexo viejo' }],
    })
    expect(nombreDeMedio('otro', SODEXO, r)).toBe('Sodexo')
  })
})

describe('conSigno: lo escrito en el cierre de un medio', () => {
  it.each([
    ['', 0],
    ['   ', 0],
    ['0', 0],
    ['5000', 5_000],
    ['5.000', 5_000],
    ['1.234.567', 1_234_567],
    ['$ 66.050', 66_050],
    ['-5.000', -5_000],
    ['-5000', -5_000],
    ['  -5.000', -5_000],
    ['-', 0],
    ['-0', 0],
    ['abc', 0],
    ['5-000', 5_000],
    ['-$ 2.500', -2_500],
  ])('«%s» → %s', (texto, esperado) => {
    expect(conSigno(texto)).toBe(esperado)
  })

  it('nunca da -0', () => {
    expect(Object.is(conSigno('-'), 0)).toBe(true)
    expect(Object.is(conSigno('-0'), 0)).toBe(true)
  })

  it('corta a 9 cifras como los demás campos de dinero', () => {
    expect(conSigno('1234567890123')).toBe(123_456_789)
    expect(conSigno('-1234567890123')).toBe(-123_456_789)
  })
})
