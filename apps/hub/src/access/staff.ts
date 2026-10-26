import {
  isPermission,
  PASSWORD_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  PERMISSIONS,
  type Permission,
} from '@pos/core'
import { inTransaction, type SqliteDatabase } from '@pos/db'
import { type Author, insertVersioned, updateVersioned } from './records'
import { type AccessService, DataError } from './service'

// Staff and roles (task 1.3b, ADR-013): the admin creates roles, decides which permissions each
// one has and adds each person. Everything is per restaurant. Two rules protect the location:
// - there is always at least one active person who can manage staff (otherwise nobody could
//   get back into this screen);
// - default roles are not renamed or archived (the hub recognizes them by name),
//   but their permissions can be changed.

export class StaffError extends Error {}

export interface StaffRole {
  id: string
  name: string
  /** Default role: it is not renamed or archived. */
  system: boolean
  active: boolean
  permissions: Permission[]
  /** How many active people have it. */
  people: number
}

export interface StaffMember {
  id: string
  name: string
  roleId: string
  active: boolean
  /** The username they sign in to the register with; `null` if they sign in with their PIN. */
  user: string | null
}

export interface StaffDevice {
  id: string
  name: string
  type: string
  registeredAt: string | null
  revokedAt: string | null
  /** Last use of a session on that device, and whose. */
  lastUsed: string | null
  lastPerson: string | null
}

const NAME_MAX_LENGTH = 60

function validName(name: string, what: string): string {
  const n = name.trim()
  if (n.length === 0 || n.length > NAME_MAX_LENGTH)
    throw new StaffError(`El nombre ${what} debe tener entre 1 y ${NAME_MAX_LENGTH} letras`)
  return n
}

/** What the staff screen sees: all roles and people, archived ones included. */
export function readStaff(
  db: SqliteDatabase,
  restaurantId: string,
  access: AccessService,
): { roles: StaffRole[]; people: StaffMember[]; devices: StaffDevice[] } {
  const roles = db
    .prepare(
      `SELECT r.id, r.name, r.system, r.active,
         (SELECT count(*) FROM users u WHERE u.role_id = r.id AND u.active = 1) AS people
       FROM roles r WHERE r.restaurant_id = ? AND r.hidden = 0
       ORDER BY r.system DESC, r.created_at, r.id`,
    )
    .all(restaurantId)
    .map((f) => ({
      id: String(f.id),
      name: String(f.name),
      system: f.system === 1,
      active: f.active === 1,
      permissions: rolePermissions(db, String(f.id)),
      people: Number(f.people),
    }))
  const people = db
    .prepare(
      // The technical users of kitchen screens are not people (ADR-015).
      'SELECT id, name, role_id, active FROM users WHERE restaurant_id = ? AND screen = 0 ORDER BY active DESC, name, id',
    )
    .all(restaurantId)
    .map((f) => ({
      id: String(f.id),
      name: String(f.name),
      roleId: String(f.role_id),
      active: f.active === 1,
      user: access.userOf(String(f.id)),
    }))
  // Devices, most recently used first: the lost one is usually one that is not in use.
  const devices = db
    .prepare(
      `SELECT d.id, d.name, d.type, d.paired_at, d.revoked_at, s.last_used, u.name AS person
       FROM devices d
       LEFT JOIN sessions s ON s.id = (
         SELECT id FROM sessions WHERE device_id = d.id ORDER BY last_used DESC LIMIT 1)
       LEFT JOIN users u ON u.id = s.user_id
       WHERE d.restaurant_id = ? AND d.active = 1
       ORDER BY d.revoked_at IS NOT NULL, coalesce(s.last_used, d.paired_at) DESC`,
    )
    .all(restaurantId)
    .map((f) => ({
      id: String(f.id),
      name: String(f.name),
      type: String(f.type),
      registeredAt: f.paired_at === null ? null : String(f.paired_at),
      revokedAt: f.revoked_at === null ? null : String(f.revoked_at),
      lastUsed: f.last_used === null ? null : String(f.last_used),
      lastPerson: f.person === null ? null : String(f.person),
    }))
  return { roles, people, devices }
}

function rolePermissions(db: SqliteDatabase, roleId: string): Permission[] {
  return db
    .prepare(
      'SELECT permission FROM role_permissions WHERE role_id = ? AND active = 1 ORDER BY permission',
    )
    .all(roleId)
    .map((f) => String(f.permission))
    .filter(isPermission)
}

/** Creates a role or changes its name, its permissions or whether it is active. Returns its id. */
export function saveRole(
  db: SqliteDatabase,
  restaurantId: string,
  access: AccessService,
  data: { id?: string; name: string; permissions: readonly string[]; active?: boolean },
  author: Author,
  now: string,
): string {
  const name = validName(data.name, 'del rol')
  const permissions = [...new Set(data.permissions)]
  const unknown = permissions.find((p) => !isPermission(p))
  if (unknown) throw new StaffError(`Permiso desconocido: ${unknown}`)

  return inTransaction(db, () => {
    const current = data.id
      ? db
          .prepare('SELECT * FROM roles WHERE restaurant_id = ? AND id = ?')
          .get(restaurantId, data.id)
      : undefined
    if (data.id && !current) throw new StaffError('Ese rol no existe')
    if (current?.hidden === 1) throw new StaffError('Ese rol no existe')
    const active = data.active ?? (current ? current.active === 1 : true)
    if (current?.system === 1) {
      if (name !== current.name)
        throw new StaffError('Los roles de fábrica no se renombran: crea uno nuevo')
      if (!active) throw new StaffError('Los roles de fábrica no se archivan')
    }
    if (active) {
      const duplicate = db
        .prepare('SELECT id, name FROM roles WHERE restaurant_id = ? AND active = 1 AND hidden = 0')
        .all(restaurantId)
        .find(
          (f) =>
            f.id !== data.id &&
            String(f.name).toLocaleLowerCase('es') === name.toLocaleLowerCase('es'),
        )
      if (duplicate) throw new StaffError(`Ya hay un rol que se llama «${duplicate.name}»`)
    }

    let roleId: string
    if (current) {
      roleId = String(current.id)
      if (!active && current.active === 1) {
        const people = db
          .prepare('SELECT count(*) AS n FROM users WHERE role_id = ? AND active = 1')
          .get(roleId)
        if (Number(people?.n) > 0)
          throw new StaffError('Ese rol tiene personas: pásalas a otro rol antes de archivarlo')
      }
      if (name !== current.name || active !== (current.active === 1))
        updateVersioned(
          db,
          'roles',
          restaurantId,
          roleId,
          { name, active: active ? 1 : 0 },
          author,
          now,
        )
    } else {
      roleId = insertVersioned(db, 'roles', restaurantId, { name, system: 0 }, author, now)
    }

    // A removed permission is archived; if it is given again, the same row is reactivated.
    const rows = db
      .prepare('SELECT id, permission, active FROM role_permissions WHERE role_id = ?')
      .all(roleId)
    for (const permission of PERMISSIONS) {
      const row = rows.find((f) => f.permission === permission)
      const wants = permissions.includes(permission)
      if (!row) {
        if (wants)
          insertVersioned(
            db,
            'role_permissions',
            restaurantId,
            { role_id: roleId, permission },
            author,
            now,
          )
      } else if (wants !== (row.active === 1)) {
        updateVersioned(
          db,
          'role_permissions',
          restaurantId,
          String(row.id),
          { active: wants ? 1 : 0 },
          author,
          now,
        )
      }
    }
    const roleUsers = db
      .prepare('SELECT id FROM users WHERE role_id = ? AND active = 1')
      .all(roleId)
      .map((f) => String(f.id))
    requirePassword(db, restaurantId, access, roleUsers)
    requireAdmin(db, restaurantId)
    return roleId
  })
}

/** How a person signs in: with their PIN, or with username and password (PIN only authorizes). */
export type StaffMemberAccess =
  | { type: 'pin' }
  | { type: 'password'; user: string; password?: string }

/**
 * Creates a person or changes their name, role, how they sign in or whether they are active.
 * Returns their id and the PIN if it is new or was regenerated (the PIN is shown only this time).
 * Changing the role or how they sign in closes their sessions, so their device asks them to sign
 * in again with the new one.
 */
export function saveStaffMember(
  db: SqliteDatabase,
  restaurantId: string,
  access: AccessService,
  data: {
    id?: string
    name: string
    roleId: string
    active?: boolean
    access?: StaffMemberAccess
    regeneratePin?: boolean
  },
  author: Author,
  now: string,
): { userId: string; pin: string | null } {
  const name = validName(data.name, 'de la persona')
  return inTransaction(db, () => {
    const role = db
      .prepare('SELECT active FROM roles WHERE restaurant_id = ? AND id = ? AND hidden = 0')
      .get(restaurantId, data.roleId)
    if (!role) throw new StaffError('Ese rol no existe')

    const current = data.id
      ? db
          .prepare('SELECT * FROM users WHERE restaurant_id = ? AND id = ?')
          .get(restaurantId, data.id)
      : undefined
    if (data.id && (!current || current.screen === 1)) throw new StaffError('Esa persona no existe')
    const active = data.active ?? (current ? current.active === 1 : true)
    if (active && role.active !== 1) throw new StaffError('Ese rol está archivado')

    // Only data errors (username taken, short password) are shown as is.
    const withError = <T>(job: () => T): T => {
      try {
        return job()
      } catch (e) {
        throw e instanceof DataError ? new StaffError(e.message) : e
      }
    }

    if (!current) {
      const signInMethod = data.access ?? { type: 'pin' }
      if (signInMethod.type === 'password' && !signInMethod.password)
        throw new StaffError('Escribe una contraseña para esta persona')
      const { userId, pin } = withError(() =>
        access.insertUser(
          {
            name,
            roleId: data.roleId,
            ...(signInMethod.type === 'password'
              ? { user: signInMethod.user, password: signInMethod.password }
              : {}),
          },
          author,
        ),
      )
      requirePassword(db, restaurantId, access, [userId])
      requireAdmin(db, restaurantId)
      return { userId, pin }
    }

    const userId = String(current.id)
    const changesRole = data.roleId !== current.role_id

    // How they sign in goes first: so when reactivating them, their username no longer clashes
    // with someone else's.
    const signInMethod = data.access
    if (signInMethod?.type === 'pin' && access.hasPassword(userId)) access.removePassword(userId)
    if (signInMethod?.type === 'password') {
      const currentUser = access.userOf(userId)
      if (signInMethod.password)
        withError(() =>
          access.setPassword(userId, signInMethod.user, signInMethod.password as string),
        )
      else if (currentUser === null)
        throw new StaffError('Escribe una contraseña para esta persona')
      else if (signInMethod.user.trim().toLowerCase() !== currentUser)
        throw new StaffError('Para cambiar el usuario, escribe también una contraseña')
    }

    // While they were archived, their PIN or username may have gone to someone else: the PIN is
    // swapped for a free one; the username must be changed by whoever reactivates them.
    let newPin: string | null = null
    if (active && current.active !== 1) {
      const clashes = (column: 'pin_hash' | 'username') =>
        db
          .prepare(
            `SELECT 1 FROM user_credentials esta JOIN user_credentials otra
               ON otra.restaurant_id = esta.restaurant_id AND otra.${column} = esta.${column}
             WHERE esta.user_id = ? AND otra.current = 1 AND otra.user_id <> esta.user_id`,
          )
          .get(userId) !== undefined
      if (clashes('username'))
        throw new StaffError(
          `Su usuario «${access.userOf(userId)}» ya lo tiene otra persona: ponle otro, con una contraseña`,
        )
      if (clashes('pin_hash')) newPin = access.regeneratePin(userId)
    }

    if (name !== current.name || changesRole || active !== (current.active === 1))
      updateVersioned(
        db,
        'users',
        restaurantId,
        userId,
        { name, role_id: data.roleId, active: active ? 1 : 0 },
        author,
        now,
      )
    if (changesRole || !active) closeSessionsOf(db, restaurantId, userId, now)

    const pin = data.regeneratePin ? access.regeneratePin(userId) : newPin
    requirePassword(db, restaurantId, access, [userId])
    requireAdmin(db, restaurantId)
    return { userId, pin }
  })
}

function closeSessionsOf(db: SqliteDatabase, restaurantId: string, userId: string, now: string) {
  db.prepare(
    'UPDATE sessions SET closed_at = ? WHERE restaurant_id = ? AND user_id = ? AND closed_at IS NULL',
  ).run(now, restaurantId, userId)
}

const PERMISSION_NAME = new Map(
  PERMISSION_DESCRIPTIONS.flatMap((g) => g.permissions.map((p) => [p.permission, p.name] as const)),
)

/**
 * Someone who signs in with a PIN cannot have permissions that require a password
 * (`PASSWORD_PERMISSIONS`): a 4-digit PIN is easier to guess. It is checked at the end of the
 * change, inside the transaction.
 */
function requirePassword(
  db: SqliteDatabase,
  restaurantId: string,
  access: AccessService,
  userIds: readonly string[],
) {
  for (const id of userIds) {
    const f = db
      .prepare('SELECT name, active FROM users WHERE restaurant_id = ? AND id = ?')
      .get(restaurantId, id)
    if (f?.active !== 1 || access.hasPassword(id)) continue
    const sensitive = access.permissionsOf(id).find((p) => PASSWORD_PERMISSIONS.has(p))
    if (sensitive)
      throw new StaffError(
        `${f.name} entra con PIN y su rol permite «${PERMISSION_NAME.get(sensitive) ?? sensitive}»: dale usuario y contraseña, o quita ese permiso`,
      )
  }
}

/**
 * The active people, with username and password, who can manage that restaurant's staff, from
 * oldest to newest. Used by startup, `reset-admin` and the rule against running out of admins:
 * so all three count the same people.
 */
export function admins(db: SqliteDatabase, restaurantId: string): string[] {
  return db
    .prepare(
      `SELECT u.id FROM users u
       JOIN roles r ON r.id = u.role_id AND r.active = 1
       JOIN role_permissions rp ON rp.role_id = r.id AND rp.active = 1 AND rp.permission = 'manage_users'
       JOIN user_credentials c ON c.user_id = u.id AND c.username IS NOT NULL
       WHERE u.restaurant_id = ? AND u.active = 1 ORDER BY u.created_at, u.id`,
    )
    .all(restaurantId)
    .map((f) => String(f.id))
}

/** Ensures someone who can manage staff remains (otherwise the whole change is rolled back). */
function requireAdmin(db: SqliteDatabase, restaurantId: string) {
  if (admins(db, restaurantId).length === 0)
    throw new StaffError(
      'Tiene que quedar al menos una persona que pueda administrar el personal con usuario y contraseña',
    )
}
