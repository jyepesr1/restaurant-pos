import {
  DESCRIPCION_PERMISOS,
  esPermiso,
  PERMISOS,
  PERMISOS_CON_CONTRASENA,
  type Permiso,
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
  nombre: string
  /** De fábrica: no se renombra ni se archiva. */
  sistema: boolean
  activo: boolean
  permisos: Permiso[]
  /** Cuántas personas activas lo tienen. */
  personas: number
}

export interface PersonaPersonal {
  id: string
  nombre: string
  rolId: string
  activo: boolean
  /** El usuario con que entra a la caja; `null` si entra con su PIN. */
  usuario: string | null
}

export interface EquipoPersonal {
  id: string
  nombre: string
  tipo: string
  registradoEn: string | null
  revocadoEn: string | null
  /** Último uso de una sesión en ese equipo, y de quién. */
  ultimoUso: string | null
  ultimaPersona: string | null
}

const LARGO_NOMBRE = 60

function nombreValido(nombre: string, que: string): string {
  const n = nombre.trim()
  if (n.length === 0 || n.length > LARGO_NOMBRE)
    throw new ErrorPersonal(`El nombre ${que} debe tener entre 1 y ${LARGO_NOMBRE} letras`)
  return n
}

/** Lo que ve la pantalla de personal: todos los roles y personas, también los archivados. */
export function leerPersonal(
  db: BaseSqlite,
  restauranteId: string,
  acceso: ServicioAcceso,
): { roles: RolPersonal[]; personas: PersonaPersonal[]; equipos: EquipoPersonal[] } {
  const roles = db
    .prepare(
      `SELECT r.id, r.nombre, r.sistema, r.activo,
         (SELECT count(*) FROM usuario u WHERE u.rol_id = r.id AND u.activo = 1) AS personas
       FROM rol r WHERE r.restaurante_id = ? AND r.oculto = 0
       ORDER BY r.sistema DESC, r.creado_en, r.id`,
    )
    .all(restauranteId)
    .map((f) => ({
      id: String(f.id),
      nombre: String(f.nombre),
      sistema: f.sistema === 1,
      activo: f.activo === 1,
      permisos: permisosDelRol(db, String(f.id)),
      personas: Number(f.personas),
    }))
  const personas = db
    .prepare(
      // Los usuarios técnicos de las pantallas de cocina no son personas (ADR-015).
      'SELECT id, nombre, rol_id, activo FROM usuario WHERE restaurante_id = ? AND pantalla = 0 ORDER BY activo DESC, nombre, id',
    )
    .all(restauranteId)
    .map((f) => ({
      id: String(f.id),
      nombre: String(f.nombre),
      rolId: String(f.rol_id),
      activo: f.activo === 1,
      usuario: acceso.usuarioDe(String(f.id)),
    }))
  // Los equipos, con el uso más reciente primero: el que se perdió suele ser uno que no se usa.
  const equipos = db
    .prepare(
      `SELECT d.id, d.nombre, d.tipo, d.emparejado_en, d.revocado_en, s.ultimo_uso, u.nombre AS persona
       FROM dispositivo d
       LEFT JOIN sesion s ON s.id = (
         SELECT id FROM sesion WHERE dispositivo_id = d.id ORDER BY ultimo_uso DESC LIMIT 1)
       LEFT JOIN usuario u ON u.id = s.usuario_id
       WHERE d.restaurante_id = ? AND d.activo = 1
       ORDER BY d.revocado_en IS NOT NULL, coalesce(s.ultimo_uso, d.emparejado_en) DESC`,
    )
    .all(restauranteId)
    .map((f) => ({
      id: String(f.id),
      nombre: String(f.nombre),
      tipo: String(f.tipo),
      registradoEn: f.emparejado_en === null ? null : String(f.emparejado_en),
      revocadoEn: f.revocado_en === null ? null : String(f.revocado_en),
      ultimoUso: f.ultimo_uso === null ? null : String(f.ultimo_uso),
      ultimaPersona: f.persona === null ? null : String(f.persona),
    }))
  return { roles, personas, equipos }
}

function permisosDelRol(db: BaseSqlite, rolId: string): Permiso[] {
  return db
    .prepare('SELECT permiso FROM rol_permiso WHERE rol_id = ? AND activo = 1 ORDER BY permiso')
    .all(rolId)
    .map((f) => String(f.permiso))
    .filter(esPermiso)
}

/** Crea un rol o cambia su nombre, sus permisos o si está activo. Devuelve su id. */
export function guardarRol(
  db: BaseSqlite,
  restauranteId: string,
  acceso: ServicioAcceso,
  datos: { id?: string; nombre: string; permisos: readonly string[]; activo?: boolean },
  autor: Autor,
  ahora: string,
): string {
  const nombre = nombreValido(datos.nombre, 'del rol')
  const permisos = [...new Set(datos.permisos)]
  const desconocido = permisos.find((p) => !esPermiso(p))
  if (desconocido) throw new ErrorPersonal(`Permiso desconocido: ${desconocido}`)

  return enTransaccion(db, () => {
    const actual = datos.id
      ? db
          .prepare('SELECT * FROM rol WHERE restaurante_id = ? AND id = ?')
          .get(restauranteId, datos.id)
      : undefined
    if (datos.id && !actual) throw new ErrorPersonal('Ese rol no existe')
    if (actual?.oculto === 1) throw new ErrorPersonal('Ese rol no existe')
    const activo = datos.activo ?? (actual ? actual.activo === 1 : true)
    if (actual?.sistema === 1) {
      if (nombre !== actual.nombre)
        throw new ErrorPersonal('Los roles de fábrica no se renombran: crea uno nuevo')
      if (!activo) throw new ErrorPersonal('Los roles de fábrica no se archivan')
    }
    if (activo) {
      const repetido = db
        .prepare(
          'SELECT id, nombre FROM rol WHERE restaurante_id = ? AND activo = 1 AND oculto = 0',
        )
        .all(restauranteId)
        .find(
          (f) =>
            f.id !== datos.id &&
            String(f.nombre).toLocaleLowerCase('es') === nombre.toLocaleLowerCase('es'),
        )
      if (repetido) throw new ErrorPersonal(`Ya hay un rol que se llama «${repetido.nombre}»`)
    }

    let rolId: string
    if (actual) {
      rolId = String(actual.id)
      if (!activo && actual.activo === 1) {
        const gente = db
          .prepare('SELECT count(*) AS n FROM usuario WHERE rol_id = ? AND activo = 1')
          .get(rolId)
        if (Number(gente?.n) > 0)
          throw new ErrorPersonal('Ese rol tiene personas: pásalas a otro rol antes de archivarlo')
      }
      if (nombre !== actual.nombre || activo !== (actual.activo === 1))
        actualizarVersionado(
          db,
          'rol',
          restauranteId,
          rolId,
          { nombre, activo: activo ? 1 : 0 },
          autor,
          ahora,
        )
    } else {
      rolId = insertarVersionado(db, 'rol', restauranteId, { nombre, sistema: 0 }, autor, ahora)
    }

    // Un permiso que se quita queda archivado; si se vuelve a dar, se reactiva la misma fila.
    const filas = db
      .prepare('SELECT id, permiso, activo FROM rol_permiso WHERE rol_id = ?')
      .all(rolId)
    for (const permiso of PERMISOS) {
      const fila = filas.find((f) => f.permiso === permiso)
      const quiere = permisos.includes(permiso)
      if (!fila) {
        if (quiere)
          insertarVersionado(
            db,
            'rol_permiso',
            restauranteId,
            { rol_id: rolId, permiso },
            autor,
            ahora,
          )
      } else if (quiere !== (fila.activo === 1)) {
        actualizarVersionado(
          db,
          'rol_permiso',
          restauranteId,
          String(fila.id),
          { activo: quiere ? 1 : 0 },
          autor,
          ahora,
        )
      }
    }
    const delRol = db
      .prepare('SELECT id FROM usuario WHERE rol_id = ? AND activo = 1')
      .all(rolId)
      .map((f) => String(f.id))
    exigirContrasena(db, restauranteId, acceso, delRol)
    exigirAdministrador(db, restauranteId)
    return rolId
  })
}

/** Cómo entra una persona: con su PIN, o con usuario y contraseña (y el PIN solo autoriza). */
export type AccesoPersona =
  | { tipo: 'pin' }
  | { tipo: 'contrasena'; usuario: string; contrasena?: string }

/**
 * Crea a una persona o cambia su nombre, su rol, cómo entra o si está activa. Devuelve su id y el
 * PIN si es nuevo o se regeneró (el PIN solo se ve esta vez). Cambiar el rol o cómo entra cierra
 * sus sesiones, para que su equipo vuelva a pedirle que entre con lo nuevo.
 */
export function guardarPersona(
  db: BaseSqlite,
  restauranteId: string,
  acceso: ServicioAcceso,
  datos: {
    id?: string
    nombre: string
    rolId: string
    activo?: boolean
    acceso?: AccesoPersona
    regenerarPin?: boolean
  },
  autor: Autor,
  ahora: string,
): { usuarioId: string; pin: string | null } {
  const nombre = nombreValido(datos.nombre, 'de la persona')
  return enTransaccion(db, () => {
    const rol = db
      .prepare('SELECT activo FROM rol WHERE restaurante_id = ? AND id = ? AND oculto = 0')
      .get(restauranteId, datos.rolId)
    if (!rol) throw new ErrorPersonal('Ese rol no existe')

    const actual = datos.id
      ? db
          .prepare('SELECT * FROM usuario WHERE restaurante_id = ? AND id = ?')
          .get(restauranteId, datos.id)
      : undefined
    if (datos.id && (!actual || actual.pantalla === 1))
      throw new ErrorPersonal('Esa persona no existe')
    const activo = datos.activo ?? (actual ? actual.activo === 1 : true)
    if (activo && rol.activo !== 1) throw new ErrorPersonal('Ese rol está archivado')

    // Solo los errores de datos (usuario tomado, contraseña corta) se muestran tal cual.
    const conError = <T>(trabajo: () => T): T => {
      try {
        return trabajo()
      } catch (e) {
        throw e instanceof ErrorDatos ? new ErrorPersonal(e.message) : e
      }
    }

    if (!actual) {
      const entra = datos.acceso ?? { tipo: 'pin' }
      if (entra.tipo === 'contrasena' && !entra.contrasena)
        throw new ErrorPersonal('Escribe una contraseña para esta persona')
      const { usuarioId, pin } = conError(() =>
        acceso.insertarUsuario(
          {
            nombre,
            rolId: datos.rolId,
            ...(entra.tipo === 'contrasena'
              ? { usuario: entra.usuario, contrasena: entra.contrasena }
              : {}),
          },
          autor,
        ),
      )
      exigirContrasena(db, restauranteId, acceso, [usuarioId])
      exigirAdministrador(db, restauranteId)
      return { usuarioId, pin }
    }

    const usuarioId = String(actual.id)
    const cambiaRol = datos.rolId !== actual.rol_id

    // Primero cómo entra: así, al volver a activarla, su usuario ya no choca con el de otra.
    const entra = datos.acceso
    if (entra?.tipo === 'pin' && acceso.tieneContrasena(usuarioId))
      acceso.quitarContrasena(usuarioId)
    if (entra?.tipo === 'contrasena') {
      const usuarioActual = acceso.usuarioDe(usuarioId)
      if (entra.contrasena)
        conError(() => acceso.fijarContrasena(usuarioId, entra.usuario, entra.contrasena as string))
      else if (usuarioActual === null)
        throw new ErrorPersonal('Escribe una contraseña para esta persona')
      else if (entra.usuario.trim().toLowerCase() !== usuarioActual)
        throw new ErrorPersonal('Para cambiar el usuario, escribe también una contraseña')
    }

    // Mientras estaba archivada, su PIN o su usuario pudieron quedar en otra persona: el PIN se
    // cambia por uno libre; el usuario lo tiene que cambiar quien la activa.
    let pinNuevo: string | null = null
    if (activo && actual.activo !== 1) {
      const choca = (columna: 'pin_huella' | 'nombre_usuario') =>
        db
          .prepare(
            `SELECT 1 FROM usuario_credencial esta JOIN usuario_credencial otra
               ON otra.restaurante_id = esta.restaurante_id AND otra.${columna} = esta.${columna}
             WHERE esta.usuario_id = ? AND otra.vigente = 1 AND otra.usuario_id <> esta.usuario_id`,
          )
          .get(usuarioId) !== undefined
      if (choca('nombre_usuario'))
        throw new ErrorPersonal(
          `Su usuario «${acceso.usuarioDe(usuarioId)}» ya lo tiene otra persona: ponle otro, con una contraseña`,
        )
      if (choca('pin_huella')) pinNuevo = acceso.regenerarPin(usuarioId)
    }

    if (nombre !== actual.nombre || cambiaRol || activo !== (actual.activo === 1))
      actualizarVersionado(
        db,
        'usuario',
        restauranteId,
        usuarioId,
        { nombre, rol_id: datos.rolId, activo: activo ? 1 : 0 },
        autor,
        ahora,
      )
    if (cambiaRol || !activo) cerrarSesionesDe(db, restauranteId, usuarioId, ahora)

    const pin = datos.regenerarPin ? acceso.regenerarPin(usuarioId) : pinNuevo
    exigirContrasena(db, restauranteId, acceso, [usuarioId])
    exigirAdministrador(db, restauranteId)
    return { usuarioId, pin }
  })
}

function cerrarSesionesDe(db: BaseSqlite, restauranteId: string, usuarioId: string, ahora: string) {
  db.prepare(
    'UPDATE sesion SET cerrada_en = ? WHERE restaurante_id = ? AND usuario_id = ? AND cerrada_en IS NULL',
  ).run(ahora, restauranteId, usuarioId)
}

const NOMBRE_PERMISO = new Map(
  DESCRIPCION_PERMISOS.flatMap((g) => g.permisos.map((p) => [p.permiso, p.nombre] as const)),
)

/**
 * Quien entra con PIN no puede tener permisos que pidan contraseña (`PERMISOS_CON_CONTRASENA`): un
 * PIN de 4 dígitos se adivina más fácil. Se revisa al final del cambio, dentro de la transacción.
 */
function exigirContrasena(
  db: BaseSqlite,
  restauranteId: string,
  acceso: ServicioAcceso,
  usuarioIds: readonly string[],
) {
  for (const id of usuarioIds) {
    const f = db
      .prepare('SELECT nombre, activo FROM usuario WHERE restaurante_id = ? AND id = ?')
      .get(restauranteId, id)
    if (f?.activo !== 1 || acceso.tieneContrasena(id)) continue
    const delicado = acceso.permisosDe(id).find((p) => PERMISOS_CON_CONTRASENA.has(p))
    if (delicado)
      throw new ErrorPersonal(
        `${f.nombre} entra con PIN y su rol permite «${NOMBRE_PERMISO.get(delicado) ?? delicado}»: dale usuario y contraseña, o quita ese permiso`,
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
      `SELECT u.id FROM usuario u
       JOIN rol r ON r.id = u.rol_id AND r.activo = 1
       JOIN rol_permiso rp ON rp.rol_id = r.id AND rp.activo = 1 AND rp.permiso = 'administrar_usuarios'
       JOIN usuario_credencial c ON c.usuario_id = u.id AND c.nombre_usuario IS NOT NULL
       WHERE u.restaurante_id = ? AND u.activo = 1 ORDER BY u.creado_en, u.id`,
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
