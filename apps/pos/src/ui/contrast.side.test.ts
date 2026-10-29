import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRANDS } from './brand'

// New colors from task 1.3c: `sidebar` (side and top bar) and `divider` (separators that
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
    ...(dark ? [':root.dark'] : []),
    ...(brand ? [`:root[data-brand="${brand}"]`] : []),
    ...(brand && dark ? [`:root[data-brand="${brand}"].dark`] : []),
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
      [`${name} ${dark ? 'dark' : 'light'}`, brand === 'faro' ? null : brand, dark] as const,
  ),
)

describe('sidebar and divider: defined', () => {
  it('Faro defines them in its light base and in the dark one', () => {
    for (const selector of [':root', ':root.dark'])
      for (const name of ['sidebar', 'divider'])
        expect(blockOf(selector)?.variables[name], `${selector} ${name}`).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it.each(BRANDS.filter((m) => m.brand !== 'faro'))(
    '$name defines them in its own block, by day and by night (does not inherit them from Faro)',
    ({ brand }) => {
      for (const selector of [`:root[data-brand="${brand}"]`, `:root[data-brand="${brand}"].dark`])
        for (const name of ['sidebar', 'divider'])
          expect(blockOf(selector)?.variables[name], `${selector} ${name}`).toMatch(
            /^#[0-9a-f]{6}$/i,
          )
    },
  )

  it('the restaurant brand does not repeat the sidebar or divider of Faro (it shows it is another one)', () => {
    for (const { brand } of BRANDS.filter((m) => m.brand !== 'faro'))
      for (const dark of [false, true]) {
        const faro = variables(null, dark)
        const ownItem = variables(brand, dark)
        expect(ownItem.sidebar, `${brand} ${dark} sidebar`).not.toBe(faro.sidebar)
        expect(ownItem.divider, `${brand} ${dark} divider`).not.toBe(faro.divider)
      }
  })

  it('they are written as six-digit #rrggbb (the contrast test would not read another format)', () => {
    for (const b of blocks)
      for (const name of ['sidebar', 'divider']) {
        const lines = [...b.text.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))]
        for (const l of lines)
          expect(l[1]?.trim(), `${b.selectors} ${name}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
  })

  it('Tailwind knows them as color-sidebar and color-divider', () => {
    expect(css).toMatch(/--color-sidebar:\s*var\(--sidebar\)/)
    expect(css).toMatch(/--color-divider:\s*var\(--divider\)/)
  })

  it('every variable a Tailwind color uses is defined in the base (no orphan colors)', () => {
    const base = blockOf(':root')?.variables ?? {}
    const used = [...css.matchAll(/--color-[a-z0-9-]+:\s*var\(--([a-z0-9-]+)\)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(10)
    for (const name of used) expect(base[name as string], name).toBeDefined()
  })
})

describe.each(CASES)('sidebar and divider: %s', (_name, brand, dark) => {
  const v = variables(brand, dark)

  it('the text and the soft text read over the sidebar (AA, 4.5:1)', () => {
    for (const text of ['foreground', 'muted'])
      expect(
        contrast(v[text] as string, v.sidebar as string),
        `${text} over sidebar`,
      ).toBeGreaterThanOrEqual(4.5)
  })

  it('the focus ring shows over the sidebar (3:1)', () => {
    expect(contrast(v.focus as string, v.sidebar as string)).toBeGreaterThanOrEqual(3)
  })

  it('the brand color (logo, headings) is enough over the sidebar (3:1)', () => {
    expect(contrast(v.brand as string, v.sidebar as string)).toBeGreaterThanOrEqual(3)
  })

  it('the action tone text over its soft background (active menu option) is readable', () => {
    expect(contrast(v['action-text'] as string, v['action-soft'] as string)).toBeGreaterThanOrEqual(
      4.5,
    )
  })

  it('the control border stands out from the sidebar (3:1)', () => {
    expect(contrast(v.border as string, v.sidebar as string)).toBeGreaterThanOrEqual(3)
  })

  it('the divider is a discreet separator: it stands out from the background, but is softer than a control border', () => {
    for (const background of ['background', 'surface', 'sidebar']) {
      const c = contrast(v.divider as string, v[background] as string)
      // It is not a control (it does not need 3:1), but it is not invisible nor equal to the
      // background color either.
      expect(v.divider, `divider vs ${background}`).not.toBe(v[background])
      expect(c, `divider over ${background}`).toBeGreaterThan(1.03)
      expect(c, `divider over ${background}`).toBeLessThan(
        contrast(v.border as string, v[background] as string),
      )
    }
  })

  it('sidebar and background are not the same color (the bar separates from the screen, if not with a divider)', () => {
    // Either the color changes or, if it is the same as the surface, the divider does the job.
    expect(v.sidebar === v.background, 'sidebar equal to background').toBe(false)
  })
})
