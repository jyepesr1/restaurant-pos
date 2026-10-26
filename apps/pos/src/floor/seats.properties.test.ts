import fc from 'fast-check'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { Seats } from './FloorPlanCanvas'

// Properties of the seats drawn around a table (task 1.3c). `Seats` is pure (no
// hooks): it is called as a function and the positions it sets in each seat's style are read.
// Fixed seed: deterministic. Sizes in screen pixels (floor plan cm times the scale).

const SHAPES = ['round', 'square', 'rectangular', 'bar'] as const
type Shape = (typeof SHAPES)[number]

interface Seat {
  /** Seat corners, already rotated. */
  corners: [number, number][]
  center: [number, number]
  width: number
  height: number
  angle: number
}

function seatsOf(shape: string, boxWidth: number, boxHeight: number, places: number): Seat[] {
  const tree = Seats({
    shape,
    width: boxWidth,
    height: boxHeight,
    places,
    cssClass: 'x',
  }) as ReactElement<{
    children: ReactElement<{ style: Record<string, number | string> }>[]
  }> | null
  if (tree === null) return []
  return tree.props.children.map((child) => {
    const { width, height, left, top, transform } = child.props.style as {
      width: number
      height: number
      left: number
      top: number
      transform: string
    }
    const angle = Number(/rotate\((-?[\d.e+-]+)deg\)/.exec(transform)?.[1])
    const cx = left + width / 2
    const cy = top + height / 2
    const r = (angle * Math.PI) / 180
    const corners = (
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
    return { corners, center: [cx, cy], width: width, height: height, angle }
  })
}

const TOLERANCE = 1e-6

/** Separating axis theorem between two convex polygons: touching at the edge is fine. */
function overlap(a: [number, number][], b: [number, number][]): boolean {
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i++) {
      const [x1, y1] = polygon[i] as [number, number]
      const [x2, y2] = polygon[(i + 1) % polygon.length] as [number, number]
      const nx = y2 - y1
      const ny = x1 - x2
      const project = (p: [number, number][]) => {
        const v = p.map(([x, y]) => x * nx + y * ny)
        return [Math.min(...v), Math.max(...v)] as const
      }
      const [minA, maxA] = project(a)
      const [minB, maxB] = project(b)
      const norm = Math.hypot(nx, ny)
      if (maxA <= minB + TOLERANCE * norm || maxB <= minA + TOLERANCE * norm) return false
    }
  }
  return true
}

/** Points along the seat's edge (corners and midpoints). */
function pointsOf(seat: Seat): [number, number][] {
  const points: [number, number][] = []
  const e = seat.corners
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = e[i] as [number, number]
    const [x2, y2] = e[(i + 1) % 4] as [number, number]
    for (let t = 0; t <= 8; t++) points.push([x1 + ((x2 - x1) * t) / 8, y1 + ((y2 - y1) * t) / 8])
  }
  points.push(seat.center)
  return points
}

/** The seat stays outside the table: the edge may touch it, but no point gets in. */
function offTheTable(seat: Seat, shape: Shape, boxWidth: number, boxHeight: number): boolean {
  if (shape === 'round') {
    const [rx, ry] = [boxWidth / 2, boxHeight / 2]
    return pointsOf(seat).every(([x, y]) => ((x - rx) / rx) ** 2 + ((y - ry) / ry) ** 2 >= 1 - 1e-9)
  }
  return !overlap(seat.corners, [
    [0, 0],
    [boxWidth, 0],
    [boxWidth, boxHeight],
    [0, boxHeight],
  ])
}

const overlapping = (seats: Seat[]) => {
  const pairs: [number, number][] = []
  for (let i = 0; i < seats.length; i++)
    for (let j = i + 1; j < seats.length; j++)
      if (overlap((seats[i] as Seat).corners, (seats[j] as Seat).corners)) pairs.push([i, j])
  return pairs
}

const SEED = { seed: 20261025, numRuns: 400 }
const shape = fc.constantFrom(...SHAPES)
const size = fc.integer({ min: 16, max: 600 })

describe('seats: exact count', () => {
  it('there are exactly as many seats as places, for every shape and size', () => {
    fc.assert(
      fc.property(
        shape,
        fc.integer({ min: 5, max: 3000 }),
        fc.integer({ min: 5, max: 3000 }),
        fc.integer({ min: 1, max: 100 }),
        (f, boxWidth, boxHeight, places) => {
          expect(seatsOf(f, boxWidth, boxHeight, places)).toHaveLength(places)
        },
      ),
      { ...SEED, numRuns: 1000 },
    )
  })

  it('with no places (zero, negative) nothing is drawn', () => {
    for (const f of SHAPES)
      for (const places of [0, -1, -100])
        expect(Seats({ shape: f, width: 80, height: 80, places, cssClass: 'x' })).toBeNull()
  })

  it('an unknown shape is drawn as rectangular (sides) and keeps the count', () => {
    for (let places = 1; places <= 12; places++)
      expect(seatsOf('hexagonal', 120, 80, places)).toHaveLength(places)
  })

  it('the factory sizes of each shape with its usual capacity', () => {
    const factory = [
      ['square', 80, 80, 4],
      ['round', 90, 90, 4],
      ['rectangular', 160, 80, 6],
      ['bar', 50, 50, 1],
    ] as const
    for (const [f, boxWidth, boxHeight, places] of factory) {
      for (const scale of [0.2, 0.25, 0.5, 1, 1.5]) {
        const seats = seatsOf(f, boxWidth * scale, boxHeight * scale, places)
        expect(seats, `${f} a ${scale}`).toHaveLength(places)
        expect(overlapping(seats), `${f} a ${scale}: encimadas`).toEqual([])
        for (const s of seats)
          expect(
            offTheTable(s, f, boxWidth * scale, boxHeight * scale),
            `${f} a ${scale}: dentro`,
          ).toBe(true)
      }
    }
  })
})

describe('seats: never inside the table', () => {
  it('no seat gets into the table, for every shape, size and number of places', () => {
    fc.assert(
      fc.property(
        shape,
        size,
        size,
        fc.integer({ min: 1, max: 100 }),
        (f, boxWidth, boxHeight, places) => {
          for (const seat of seatsOf(f, boxWidth, boxHeight, places))
            expect(
              offTheTable(seat, f, boxWidth, boxHeight),
              `${f} ${boxWidth}x${boxHeight} (${places})`,
            ).toBe(true)
        },
      ),
      SEED,
    )
  })

  it('seats are always finite numbers with a positive size', () => {
    fc.assert(
      fc.property(
        shape,
        fc.integer({ min: 5, max: 3000 }),
        fc.integer({ min: 5, max: 3000 }),
        fc.integer({ min: 1, max: 100 }),
        (f, boxWidth, boxHeight, places) => {
          for (const s of seatsOf(f, boxWidth, boxHeight, places)) {
            expect(s.corners.flat().every(Number.isFinite)).toBe(true)
            expect(s.width).toBeGreaterThan(0)
            expect(s.height).toBeGreaterThan(0)
            expect(Number.isFinite(s.angle)).toBe(true)
          }
        },
      ),
      SEED,
    )
  })

  it('seats face the table: their long side stays parallel to the nearest edge (square and bar)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('square', 'rectangular', 'bar' as const),
        size,
        size,
        fc.integer({ min: 1, max: 8 }),
        (f, boxWidth, boxHeight, places) => {
          for (const s of seatsOf(f, boxWidth, boxHeight, places)) {
            // Rotations in multiples of 90: never diagonal relative to a straight table.
            expect(Math.abs(s.angle) % 90).toBeCloseTo(0, 6)
          }
        },
      ),
      SEED,
    )
  })
})

describe('seats: no overlapping', () => {
  // How many seats fit on the table's edge given each seat's size. A seat measures a
  // third of the table's short side, between 8 and 26 px (FloorPlanCanvas's criterion). With more
  // places than fit (12 on an 80 cm table) they crowd together hopelessly: no drawing can
  // fix it, and that is not what is measured here.
  const seatLength = (boxWidth: number, boxHeight: number) =>
    Math.max(8, Math.min(26, Math.min(boxWidth, boxHeight) * 0.32))
  const seatGap = (boxWidth: number, boxHeight: number) =>
    Math.max(3, seatLength(boxWidth, boxHeight) * 0.18)

  const fits = (f: Shape, boxWidth: number, boxHeight: number) => {
    const length = seatLength(boxWidth, boxHeight)
    if (f === 'bar') return Math.floor(boxWidth / length)
    if (f === 'round') {
      const inside = Math.max(boxWidth, boxHeight) / 2 + seatGap(boxWidth, boxHeight)
      return Math.floor((2 * Math.PI * inside) / length)
    }
    return 2 * Math.floor(Math.max(boxWidth, boxHeight) / length)
  }

  const sizes = fc.record({
    f: shape,
    width: fc.double({ min: 10, max: 600, noNaN: true }),
    height: fc.double({ min: 10, max: 600, noNaN: true }),
    fraction: fc.double({ min: 0, max: 1, noNaN: true }),
  })

  it('with the places that fit on the edge, the seats do not overlap, for every shape and size', () => {
    fc.assert(
      fc.property(sizes, ({ f, width: boxWidth, height: boxHeight, fraction }) => {
        const fit = fits(f, boxWidth, boxHeight)
        fc.pre(fit >= 1)
        const places = 1 + Math.floor(fraction * (fit - 1))
        expect(
          overlapping(seatsOf(f, boxWidth, boxHeight, places)),
          `${f} ${boxWidth}x${boxHeight} (${places} de ${fit})`,
        ).toEqual([])
      }),
      { ...SEED, numRuns: 2000 },
    )
  })

  it('with the maximum that fits on the edge, neither', () => {
    fc.assert(
      fc.property(sizes, ({ f, width: boxWidth, height: boxHeight }) => {
        const places = Math.min(fits(f, boxWidth, boxHeight), 100)
        fc.pre(places >= 1)
        expect(
          overlapping(seatsOf(f, boxWidth, boxHeight, places)),
          `${f} ${boxWidth}x${boxHeight} (${places})`,
        ).toEqual([])
      }),
      { ...SEED, numRuns: 2000 },
    )
  })

  it('a square table with the factory capacity (4 places) does not crowd down to 25 % scale', () => {
    for (const side of [20, 24, 30, 40, 80, 120])
      for (const f of ['square', 'round'] as const)
        expect(overlapping(seatsOf(f, side, side, 4)), `${f} de ${side} px`).toEqual([])
  })

  it('the head seats do not collide with the long-side ones, with and without heads', () => {
    for (let places = 4; places <= 10; places++)
      for (const [boxWidth, boxHeight] of [
        [160, 80],
        [120, 60],
        [240, 120],
        [80, 160],
      ] as const)
        expect(
          overlapping(seatsOf('rectangular', boxWidth, boxHeight, places)),
          `${boxWidth}x${boxHeight} con ${places}`,
        ).toEqual([])
  })

  it('the seats are spread evenly: no side of a straight table has more than one seat over the opposite', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 14 }), (places) => {
        const seats = seatsOf('rectangular', 400, 100, places)
        const above = seats.filter(
          (s) => s.center[1] < 0 && s.center[0] >= 0 && s.center[0] <= 400,
        ).length
        const below = seats.filter((s) => s.center[1] > 100).length
        expect(Math.abs(above - below)).toBeLessThanOrEqual(1)
      }),
      SEED,
    )
  })
})
