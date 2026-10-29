import { newId } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { CatalogChange, EditableCatalog, ElementType, Geometry, TableShape } from './engine'
import {
  adjust,
  bounds,
  ELEMENT_TYPES,
  GRID,
  MIN_SIZE,
  measure,
  move,
  newElement,
  newTable,
  newZone,
  nextName,
  rotate,
  SHAPES,
  type ZoneDraft,
  zoneChanges,
  zoneDraft,
  zoneIssues,
} from './floor-plan'

// Floor plan properties (task 1.2). Fixed seed: deterministic.
// - Moving, rotating and measuring (in any order) keep the grid and the bounds the hub
//   requires (`apps/hub/src/catalog-editing.ts`).
// - Applying a zone's changes to the catalog leaves a draft equal to the edited one.
// - `bounds` contains the four corners of each shape, rotated or not.
// - `nextName` gives the smallest free number.

const SEED = 20_261_024
const RUNS = 300

// ── Geometry ─────────────────────────────────────────────────────────────────────────────────

const LIMIT = 10_000
const onGrid = (n: number) => Math.abs(n % GRID) === 0
const validGeometry = (g: Geometry) =>
  Number.isInteger(g.x) &&
  Number.isInteger(g.y) &&
  g.x >= -LIMIT &&
  g.x <= LIMIT &&
  g.y >= -LIMIT &&
  g.y <= LIMIT &&
  Number.isInteger(g.width) &&
  Number.isInteger(g.height) &&
  g.width >= MIN_SIZE &&
  g.width <= LIMIT &&
  g.height >= MIN_SIZE &&
  g.height <= LIMIT &&
  Number.isInteger(g.rotation) &&
  g.rotation >= 0 &&
  g.rotation <= 359

const arbGeometry: fc.Arbitrary<Geometry> = fc.record({
  x: fc.integer({ min: -LIMIT, max: LIMIT }).map((n) => adjust(n)),
  y: fc.integer({ min: -LIMIT, max: LIMIT }).map((n) => adjust(n)),
  width: fc.integer({ min: 2, max: 1000 }).map((n) => Math.max(MIN_SIZE, adjust(n * 5))),
  height: fc.integer({ min: 2, max: 1000 }).map((n) => Math.max(MIN_SIZE, adjust(n * 5))),
  rotation: fc.integer({ min: 0, max: 359 }),
})
// Screen values: with decimals, negative and absurd.
const arbScreen = fc.oneof(
  fc.double({ min: -50_000, max: 50_000, noNaN: true }),
  fc.integer({ min: -50_000, max: 50_000 }),
  fc.constantFrom(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, 4.99, 5, 5.01),
)

type Position =
  | { t: 'move'; x: number; y: number }
  | { t: 'rotate'; g: number }
  | { t: 'measure'; a: number; h: number }
const arbPosition: fc.Arbitrary<Position> = fc.oneof(
  fc.record({ t: fc.constant('move' as const), x: arbScreen, y: arbScreen }),
  fc.record({
    t: fc.constant('rotate' as const),
    g: fc.constantFrom(-90, -15, 15, 45, 90, 180, 360, -360, 1000),
  }),
  fc.record({ t: fc.constant('measure' as const), a: arbScreen, h: arbScreen }),
)
const act = (g: Geometry, o: Position): Geometry =>
  o.t === 'move' ? move(g, o.x, o.y) : o.t === 'rotate' ? rotate(g, o.g) : measure(g, o.a, o.h)

describe('move, rotate and measure', () => {
  it('any sequence leaves the shape on the grid, within the bounds and with integer sizes', () => {
    fc.assert(
      fc.property(arbGeometry, fc.array(arbPosition, { maxLength: 12 }), (g0, ranks) => {
        let g = g0
        for (const o of ranks) {
          g = act(g, o)
          expect(validGeometry(g)).toBe(true)
        }
        if (ranks.some((o) => o.t === 'move')) {
          expect(onGrid(g.x)).toBe(true)
          expect(onGrid(g.y)).toBe(true)
        }
        if (ranks.some((o) => o.t === 'measure')) {
          expect(onGrid(g.width)).toBe(true)
          expect(onGrid(g.height)).toBe(true)
        }
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('each operation only touches its own', () => {
    fc.assert(
      fc.property(arbGeometry, arbScreen, arbScreen, (g, a, b) => {
        const movedTable = move(g, a, b)
        expect([movedTable.width, movedTable.height, movedTable.rotation]).toEqual([
          g.width,
          g.height,
          g.rotation,
        ])
        const size = measure(g, a, b)
        expect([size.x, size.y, size.rotation]).toEqual([g.x, g.y, g.rotation])
        const rotated = rotate(g, 90)
        expect([rotated.x, rotated.y, rotated.width, rotated.height]).toEqual([
          g.x,
          g.y,
          g.width,
          g.height,
        ])
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('move and measure are idempotent: repeating with the result changes nothing', () => {
    fc.assert(
      fc.property(arbGeometry, arbScreen, arbScreen, (g, a, b) => {
        const m = move(g, a, b)
        expect(move(m, m.x, m.y)).toEqual(m)
        const t = measure(g, a, b)
        expect(measure(t, t.width, t.height)).toEqual(t)
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('a grid point inside the dining room stays where it is', () => {
    fc.assert(
      fc.property(arbGeometry, (g) => {
        expect(move(g, g.x, g.y)).toEqual(g)
        expect(measure(g, g.width, g.height)).toEqual(g)
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('rotating adds modulo 360: a full turn returns to the same angle', () => {
    fc.assert(
      fc.property(
        arbGeometry,
        fc.integer({ min: -2000, max: 2000 }),
        fc.integer({ min: -2000, max: 2000 }),
        (g, a, b) => {
          expect(rotate(rotate(g, a), b).rotation).toBe(rotate(g, a + b).rotation)
          expect(rotate(g, 360).rotation).toBe(g.rotation)
          expect(rotate(rotate(g, a), -a).rotation).toBe(g.rotation)
        },
      ),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('dragging to an absurd place stops at the edge of the dining room', () => {
    const g = { x: 0, y: 0, width: 80, height: 80, rotation: 0 }
    expect(move(g, 1e12, -1e12)).toMatchObject({ x: LIMIT, y: -LIMIT })
    expect(move(g, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)).toMatchObject({
      x: LIMIT,
      y: -LIMIT,
    })
    expect(measure(g, 1e12, -5)).toMatchObject({ width: LIMIT, height: MIN_SIZE })
  })

  // Found by qa-pruebas in 1.2 and already fixed: `move` and `measure` let NaN through
  // (Math.round(NaN) = NaN and Math.min/max propagate it). The editor does not produce it today
  // (it stops at scale 0), but a NaN saved in the draft would travel as null and the hub would
  // reject the whole save.
  it('a screen number that is not a number (NaN) does not slip in as a position or size', () => {
    const g = { x: 0, y: 0, width: 80, height: 80, rotation: 0 }
    expect(Number.isFinite(move(g, Number.NaN, 0).x)).toBe(true)
    expect(Number.isFinite(measure(g, Number.NaN, 0).width)).toBe(true)
  })
})

// ── bounds ───────────────────────────────────────────────────────────────────────────────────

/** The four corners of a shape, rotated around its center. */
function corners(g: Geometry) {
  const cx = g.x + g.width / 2
  const cy = g.y + g.height / 2
  const rad = (g.rotation * Math.PI) / 180
  return [
    [-g.width / 2, -g.height / 2],
    [g.width / 2, -g.height / 2],
    [g.width / 2, g.height / 2],
    [-g.width / 2, g.height / 2],
  ].map(([dx, dy]) => ({
    x: cx + (dx as number) * Math.cos(rad) - (dy as number) * Math.sin(rad),
    y: cy + (dx as number) * Math.sin(rad) + (dy as number) * Math.cos(rad),
  }))
}

const arbShape: fc.Arbitrary<Geometry> = fc.record({
  x: fc.integer({ min: -2000, max: 2000 }),
  y: fc.integer({ min: -2000, max: 2000 }),
  width: fc.integer({ min: 20, max: 600 }),
  height: fc.integer({ min: 20, max: 600 }),
  rotation: fc.integer({ min: 0, max: 359 }),
})
const EPS = 1e-6

describe('bounds', () => {
  it('contains the four corners of each shape, with any rotation, plus the margin', () => {
    fc.assert(
      fc.property(
        fc.array(arbShape, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 200 }),
        (figures, margin) => {
          const register = bounds(figures, margin)
          for (const f of figures)
            for (const p of corners(f)) {
              expect(p.x).toBeGreaterThanOrEqual(register.x + margin - EPS)
              expect(p.y).toBeGreaterThanOrEqual(register.y + margin - EPS)
              expect(p.x).toBeLessThanOrEqual(register.x + register.width - margin + EPS)
              expect(p.y).toBeLessThanOrEqual(register.y + register.height - margin + EPS)
            }
        },
      ),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('without rotation (0° and 180°) it is exact: not one centimeter to spare', () => {
    fc.assert(
      fc.property(
        fc.array(
          arbShape.map((f) => ({ ...f, rotation: 0 })),
          { minLength: 1, maxLength: 8 },
        ),
        fc.constantFrom(0, 180),
        (figures, angle) => {
          const g = figures.map((f) => ({ ...f, rotation: angle }))
          const register = bounds(g, 0)
          expect(register.x).toBe(Math.min(...g.map((f) => f.x)))
          expect(register.y).toBe(Math.min(...g.map((f) => f.y)))
          expect(register.x + register.width).toBe(Math.max(...g.map((f) => f.x + f.width)))
          expect(register.y + register.height).toBe(Math.max(...g.map((f) => f.y + f.height)))
        },
      ),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('adding a shape never shrinks the box; the margin adds double to width and height', () => {
    fc.assert(
      fc.property(
        fc.array(arbShape, { minLength: 1, maxLength: 6 }),
        arbShape,
        (figures, another) => {
          const before = bounds(figures, 0)
          const after = bounds([...figures, another], 0)
          expect(after.x).toBeLessThanOrEqual(before.x + EPS)
          expect(after.y).toBeLessThanOrEqual(before.y + EPS)
          expect(after.x + after.width).toBeGreaterThanOrEqual(before.x + before.width - EPS)
          expect(after.y + after.height).toBeGreaterThanOrEqual(before.y + before.height - EPS)
          const withMargin = bounds(figures, 40)
          expect(withMargin.width).toBeCloseTo(before.width + 80)
          expect(withMargin.height).toBeCloseTo(before.height + 80)
        },
      ),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('the order of the shapes does not matter', () => {
    fc.assert(
      fc.property(fc.array(arbShape, { minLength: 1, maxLength: 8 }), (figures) => {
        expect(bounds([...figures].reverse())).toEqual(bounds(figures))
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('a long thin one rotated 90° takes more than its side length (the circle is used)', () => {
    // 300×20 at 90°: exact would be 20 wide and 300 high; `bounds` is conservative.
    const register = bounds([{ x: 0, y: 0, width: 300, height: 20, rotation: 90 }], 0)
    expect(register.height).toBeGreaterThanOrEqual(300)
    expect(register.width).toBeGreaterThanOrEqual(20)
    // And it is the same for 90° and 270°.
    expect(bounds([{ x: 0, y: 0, width: 300, height: 20, rotation: 270 }], 0)).toEqual(register)
  })

  it('with no shapes it gives a blank floor plan of fixed size, with or without margin', () => {
    expect(bounds([])).toEqual({ x: 0, y: 0, width: 600, height: 400 })
    expect(bounds([], 500)).toEqual(bounds([], 0))
  })
})

// ── nextName ──────────────────────────────────────────────────────────────────────────

describe('nextName', () => {
  it('is the smallest positive integer no name uses (ignoring case and spaces)', () => {
    const arbName = fc.oneof(
      fc.integer({ min: 1, max: 40 }).map(String),
      fc.integer({ min: 1, max: 40 }).map((n) => ` ${n} `),
      fc.stringMatching(/^[A-Za-z]{1,6}[0-9]{0,2}$/),
      fc.constantFrom('', '0', '-1', '01', '1.5', 'Terraza 1'),
    )
    fc.assert(
      fc.property(fc.array(arbName, { maxLength: 60 }), (names) => {
        const n = nextName(names)
        expect(n).toMatch(/^[1-9][0-9]*$/)
        const usedNames = new Set(names.map((x) => x.trim().toLowerCase()))
        expect(usedNames.has(n)).toBe(false)
        for (let k = 1; k < Number(n); k++) expect(usedNames.has(String(k))).toBe(true)
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('concrete cases', () => {
    expect(nextName([])).toBe('1')
    expect(nextName(['2', '3'])).toBe('1')
    expect(nextName(['1', '2', '3'])).toBe('4')
    expect(nextName([' 1 ', '2'])).toBe('3')
    expect(nextName(['A1', '1a', '01', '0', '-1'])).toBe('1')
    expect(nextName(Array.from({ length: 500 }, (_, i) => String(i + 1)))).toBe('501')
  })
})

// ── A dining room that fills up ──────────────────────────────────────────────────────────────

const intersect = (a: Geometry, b: Omit<Geometry, 'rotation'>) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

describe('freeSpot: placing new tables and elements in a dining room that fills up', () => {
  const TABLE_SHAPES = Object.keys(SHAPES) as TableShape[]
  const TYPES = Object.keys(ELEMENT_TYPES) as ElementType[]

  function fill(
    times: { table: TableShape } | { element: ElementType },
    n: number,
    b = newZone({ zones: [] } as unknown as EditableCatalog),
  ) {
    for (let i = 0; i < n; i++) {
      if ('table' in times)
        b.tables.push(
          newTable(
            b,
            times.table,
            b.tables.map((m) => m.name),
          ),
        )
      else b.elements.push(newElement(b, times.element))
    }
    return b
  }

  it('the first one goes to the origin', () => {
    const b = newZone({ zones: [] } as unknown as EditableCatalog)
    expect(newTable(b, 'square', [])).toMatchObject({ x: 0, y: 0 })
    expect(newElement(b, 'wall')).toMatchObject({ x: 0, y: 0 })
  })

  it('the new one never overlaps what is already there, on the grid and inside the dining room', () => {
    const arbStep = fc.oneof(
      fc.constantFrom(...TABLE_SHAPES).map((shape) => ({ table: shape })),
      fc.constantFrom(...TYPES).map((type) => ({ element: type })),
    )
    fc.assert(
      fc.property(
        fc.array(arbStep, { minLength: 1, maxLength: 40 }),
        fc.array(arbShape, { maxLength: 4 }),
        (steps, previousCount) => {
          const b = newZone({ zones: [] } as unknown as EditableCatalog)
          // Something already drawn, maybe rotated.
          for (const [i, f] of previousCount.entries())
            b.tables.push({
              ...newTable(b, 'square', []),
              ...f,
              id: newId(),
              name: `P${i}`,
              fresh: false,
            })
          for (const p of steps) {
            const before = [...b.tables, ...b.elements]
            const fresh =
              'table' in p
                ? newTable(
                    b,
                    p.table,
                    b.tables.map((m) => m.name),
                  )
                : newElement(b, p.element)
            expect(onGrid(fresh.x) && onGrid(fresh.y)).toBe(true)
            expect(Math.abs(fresh.x)).toBeLessThanOrEqual(LIMIT)
            expect(Math.abs(fresh.y)).toBeLessThanOrEqual(LIMIT)
            // A rotated one takes the circle that contains it (like `bounds`): the new spot must
            // fall outside the `bounds` box, that is, outside any previous shape.
            for (const another of before) {
              const register = bounds([another], 0)
              expect(intersect(fresh, register)).toBe(false)
            }
            if ('table' in p) b.tables.push(fresh as (typeof b.tables)[number])
            else b.elements.push(fresh as (typeof b.elements)[number])
          }
        },
      ),
      { seed: SEED, numRuns: 100 },
    )
  })

  it('places several tables per row up to about 15 m and then moves down to the next row', () => {
    const b = fill({ table: 'round' }, 11)
    // Round ones of 90 cm with 40 of spacing: 11 fit in a 15 m row.
    expect(new Set(b.tables.map((m) => m.y))).toEqual(new Set([0]))
    expect(Math.max(...b.tables.map((m) => m.x + m.width))).toBeLessThanOrEqual(1500)
    const next = newTable(
      b,
      'round',
      b.tables.map((m) => m.name),
    )
    expect(next.y).toBeGreaterThan(0)
    expect(next.x).toBe(0)
  })

  // Found by qa-pruebas in 1.2 and already fixed: `freeSpot` measures the box of EVERYTHING
  // drawn; as soon as the first row fills the usual width, the box is already wider than 1500 and
  // no more tables fit "to the right": each one goes down to a new row one at a time, in a single
  // column.
  it('when filling up, the following rows also fill with several tables, not one at a time', () => {
    // 40 round tables: with 11 per row 4 rows are enough; not a column of 30.
    const b = fill({ table: 'round' }, 40)
    const rows = new Set(b.tables.map((m) => m.y)).size
    expect(rows).toBeLessThanOrEqual(6)
  })

  // Found by qa-pruebas in 1.2 and already fixed: with ~78 new tables in a zone the
  // column goes past y = 10 000 and the hub rejects the whole save ("y: Too big"), without the
  // screen warning about it first.
  it('100 new tables in a zone fit within the dining room bounds the hub accepts', () => {
    const b = fill({ table: 'round' }, 100)
    for (const m of b.tables) {
      expect(Math.abs(m.x)).toBeLessThanOrEqual(LIMIT)
      expect(Math.abs(m.y)).toBeLessThanOrEqual(LIMIT)
    }
  })

  it('a wide element that does not fit to the right moves down a row instead of leaving the usual dining room', () => {
    const b = fill({ element: 'wall' }, 1)
    const second = newElement(b, 'wall')
    b.elements.push(second)
    const third = newElement(b, 'wall')
    // 300 + 40 + 300 + 40 + 300 > 1500: a third one does not fit in the same row.
    expect(second.y).toBe(0)
    expect(third.x + third.width).toBeLessThanOrEqual(1500)
  })

  it('what is archived takes no space', () => {
    const b = fill({ table: 'square' }, 5)
    for (const m of b.tables) m.active = false
    expect(newTable(b, 'square', [])).toMatchObject({ x: 0, y: 0 })
  })
})

// ── Save and reopen ──────────────────────────────────────────────────────────────────────────

type Registration = Record<string, string | number | boolean | null>
const FIELDS: Record<'zones' | 'dining_tables' | 'floor_plan_elements', string[]> = {
  zones: ['name', 'position', 'level', 'active'],
  dining_tables: [
    'zone_id',
    'name',
    'shape',
    'x',
    'y',
    'width',
    'height',
    'rotation',
    'capacity',
    'active',
  ],
  floor_plan_elements: [
    'zone_id',
    'type',
    'text',
    'x',
    'y',
    'width',
    'height',
    'rotation',
    'active',
  ],
}
const TABLE = { zones: 'zones', dining_tables: 'tables', floor_plan_elements: 'elements' } as const

const whole = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/** Applies the changes as the hub would (`catalog-editing.ts`); throws if it would reject them. */
function apply(source: EditableCatalog, sentList: CatalogChange[]): EditableCatalog {
  const c = structuredClone(source)
  // They travel over the network as JSON (so -0 arrives as 0).
  const changes: CatalogChange[] = JSON.parse(JSON.stringify(sentList))
  let version = c.version
  const touched: {
    entity: 'zones' | 'dining_tables' | 'floor_plan_elements'
    id: string
    where: string
  }[] = []
  const tableName = (e: keyof typeof TABLE) =>
    c[TABLE[e]] as unknown as (Registration & { id: string })[]

  for (const [i, change] of changes.entries()) {
    const e = change.entity as keyof typeof TABLE
    const where = `Change ${i + 1} (${e})`
    if (!(e in TABLE)) throw new Error(`${where}: not part of the floor plan`)
    const keys = Object.keys(change.data)
    if (keys.length === 0) throw new Error(`${where}: changes nothing`)
    for (const k of keys)
      if (!FIELDS[e].includes(k)) throw new Error(`${where}: field ${k} does not exist`)
    const zoneRef = change.data.zone_id
    if (typeof zoneRef === 'string' && !c.zones.some((z) => z.id === zoneRef))
      throw new Error(`${where}: zone_id does not exist`)
    const current = tableName(e).find((f) => f.id === change.id)
    if (!current) {
      for (const k of FIELDS[e])
        if (!(k in change.data)) throw new Error(`${where}: ${k} missing on create`)
      tableName(e).push({ id: change.id, version: ++version, ...change.data } as Registration & {
        id: string
      })
    } else {
      const changing = Object.entries(change.data).filter(([k, v]) => current[k] !== v)
      if (changing.length !== keys.length) throw new Error(`${where}: sends unchanged fields`)
      Object.assign(current, change.data, { version: ++version })
    }
    const row = tableName(e).find((f) => f.id === change.id) as Registration
    const badCase = (field: string) => {
      throw new Error(`${where}: invalid ${field} (${String(row[field])})`)
    }
    if (typeof row.name === 'string') {
      const max = e === 'zones' ? 80 : 20
      if (row.name !== row.name.trim() || row.name.length < 1 || row.name.length > max)
        badCase('name')
    }
    if (e !== 'zones') {
      if (!whole(row.x, -LIMIT, LIMIT)) badCase('x')
      if (!whole(row.y, -LIMIT, LIMIT)) badCase('y')
      if (!whole(row.width, 5, LIMIT)) badCase('width')
      if (!whole(row.height, 5, LIMIT)) badCase('height')
      if (!whole(row.rotation, 0, 359)) badCase('rotation')
    }
    if (e === 'dining_tables' && !whole(row.capacity, 1, 100)) badCase('capacity')
    if (e === 'zones' && (!whole(row.level, -5, 100) || !whole(row.position, 0, 10_000)))
      badCase('level')
    if (e === 'floor_plan_elements') {
      if (typeof row.text === 'string' && (row.text !== row.text.trim() || row.text.length > 60))
        badCase('text')
    }
    touched.push({ entity: e, id: change.id, where })
  }

  for (const t of touched) {
    const row = tableName(t.entity).find((f) => f.id === t.id) as Registration
    if (row.active === true && t.entity !== 'zones') {
      const zone = c.zones.find((z) => z.id === row.zone_id)
      if (zone?.active !== true) throw new Error(`${t.where}: zone is archived`)
    }
    if (row.active === false && t.entity === 'zones')
      if (c.tables.some((m) => m.zone_id === t.id && m.active))
        throw new Error(`${t.where}: used by tables; change them first`)
  }
  if (touched.some((t) => t.entity === 'dining_tables')) {
    const seenSet = new Set<string>()
    for (const m of c.tables.filter((x) => x.active)) {
      const n = m.name.toLowerCase()
      if (seenSet.has(n)) throw new Error(`There are two tables named «${m.name}»`)
      seenSet.add(n)
    }
  }
  c.version = version
  return c
}

const rowBase = { version: 1, active: true }
const geo = (x: number, y: number) => ({ x, y, width: 80, height: 80, rotation: 0 })

function diningRoom(): EditableCatalog {
  const a = 'ZONE-DINING'
  const t = 'ZONE-PATIO'
  return {
    version: 10,
    zones: [
      { ...rowBase, id: a, name: 'Salón', position: 0, level: 1 },
      { ...rowBase, id: t, name: 'Terraza', position: 1, level: 1 },
    ],
    tables: [
      { ...rowBase, ...geo(0, 0), id: 'M1', zone_id: a, name: '1', shape: 'square', capacity: 4 },
      { ...rowBase, ...geo(120, 0), id: 'M2', zone_id: a, name: '2', shape: 'round', capacity: 2 },
      {
        ...rowBase,
        ...geo(0, 120),
        id: 'M3',
        zone_id: a,
        name: '3',
        shape: 'rectangular',
        capacity: 6,
      },
      { ...rowBase, ...geo(0, 0), id: 'M10', zone_id: t, name: '10', shape: 'round', capacity: 2 },
      // Archived: they are not in the editor, but their names do not count.
      {
        ...rowBase,
        ...geo(0, 0),
        id: 'M4',
        zone_id: a,
        name: '4',
        shape: 'bar',
        capacity: 1,
        active: false,
      },
    ],
    elements: [
      {
        ...rowBase,
        ...geo(0, 300),
        id: 'E1',
        zone_id: a,
        type: 'wall',
        text: null,
        width: 400,
        height: 20,
        rotation: 30,
      },
      { ...rowBase, ...geo(500, 0), id: 'E2', zone_id: a, type: 'text', text: 'Baños' },
    ],
    taxes: [],
    stations: [],
    categories: [],
    products: [],
    variants: [],
    groups: [],
    links: [],
    modifiers: [],
  }
}

type Edit =
  | { t: 'table'; shape: TableShape }
  | { t: 'element'; type: ElementType }
  | { t: 'move'; i: number; x: number; y: number }
  | { t: 'measure'; i: number; a: number; h: number }
  | { t: 'rotate'; i: number; g: number }
  | { t: 'remove'; i: number }
  | { t: 'removeElement'; i: number }
  | { t: 'rename'; i: number; name: string }
  | { t: 'places'; i: number; n: number }
  | { t: 'shape'; i: number; shape: TableShape }
  | { t: 'text'; i: number; text: string }
  | { t: 'duplicate'; i: number }
  | { t: 'zone'; name: string; level: number }

const arbSpaces = fc.constantFrom('', ' ', '  ')
const arbText = fc
  .tuple(arbSpaces, fc.stringMatching(/^[A-Za-zñÁ0-9]{1,10}$/), arbSpaces)
  .map(([a, b, c]) => `${a}${b}${c}`)
const arbTableNumber = fc.oneof(
  arbText,
  fc.integer({ min: 1, max: 12 }).map(String),
  fc.integer({ min: 1, max: 12 }).map((n) => ` ${n} `),
  fc.constantFrom('T', 't', 'T ', ' t'),
)
const arbEdit: fc.Arbitrary<Edit> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .constantFrom(...(Object.keys(SHAPES) as TableShape[]))
      .map((shape) => ({ t: 'table' as const, shape })),
  },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom(...(Object.keys(ELEMENT_TYPES) as ElementType[]))
      .map((type) => ({ t: 'element' as const, type })),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('move' as const),
      i: fc.nat(20),
      x: fc.integer({ min: -3000, max: 3000 }),
      y: fc.integer({ min: -3000, max: 3000 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('measure' as const),
      i: fc.nat(20),
      a: fc.integer({ min: -100, max: 2000 }),
      h: fc.integer({ min: -100, max: 2000 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('rotate' as const),
      i: fc.nat(20),
      g: fc.constantFrom(-15, 15, 90),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('remove' as const), i: fc.nat(20) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('removeElement' as const), i: fc.nat(20) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('rename' as const),
      i: fc.nat(20),
      name: arbTableNumber,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('places' as const),
      i: fc.nat(20),
      n: fc.integer({ min: 0, max: 100 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('shape' as const),
      i: fc.nat(20),
      shape: fc.constantFrom(...(Object.keys(SHAPES) as TableShape[])),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('text' as const),
      i: fc.nat(20),
      text: fc.oneof(arbText, fc.constant('')),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('duplicate' as const), i: fc.nat(20) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('zone' as const),
      name: arbText,
      level: fc.integer({ min: -5, max: 100 }),
    }),
  },
)

/** What the editor would do with each gesture (same functions from `floor-plan.ts`). */
function edit(c: EditableCatalog, b: ZoneDraft, e: Edit): ZoneDraft {
  const tables = b.tables.filter((m) => m.active)
  const elements = b.elements.filter((x) => x.active)
  const table = tables.length ? tables[e && 'i' in e ? e.i % tables.length : 0] : undefined
  const element = elements.length ? elements[e && 'i' in e ? e.i % elements.length : 0] : undefined
  const usedNames = [
    ...c.tables.filter((m) => m.active && m.zone_id !== b.id).map((m) => m.name),
    ...tables.map((m) => m.name),
  ]
  const changeTable = (
    id: string,
    f: (m: (typeof b.tables)[number]) => (typeof b.tables)[number],
  ) => ({
    ...b,
    tables: b.tables.map((m) => (m.id === id ? f(m) : m)),
  })
  const changeElement = (
    id: string,
    f: (m: (typeof b.elements)[number]) => (typeof b.elements)[number],
  ) => ({
    ...b,
    elements: b.elements.map((m) => (m.id === id ? f(m) : m)),
  })
  switch (e.t) {
    case 'table':
      return { ...b, tables: [...b.tables, newTable(b, e.shape, usedNames)] }
    case 'element':
      return { ...b, elements: [...b.elements, newElement(b, e.type)] }
    case 'move':
      if (table) return changeTable(table.id, (m) => move(m, e.x, e.y))
      return element ? changeElement(element.id, (m) => move(m, e.x, e.y)) : b
    case 'measure':
      if (table) return changeTable(table.id, (m) => measure(m, e.a, e.h))
      return element ? changeElement(element.id, (m) => measure(m, e.a, e.h)) : b
    case 'rotate':
      if (table) return changeTable(table.id, (m) => rotate(m, e.g))
      return element ? changeElement(element.id, (m) => rotate(m, e.g)) : b
    case 'remove':
      return table ? changeTable(table.id, (m) => ({ ...m, active: false })) : b
    case 'removeElement':
      return element ? changeElement(element.id, (m) => ({ ...m, active: false })) : b
    case 'rename':
      return table ? changeTable(table.id, (m) => ({ ...m, name: e.name })) : b
    case 'places':
      return table ? changeTable(table.id, (m) => ({ ...m, capacity: e.n })) : b
    case 'shape':
      return table ? changeTable(table.id, (m) => ({ ...m, shape: e.shape })) : b
    case 'text':
      return element?.type === 'text'
        ? changeElement(element.id, (m) => ({ ...m, text: e.text }))
        : b
    case 'duplicate': {
      if (table) {
        const side = move(table, table.x + table.width + GRID * 2, table.y)
        return {
          ...b,
          tables: [...b.tables, { ...side, id: newId(), fresh: true, name: nextName(usedNames) }],
        }
      }
      if (element)
        return {
          ...b,
          elements: [
            ...b.elements,
            {
              ...move(element, element.x + element.width + GRID * 2, element.y),
              id: newId(),
              fresh: true,
            },
          ],
        }
      return b
    }
    case 'zone':
      return { ...b, name: e.name, level: e.level }
  }
}

/** How the draft must look when reopened: only what is active, already saved and trimmed. */
function expected(b: ZoneDraft): ZoneDraft {
  const byId = <T extends { id: string }>(list: T[]) =>
    [...list].sort((p, q) => p.id.localeCompare(q.id))
  return {
    ...b,
    fresh: false,
    name: b.name.trim(),
    tables: byId(
      b.tables.filter((m) => m.active).map((m) => ({ ...m, fresh: false, name: m.name.trim() })),
    ),
    elements: byId(
      b.elements
        .filter((x) => x.active)
        .map((x) => ({
          ...x,
          fresh: false,
          text: x.type === 'text' ? (x.text?.trim() ?? '') : null,
        })),
    ),
  }
}
const ordered = (b: ZoneDraft): ZoneDraft => ({
  ...b,
  tables: [...b.tables].sort((p, q) => p.id.localeCompare(q.id)),
  elements: [...b.elements].sort((p, q) => p.id.localeCompare(q.id)),
})

describe('save a zone and reopen it', () => {
  const arbWhere = fc.constantFrom('dining' as const, 'patio' as const, 'new' as const)

  it('applying the changes of an edited draft to the catalog and reopening gives the same draft; saving again changes nothing', () => {
    let checked = 0
    fc.assert(
      fc.property(arbWhere, fc.array(arbEdit, { maxLength: 25 }), (where, edits) => {
        const c = diningRoom()
        let b: ZoneDraft =
          where === 'new'
            ? { ...newZone(c), name: 'Primer piso', level: 2 }
            : zoneDraft(c, where === 'dining' ? 'ZONE-DINING' : 'ZONE-PATIO')
        for (const e of edits) b = edit(c, b, e)

        const issues = zoneIssues(c, b)
        const changes = zoneChanges(c, b)
        if (issues.length > 0) return // The screen does not allow saving: nothing to check.
        checked += 1

        // What the screen allows saving, the hub accepts.
        const c2 = apply(c, changes)
        const roundTripped = zoneDraft(c2, b.id)
        expect(ordered(roundTripped)).toEqual(JSON.parse(JSON.stringify(expected(b))))
        // And saving the same again sends nothing.
        expect(zoneChanges(c2, roundTripped)).toEqual([])
        // The other zones are not touched.
        for (const z of c.zones.filter((z) => z.id !== b.id))
          expect(zoneDraft(c2, z.id)).toEqual(zoneDraft(c, z.id))
      }),
      { seed: SEED, numRuns: 400 },
    )
    // The property is not vacuous: most generated edits can be saved.
    expect(checked).toBeGreaterThan(200)
  })

  it('each change brings something, no record repeats and a new zone goes before its tables', () => {
    fc.assert(
      fc.property(fc.array(arbEdit, { maxLength: 25 }), (edits) => {
        const c = diningRoom()
        let b: ZoneDraft = { ...newZone(c), name: 'Azotea', level: 3 }
        for (const e of edits) b = edit(c, b, e)
        const changes = zoneChanges(c, b)
        for (const x of changes) expect(Object.keys(x.data).length).toBeGreaterThan(0)
        expect(new Set(changes.map((x) => x.id)).size).toBe(changes.length)
        const iZone = changes.findIndex((x) => x.entity === 'zones')
        expect(iZone).toBe(0)
        // Archiving what was removed does not send the new ones already removed.
        for (const x of changes.filter((x) => x.entity !== 'zones'))
          expect(x.data.active).toBe(true)
      }),
      { seed: SEED, numRuns: RUNS },
    )
  })

  it('if the screen allows saving, there are no two tables with the same name in the whole restaurant', () => {
    fc.assert(
      fc.property(arbWhere, fc.array(arbEdit, { maxLength: 25 }), (where, edits) => {
        const c = diningRoom()
        let b: ZoneDraft =
          where === 'new'
            ? { ...newZone(c), name: 'Patio' }
            : zoneDraft(c, where === 'dining' ? 'ZONE-DINING' : 'ZONE-PATIO')
        for (const e of edits) b = edit(c, b, e)
        if (zoneIssues(c, b).length > 0) return
        const c2 = apply(c, zoneChanges(c, b))
        const names = c2.tables.filter((m) => m.active).map((m) => m.name.trim().toLowerCase())
        expect(new Set(names).size).toBe(names.length)
      }),
      { seed: SEED, numRuns: 400 },
    )
  })

  it('archiving the zone with edits on top archives everything of its own and sends nothing new', () => {
    fc.assert(
      fc.property(fc.array(arbEdit, { maxLength: 15 }), (edits) => {
        const c = diningRoom()
        let b = zoneDraft(c, 'ZONE-DINING')
        for (const e of edits) b = edit(c, b, e)
        b = { ...b, active: false }
        const changes = zoneChanges(c, b)
        // Only existing ones: what was created in this session and not saved does not travel.
        const newer = new Set([...b.tables, ...b.elements].filter((x) => x.fresh).map((x) => x.id))
        expect(changes.some((x) => newer.has(x.id))).toBe(false)
        expect(changes.at(-1)).toMatchObject({ entity: 'zones', data: { active: false } })
        if (zoneIssues(c, b).length > 0) return
        const c2 = apply(c, changes)
        expect(c2.tables.filter((m) => m.zone_id === 'ZONE-DINING' && m.active)).toEqual([])
        expect(c2.elements.filter((x) => x.zone_id === 'ZONE-DINING' && x.active)).toEqual([])
        expect(c2.zones.find((z) => z.id === 'ZONE-DINING')?.active).toBe(false)
      }),
      { seed: SEED, numRuns: 200 },
    )
  })
})
