import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { completeCatalog, completeEdit, type EditableCatalog } from './engine'
import {
  newTable,
  newZone,
  SHAPES,
  severalTables,
  type ZoneDraft,
  zoneChanges,
  zoneDraft,
  zoneIssues,
} from './floor-plan'

// Floor plan edges (task 1.2): several tables at once and what the editor does with an editing
// catalog without zones. Fixed seed.

const SEED = 20_261_024
const emptyCatalog = (): EditableCatalog => ({
  version: 0,
  zones: [],
  tables: [],
  elements: [],
  taxes: [],
  stations: [],
  categories: [],
  products: [],
  variants: [],
  groups: [],
  links: [],
  modifiers: [],
})
const shapes = Object.keys(SHAPES) as (keyof typeof SHAPES)[]

describe('severalTables', () => {
  it('count, consecutive names that do not clash, grid and no overlapping', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...shapes),
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 1, max: 15 }),
        fc.array(fc.integer({ min: 1, max: 80 }).map(String), { maxLength: 20 }),
        fc.integer({ min: 0, max: 5 }),
        (shape, quantity, perRow, usedNames, previousCount) => {
          const b = newZone(emptyCatalog())
          for (let i = 0; i < previousCount; i++)
            b.tables.push(
              newTable(
                b,
                'round',
                b.tables.map((m) => m.name),
              ),
            )
          const added = severalTables(b, shape, quantity, perRow, usedNames)
          expect(added).toHaveLength(quantity)
          const names = added.map((m) => m.name)
          expect(new Set(names).size).toBe(quantity)
          for (const n of names) expect(usedNames).not.toContain(n)
          // The smallest free ones, in increasing order.
          expect(names.map(Number)).toEqual([...names.map(Number)].sort((a, c) => a - c))
          for (const m of added) {
            expect(m.x % 10).toBe(0)
            expect(m.y % 10).toBe(0)
            expect(m.fresh && m.active).toBe(true)
          }
          expect(new Set(added.map((m) => m.y)).size).toBe(Math.ceil(quantity / perRow))
          // None on top of another nor of what was there.
          const allRows = [...b.tables, ...added]
          for (const [i, a] of allRows.entries())
            for (const c of allRows.slice(i + 1))
              expect(
                a.x < c.x + c.width &&
                  c.x < a.x + a.width &&
                  a.y < c.y + c.height &&
                  c.y < a.y + a.height,
              ).toBe(false)
        },
      ),
      { seed: SEED, numRuns: 200 },
    )
  })

  it('zero tables gives an empty list', () => {
    expect(severalTables(newZone(emptyCatalog()), 'square', 0, 5, [])).toEqual([])
  })

  it('a row of a single table per row stacks downward', () => {
    const m = severalTables(newZone(emptyCatalog()), 'square', 3, 1, [])
    expect(new Set(m.map((x) => x.x)).size).toBe(1)
    expect(new Set(m.map((x) => x.y)).size).toBe(3)
  })

  // Found by qa-pruebas in 1.2 and already fixed: Low priority: the screen limits "Por
  // fila" to 1..20, but `severalTables(…, 0, …)` gives x = NaN (division by zero).
  it('with perRow 0 the tables do not end up with invalid coordinates', () => {
    // An empty field on the screen could give 0: no position must be NaN or infinite.
    const m = severalTables(newZone(emptyCatalog()), 'square', 3, 0, [])
    for (const x of m) {
      expect(Number.isFinite(x.x)).toBe(true)
      expect(Number.isFinite(x.y)).toBe(true)
    }
  })

  it('the tables placed several at once are saved together in a single edit', () => {
    const c = emptyCatalog()
    const b: ZoneDraft = { ...newZone(c), name: 'Patio' }
    b.tables.push(...severalTables(b, 'round', 12, 4, []))
    expect(zoneIssues(c, b)).toEqual([])
    const changes = zoneChanges(c, b)
    expect(changes).toHaveLength(13)
    expect(changes[0]?.entity).toBe('zones')
  })
})

describe('the editor facing an editing catalog without zones', () => {
  // `FloorPlanEditor.openZone` takes the first active zone or, if there is none, builds a new one
  // named «Salón». Here that logic is checked with the functions of `floor-plan.ts`.
  const open = (c: EditableCatalog) => {
    const zone = c.zones.find((z) => z.active)
    return zone ? zoneDraft(c, zone.id) : { ...newZone(c), name: 'Salón' }
  }

  it('without zones it builds a new, empty «Salón» that cannot be saved untouched', () => {
    const c = emptyCatalog()
    const b = open(c)
    expect(b).toMatchObject({
      fresh: true,
      name: 'Salón',
      position: 0,
      level: 1,
      tables: [],
      elements: [],
    })
    expect(zoneIssues(c, b)).toEqual([])
    // «Dirty» is decided by the screen by tables/elements/name different from the initial one: here
    // there are 0 tables and the name is the initial one.
    expect(b.tables.length + b.elements.length).toBe(0)
  })

  it('with a table placed, saving creates the zone before the table', () => {
    const c = emptyCatalog()
    const b = open(c)
    b.tables.push(newTable(b, 'square', []))
    const changes = zoneChanges(c, b)
    expect(changes.map((x) => x.entity)).toEqual(['zones', 'dining_tables'])
    expect(changes[0]?.data).toEqual({ name: 'Salón', level: 1, position: 0, active: true })
  })

  it('with every zone archived it also builds a new one, without opening the archived one', () => {
    const c = emptyCatalog()
    c.zones.push({ id: 'Z', version: 3, active: false, name: 'Vieja', position: 0, level: 1 })
    const b = open(c)
    expect(b.fresh).toBe(true)
    expect(b.position).toBe(1)
    expect(() => zoneDraft(c, 'Z')).not.toThrow()
  })

  it('requesting the draft of a zone that does not exist throws a clear error', () => {
    expect(() => zoneDraft(emptyCatalog(), 'NO-EXISTE')).toThrow('Esa zona no existe')
  })

  // Found by qa-pruebas in 1.2 and already fixed: A hub older than the app (or a cut-off
  // response) may not bring `zones` or `elements`. `catalogForEditing` does not go through
  // `completeCatalog`, so the editor would show the browser's technical message instead of
  // opening a blank floor plan.
  it('an editing catalog without the floor plan keys is treated as an empty one', () => {
    // What `Floor.catalogForEditing` does with the hub response before handing it to the editor.
    const withoutFloorPlan = completeEdit({ version: 3, taxes: [], categories: [] })
    expect(() => open(withoutFloorPlan)).not.toThrow()
    expect(() => newZone(withoutFloorPlan)).not.toThrow()
  })
})

describe('completeCatalog', () => {
  const valid = {
    version: 9,
    restaurant: { name: 'X', sessionIdleMin: 30 },
    zones: [{ id: 'Z', name: 'Salón', level: 2 }],
    tables: [
      {
        id: 'M',
        zoneId: 'Z',
        name: '1',
        x: 10,
        y: 20,
        width: 100,
        height: 60,
        rotation: 45,
        shape: 'round',
        capacity: 2,
      },
    ],
    elements: [
      {
        id: 'E',
        zoneId: 'Z',
        type: 'wall',
        text: null,
        x: 0,
        y: 0,
        width: 300,
        height: 20,
        rotation: 0,
      },
    ],
    staff: [{ id: 'U', name: 'Ana' }],
    stations: [],
    categories: [],
  } as unknown as Parameters<typeof completeCatalog>[0]

  it('a complete menu stays the same and the original is not modified', () => {
    const copy = structuredClone(valid)
    expect(completeCatalog(valid)).toEqual(valid)
    expect(valid).toEqual(copy)
  })

  it('is idempotent and respects zeros (rotation 0, width 0 are not replaced by the default value)', () => {
    const old = {
      ...valid,
      tables: [{ ...(valid.tables[0] as object), width: 0, height: 0, rotation: 0 }],
    } as unknown as typeof valid
    const completed = completeCatalog(old)
    expect(completed.tables[0]).toMatchObject({ width: 0, height: 0, rotation: 0 })
    expect(completeCatalog(completed)).toEqual(completed)
  })

  it('completes only what is missing, table by table', () => {
    const mixed = {
      ...valid,
      zones: [
        { id: 'A', name: 'A' },
        { id: 'B', name: 'B', level: 3 },
      ],
      tables: [
        { id: '1', zoneId: 'A', name: '1', x: 0, y: 0, shape: 'square', capacity: 4 },
        {
          id: '2',
          zoneId: 'B',
          name: '2',
          x: 0,
          y: 0,
          width: 200,
          height: 50,
          rotation: 90,
          shape: 'bar',
          capacity: 1,
        },
      ],
    } as unknown as typeof valid
    const c = completeCatalog(mixed)
    expect(c.zones.map((z) => z.level)).toEqual([1, 3])
    expect(c.tables[0]).toMatchObject({ width: 80, height: 80, rotation: 0 })
    expect(c.tables[1]).toMatchObject({ width: 200, height: 50, rotation: 90 })
  })

  it('null values (from an odd save) are completed too', () => {
    const odd = {
      ...valid,
      zones: null,
      tables: [
        {
          id: '1',
          zoneId: 'A',
          name: '1',
          x: 0,
          y: 0,
          width: null,
          height: null,
          rotation: null,
          shape: 'square',
          capacity: 4,
        },
      ],
      elements: null,
      staff: null,
    } as unknown as typeof valid
    const c = completeCatalog(odd)
    expect(c.zones).toEqual([])
    expect(c.elements).toEqual([])
    expect(c.staff).toEqual([])
    expect(c.tables[0]).toMatchObject({ width: 80, height: 80, rotation: 0 })
  })
})
