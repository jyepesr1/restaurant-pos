import { describe, expect, it } from 'vitest'
import { fullConfig, LOGO_MAX_HEIGHT, LOGO_MAX_WIDTH, PrintLogo, RestaurantConfig } from './config'

// The print logo: 1-bit raster, width in multiples of 8, base64 with the exact length.

const logoOf = (width: number, height: number, fill = 0xaa): PrintLogo => ({
  width,
  height,
  data: Buffer.alloc((width / 8) * height, fill).toString('base64'),
})
const valid = (l: unknown) => PrintLogo.safeParse(l).success

describe('PrintLogo: size limits', () => {
  it('the limits are 384 x 240 dots', () => {
    expect(LOGO_MAX_WIDTH).toBe(384)
    expect(LOGO_MAX_HEIGHT).toBe(240)
  })

  it('accepts the smallest and the largest logo', () => {
    expect(valid(logoOf(8, 1))).toBe(true)
    expect(valid(logoOf(LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT))).toBe(true)
    expect(valid(logoOf(LOGO_MAX_WIDTH, 1))).toBe(true)
    expect(valid(logoOf(8, LOGO_MAX_HEIGHT))).toBe(true)
  })

  it('rejects a width above the maximum, even if it is a multiple of 8', () => {
    expect(valid(logoOf(LOGO_MAX_WIDTH + 8, 10))).toBe(false)
  })

  it('rejects a height above the maximum', () => {
    expect(valid(logoOf(64, LOGO_MAX_HEIGHT + 1))).toBe(false)
  })

  it('rejects zero or negative sizes', () => {
    expect(valid({ width: 0, height: 1, data: '' })).toBe(false)
    expect(valid({ width: 8, height: 0, data: '' })).toBe(false)
    expect(valid({ width: -8, height: 1, data: 'AA==' })).toBe(false)
    expect(valid({ width: 8, height: -1, data: 'AA==' })).toBe(false)
  })

  it('rejects a width that is not a multiple of 8', () => {
    for (const width of [1, 7, 9, 12, 100, 383])
      expect(
        valid({ width, height: 4, data: 'A'.repeat(4 * Math.ceil((width * 4) / 8 / 3)) }),
        String(width),
      ).toBe(false)
  })

  it('rejects fractional and non-numeric sizes', () => {
    expect(valid({ ...logoOf(16, 2), width: 16.5 })).toBe(false)
    expect(valid({ ...logoOf(16, 2), height: 2.5 })).toBe(false)
    expect(valid({ ...logoOf(16, 2), width: '16' })).toBe(false)
    expect(valid({ ...logoOf(16, 2), height: null })).toBe(false)
  })
})

describe('PrintLogo: data', () => {
  it('accepts every size whose data has the exact base64 length', () => {
    for (const [w, h] of [
      [8, 1],
      [8, 2],
      [8, 3],
      [16, 1],
      [24, 5],
      [64, 64],
      [136, 17],
    ] as const)
      expect(valid(logoOf(w, h)), `${w}x${h}`).toBe(true)
  })

  it('rejects data one character too short or too long', () => {
    const good = logoOf(64, 8)
    expect(valid({ ...good, data: good.data.slice(0, -4) })).toBe(false)
    expect(valid({ ...good, data: `${good.data}AAAA` })).toBe(false)
  })

  it('rejects data from a different size', () => {
    expect(valid({ ...logoOf(16, 4), data: logoOf(8, 4).data })).toBe(false)
    expect(valid({ ...logoOf(16, 4), data: logoOf(16, 8).data })).toBe(false)
  })

  it('rejects empty data and data that is not base64', () => {
    expect(valid({ width: 8, height: 1, data: '' })).toBe(false)
    expect(valid({ width: 8, height: 1, data: 'AA=!' })).toBe(false)
    expect(valid({ width: 8, height: 1, data: 'A A=' })).toBe(false)
    expect(valid({ width: 8, height: 1, data: 'AA-_' })).toBe(false)
    expect(valid({ width: 8, height: 1, data: 'AA===' })).toBe(false)
  })

  it('rejects a missing or non-string data and extra shapes', () => {
    expect(valid({ width: 8, height: 1 })).toBe(false)
    expect(valid({ width: 8, height: 1, data: 3 })).toBe(false)
    expect(valid(null)).toBe(false)
    expect(valid('logo')).toBe(false)
    expect(valid([])).toBe(false)
  })
})

describe('config: pre-bill header and print logo', () => {
  it('an old config without the fields still reads, with «name» and no logo', () => {
    const old = fullConfig({ session_idle_min: 10, pre_bill_printer_id: null })
    expect(old.pre_bill_header).toBe('name')
    expect(old.print_logo).toBeNull()
    expect(fullConfig().pre_bill_header).toBe('name')
    expect(fullConfig().print_logo).toBeNull()
    expect(RestaurantConfig.safeParse({}).success).toBe(true)
  })

  it('stores a valid logo and the «logo» header', () => {
    const logo = logoOf(48, 12)
    const c = fullConfig({ pre_bill_header: 'logo', print_logo: logo })
    expect(c.pre_bill_header).toBe('logo')
    expect(c.print_logo).toEqual(logo)
  })

  it('rejects an invalid logo and an unknown header inside the config', () => {
    expect(() => fullConfig({ print_logo: { width: 7, height: 1, data: 'AA==' } })).toThrow()
    expect(() => fullConfig({ print_logo: logoOf(400, 10) })).toThrow()
    expect(() => fullConfig({ pre_bill_header: 'banner' })).toThrow()
    expect(() => fullConfig({ pre_bill_header: null })).toThrow()
  })

  it('a null logo is accepted and filling in twice changes nothing', () => {
    const once = fullConfig({ pre_bill_header: 'logo', print_logo: logoOf(8, 8) })
    expect(fullConfig(once)).toEqual(once)
    expect(fullConfig({ print_logo: null }).print_logo).toBeNull()
  })
})
