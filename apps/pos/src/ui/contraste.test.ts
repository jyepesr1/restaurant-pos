import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../estilos.css', import.meta.url), 'utf8')

// Contraste AA (4,5:1) de las parejas de color del design system, en claro y en oscuro
// (brief §5, regla 11). Se leen de estilos.css: si alguien cambia un color, esta prueba lo mide.

/** Bloques `selectores { variables }` de la hoja (sin comentarios), en orden. */
const sinComentarios = css.replace(/\/\*[\s\S]*?\*\//g, '')
const bloques = [...sinComentarios.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => ({
  selectores: (m[1] ?? '').split(',').map((x) => x.trim()),
  variables: Object.fromEntries(
    [...(m[2] ?? '').matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((v) => [v[1], v[2]]),
  ),
}))

/** Los colores que quedan con esa marca y ese modo, aplicando la cascada en el orden de la hoja. */
function variables(brand: string | null, dark: boolean): Record<string, string> {
  const aplican = [
    ':root',
    ...(dark ? [':root.oscuro'] : []),
    ...(brand ? [`:root[data-marca="${brand}"]`] : []),
    ...(brand && dark ? [`:root[data-marca="${brand}"].oscuro`] : []),
  ]
  const v: Record<string, string> = {}
  for (const b of bloques)
    if (b.selectores.some((x) => aplican.includes(x))) Object.assign(v, b.variables)
  return v
}

function luminancia(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

const TONOS = ['accion', 'libre', 'proceso', 'alerta', 'neutro']

describe.each([
  ['Faro claro', null, false],
  ['Faro oscuro', null, true],
  ['La Spritzzería de día', 'la-spritzzeria', false],
  ['La Spritzzería de noche', 'la-spritzzeria', true],
] as const)('contraste AA: %s', (_nombre, brand, dark) => {
  const v = variables(brand, dark)

  it('define todos los colores', () => {
    for (const name of [
      'fondo',
      'superficie',
      'superficie-2',
      'borde',
      'texto',
      'texto-suave',
      'foco',
    ])
      expect(v[name], name).toBeDefined()
    for (const tono of TONOS)
      for (const variant of ['fuerte', 'suave', 'texto'])
        expect(v[`${tono}-${variant}`], `${tono}-${variant}`).toBeDefined()
  })

  it('el texto se lee sobre el fondo y las superficies', () => {
    for (const fondo of ['fondo', 'superficie', 'superficie-2'])
      for (const text of ['texto', 'texto-suave'])
        expect(
          contraste(v[text] as string, v[fondo] as string),
          `${text} sobre ${fondo}`,
        ).toBeGreaterThanOrEqual(4.5)
  })

  it('el borde de los controles se distingue de su fondo (3:1, WCAG 1.4.11)', () => {
    for (const fondo of ['fondo', 'superficie', 'superficie-2'])
      expect(
        contraste(v.borde as string, v[fondo] as string),
        `borde sobre ${fondo}`,
      ).toBeGreaterThanOrEqual(3)
  })

  it('el anillo de foco se ve sobre cualquier fondo (3:1)', () => {
    for (const fondo of ['fondo', 'superficie', 'superficie-2'])
      expect(contraste(v.foco as string, v[fondo] as string)).toBeGreaterThanOrEqual(3)
  })

  it('el color de marca alcanza para títulos grandes (3:1)', () => {
    expect(contraste(v.marca as string, v.fondo as string)).toBeGreaterThanOrEqual(3)
  })

  it('el aviso (texto de superficie sobre fondo neutro) se lee', () => {
    expect(contraste(v.superficie as string, v['neutro-texto'] as string)).toBeGreaterThanOrEqual(
      4.5,
    )
  })

  it.each(TONOS)('%s: texto blanco sobre el tono fuerte y su texto sobre el suave', (tono) => {
    expect(contraste('#ffffff', v[`${tono}-fuerte`] as string)).toBeGreaterThanOrEqual(4.5)
    expect(
      contraste(v[`${tono}-texto`] as string, v[`${tono}-suave`] as string),
    ).toBeGreaterThanOrEqual(4.5)
  })
})

describe('los colores de estado no cambian con la marca (ADR-014)', () => {
  const ESTADO = ['libre', 'proceso', 'alerta'].flatMap((t) =>
    ['fuerte', 'suave', 'texto'].map((n) => `${t}-${n}`),
  )
  it.each([false, true])('La Spritzzería tiene los de Faro (oscuro: %s)', (dark) => {
    const faro = variables(null, dark)
    const brand = variables('la-spritzzeria', dark)
    for (const name of ESTADO) expect(brand[name], name).toBe(faro[name])
  })

  it.each([
    [null, false],
    [null, true],
    ['la-spritzzeria', false],
    ['la-spritzzeria', true],
  ] as const)('texto y texto suave se leen sobre la barra lateral (%s, oscuro: %s)', (m, dark) => {
    const v = variables(m, dark)
    expect(contraste(v.texto as string, v.lateral as string)).toBeGreaterThanOrEqual(4.5)
    expect(contraste(v['texto-suave'] as string, v.lateral as string)).toBeGreaterThanOrEqual(4.5)
  })
})
