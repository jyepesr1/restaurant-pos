import {
  isPermission,
  PASSWORD_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  PERMISSIONS,
  type Permission,
} from '@pos/core'
import { type BaseSqlite, enTransaccion } from '@pos/db'
import { type Autor, actualizarVersionado, insertarVersionado } from './registros'
import { ErrorDatos, type ServicioAcceso } from './servicio'

// Personal y roles (tarea 1.3b, ADR-013): el administrador crea roles, decide qué permisos tiene
// cada uno y da de alta a cada persona. Todo es por restaurante. Dos reglas protegen el local:
// - siempre queda al menos una persona activa que puede administrar el personal (si no, nadie
//   podría volver a entrar a esta pantalla);
// - los roles de fábrica no se renombran ni se archivan (el hub los reconoce por su nombre),
//   pero sus permisos sí se cambian.

export class ErrorPersonal extends Error {}

export interface RolPersonal {
  id: string
  name: string
  /** De fábrica: no se renombra ni se archiva. */
  system: boolean
  active: boolean
  permissions: Permission[]
  /** Cuántas personas activas lo tienen. */
  people: number
}

export interface PersonaPersonal {
  id: string
  name: string
  rolId: string
  active: boolean
  /** El usuario con que entra a la caja; `null` si entra con su PIN. */
  user: string | null
}

export interface EquipoPersonal {
  id: string
  name: string
  type: string
  registradoEn: string | null
  revocadoEn: string | null
  /** Último uso de una sesión en ese equipo, y de quién. */
  ultimoUso: string | null
  ultimaPersona: string | null
}

const LARGO_NOMBRE = 60

function nombreValido(name: string, que: string): string {
  const n = name.trim()
  if (n.length === 0 || n.length > LARGO_NOMBRE)
    throw new ErrorPersonal(`El nombre ${que} debe tener entre 1 y ${LARGO_NOMBRE} letras`)
  return n
}

/** Lo que ve la pantalla de personal: todos los roles y personas, también los archivados. */
export function leerPersonal(
  db: BaseSqlite,
  restauranteId: string,
  access: ServicioAcceso,
): { roles: RolPersonal[]; people: PersonaPersonal[]; devices: EquipoPersonal[] } {
  const roles = db
    .prepare(
      `SELECT r.id, r.name, r.system, r.active,
         (SELECT count(*) FROM users u WHERE u.role_id = r.id AND u.active = 1) AS people
       FROM roles r WHERE r.restaurant_id = ? AND r.hidden = 0
       ORDER BY r.system DESC, r.created_at, r.id`,
    )
    .all(restauranteId)
    .map((f) => ({
      id: String(f.id),
      name: String(f.name),
      system: f.system === 1,
      active: f.active === 1,
      permissions: permisosDelRol(db, String(f.id)),
      people: Number(f.people),
    }))
  const people = db
    .prepare(
      // Los usuarios técnicos de las pantallas de cocina no son personas (ADR-015).
      'SELECT id, name, role_id, active FROM users WHERE restaurant_id = ? AND screen = 0 ORDER BY active DESC, name, id',
    )
    .all(restauranteId)
    .map((f) => ({
      id: String(f.id),
      name: String(f.name),
      rolId: String(f.role_id),
      active: f.active === 1,
      user: access.usuarioDe(String(f.id)),
    }))
  // Los equipos, con el uso más reciente primero: el que se perdió suele ser uno que no se usa.
  const devices = db
    .prepare(
      `SELECT d.id, d.name, d.type, d.paired_at, d.revoked_at, s.last_used, u.name AS persona
       FROM devices d
       LEFT JOIN sessions s ON s.id = (
         SELECT id FROM sessions WHERE device_id = d.id ORDER BY last_used DESC LIMIT 1)
       LEFT JOIN users u ON u.id = s.user_id
       WHERE d.restaurant_id = ? AND d.active = 1
       ORDER BY d.revoked_at IS NOT NULL, coalesce(s.last_used, d.paired_at) DESC`,
    )
    .all(restauranteId)
    .map((f) => ({
      id: String(f.id),
      name: String(f.name),
      type: String(f.type),
      registradoEn: f.paired_at === null ? null : String(f.paired_at),
      revocadoEn: f.revoked_at === null ? null : String(f.revoked_at),
      ultimoUso: f.last_used === null ? null : String(f.last_used),
      ultimaPersona: f.persona === null ? null : String(f.persona),
    }))
  return { roles, people, devices }
}

function permisosDelRol(db: BaseSqlite, rolId: string): Permission[] {
  return db
    .prepare(
      'SELECT permission FROM role_permissions WHERE role_id = ? AND active = 1 ORDER BY permission',
    )
    .all(rolId)
    .map((f) => String(f.permission))
    .filter(isPermission)
}

/** Crea un rol o cambia su nombre, sus permisos o si está activo. Devuelve su id. */
export function guardarRol(
  db: BaseSqlite,
  restauranteId: string,
  access: ServicioAcceso,
  data: { id?: string; name: string; permissions: readonly string[]; active?: boolean },
  autor: Autor,
  ahora: string,
): string {
  const name = nombreValido(data.name, 'del rol')
  const permissions = [...new Set(data.permissions)]
  const unknown = permissions.find((p) => !isPermission(p))
  if (unknown) throw new ErrorPersonal(`Permiso desconocido: ${unknown}`)

  return enTransaccion(db, () => {
    const current = data.id
      ? db
          .prepare('SELECT * FROM roles WHERE restaurant_id = ? AND id = ?')
          .get(restauranteId, data.id)
      : undefined
    if (data.id && !current) throw new ErrorPersonal('Ese rol no existe')
    if (current?.hidden === 1) throw new ErrorPersonal('Ese rol no existe')
    const active = data.active ?? (current ? current.active === 1 : true)
    if (current?.system === 1) {
      if (name !== current.name)
        throw new ErrorPersonal('Los roles de fábrica no se renombran: crea uno nuevo')
      if (!active) throw new ErrorPersonal('Los roles de fábrica no se archivan')
    }
    if (active) {
      const repetido = db
        .prepare('SELECT id, name FROM roles WHERE restaurant_id = ? AND active = 1 AND hidden = 0')
        .all(restauranteId)
        .find(
          (f) =>
            f.id !== data.id &&
            String(f.name).toLocaleLowerCase('es') === name.toLocaleLowerCase('es'),
        )
      if (repetido) throw new ErrorPersonal(`Ya hay un rol que se llama «${repetido.name}»`)
    }

    let rolId: string
    if (current) {
      rolId = String(current.id)
      if (!active && current.active === 1) {
        const gente = db
          .prepare('SELECT count(*) AS n FROM users WHERE role_id = ? AND active = 1')
          .get(rolId)
        if (Number(gente?.n) > 0)
          throw new ErrorPersonal('Ese rol tiene personas: pásalas a otro rol antes de archivarlo')
      }
      if (name !== current.name || active !== (current.active === 1))
        actualizarVersionado(
          db,
          'roles',
          restauranteId,
          rolId,
          { name, active: active ? 1 : 0 },
          autor,
          ahora,
        )
    } else {
      rolId = insertarVersionado(db, 'roles', restauranteId, { name, system: 0 }, autor, ahora)
    }

    // Un permiso que se quita queda archivado; si se vuelve a dar, se reactiva la misma fila.
    const rows = db
      .prepare('SELECT id, permission, active FROM role_permissions WHERE role_id = ?')
      .all(rolId)
    for (const permission of PERMISSIONS) {
      const fila = rows.find((f) => f.permission === permission)
      const quiere = permissions.includes(permission)
      if (!fila) {
        if (quiere)
          insertarVersionado(
            db,
            'role_permissions',
            restauranteId,
            { role_id: rolId, permission },
            autor,
            ahora,
          )
      } else if (quiere !== (fila.active === 1)) {
        actualizarVersionado(
          db,
          'role_permissions',
          restauranteId,
          String(fila.id),
          { active: quiere ? 1 : 0 },
          autor,
          ahora,
        )
      }
    }
    const delRol = db
      .prepare('SELECT id FROM users WHERE role_id = ? AND active = 1')
      .all(rolId)
      .map((f) => String(f.id))
    exigirContrasena(db, restauranteId, access, delRol)
    exigirAdministrador(db, restauranteId)
    return rolId
  })
}

/** Cómo entra una persona: con su PIN, o con usuario y contraseña (y el PIN solo autoriza). */
export type AccesoPersona = { type: 'pin' } | { type: 'password'; user: string; password?: string }

/**
 * Crea a una persona o cambia su nombre, su rol, cómo entra o si está activa. Devuelve su id y el
 * PIN si es nuevo o se regeneró (el PIN solo se ve esta vez). Cambiar el rol o cómo entra cierra
 * sus sesiones, para que su equipo vuelva a pedirle que entre con lo nuevo.
 */
export function guardarPersona(
  db: BaseSqlite,
  restauranteId: string,
  access: ServicioAcceso,
  data: {
    id?: string
    name: string
    rolId: string
    active?: boolean
    access?: AccesoPersona
    regenerarPin?: boolean
  },
  autor: Autor,
  ahora: string,
): { userId: string; pin: string | null } {
  const name = nombreValido(data.name, 'de la persona')
  return enTransaccion(db, () => {
    const role = db
      .prepare('SELECT active FROM roles WHERE restaurant_id = ? AND id = ? AND hidden = 0')
      .get(restauranteId, data.rolId)
    if (!role) throw new ErrorPersonal('Ese rol no existe')

    const current = data.id
      ? db
          .prepare('SELECT * FROM users WHERE restaurant_id = ? AND id = ?')
          .get(restauranteId, data.id)
      : undefined
    if (data.id && (!current || current.screen === 1))
      throw new ErrorPersonal('Esa persona no existe')
    const active = data.active ?? (current ? current.active === 1 : true)
    if (active && role.active !== 1) throw new ErrorPersonal('Ese rol está archivado')

    // Solo los errores de datos (usuario tomado, contraseña corta) se muestran tal cual.
    const conError = <T>(trabajo: () => T): T => {
      try {
        return trabajo()
      } catch (e) {
        throw e instanceof ErrorDatos ? new ErrorPersonal(e.message) : e
      }
    }

    if (!current) {
      const entra = data.access ?? { type: 'pin' }
      if (entra.type === 'password' && !entra.password)
        throw new ErrorPersonal('Escribe una contraseña para esta persona')
      const { userId, pin } = conError(() =>
        access.insertUser(
          {
            name,
            rolId: data.rolId,
            ...(entra.type === 'password' ? { user: entra.user, password: entra.password } : {}),
          },
          autor,
        ),
      )
      exigirContrasena(db, restauranteId, access, [userId])
      exigirAdministrador(db, restauranteId)
      return { userId, pin }
    }

    const userId = String(current.id)
    const cambiaRol = data.rolId !== current.role_id

    // Primero cómo entra: así, al volver a activarla, su usuario ya no choca con el de otra.
    const entra = data.access
    if (entra?.type === 'pin' && access.tieneContrasena(userId)) access.quitarContrasena(userId)
    if (entra?.type === 'password') {
      const usuarioActual = access.usuarioDe(userId)
      if (entra.password)
        conError(() => access.fijarContrasena(userId, entra.user, entra.password as string))
      else if (usuarioActual === null)
        throw new ErrorPersonal('Escribe una contraseña para esta persona')
      else if (entra.user.trim().toLowerCase() !== usuarioActual)
        throw new ErrorPersonal('Para cambiar el usuario, escribe también una contraseña')
    }

    // Mientras estaba archivada, su PIN o su usuario pudieron quedar en otra persona: el PIN se
    // cambia por uno libre; el usuario lo tiene que cambiar quien la activa.
    let pinNuevo: string | null = null
    if (active && current.active !== 1) {
      const choca = (columna: 'pin_hash' | 'username') =>
        db
          .prepare(
            `SELECT 1 FROM user_credentials esta JOIN user_credentials otra
               ON otra.restaurant_id = esta.restaurant_id AND otra.${columna} = esta.${columna}
             WHERE esta.user_id = ? AND otra.current = 1 AND otra.user_id <> esta.user_id`,
          )
          .get(userId) !== undefined
      if (choca('username'))
        throw new ErrorPersonal(
          `Su usuario «${access.usuarioDe(userId)}» ya lo tiene otra persona: ponle otro, con una contraseña`,
        )
      if (choca('pin_hash')) pinNuevo = access.regenerarPin(userId)
    }

    if (name !== current.name || cambiaRol || active !== (current.active === 1))
      actualizarVersionado(
        db,
        'users',
        restauranteId,
        userId,
        { name, role_id: data.rolId, active: active ? 1 : 0 },
        autor,
        ahora,
      )
    if (cambiaRol || !active) cerrarSesionesDe(db, restauranteId, userId, ahora)

    const pin = data.regenerarPin ? access.regenerarPin(userId) : pinNuevo
    exigirContrasena(db, restauranteId, access, [userId])
    exigirAdministrador(db, restauranteId)
    return { userId, pin }
  })
}

function cerrarSesionesDe(db: BaseSqlite, restauranteId: string, userId: string, ahora: string) {
  db.prepare(
    'UPDATE sessions SET closed_at = ? WHERE restaurant_id = ? AND user_id = ? AND closed_at IS NULL',
  ).run(ahora, restauranteId, userId)
}

const NOMBRE_PERMISO = new Map(
  PERMISSION_DESCRIPTIONS.flatMap((g) => g.permissions.map((p) => [p.permission, p.name] as const)),
)

/**
 * Quien entra con PIN no puede tener permisos que pidan contraseña (`PASSWORD_PERMISSIONS`): un
 * PIN de 4 dígitos se adivina más fácil. Se revisa al final del cambio, dentro de la transacción.
 */
function exigirContrasena(
  db: BaseSqlite,
  restauranteId: string,
  access: ServicioAcceso,
  usuarioIds: readonly string[],
) {
  for (const id of usuarioIds) {
    const f = db
      .prepare('SELECT name, active FROM users WHERE restaurant_id = ? AND id = ?')
      .get(restauranteId, id)
    if (f?.active !== 1 || access.tieneContrasena(id)) continue
    const delicado = access.permisosDe(id).find((p) => PASSWORD_PERMISSIONS.has(p))
    if (delicado)
      throw new ErrorPersonal(
        `${f.name} entra con PIN y su rol permite «${NOMBRE_PERMISO.get(delicado) ?? delicado}»: dale usuario y contraseña, o quita ese permiso`,
      )
  }
}

/**
 * Las personas activas, con usuario y contraseña, que pueden administrar el personal de ese
 * restaurante, de la más antigua a la más nueva. La usan el arranque, `restablecer-admin` y la
 * regla de no quedarse sin administrador: así los tres cuentan a las mismas personas.
 */
export function administradores(db: BaseSqlite, restauranteId: string): string[] {
  return db
    .prepare(
      `SELECT u.id FROM users u
       JOIN roles r ON r.id = u.role_id AND r.active = 1
       JOIN role_permissions rp ON rp.role_id = r.id AND rp.active = 1 AND rp.permission = 'manage_users'
       JOIN user_credentials c ON c.user_id = u.id AND c.username IS NOT NULL
       WHERE u.restaurant_id = ? AND u.active = 1 ORDER BY u.created_at, u.id`,
    )
    .all(restauranteId)
    .map((f) => String(f.id))
}

/** Que quede alguien que pueda administrar el personal (si no, se deshace todo el cambio). */
function exigirAdministrador(db: BaseSqlite, restauranteId: string) {
  if (administradores(db, restauranteId).length === 0)
    throw new ErrorPersonal(
      'Tiene que quedar al menos una persona que pueda administrar el personal con usuario y contraseña',
    )
}
