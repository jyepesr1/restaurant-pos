import { newId } from '@pos/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { configFrom, readConfig } from './snapshots'
import { putSnapshot } from './testing/panel'
import { createWorld, type World } from './testing/world'

// The cash drawer key in the config snapshot (task 1.13): the cloud takes the same config schema
// as the hub (`RestaurantConfig`, strict), so `cash_drawer_printer_id` is accepted, stored and
// read back; a hub that has no drawer does not send it; garbage in that field is refused.

let m: World
beforeAll(async () => {
  m = await createWorld()
})

const config = (extra: Record<string, unknown>) => ({
  config: { business_day_start: '06:00', ...extra },
  time_zone: 'America/Bogota',
})

describe('cash_drawer_printer_id in the config snapshot', () => {
  it('a hub with a drawer uploads it: accepted, stored as sent and read back', async () => {
    const h = await m.newHub()
    const id = newId()
    expect(await putSnapshot(m, h, 'config', config({ cash_drawer_printer_id: id }))).toBe(204)
    const [row] = (
      await m.db.query<{ content: { config: Record<string, unknown> } }>(
        "SELECT content FROM snapshots WHERE restaurant_id = $1 AND kind = 'config'",
        [h.restaurantId],
      )
    ).rows
    expect(row?.content.config.cash_drawer_printer_id).toBe(id)
    const read = await m.sql.transaction((tx) => readConfig(tx, h.restaurantId, h.hub.locationId))
    expect(read.config.cash_drawer_printer_id).toBe(id)
  })

  it('a hub without a drawer does not send it: accepted, and read back as no drawer', async () => {
    const h = await m.newHub()
    expect(await putSnapshot(m, h, 'config', config({}))).toBe(204)
    const read = await m.sql.transaction((tx) => readConfig(tx, h.restaurantId, h.hub.locationId))
    expect(read.config.cash_drawer_printer_id).toBeNull()
  })

  it('an explicit null (an older hub build, or one that removed the drawer) is accepted too', async () => {
    const h = await m.newHub()
    expect(await putSnapshot(m, h, 'config', config({ cash_drawer_printer_id: null }))).toBe(204)
  })

  it('changing the drawer replaces the snapshot: only the last one is kept', async () => {
    const h = await m.newHub()
    const first = newId()
    const second = newId()
    expect(await putSnapshot(m, h, 'config', config({ cash_drawer_printer_id: first }))).toBe(204)
    expect(await putSnapshot(m, h, 'config', config({ cash_drawer_printer_id: second }))).toBe(204)
    expect(await putSnapshot(m, h, 'config', config({}))).toBe(204)
    const rows = (
      await m.db.query<{ content: { config: Record<string, unknown> } }>(
        "SELECT content FROM snapshots WHERE restaurant_id = $1 AND kind = 'config'",
        [h.restaurantId],
      )
    ).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content.config).not.toHaveProperty('cash_drawer_printer_id')
  })

  it.each([
    ['a number', 42],
    ['a short string', 'abc'],
    ['an empty string', ''],
    ['a lowercase ULID', newId().toLowerCase()],
    ['a ULID with an illegal letter (U)', `${'U'.repeat(26)}`],
    ['a 27 character string', `${newId()}0`],
    ['an object', { id: newId() }],
    ['a list', [newId()]],
    ['a boolean', true],
  ])('refuses %s with 400 and keeps the previous snapshot', async (_n, value) => {
    const h = await m.newHub()
    const good = newId()
    expect(await putSnapshot(m, h, 'config', config({ cash_drawer_printer_id: good }))).toBe(204)
    expect(await putSnapshot(m, h, 'config', config({ cash_drawer_printer_id: value }))).toBe(400)
    const [row] = (
      await m.db.query<{ content: { config: Record<string, unknown> } }>(
        "SELECT content FROM snapshots WHERE restaurant_id = $1 AND kind = 'config'",
        [h.restaurantId],
      )
    ).rows
    expect(row?.content.config.cash_drawer_printer_id).toBe(good)
  })

  it('a name close to it is still an unknown key and is refused (the schema is strict)', async () => {
    const h = await m.newHub()
    for (const key of [
      'cash_drawer_printer',
      'cash_drawer',
      'cashDrawerPrinterId',
      'cash_drawer_printer_ids',
    ])
      expect(await putSnapshot(m, h, 'config', config({ [key]: newId() })), key).toBe(400)
  })

  it('a stored config with a bad drawer value falls back to no drawer, and the rest is kept', () => {
    const read = configFrom({ business_day_start: '05:00', cash_drawer_printer_id: 7 })
    expect(read.cash_drawer_printer_id).toBeNull()
    expect(read.business_day_start).toBe('05:00')
  })

  it('the pre-bill printer and the drawer can be the same printer (one thermal printer does both)', async () => {
    const h = await m.newHub()
    const printer = newId()
    expect(
      await putSnapshot(
        m,
        h,
        'config',
        config({ pre_bill_printer_id: printer, cash_drawer_printer_id: printer }),
      ),
    ).toBe(204)
  })
})
