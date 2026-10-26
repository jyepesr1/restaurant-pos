import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isValidId, newId } from '@pos/core'
import { applyMigrations } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { ensureAdmin, ensureRestaurant, ensureRoles } from '../access/initial'
import { insertVersioned, stableId, updateVersioned } from '../access/records'
import { AccessService } from '../access/service'
import { readMenu } from './menu'
import { seed } from './seed'

// The pilot's card terminals (task 1.6): the seed creates «Bold 1» and «Bold 2» and then respects
// them: whatever the admin renames, archives or adds in «Caja y pagos» is left alone.

const MENU_TEXT = readFileSync(
  fileURLToPath(new URL('../../../../docs/datos/carta-la-spritzzeria.yaml', import.meta.url)),
  'utf8',
)
const NOW = '2026-10-24T20:00:00.000Z'
const LATER = '2026-10-25T09:30:00.000Z'

function hub() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const restaurantId = ensureRestaurant(db, NOW)
  const roles = ensureRoles(db, restaurantId, NOW)
  const access = new AccessService({
    db,
    restaurantId,
    key: Buffer.alloc(32, 3),
    clock: () => NOW,
  })
  ensureAdmin(db, access, roles.admin, false)
  const load = (now = NOW, withoutStaff = true) =>
    seed(db, access, { restaurantId, roles, menu: readMenu(MENU_TEXT), withoutStaff }, now)
  const cardTerminals = () =>
    db
      .prepare('SELECT * FROM card_terminals WHERE restaurant_id = ? ORDER BY name')
      .all(restaurantId)
  const admin = () => {
    const u = db.prepare("SELECT id FROM users WHERE name = 'Administrador'").get()
    return { userId: String(u?.id), deviceId: null }
  }
  return { db, restaurantId, load, cardTerminals, admin }
}

describe('the seed creates two Bold card terminals', () => {
  it('«Bold 1» and «Bold 2», provider bold, active, system-owned and with a valid, stable id', () => {
    const h = hub()
    h.load()
    const rows = h.cardTerminals()
    expect(rows.map((f) => [f.name, f.provider, f.active])).toEqual([
      ['Bold 1', 'bold', 1],
      ['Bold 2', 'bold', 1],
    ])
    for (const f of rows) {
      expect(isValidId(String(f.id))).toBe(true)
      expect(f.user_id).toBeNull()
      expect(f.device_id).toBeNull()
    }
    expect(rows.map((f) => f.id)).toEqual([
      stableId(h.restaurantId, 'card_terminal:bold-1'),
      stableId(h.restaurantId, 'card_terminal:bold-2'),
    ])
  })

  it('the summary counts them as created', () => {
    const r = hub().load()
    expect(r.sqlTables.card_terminals).toEqual({
      created: 2,
      updated: 0,
      equal: 0,
      respected: 0,
      archived: 0,
    })
  })

  it('they are also created with the sample staff (the full seed)', () => {
    const h = hub()
    h.load(NOW, false)
    expect(h.cardTerminals()).toHaveLength(2)
  })

  it('each card terminal bumps the catalog version: devices receive it with the menu', () => {
    const h = hub()
    h.load()
    const versions = h.cardTerminals().map((f) => Number(f.version))
    expect(new Set(versions).size).toBe(2)
    for (const v of versions) expect(v).toBeGreaterThan(0)
    const counter = Number(
      h.db
        .prepare("SELECT value FROM counters WHERE restaurant_id = ? AND name = 'catalog'")
        .get(h.restaurantId)?.value,
    )
    expect(counter).toBeGreaterThanOrEqual(Math.max(...versions))
  })
})

describe('repeat the seed', () => {
  it('does not duplicate or touch the card terminals: same ids, versions and dates', () => {
    const h = hub()
    h.load()
    const before = h.cardTerminals()
    const r = h.load(LATER)
    expect(h.cardTerminals()).toEqual(before)
    expect(r.sqlTables.card_terminals).toEqual({
      created: 0,
      updated: 0,
      equal: 0,
      respected: 2,
      archived: 0,
    })
    h.load('2027-01-01T00:00:00.000Z')
    expect(h.cardTerminals()).toEqual(before)
  })

  it('the admin renames one: the seed does not overwrite it', () => {
    const h = hub()
    h.load()
    const id = stableId(h.restaurantId, 'card_terminal:bold-1')
    updateVersioned(
      h.db,
      'card_terminals',
      h.restaurantId,
      id,
      { name: 'Bold terraza', provider: 'redeban' },
      h.admin(),
      LATER,
    )
    h.load(LATER)
    h.load('2027-01-01T00:00:00.000Z')
    expect(h.cardTerminals().map((f) => [f.name, f.provider])).toEqual([
      ['Bold 2', 'bold'],
      ['Bold terraza', 'redeban'],
    ])
  })

  it('the admin archives one: it stays archived, does not come back and is not recreated', () => {
    const h = hub()
    h.load()
    const id = stableId(h.restaurantId, 'card_terminal:bold-2')
    updateVersioned(h.db, 'card_terminals', h.restaurantId, id, { active: 0 }, h.admin(), LATER)
    h.load(LATER)
    expect(h.cardTerminals().map((f) => [f.name, f.active])).toEqual([
      ['Bold 1', 1],
      ['Bold 2', 0],
    ])
    expect(h.cardTerminals()).toHaveLength(2)
  })

  it('one archived by hand and reactivated by the admin stays as they left it', () => {
    const h = hub()
    h.load()
    const id = stableId(h.restaurantId, 'card_terminal:bold-1')
    updateVersioned(h.db, 'card_terminals', h.restaurantId, id, { active: 0 }, h.admin(), NOW)
    updateVersioned(h.db, 'card_terminals', h.restaurantId, id, { active: 1 }, h.admin(), NOW)
    const before = h.cardTerminals()
    h.load(LATER)
    expect(h.cardTerminals()).toEqual(before)
  })

  it('a card terminal the admin added is not archived even though the seed does not know it', () => {
    const h = hub()
    h.load()
    const own = insertVersioned(
      h.db,
      'card_terminals',
      h.restaurantId,
      { name: 'Redeban barra', provider: 'redeban' },
      h.admin(),
      LATER,
    )
    const r = h.load(LATER)
    const row = h.cardTerminals().find((f) => f.id === own)
    expect(row).toMatchObject({ active: 1, name: 'Redeban barra' })
    expect(r.sqlTables.card_terminals?.archived ?? 0).toBe(0)
    expect(h.cardTerminals()).toHaveLength(3)
  })

  it('several runs do not repeat «Bold 1»', () => {
    const h = hub()
    const before = h.load()
    expect(before.sqlTables.card_terminals?.created).toBe(2)
    h.load(LATER)
    expect(h.cardTerminals().filter((f) => f.name === 'Bold 1')).toHaveLength(1)
  })
})

describe('several restaurants', () => {
  it('the seed card terminals belong to each restaurant, with different ids', () => {
    const a = hub()
    const b = hub()
    a.load()
    b.load()
    expect(a.cardTerminals().map((f) => f.id)).not.toEqual(b.cardTerminals().map((f) => f.id))
    for (const f of a.cardTerminals()) expect(f.restaurant_id).toBe(a.restaurantId)
  })

  it('in a shared database, seeding one does not create card terminals in the other', () => {
    const db = openDatabase(':memory:')
    applyMigrations(db)
    const one = ensureRestaurant(db, NOW)
    const other = newId()
    db.prepare(
      `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
       VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
    ).run(other, other, NOW, NOW)
    db.prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)").run(
      other,
    )
    const roles = ensureRoles(db, one, NOW)
    const access = new AccessService({
      db,
      restaurantId: one,
      key: Buffer.alloc(32, 3),
      clock: () => NOW,
    })
    seed(
      db,
      access,
      { restaurantId: one, roles, menu: readMenu(MENU_TEXT), withoutStaff: true },
      NOW,
    )
    const check = (r: string) =>
      Number(
        db.prepare('SELECT count(*) AS n FROM card_terminals WHERE restaurant_id = ?').get(r)?.n,
      )
    expect(check(one)).toBe(2)
    expect(check(other)).toBe(0)
  })
})
