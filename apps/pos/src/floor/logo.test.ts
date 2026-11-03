import { LOGO_MAX_HEIGHT, LOGO_MAX_WIDTH, PrintLogo } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { logoSize, printLogoPixels, toPrintLogo } from './logo'

// The logo for the pre-bill: size that fits the paper, threshold to black and white on white
// paper, and the way back to pixels for the preview.

/** RGBA pixels from a list of [r, g, b, a]. */
const rgba = (pixels: [number, number, number, number][]) => Uint8ClampedArray.from(pixels.flat())
const same = (n: number, pixel: [number, number, number, number]) =>
  rgba(Array.from({ length: n }, () => pixel))
const bytesOf = (logo: PrintLogo) => [...Buffer.from(logo.data, 'base64')]

describe('logoSize', () => {
  it('a small logo keeps its size, with the width rounded down to a multiple of 8', () => {
    expect(logoSize(64, 32)).toEqual({ width: 64, height: 32 })
    expect(logoSize(100, 50)).toEqual({ width: 96, height: 48 })
  })

  it('a wide logo is scaled down to 384 dots keeping its proportions', () => {
    expect(logoSize(768, 100)).toEqual({ width: 384, height: 50 })
    expect(logoSize(1536, 400)).toEqual({ width: 384, height: 100 })
  })

  it('a tall logo is scaled down to 240 dots and the width stays a multiple of 8', () => {
    const s = logoSize(100, 480)
    expect(s.height).toBeLessThanOrEqual(LOGO_MAX_HEIGHT)
    expect(s.width % 8).toBe(0)
    expect(s).toEqual({ width: 48, height: 230 })
  })

  it('exactly at the limits it does not change', () => {
    expect(logoSize(LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT)).toEqual({
      width: LOGO_MAX_WIDTH,
      height: LOGO_MAX_HEIGHT,
    })
  })

  it('never makes a logo bigger', () => {
    expect(logoSize(16, 16)).toEqual({ width: 16, height: 16 })
  })

  it('a very narrow or very flat logo is at least 8 x 1', () => {
    expect(logoSize(3, 3)).toEqual({ width: 8, height: 8 })
    expect(logoSize(1000, 1)).toEqual({ width: 384, height: 1 })
    expect(logoSize(2000, 2).height).toBeGreaterThanOrEqual(1)
  })

  it('a very thin tall logo does not go below 8 dots wide', () => {
    const s = logoSize(2, 1000)
    expect(s.width).toBe(8)
    expect(s.height).toBeLessThanOrEqual(LOGO_MAX_HEIGHT)
    expect(s.height).toBeGreaterThanOrEqual(1)
  })

  it('property: the result is always something the hub accepts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6000 }), fc.integer({ min: 1, max: 6000 }), (w, h) => {
        const { width, height } = logoSize(w, h)
        expect(width % 8).toBe(0)
        expect(width).toBeGreaterThanOrEqual(8)
        expect(width).toBeLessThanOrEqual(LOGO_MAX_WIDTH)
        expect(height).toBeGreaterThanOrEqual(1)
        expect(height).toBeLessThanOrEqual(LOGO_MAX_HEIGHT)
        // the converted logo passes the same schema the hub uses
        const logo = toPrintLogo(new Uint8ClampedArray(width * height * 4), width, height)
        expect(PrintLogo.safeParse(logo).success).toBe(true)
      }),
      { numRuns: 60 },
    )
  })

  it('property: when nothing is clamped, proportions are kept up to the rounding of the height', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 64, max: 3000 }),
        fc.integer({ min: 64, max: 3000 }),
        (w, h) => {
          const s = logoSize(w, h)
          fc.pre(s.width > 8 && s.height < LOGO_MAX_HEIGHT)
          expect(Math.abs(s.height - h * (s.width / w))).toBeLessThanOrEqual(0.5 + 1e-9)
        },
      ),
    )
  })
})

describe('toPrintLogo', () => {
  it('transparent is white (paper): all bits 0', () => {
    const logo = toPrintLogo(same(16, [0, 0, 0, 0]), 8, 2)
    expect(bytesOf(logo)).toEqual([0, 0])
  })

  it('opaque black is black: all bits 1', () => {
    const logo = toPrintLogo(same(16, [0, 0, 0, 255]), 8, 2)
    expect(bytesOf(logo)).toEqual([0xff, 0xff])
  })

  it('opaque white is paper', () => {
    expect(bytesOf(toPrintLogo(same(8, [255, 255, 255, 255]), 8, 1))).toEqual([0])
  })

  it('transparent pixels with black color (a canvas gives 0,0,0,0) stay white', () => {
    expect(bytesOf(toPrintLogo(same(8, [0, 0, 0, 0]), 8, 1))).toEqual([0])
  })

  it('bits go most significant first: the first pixel is the 0x80 bit', () => {
    const px: [number, number, number, number][] = Array.from({ length: 8 }, (_, i) =>
      i === 0 || i === 7 ? [0, 0, 0, 255] : [255, 255, 255, 255],
    )
    expect(bytesOf(toPrintLogo(rgba(px), 8, 1))).toEqual([0b1000_0001])
  })

  it('every row has width / 8 bytes: 16 x 2 is four bytes, row after row', () => {
    const px: [number, number, number, number][] = []
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 16; x++)
        px.push(
          y === 0 && x < 8
            ? [0, 0, 0, 255]
            : x >= 8 && y === 1
              ? [0, 0, 0, 255]
              : [255, 255, 255, 255],
        )
    const logo = toPrintLogo(rgba(px), 16, 2)
    expect(logo).toMatchObject({ width: 16, height: 2 })
    expect(bytesOf(logo)).toEqual([0xff, 0x00, 0x00, 0xff])
  })

  it('the threshold: luminance 127 is black and 129 is paper (opaque gray)', () => {
    expect(bytesOf(toPrintLogo(same(8, [127, 127, 127, 255]), 8, 1))).toEqual([0xff])
    expect(bytesOf(toPrintLogo(same(8, [129, 129, 129, 255]), 8, 1))).toEqual([0])
  })

  it('uses perceived luminance: pure green is light, pure blue is dark, pure red is dark', () => {
    // 0.587 * 255 = 149.7 (light), 0.114 * 255 = 29 (dark), 0.299 * 255 = 76 (dark)
    expect(bytesOf(toPrintLogo(same(8, [0, 255, 0, 255]), 8, 1))).toEqual([0])
    expect(bytesOf(toPrintLogo(same(8, [0, 0, 255, 255]), 8, 1))).toEqual([0xff])
    expect(bytesOf(toPrintLogo(same(8, [255, 0, 0, 255]), 8, 1))).toEqual([0xff])
  })

  it('mid gray with alpha is mixed with white paper: opaque is black, half transparent is paper', () => {
    // gray 100 opaque: 100 (black). Half alpha: 100 * 0.502 + 255 * 0.498 = 177 (paper)
    expect(bytesOf(toPrintLogo(same(8, [100, 100, 100, 255]), 8, 1))).toEqual([0xff])
    expect(bytesOf(toPrintLogo(same(8, [100, 100, 100, 128]), 8, 1))).toEqual([0])
  })

  it('black at partial alpha: dark enough counts as black, faint counts as paper', () => {
    // black at alpha a gives 255 * (1 - a/255): black while 255 - alpha < 128, so alpha >= 128
    expect(bytesOf(toPrintLogo(same(8, [0, 0, 0, 128]), 8, 1))).toEqual([0xff])
    expect(bytesOf(toPrintLogo(same(8, [0, 0, 0, 127]), 8, 1))).toEqual([0])
    expect(bytesOf(toPrintLogo(same(8, [0, 0, 0, 10]), 8, 1))).toEqual([0])
  })

  it('accepts a plain array as well as a typed array', () => {
    expect(
      bytesOf(
        toPrintLogo(
          Array(32)
            .fill(0)
            .map((_, i) => (i % 4 === 3 ? 255 : 0)),
          8,
          1,
        ),
      ),
    ).toEqual([0xff])
  })

  it('produces something the hub accepts, at the minimum and the maximum size', () => {
    for (const [w, h] of [
      [8, 1],
      [LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT],
    ] as const) {
      const logo = toPrintLogo(same(w * h, [0, 0, 0, 255]), w, h)
      expect(PrintLogo.safeParse(logo).success, `${w}x${h}`).toBe(true)
      expect(logo.data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    }
  })
})

describe('printLogoPixels', () => {
  it('black bits become opaque black and the rest opaque white', () => {
    const logo = toPrintLogo(
      rgba(
        Array.from({ length: 8 }, (_, i) =>
          i % 2 === 0 ? ([0, 0, 0, 255] as [number, number, number, number]) : [0, 0, 0, 0],
        ),
      ),
      8,
      1,
    )
    const pixels = printLogoPixels(logo)
    expect(pixels).toHaveLength(8 * 4)
    for (let x = 0; x < 8; x++) {
      const v = x % 2 === 0 ? 0 : 255
      expect([...pixels.slice(x * 4, x * 4 + 4)], `pixel ${x}`).toEqual([v, v, v, 255])
    }
  })

  it('round trip: pixels to logo to pixels gives black and white, same positions', () => {
    const width = 24
    const height = 5
    const source = new Uint8ClampedArray(width * height * 4)
    for (let p = 0; p < width * height; p++) {
      const dark = (p * 7) % 5 < 2
      source.set(dark ? [10, 20, 30, 255] : [250, 250, 250, 255], p * 4)
    }
    const back = printLogoPixels(toPrintLogo(source, width, height))
    for (let p = 0; p < width * height; p++) {
      const dark = (p * 7) % 5 < 2
      expect([...back.slice(p * 4, p * 4 + 4)], `pixel ${p}`).toEqual(
        dark ? [0, 0, 0, 255] : [255, 255, 255, 255],
      )
    }
  })

  it('round trip with transparency: transparent comes back white, black opaque comes back black', () => {
    const source = rgba([
      [0, 0, 0, 0],
      [0, 0, 0, 255],
      [255, 255, 255, 0],
      [20, 20, 20, 255],
      [0, 0, 0, 0],
      [0, 0, 0, 255],
      [0, 0, 0, 0],
      [0, 0, 0, 255],
    ])
    const back = printLogoPixels(toPrintLogo(source, 8, 1))
    const colors = Array.from({ length: 8 }, (_, x) => back[x * 4])
    expect(colors).toEqual([255, 0, 255, 0, 255, 0, 255, 0])
    for (let x = 0; x < 8; x++) expect(back[x * 4 + 3]).toBe(255)
  })

  it('the output has exactly width x height x 4 values, with all alphas opaque', () => {
    const logo = toPrintLogo(same(16 * 3, [0, 0, 0, 0]), 16, 3)
    const pixels = printLogoPixels(logo)
    expect(pixels).toHaveLength(16 * 3 * 4)
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(255)
  })

  it('property: converting the preview again gives the same logo (idempotent)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 4, maxLength: 64 }),
        (rowBytes, height, noise) => {
          const width = rowBytes * 8
          const source = new Uint8ClampedArray(width * height * 4)
          source.forEach((_, i) => {
            source[i] = noise[i % noise.length] as number
          })
          const once = toPrintLogo(source, width, height)
          const twice = toPrintLogo(printLogoPixels(once), width, height)
          expect(twice).toEqual(once)
        },
      ),
    )
  })
})
