import { newId } from '@pos/core'
import { add, diffs } from './drafts'
import type { CatalogChange, EditableCatalog, ElementType, Geometry, TableShape } from './engine'

// The floor plan (task 1.2): geometry is in centimeters (x, y of the top-left corner, width,
// height and rotation around the center). The editor works on a draft of each zone; on save only
// the changes come out. Whatever is removed is archived.

/** The editor's grid: everything moves and measures in steps of 10 cm. */
export const GRID = 10
export const MIN_SIZE = 20
const LIMIT = 10_000

export const adjust = (n: number, step = GRID) => Math.round(n / step) * step
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

export interface FloorPlanTable extends Geometry {
  id: string
  fresh: boolean
  name: string
  shape: TableShape
  capacity: number
  active: boolean
}

export interface FloorPlanElement extends Geometry {
  id: string
  fresh: boolean
  type: ElementType
  text: string | null
  active: boolean
}

export interface ZoneDraft {
  id: string
  fresh: boolean
  name: string
  level: number
  position: number
  active: boolean
  tables: FloorPlanTable[]
  elements: FloorPlanElement[]
}

const geometry = (g: Geometry): Geometry => ({
  x: g.x,
  y: g.y,
  width: g.width,
  height: g.height,
  rotation: g.rotation,
})

export function zoneDraft(c: EditableCatalog, id: string): ZoneDraft {
  const z = c.zones.find((x) => x.id === id)
  if (!z) throw new Error('Esa zona no existe')
  return {
    id,
    fresh: false,
    name: z.name,
    level: z.level,
    position: z.position,
    active: z.active,
    tables: c.tables
      .filter((m) => m.zone_id === id && m.active)
      .map((m) => ({
        id: m.id,
        fresh: false,
        name: m.name,
        shape: m.shape,
        capacity: m.capacity,
        active: true,
        ...geometry(m),
      })),
    elements: c.elements
      .filter((e) => e.zone_id === id && e.active)
      .map((e) => ({
        id: e.id,
        fresh: false,
        type: e.type,
        text: e.text,
        active: true,
        ...geometry(e),
      })),
  }
}

export const newZone = (c: EditableCatalog): ZoneDraft => ({
  id: newId(),
  fresh: true,
  name: '',
  level: 1,
  position: c.zones.length,
  active: true,
  tables: [],
  elements: [],
})

/** The rectangle covering everything active, with a margin: what the canvas shows. */
export function bounds(things: readonly Geometry[], margin = 40) {
  if (things.length === 0) return { x: 0, y: 0, width: 600, height: 400 }
  // With rotation, a shape's bounding box grows; the circle that contains it is used.
  const boxes = things.map((g) => {
    const angle = g.rotation % 180 !== 0
    const side = angle ? Math.hypot(g.width, g.height) : 0
    const cx = g.x + g.width / 2
    const cy = g.y + g.height / 2
    const halfWidth = angle ? side / 2 : g.width / 2
    const halfHeight = angle ? side / 2 : g.height / 2
    return { x0: cx - halfWidth, y0: cy - halfHeight, x1: cx + halfWidth, y1: cy + halfHeight }
  })
  const x0 = Math.min(...boxes.map((c) => c.x0)) - margin
  const y0 = Math.min(...boxes.map((c) => c.y0)) - margin
  const x1 = Math.max(...boxes.map((c) => c.x1)) + margin
  const y1 = Math.max(...boxes.map((c) => c.y1)) + margin
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** Initial size of each table shape, in cm, and how many sit at it. */
export const SHAPES: Record<
  TableShape,
  { name: string; width: number; height: number; capacity: number }
> = {
  square: { name: 'Cuadrada', width: 80, height: 80, capacity: 4 },
  round: { name: 'Redonda', width: 90, height: 90, capacity: 4 },
  rectangular: { name: 'Rectangular', width: 160, height: 80, capacity: 6 },
  bar: { name: 'Puesto de barra', width: 50, height: 50, capacity: 1 },
}

export const ELEMENT_TYPES: Record<ElementType, { name: string; width: number; height: number }> = {
  wall: { name: 'Pared', width: 300, height: 20 },
  door: { name: 'Puerta', width: 90, height: 20 },
  plant: { name: 'Planta', width: 50, height: 50 },
  bar: { name: 'Mostrador', width: 300, height: 60 },
  text: { name: 'Texto', width: 150, height: 40 },
}

/** The first number not used by any active table in the restaurant (in any zone). */
export function nextName(names: readonly string[]): string {
  const used = new Set(names.map((n) => n.trim().toLowerCase()))
  let n = 1
  while (used.has(String(n))) n += 1
  return String(n)
}

/** A typical room is about 15 m wide: new things are laid out in rows of that width. */
const USUAL_WIDTH = 1500
const SPACING = 40

/**
 * Where to put something new of that size: the first free gap, scanning rows left to right and
 * top to bottom, leaving 40 cm from what is already there. That way a room that fills up keeps
 * filling in rows (not in a single column) and nothing leaves the bounds the hub accepts.
 */
function freeSpot(b: ZoneDraft, width: number, height: number) {
  const taken = [...b.tables, ...b.elements]
    .filter((x) => x.active)
    .map((g) => {
      const c = bounds([g], 0)
      return {
        x0: c.x - SPACING,
        y0: c.y - SPACING,
        x1: c.x + c.width + SPACING,
        y1: c.y + c.height + SPACING,
      }
    })
  if (taken.length === 0) return { x: 0, y: 0 }
  const x0 = adjust(Math.min(...taken.map((o) => o.x0)) + SPACING)
  const y0 = adjust(Math.min(...taken.map((o) => o.y0)) + SPACING)
  const free = (x: number, y: number) =>
    taken.every((o) => x + width <= o.x0 || x >= o.x1 || y + height <= o.y0 || y >= o.y1)
  const step = GRID * 2
  const untilX = Math.max(x0 + USUAL_WIDTH, x0 + width)
  for (let y = y0; y + height <= LIMIT; y += step)
    for (let x = x0; x + width <= untilX; x += step) if (free(x, y)) return { x, y }
  // The room is full to the limit: put it at the top left and arrange it by hand.
  return { x: x0, y: y0 }
}

export function newTable(
  b: ZoneDraft,
  shape: TableShape,
  usedNames: readonly string[],
): FloorPlanTable {
  const f = SHAPES[shape]
  return {
    id: newId(),
    fresh: true,
    name: nextName(usedNames),
    shape,
    capacity: f.capacity,
    active: true,
    width: f.width,
    height: f.height,
    rotation: 0,
    ...freeSpot(b, f.width, f.height),
  }
}

/**
 * Several identical tables at once, in rows, with the next numbers: drawing a room of 25 tables
 * takes a few taps, and then the ones that don't go on the grid are arranged.
 */
export function severalTables(
  b: ZoneDraft,
  shape: TableShape,
  quantity: number,
  perRow: number,
  usedNames: readonly string[],
): FloorPlanTable[] {
  const f = SHAPES[shape]
  const spacing = SPACING
  const columns = Math.max(1, Math.min(perRow, quantity))
  const rows = Math.ceil(quantity / columns)
  // The whole block in a free gap, so the new tables don't land on top of others.
  const start = freeSpot(
    b,
    columns * (f.width + spacing) - spacing,
    rows * (f.height + spacing) - spacing,
  )
  const takenNames = [...usedNames]
  return Array.from({ length: quantity }, (_, i) => {
    const name = nextName(takenNames)
    takenNames.push(name)
    const row = Math.floor(i / columns)
    const column = i % columns
    return {
      id: newId(),
      fresh: true,
      name,
      shape,
      capacity: f.capacity,
      active: true,
      width: f.width,
      height: f.height,
      rotation: 0,
      x: adjust(start.x + column * (f.width + spacing)),
      y: adjust(start.y + row * (f.height + spacing)),
    }
  })
}

export function newElement(b: ZoneDraft, type: ElementType): FloorPlanElement {
  const t = ELEMENT_TYPES[type]
  return {
    id: newId(),
    fresh: true,
    type,
    text: type === 'text' ? 'Texto' : null,
    active: true,
    width: t.width,
    height: t.height,
    rotation: 0,
    ...freeSpot(b, t.width, t.height),
  }
}

/** Move, rotate or resize, always on the grid and within the bounds. */
/** A non-number (e.g. from an empty field) leaves the value as it was; ±∞ is clamped. */
const numberOr = (n: number, yes: number) => (Number.isNaN(n) ? yes : n)

export function move<T extends Geometry>(g: T, x: number, y: number): T {
  return {
    ...g,
    x: clamp(adjust(numberOr(x, g.x)), -LIMIT, LIMIT),
    y: clamp(adjust(numberOr(y, g.y)), -LIMIT, LIMIT),
  }
}

export function rotate<T extends Geometry>(g: T, degrees: number): T {
  return { ...g, rotation: (((g.rotation + degrees) % 360) + 360) % 360 }
}

export function measure<T extends Geometry>(g: T, width: number, height: number): T {
  return {
    ...g,
    width: clamp(adjust(numberOr(width, g.width)), MIN_SIZE, LIMIT),
    height: clamp(adjust(numberOr(height, g.height)), MIN_SIZE, LIMIT),
  }
}

/** What prevents saving the zone, in words for the person. */
export function zoneIssues(c: EditableCatalog, b: ZoneDraft): string[] {
  const issues: string[] = []
  if (!b.name.trim()) issues.push('Falta el nombre de la zona')
  const tables = b.tables.filter((m) => m.active)
  if (tables.some((m) => !m.name.trim())) issues.push('Cada mesa lleva nombre')
  // The waiter says "la 12": there cannot be two, neither in this zone nor in another.
  const fromOtherZones = c.tables.filter((m) => m.active && m.zone_id !== b.id).map((m) => m.name)
  const names = [...fromOtherZones, ...tables.map((m) => m.name)].map((n) =>
    n.trim().normalize('NFC').toLocaleLowerCase('es'),
  )
  const duplicate = names.find((n, i) => n && names.indexOf(n) !== i)
  if (duplicate) issues.push(`Hay dos mesas que se llaman «${duplicate}»`)
  if (tables.some((m) => m.capacity < 1)) issues.push('Cada mesa es para al menos una persona')
  return issues
}

/** The changes to make the zone match the draft. Archiving the zone archives what it holds. */
export function zoneChanges(c: EditableCatalog, b: ZoneDraft): CatalogChange[] {
  const changes: CatalogChange[] = []
  const original = b.fresh ? undefined : c.zones.find((z) => z.id === b.id)
  const archive = !b.active
  // Contents first: the hub does not allow archiving a zone with active tables.
  for (const m of b.tables) {
    if (m.fresh && (!m.active || archive)) continue
    const before = m.fresh ? undefined : c.tables.find((x) => x.id === m.id)
    add(
      changes,
      'dining_tables',
      m.id,
      diffs(before, {
        zone_id: b.id,
        name: m.name.trim(),
        shape: m.shape,
        capacity: m.capacity,
        ...geometry(m),
        active: m.active && !archive,
      }),
    )
  }
  for (const e of b.elements) {
    if (e.fresh && (!e.active || archive)) continue
    const before = e.fresh ? undefined : c.elements.find((x) => x.id === e.id)
    add(
      changes,
      'floor_plan_elements',
      e.id,
      diffs(before, {
        zone_id: b.id,
        type: e.type,
        text: e.type === 'text' ? (e.text?.trim() ?? '') : null,
        ...geometry(e),
        active: e.active && !archive,
      }),
    )
  }
  const zone = {
    entity: 'zones' as const,
    id: b.id,
    data: diffs(original, {
      name: b.name.trim(),
      level: b.level,
      position: b.position,
      active: b.active,
    }),
  }
  // A new zone goes before its tables (the reference must exist); archiving it, after.
  if (Object.keys(zone.data).length > 0) {
    if (archive) changes.push(zone)
    else changes.unshift(zone)
  }
  return changes
}
