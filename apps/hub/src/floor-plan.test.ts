import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { setupAccess } from './access/setup'
import { readCatalog } from './catalog'
import { readMenu } from './seed/menu'
import { seed } from './seed/seed'
import { createAppServer } from './server'

// Editing the dining room floor plan (task 1.2): zones, tables and elements, with their rules.

const MENU = readMenu(
  readFileSync(
    fileURLToPath(new URL('../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
    'utf8',
  ),
)

async function setup(occupiedIds: string[] = []) {
  const m = setupAccess()
  seed(
    m.db,
    m.access,
    { restaurantId: m.restaurantId, roles: m.roles, menu: MENU, withoutStaff: true },
    m.clock(),
  )
  const app = createAppServer({
    access: m.access,
    catalog: {
      db: m.db,
      restaurantId: m.restaurantId,
      access: m.access,
      clock: m.clock,
      occupiedTable: (id) => occupiedIds.includes(id),
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
  return { ...m, edit, catalog }
}

const table = (zoneId: string, name: string, fields: Record<string, unknown> = {}) => ({
  entity: 'dining_tables',
  id: newId(),
  data: {
    zone_id: zoneId,
    name,
    shape: 'round',
    x: 0,
    y: 0,
    width: 90,
    height: 90,
    rotation: 0,
    capacity: 2,
    active: true,
    ...fields,
  },
})

describe('floor plan', () => {
  it('creates a zone with its tables and a wall in a single save; the hub sets the location', async () => {
    const m = await setup()
    const zone = newId()
    const r = await m.edit([
      { entity: 'zones', id: zone, data: { name: 'Terraza', position: 1, level: 1, active: true } },
      table(zone, 'T1', { x: 100, rotation: 45 }),
      table(zone, 'T2', { shape: 'rectangular', width: 160 }),
      {
        entity: 'floor_plan_elements',
        id: newId(),
        data: {
          zone_id: zone,
          type: 'wall',
          text: null,
          x: 0,
          y: 300,
          width: 500,
          height: 20,
          rotation: 0,
          active: true,
        },
      },
    ])
    expect(r.code).toBe(200)
    const c = m.catalog()
    expect(c.zones.map((z) => z.name)).toEqual(['Salón', 'Terraza'])
    expect(
      c.tables
        .filter((x) => x.zoneId === zone)
        .map((x) => [x.name, x.rotation])
        .sort(),
    ).toEqual([
      ['T1', 45],
      ['T2', 0],
    ])
    expect(c.elements).toEqual([
      expect.objectContaining({ zoneId: zone, type: 'wall', width: 500 }),
    ])
  })

  it('two active tables cannot share a name, even in different zones', async () => {
    const m = await setup()
    const diningRoom = m.catalog().zones[0]?.id as string
    const r = await m.edit([table(diningRoom, '1')])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/dos mesas que se llaman «1»/)
    // Archiving the old one and creating another with its name works.
    const old = m.catalog().tables.find((x) => x.name === '1')
    const r2 = await m.edit([
      { entity: 'dining_tables', id: old?.id, data: { active: false } },
      table(diningRoom, '1'),
    ])
    expect(r2.code).toBe(200)
  })

  it('a table with an open order cannot be archived, nor a zone with active tables', async () => {
    const occupiedIds: string[] = []
    const m = await setup(occupiedIds)
    const takenPath = m.catalog().tables[0]?.id as string
    occupiedIds.push(takenPath)
    const r = await m.edit([{ entity: 'dining_tables', id: takenPath, data: { active: false } }])
    expect(r.code).toBe(400)
    expect(r.body.message).toMatch(/tiene un pedido abierto/)
    const diningRoom = m.catalog().zones[0]?.id as string
    const r2 = await m.edit([{ entity: 'zones', id: diningRoom, data: { active: false } }])
    expect(r2.body.message).toMatch(/lo usan 25 mesas/)
  })

  it("archiving the zone along with its tables removes it, with its tables and elements, from the devices' catalog", async () => {
    const m = await setup()
    const c = m.catalog()
    const diningRoom = c.zones[0]?.id as string
    const r = await m.edit([
      ...c.tables.map((x) => ({ entity: 'dining_tables', id: x.id, data: { active: false } })),
      { entity: 'zones', id: diningRoom, data: { active: false } },
    ])
    expect(r.code).toBe(200)
    expect(m.catalog()).toMatchObject({ zones: [], tables: [], elements: [] })
  })

  it('rejects out-of-range or decimal geometry, and unknown shapes or types', async () => {
    const m = await setup()
    const diningRoom = m.catalog().zones[0]?.id as string
    for (const fields of [
      { x: 0.5 },
      { width: 2 },
      { rotation: 360 },
      { shape: 'triangular' },
      { capacity: 0 },
    ])
      expect((await m.edit([table(diningRoom, 'X', fields)])).code).toBe(400)
  })

  it('the catalog returns the active staff with name and nothing else', async () => {
    const m = await setup()
    const staff = m.catalog().staff
    expect(staff.length).toBeGreaterThan(0)
    for (const p of staff) expect(Object.keys(p).sort()).toEqual(['id', 'name'])
  })
})
