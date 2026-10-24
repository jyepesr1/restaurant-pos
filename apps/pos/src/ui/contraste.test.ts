import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../estilos.css', import.meta.url), 'utf8')

// Contraste AA (4,5:1) de las parejas de color del design system, en claro y en oscuro
// (brief §5, regla 11). Se leen de estilos.css: si alguien cambia un color, esta prueba lo mide.

function variables(selector: string): Record<string, string> {
  const bloque = css.split(`${selector} {`)[1]?.split('}')[0] ?? ''
  return Object.fromEntries(
    [...bloque.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]),
  )
}

function luminancia(hex: string): number {
  const canal = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * canal(1) + 0.7152 * canal(3) + 0.0722 * canal(5)
}

function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

const TONOS = ['accion', 'libre', 'proceso', 'alerta', 'neutro']

describe.each([
  ['claro', ':root'],
  ['oscuro', ':root.oscuro'],
])('contraste AA en modo %s', (_modo, selector) => {
  const v = variables(selector)

  it('define todos los colores', () => {
    for (const nombre of [
      'fondo',
      'superficie',
      'superficie-2',
      'borde',
      'texto',
      'texto-suave',
      'foco',
    ])
      expect(v[nombre], nombre).toBeDefined()
    for (const tono of TONOS)
      for (const variante of ['fuerte', 'suave', 'texto'])
        expect(v[`${tono}-${variante}`], `${tono}-${variante}`).toBeDefined()
  })

  it('el texto se lee sobre el fondo y las superficies', () => {
    for (const fondo of ['fondo', 'superficie', 'superficie-2'])
      for (const texto of ['texto', 'texto-suave'])
        expect(
          contraste(v[texto] as string, v[fondo] as string),
          `${texto} sobre ${fondo}`,
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
