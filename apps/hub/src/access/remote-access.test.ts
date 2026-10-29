import { applyMigrations, type SqliteDatabase } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { ensureRestaurant, ensureRoles, REMOTE_ACCESS_GRANTED } from './initial'
import { insertVersioned, SYSTEM } from './records'
import { AccessService } from './service'
import { saveRole } from './staff'

// «Entrar desde fuera del local» (`remote_access`, ADR-017): a new restaurant's Administrador has
// it; a hub from before gets it once on startup, and if the admin takes it away it does not come
// back.

const NOW = '2026-10-29T15:00:00.000Z'
const LATER = '2026-10-30T15:00:00.000Z'

const remoteRows = (db: SqliteDatabase) =>
  db
    .prepare(
      "SELECT role_id, active, version FROM role_permissions WHERE permission = 'remote_access' ORDER BY role_id",
    )
    .all()
const catalogCounter = (db: SqliteDatabase) =>
  Number(db.prepare("SELECT value FROM counters WHERE name = 'catalog'").get()?.value)
const granted = (db: SqliteDatabase) =>
  db.prepare('SELECT value FROM counters WHERE name = ?').get(REMOTE_ACCESS_GRANTED)

function freshDb() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  return db
}

/** A hub from before the panel: the default roles exist, the Administrador without the permission. */
function hubFromBefore() {
  const db = freshDb()
  const restaurantId = ensureRestaurant(db, NOW)
  const admin = insertVersioned(
    db,
    'roles',
    restaurantId,
    { name: 'Administrador', system: 1 },
    SYSTEM,
    NOW,
  )
  for (const permission of ['manage_users', 'manage_devices', 'view_reports'])
    insertVersioned(
      db,
      'role_permissions',
      restaurantId,
      { role_id: admin, permission },
      SYSTEM,
      NOW,
    )
  // A custom role that can do everything: it is not «the Administrador», it does not get it.
  const manager = insertVersioned(
    db,
    'roles',
    restaurantId,
    { name: 'Gerente general', system: 0 },
    SYSTEM,
    NOW,
  )
  insertVersioned(
    db,
    'role_permissions',
    restaurantId,
    { role_id: manager, permission: 'manage_users' },
    SYSTEM,
    NOW,
  )
  const access = new AccessService({
    db,
    restaurantId,
    key: Buffer.alloc(32, 3),
    clock: () => NOW,
    passwordCost: 1,
  })
  return { db, restaurantId, admin, manager, access }
}

describe('remote_access for the Administrador role', () => {
  it('a new restaurant: the Administrador has it from the start, in a single row', () => {
    const db = freshDb()
    const restaurantId = ensureRestaurant(db, NOW)
    const roles = ensureRoles(db, restaurantId, NOW)
    expect(remoteRows(db)).toEqual([expect.objectContaining({ role_id: roles.admin, active: 1 })])
    expect(granted(db)).toEqual({ value: 1 })
  })

  it('a hub from before: only the Administrador gets it, once, and the version moves once', () => {
    const h = hubFromBefore()
    const counter = catalogCounter(h.db)
    const roles = ensureRoles(h.db, h.restaurantId, LATER)
    expect(roles.admin).toBe(h.admin)
    expect(remoteRows(h.db)).toEqual([expect.objectContaining({ role_id: h.admin, active: 1 })])
    const afterOnce = catalogCounter(h.db)
    expect(afterOnce).toBeGreaterThan(counter)
    // Running it again (each startup) does not add or touch anything.
    for (let i = 0; i < 3; i++) ensureRoles(h.db, h.restaurantId, LATER)
    expect(remoteRows(h.db)).toHaveLength(1)
    expect(catalogCounter(h.db)).toBe(afterOnce)
  })

  it('if the admin takes it away, the next startups do not give it back', () => {
    const h = hubFromBefore()
    const roles = ensureRoles(h.db, h.restaurantId, LATER)
    const admin = h.access.createUser({
      name: 'Dueña',
      roleId: roles.admin,
      user: 'duena',
      password: 'clave-de-la-duena',
    })
    const permissions = h.access
      .permissionsOf(admin.userId)
      .filter((p) => p !== 'remote_access') as string[]
    saveRole(
      h.db,
      h.restaurantId,
      h.access,
      { id: roles.admin, name: 'Administrador', permissions },
      { userId: admin.userId, deviceId: null },
      LATER,
    )
    expect(h.access.permissionsOf(admin.userId)).not.toContain('remote_access')
    ensureRoles(h.db, h.restaurantId, '2026-11-01T15:00:00.000Z')
    expect(h.access.permissionsOf(admin.userId)).not.toContain('remote_access')
    expect(remoteRows(h.db)).toEqual([expect.objectContaining({ role_id: h.admin, active: 0 })])
  })

  it('once the grant was made, it is not repeated even if the row were missing', () => {
    const h = hubFromBefore()
    h.db
      .prepare('INSERT INTO counters (restaurant_id, name, value) VALUES (?, ?, 1)')
      .run(h.restaurantId, REMOTE_ACCESS_GRANTED)
    ensureRoles(h.db, h.restaurantId, LATER)
    expect(remoteRows(h.db)).toEqual([])
  })

  it('a role that already had it (given by hand) is left as it is', () => {
    const h = hubFromBefore()
    insertVersioned(
      h.db,
      'role_permissions',
      h.restaurantId,
      { role_id: h.admin, permission: 'remote_access', active: 0 },
      { userId: null, deviceId: null },
      NOW,
    )
    ensureRoles(h.db, h.restaurantId, LATER)
    expect(remoteRows(h.db)).toEqual([expect.objectContaining({ role_id: h.admin, active: 0 })])
  })
})
