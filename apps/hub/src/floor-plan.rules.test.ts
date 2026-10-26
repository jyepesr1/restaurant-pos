import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { setupAccess } from './access/setup'
import { readCatalog } from './catalog'
import { catalogForEditing } from './catalog-editing'
import { MENU } from './catalog-fixtures'
import { seed } from './seed/seed'
import { createAppServer } from './server'

// Floor plan rules (task 1.2) beyond the happy path: changing zones, reactivating, names that
// almost repeat, large batches and what happens to the seed after someone draws the dining room.

// The type returned by `catalogForEditing` loses the columns when destructuring: declared here.
type Row = { id: string; name: string; version: number; active: boolean; zone_id: string }
type Edit = { version: number; zones: Row[]; tables: Row[]; elements: Row[] }

async function setup() {
  const m = setupAccess()
  const seedDiningRoom = () =>
    seed(
      m.db,
      m.access,
      { restaurantId: m.restaurantId, roles: m.roles, menu: MENU, withoutStaff: true },
      m.clock(),
    )
  seedDiningRoom()
  const alerts: number[] = []
  const app = createAppServer({
    access: m.access,
    catalog: {
      db: m.db,
      restaurantId: m.restaurantId,
      access: m.access,
      clock: m.clock,
      onChange: (v) => alerts.push(v),
    },
  })
  await app.ready()
  const register = m.pair('register')
  const s = m.signIn(register.connection, 'manager')
  const edit = async (changes: unknown[]) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/catalog/changes',
      headers: { authorization: `Bearer ${register.token}` },
      payload: { session_id: s.sessionId, secret: s.secret, changes },
    })
    return { code: r.statusCode, body: r.json() }
  }
  const catalog = () => readCatalog(m.db, m.restaurantId)
  const editView = () => catalogForEditing(m.db, m.restaurantId) as unknown as Edit
  const diningRoom = () => catalog().zones[0]?.id as string
  return { ...m, app, edit, catalog, editView, diningRoom, alerts, seedDiningRoom }
}

const GEO = { x: 0, y: 0, width: 90, height: 90, rotation: 0 }
const table = (zoneId: string, name: string, fields: Record<string, unknown> = {}) => ({
  entity: 'dining_tables',
  id: newId(),
  data: {
    zone_id: zoneId,
    name,
    shape: 'round',
    capacity: 2,
    active: true,
    ...GEO,
    ...fields,
  },
})
const zone = (name: string, fields: Record<string, unknown> = {}) => ({
  entity: 'zones',
  id: newId(),
  data: { name, position: 1, level: 1, active: true, ...fields },
})
const element = (zoneId: string, fields: Record<string, unknown> = {}) => ({
  entity: 'floor_plan_elements',
  id: newId(),
  data: { zone_id: zoneId, type: 'wall', text: null, ...GEO, active: true, ...fields },
})

describe('moving a table or an element to another zone', () => {
  it('the table moves to the other zone with its name and geometry, and each zone sees it on its side', async () => {
    const m = await setup()
    const patio = zone('Terraza')
    expect((await m.edit([patio])).code).toBe(200)
    const one = m.catalog().tables.find((x) => x.name === '1')
    expect(one).toBeDefined()
    const r = await m.edit([{ entity: 'dining_tables', id: one?.id, data: { zone_id: patio.id } }])
    expect(r.code).toBe(200)
    const movedTable = m.catalog().tables.find((x) => x.id === one?.id)
    expect(movedTable).toMatchObject({ zoneId: patio.id, name: '1', x: one?.x, y: one?.y })
    expect(m.catalog().tables.filter((x) => x.zoneId === m.diningRoom())).toHaveLength(24)
    expect(m.catalog().tables.filter((x) => x.zoneId === patio.id)).toHaveLength(1)
  })

  it('moving it and changing its geometry in a single save also works, and bumps its version', async () => {
    const m = await setup()
    const patio = zone('Terraza')
    await m.edit([patio])
    const before = m.editView().tables.find((x) => x.name === '2')
    const r = await m.edit([
      {
        entity: 'dining_tables',
        id: before?.id,
        data: { zone_id: patio.id, x: 500, rotation: 90 },
      },
    ])
    expect(r).toMatchObject({ code: 200, body: { changedCount: 1 } })
    const after = m.editView().tables.find((x) => x.id === before?.id)
    expect(after).toMatchObject({ zone_id: patio.id, x: 500, rotation: 90 })
    expect(Number(after?.version)).toBeGreaterThan(Number(before?.version))
  })

  it('cannot be moved to an archived zone or to one that does not exist', async () => {
    const m = await setup()
    const emptyOne = zone('Vacía')
    await m.edit([emptyOne])
    await m.edit([{ entity: 'zones', id: emptyOne.id, data: { active: false } }])
    const one = m.catalog().tables[0]?.id
    const toArchived = await m.edit([
      { entity: 'dining_tables', id: one, data: { zone_id: emptyOne.id } },
    ])
    expect(toArchived.code).toBe(400)
    expect(toArchived.body.message).toMatch(/zone está archivado/)
    const toNone = await m.edit([{ entity: 'dining_tables', id: one, data: { zone_id: newId() } }])
    expect(toNone.body.message).toMatch(/zone_id no existe/)
    // Nothing moved.
    expect(m.catalog().tables.find((x) => x.id === one)?.zoneId).toBe(m.diningRoom())
  })

  it('a single save can empty the old zone: move its tables and archive it', async () => {
    const m = await setup()
    const newOne = zone('Nueva', { position: 0 })
    const diningRoom = m.diningRoom()
    const r = await m.edit([
      newOne,
      ...m.catalog().tables.map((x) => ({
        entity: 'dining_tables',
        id: x.id,
        data: { zone_id: newOne.id },
      })),
      { entity: 'zones', id: diningRoom, data: { active: false } },
    ])
    expect(r.code).toBe(200)
    expect(m.catalog().zones.map((z) => z.name)).toEqual(['Nueva'])
    expect(m.catalog().tables).toHaveLength(25)
  })

  it('a floor plan element also changes zones', async () => {
    const m = await setup()
    const a = zone('A')
    const wall = element(a.data.name === 'A' ? m.diningRoom() : '')
    await m.edit([a, wall])
    expect(
      (await m.edit([{ entity: 'floor_plan_elements', id: wall.id, data: { zone_id: a.id } }]))
        .code,
    ).toBe(200)
    expect(m.catalog().elements.find((e) => e.id === wall.id)?.zoneId).toBe(a.id)
  })
})

describe('reactivating archived records', () => {
  it('an archived zone comes back alone, empty: its tables stay archived until reactivated', async () => {
    const m = await setup()
    const t = zone('Terraza')
    const t1 = table(t.id, 'T1')
    const wall = element(t.id)
    await m.edit([t, t1, wall])
    await m.edit([
      { entity: 'dining_tables', id: t1.id, data: { active: false } },
      { entity: 'floor_plan_elements', id: wall.id, data: { active: false } },
      { entity: 'zones', id: t.id, data: { active: false } },
    ])
    expect(m.catalog().zones.map((z) => z.name)).toEqual(['Salón'])

    expect((await m.edit([{ entity: 'zones', id: t.id, data: { active: true } }])).code).toBe(200)
    expect(m.catalog().zones.map((z) => z.name)).toEqual(['Salón', 'Terraza'])
    expect(m.catalog().tables.filter((x) => x.zoneId === t.id)).toEqual([])
    expect(m.catalog().elements).toEqual([])

    // Reactivate table and element, now that the zone is active.
    const r = await m.edit([
      { entity: 'dining_tables', id: t1.id, data: { active: true } },
      { entity: 'floor_plan_elements', id: wall.id, data: { active: true } },
    ])
    expect(r.code).toBe(200)
    expect(
      m
        .catalog()
        .tables.filter((x) => x.zoneId === t.id)
        .map((x) => x.name),
    ).toEqual(['T1'])
    expect(m.catalog().elements.map((e) => e.id)).toEqual([wall.id])
  })

  it('reactivating the zone and its tables in a single save works', async () => {
    const m = await setup()
    const t = zone('Terraza')
    const t1 = table(t.id, 'T1')
    await m.edit([t, t1])
    await m.edit([
      { entity: 'dining_tables', id: t1.id, data: { active: false } },
      { entity: 'zones', id: t.id, data: { active: false } },
    ])
    const r = await m.edit([
      { entity: 'dining_tables', id: t1.id, data: { active: true } },
      { entity: 'zones', id: t.id, data: { active: true } },
    ])
    expect(r.code).toBe(200)
    expect(m.catalog().tables.some((x) => x.id === t1.id)).toBe(true)
  })

  it('a table inside a zone that is still archived is not reactivated', async () => {
    const m = await setup()
    const t = zone('Terraza')
    const t1 = table(t.id, 'T1')
    await m.edit([t, t1])
    await m.edit([
      { entity: 'dining_tables', id: t1.id, data: { active: false } },
      { entity: 'zones', id: t.id, data: { active: false } },
    ])
    const r = await m.edit([{ entity: 'dining_tables', id: t1.id, data: { active: true } }])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/zone está archivado/)
  })

  it('a table whose name another active table took is not reactivated', async () => {
    const m = await setup()
    const s = m.diningRoom()
    const old = table(s, 'Barra 1')
    await m.edit([old])
    await m.edit([{ entity: 'dining_tables', id: old.id, data: { active: false } }])
    await m.edit([table(s, 'barra 1')])
    const r = await m.edit([{ entity: 'dining_tables', id: old.id, data: { active: true } }])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/dos mesas que se llaman/)
    expect(m.editView().tables.find((x) => x.id === old.id)?.active).toBe(false)
  })

  it('reactivating something already active changes nothing and does not notify devices', async () => {
    const m = await setup()
    const before = m.catalog().version
    const r = await m.edit([{ entity: 'zones', id: m.diningRoom(), data: { active: true } }])
    expect(r).toMatchObject({ code: 200, body: { changedCount: 0, version: before } })
    expect(m.alerts).toEqual([])
  })
})

describe('table names that almost repeat', () => {
  it.each([
    ['differs only in case', 'T1', 't1'],
    ['differs only in case (all of it)', 'MESA A', 'mesa a'],
    ['with spaces at the start and end', '70', '  70  '],
    ['with spaces and uppercase', 'Barra', ' BARRA '],
  ])('%s: rejected', async (_case, firstOne, secondOne) => {
    const m = await setup()
    const s = m.diningRoom()
    expect((await m.edit([table(s, firstOne)])).code).toBe(200)
    const r = await m.edit([table(s, secondOne)])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/dos mesas que se llaman/)
  })

  it('it is also detected within the same save, and neither is applied', async () => {
    const m = await setup()
    const before = m.catalog().tables.length
    const r = await m.edit([table(m.diningRoom(), 'X1'), table(m.diningRoom(), 'x1')])
    expect(r.code).toBe(400)
    expect(m.catalog().tables).toHaveLength(before)
  })

  it('swapping names between two tables in a single save works (checked at the end)', async () => {
    const m = await setup()
    const [a, b] = m.catalog().tables
    const r = await m.edit([
      { entity: 'dining_tables', id: a?.id, data: { name: b?.name } },
      { entity: 'dining_tables', id: b?.id, data: { name: a?.name } },
    ])
    expect(r.code).toBe(200)
    const now = m.catalog().tables
    expect(now.find((x) => x.id === a?.id)?.name).toBe(b?.name)
    expect(now.find((x) => x.id === b?.id)?.name).toBe(a?.name)
  })

  it('renaming a table to the name of another is rejected; to that of an archived one, it is not', async () => {
    const m = await setup()
    const [a, b] = m.catalog().tables
    const uppercase = await m.edit([
      { entity: 'dining_tables', id: a?.id, data: { name: `${b?.name} ` } },
    ])
    expect(uppercase.code).toBe(400)
    await m.edit([{ entity: 'dining_tables', id: b?.id, data: { active: false } }])
    const free = await m.edit([
      { entity: 'dining_tables', id: a?.id, data: { name: String(b?.name) } },
    ])
    expect(free.code).toBe(200)
  })

  it('a name of only spaces, empty or longer than 20 characters is rejected; 20 works', async () => {
    const m = await setup()
    const s = m.diningRoom()
    for (const name of ['', '   ', 'x'.repeat(21)])
      expect((await m.edit([table(s, name)])).code, name).toBe(400)
    expect((await m.edit([table(s, 'y'.repeat(20))])).code).toBe(200)
    // The name is saved without surrounding spaces.
    expect((await m.edit([table(s, '  Alta  ')])).code).toBe(200)
    expect(m.catalog().tables.some((x) => x.name === 'Alta')).toBe(true)
  })

  it('spaces in the middle do make another name (not normalized)', async () => {
    const m = await setup()
    const s = m.diningRoom()
    expect((await m.edit([table(s, 'Mesa 1')])).code).toBe(200)
    expect((await m.edit([table(s, 'Mesa  1')])).code).toBe(200)
  })

  // Found by qa-pruebas in 1.2 and already fixed: SQLite's lower() only knows ASCII, so
  // «Ñandú» and «ñandú» did not clash on the hub even though the screen saw them as equal.
  it('uppercase and lowercase accents and ñ also clash', async () => {
    const m = await setup()
    const s = m.diningRoom()
    expect((await m.edit([table(s, 'Ñandú')])).code).toBe(200)
    expect((await m.edit([table(s, 'ñandú')])).code).toBe(400)
  })

  it('zones can be named like a table and two zones can share a name', async () => {
    // Documents what the hub allows today: unique names apply only to tables.
    const m = await setup()
    expect((await m.edit([zone('Salón')])).code).toBe(200)
    expect((await m.edit([zone('1')])).code).toBe(200)
  })
})

describe('large batch of changes', () => {
  it('200 tables in a single save, with their numbers, are all kept and notify only once', async () => {
    const m = await setup()
    const s = m.diningRoom()
    const newZone = zone('Eventos')
    const tables = Array.from({ length: 199 }, (_, i) =>
      table(newZone.id, `E${i + 1}`, { x: (i % 20) * 100, y: Math.floor(i / 20) * 100 }),
    )
    const before = m.catalog().version
    const r = await m.edit([newZone, ...tables])
    expect(r).toMatchObject({ code: 200, body: { changedCount: 200 } })
    expect(r.body.version).toBe(before + 200)
    expect(m.alerts).toEqual([before + 200])
    const savedTables = m.catalog().tables.filter((x) => x.zoneId === newZone.id)
    expect(savedTables).toHaveLength(199)
    expect(new Set(savedTables.map((x) => x.name)).size).toBe(199)
    expect(m.catalog().tables.filter((x) => x.zoneId === s)).toHaveLength(25)
    // The same save again changes nothing.
    const another = await m.edit([newZone, ...tables])
    expect(another).toMatchObject({ code: 200, body: { changedCount: 0 } })
  })

  it('201 changes are rejected as a whole', async () => {
    const m = await setup()
    const before = m.catalog().version
    const r = await m.edit(Array.from({ length: 201 }, (_, i) => table(m.diningRoom(), `Z${i}`)))
    expect(r.code).toBe(400)
    expect(m.catalog().version).toBe(before)
  })

  it('a single bad change after 150 good ones leaves everything as it was', async () => {
    const m = await setup()
    const before = { version: m.catalog().version, tables: m.editView().tables.length }
    const goodOnes = Array.from({ length: 150 }, (_, i) => table(m.diningRoom(), `B${i}`))
    const r = await m.edit([...goodOnes, table(m.diningRoom(), 'Mala', { rotation: 360 })])
    expect(r.code).toBe(400)
    expect(m.catalog().version).toBe(before.version)
    expect(m.editView().tables).toHaveLength(before.tables)
  })

  it('a repeated name hidden among 150 new tables brings down the whole batch', async () => {
    const m = await setup()
    const before = m.editView().tables.length
    const goodOnes = Array.from({ length: 150 }, (_, i) => table(m.diningRoom(), `B${i}`))
    const r = await m.edit([...goodOnes, table(m.diningRoom(), 'b77')])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/dos mesas que se llaman «B77»|«b77»/i)
    expect(m.editView().tables).toHaveLength(before)
  })

  it('archiving all 25 tables at once and creating 25 new ones with the same names works', async () => {
    const m = await setup()
    const s = m.diningRoom()
    const oldOnes = m.catalog().tables
    const r = await m.edit([
      ...oldOnes.map((x) => ({ entity: 'dining_tables', id: x.id, data: { active: false } })),
      ...oldOnes.map((x) => table(s, x.name, { x: x.x, y: x.y })),
    ])
    expect(r.code).toBe(200)
    expect(m.catalog().tables).toHaveLength(25)
    expect(m.editView().tables).toHaveLength(50)
    expect(new Set(m.catalog().tables.map((x) => x.id)).size).toBe(25)
  })

  it('each touched record in the batch bumps its version only once and the versions differ', async () => {
    const m = await setup()
    const newOnes = Array.from({ length: 40 }, (_, i) => table(m.diningRoom(), `V${i}`))
    await m.edit(newOnes)
    const versions = m.editView().tables.map((x) => Number(x.version))
    expect(new Set(versions).size).toBe(versions.length)
    expect(Math.max(...versions)).toBe(m.catalog().version)
  })
})

describe('the seed after drawing the dining room', () => {
  it('what a person moved, renamed or archived is not overwritten when the seed runs again', async () => {
    const m = await setup()
    const [a, b, c] = m.catalog().tables
    await m.edit([
      { entity: 'dining_tables', id: a?.id, data: { x: 777, name: 'Esquina' } },
      { entity: 'dining_tables', id: b?.id, data: { active: false } },
    ])
    m.seedDiningRoom()
    const now = m.editView().tables
    expect(now.find((x) => x.id === a?.id)).toMatchObject({ x: 777, name: 'Esquina' })
    expect(now.find((x) => x.id === b?.id)?.active).toBe(false)
    // The one nobody touched stays where the seed left it.
    expect(now.find((x) => x.id === c?.id)).toMatchObject({ x: c?.x, y: c?.y, active: true })
  })

  it('a zone with tables and elements drawn by a person is not archived when the seed runs again', async () => {
    const m = await setup()
    const t = zone('Terraza')
    const t1 = table(t.id, 'T1')
    const plant = element(t.id, { type: 'plant' })
    await m.edit([t, t1, plant])
    const before = m.catalog()
    const r = m.seedDiningRoom()
    expect(r.sqlTables.zones).toMatchObject({ archived: 0 })
    const after = m.catalog()
    expect(after.zones.map((z) => z.name)).toEqual(before.zones.map((z) => z.name))
    expect(after.tables.map((x) => x.id).sort()).toEqual(before.tables.map((x) => x.id).sort())
    expect(after.elements).toEqual(before.elements)
  })

  it('if the person archived the seed dining room (with its tables) and drew another, the seed does not bring it back', async () => {
    const m = await setup()
    const oldOnes = m.catalog().tables
    const newOne = zone('Nuevo salón', { position: 0 })
    await m.edit([
      newOne,
      ...oldOnes.map((x) => ({ entity: 'dining_tables', id: x.id, data: { active: false } })),
      { entity: 'zones', id: m.diningRoom(), data: { active: false } },
    ])
    m.seedDiningRoom()
    expect(m.catalog().zones.map((z) => z.name)).toEqual(['Nuevo salón'])
    expect(m.catalog().tables).toEqual([])
  })
})

describe('what the editor sees and what devices see', () => {
  it('the editor also gets archived records; devices, only active ones', async () => {
    const m = await setup()
    const t = zone('Terraza')
    const t1 = table(t.id, 'T1')
    const wall = element(t.id)
    await m.edit([t, t1, wall])
    await m.edit([
      { entity: 'dining_tables', id: t1.id, data: { active: false } },
      { entity: 'floor_plan_elements', id: wall.id, data: { active: false } },
      { entity: 'zones', id: t.id, data: { active: false } },
    ])
    const e = m.editView()
    expect(e.zones.find((z) => z.id === t.id)).toMatchObject({ active: false })
    expect(e.tables.find((x) => x.id === t1.id)).toMatchObject({ active: false })
    expect(e.elements.find((x) => x.id === wall.id)).toMatchObject({ active: false })
    const c = m.catalog()
    expect(c.zones.some((z) => z.id === t.id)).toBe(false)
    expect(c.tables.some((x) => x.id === t1.id)).toBe(false)
    expect(c.elements).toEqual([])
  })

  it('the editor does not return the location, the author or the creation date', async () => {
    const m = await setup()
    const e = m.editView()
    for (const row of [...e.zones, ...e.tables, ...e.elements]) {
      for (const field of ['location_id', 'restaurant_id', 'user_id', 'device_id', 'created_at'])
        expect(Object.keys(row)).not.toContain(field)
    }
  })

  it('zones come out by level, order and name; the tables in each zone from top to bottom', async () => {
    const m = await setup()
    const high = zone('Azotea', { level: 3, position: 0 })
    const basement = zone('Sótano', { level: -1, position: 5 })
    await m.edit([high, basement])
    expect(m.catalog().zones.map((z) => z.name)).toEqual(['Sótano', 'Salón', 'Azotea'])
    const rows = m.catalog().tables.filter((x) => x.zoneId === m.diningRoom())
    const sorted = [...rows].sort((p, q) => p.y - q.y || p.x - q.x)
    expect(rows.map((x) => x.id)).toEqual(sorted.map((x) => x.id))
  })

  it('an element of an archived zone with active elements is not sent to devices', async () => {
    // The hub lets a zone without tables be archived even with active elements; devices do not
    // see them.
    const m = await setup()
    const t = zone('Patio')
    const wall = element(t.id)
    await m.edit([t, wall])
    const r = await m.edit([{ entity: 'zones', id: t.id, data: { active: false } }])
    expect(r.code).toBe(200)
    expect(m.catalog().elements).toEqual([])
    expect(m.editView().elements.find((e) => e.id === wall.id)?.active).toBe(true)
  })

  it('creating an element in an archived zone is rejected', async () => {
    const m = await setup()
    const t = zone('Patio')
    await m.edit([t])
    await m.edit([{ entity: 'zones', id: t.id, data: { active: false } }])
    const r = await m.edit([element(t.id)])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/zone está archivado/)
  })
})

describe('floor plan elements: validation', () => {
  it.each([
    ['unknown type', { type: 'ventana' }],
    ['text longer than 60 characters', { type: 'text', text: 'x'.repeat(61) }],
    ['width below the minimum', { width: 4 }],
    ['height over 10 000', { height: 10_001 }],
    ['coordinate outside the dining room', { x: 10_001 }],
    ['coordinate with decimals', { y: 1.5 }],
    ['negative rotation', { rotation: -1 }],
    ['field that does not exist', { color: 'rojo' }],
  ])('%s is rejected', async (_case, fields) => {
    const m = await setup()
    const before = m.catalog().version
    expect((await m.edit([element(m.diningRoom(), fields)])).code).toBe(400)
    expect(m.catalog().version).toBe(before)
  })

  it('an element without zone or width is rejected when created (requires all fields)', async () => {
    const m = await setup()
    const incomplete = { entity: 'floor_plan_elements', id: newId(), data: { type: 'wall' } }
    expect((await m.edit([incomplete])).code).toBe(400)
  })

  it('an element id can match a table id: they are different tables and do not cross', async () => {
    // Today the hub only checks that an id is not of two types in the catalog history, and the
    // floor plan is not part of it. Noted so that a future change is deliberate.
    const m = await setup()
    const one = m.catalog().tables[0]
    const r = await m.edit([{ ...element(m.diningRoom()), id: one?.id }])
    expect(r.code).toBe(200)
    expect(m.catalog().tables.find((x) => x.id === one?.id)?.name).toBe(one?.name)
    expect(m.catalog().elements.some((e) => e.id === one?.id)).toBe(true)
  })

  it('it is updated piece by piece and archived', async () => {
    const m = await setup()
    const e = element(m.diningRoom(), { type: 'text', text: 'Baños' })
    await m.edit([e])
    expect(
      (await m.edit([{ entity: 'floor_plan_elements', id: e.id, data: { x: 40 } }])).code,
    ).toBe(200)
    expect(m.catalog().elements[0]).toMatchObject({ text: 'Baños', x: 40 })
    expect(
      (await m.edit([{ entity: 'floor_plan_elements', id: e.id, data: { active: false } }])).code,
    ).toBe(200)
    expect(m.catalog().elements).toEqual([])
  })

  it('an element text arrives without surrounding spaces', async () => {
    const m = await setup()
    await m.edit([element(m.diningRoom(), { type: 'text', text: '  Baños  ' })])
    expect(m.catalog().elements[0]?.text).toBe('Baños')
  })
})
