import { describe, expect, it } from 'vitest'
import { BRANDS, fullConfig, RestaurantConfig } from './config'
import { chargedInCash } from './money/cash'
import { suggestedTip } from './money/tip'

describe('restaurant config', () => {
  it('with nothing given, returns the pilot defaults (MODELO_DATOS.md)', () => {
    expect(fullConfig()).toEqual({
      business_day_start: '06:00',
      table_lock_by_waiter: false,
      cash_rounding: 100,
      suggested_tip: 1000,
      tip_base: 'pre_tax',
      tax_granularity: 'line',
      sales_by_waiter: 'added_by',
      rounding_mode: 'half_up',
      cash_rounding_mode: 'nearest_half_down',
      session_idle_min: 30,
      brand: 'faro',
      kitchen_yellow_min: 10,
      kitchen_red_min: 20,
      courses_enabled: false,
      payment_methods: ['cash', 'card', 'nequi', 'daviplata', 'breb', 'transfer'],
      custom_methods: [],
      register_variance_threshold: 1000,
      pre_bill_printer_id: null,
    })
  })

  describe('payment methods and pre-bill printer (task 1.6)', () => {
    it('cash is always there, no duplicates, and an unknown method is rejected', () => {
      expect(fullConfig({ payment_methods: ['cash'] }).payment_methods).toEqual(['cash'])
      expect(() => fullConfig({ payment_methods: ['card'] })).toThrow()
      expect(() => fullConfig({ payment_methods: [] })).toThrow()
      expect(() => fullConfig({ payment_methods: ['cash', 'cash'] })).toThrow()
      expect(() => fullConfig({ payment_methods: ['cash', 'cheque'] })).toThrow()
    })

    it('the pre-bill printer is a ULID or nothing', () => {
      expect(fullConfig({ pre_bill_printer_id: null }).pre_bill_printer_id).toBeNull()
      expect(() => fullConfig({ pre_bill_printer_id: 'impresora' })).toThrow()
    })
  })

  describe('restaurant brand (task 1.3c)', () => {
    it('no brand (an old hub) means Faro; the two existing ones are accepted', () => {
      expect(fullConfig({}).brand).toBe('faro')
      expect(fullConfig({ session_idle_min: 10 }).brand).toBe('faro')
      expect(fullConfig({ brand: 'faro' }).brand).toBe('faro')
      expect(fullConfig({ brand: 'la-spritzzeria' }).brand).toBe('la-spritzzeria')
    })

    it('rejects any other brand, including those from earlier tests', () => {
      for (const brand of [
        'bagno',
        'taller',
        'noche',
        'neutra',
        'Faro',
        'FARO',
        ' faro',
        '',
        null,
        0,
        true,
        {},
        ['faro'],
      ])
        expect(RestaurantConfig.safeParse({ brand }).success, JSON.stringify(brand)).toBe(false)
    })

    it('the brand list is what the schema accepts, with no duplicates and Faro first', () => {
      expect([...BRANDS]).toEqual(['faro', 'la-spritzzeria'])
      for (const brand of BRANDS) expect(fullConfig({ brand }).brand).toBe(brand)
    })

    it('filling in twice changes nothing (idempotent), with or without a brand', () => {
      for (const partial of [
        {},
        { brand: 'la-spritzzeria' },
        { brand: 'faro', cash_rounding: 50 },
      ]) {
        const once = fullConfig(partial)
        expect(fullConfig(once)).toEqual(once)
      }
    })
  })

  it('keeps what it is given and rejects out-of-range or decimal values', () => {
    expect(fullConfig({ cash_rounding: 50 }).cash_rounding).toBe(50)
    for (const badCase of [
      { business_day_start: '6:00' },
      { suggested_tip: 10.5 },
      { cash_rounding: 0 },
      { tip_base: 'with_tax' },
      { odd_field: 1 },
    ])
      expect(RestaurantConfig.safeParse(badCase).success).toBe(false)
  })

  it('money limits: tip up to 10 %, rounding only to usual multiples, tax per line', () => {
    for (const good of [
      { suggested_tip: 0 },
      { suggested_tip: 1000 },
      ...[1, 50, 100, 500, 1000].map((cash_rounding) => ({ cash_rounding })),
      { rounding_mode: 'half_even' },
      ...['nearest_half_up', 'down', 'up'].map((m) => ({ cash_rounding_mode: m })),
    ])
      expect(RestaurantConfig.safeParse(good).success).toBe(true)
    for (const badCase of [
      { suggested_tip: -1 },
      { suggested_tip: 1001 },
      { cash_rounding: 200 },
      { cash_rounding: 10_000 },
      { cash_rounding: 100.5 },
      { tax_granularity: 'documento' },
      { rounding_mode: 'toward_zero' },
      { cash_rounding_mode: 'cercano' },
    ])
      expect(RestaurantConfig.safeParse(badCase).success).toBe(false)
  })

  it('the config extremes work in the money code', () => {
    const c = fullConfig({ cash_rounding: 1000, cash_rounding_mode: 'up' })
    expect(chargedInCash(36_810, c.cash_rounding, c.cash_rounding_mode)).toBe(37_000)
    expect(suggestedTip([{ net: 108_000, rate: 800 }], 1000, c.rounding_mode)).toBe(10_000)
    expect(suggestedTip([{ net: 108_000, rate: 800 }], 0)).toBe(0)
  })
})
