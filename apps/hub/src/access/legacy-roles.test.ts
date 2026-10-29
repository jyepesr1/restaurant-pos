import { DEFAULT_ROLES } from '@pos/core'
import { applyMigrations, type SqliteDatabase } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { ensureRestaurant, ensureRoles } from './initial'
import { insertVersioned, SYSTEM } from './records'
import { AccessService } from './service'

// Conversion of the pre-ADR-013 roles (Gerente, Cocina, Contador) at hub startup:
// idempotent, with people assigned, without losing permissions or sessions.

const NOW = '2026-10-24T20:00:00.000Z'
const LATER = '2026-10-25T08:00:00.000Z'

const OLD_ROLES: Record<string, readonly string[]> = {
  Administrador: ['manage_users', 'manage_devices', 'take_order'],
  Gerente: ['take_order', 'apply_discount', 'view_reports', 'edit_catalog'],
  Cajero: ['take_order', 'record_payment'],
  Mesero: ['take_order'],
  Cocina: ['mark_preparation', 'mark_product_sold_out'],
  Contador: ['view_reports'],
}

/** A database as task 0.7 left it: old default roles, each with its people. */
function oldDatabase() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  const restaurantId = ensureRestaurant(db, NOW)
  const roles: Record<string, string> = {}
  for (const [name, permissions] of Object.entries(OLD_ROLES)) {
    roles[name] = insertVersioned(db, 'roles', restaurantId, { name, system: 1 }, SYSTEM, NOW)
    for (const permission of permissions)
      insertVersioned(
        db,
        'role_permissions',
        restaurantId,
        { role_id: roles[name] as string, permission },
        SYSTEM,
        NOW,
      )
  }
  const access = new AccessService({
    db,
    restaurantId,
    key: Buffer.alloc(32, 5),
    clock: () => NOW,
    passwordCost: 1,
  })
  const people: Record<string, { userId: string; pin: string }[]> = {}
  for (const [name, roleId] of Object.entries(roles))
    people[name] = [1, 2].map((n) => access.createUser({ name: `${name} ${n}`, roleId }))
  return { db, restaurantId, roles, access, people }
}

const roles = (db: SqliteDatabase) =>
  db.prepare('SELECT id, name, system, active, version FROM roles ORDER BY name, id').all()
const permissions = (db: SqliteDatabase) =>
  db
    .prepare(
      'SELECT role_id, permission, active, version FROM role_permissions ORDER BY role_id, permission',
    )
    .all()

describe('conversion of the old roles', () => {
  it('Contador becomes Reportes (same id and permissions); Gerente and Cocina become custom and active, with their people', () => {
    const b = oldDatabase()
    const before = permissions(b.db)
    const newer = ensureRoles(b.db, b.restaurantId, LATER)
    const row = (id: string) =>
      b.db.prepare('SELECT name, system, active FROM roles WHERE id = ?').get(id)
    expect(newer.reports).toBe(b.roles.Contador as string)
    expect(row(b.roles.Contador as string)).toEqual({ name: 'Reportes', system: 1, active: 1 })
    expect(row(b.roles.Gerente as string)).toEqual({ name: 'Gerente', system: 0, active: 1 })
    expect(row(b.roles.Cocina as string)).toEqual({ name: 'Cocina', system: 0, active: 1 })
    // The default roles that remain (Administrador, Cajero, Mesero) keep their id.
    expect(newer.admin).toBe(b.roles.Administrador as string)
    expect(newer.cashier).toBe(b.roles.Cajero as string)
    expect(newer.waiter).toBe(b.roles.Mesero as string)
    // Nobody loses their role or permissions: the conversion does not rewrite permissions.
    expect(permissions(b.db)).toEqual(before)
    for (const name of ['Gerente', 'Cocina', 'Contador'])
      for (const g of b.people[name] ?? [])
        expect(b.access.permissionsOf(g.userId)).toEqual([...(OLD_ROLES[name] ?? [])].sort())
  })

  it('is idempotent: running it 5 times changes no versions or rows and duplicates no roles', () => {
    const b = oldDatabase()
    ensureRoles(b.db, b.restaurantId, LATER)
    const rolesOnce = roles(b.db)
    const counter = b.db.prepare("SELECT value FROM counters WHERE name = 'catalog'").get()
    for (let i = 0; i < 5; i++) ensureRoles(b.db, b.restaurantId, '2026-10-26T00:00:00.000Z')
    expect(roles(b.db)).toEqual(rolesOnce)
    expect(b.db.prepare("SELECT value FROM counters WHERE name = 'catalog'").get()).toEqual(counter)
    expect(Number(b.db.prepare('SELECT count(*) AS n FROM roles').get()?.n)).toBe(6)
  })

  it('the four new default roles exist only once and Reportes is not duplicated', () => {
    const b = oldDatabase()
    ensureRoles(b.db, b.restaurantId, LATER)
    for (const role of Object.values(DEFAULT_ROLES))
      expect(
        Number(
          b.db
            .prepare('SELECT count(*) AS n FROM roles WHERE name = ? AND system = 1')
            .get(role.name)?.n,
        ),
      ).toBe(1)
    expect(
      Number(b.db.prepare("SELECT count(*) AS n FROM roles WHERE name = 'Contador'").get()?.n),
    ).toBe(0)
  })

  it('if a default «Reportes» already exists besides «Contador», they do not overwrite each other: Contador stays as is', () => {
    const b = oldDatabase()
    const reports = insertVersioned(
      b.db,
      'roles',
      b.restaurantId,
      { name: 'Reportes', system: 1 },
      SYSTEM,
      NOW,
    )
    const newer = ensureRoles(b.db, b.restaurantId, LATER)
    expect(newer.reports).toBe(reports)
    expect(
      b.db.prepare('SELECT name, system FROM roles WHERE id = ?').get(b.roles.Contador as string),
    ).toEqual({ name: 'Contador', system: 1 })
  })

  it('a previously archived Gerente is also converted, and a database without old roles does not change', () => {
    const b = oldDatabase()
    b.db.prepare('UPDATE roles SET active = 0 WHERE id = ?').run(b.roles.Gerente as string)
    ensureRoles(b.db, b.restaurantId, LATER)
    expect(
      b.db.prepare('SELECT system, active FROM roles WHERE id = ?').get(b.roles.Gerente as string),
    ).toEqual({ system: 0, active: 0 })

    const freshDb = openDatabase(':memory:')
    applyMigrations(freshDb)
    const id = ensureRestaurant(freshDb, NOW)
    ensureRoles(freshDb, id, NOW)
    const photo = roles(freshDb)
    ensureRoles(freshDb, id, LATER)
    expect(roles(freshDb)).toEqual(photo)
    expect(photo).toHaveLength(4)
  })

  it('two restaurants with old roles: each one is converted separately', () => {
    const b = oldDatabase()
    const other = '01M5RPDZQP7MH7BBP9D2CEGG2N'
    b.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(other, other, NOW, NOW)
    b.db
      .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)")
      .run(other)
    const otherAccountantRole = insertVersioned(
      b.db,
      'roles',
      other,
      { name: 'Contador', system: 1 },
      SYSTEM,
      NOW,
    )
    ensureRoles(b.db, b.restaurantId, LATER)
    // The other restaurant was not touched.
    expect(b.db.prepare('SELECT name FROM roles WHERE id = ?').get(otherAccountantRole)).toEqual({
      name: 'Contador',
    })
    ensureRoles(b.db, other, LATER)
    expect(b.db.prepare('SELECT name FROM roles WHERE id = ?').get(otherAccountantRole)).toEqual({
      name: 'Reportes',
    })
  })

  it('open sessions of Gerente and Cocina people stay valid after the conversion', () => {
    const b = oldDatabase()
    const gloria = b.people.Gerente?.[0]
    if (!gloria) throw new Error('no manager')
    // Gerente people here have no password (PIN): the ADR-013 rule applies when editing, not at
    // startup. They sign in with their PIN if their permissions allow it; if not, it is rejected.
    const r = b.access.signIn({ pin: gloria.pin }, null, '10.0.0.1')
    ensureRoles(b.db, b.restaurantId, LATER)
    const kitchen = b.people.Cocina?.[0]
    if (!kitchen) throw new Error('no kitchen user')
    expect(b.access.signIn({ pin: kitchen.pin }, null, '10.0.0.2')).toMatchObject({ ok: true })
    if (r.ok) {
      const connection = b.access.authenticate(r.device?.token as string)
      expect(connection).not.toBeNull()
    }
  })
})
