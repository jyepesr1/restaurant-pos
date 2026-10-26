import { canonicalJson, fullConfig, type RoleKey } from '@pos/core'
import { inTransaction, type SqliteDatabase, type SqlValue } from '@pos/db'
import { type Change, SYSTEM, saveVersioned, stableId, updateVersioned } from '../access/records'
import { generatePassword } from '../access/secrets'
import type { AccessService } from '../access/service'
import type { MenuCategory, MenuGroup, Station } from './menu'

// Loads the pilot's data (task 0.8): restaurant, dining room, stations, tax, menu and staff, all
// in one transaction. Each record has a stable ID (`stableId`): running it again leaves
// everything the same and only changes what changed in the menu. Rules:
// - what a person wrote (with the catalog editor, Phase 1) is not overwritten;
// - the tax is created only once: if the accountant changes it, the seed does not revert it;
// - what the seed loaded before and is no longer on the menu (or became «no disponible») is
//   archived;
// - the sample staff is created once and keeps its PIN; whoever is archived does not come back.

export const RESTAURANT_NAME = 'La Spritzzería'
export const LOCATION_NAME = 'Envigado'

/** 8 % INC in restaurants and bars. (validate) with the accountant. */
export const TAX = { name: 'INC 8 %', type: 'inc', rate: 800 } as const

/** Provisional floor plan: 25 tables in one zone, on a grid. The real one is drawn in Phase 1. */
export const TABLES = 25
const COLUMNS = 5
const STEP = 120

/**
 * Sample staff, by role (the restaurant sets the real names). With `user` they sign in at the
 * register with username and password; without it, with their PIN (ADR-013).
 */
export const STAFF: readonly {
  key: string
  name: string
  role: RoleKey
  user?: string
}[] = [
  { key: 'caja', name: 'Caja', role: 'cashier', user: 'caja' },
  { key: 'reportes', name: 'Reportes', role: 'reports', user: 'reportes' },
  { key: 'mesero-1', name: 'Mesero 1', role: 'waiter' },
  { key: 'mesero-2', name: 'Mesero 2', role: 'waiter' },
  { key: 'mesero-3', name: 'Mesero 3', role: 'waiter' },
]

/** Tables the seed fills and where it archives what is no longer on the menu. */
const SEEDED_TABLES = [
  'zones',
  'dining_tables',
  'stations',
  'modifier_groups',
  'modifiers',
  'categories',
  'products',
  'variants',
  'product_modifier_groups',
] as const

const STATIONS: Record<Station, { name: string; position: number }> = {
  cocina: { name: 'Cocina', position: 0 },
  barra: { name: 'Barra', position: 1 },
}

export interface Summary {
  /** Per table: how many records were created, changed, left equal, respected or archived. */
  sqlTables: Record<string, Record<Change, number>>
  /**
   * PINs of the people created in this run (those who already existed keep theirs), and username
   * and password for whoever signs in with them. Someone who already existed without a username
   * and now has one (a database from before ADR-013) gets a username and password, no new PIN.
   */
  pins: {
    name: string
    role: RoleKey
    pin: string | null
    user?: string
    password?: string
  }[]
}

export function seed(
  db: SqliteDatabase,
  access: AccessService,
  data: {
    restaurantId: string
    roles: Record<RoleKey, string>
    menu: MenuCategory[]
    /** Without the sample staff (for a restaurant that creates its own users). */
    withoutStaff?: boolean
  },
  now: string,
): Summary {
  const { restaurantId, roles, menu } = data
  const sqlTables: Summary['sqlTables'] = {}
  const count = (tableName: string, change: Change) => {
    sqlTables[tableName] ??= { created: 0, updated: 0, equal: 0, respected: 0, archived: 0 }
    sqlTables[tableName][change] += 1
  }
  const id = (key: string) => stableId(restaurantId, key)
  const currentOnes = new Map<string, Set<string>>()
  const save = (
    tableName: string,
    recordId: string,
    fields: Record<string, SqlValue>,
    options: { createOnly?: boolean } = {},
  ) => {
    currentOnes.set(tableName, (currentOnes.get(tableName) ?? new Set()).add(recordId))
    count(
      tableName,
      saveVersioned(db, tableName, restaurantId, recordId, fields, SYSTEM, now, options),
    )
  }
  const pins: Summary['pins'] = []

  inTransaction(db, () => {
    const restaurant = db.prepare('SELECT config FROM restaurants WHERE id = ?').get(restaurantId)
    // What the restaurant already configured is respected; whatever is missing takes the pilot's
    // value. It is compared as an object: the same content with keys in another order is no change.
    const current = String(restaurant?.config ?? '{}')
    // The pilot shows its brand, unless the restaurant chose another one (task 1.3c).
    const config = canonicalJson(fullConfig({ brand: 'la-spritzzeria', ...JSON.parse(current) }))
    save('restaurants', restaurantId, {
      name: RESTAURANT_NAME,
      config: canonicalJson(JSON.parse(current)) === config ? current : config,
    })
    const location = db
      .prepare('SELECT id FROM locations WHERE restaurant_id = ? ORDER BY created_at, id LIMIT 1')
      .get(restaurantId)
    if (!location) throw new Error('El restaurante no tiene sede: arranca el hub una vez primero')
    const locationId = String(location.id)
    save('locations', locationId, { name: LOCATION_NAME, time_zone: 'America/Bogota' })

    // Dining room.
    const zoneId = id('zone:salon')
    save('zones', zoneId, { location_id: locationId, name: 'Salón', position: 0, level: 1 })
    for (let n = 1; n <= TABLES; n++) {
      save('dining_tables', id(`table:${n}`), {
        zone_id: zoneId,
        name: String(n),
        shape: 'square',
        x: ((n - 1) % COLUMNS) * STEP,
        y: Math.floor((n - 1) / COLUMNS) * STEP,
        width: 80,
        height: 80,
        rotation: 0,
        capacity: 4,
      })
    }

    // Stations and tax.
    for (const [key, e] of Object.entries(STATIONS))
      save('stations', id(`station:${key}`), { name: e.name, position: e.position })
    const taxId = id('tax:inc')
    save('taxes', taxId, { ...TAX }, { createOnly: true })
    // The pilot's Bold card terminals (task 1.6). They are only created: the admin renames, adds
    // or archives them in «Caja y pagos», and the seed respects that.
    for (const n of [1, 2])
      save(
        'card_terminals',
        id(`card_terminal:bold-${n}`),
        { name: `Bold ${n}`, provider: 'bold' },
        { createOnly: true },
      )

    // Menu. First the modifier groups, which products share.
    const groups = new Map<string, MenuGroup>()
    for (const p of menu.flatMap((c) => c.products)) for (const g of p.groups) groups.set(g.key, g)
    for (const g of groups.values()) {
      save('modifier_groups', id(`group:${g.key}`), {
        name: g.name,
        minimum: g.minimum,
        maximum: g.maximum,
      })
      for (const [position, o] of g.options.entries())
        save('modifiers', id(`modifier:${g.key}:${o.name}`), {
          group_id: id(`group:${g.key}`),
          name: o.name,
          extra_price: o.extraPrice,
          position,
        })
    }
    for (const category of menu) {
      const categoryId = id(`category:${category.key}`)
      save('categories', categoryId, {
        name: category.name,
        position: category.position,
        station_id: id(`station:${category.station}`),
        photo: category.photo,
      })
      for (const p of category.products) {
        const productId = id(`product:${p.key}`)
        save('products', productId, {
          category_id: categoryId,
          name: p.name,
          description: p.description,
          price: p.price,
          tax_id: taxId,
          photo: null,
          favorite: 0,
        })
        for (const [position, v] of p.variants.entries())
          save('variants', id(`variant:${p.key}:${v.name}`), {
            product_id: productId,
            name: v.name,
            price: v.price,
            position,
          })
        for (const [position, g] of p.groups.entries()) {
          save('product_modifier_groups', id(`product-group:${p.key}:${g.key}`), {
            product_id: productId,
            group_id: id(`group:${g.key}`),
            position,
          })
        }
      }
    }

    // What the seed loaded before and is no longer on the menu is archived (never deleted). Only
    // the system's: what a person created does not belong to the seed.
    for (const tableName of SEEDED_TABLES) {
      const kept = currentOnes.get(tableName) ?? new Set<string>()
      const leftover = db
        .prepare(
          `SELECT id FROM ${tableName} WHERE restaurant_id = ? AND active = 1 AND user_id IS NULL`,
        )
        .all(restaurantId)
        .map((f) => String(f.id))
        .filter((x) => !kept.has(x))
      for (const x of leftover) {
        updateVersioned(db, tableName, restaurantId, x, { active: 0 }, SYSTEM, now)
        count(tableName, 'archived')
      }
    }

    // Sample staff, in the same transaction: either everything stays with its PINs, or nothing.
    if (data.withoutStaff) return
    for (const person of STAFF) {
      const userId = id(`user:${person.key}`)
      const exists = db
        .prepare('SELECT active FROM users WHERE restaurant_id = ? AND id = ?')
        .get(restaurantId, userId)
      const password = person.user ? generatePassword() : undefined
      if (exists) {
        // Whoever was archived does not come back, nor gets a password that would not work.
        if (exists.active !== 1 || !person.user || access.hasPassword(userId) || !password) {
          count('users', 'equal')
          continue
        }
        access.setPassword(userId, person.user, password)
        count('users', 'updated')
        pins.push({
          name: person.name,
          role: person.role,
          pin: null,
          user: person.user,
          password,
        })
        continue
      }
      const { pin } = access.insertUser({
        id: userId,
        name: person.name,
        roleId: roles[person.role],
        ...(person.user && password ? { user: person.user, password } : {}),
      })
      count('users', 'created')
      pins.push({
        name: person.name,
        role: person.role,
        pin,
        ...(person.user ? { user: person.user, password } : {}),
      })
    }
  })
  return { sqlTables, pins }
}
