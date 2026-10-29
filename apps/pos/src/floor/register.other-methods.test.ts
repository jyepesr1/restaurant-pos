import { type ChargedByMethod, newId, type ShiftReconciliation } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { type CheckoutRules, methodName } from './checks'
import { shiftCloseMethods, withSign } from './Register'
import { testCatalog } from './testing'

// The methods the register close asks for (task 1.8): `shiftCloseMethods`, the signed text of
// what was typed and the name of an archived custom method.

const SODEXO = newId()
const QR = newId()
const OLD = newId()

const rules = (fields: Partial<CheckoutRules> = {}): CheckoutRules => ({
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

const reconciliationWith = (byMethod: ChargedByMethod[] = []): ShiftReconciliation => ({
  shiftId: newId(),
  registerId: newId(),
  base: 0,
  openedAt: '2026-10-26T13:00:00Z',
  byMethod,
  movements: [],
  cashCounts: [],
  cash: { charged: 0, refunds: 0, cashIn: 0, cashOut: 0, tipPayouts: 0, expected: 0 },
  closed: null,
})

const catalogWith = (providers: (string | undefined)[]) =>
  testCatalog({
    cardTerminals: providers.map((provider, i) => ({
      id: newId(),
      name: `Datáfono ${i + 1}`,
      ...(provider ? { provider } : {}),
    })),
  })

const keys = (m: ReturnType<typeof shiftCloseMethods>) => m.map((x) => x.key)

describe('shiftCloseMethods: the card on a single line', () => {
  it('with two card terminals from the same provider, a single card line', () => {
    const m = shiftCloseMethods(rules(), reconciliationWith(), catalogWith(['bold', 'bold']))
    expect(m.filter((x) => x.method === 'card')).toHaveLength(1)
  })

  it('with credit and debit card charged, still a single card line', () => {
    const m = shiftCloseMethods(
      rules(),
      reconciliationWith([charged('card', 5_000), charged('card', 7_000)]),
      catalogWith(['bold']),
    )
    expect(keys(m)).toEqual(['card:', 'nequi:'])
  })

  it('the card key is `card:` and the custom method key is `other:<id>`', () => {
    const m = shiftCloseMethods(
      rules({ customMethods: [{ id: SODEXO, name: 'Sodexo' }] }),
      reconciliationWith(),
      null,
    )
    expect(keys(m)).toEqual(['card:', 'nequi:', `other:${SODEXO}`])
    expect(m.at(-1)).toMatchObject({ method: 'other', customMethodId: SODEXO, name: 'Sodexo' })
  })
})

describe('shiftCloseMethods: the card label', () => {
  it.each([
    ['bold', 'Cierre de Bold (total con propinas)'],
    ['redeban', 'Cierre de Redeban (total con propinas)'],
    ['credibanco', 'Cierre de Credibanco (total con propinas)'],
  ])('one provider (%s): «Cierre de …»', (provider, label) => {
    const m = shiftCloseMethods(rules(), reconciliationWith(), catalogWith([provider, provider]))
    expect(m.find((x) => x.method === 'card')?.label).toBe(label)
  })

  it('several providers: the generic label, with the sum', () => {
    const m = shiftCloseMethods(rules(), reconciliationWith(), catalogWith(['bold', 'redeban']))
    expect(m.find((x) => x.method === 'card')?.label).toBe(
      'Cierre de los datáfonos (la suma, con propinas)',
    )
  })

  it('an unknown provider or no provider: the generic one', () => {
    for (const providers of [['wompi'], [undefined], [undefined, undefined]])
      expect(
        shiftCloseMethods(rules(), reconciliationWith(), catalogWith(providers)).find(
          (x) => x.method === 'card',
        )?.label,
      ).toBe('Cierre de los datáfonos (la suma, con propinas)')
  })

  it('a known provider and one without a provider are two: the generic one', () => {
    const m = shiftCloseMethods(rules(), reconciliationWith(), catalogWith(['bold', undefined]))
    expect(m.find((x) => x.method === 'card')?.label).toContain('datáfonos')
  })

  it('no card terminals or no catalog: the generic one', () => {
    expect(
      shiftCloseMethods(rules(), reconciliationWith(), catalogWith([])).find(
        (x) => x.method === 'card',
      )?.label,
    ).toBe('Cierre de los datáfonos (la suma, con propinas)')
    expect(
      shiftCloseMethods(rules(), reconciliationWith(), null).find((x) => x.method === 'card')
        ?.label,
    ).toBe('Cierre de los datáfonos (la suma, con propinas)')
  })

  it('the apps say «Llegó por …» with their name', () => {
    const m = shiftCloseMethods(
      rules({ paymentMethods: ['cash', 'nequi', 'daviplata', 'breb', 'transfer'] }),
      reconciliationWith(),
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

describe('shiftCloseMethods: which methods are included', () => {
  it('cash is never included', () => {
    const m = shiftCloseMethods(rules(), reconciliationWith([charged('cash', 50_000)]), null)
    expect(m.some((x) => (x.method as string) === 'cash' || x.key.startsWith('cash'))).toBe(false)
  })

  it('a disabled method with payments in the shift is included, and a disabled one without payments is not', () => {
    // Daviplata is no longer accepted, but it was charged in this shift.
    const m = shiftCloseMethods(rules(), reconciliationWith([charged('daviplata', 8_000)]), null)
    expect(keys(m)).toEqual(['card:', 'nequi:', 'daviplata:'])
    expect(
      shiftCloseMethods(rules(), reconciliationWith(), null).some((x) => x.method === 'daviplata'),
    ).toBe(false)
  })

  it('an archived custom method with payments is included with its name; without payments, not', () => {
    const r = rules({ archivedCustomMethods: [{ id: OLD, name: 'Bono de la casa' }] })
    const withIt = shiftCloseMethods(r, reconciliationWith([charged('other', 4_000, OLD)]), null)
    expect(withIt.at(-1)).toMatchObject({
      key: `other:${OLD}`,
      name: 'Bono de la casa',
      label: 'Llegó por Bono de la casa',
    })
    expect(
      shiftCloseMethods(r, reconciliationWith(), null).some((x) => x.customMethodId === OLD),
    ).toBe(false)
  })

  it('a custom method that is no longer there, not even archived (unknown), is included as «Otro»', () => {
    const m = shiftCloseMethods(rules(), reconciliationWith([charged('other', 4_000, OLD)]), null)
    expect(m.at(-1)).toMatchObject({
      key: `other:${OLD}`,
      name: 'Otro',
      label: 'Llegó por Otro',
    })
  })

  it('an `other` without a custom method id is not included (a refund without its payment here)', () => {
    const m = shiftCloseMethods(rules(), reconciliationWith([charged('other', -2_000, null)]), null)
    expect(m.some((x) => x.method === 'other')).toBe(false)
  })

  it('several custom methods: each on its own line, active ones first and then those from payments', () => {
    const r = rules({
      customMethods: [
        { id: SODEXO, name: 'Sodexo' },
        { id: QR, name: 'QR del banco' },
      ],
    })
    const m = shiftCloseMethods(
      r,
      reconciliationWith([charged('other', 1_000, OLD), charged('other', 1_000, QR)]),
      null,
    )
    expect(keys(m)).toEqual(['card:', 'nequi:', `other:${SODEXO}`, `other:${QR}`, `other:${OLD}`])
  })

  it('no duplicates: a method that is in the rules and in the payments shows once', () => {
    const m = shiftCloseMethods(
      rules(),
      reconciliationWith([charged('nequi'), charged('nequi', 3_000), charged('card')]),
      null,
    )
    expect(keys(m)).toEqual(['card:', 'nequi:'])
  })

  it('without checkout rules (an old hub): only the methods from the payments', () => {
    expect(shiftCloseMethods(null, reconciliationWith(), null)).toEqual([])
    expect(keys(shiftCloseMethods(null, reconciliationWith([charged('nequi')]), null))).toEqual([
      'nequi:',
    ])
  })

  it('the order of the rules rules: methods in the order in which the restaurant accepts them', () => {
    const m = shiftCloseMethods(
      rules({ paymentMethods: ['nequi', 'cash', 'card'] }),
      reconciliationWith(),
      null,
    )
    expect(keys(m)).toEqual(['nequi:', 'card:'])
  })

  it('the names of each method', () => {
    const m = shiftCloseMethods(
      rules({ paymentMethods: ['cash', 'card', 'nequi', 'voucher'] }),
      reconciliationWith(),
      null,
    )
    expect(m.map((x) => x.name)).toEqual(['Tarjeta', 'Nequi', 'Bono'])
  })
})

describe('methodName: archived custom methods', () => {
  it('an active custom method, an archived one and an unknown one', () => {
    const r = rules({
      customMethods: [{ id: SODEXO, name: 'Sodexo' }],
      archivedCustomMethods: [{ id: OLD, name: 'Bono de la casa' }],
    })
    expect(methodName('other', SODEXO, r)).toBe('Sodexo')
    expect(methodName('other', OLD, r)).toBe('Bono de la casa')
    expect(methodName('other', QR, r)).toBe('Otro')
    expect(methodName('other', null, r)).toBe('Otro')
    expect(methodName('other', undefined, null)).toBe('Otro')
  })

  it('a hub that does not send the archived ones: the method is called «Otro»', () => {
    expect(
      methodName('other', OLD, rules({ customMethods: [{ id: SODEXO, name: 'Sodexo' }] })),
    ).toBe('Otro')
  })

  it('the standard methods do not depend on the custom ones', () => {
    expect(methodName('nequi', null, rules())).toBe('Nequi')
    expect(methodName('card', null, null)).toBe('Tarjeta')
  })

  it('an id that is in both (active and archived): the active one wins', () => {
    const r = rules({
      customMethods: [{ id: SODEXO, name: 'Sodexo' }],
      archivedCustomMethods: [{ id: SODEXO, name: 'Sodexo viejo' }],
    })
    expect(methodName('other', SODEXO, r)).toBe('Sodexo')
  })
})

describe('withSign: what was typed in the close of a method', () => {
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

  it('never gives -0', () => {
    expect(Object.is(withSign('-'), 0)).toBe(true)
    expect(Object.is(withSign('-0'), 0)).toBe(true)
  })

  it('cuts to 9 digits like the other money fields', () => {
    expect(withSign('1234567890123')).toBe(123_456_789)
    expect(withSign('-1234567890123')).toBe(-123_456_789)
  })
})
