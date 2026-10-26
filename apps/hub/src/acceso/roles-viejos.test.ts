import { DEFAULT_ROLES } from '@pos/core'
import { aplicarMigraciones, type BaseSqlite } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { describe, expect, it } from 'vitest'
import { asegurarRestaurante, asegurarRoles } from './inicial'
import { insertarVersionado, SISTEMA } from './registros'
import { ServicioAcceso } from './servicio'

// Conversión de los roles de antes de ADR-013 (Gerente, Cocina, Contador) al arrancar el hub:
// idempotente, con gente asignada, sin perder permisos ni sesiones.

const AHORA = '2026-10-24T20:00:00.000Z'
const MAS_TARDE = '2026-10-25T08:00:00.000Z'

const VIEJOS: Record<string, readonly string[]> = {
  Administrador: ['manage_users', 'manage_devices', 'take_order'],
  Gerente: ['take_order', 'apply_discount', 'view_reports', 'edit_catalog'],
  Cajero: ['take_order', 'record_payment'],
  Mesero: ['take_order'],
  Cocina: ['mark_preparation', 'mark_product_sold_out'],
  Contador: ['view_reports'],
}

/** Una base como la dejaba la tarea 0.7: roles de fábrica viejos, cada uno con su gente. */
function baseVieja() {
  const db = abrirBase(':memory:')
  aplicarMigraciones(db)
  const restauranteId = asegurarRestaurante(db, AHORA)
  const roles: Record<string, string> = {}
  for (const [name, permissions] of Object.entries(VIEJOS)) {
    roles[name] = insertarVersionado(
      db,
      'roles',
      restauranteId,
      { name, system: 1 },
      SISTEMA,
      AHORA,
    )
    for (const permission of permissions)
      insertarVersionado(
        db,
        'role_permissions',
        restauranteId,
        { role_id: roles[name] as string, permission },
        SISTEMA,
        AHORA,
      )
  }
  const access = new ServicioAcceso({
    db,
    restauranteId,
    key: Buffer.alloc(32, 5),
    clock: () => AHORA,
    costoContrasena: 1,
  })
  const gente: Record<string, { userId: string; pin: string }[]> = {}
  for (const [name, rolId] of Object.entries(roles))
    gente[name] = [1, 2].map((n) => access.crearUsuario({ name: `${name} ${n}`, rolId }))
  return { db, restauranteId, roles, access, gente }
}

const roles = (db: BaseSqlite) =>
  db.prepare('SELECT id, name, system, active, version FROM roles ORDER BY name, id').all()
const permissions = (db: BaseSqlite) =>
  db
    .prepare(
      'SELECT role_id, permission, active, version FROM role_permissions ORDER BY role_id, permission',
    )
    .all()

describe('conversión de los roles de antes', () => {
  it('Contador pasa a Reportes (mismo id y permisos); Gerente y Cocina quedan propios y activos, con su gente', () => {
    const b = baseVieja()
    const before = permissions(b.db)
    const nuevos = asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
    const row = (id: string) =>
      b.db.prepare('SELECT name, system, active FROM roles WHERE id = ?').get(id)
    expect(nuevos.reports).toBe(b.roles.Contador as string)
    expect(row(b.roles.Contador as string)).toEqual({ name: 'Reportes', system: 1, active: 1 })
    expect(row(b.roles.Gerente as string)).toEqual({ name: 'Gerente', system: 0, active: 1 })
    expect(row(b.roles.Cocina as string)).toEqual({ name: 'Cocina', system: 0, active: 1 })
    // Los de fábrica que siguen (Administrador, Cajero, Mesero) conservan su id.
    expect(nuevos.admin).toBe(b.roles.Administrador as string)
    expect(nuevos.cashier).toBe(b.roles.Cajero as string)
    expect(nuevos.waiter).toBe(b.roles.Mesero as string)
    // Nadie pierde a su rol ni sus permisos: la conversión no reescribe permisos.
    expect(permissions(b.db)).toEqual(before)
    for (const name of ['Gerente', 'Cocina', 'Contador'])
      for (const g of b.gente[name] ?? [])
        expect(b.access.permisosDe(g.userId)).toEqual([...(VIEJOS[name] ?? [])].sort())
  })

  it('es idempotente: correrlo 5 veces no cambia versiones ni filas ni duplica roles', () => {
    const b = baseVieja()
    asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
    const rolesUna = roles(b.db)
    const counter = b.db.prepare("SELECT value FROM counters WHERE name = 'catalog'").get()
    for (let i = 0; i < 5; i++) asegurarRoles(b.db, b.restauranteId, '2026-10-26T00:00:00.000Z')
    expect(roles(b.db)).toEqual(rolesUna)
    expect(b.db.prepare("SELECT value FROM counters WHERE name = 'catalog'").get()).toEqual(counter)
    expect(Number(b.db.prepare('SELECT count(*) AS n FROM roles').get()?.n)).toBe(6)
  })

  it('los cuatro roles de fábrica nuevos existen una sola vez y Reportes no se duplica', () => {
    const b = baseVieja()
    asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
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

  it('si ya hay un «Reportes» de fábrica además de «Contador», no se pisan: Contador queda como está', () => {
    const b = baseVieja()
    const reports = insertarVersionado(
      b.db,
      'roles',
      b.restauranteId,
      { name: 'Reportes', system: 1 },
      SISTEMA,
      AHORA,
    )
    const nuevos = asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
    expect(nuevos.reports).toBe(reports)
    expect(
      b.db.prepare('SELECT name, system FROM roles WHERE id = ?').get(b.roles.Contador as string),
    ).toEqual({ name: 'Contador', system: 1 })
  })

  it('un Gerente archivado antes también se convierte, y una base sin roles viejos no cambia', () => {
    const b = baseVieja()
    b.db.prepare('UPDATE roles SET active = 0 WHERE id = ?').run(b.roles.Gerente as string)
    asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
    expect(
      b.db.prepare('SELECT system, active FROM roles WHERE id = ?').get(b.roles.Gerente as string),
    ).toEqual({ system: 0, active: 0 })

    const newOne = abrirBase(':memory:')
    aplicarMigraciones(newOne)
    const id = asegurarRestaurante(newOne, AHORA)
    asegurarRoles(newOne, id, AHORA)
    const photo = roles(newOne)
    asegurarRoles(newOne, id, MAS_TARDE)
    expect(roles(newOne)).toEqual(photo)
    expect(photo).toHaveLength(4)
  })

  it('dos restaurantes con roles viejos: cada uno se convierte por separado', () => {
    const b = baseVieja()
    const other = '01M5RPDZQP7MH7BBP9D2CEGG2N'
    b.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(other, other, AHORA, AHORA)
    b.db
      .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)")
      .run(other)
    const contadorOtro = insertarVersionado(
      b.db,
      'roles',
      other,
      { name: 'Contador', system: 1 },
      SISTEMA,
      AHORA,
    )
    asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
    // El otro restaurante no se tocó.
    expect(b.db.prepare('SELECT name FROM roles WHERE id = ?').get(contadorOtro)).toEqual({
      name: 'Contador',
    })
    asegurarRoles(b.db, other, MAS_TARDE)
    expect(b.db.prepare('SELECT name FROM roles WHERE id = ?').get(contadorOtro)).toEqual({
      name: 'Reportes',
    })
  })

  it('las sesiones abiertas de la gente de Gerente y Cocina siguen valiendo tras la conversión', () => {
    const b = baseVieja()
    const gloria = b.gente.Gerente?.[0]
    if (!gloria) throw new Error('sin gerente')
    // Los de Gerente aquí no tienen contraseña (PIN): la regla de ADR-013 se aplica al editar, no
    // al arrancar. Entran con su PIN si sus permisos lo permiten; si no, la entrada se rechaza.
    const r = b.access.entrar({ pin: gloria.pin }, null, '10.0.0.1')
    asegurarRoles(b.db, b.restauranteId, MAS_TARDE)
    const kitchen = b.gente.Cocina?.[0]
    if (!kitchen) throw new Error('sin cocina')
    expect(b.access.entrar({ pin: kitchen.pin }, null, '10.0.0.2')).toMatchObject({ ok: true })
    if (r.ok) {
      const connection = b.access.authenticate(r.device?.token as string)
      expect(connection).not.toBeNull()
    }
  })
})
