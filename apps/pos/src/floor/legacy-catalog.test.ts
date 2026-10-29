import 'fake-indexeddb/auto'
import { newId } from '@pos/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Device, Floor } from './engine'
import { DeviceDatabase } from './store'

// An app update must not leave the floor blank: the menu saved in IndexedDB by an earlier
// version (no floor plan, no elements, no staff) is completed on open, and so is the one that
// comes from an old hub. No network: the device does not connect.

const databases: DeviceDatabase[] = []
const floors: Floor[] = []

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const b of databases.splice(0)) await b.delete()
  floors.length = 0
})

/** Saves `catalog` as is in a new database and opens the floor on it. */
async function openWith(catalog: unknown, extra: { device?: Device } = {}) {
  const db = new DeviceDatabase(`old-${newId()}`)
  databases.push(db)
  if (catalog !== undefined) await db.saveSetting('catalog', catalog)
  if (extra.device) await db.saveSetting('device', extra.device)
  // A channel that never opens: no connection and no messages.
  const floor = new Floor({ db, open: () => ({ send: () => {}, close: () => {} }) })
  floors.push(floor)
  await floor.load()
  return { floor, db }
}

const base = {
  version: 3,
  restaurant: { name: 'La Spritzzería', sessionIdleMin: 30 },
  stations: [{ id: 'E', name: 'Cocina' }],
  categories: [],
}

describe('Floor.load() with a menu saved by an earlier version', () => {
  it.each([
    [
      'the one from task 0.9: zones without level, tables without size or rotation, no elements or staff',
      {
        ...base,
        zones: [{ id: 'Z', name: 'Salón' }],
        tables: [{ id: 'M', zoneId: 'Z', name: '1', x: 0, y: 0, shape: 'square', capacity: 4 }],
      },
    ],
    ['without zones or tables', { ...base, zones: [], tables: [] }],
    ['without the zones and tables keys', { ...base }],
    [
      'with tables but no zones (half-written data)',
      {
        ...base,
        tables: [{ id: 'M', zoneId: 'Z', name: '1', x: 0, y: 0, shape: 'square', capacity: 4 }],
      },
    ],
    [
      'with a shape that no longer exists',
      {
        ...base,
        zones: [{ id: 'Z', name: 'Salón' }],
        tables: [{ id: 'M', zoneId: 'Z', name: '1', x: 0, y: 0, shape: 'hexagonal', capacity: 4 }],
      },
    ],
    [
      'with loose, unknown new fields',
      {
        ...base,
        zones: [{ id: 'Z', name: 'Salón', level: 1, future: true }],
        tables: [],
        somethingElse: [1, 2, 3],
      },
    ],
  ])('%s: loads without failing and has everything the screen reads', async (_case, old) => {
    const { floor } = await openWith(old)
    const c = floor.snapshot().catalog
    expect(floor.snapshot().loaded).toBe(true)
    expect(c).not.toBeNull()
    // What Tables.tsx reads without guarding.
    expect(Array.isArray(c?.zones)).toBe(true)
    expect(Array.isArray(c?.tables)).toBe(true)
    expect(Array.isArray(c?.elements)).toBe(true)
    expect(Array.isArray(c?.staff)).toBe(true)
    for (const z of c?.zones ?? []) expect(typeof z.level).toBe('number')
    for (const m of c?.tables ?? []) {
      expect(typeof m.width).toBe('number')
      expect(typeof m.height).toBe('number')
      expect(typeof m.rotation).toBe('number')
    }
    // The old data is kept.
    expect(c?.version).toBe(3)
    expect(c?.restaurant.name).toBe('La Spritzzería')
  })

  it('keeps the existing tables with a default size of 80 × 80 and no rotation', async () => {
    const { floor } = await openWith({
      ...base,
      zones: [{ id: 'Z', name: 'Salón' }],
      tables: [
        { id: 'M1', zoneId: 'Z', name: '1', x: 120, y: 240, shape: 'square', capacity: 4 },
        { id: 'M2', zoneId: 'Z', name: '2', x: 0, y: 0, shape: 'square', capacity: 2 },
      ],
    })
    expect(floor.snapshot().catalog?.tables).toEqual([
      expect.objectContaining({ id: 'M1', x: 120, y: 240, width: 80, height: 80, rotation: 0 }),
      expect.objectContaining({ id: 'M2', width: 80, height: 80, rotation: 0 }),
    ])
    expect(floor.snapshot().catalog?.zones[0]).toMatchObject({ id: 'Z', level: 1 })
  })

  it('with no saved menu, the menu is null (it does not invent one)', async () => {
    const { floor } = await openWith(undefined)
    expect(floor.snapshot().loaded).toBe(true)
    expect(floor.snapshot().catalog).toBeNull()
  })

  it('opening the same database twice gives the same complete menu (repeating does not break it)', async () => {
    const db = new DeviceDatabase(`old-${newId()}`)
    databases.push(db)
    await db.saveSetting('catalog', {
      ...base,
      zones: [{ id: 'Z', name: 'Salón' }],
      tables: [],
    })
    const open = () => new Floor({ db, open: () => ({ send: () => {}, close: () => {} }) })
    const a = open()
    await a.load()
    const b = open()
    await b.load()
    expect(b.snapshot().catalog).toEqual(a.snapshot().catalog)
    // Calling load() again on the same floor returns the same load.
    await a.load()
  })
})

describe('Floor.updateCatalog() with the response of an older hub', () => {
  const device: Device = { deviceId: newId(), token: 'token', name: 'Caja', type: 'register' }
  const respond = (body: unknown, status = 200) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    )

  it('fills in what is missing, saves it complete and shows it', async () => {
    const { floor, db } = await openWith(undefined, { device })
    respond({
      ...base,
      version: 5,
      zones: [{ id: 'Z', name: 'Salón' }],
      tables: [{ id: 'M', zoneId: 'Z', name: '1', x: 0, y: 0, shape: 'square', capacity: 4 }],
    })
    await floor.updateCatalog()
    const shownCatalog = floor.snapshot().catalog
    expect(shownCatalog?.version).toBe(5)
    expect(shownCatalog?.elements).toEqual([])
    expect(shownCatalog?.tables[0]).toMatchObject({ width: 80, height: 80, rotation: 0 })
    const saved = await db.readSetting<typeof shownCatalog>('catalog')
    expect(saved).toEqual(shownCatalog)
  })

  it('a response without tables (not the menu) does not replace the good one', async () => {
    const { floor } = await openWith(
      { ...base, version: 7, zones: [], tables: [], elements: [], staff: [] },
      { device },
    )
    respond({ error: 'algo' })
    await expect(floor.updateCatalog()).rejects.toMatchObject({ code: 'invalid_response' })
    expect(floor.snapshot().catalog?.version).toBe(7)
  })

  it('a response with an older version than the saved one does not overwrite it', async () => {
    const { floor } = await openWith(
      { ...base, version: 7, zones: [], tables: [], elements: [], staff: [] },
      { device },
    )
    respond({ ...base, version: 4, zones: [], tables: [] })
    await floor.updateCatalog()
    expect(floor.snapshot().catalog?.version).toBe(7)
  })
})
