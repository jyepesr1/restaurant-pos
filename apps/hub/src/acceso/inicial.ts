import { DEFAULT_ROLES, newId, RETIRED_ROLES, type RoleKey } from '@pos/core'
import { inTransaction, type SqliteDatabase } from '@pos/db'
import { actualizarVersionado, insertVersioned, SISTEMA } from './registros'
import { generarContrasena } from './secretos'
import type { ServicioAcceso } from './servicio'

// Lo mínimo para que un hub recién instalado funcione: el restaurante, su sede, los roles de
// fábrica y un administrador. Correrlo otra vez no duplica nada.

const ZONA_HORARIA = 'America/Bogota'

/** El restaurante del hub; si no hay, lo crea con su sede principal. */
export function asegurarRestaurante(db: SqliteDatabase, now: string): string {
  const existente = db
    .prepare('SELECT id FROM restaurants WHERE active = 1 ORDER BY created_at, id LIMIT 1')
    .get()
  if (existente) return String(existente.id)

  return inTransaction(db, () => {
    // El contador de versiones pide que el restaurante exista: este primer registro toma la 1.
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
      { name: 'Principal', address: null, time_zone: ZONA_HORARIA },
      SISTEMA,
      now,
    )
    return id
  })
}

/**
 * Los roles de fábrica (se reconocen por su nombre entre los del sistema). Un hub de antes de
 * ADR-013 convierte los suyos: Contador pasa a ser Reportes, y Gerente y Cocina quedan como roles
 * propios del restaurante, con sus permisos y su gente.
 */
export function asegurarRoles(
  db: SqliteDatabase,
  restaurantId: string,
  now: string,
): Record<RoleKey, string> {
  return inTransaction(db, () => {
    const delSistema = (name: string) =>
      db
        .prepare(
          'SELECT id FROM roles WHERE restaurant_id = ? AND system = 1 AND name = ? ORDER BY created_at LIMIT 1',
        )
        .get(restaurantId, name)
    for (const [oldOne, fresh] of Object.entries(RETIRED_ROLES.rename)) {
      const role = delSistema(oldOne)
      if (role && !delSistema(fresh))
        actualizarVersionado(
          db,
          'roles',
          restaurantId,
          String(role.id),
          { name: fresh },
          SISTEMA,
          now,
        )
    }
    for (const name of RETIRED_ROLES.ownOnes) {
      const role = delSistema(name)
      if (role)
        actualizarVersionado(
          db,
          'roles',
          restaurantId,
          String(role.id),
          { system: 0 },
          SISTEMA,
          now,
        )
    }

    const roles = {} as Record<RoleKey, string>
    for (const [key, role] of Object.entries(DEFAULT_ROLES) as [
      RoleKey,
      (typeof DEFAULT_ROLES)[RoleKey],
    ][]) {
      const existente = db
        .prepare(
          'SELECT id FROM roles WHERE restaurant_id = ? AND system = 1 AND name = ? ORDER BY created_at LIMIT 1',
        )
        .get(restaurantId, role.name)
      if (existente) {
        roles[key] = String(existente.id)
        continue
      }
      const rolId = insertVersioned(
        db,
        'roles',
        restaurantId,
        { name: role.name, system: 1 },
        SISTEMA,
        now,
      )
      for (const permission of role.permissions)
        insertVersioned(
          db,
          'role_permissions',
          restaurantId,
          { role_id: rolId, permission },
          SISTEMA,
          now,
        )
      roles[key] = rolId
    }
    return roles
  })
}

/** Usuario con que entra el administrador que crea el hub. */
export const USUARIO_ADMIN = 'admin'

export interface Administrador {
  /** PIN nuevo (para autorizar), si se creó o regeneró en este arranque. */
  pin: string | null
  /** Usuario y contraseña nuevos, si se crearon en este arranque. */
  user: string | null
  password: string | null
  alerts: string[]
}

/**
 * Si nadie activo puede administrar usuarios, crea el usuario «Administrador» con usuario,
 * contraseña y PIN para autorizar. Si la clave de los PIN es nueva pero ya había usuarios (se
 * perdió la clave), ningún PIN guardado sirve: regenera el del administrador y avisa que hay que
 * regenerar los demás. Un administrador de antes de ADR-013, que entraba con PIN, recibe usuario
 * y contraseña.
 */
export function asegurarAdministrador(
  db: SqliteDatabase,
  access: ServicioAcceso,
  rolAdmin: string,
  claveNueva: boolean,
): Administrador {
  const restaurantId = access.restaurant
  // Alguien que puede administrar, tenga o no contraseña (uno de antes de ADR-013 no la tiene).
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
    const password = generarContrasena()
    const { pin } = access.crearUsuario({
      name: 'Administrador',
      rolId: rolAdmin,
      user: USUARIO_ADMIN,
      password,
    })
    return { pin, user: USUARIO_ADMIN, password, alerts: [] }
  }
  const result: Administrador = { pin: null, user: null, password: null, alerts: [] }
  const adminId = String(admin.id)
  const credenciales = db
    .prepare('SELECT count(*) AS n FROM user_credentials WHERE restaurant_id = ?')
    .get(restaurantId)
  if (claveNueva && Number(credenciales?.n) > 0) {
    result.pin = access.regenerarPin(adminId)
    result.alerts.push(
      'Falta la clave de los PIN (¿se restauró la base sin ella?). Los PIN anteriores ya no sirven:',
      'se generó uno nuevo para el administrador; con él, regenera el PIN de cada persona.',
    )
  }
  if (!access.tieneContrasena(adminId)) {
    const user = usuarioLibre(db, restaurantId, USUARIO_ADMIN)
    const password = generarContrasena()
    access.ponerContrasena(adminId, user, password)
    result.user = user
    result.password = password
    result.alerts.push(
      'Desde ahora el administrador entra a la caja con usuario y contraseña; su PIN sirve para autorizar.',
    )
  }
  return result
}

/** `admin`, o `admin2`, `admin3`… si ya lo tiene otra persona. */
function usuarioLibre(db: SqliteDatabase, restaurantId: string, base: string): string {
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
