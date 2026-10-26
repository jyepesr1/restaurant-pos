import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { completeCatalog, type EditableCatalog } from './engine'
import {
  adjust,
  bounds,
  measure,
  move,
  newElement,
  newTable,
  newZone,
  nextName,
  rotate,
  severalTables,
  zoneChanges,
  zoneDraft,
  zoneIssues,
} from './floor-plan'

const reg = { version: 1, active: true }
const geo = (x: number, y: number, width = 80, height = 80) => ({
  x,
  y,
  width,
  height,
  rotation: 0,
})

function editView(): EditableCatalog {
  const diningRoom = newId()
  const patio = newId()
  return {
    version: 5,
    zones: [
      { ...reg, id: diningRoom, name: 'Salón', position: 0, level: 1 },
      { ...reg, id: patio, name: 'Terraza', position: 1, level: 1 },
    ],
    tables: [
      {
        ...reg,
        ...geo(0, 0),
        id: newId(),
        zone_id: diningRoom,
        name: '1',
        shape: 'square',
        capacity: 4,
      },
      {
        ...reg,
        ...geo(120, 0),
        id: newId(),
        zone_id: diningRoom,
        name: '2',
        shape: 'square',
        capacity: 4,
      },
      {
        ...reg,
        ...geo(0, 0),
        id: newId(),
        zone_id: patio,
        name: '10',
        shape: 'round',
        capacity: 2,
      },
    ],
    elements: [
      {
        ...reg,
        ...geo(0, 200, 300, 20),
        id: newId(),
        zone_id: diningRoom,
        type: 'wall',
        text: null,
      },
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

const diningRoomOf = (c: EditableCatalog) => c.zones[0]?.id as string

describe('geometry', () => {
  it('everything snaps to the 10 cm grid', () => {
    expect(adjust(84)).toBe(80)
    expect(adjust(85)).toBe(90)
    expect(move(geo(0, 0), 123, -7)).toMatchObject({ x: 120, y: -10 })
  })

  it('rotating always gives between 0 and 359', () => {
    expect(rotate(geo(0, 0), 45).rotation).toBe(45)
    expect(rotate({ ...geo(0, 0), rotation: 330 }, 45).rotation).toBe(15)
    expect(rotate(geo(0, 0), -15).rotation).toBe(345)
  })

  it('sizes have a minimum and snap to the grid', () => {
    expect(measure(geo(0, 0), 3, 154)).toMatchObject({ width: 20, height: 150 })
  })

  it('the bounds cover everything, rotated things too, with margin', () => {
    expect(bounds([geo(0, 0), geo(200, 100)], 0)).toEqual({ x: 0, y: 0, width: 280, height: 180 })
    const rotated = bounds([{ ...geo(0, 0, 100, 20), rotation: 90 }], 0)
    expect(rotated.width).toBeGreaterThan(100)
    expect(bounds([], 0).width).toBeGreaterThan(0)
  })
})

describe('zone', () => {
  it('opening and saving without touching anything changes nothing', () => {
    const c = editView()
    expect(zoneChanges(c, zoneDraft(c, diningRoomOf(c)))).toEqual([])
  })

  it('moving a table only sends its position', () => {
    const c = editView()
    const b = zoneDraft(c, diningRoomOf(c))
    const [first] = b.tables
    if (!first) throw new Error('missing')
    b.tables = b.tables.map((m) => (m.id === first.id ? move(m, 40, 300) : m))
    expect(zoneChanges(c, b)).toEqual([
      { entity: 'dining_tables', id: first.id, data: { x: 40, y: 300 } },
    ])
  })

  it('a new table takes the next free number of the restaurant and goes to the first free gap', () => {
    const c = editView()
    const b = zoneDraft(c, diningRoomOf(c))
    const names = c.tables.map((m) => m.name)
    const table = newTable(b, 'rectangular', names)
    expect(table).toMatchObject({ name: '3', width: 160, height: 80, capacity: 6, rotation: 0 })
    // In the first free gap of the row, 40 cm from table 2 (which ends at x = 200).
    expect(table).toMatchObject({ x: 240, y: 0 })
    b.tables.push(table)
    const [change] = zoneChanges(c, b)
    expect(change).toMatchObject({
      entity: 'dining_tables',
      id: table.id,
      data: { zone_id: b.id, name: '3', shape: 'rectangular', capacity: 6, active: true },
    })
  })

  it('nextName skips the used ones regardless of case', () => {
    expect(nextName(['1', '2', '4'])).toBe('3')
    expect(nextName([])).toBe('1')
  })

  it('a text element carries its text; the others, null', () => {
    const c = editView()
    const b = zoneDraft(c, diningRoomOf(c))
    const t = newElement(b, 'text')
    const p = newElement(b, 'door')
    b.elements.push({ ...t, text: ' Baños ' }, p)
    const changes = zoneChanges(c, b)
    expect(changes.find((x) => x.id === t.id)?.data.text).toBe('Baños')
    expect(changes.find((x) => x.id === p.id)?.data.text).toBeNull()
  })

  it('removing a table archives it; a new one removed before saving does not travel', () => {
    const c = editView()
    const b = zoneDraft(c, diningRoomOf(c))
    const [first] = b.tables
    if (!first) throw new Error('missing')
    b.tables = b.tables.map((m) => (m.id === first.id ? { ...m, active: false } : m))
    b.tables.push({ ...newTable(b, 'square', []), active: false })
    expect(zoneChanges(c, b)).toEqual([
      { entity: 'dining_tables', id: first.id, data: { active: false } },
    ])
  })

  it('archiving the zone archives its tables and elements first (the hub does not allow a zone with tables)', () => {
    const c = editView()
    const b = { ...zoneDraft(c, diningRoomOf(c)), active: false }
    const changes = zoneChanges(c, b)
    expect(changes.map((x) => x.entity)).toEqual([
      'dining_tables',
      'dining_tables',
      'floor_plan_elements',
      'zones',
    ])
    expect(changes.every((x) => x.data.active === false)).toBe(true)
  })

  it('a new zone goes before its tables', () => {
    const c = editView()
    const b = newZone(c)
    b.name = 'Segundo piso'
    b.level = 2
    b.tables.push(newTable(b, 'square', ['1']))
    const changes = zoneChanges(c, b)
    expect(changes[0]).toEqual({
      entity: 'zones',
      id: b.id,
      data: { name: 'Segundo piso', level: 2, position: 2, active: true },
    })
    expect(changes[1]?.entity).toBe('dining_tables')
  })

  it('does not allow two tables with the same name, not even across zones', () => {
    const c = editView()
    const b = zoneDraft(c, diningRoomOf(c))
    expect(zoneIssues(c, b)).toEqual([])
    b.tables.push({ ...newTable(b, 'square', []), name: '10' })
    expect(zoneIssues(c, b)).toEqual(['Hay dos mesas que se llaman «10»'])
    b.name = ' '
    expect(zoneIssues(c, b)[0]).toBe('Falta el nombre de la zona')
  })
})

describe('menu saved by an earlier version of the app', () => {
  it('is completed with what it is missing instead of breaking the screen', () => {
    const old = {
      version: 3,
      restaurant: { name: 'X', sessionIdleMin: 30 },
      zones: [{ id: 'Z', name: 'Salón' }],
      tables: [{ id: 'M', zoneId: 'Z', name: '1', x: 0, y: 0, shape: 'square', capacity: 4 }],
      stations: [],
      categories: [],
    } as unknown as Parameters<typeof completeCatalog>[0]
    const c = completeCatalog(old)
    expect(c.elements).toEqual([])
    expect(c.staff).toEqual([])
    expect(c.zones[0]?.level).toBe(1)
    expect(c.tables[0]).toMatchObject({ width: 80, height: 80, rotation: 0 })
  })
})

describe('several tables at once', () => {
  it('places N tables in rows, with consecutive numbers that do not clash with the used ones', () => {
    const c = editView()
    const b = { ...newZone(c), name: 'Patio' }
    const tables = severalTables(b, 'square', 7, 3, ['1', '2', '4'])
    expect(tables.map((m) => m.name)).toEqual(['3', '5', '6', '7', '8', '9', '10'])
    expect(new Set(tables.map((m) => m.y)).size).toBe(3)
    expect(tables.filter((m) => m.y === tables[0]?.y)).toHaveLength(3)
    // None on top of another.
    expect(new Set(tables.map((m) => `${m.x},${m.y}`)).size).toBe(7)
    expect(tables.every((m) => m.x % 10 === 0 && m.y % 10 === 0)).toBe(true)
  })
})
