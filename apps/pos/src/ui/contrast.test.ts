import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

// AA contrast (4.5:1) of the design system color pairs, in light and dark mode
// (brief §5, rule 11). Read from styles.css: if someone changes a color, this test measures it.

/** The sheet's `selectors { variables }` blocks (without comments), in order. */
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
const blocks = [...withoutComments.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: (m[1] ?? '').split(',').map((x) => x.trim()),
  variables: Object.fromEntries(
    [...(m[2] ?? '').matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((v) => [v[1], v[2]]),
  ),
}))

/** The colors that apply with that brand and that mode, applying the cascade in sheet order. */
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

const TONES = ['action', 'free', 'progress', 'alert', 'neutral']

describe.each([
  ['Faro light', null, false],
  ['Faro dark', null, true],
  ['La Spritzzería by day', 'la-spritzzeria', false],
  ['La Spritzzería by night', 'la-spritzzeria', true],
] as const)('AA contrast: %s', (_name, brand, dark) => {
  const v = variables(brand, dark)

  it('defines all the colors', () => {
    for (const name of [
      'background',
      'surface',
      'surface-2',
      'border',
      'foreground',
      'muted',
      'focus',
    ])
      expect(v[name], name).toBeDefined()
    for (const tone of TONES)
      for (const variant of ['strong', 'soft', 'text'])
        expect(v[`${tone}-${variant}`], `${tone}-${variant}`).toBeDefined()
  })

  it('text is readable on the background and the surfaces', () => {
    for (const background of ['background', 'surface', 'surface-2'])
      for (const text of ['foreground', 'muted'])
        expect(
          contrast(v[text] as string, v[background] as string),
          `${text} over ${background}`,
        ).toBeGreaterThanOrEqual(4.5)
  })

  it('the controls border stands out from its background (3:1, WCAG 1.4.11)', () => {
    for (const background of ['background', 'surface', 'surface-2'])
      expect(
        contrast(v.border as string, v[background] as string),
        `border over ${background}`,
      ).toBeGreaterThanOrEqual(3)
  })

  it('the focus ring is visible on any background (3:1)', () => {
    for (const background of ['background', 'surface', 'surface-2'])
      expect(contrast(v.focus as string, v[background] as string)).toBeGreaterThanOrEqual(3)
  })

  it('the brand color is enough for large titles (3:1)', () => {
    expect(contrast(v.brand as string, v.background as string)).toBeGreaterThanOrEqual(3)
  })

  it('the notice (surface text on a neutral background) is readable', () => {
    expect(contrast(v.surface as string, v['neutral-text'] as string)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(TONES)('%s: white text on the strong tone and its text on the soft one', (tone) => {
    expect(contrast('#ffffff', v[`${tone}-strong`] as string)).toBeGreaterThanOrEqual(4.5)
    expect(
      contrast(v[`${tone}-text`] as string, v[`${tone}-soft`] as string),
    ).toBeGreaterThanOrEqual(4.5)
  })
})

describe('status colors do not change with the brand (ADR-014)', () => {
  const STATUS = ['free', 'progress', 'alert'].flatMap((t) =>
    ['strong', 'soft', 'text'].map((n) => `${t}-${n}`),
  )
  it.each([false, true])('La Spritzzería has the Faro ones (dark: %s)', (dark) => {
    const faro = variables(null, dark)
    const brand = variables('la-spritzzeria', dark)
    for (const name of STATUS) expect(brand[name], name).toBe(faro[name])
  })

  it.each([
    [null, false],
    [null, true],
    ['la-spritzzeria', false],
    ['la-spritzzeria', true],
  ] as const)('text and soft text are readable on the sidebar (%s, dark: %s)', (m, dark) => {
    const v = variables(m, dark)
    expect(contrast(v.foreground as string, v.sidebar as string)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(v.muted as string, v.sidebar as string)).toBeGreaterThanOrEqual(4.5)
  })
})
