import { type ClaveRol, nuevoId, ROLES_DE_FABRICA } from '@pos/core'
import { type BaseSqlite, enTransaccion } from '@pos/db'
import { insertarVersionado, SISTEMA } from './registros'
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

/** Los roles de fábrica (se reconocen por su nombre entre los del sistema). */
export function asegurarRoles(
  db: BaseSqlite,
  restauranteId: string,
  ahora: string,
): Record<ClaveRol, string> {
  return enTransaccion(db, () => {
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

/**
 * Si nadie activo puede administrar usuarios, crea el usuario «Administrador». Si la clave de
 * los PIN es nueva pero ya había usuarios (se perdió la clave), ningún PIN guardado sirve:
 * regenera el del administrador para poder entrar y avisa que hay que regenerar los demás.
 */
export function asegurarAdministrador(
  db: BaseSqlite,
  acceso: ServicioAcceso,
  rolAdmin: string,
  claveNueva: boolean,
): { pin: string | null; avisos: string[] } {
  const admin = db
    .prepare(
      `SELECT u.id FROM usuario u
       JOIN rol_permiso rp ON rp.rol_id = u.rol_id AND rp.activo = 1
       WHERE u.activo = 1 AND rp.permiso = 'administrar_usuarios'
       ORDER BY u.creado_en LIMIT 1`,
    )
    .get()
  if (!admin) {
    const { pin } = acceso.crearUsuario({ nombre: 'Administrador', rolId: rolAdmin })
    return { pin, avisos: [] }
  }
  const credenciales = db.prepare('SELECT count(*) AS n FROM usuario_credencial').get()
  if (claveNueva && Number(credenciales?.n) > 0) {
    return {
      pin: acceso.regenerarPin(String(admin.id)),
      avisos: [
        'Falta la clave de los PIN (¿se restauró la base sin ella?). Los PIN anteriores ya no sirven:',
        'se generó uno nuevo para el administrador; con él, regenera el PIN de cada persona.',
      ],
    }
  }
  return { pin: null, avisos: [] }
}
