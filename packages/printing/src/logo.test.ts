import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  asText,
  COLUMNS,
  escpos,
  type Line,
  type PreBill,
  preBillLines,
  type RasterImage,
  readEscpos,
} from './index'

// The logo on paper: `GS v 0` raster image, centered, and what the reader and the text view make
// of it.

const ESC = 0x1b
const GS = 0x1d
const f80 = { columns: COLUMNS[80], page: 'no_accents' as const }
const f58 = { columns: COLUMNS[58], page: 'no_accents' as const }

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Base64 by hand: the package compiles without the browser's or Node's types. */
function toBase64(bytes: number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = bytes.slice(i, i + 3)
    const n = (a << 16) | (b << 8) | c
    const left = bytes.length - i
    out += ALPHABET[(n >> 18) & 63]
    out += ALPHABET[(n >> 12) & 63]
    out += left > 1 ? ALPHABET[(n >> 6) & 63] : '='
    out += left > 2 ? ALPHABET[n & 63] : '='
  }
  return out
}

const imageOf = (width: number, height: number, bytes: number[]): RasterImage => ({
  width,
  height,
  data: toBase64(bytes),
})
const sequence = (n: number, from = 0) => Array.from({ length: n }, (_, i) => (i + from) & 0xff)

describe('escpos: image', () => {
  it('prints a 16 x 3 image with exact GS v 0 bytes, centered before and normal after', () => {
    const pixels = [0xff, 0x00, 0xaa, 0x55, 0x80, 0x01]
    const bytes = [...escpos([{ image: imageOf(16, 3, pixels) }], f80)]
    expect(bytes).toEqual([
      ESC,
      0x40,
      // centered
      ESC,
      0x61,
      1,
      // GS v 0 m=0, xL xH = 2 bytes per row, yL yH = 3 rows
      GS,
      0x76,
      0x30,
      0,
      2,
      0,
      3,
      0,
      ...pixels,
      // alignment back to normal
      ESC,
      0x61,
      0,
      // closing: size, bold, align, feed, partial cut
      GS,
      0x21,
      0,
      ESC,
      0x45,
      0,
      ESC,
      0x61,
      0,
      ESC,
      0x64,
      4,
      GS,
      0x56,
      0x42,
      0,
    ])
  })

  it('writes width and height in little endian and the real size of the header', () => {
    const image = imageOf(384, 240, sequence(48 * 240))
    const bytes = [...escpos([{ image }], f80)]
    const at = bytes.indexOf(0x76)
    expect(bytes.slice(at - 1, at + 7)).toEqual([GS, 0x76, 0x30, 0, 48, 0, 240, 0])
    expect(bytes.slice(at + 7, at + 7 + 48 * 240)).toEqual(sequence(48 * 240))
  })

  it('decodes every byte value 0 to 255 exactly', () => {
    const all = sequence(256)
    const bytes = [...escpos([{ image: imageOf(64, 32, all) }], f80)]
    const at = bytes.indexOf(0x76)
    expect(bytes.slice(at + 7, at + 7 + 256)).toEqual(all)
  })

  it.each([
    [1, 'AA=='],
    [2, 'AAA='],
    [3, 'AAAA'],
  ])('base64 with %i byte(s) in the last group (padding) decodes to zeros', (n, data) => {
    const bytes = [...escpos([{ image: { width: 8 * n, height: 1, data } }], f80)]
    const at = bytes.indexOf(0x76)
    expect(bytes.slice(at + 7, at + 7 + n)).toEqual(Array(n).fill(0))
    // the next command is the alignment back to normal: nothing extra, nothing missing
    expect(bytes.slice(at + 7 + n, at + 7 + n + 3)).toEqual([ESC, 0x61, 0])
  })

  it('known base64 values: «/w==» is 0xff, «+/8=» is 0xfb 0xff, «SGk=» is «Hi»', () => {
    const decode = (data: string, n: number) => {
      const bytes = [...escpos([{ image: { width: 8 * n, height: 1, data } }], f80)]
      const at = bytes.indexOf(0x76)
      return bytes.slice(at + 7, at + 7 + n)
    }
    expect(decode('/w==', 1)).toEqual([0xff])
    expect(decode('+/8=', 2)).toEqual([0xfb, 0xff])
    expect(decode('SGk=', 2)).toEqual([0x48, 0x69])
  })

  it('the image sits between two lines of text without disturbing them', () => {
    const lines: Line[] = [
      { text: 'Antes', center: true },
      { image: imageOf(8, 1, [0xf0]) },
      { text: 'Despues' },
    ]
    expect(readEscpos(escpos(lines, f80)).text.split('\n')).toEqual([
      'Antes',
      '[logo 8×1]',
      'Despues',
      '',
      '',
      '',
      '',
      '✂ ─────────',
    ])
  })

  it('property: any image comes out as its header and its exact bytes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 48 }),
        fc.integer({ min: 1, max: 30 }),
        fc.integer(),
        (rowBytes, height, seed) => {
          const pixels = sequence(rowBytes * height, seed)
          const bytes = [...escpos([{ image: imageOf(rowBytes * 8, height, pixels) }], f80)]
          const at = bytes.indexOf(0x76)
          expect(bytes.slice(at - 1, at + 7)).toEqual([GS, 0x76, 0x30, 0, rowBytes, 0, height, 0])
          expect(bytes.slice(at + 7, at + 7 + pixels.length)).toEqual(pixels)
        },
      ),
    )
  })
})

describe('readEscpos: image', () => {
  it('shows the logo size and skips its bytes, even if they look like commands or line feeds', () => {
    // 0x0a (LF), 0x1b (ESC), 0x1d (GS), 0x56 ('V'), 0x41 ('A') inside the dots
    const pixels = [0x0a, 0x1b, 0x1d, 0x56, 0x42, 0x41, 0x1d, 0x76, 0x30, 0x0a, 0x0a, 0x0a]
    const lines: Line[] = [{ image: imageOf(24, 4, pixels) }, { text: 'Precuenta' }]
    const read = readEscpos(escpos(lines, f80))
    expect(read.text.split('\n').slice(0, 2)).toEqual(['[logo 24×4]', 'Precuenta'])
    expect(read.cuts).toBe(1)
    expect(read.text).not.toContain('A')
  })

  it('reads the text that comes after, line by line, as if there were no image', () => {
    const after: Line[] = [
      { text: 'PRECUENTA', center: true, bold: true },
      { separator: true },
      { text: 'Mesa 5', large: true },
    ]
    const plain = readEscpos(escpos(after, f80)).text
    const logo = readEscpos(
      escpos([{ image: imageOf(16, 2, [0x0a, 0x0a, 0x1d, 0x56]) }, ...after], f80),
    ).text
    expect(logo).toBe(`[logo 16×2]\n${plain}`)
  })

  it('two images in a row are read one by one', () => {
    const lines: Line[] = [
      { image: imageOf(8, 2, [1, 2]) },
      { image: imageOf(16, 1, [0x0a, 0x0a]) },
      { text: 'Fin' },
    ]
    expect(readEscpos(escpos(lines, f80)).text.split('\n').slice(0, 3)).toEqual([
      '[logo 8×2]',
      '[logo 16×1]',
      'Fin',
    ])
  })

  it('property: the text after an image is always read intact', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 48 }),
        fc.integer({ min: 1, max: 30 }),
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 1440 }),
        (rowBytes, height, noise) => {
          const pixels = Array.from(
            { length: rowBytes * height },
            (_, i) => noise[i % noise.length],
          ) as number[]
          const read = readEscpos(
            escpos([{ image: imageOf(rowBytes * 8, height, pixels) }, { text: 'Gracias' }], f80),
          )
          expect(read.text.split('\n').slice(0, 2)).toEqual([
            `[logo ${rowBytes * 8}×${height}]`,
            'Gracias',
          ])
          expect(read.cuts).toBe(1)
        },
      ),
    )
  })
})

describe('asText: image', () => {
  it('shows [LOGO] centered on the page width', () => {
    const t80 = asText([{ image: imageOf(8, 1, [0]) }], 48)
    const t58 = asText([{ image: imageOf(8, 1, [0]) }], 32)
    expect(t80.trim()).toBe('[LOGO]')
    expect(t58.trim()).toBe('[LOGO]')
    expect(t80.length).toBe(Math.floor((48 + 6) / 2))
    expect(t58.length).toBe(Math.floor((32 + 6) / 2))
  })
})

describe('preBillLines: logo', () => {
  const preBill: PreBill = {
    restaurant: 'La Spritzzería',
    target: 'Mesa 5',
    order: 12,
    waiter: 'Ana',
    time: '8:42 p. m.',
    guests: 4,
    lines: [{ quantity: 2, name: 'Garden Margarita', options: [], value: 81_800 }],
    taxes: [{ name: 'INC 8 %', base: 75_741, value: 6_059 }],
    total: 81_800,
    paid: 0,
    check: null,
    subtotal: 81_800,
    tip: 8_180,
    tipRate: 1000,
  }
  const logo = imageOf(16, 2, [0xff, 0x00, 0x0f, 0xf0])

  it('with a logo, the image goes at the top instead of the name', () => {
    for (const format of [f80, f58]) {
      const lines = preBillLines({ ...preBill, logo }, format)
      expect(lines[0]).toEqual({ image: logo })
      expect(lines.filter((l) => 'image' in l)).toHaveLength(1)
      expect(lines.some((l) => 'text' in l && l.text.startsWith('La Spritz'))).toBe(false)
      expect(lines[1]).toMatchObject({ text: 'PRECUENTA', center: true })
    }
  })

  it.each([
    ['without the field', undefined],
    ['with null', null],
  ])('%s, the name is printed large and centered, with no image', (_name, value) => {
    const p = value === undefined ? preBill : { ...preBill, logo: value }
    const lines = preBillLines(p, f80)
    expect(lines.some((l) => 'image' in l)).toBe(false)
    expect(lines[0]).toMatchObject({ text: expect.stringContaining('La Spritz'), large: true })
    expect(lines[0]).toMatchObject({ center: true })
  })

  it('the rest of the pre-bill is identical with and without the logo', () => {
    const withLogo = preBillLines({ ...preBill, logo }, f80)
    const withName = preBillLines(preBill, f80)
    const nameLines = withName.findIndex((l) => 'text' in l && l.text === 'PRECUENTA')
    expect(withLogo.slice(1)).toEqual(withName.slice(nameLines))
  })

  it('a long restaurant name takes several lines; the logo takes just one', () => {
    const long = { ...preBill, restaurant: 'Restaurante Con Un Nombre Larguísimo Para Probar' }
    expect(
      preBillLines(long, f58).findIndex((l) => 'text' in l && l.text === 'PRECUENTA'),
    ).toBeGreaterThan(1)
    expect(preBillLines({ ...long, logo }, f58)[1]).toMatchObject({ text: 'PRECUENTA' })
  })

  it('on paper: the logo is in the bytes and the name is not', () => {
    const paper = (p: PreBill) => readEscpos(escpos(preBillLines(p, f80), f80)).text
    const withLogo = paper({ ...preBill, logo })
    expect(withLogo.split('\n')[0]).toBe('[logo 16×2]')
    expect(withLogo).toContain('PRECUENTA')
    expect(withLogo).not.toContain('Spritz')
    expect(paper(preBill)).toContain('La Spritzz')
  })

  it('as text: [LOGO] at the top', () => {
    expect(
      asText(preBillLines({ ...preBill, logo }, f80), 48)
        .split('\n')[0]
        ?.trim(),
    ).toBe('[LOGO]')
  })
})
