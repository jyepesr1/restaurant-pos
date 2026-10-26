import { type ChargedByMethod, newId, type ShiftReconciliation } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { mediosDelCierre, withSign } from './Caja'
import { methodName, type ReglasCobro } from './cuentas'
import { catalogoDePrueba } from './pruebas'

// Los medios que pide el cierre de caja (tarea 1.8): `mediosDelCierre`, el texto con signo de lo
// escrito y el nombre de un medio propio archivado.

const SODEXO = newId()
const QR = newId()
const VIEJO = newId()

const rules = (fields: Partial<ReglasCobro> = {}): ReglasCobro => ({
  paymentMethods: ['cash', 'card', 'nequi'],
  suggestedTip: 1000,
  roundingMode: 'half_up',
  cashRounding: 100,
  cashRoundingMode: 'nearest_half_down',
  printsPreBill: false,
  ...fields,
})

const charged = (
  method: ChargedByMethod['method'],
  sale = 1_000,
  customMethodId: string | null = null,
): ChargedByMethod => ({ method, customMethodId, sale, tip: 0, payments: 1 })

const cuadreCon = (byMethod: ChargedByMethod[] = []): ShiftReconciliation => ({
  shiftId: newId(),
  registerId: newId(),
  base: 0,
  openedAt: '2026-10-26T13:00:00Z',
  byMethod,
  movements: [],
  cashCounts: [],
  cash: { charged: 0, refunds: 0, entries: 0, outflows: 0, tipPayouts: 0, expected: 0 },
  closed: null,
})

const catalogoCon = (proveedores: (string | undefined)[]) =>
  catalogoDePrueba({
    cardTerminals: proveedores.map((provider, i) => ({
      id: newId(),
      name: `Datáfono ${i + 1}`,
      ...(provider ? { provider } : {}),
    })),
  })

const keys = (m: ReturnType<typeof mediosDelCierre>) => m.map((x) => x.key)

describe('mediosDelCierre: la tarjeta en una sola línea', () => {
  it('con dos datáfonos del mismo proveedor, una sola línea de tarjeta', () => {
    const m = mediosDelCierre(rules(), cuadreCon(), catalogoCon(['bold', 'bold']))
    expect(m.filter((x) => x.method === 'card')).toHaveLength(1)
  })

  it('con tarjeta crédito y débito cobradas, sigue una sola línea de tarjeta', () => {
    const m = mediosDelCierre(
      rules(),
      cuadreCon([charged('card', 5_000), charged('card', 7_000)]),
      catalogoCon(['bold']),
    )
    expect(keys(m)).toEqual(['card:', 'nequi:'])
  })

  it('la clave de la tarjeta es «tarjeta:» y la del medio propio «otro:<id>»', () => {
    const m = mediosDelCierre(
      rules({ customMethods: [{ id: SODEXO, name: 'Sodexo' }] }),
      cuadreCon(),
      null,
    )
    expect(keys(m)).toEqual(['card:', 'nequi:', `other:${SODEXO}`])
    expect(m.at(-1)).toMatchObject({ method: 'other', customMethodId: SODEXO, name: 'Sodexo' })
  })
})

describe('mediosDelCierre: la etiqueta de la tarjeta', () => {
  it.each([
    ['bold', 'Cierre de Bold (total con propinas)'],
    ['redeban', 'Cierre de Redeban (total con propinas)'],
    ['credibanco', 'Cierre de Credibanco (total con propinas)'],
  ])('un proveedor (%s): «Cierre de …»', (provider, label) => {
    const m = mediosDelCierre(rules(), cuadreCon(), catalogoCon([provider, provider]))
    expect(m.find((x) => x.method === 'card')?.label).toBe(label)
  })

  it('varios proveedores: la etiqueta genérica, con la suma', () => {
    const m = mediosDelCierre(rules(), cuadreCon(), catalogoCon(['bold', 'redeban']))
    expect(m.find((x) => x.method === 'card')?.label).toBe(
      'Cierre de los datáfonos (la suma, con propinas)',
    )
  })

  it('un proveedor que no se conoce o sin proveedor: la genérica', () => {
    for (const proveedores of [['wompi'], [undefined], [undefined, undefined]])
      expect(
        mediosDelCierre(rules(), cuadreCon(), catalogoCon(proveedores)).find(
          (x) => x.method === 'card',
        )?.label,
      ).toBe('Cierre de los datáfonos (la suma, con propinas)')
  })

  it('un proveedor conocido y otro sin proveedor son dos: la genérica', () => {
    const m = mediosDelCierre(rules(), cuadreCon(), catalogoCon(['bold', undefined]))
    expect(m.find((x) => x.method === 'card')?.label).toContain('datáfonos')
  })

  it('sin datáfonos o sin catálogo: la genérica', () => {
    expect(
      mediosDelCierre(rules(), cuadreCon(), catalogoCon([])).find((x) => x.method === 'card')
        ?.label,
    ).toBe('Cierre de los datáfonos (la suma, con propinas)')
    expect(
      mediosDelCierre(rules(), cuadreCon(), null).find((x) => x.method === 'card')?.label,
    ).toBe('Cierre de los datáfonos (la suma, con propinas)')
  })

  it('las apps dicen «Llegó por …» con su nombre', () => {
    const m = mediosDelCierre(
      rules({ paymentMethods: ['cash', 'nequi', 'daviplata', 'breb', 'transfer'] }),
      cuadreCon(),
      null,
    )
    expect(m.map((x) => x.label)).toEqual([
      'Llegó por Nequi',
      'Llegó por Daviplata',
      'Llegó por Bre-B',
      'Llegó por Transferencia',
    ])
  })
})

describe('mediosDelCierre: qué medios entran', () => {
  it('el efectivo nunca entra', () => {
    const m = mediosDelCierre(rules(), cuadreCon([charged('cash', 50_000)]), null)
    expect(m.some((x) => (x.method as string) === 'cash' || x.key.startsWith('cash'))).toBe(false)
  })

  it('un medio apagado con pagos en el turno entra, y uno apagado sin pagos no', () => {
    // Daviplata ya no se recibe, pero se cobró en este turno.
    const m = mediosDelCierre(rules(), cuadreCon([charged('daviplata', 8_000)]), null)
    expect(keys(m)).toEqual(['card:', 'nequi:', 'daviplata:'])
    expect(mediosDelCierre(rules(), cuadreCon(), null).some((x) => x.method === 'daviplata')).toBe(
      false,
    )
  })

  it('un medio propio archivado con pagos entra con su nombre; sin pagos, no', () => {
    const r = rules({ archivedCustomMethods: [{ id: VIEJO, name: 'Bono de la casa' }] })
    const withIt = mediosDelCierre(r, cuadreCon([charged('other', 4_000, VIEJO)]), null)
    expect(withIt.at(-1)).toMatchObject({
      key: `other:${VIEJO}`,
      name: 'Bono de la casa',
      label: 'Llegó por Bono de la casa',
    })
    expect(mediosDelCierre(r, cuadreCon(), null).some((x) => x.customMethodId === VIEJO)).toBe(
      false,
    )
  })

  it('un medio propio que ya no está ni archivado (no se conoce) entra como «Otro»', () => {
    const m = mediosDelCierre(rules(), cuadreCon([charged('other', 4_000, VIEJO)]), null)
    expect(m.at(-1)).toMatchObject({
      key: `other:${VIEJO}`,
      name: 'Otro',
      label: 'Llegó por Otro',
    })
  })

  it('un «otro» sin id de medio propio no entra (un reembolso sin su pago aquí)', () => {
    const m = mediosDelCierre(rules(), cuadreCon([charged('other', -2_000, null)]), null)
    expect(m.some((x) => x.method === 'other')).toBe(false)
  })

  it('varios medios propios: cada uno en su línea, activos primero y luego los de los pagos', () => {
    const r = rules({
      customMethods: [
        { id: SODEXO, name: 'Sodexo' },
        { id: QR, name: 'QR del banco' },
      ],
    })
    const m = mediosDelCierre(
      r,
      cuadreCon([charged('other', 1_000, VIEJO), charged('other', 1_000, QR)]),
      null,
    )
    expect(keys(m)).toEqual(['card:', 'nequi:', `other:${SODEXO}`, `other:${QR}`, `other:${VIEJO}`])
  })

  it('sin repetidos: un medio que está en las reglas y en los pagos sale una vez', () => {
    const m = mediosDelCierre(
      rules(),
      cuadreCon([charged('nequi'), charged('nequi', 3_000), charged('card')]),
      null,
    )
    expect(keys(m)).toEqual(['card:', 'nequi:'])
  })

  it('sin reglas de cobro (un hub viejo): solo los medios de los pagos', () => {
    expect(mediosDelCierre(null, cuadreCon(), null)).toEqual([])
    expect(keys(mediosDelCierre(null, cuadreCon([charged('nequi')]), null))).toEqual(['nequi:'])
  })

  it('el orden de las reglas manda: los medios en el orden en que el restaurante los recibe', () => {
    const m = mediosDelCierre(
      rules({ paymentMethods: ['nequi', 'cash', 'card'] }),
      cuadreCon(),
      null,
    )
    expect(keys(m)).toEqual(['nequi:', 'card:'])
  })

  it('los nombres de cada medio', () => {
    const m = mediosDelCierre(
      rules({ paymentMethods: ['cash', 'card', 'nequi', 'voucher'] }),
      cuadreCon(),
      null,
    )
    expect(m.map((x) => x.name)).toEqual(['Tarjeta', 'Nequi', 'Bono'])
  })
})

describe('nombreDeMedio: medios propios archivados', () => {
  it('un medio propio activo, uno archivado y uno desconocido', () => {
    const r = rules({
      customMethods: [{ id: SODEXO, name: 'Sodexo' }],
      archivedCustomMethods: [{ id: VIEJO, name: 'Bono de la casa' }],
    })
    expect(methodName('other', SODEXO, r)).toBe('Sodexo')
    expect(methodName('other', VIEJO, r)).toBe('Bono de la casa')
    expect(methodName('other', QR, r)).toBe('Otro')
    expect(methodName('other', null, r)).toBe('Otro')
    expect(methodName('other', undefined, null)).toBe('Otro')
  })

  it('un hub que no manda los archivados: el medio se llama «Otro»', () => {
    expect(
      methodName('other', VIEJO, rules({ customMethods: [{ id: SODEXO, name: 'Sodexo' }] })),
    ).toBe('Otro')
  })

  it('los medios estándar no dependen de los propios', () => {
    expect(methodName('nequi', null, rules())).toBe('Nequi')
    expect(methodName('card', null, null)).toBe('Tarjeta')
  })

  it('un id que está en los dos (activo y archivado): gana el activo', () => {
    const r = rules({
      customMethods: [{ id: SODEXO, name: 'Sodexo' }],
      archivedCustomMethods: [{ id: SODEXO, name: 'Sodexo viejo' }],
    })
    expect(methodName('other', SODEXO, r)).toBe('Sodexo')
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
  ])('«%s» → %s', (text, expected) => {
    expect(withSign(text)).toBe(expected)
  })

  it('nunca da -0', () => {
    expect(Object.is(withSign('-'), 0)).toBe(true)
    expect(Object.is(withSign('-0'), 0)).toBe(true)
  })

  it('corta a 9 cifras como los demás campos de dinero', () => {
    expect(withSign('1234567890123')).toBe(123_456_789)
    expect(withSign('-1234567890123')).toBe(-123_456_789)
  })
})
