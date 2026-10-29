import { describe, expect, it } from 'vitest'
import { fullConfig, RestaurantConfig } from './config'
import { newId } from './id'

// Checkout config (task 1.6): `payment_methods` and `pre_bill_printer_id`.

const ALL_METHODS = ['cash', 'card', 'nequi', 'daviplata', 'breb', 'transfer']

describe('config.payment_methods', () => {
  it('with nothing set it has the six methods in the order they show at checkout', () => {
    expect(fullConfig().payment_methods).toEqual(ALL_METHODS)
    expect(fullConfig({}).payment_methods[0]).toBe('cash')
  })

  it('keeps the order the restaurant chose, even if cash is not first', () => {
    expect(fullConfig({ payment_methods: ['nequi', 'cash', 'card'] }).payment_methods).toEqual([
      'nequi',
      'cash',
      'card',
    ])
  })

  it('accepts a subset with cash and the voucher, which is not included by default', () => {
    expect(fullConfig({ payment_methods: ['cash', 'voucher'] }).payment_methods).toEqual([
      'cash',
      'voucher',
    ])
    expect(
      fullConfig({ payment_methods: [...ALL_METHODS, 'voucher'] }).payment_methods,
    ).toHaveLength(7)
  })

  it.each([
    ['without cash', ['card', 'nequi']],
    ['that is empty', []],
    ['with duplicates', ['cash', 'card', 'card']],
    ['with a method that does not exist', ['cash', 'cheque']],
    ['with uppercase', ['Efectivo']],
    ['that is not a list', 'cash'],
    ['null', null],
    ['with an element that is not text', ['cash', 3]],
  ])('rejects a list %s', (_, payment_methods) => {
    expect(RestaurantConfig.safeParse({ payment_methods }).success).toBe(false)
  })

  it('completing an already complete config does not change the methods (idempotent)', () => {
    const once = fullConfig({ payment_methods: ['cash', 'breb'] })
    expect(fullConfig(once).payment_methods).toEqual(['cash', 'breb'])
  })

  it('the default value is not shared: changing one config list does not touch the next', () => {
    const a = fullConfig()
    a.payment_methods.push('voucher')
    a.payment_methods.shift()
    expect(fullConfig().payment_methods).toEqual(ALL_METHODS)
  })
})

describe('config.pre_bill_printer_id', () => {
  it('by default there is no printer: the pre-bill only shows on screen', () => {
    expect(fullConfig().pre_bill_printer_id).toBeNull()
  })

  it('accepts a ULID', () => {
    const id = newId()
    expect(fullConfig({ pre_bill_printer_id: id }).pre_bill_printer_id).toBe(id)
  })

  it.each([
    ['any text', 'impresora'],
    ['an empty string', ''],
    ['a lowercase ULID', newId().toLowerCase()],
    ['one with a space', ` ${newId()}`],
    ['a number', 5],
    ['an object', {}],
  ])('rejects %s', (_, pre_bill_printer_id) => {
    expect(RestaurantConfig.safeParse({ pre_bill_printer_id }).success).toBe(false)
  })

  it('removing it (null) is valid, and both options coexist with the rest of the config', () => {
    const id = newId()
    const config = fullConfig({
      pre_bill_printer_id: id,
      payment_methods: ['cash'],
      cash_rounding: 50,
    })
    expect(config).toMatchObject({
      pre_bill_printer_id: id,
      payment_methods: ['cash'],
      cash_rounding: 50,
    })
    expect(fullConfig({ ...config, pre_bill_printer_id: null }).pre_bill_printer_id).toBe(null)
  })
})

describe('config.custom_methods', () => {
  const own = (extra: object = {}) => ({
    id: newId(),
    name: 'Sodexo',
    active: true,
    ...extra,
  })

  it('by default there are no custom methods', () => {
    expect(fullConfig().custom_methods).toEqual([])
  })

  it('accepts methods with id, name and active, archived ones too', () => {
    const a = own()
    const b = own({ name: 'QR Bancolombia', active: false })
    expect(fullConfig({ custom_methods: [a, b] }).custom_methods).toEqual([a, b])
  })

  it('the name is trimmed and is 1 to 30 characters long', () => {
    expect(
      fullConfig({ custom_methods: [own({ name: '  Rappi  ' })] }).custom_methods[0]?.name,
    ).toBe('Rappi')
    expect(() => fullConfig({ custom_methods: [own({ name: 'x'.repeat(30) })] })).not.toThrow()
    expect(() => fullConfig({ custom_methods: [own({ name: 'x'.repeat(31) })] })).toThrow()
    expect(() => fullConfig({ custom_methods: [own({ name: '   ' })] })).toThrow()
    expect(() => fullConfig({ custom_methods: [own({ name: '' })] })).toThrow()
  })

  it('rejects duplicate ids, ids that are not ULIDs, extra fields and non-boolean active', () => {
    const a = own()
    expect(() => fullConfig({ custom_methods: [a, { ...a, name: 'Otro nombre' }] })).toThrow()
    expect(() => fullConfig({ custom_methods: [own({ id: 'sodexo' })] })).toThrow()
    expect(() => fullConfig({ custom_methods: [own({ color: 'rojo' })] })).toThrow()
    expect(() => fullConfig({ custom_methods: [own({ active: 1 })] })).toThrow()
    expect(() => fullConfig({ custom_methods: 'Sodexo' })).toThrow()
  })

  it('at most 20', () => {
    const twenty = Array.from({ length: 20 }, () => own())
    expect(fullConfig({ custom_methods: twenty }).custom_methods).toHaveLength(20)
    expect(() => fullConfig({ custom_methods: [...twenty, own()] })).toThrow()
  })

  it('«other» does not go in payment_methods: custom methods go in custom_methods', () => {
    expect(() => fullConfig({ payment_methods: ['cash', 'other'] })).toThrow()
    expect(fullConfig({ payment_methods: ['cash', 'voucher'] }).payment_methods).toContain(
      'voucher',
    )
  })

  it('completing twice changes nothing', () => {
    const once = fullConfig({ custom_methods: [own()] })
    expect(fullConfig(once)).toEqual(once)
  })
})
