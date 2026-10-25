import fc from 'fast-check'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { Sillas } from './LienzoPlano'

// Propiedades de las sillas dibujadas alrededor de una mesa (tarea 1.3c). `Sillas` es pura (sin
// hooks): se llama como función y se leen las posiciones que pone en el estilo de cada silla.
// Semilla fija: determinista. Medidas en píxeles de pantalla (cm del plano por la escala).

const FORMAS = ['redonda', 'cuadrada', 'rectangular', 'barra'] as const
type Forma = (typeof FORMAS)[number]

interface Silla {
  /** Esquinas de la silla ya giradas. */
  esquinas: [number, number][]
  centro: [number, number]
  ancho: number
  alto: number
  giro: number
}

function sillasDe(forma: string, ancho: number, alto: number, puestos: number): Silla[] {
  const arbol = Sillas({ forma, ancho, alto, puestos, clase: 'x' }) as ReactElement<{
    children: ReactElement<{ style: Record<string, number | string> }>[]
  }> | null
  if (arbol === null) return []
  return arbol.props.children.map((hijo) => {
    const { width, height, left, top, transform } = hijo.props.style as {
      width: number
      height: number
      left: number
      top: number
      transform: string
    }
    const giro = Number(/rotate\((-?[\d.e+-]+)deg\)/.exec(transform)?.[1])
    const cx = left + width / 2
    const cy = top + height / 2
    const r = (giro * Math.PI) / 180
    const esquinas = (
      [
        [-width / 2, -height / 2],
        [width / 2, -height / 2],
        [width / 2, height / 2],
        [-width / 2, height / 2],
      ] as const
    ).map(
      ([x, y]) =>
        [cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)] as [
          number,
          number,
        ],
    )
    return { esquinas, centro: [cx, cy], ancho: width, alto: height, giro }
  })
}

const TOLERANCIA = 1e-6

/** Teorema del eje separador entre dos polígonos convexos: se tocan por el borde sin problema. */
function seSolapan(a: [number, number][], b: [number, number][]): boolean {
  for (const poligono of [a, b]) {
    for (let i = 0; i < poligono.length; i++) {
      const [x1, y1] = poligono[i] as [number, number]
      const [x2, y2] = poligono[(i + 1) % poligono.length] as [number, number]
      const nx = y2 - y1
      const ny = x1 - x2
      const proyectar = (p: [number, number][]) => {
        const v = p.map(([x, y]) => x * nx + y * ny)
        return [Math.min(...v), Math.max(...v)] as const
      }
      const [minA, maxA] = proyectar(a)
      const [minB, maxB] = proyectar(b)
      const norma = Math.hypot(nx, ny)
      if (maxA <= minB + TOLERANCIA * norma || maxB <= minA + TOLERANCIA * norma) return false
    }
  }
  return true
}

/** Puntos a lo largo del borde de la silla (esquinas y puntos intermedios). */
function puntosDe(silla: Silla): [number, number][] {
  const puntos: [number, number][] = []
  const e = silla.esquinas
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = e[i] as [number, number]
    const [x2, y2] = e[(i + 1) % 4] as [number, number]
    for (let t = 0; t <= 8; t++) puntos.push([x1 + ((x2 - x1) * t) / 8, y1 + ((y2 - y1) * t) / 8])
  }
  puntos.push(silla.centro)
  return puntos
}

/** La silla queda fuera de la mesa: el borde puede tocarla, pero ningún punto entra. */
function fueraDeLaMesa(silla: Silla, forma: Forma, ancho: number, alto: number): boolean {
  if (forma === 'redonda') {
    const [rx, ry] = [ancho / 2, alto / 2]
    return puntosDe(silla).every(
      ([x, y]) => ((x - rx) / rx) ** 2 + ((y - ry) / ry) ** 2 >= 1 - 1e-9,
    )
  }
  return !seSolapan(silla.esquinas, [
    [0, 0],
    [ancho, 0],
    [ancho, alto],
    [0, alto],
  ])
}

const encimadas = (sillas: Silla[]) => {
  const pares: [number, number][] = []
  for (let i = 0; i < sillas.length; i++)
    for (let j = i + 1; j < sillas.length; j++)
      if (seSolapan((sillas[i] as Silla).esquinas, (sillas[j] as Silla).esquinas))
        pares.push([i, j])
  return pares
}

const SEMILLA = { seed: 20261025, numRuns: 400 }
const forma = fc.constantFrom(...FORMAS)
const medida = fc.integer({ min: 16, max: 600 })

describe('sillas: cuenta exacta', () => {
  it('hay exactamente tantas sillas como puestos, para cada forma y medida', () => {
    fc.assert(
      fc.property(
        forma,
        fc.integer({ min: 5, max: 3000 }),
        fc.integer({ min: 5, max: 3000 }),
        fc.integer({ min: 1, max: 100 }),
        (f, ancho, alto, puestos) => {
          expect(sillasDe(f, ancho, alto, puestos)).toHaveLength(puestos)
        },
      ),
      { ...SEMILLA, numRuns: 1000 },
    )
  })

  it('sin puestos (cero, negativos) no se dibuja nada', () => {
    for (const f of FORMAS)
      for (const puestos of [0, -1, -100])
        expect(Sillas({ forma: f, ancho: 80, alto: 80, puestos, clase: 'x' })).toBeNull()
  })

  it('una forma desconocida se dibuja como rectangular (lados) y mantiene la cuenta', () => {
    for (let puestos = 1; puestos <= 12; puestos++)
      expect(sillasDe('hexagonal', 120, 80, puestos)).toHaveLength(puestos)
  })

  it('las medidas de fábrica de cada forma con su capacidad habitual', () => {
    const fabrica = [
      ['cuadrada', 80, 80, 4],
      ['redonda', 90, 90, 4],
      ['rectangular', 160, 80, 6],
      ['barra', 50, 50, 1],
    ] as const
    for (const [f, ancho, alto, puestos] of fabrica) {
      for (const escala of [0.2, 0.25, 0.5, 1, 1.5]) {
        const sillas = sillasDe(f, ancho * escala, alto * escala, puestos)
        expect(sillas, `${f} a ${escala}`).toHaveLength(puestos)
        expect(encimadas(sillas), `${f} a ${escala}: encimadas`).toEqual([])
        for (const s of sillas)
          expect(
            fueraDeLaMesa(s, f, ancho * escala, alto * escala),
            `${f} a ${escala}: dentro`,
          ).toBe(true)
      }
    }
  })
})

describe('sillas: nunca dentro de la mesa', () => {
  it('ninguna silla entra en la mesa, para cada forma, medida y cantidad de puestos', () => {
    fc.assert(
      fc.property(
        forma,
        medida,
        medida,
        fc.integer({ min: 1, max: 100 }),
        (f, ancho, alto, puestos) => {
          for (const silla of sillasDe(f, ancho, alto, puestos))
            expect(fueraDeLaMesa(silla, f, ancho, alto), `${f} ${ancho}x${alto} (${puestos})`).toBe(
              true,
            )
        },
      ),
      SEMILLA,
    )
  })

  it('las sillas son siempre números finitos con tamaño positivo', () => {
    fc.assert(
      fc.property(
        forma,
        fc.integer({ min: 5, max: 3000 }),
        fc.integer({ min: 5, max: 3000 }),
        fc.integer({ min: 1, max: 100 }),
        (f, ancho, alto, puestos) => {
          for (const s of sillasDe(f, ancho, alto, puestos)) {
            expect(s.esquinas.flat().every(Number.isFinite)).toBe(true)
            expect(s.ancho).toBeGreaterThan(0)
            expect(s.alto).toBeGreaterThan(0)
            expect(Number.isFinite(s.giro)).toBe(true)
          }
        },
      ),
      SEMILLA,
    )
  })

  it('las sillas miran a la mesa: su lado largo queda paralelo al borde más cercano (cuadradas y barra)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('cuadrada', 'rectangular', 'barra' as const),
        medida,
        medida,
        fc.integer({ min: 1, max: 8 }),
        (f, ancho, alto, puestos) => {
          for (const s of sillasDe(f, ancho, alto, puestos)) {
            // Giros en múltiplos de 90: nunca quedan en diagonal respecto a una mesa recta.
            expect(Math.abs(s.giro) % 90).toBeCloseTo(0, 6)
          }
        },
      ),
      SEMILLA,
    )
  })
})

describe('sillas: sin encimarse', () => {
  // Cuántas sillas caben en el borde de la mesa según lo que mide cada silla. La silla mide un
  // tercio del lado corto de la mesa, entre 8 y 26 px (es el criterio de LienzoPlano). Con más
  // puestos de los que caben (12 en una mesa de 80 cm) se amontonan sin remedio: no hay dibujo que
  // lo arregle, y no es lo que se mide aquí.
  const largoSilla = (ancho: number, alto: number) =>
    Math.max(8, Math.min(26, Math.min(ancho, alto) * 0.32))
  const aireSilla = (ancho: number, alto: number) => Math.max(3, largoSilla(ancho, alto) * 0.18)

  const caben = (f: Forma, ancho: number, alto: number) => {
    const largo = largoSilla(ancho, alto)
    if (f === 'barra') return Math.floor(ancho / largo)
    if (f === 'redonda') {
      const dentro = Math.max(ancho, alto) / 2 + aireSilla(ancho, alto)
      return Math.floor((2 * Math.PI * dentro) / largo)
    }
    return 2 * Math.floor(Math.max(ancho, alto) / largo)
  }

  const medidas = fc.record({
    f: forma,
    ancho: fc.double({ min: 10, max: 600, noNaN: true }),
    alto: fc.double({ min: 10, max: 600, noNaN: true }),
    fraccion: fc.double({ min: 0, max: 1, noNaN: true }),
  })

  it('con los puestos que caben en el borde, las sillas no se encimen, para cada forma y medida', () => {
    fc.assert(
      fc.property(medidas, ({ f, ancho, alto, fraccion }) => {
        const cupo = caben(f, ancho, alto)
        fc.pre(cupo >= 1)
        const puestos = 1 + Math.floor(fraccion * (cupo - 1))
        expect(
          encimadas(sillasDe(f, ancho, alto, puestos)),
          `${f} ${ancho}x${alto} (${puestos} de ${cupo})`,
        ).toEqual([])
      }),
      { ...SEMILLA, numRuns: 2000 },
    )
  })

  it('con el máximo que cabe en el borde, tampoco', () => {
    fc.assert(
      fc.property(medidas, ({ f, ancho, alto }) => {
        const puestos = Math.min(caben(f, ancho, alto), 100)
        fc.pre(puestos >= 1)
        expect(
          encimadas(sillasDe(f, ancho, alto, puestos)),
          `${f} ${ancho}x${alto} (${puestos})`,
        ).toEqual([])
      }),
      { ...SEMILLA, numRuns: 2000 },
    )
  })

  it('una mesa cuadrada con el cupo de fábrica (4 puestos) no se amontona hasta el 25 % de escala', () => {
    for (const lado of [20, 24, 30, 40, 80, 120])
      for (const f of ['cuadrada', 'redonda'] as const)
        expect(encimadas(sillasDe(f, lado, lado, 4)), `${f} de ${lado} px`).toEqual([])
  })

  it('las sillas de la cabecera no chocan con las del lado largo, con y sin cabeceras', () => {
    for (let puestos = 4; puestos <= 10; puestos++)
      for (const [ancho, alto] of [
        [160, 80],
        [120, 60],
        [240, 120],
        [80, 160],
      ] as const)
        expect(
          encimadas(sillasDe('rectangular', ancho, alto, puestos)),
          `${ancho}x${alto} con ${puestos}`,
        ).toEqual([])
  })

  it('las sillas se reparten parejo: ningún lado de una mesa recta pasa de una silla más que el opuesto', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 14 }), (puestos) => {
        const sillas = sillasDe('rectangular', 400, 100, puestos)
        const arriba = sillas.filter(
          (s) => s.centro[1] < 0 && s.centro[0] >= 0 && s.centro[0] <= 400,
        ).length
        const abajo = sillas.filter((s) => s.centro[1] > 100).length
        expect(Math.abs(arriba - abajo)).toBeLessThanOrEqual(1)
      }),
      SEMILLA,
    )
  })
})
