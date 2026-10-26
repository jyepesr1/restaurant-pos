import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRANDS } from './marca'

// Colores nuevos de la tarea 1.3c: `lateral` (barra lateral y superior) y `linea` (separadores que
// no son controles), en Faro y en cada marca de restaurante, en claro y en oscuro. Se leen de
// estilos.css, igual que contraste.test.ts.

const css = readFileSync(new URL('../estilos.css', import.meta.url), 'utf8')
const sinComentarios = css.replace(/\/\*[\s\S]*?\*\//g, '')
const bloques = [...sinComentarios.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => ({
  selectores: (m[1] ?? '').split(',').map((x) => x.trim()),
  text: m[2] ?? '',
  variables: Object.fromEntries(
    [...(m[2] ?? '').matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((v) => [v[1], v[2]]),
  ),
}))

const bloqueDe = (selector: string) => bloques.find((b) => b.selectores.includes(selector))

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

// Faro es el diseño base (sin atributo); las demás, las del código.
const CASOS = BRANDS.flatMap(({ brand, name }) =>
  [false, true].map(
    (dark) =>
      [`${name} ${dark ? 'oscuro' : 'claro'}`, brand === 'faro' ? null : brand, dark] as const,
  ),
)

describe('lateral y linea: definidos', () => {
  it('Faro los define en su base clara y en la oscura', () => {
    for (const selector of [':root', ':root.oscuro'])
      for (const name of ['lateral', 'linea'])
        expect(bloqueDe(selector)?.variables[name], `${selector} ${name}`).toMatch(
          /^#[0-9a-f]{6}$/i,
        )
  })

  it.each(BRANDS.filter((m) => m.brand !== 'faro'))(
    '$nombre los define en su propio bloque, de día y de noche (no los hereda de Faro)',
    ({ brand }) => {
      for (const selector of [
        `:root[data-marca="${brand}"]`,
        `:root[data-marca="${brand}"].oscuro`,
      ])
        for (const name of ['lateral', 'linea'])
          expect(bloqueDe(selector)?.variables[name], `${selector} ${name}`).toMatch(
            /^#[0-9a-f]{6}$/i,
          )
    },
  )

  it('la marca de restaurante no repite el lateral ni la línea de Faro (se nota que es otra)', () => {
    for (const { brand } of BRANDS.filter((m) => m.brand !== 'faro'))
      for (const dark of [false, true]) {
        const faro = variables(null, dark)
        const propia = variables(brand, dark)
        expect(propia.lateral, `${brand} ${dark} lateral`).not.toBe(faro.lateral)
        expect(propia.linea, `${brand} ${dark} linea`).not.toBe(faro.linea)
      }
  })

  it('están escritos como #rrggbb de seis dígitos (otro formato no lo leería la prueba de contraste)', () => {
    for (const b of bloques)
      for (const name of ['lateral', 'linea']) {
        const lines = [...b.text.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))]
        for (const l of lines)
          expect(l[1]?.trim(), `${b.selectores} ${name}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
  })

  it('Tailwind los conoce como color-lateral y color-linea', () => {
    expect(css).toMatch(/--color-lateral:\s*var\(--lateral\)/)
    expect(css).toMatch(/--color-linea:\s*var\(--linea\)/)
  })

  it('cada variable que usa un color de Tailwind está definida en la base (no hay colores huérfanos)', () => {
    const base = bloqueDe(':root')?.variables ?? {}
    const used = [...css.matchAll(/--color-[a-z0-9-]+:\s*var\(--([a-z0-9-]+)\)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(10)
    for (const name of used) expect(base[name as string], name).toBeDefined()
  })
})

describe.each(CASOS)('lateral y linea: %s', (_nombre, brand, dark) => {
  const v = variables(brand, dark)

  it('el texto y el texto suave se leen sobre el lateral (AA, 4,5:1)', () => {
    for (const text of ['texto', 'texto-suave'])
      expect(
        contraste(v[text] as string, v.lateral as string),
        `${text} sobre lateral`,
      ).toBeGreaterThanOrEqual(4.5)
  })

  it('el anillo de foco se ve sobre el lateral (3:1)', () => {
    expect(contraste(v.foco as string, v.lateral as string)).toBeGreaterThanOrEqual(3)
  })

  it('el color de marca (logo, títulos) alcanza sobre el lateral (3:1)', () => {
    expect(contraste(v.marca as string, v.lateral as string)).toBeGreaterThanOrEqual(3)
  })

  it('el texto del tono de acción sobre su fondo suave (opción activa del menú) se lee', () => {
    expect(
      contraste(v['accion-texto'] as string, v['accion-suave'] as string),
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('el borde de los controles se distingue del lateral (3:1)', () => {
    expect(contraste(v.borde as string, v.lateral as string)).toBeGreaterThanOrEqual(3)
  })

  it('la línea es un separador discreto: se distingue del fondo, pero es más suave que un borde de control', () => {
    for (const fondo of ['fondo', 'superficie', 'lateral']) {
      const c = contraste(v.linea as string, v[fondo] as string)
      // No es un control (no pide 3:1), pero tampoco es invisible ni iguala al color del fondo.
      expect(v.linea, `linea vs ${fondo}`).not.toBe(v[fondo])
      expect(c, `linea sobre ${fondo}`).toBeGreaterThan(1.03)
      expect(c, `linea sobre ${fondo}`).toBeLessThan(
        contraste(v.borde as string, v[fondo] as string),
      )
    }
  })

  it('lateral y fondo no son el mismo color (la barra se separa de la pantalla, si no con línea)', () => {
    // O cambia el color o, si es el mismo que la superficie, la línea hace el trabajo.
    expect(v.lateral === v.fondo, 'lateral igual al fondo').toBe(false)
  })
})
