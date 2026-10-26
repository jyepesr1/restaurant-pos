import fc from 'fast-check'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { Sillas } from './LienzoPlano'

// Propiedades de las sillas dibujadas alrededor de una mesa (tarea 1.3c). `Sillas` es pura (sin
// hooks): se llama como función y se leen las posiciones que pone en el estilo de cada silla.
// Semilla fija: determinista. Medidas en píxeles de pantalla (cm del plano por la escala).

const FORMAS = ['round', 'square', 'rectangular', 'bar'] as const
type Forma = (typeof FORMAS)[number]

interface Silla {
  /** Esquinas de la silla ya giradas. */
  esquinas: [number, number][]
  centro: [number, number]
  width: number
  height: number
  giro: number
}

function sillasDe(shape: string, boxWidth: number, boxHeight: number, places: number): Silla[] {
  const arbol = Sillas({
    shape,
    width: boxWidth,
    height: boxHeight,
    places,
    cssClass: 'x',
  }) as ReactElement<{
    children: ReactElement<{ style: Record<string, number | string> }>[]
  }> | null
  if (arbol === null) return []
  return arbol.props.children.map((child) => {
    const { width, height, left, top, transform } = child.props.style as {
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
    return { esquinas, centro: [cx, cy], width: width, height: height, giro }
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
function puntosDe(seat: Silla): [number, number][] {
  const puntos: [number, number][] = []
  const e = seat.esquinas
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = e[i] as [number, number]
    const [x2, y2] = e[(i + 1) % 4] as [number, number]
    for (let t = 0; t <= 8; t++) puntos.push([x1 + ((x2 - x1) * t) / 8, y1 + ((y2 - y1) * t) / 8])
  }
  puntos.push(seat.centro)
  return puntos
}

/** La silla queda fuera de la mesa: el borde puede tocarla, pero ningún punto entra. */
function fueraDeLaMesa(seat: Silla, shape: Forma, boxWidth: number, boxHeight: number): boolean {
  if (shape === 'round') {
    const [rx, ry] = [boxWidth / 2, boxHeight / 2]
    return puntosDe(seat).every(([x, y]) => ((x - rx) / rx) ** 2 + ((y - ry) / ry) ** 2 >= 1 - 1e-9)
  }
  return !seSolapan(seat.esquinas, [
    [0, 0],
    [boxWidth, 0],
    [boxWidth, boxHeight],
    [0, boxHeight],
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
const shape = fc.constantFrom(...FORMAS)
const medida = fc.integer({ min: 16, max: 600 })

describe('sillas: cuenta exacta', () => {
  it('hay exactamente tantas sillas como puestos, para cada forma y medida', () => {
    fc.assert(
      fc.property(
        shape,
        fc.integer({ min: 5, max: 3000 }),
        fc.integer({ min: 5, max: 3000 }),
        fc.integer({ min: 1, max: 100 }),
        (f, boxWidth, boxHeight, places) => {
          expect(sillasDe(f, boxWidth, boxHeight, places)).toHaveLength(places)
        },
      ),
      { ...SEMILLA, numRuns: 1000 },
    )
  })

  it('sin puestos (cero, negativos) no se dibuja nada', () => {
    for (const f of FORMAS)
      for (const places of [0, -1, -100])
        expect(Sillas({ shape: f, width: 80, height: 80, places, cssClass: 'x' })).toBeNull()
  })

  it('una forma desconocida se dibuja como rectangular (lados) y mantiene la cuenta', () => {
    for (let places = 1; places <= 12; places++)
      expect(sillasDe('hexagonal', 120, 80, places)).toHaveLength(places)
  })

  it('las medidas de fábrica de cada forma con su capacidad habitual', () => {
    const factory = [
      ['square', 80, 80, 4],
      ['round', 90, 90, 4],
      ['rectangular', 160, 80, 6],
      ['bar', 50, 50, 1],
    ] as const
    for (const [f, boxWidth, boxHeight, places] of factory) {
      for (const escala of [0.2, 0.25, 0.5, 1, 1.5]) {
        const sillas = sillasDe(f, boxWidth * escala, boxHeight * escala, places)
        expect(sillas, `${f} a ${escala}`).toHaveLength(places)
        expect(encimadas(sillas), `${f} a ${escala}: encimadas`).toEqual([])
        for (const s of sillas)
          expect(
            fueraDeLaMesa(s, f, boxWidth * escala, boxHeight * escala),
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
        shape,
        medida,
        medida,
        fc.integer({ min: 1, max: 100 }),
        (f, boxWidth, boxHeight, places) => {
          for (const seat of sillasDe(f, boxWidth, boxHeight, places))
            expect(
              fueraDeLaMesa(seat, f, boxWidth, boxHeight),
              `${f} ${boxWidth}x${boxHeight} (${places})`,
            ).toBe(true)
        },
      ),
      SEMILLA,
    )
  })

  it('las sillas son siempre números finitos con tamaño positivo', () => {
    fc.assert(
      fc.property(
        shape,
        fc.integer({ min: 5, max: 3000 }),
        fc.integer({ min: 5, max: 3000 }),
        fc.integer({ min: 1, max: 100 }),
        (f, boxWidth, boxHeight, places) => {
          for (const s of sillasDe(f, boxWidth, boxHeight, places)) {
            expect(s.esquinas.flat().every(Number.isFinite)).toBe(true)
            expect(s.width).toBeGreaterThan(0)
            expect(s.height).toBeGreaterThan(0)
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
        fc.constantFrom('square', 'rectangular', 'bar' as const),
        medida,
        medida,
        fc.integer({ min: 1, max: 8 }),
        (f, boxWidth, boxHeight, places) => {
          for (const s of sillasDe(f, boxWidth, boxHeight, places)) {
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
  const largoSilla = (boxWidth: number, boxHeight: number) =>
    Math.max(8, Math.min(26, Math.min(boxWidth, boxHeight) * 0.32))
  const aireSilla = (boxWidth: number, boxHeight: number) =>
    Math.max(3, largoSilla(boxWidth, boxHeight) * 0.18)

  const caben = (f: Forma, boxWidth: number, boxHeight: number) => {
    const length = largoSilla(boxWidth, boxHeight)
    if (f === 'bar') return Math.floor(boxWidth / length)
    if (f === 'round') {
      const dentro = Math.max(boxWidth, boxHeight) / 2 + aireSilla(boxWidth, boxHeight)
      return Math.floor((2 * Math.PI * dentro) / length)
    }
    return 2 * Math.floor(Math.max(boxWidth, boxHeight) / length)
  }

  const medidas = fc.record({
    f: shape,
    width: fc.double({ min: 10, max: 600, noNaN: true }),
    height: fc.double({ min: 10, max: 600, noNaN: true }),
    fraction: fc.double({ min: 0, max: 1, noNaN: true }),
  })

  it('con los puestos que caben en el borde, las sillas no se encimen, para cada forma y medida', () => {
    fc.assert(
      fc.property(medidas, ({ f, width: boxWidth, height: boxHeight, fraction }) => {
        const cupo = caben(f, boxWidth, boxHeight)
        fc.pre(cupo >= 1)
        const places = 1 + Math.floor(fraction * (cupo - 1))
        expect(
          encimadas(sillasDe(f, boxWidth, boxHeight, places)),
          `${f} ${boxWidth}x${boxHeight} (${places} de ${cupo})`,
        ).toEqual([])
      }),
      { ...SEMILLA, numRuns: 2000 },
    )
  })

  it('con el máximo que cabe en el borde, tampoco', () => {
    fc.assert(
      fc.property(medidas, ({ f, width: boxWidth, height: boxHeight }) => {
        const places = Math.min(caben(f, boxWidth, boxHeight), 100)
        fc.pre(places >= 1)
        expect(
          encimadas(sillasDe(f, boxWidth, boxHeight, places)),
          `${f} ${boxWidth}x${boxHeight} (${places})`,
        ).toEqual([])
      }),
      { ...SEMILLA, numRuns: 2000 },
    )
  })

  it('una mesa cuadrada con el cupo de fábrica (4 puestos) no se amontona hasta el 25 % de escala', () => {
    for (const lado of [20, 24, 30, 40, 80, 120])
      for (const f of ['square', 'round'] as const)
        expect(encimadas(sillasDe(f, lado, lado, 4)), `${f} de ${lado} px`).toEqual([])
  })

  it('las sillas de la cabecera no chocan con las del lado largo, con y sin cabeceras', () => {
    for (let places = 4; places <= 10; places++)
      for (const [boxWidth, boxHeight] of [
        [160, 80],
        [120, 60],
        [240, 120],
        [80, 160],
      ] as const)
        expect(
          encimadas(sillasDe('rectangular', boxWidth, boxHeight, places)),
          `${boxWidth}x${boxHeight} con ${places}`,
        ).toEqual([])
  })

  it('las sillas se reparten parejo: ningún lado de una mesa recta pasa de una silla más que el opuesto', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 14 }), (places) => {
        const sillas = sillasDe('rectangular', 400, 100, places)
        const above = sillas.filter(
          (s) => s.centro[1] < 0 && s.centro[0] >= 0 && s.centro[0] <= 400,
        ).length
        const below = sillas.filter((s) => s.centro[1] > 100).length
        expect(Math.abs(above - below)).toBeLessThanOrEqual(1)
      }),
      SEMILLA,
    )
  })
})
