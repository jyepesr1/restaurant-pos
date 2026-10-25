import { type ClaveRol, nuevoId, ROLES_DE_FABRICA, ROLES_RETIRADOS } from '@pos/core'
import { type BaseSqlite, enTransaccion } from '@pos/db'
import { actualizarVersionado, insertarVersionado, SISTEMA } from './registros'
import { generarContrasena } from './secretos'
import type { ServicioAcceso } from './servicio'

// Lo mínimo para que un hub recién instalado funcione: el restaurante, su sede, los roles de
// fábrica y un administrador. Correrlo otra vez no duplica nada.

const ZONA_HORARIA = 'America/Bogota'

/** El restaurante del hub; si no hay, lo crea con su sede principal. */
export function asegurarRestaurante(db: BaseSqlite, ahora: string): string {
  const existente = db
    .prepare('SELECT id FROM restaurante WHERE activo = 1 ORDER BY creado_en, id LIMIT 1')
    .get()
  if (existente) return String(existente.id)

  return enTransaccion(db, () => {
    // El contador de versiones pide que el restaurante exista: este primer registro toma la 1.
    const id = nuevoId()
    db.prepare(
      `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
       VALUES (?, ?, ?, ?, 1, 'Mi restaurante', '{}')`,
    ).run(id, id, ahora, ahora)
    db.prepare(
      "INSERT INTO contador (restaurante_id, nombre, valor) VALUES (?, 'catalogo', 1)",
    ).run(id)
    insertarVersionado(
      db,
      'sede',
      id,
      { nombre: 'Principal', direccion: null, zona_horaria: ZONA_HORARIA },
      SISTEMA,
      ahora,
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
  db: BaseSqlite,
  restauranteId: string,
  ahora: string,
): Record<ClaveRol, string> {
  return enTransaccion(db, () => {
    const delSistema = (nombre: string) =>
      db
        .prepare(
          'SELECT id FROM rol WHERE restaurante_id = ? AND sistema = 1 AND nombre = ? ORDER BY creado_en LIMIT 1',
        )
        .get(restauranteId, nombre)
    for (const [viejo, nuevo] of Object.entries(ROLES_RETIRADOS.renombrar)) {
      const rol = delSistema(viejo)
      if (rol && !delSistema(nuevo))
        actualizarVersionado(
          db,
          'rol',
          restauranteId,
          String(rol.id),
          { nombre: nuevo },
          SISTEMA,
          ahora,
        )
    }
    for (const nombre of ROLES_RETIRADOS.propios) {
      const rol = delSistema(nombre)
      if (rol)
        actualizarVersionado(
          db,
          'rol',
          restauranteId,
          String(rol.id),
          { sistema: 0 },
          SISTEMA,
          ahora,
        )
    }

    const roles = {} as Record<ClaveRol, string>
    for (const [clave, rol] of Object.entries(ROLES_DE_FABRICA) as [
      ClaveRol,
      (typeof ROLES_DE_FABRICA)[ClaveRol],
    ][]) {
      const existente = db
        .prepare(
          'SELECT id FROM rol WHERE restaurante_id = ? AND sistema = 1 AND nombre = ? ORDER BY creado_en LIMIT 1',
        )
        .get(restauranteId, rol.nombre)
      if (existente) {
        roles[clave] = String(existente.id)
        continue
      }
      const rolId = insertarVersionado(
        db,
        'rol',
        restauranteId,
        { nombre: rol.nombre, sistema: 1 },
        SISTEMA,
        ahora,
      )
      for (const permiso of rol.permisos)
        insertarVersionado(
          db,
          'rol_permiso',
          restauranteId,
          { rol_id: rolId, permiso },
          SISTEMA,
          ahora,
        )
      roles[clave] = rolId
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
  usuario: string | null
  contrasena: string | null
  avisos: string[]
}

/**
 * Si nadie activo puede administrar usuarios, crea el usuario «Administrador» con usuario,
 * contraseña y PIN para autorizar. Si la clave de los PIN es nueva pero ya había usuarios (se
 * perdió la clave), ningún PIN guardado sirve: regenera el del administrador y avisa que hay que
 * regenerar los demás. Un administrador de antes de ADR-013, que entraba con PIN, recibe usuario
 * y contraseña.
 */
export function asegurarAdministrador(
  db: BaseSqlite,
  acceso: ServicioAcceso,
  rolAdmin: string,
  claveNueva: boolean,
): Administrador {
  const restauranteId = acceso.restaurante
  // Alguien que puede administrar, tenga o no contraseña (uno de antes de ADR-013 no la tiene).
  const admin = db
    .prepare(
      `SELECT u.id FROM usuario u
       JOIN rol r ON r.id = u.rol_id AND r.activo = 1
       JOIN rol_permiso rp ON rp.rol_id = r.id AND rp.activo = 1 AND rp.permiso = 'administrar_usuarios'
       WHERE u.restaurante_id = ? AND u.activo = 1
       ORDER BY u.creado_en, u.id LIMIT 1`,
    )
    .get(restauranteId)
  if (!admin) {
    const contrasena = generarContrasena()
    const { pin } = acceso.crearUsuario({
      nombre: 'Administrador',
      rolId: rolAdmin,
      usuario: USUARIO_ADMIN,
      contrasena,
    })
    return { pin, usuario: USUARIO_ADMIN, contrasena, avisos: [] }
  }
  const resultado: Administrador = { pin: null, usuario: null, contrasena: null, avisos: [] }
  const adminId = String(admin.id)
  const credenciales = db
    .prepare('SELECT count(*) AS n FROM usuario_credencial WHERE restaurante_id = ?')
    .get(restauranteId)
  if (claveNueva && Number(credenciales?.n) > 0) {
    resultado.pin = acceso.regenerarPin(adminId)
    resultado.avisos.push(
      'Falta la clave de los PIN (¿se restauró la base sin ella?). Los PIN anteriores ya no sirven:',
      'se generó uno nuevo para el administrador; con él, regenera el PIN de cada persona.',
    )
  }
  if (!acceso.tieneContrasena(adminId)) {
    const usuario = usuarioLibre(db, restauranteId, USUARIO_ADMIN)
    const contrasena = generarContrasena()
    acceso.ponerContrasena(adminId, usuario, contrasena)
    resultado.usuario = usuario
    resultado.contrasena = contrasena
    resultado.avisos.push(
      'Desde ahora el administrador entra a la caja con usuario y contraseña; su PIN sirve para autorizar.',
    )
  }
  return resultado
}

/** `admin`, o `admin2`, `admin3`… si ya lo tiene otra persona. */
function usuarioLibre(db: BaseSqlite, restauranteId: string, base: string): string {
  for (let i = 1; ; i++) {
    const nombre = i === 1 ? base : `${base}${i}`
    const tomado = db
      .prepare(
        'SELECT 1 FROM usuario_credencial WHERE restaurante_id = ? AND nombre_usuario = ? AND vigente = 1',
      )
      .get(restauranteId, nombre)
    if (!tomado) return nombre
  }
}
