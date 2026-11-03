import { DEFAULT_ROLES, newId, RETIRED_ROLES, type RoleKey } from '@pos/core'
import { inTransaction, type SqliteDatabase } from '@pos/db'
import { insertVersioned, SYSTEM, updateVersioned } from './records'
import { generatePassword } from './secrets'
import type { AccessService } from './service'

// The minimum for a freshly installed hub to work: the restaurant, its location, the default
// roles and an admin. Running it again does not duplicate anything.

const TIME_ZONE = 'America/Bogota'

/** The hub's restaurant; if there is none, creates it with its main location. */
export function ensureRestaurant(db: SqliteDatabase, now: string): string {
  const existing = db
    .prepare('SELECT id FROM restaurants WHERE active = 1 ORDER BY created_at, id LIMIT 1')
    .get()
  if (existing) return String(existing.id)

  return inTransaction(db, () => {
    // The version counter requires the restaurant to exist: this first record takes version 1.
    const id = newId()
    db.prepare(
      `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
       VALUES (?, ?, ?, ?, 1, 'Mi restaurante', '{}')`,
    ).run(id, id, now, now)
    db.prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)").run(id)
    insertVersioned(
      db,
      'locations',
      id,
      { name: 'Principal', address: null, time_zone: TIME_ZONE },
      SYSTEM,
      now,
    )
    return id
  })
}

/**
 * The default roles (recognized by name among the system roles). A hub from before ADR-013
 * converts its own: Contador becomes Reportes, and Gerente and Cocina remain as the restaurant's
 * own roles, with their permissions and their people.
 */
export function ensureRoles(
  db: SqliteDatabase,
  restaurantId: string,
  now: string,
): Record<RoleKey, string> {
  return inTransaction(db, () => {
    const findSystemRole = (name: string) =>
      db
        .prepare(
          'SELECT id FROM roles WHERE restaurant_id = ? AND system = 1 AND name = ? ORDER BY created_at LIMIT 1',
        )
        .get(restaurantId, name)
    for (const [oldName, fresh] of Object.entries(RETIRED_ROLES.rename)) {
      const role = findSystemRole(oldName)
      if (role && !findSystemRole(fresh))
        updateVersioned(db, 'roles', restaurantId, String(role.id), { name: fresh }, SYSTEM, now)
    }
    for (const name of RETIRED_ROLES.toCustom) {
      const role = findSystemRole(name)
      if (role)
        updateVersioned(db, 'roles', restaurantId, String(role.id), { system: 0 }, SYSTEM, now)
    }

    const roles = {} as Record<RoleKey, string>
    for (const [key, role] of Object.entries(DEFAULT_ROLES) as [
      RoleKey,
      (typeof DEFAULT_ROLES)[RoleKey],
    ][]) {
      const existing = db
        .prepare(
          'SELECT id FROM roles WHERE restaurant_id = ? AND system = 1 AND name = ? ORDER BY created_at LIMIT 1',
        )
        .get(restaurantId, role.name)
      if (existing) {
        roles[key] = String(existing.id)
        continue
      }
      const roleId = insertVersioned(
        db,
        'roles',
        restaurantId,
        { name: role.name, system: 1 },
        SYSTEM,
        now,
      )
      for (const permission of role.permissions)
        insertVersioned(
          db,
          'role_permissions',
          restaurantId,
          { role_id: roleId, permission },
          SYSTEM,
          now,
        )
      roles[key] = roleId
    }
    grantRemoteAccessOnce(db, restaurantId, roles.admin, now)
    return roles
  })
}

/** Local counter (`counters`, 1 = done): the one-time grant of `remote_access` already happened. */
export const REMOTE_ACCESS_GRANTED = 'remote_access_granted'

/**
 * The cloud panel (ADR-017): in a hub from before it, the Administrador role gets «Entrar desde
 * fuera del local» once. A new restaurant's role already has it (`DEFAULT_ROLES`). If the admin
 * takes it away afterwards, it is not given back: the row stays archived and the counter says the
 * grant was already made.
 */
function grantRemoteAccessOnce(
  db: SqliteDatabase,
  restaurantId: string,
  adminRole: string,
  now: string,
) {
  const done = db
    .prepare('SELECT 1 FROM counters WHERE restaurant_id = ? AND name = ?')
    .get(restaurantId, REMOTE_ACCESS_GRANTED)
  if (done) return
  const row = db
    .prepare('SELECT 1 FROM role_permissions WHERE role_id = ? AND permission = ?')
    .get(adminRole, 'remote_access')
  if (!row)
    insertVersioned(
      db,
      'role_permissions',
      restaurantId,
      { role_id: adminRole, permission: 'remote_access' },
      SYSTEM,
      now,
    )
  db.prepare('INSERT INTO counters (restaurant_id, name, value) VALUES (?, ?, 1)').run(
    restaurantId,
    REMOTE_ACCESS_GRANTED,
  )
}

/** Username the admin who creates the hub signs in with. */
export const ADMIN_USERNAME = 'admin'

export interface Admin {
  /** New PIN (to authorize), if it was created or regenerated in this startup. */
  pin: string | null
  /** New username and password, if they were created in this startup. */
  user: string | null
  password: string | null
  alerts: string[]
}

/**
 * If no active user can manage users, creates the «Administrador» user with username, password
 * and a PIN to authorize. If the PIN key is new but there were already users (the key was lost),
 * no stored PIN works: regenerates the admin's and alerts that the others must be regenerated.
 * An admin from before ADR-013, who signed in with a PIN, gets a username and password.
 */
export function ensureAdmin(
  db: SqliteDatabase,
  access: AccessService,
  adminRole: string,
  newKey: boolean,
): Admin {
  const restaurantId = access.restaurant
  // Someone who can manage users, with or without a password (one from before ADR-013 has none).
  const admin = db
    .prepare(
      `SELECT u.id FROM users u
       JOIN roles r ON r.id = u.role_id AND r.active = 1
       JOIN role_permissions rp ON rp.role_id = r.id AND rp.active = 1 AND rp.permission = 'manage_users'
       WHERE u.restaurant_id = ? AND u.active = 1
       ORDER BY u.created_at, u.id LIMIT 1`,
    )
    .get(restaurantId)
  if (!admin) {
    const password = generatePassword()
    const { pin } = access.createUser({
      name: 'Administrador',
      roleId: adminRole,
      user: ADMIN_USERNAME,
      password,
    })
    return { pin, user: ADMIN_USERNAME, password, alerts: [] }
  }
  const result: Admin = { pin: null, user: null, password: null, alerts: [] }
  const adminId = String(admin.id)
  const credentials = db
    .prepare('SELECT count(*) AS n FROM user_credentials WHERE restaurant_id = ?')
    .get(restaurantId)
  if (newKey && Number(credentials?.n) > 0) {
    result.pin = access.regeneratePin(adminId)
    result.alerts.push(
      'The PIN key is missing (was the database restored without it?). The old PINs no longer work:',
      "a new one was generated for the admin; use it to regenerate each person's PIN.",
    )
  }
  if (!access.hasPassword(adminId)) {
    const user = freeUsername(db, restaurantId, ADMIN_USERNAME)
    const password = generatePassword()
    access.assignPassword(adminId, user, password)
    result.user = user
    result.password = password
    result.alerts.push(
      'From now on the admin signs in at the register with a username and password; their PIN is for authorizing.',
    )
  }
  return result
}

/** `admin`, or `admin2`, `admin3`… if someone else already has it. */
function freeUsername(db: SqliteDatabase, restaurantId: string, base: string): string {
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}${i}`
    const taken = db
      .prepare(
        'SELECT 1 FROM user_credentials WHERE restaurant_id = ? AND username = ? AND current = 1',
      )
      .get(restaurantId, name)
    if (!taken) return name
  }
}
