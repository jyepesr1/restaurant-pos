import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRANDS } from './brand'

// New colors from task 1.3c: `lateral` (side and top bar) and `linea` (separators that
// are not controls), in Faro and in each restaurant brand, in light and dark. They are read from
// styles.css, same as contrast.test.ts.

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
const blocks = [...withoutComments.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: (m[1] ?? '').split(',').map((x) => x.trim()),
  text: m[2] ?? '',
  variables: Object.fromEntries(
    [...(m[2] ?? '').matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((v) => [v[1], v[2]]),
  ),
}))

const blockOf = (selector: string) => blocks.find((b) => b.selectors.includes(selector))

function variables(brand: string | null, dark: boolean): Record<string, string> {
  const applying = [
    ':root',
    ...(dark ? [':root.oscuro'] : []),
    ...(brand ? [`:root[data-marca="${brand}"]`] : []),
    ...(brand && dark ? [`:root[data-marca="${brand}"].oscuro`] : []),
  ]
  const v: Record<string, string> = {}
  for (const b of blocks)
    if (b.selectors.some((x) => applying.includes(x))) Object.assign(v, b.variables)
  return v
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

// Faro is the base design (no attribute); the others, those in the code.
const CASES = BRANDS.flatMap(({ brand, name }) =>
  [false, true].map(
    (dark) =>
      [`${name} ${dark ? 'oscuro' : 'claro'}`, brand === 'faro' ? null : brand, dark] as const,
  ),
)

describe('lateral and linea: defined', () => {
  it('Faro defines them in its light base and in the dark one', () => {
    for (const selector of [':root', ':root.oscuro'])
      for (const name of ['lateral', 'linea'])
        expect(blockOf(selector)?.variables[name], `${selector} ${name}`).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it.each(BRANDS.filter((m) => m.brand !== 'faro'))(
    '$name defines them in its own block, by day and by night (does not inherit them from Faro)',
    ({ brand }) => {
      for (const selector of [
        `:root[data-marca="${brand}"]`,
        `:root[data-marca="${brand}"].oscuro`,
      ])
        for (const name of ['lateral', 'linea'])
          expect(blockOf(selector)?.variables[name], `${selector} ${name}`).toMatch(
            /^#[0-9a-f]{6}$/i,
          )
    },
  )

  it('the restaurant brand does not repeat the lateral or linea of Faro (it shows it is another one)', () => {
    for (const { brand } of BRANDS.filter((m) => m.brand !== 'faro'))
      for (const dark of [false, true]) {
        const faro = variables(null, dark)
        const ownItem = variables(brand, dark)
        expect(ownItem.side, `${brand} ${dark} lateral`).not.toBe(faro.lateral)
        expect(ownItem.linea, `${brand} ${dark} linea`).not.toBe(faro.linea)
      }
  })

  it('they are written as six-digit #rrggbb (the contrast test would not read another format)', () => {
    for (const b of blocks)
      for (const name of ['lateral', 'linea']) {
        const lines = [...b.text.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))]
        for (const l of lines)
          expect(l[1]?.trim(), `${b.selectors} ${name}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
  })

  it('Tailwind knows them as color-lateral and color-linea', () => {
    expect(css).toMatch(/--color-lateral:\s*var\(--lateral\)/)
    expect(css).toMatch(/--color-linea:\s*var\(--linea\)/)
  })

  it('every variable a Tailwind color uses is defined in the base (no orphan colors)', () => {
    const base = blockOf(':root')?.variables ?? {}
    const used = [...css.matchAll(/--color-[a-z0-9-]+:\s*var\(--([a-z0-9-]+)\)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(10)
    for (const name of used) expect(base[name as string], name).toBeDefined()
  })
})

describe.each(CASES)('lateral and linea: %s', (_name, brand, dark) => {
  const v = variables(brand, dark)

  it('the text and the soft text read over the lateral (AA, 4.5:1)', () => {
    for (const text of ['texto', 'texto-suave'])
      expect(
        contrast(v[text] as string, v.lateral as string),
        `${text} sobre lateral`,
      ).toBeGreaterThanOrEqual(4.5)
  })

  it('the focus ring shows over the lateral (3:1)', () => {
    expect(contrast(v.foco as string, v.lateral as string)).toBeGreaterThanOrEqual(3)
  })

  it('the brand color (logo, headings) is enough over the lateral (3:1)', () => {
    expect(contrast(v.marca as string, v.lateral as string)).toBeGreaterThanOrEqual(3)
  })

  it('the action tone text over its soft background (active menu option) is readable', () => {
    expect(
      contrast(v['accion-texto'] as string, v['accion-suave'] as string),
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('the control border stands out from the lateral (3:1)', () => {
    expect(contrast(v.borde as string, v.lateral as string)).toBeGreaterThanOrEqual(3)
  })

  it('the linea is a discreet separator: it stands out from the background, but is softer than a control border', () => {
    for (const background of ['fondo', 'superficie', 'lateral']) {
      const c = contrast(v.linea as string, v[background] as string)
      // It is not a control (it does not need 3:1), but it is not invisible nor equal to the
      // background color either.
      expect(v.linea, `linea vs ${background}`).not.toBe(v[background])
      expect(c, `linea sobre ${background}`).toBeGreaterThan(1.03)
      expect(c, `linea sobre ${background}`).toBeLessThan(
        contrast(v.borde as string, v[background] as string),
      )
    }
  })

  it('lateral and fondo are not the same color (the bar separates from the screen, if not with a linea)', () => {
    // Either the color changes or, if it is the same as the surface, the linea does the job.
    expect(v.lateral === v.fondo, 'lateral igual al fondo').toBe(false)
  })
})
