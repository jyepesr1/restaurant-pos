import {
  authorizableFingerprint,
  CHECKOUT_PERMISSIONS,
  constantTimeEqual,
  isPermission,
  type NewEvent,
  newId,
  ONLY_FROM_REGISTER,
  type OrderState,
  PASSWORD_PERMISSIONS,
  type Permission,
  permissionFor,
  SCREEN_PERMISSIONS,
  signEvent,
} from '@pos/core'
import { inTransaction, type Row, type SqliteDatabase, type SqlValue } from '@pos/db'
import type { AccessControl, AccessVerdict, Connection, DeviceType } from '@pos/sync'
import { Intentos } from './intentos'
import { type Autor, actualizarVersionado, insertVersioned, SISTEMA } from './registros'
import {
  COSTO_CONTRASENA,
  contrasenaCoincide,
  esContrasenaValida,
  esPinConFormato,
  generarPin,
  huellaContrasena,
  huellaPin,
  huellaSecreto,
  LARGO_MAXIMO_CONTRASENA,
  mismaHuella,
  normalizarUsuario,
  nuevoCodigoEmparejamiento,
  nuevoSecreto,
  secretoDeSesion,
} from './secretos'

// Entrar (con PIN o con usuario y contraseña), sesiones, comprobantes de supervisor, revocación y
// el emparejamiento por código que queda para la pantalla de cocina (ADR-008 y ADR-013,
// docs/SYNC.md#seguridad). Todo esto vive solo en el hub.

/** El código del QR para emparejar vence a los 5 minutos y sirve una vez. */
export const VIGENCIA_CODIGO_MS = 5 * 60_000
/** El evento autorizado debe crearse en los 2 minutos siguientes al comprobante. */
export const VIGENCIA_AUTORIZACION_MS = 2 * 60_000
/** Y llegar al hub, a más tardar, en este plazo (puede haber quedado en la cola sin conexión). */
export const ENTREGA_AUTORIZADO_MS = 12 * 60 * 60_000
/** Margen por el reloj del dispositivo, ya corregido con el desfase que aprendió. */
const TOLERANCIA_RELOJ_MS = 60_000

export type CodigoAcceso =
  | 'wrong_pin'
  | 'invalid_credentials'
  | 'wait'
  | 'invalid_code'
  | 'invalid_session'
  | 'unpaired_device'
  | 'no_permission'
  | 'self_authorization'
  | 'already_authorized'
  | 'revoked_device'
  | 'invalid_data'

export interface ErrorAcceso {
  ok: false
  code: CodigoAcceso
  message: string
  /** Con `espera` y `wrong_pin`: cuánto esperar antes de volver a intentar. */
  waitMs?: number
}

export interface UsuarioSesion {
  id: string
  name: string
  role: string
}

export interface OpcionesAcceso {
  db: SqliteDatabase
  restaurantId: string
  /** Clave HMAC de los PIN y de los secretos de sesión (`cargarClave`). */
  key: Buffer
  clock?: () => string
  attempts?: Intentos
  /** Se revocó un dispositivo: la sala corta lo que recibe (`FloorSync.revocar`). */
  onRevoke?: (deviceId: string, revokedAt: string) => void
  /**
   * Desde cuándo existe la clave (`cargarClave`). Si se perdió y se creó otra, lo pendiente de
   * sesiones anteriores no se puede comprobar: va a cuarentena en vez de perderse.
   */
  claveDesde?: string
  /** Costo de la huella de las contraseñas (`COSTO_CONTRASENA`); las pruebas usan menos. */
  costoContrasena?: number
}

/** El equipo que el hub registró al entrar desde un navegador sin token. */
export interface EquipoNuevo {
  deviceId: string
  token: string
  name: string
  type: DeviceType
}

export type DatosEntrada = { pin: string } | { user: string; password: string }

export type Entrada = {
  ok: true
  /** Solo si el hub registró este navegador ahora: el token se ve esta única vez. */
  device: EquipoNuevo | null
  /** El tipo del equipo tras entrar: con contraseña pasa a ser de caja. */
  type: DeviceType
  sesionId: string
  secret: string
  user: UsuarioSesion
  permissions: Permission[]
}

const error = (code: CodigoAcceso, message: string, waitMs?: number): ErrorAcceso => ({
  ok: false,
  code,
  message,
  ...(waitMs === undefined ? {} : { waitMs }),
})

const PIN_INCORRECTO = 'PIN incorrecto'
const CREDENCIALES_INCORRECTAS = 'Usuario o contraseña incorrectos'
/** Tope de la espera por usuario: probar contraseñas ajenas no deja afuera a nadie más de esto. */
const ESPERA_MAXIMA_CUENTA_MS = 10_000
const PIN_SIN_PERMISO = 'PIN incorrecto o sin permiso para esto'

const esperar = (ms: number) =>
  error('wait', `Demasiados intentos. Espera ${Math.ceil(ms / 1000)} s.`, ms)

const TIPOS_DISPOSITIVO: readonly DeviceType[] = ['waiter', 'register', 'kds']

/** Mientras el hub no tiene ningún equipo, cualquiera de la red puede intentar emparejar la caja. */
const PRIMER_EMPAREJAMIENTO = 'global:first_pairing'

interface Emparejamiento {
  name: string
  type: DeviceType
  venceEn: number
  aprobadoPor: string
}

/** Un dato que no sirve (nombre, usuario, contraseña): su mensaje se puede mostrar en pantalla. */
export class ErrorDatos extends Error {}

export interface DatosUsuario {
  name: string
  rolId: string
  id?: string
  /** Con usuario y contraseña entra a la caja; sin ellos, con su PIN (ADR-013). */
  user?: string
  password?: string
}

export class ServicioAcceso implements AccessControl {
  private readonly db: SqliteDatabase
  private readonly restaurantId: string
  /** El restaurante de este hub. */
  get restaurant(): string {
    return this.restaurantId
  }
  private readonly key: Buffer
  private readonly clock: () => string
  private readonly attempts: Intentos
  private readonly onRevoke: OpcionesAcceso['onRevoke']
  private readonly claveDesde: number
  private readonly costoContrasena: number
  /**
   * Para comparar algo cuando el usuario no existe o está archivado, con el mismo costo que una
   * contraseña de verdad: así tarda lo mismo y no delata qué usuarios hay.
   */
  private huellaDeRelleno: string | null = null
  /** Códigos de emparejamiento vigentes. En memoria: viven 5 minutos. */
  private readonly emparejamientos = new Map<string, Emparejamiento>()

  constructor(o: OpcionesAcceso) {
    this.db = o.db
    this.restaurantId = o.restaurantId
    this.key = o.key
    this.clock = o.clock ?? (() => new Date().toISOString())
    this.attempts = o.attempts ?? new Intentos(() => Date.parse(this.clock()))
    this.onRevoke = o.onRevoke
    this.claveDesde = o.claveDesde ? Date.parse(o.claveDesde) : 0
    this.costoContrasena = o.costoContrasena ?? COSTO_CONTRASENA
  }

  // ── Dispositivos ─────────────────────────────────────────────────────

  /** Token → dispositivo (el `Autenticador` de la sala). `null` si no existe o se archivó. */
  authenticate = (token: string): Connection | null => {
    const row = this.db
      .prepare(
        `SELECT d.id, d.type, d.revoked_at FROM device_credentials c
         JOIN devices d ON d.id = c.device_id
         WHERE c.restaurant_id = ? AND c.token_hash = ? AND d.active = 1`,
      )
      .get(this.restaurantId, huellaSecreto(token))
    if (!row) return null
    return {
      deviceId: String(row.id),
      type: String(row.type) as DeviceType,
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    }
  }

  /**
   * Un administrador aprueba con su PIN emparejar un dispositivo nuevo: devuelve el código de un
   * solo uso que va en el QR. Se pide desde un equipo ya emparejado (la caja), así que solo un
   * equipo emparejado puede probar PIN. La única excepción es el primero, cuando el hub no tiene
   * ninguno: entonces la espera es una sola para todo el hub, porque una IP se cambia fácil.
   */
  crearEmparejamiento(
    data: { pin: string; name: string; type: string },
    connection: Connection | null,
  ): { ok: true; code: string; venceEn: string } | ErrorAcceso {
    const name = data.name.trim()
    if (name.length === 0 || name.length > 60)
      return error('invalid_data', 'El nombre del equipo debe tener entre 1 y 60 letras')
    if (!TIPOS_DISPOSITIVO.includes(data.type as DeviceType))
      return error('invalid_data', 'Tipo de equipo desconocido')
    if (connection?.revokedAt) return error('revoked_device', 'Este equipo fue retirado')
    if (!connection && this.hayDispositivos())
      return error('unpaired_device', 'Aprueba el emparejamiento desde la caja')

    const admin = this.conPin(
      connection ? `device:${connection.deviceId}` : PRIMER_EMPAREJAMIENTO,
      data.pin,
      (u) => this.tienePermiso(u.id, 'manage_devices'),
      PIN_SIN_PERMISO,
    )
    if (!admin.ok) return admin

    const now = Date.parse(this.clock())
    for (const [code, e] of this.emparejamientos)
      if (e.venceEn <= now) this.emparejamientos.delete(code)
    const code = nuevoCodigoEmparejamiento()
    const venceEn = now + VIGENCIA_CODIGO_MS
    this.emparejamientos.set(code, {
      name,
      type: data.type as DeviceType,
      venceEn,
      aprobadoPor: admin.user.id,
    })
    return { ok: true, code, venceEn: new Date(venceEn).toISOString() }
  }

  /**
   * El dispositivo cambia el código del QR por su token propio. El token solo se ve esta vez.
   * `origen` (la IP) da la espera: con 8 letras de 31 posibles, adivinar un código vigente en
   * 5 minutos es imposible, pero no hay por qué dejar probar sin freno.
   */
  emparejar(
    code: string,
    source: string,
  ): { ok: true; deviceId: string; token: string; name: string; type: DeviceType } | ErrorAcceso {
    const who = `ip:${source}`
    const delay = this.attempts.waitMs(who)
    if (delay > 0) return esperar(delay)
    const normalizado = code.trim().toUpperCase()
    const e = this.emparejamientos.get(normalizado)
    const now = this.clock()
    if (!e || e.venceEn <= Date.parse(now)) {
      if (e) this.emparejamientos.delete(normalizado)
      return error(
        'invalid_code',
        'Código vencido o inválido: pide uno nuevo en la caja',
        this.attempts.fallo(who),
      )
    }
    this.emparejamientos.delete(normalizado)

    const { deviceId, token } = inTransaction(this.db, () =>
      this.registrarDispositivo(e.name, e.type, e.aprobadoPor, now),
    )
    return { ok: true, deviceId, token, name: e.name, type: e.type }
  }

  /**
   * Retira un dispositivo (robado, dañado, de alguien que se fue). Desde ya no recibe nada del
   * salón; lo que tenía pendiente de antes va a cuarentena.
   */
  revocarDispositivo(
    connection: Connection,
    data: { sesionId: string; secret: string; deviceId: string },
  ): { ok: true; revokedAt: string } | ErrorAcceso {
    const session = this.sesionAbierta(connection, data.sesionId, data.secret)
    if (!session.ok) return session
    if (!this.tienePermiso(session.userId, 'manage_devices'))
      return error('no_permission', 'Solo un administrador puede retirar equipos')
    if (data.deviceId === connection.deviceId)
      return error('invalid_data', 'No puedes retirar el equipo desde el que estás')

    const row = this.db
      .prepare('SELECT revoked_at FROM devices WHERE restaurant_id = ? AND id = ?')
      .get(this.restaurantId, data.deviceId)
    if (!row) return error('invalid_data', 'Ese equipo no existe')
    if (row.revoked_at !== null) return { ok: true, revokedAt: String(row.revoked_at) }

    const now = this.clock()
    inTransaction(this.db, () => {
      const max = this.db
        .prepare('SELECT coalesce(max(sequence), 0) AS m FROM events WHERE restaurant_id = ?')
        .get(this.restaurantId)
      actualizarVersionado(
        this.db,
        'devices',
        this.restaurantId,
        data.deviceId,
        { revoked_at: now, revocation_sequence: Number(max?.m ?? 0) },
        { userId: session.userId, deviceId: connection.deviceId },
        now,
      )
      this.cerrarSesiones('device_id = ?', data.deviceId, now)
      // Una pantalla retirada se lleva su usuario técnico: ya no marca nada.
      const screen = this.usuarioDePantalla(data.deviceId)
      if (screen)
        actualizarVersionado(
          this.db,
          'users',
          this.restaurantId,
          screen,
          { active: 0 },
          { userId: session.userId, deviceId: connection.deviceId },
          now,
        )
    })
    this.onRevoke?.(data.deviceId, now)
    return { ok: true, revokedAt: now }
  }

  /**
   * Para acciones que no son eventos (editar el catálogo): la sesión debe ser de este equipo,
   * estar abierta y su usuario tener el permiso. Devuelve quién actúa.
   */
  usuarioConPermiso(
    connection: Connection,
    data: { sesionId: string; secret: string },
    permission: Permission,
  ): { ok: true; userId: string } | ErrorAcceso {
    const session = this.sesionAbierta(connection, data.sesionId, data.secret)
    if (!session.ok) return session
    if (!this.tienePermiso(session.userId, permission))
      return error('no_permission', 'Tu rol no tiene permiso para esto')
    return { ok: true, userId: session.userId }
  }

  // ── Pantalla de cocina (ADR-015) ─────────────────────────────────────

  /**
   * El administrador convierte el equipo desde el que está en pantalla de cocina de esas
   * estaciones. Su sesión se cierra y el equipo queda con la de un usuario técnico propio de la
   * pantalla, que solo marca listo y agotados y nunca entra con PIN ni contraseña. Repetirlo
   * cambia el nombre y las estaciones de la misma pantalla.
   */
  convertirEnPantalla(
    connection: Connection,
    data: { sesionId: string; secret: string; name: string; stationIds: string[] },
  ):
    | { ok: true; sesionId: string; secret: string; user: UsuarioSesion; permissions: Permission[] }
    | ErrorAcceso {
    const session = this.sesionAbierta(connection, data.sesionId, data.secret)
    if (!session.ok) return session
    if (!this.tienePermiso(session.userId, 'manage_devices'))
      return error('no_permission', 'Solo un administrador puede convertir un equipo en pantalla')
    const name = data.name.trim().slice(0, 60)
    if (!name) return error('invalid_data', 'Ponle un nombre a la pantalla')
    const stations = [...new Set(data.stationIds)]
    if (stations.length === 0) return error('invalid_data', 'Elige al menos una estación')
    for (const id of stations) {
      const exists = this.db
        .prepare('SELECT 1 FROM stations WHERE restaurant_id = ? AND id = ? AND active = 1')
        .get(this.restaurantId, id)
      if (!exists) return error('invalid_data', 'Esa estación no existe')
    }

    const now = this.clock()
    const autor = { userId: session.userId, deviceId: connection.deviceId }
    return inTransaction(this.db, () => {
      actualizarVersionado(
        this.db,
        'devices',
        this.restaurantId,
        connection.deviceId,
        { type: 'kds', name, station_ids: JSON.stringify(stations) },
        autor,
        now,
      )
      const rolId = this.rolPantalla(autor, now)
      let userId = this.usuarioDePantalla(connection.deviceId)
      if (userId)
        actualizarVersionado(
          this.db,
          'users',
          this.restaurantId,
          userId,
          { name, active: 1 },
          autor,
          now,
        )
      else
        userId = insertVersioned(
          this.db,
          'users',
          this.restaurantId,
          { name, role_id: rolId, screen: 1 },
          autor,
          now,
        )
      const abierta = this.abrirSesion(connection.deviceId, userId, now)
      return {
        ok: true as const,
        ...abierta,
        user: { id: userId, name, role: 'Pantalla de cocina' },
        permissions: this.permisosDe(userId),
      }
    })
  }

  /** El usuario técnico de una pantalla: el de alguna sesión suya. */
  usuarioDePantalla(deviceId: string): string | null {
    const f = this.db
      .prepare(
        `SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.restaurant_id = ? AND s.device_id = ? AND u.screen = 1
         ORDER BY s.start DESC LIMIT 1`,
      )
      .get(this.restaurantId, deviceId)
    return f ? String(f.id) : null
  }

  /** El rol oculto de las pantallas (se crea la primera vez), con `SCREEN_PERMISSIONS`. */
  private rolPantalla(autor: Autor, now: string): string {
    const f = this.db
      .prepare(
        'SELECT id FROM roles WHERE restaurant_id = ? AND hidden = 1 ORDER BY created_at LIMIT 1',
      )
      .get(this.restaurantId)
    if (f) return String(f.id)
    const rolId = insertVersioned(
      this.db,
      'roles',
      this.restaurantId,
      { name: 'Pantalla de cocina', system: 1, hidden: 1 },
      autor,
      now,
    )
    for (const permission of SCREEN_PERMISSIONS)
      insertVersioned(
        this.db,
        'role_permissions',
        this.restaurantId,
        { role_id: rolId, permission },
        autor,
        now,
      )
    return rolId
  }

  // ── Entrar (ADR-013) ─────────────────────────────────────────────────

  /**
   * Entrar desde cualquier navegador de la red, sin emparejarlo antes. Con PIN entra quien no
   * tiene usuario (los meseros); con usuario y contraseña, el resto, y su PIN solo autoriza.
   * Sin token (`conexion` nula), con el acierto el hub registra el navegador como equipo y le da
   * su token; la espera por intentos va entonces por la IP (`origen`). Con contraseña el equipo
   * pasa a ser de caja: desde él se puede cobrar si el rol lo permite.
   */
  entrar(data: DatosEntrada, connection: Connection | null, source: string): Entrada | ErrorAcceso {
    if (connection?.revokedAt) return error('revoked_device', 'Este equipo fue retirado')
    const who = connection ? `device:${connection.deviceId}` : `ip:${source}`
    const r =
      'pin' in data
        ? this.conPin(who, data.pin, (u) => this.entraConPin(u.id), PIN_INCORRECTO)
        : this.conContrasena(who, data.user, data.password)
    if (!r.ok) return r

    // Solo quien puede cobrar vuelve de caja el equipo: pagos y cierres salen de ahí.
    const permissions = this.permisosDe(r.user.id)
    const cobra = !('pin' in data) && permissions.some((p) => CHECKOUT_PERMISSIONS.has(p))
    const now = this.clock()
    return inTransaction(this.db, () => {
      let device: EquipoNuevo | null = null
      let deviceId: string
      let type: DeviceType
      if (connection) {
        deviceId = connection.deviceId
        type = connection.type
        if (cobra && type === 'waiter') {
          type = 'register'
          actualizarVersionado(
            this.db,
            'devices',
            this.restaurantId,
            deviceId,
            { type },
            { userId: r.user.id, deviceId },
            now,
          )
        }
      } else {
        type = cobra ? 'register' : 'waiter'
        const name = `Equipo de ${r.user.name}`.slice(0, 60)
        const fresh = this.registrarDispositivo(name, type, r.user.id, now)
        deviceId = fresh.deviceId
        device = { ...fresh, name, type }
      }
      const session = this.abrirSesion(deviceId, r.user.id, now)
      return {
        ok: true,
        device,
        type,
        ...session,
        user: r.user,
        permissions,
      }
    })
  }

  /**
   * Si esa persona puede entrar solo con su PIN: no tiene usuario y su rol no tiene ningún permiso
   * que pida contraseña (`PASSWORD_PERMISSIONS`).
   */
  entraConPin(userId: string): boolean {
    return (
      !this.tieneContrasena(userId) &&
      !this.permisosDe(userId).some((p) => PASSWORD_PERMISSIONS.has(p))
    )
  }

  // ── Sesiones ─────────────────────────────────────────────────────────

  /**
   * Abre una sesión con el PIN. Cierra la que hubiera en ese dispositivo: escribir otro PIN
   * cambia de usuario al instante. El secreto solo se entrega esta vez; con él el dispositivo
   * firma los eventos de la sesión, y lo olvida al cerrarla.
   */
  startSession(
    connection: Connection,
    pin: string,
  ):
    | { ok: true; sesionId: string; secret: string; user: UsuarioSesion; permissions: Permission[] }
    | ErrorAcceso {
    if (connection.revokedAt) return error('revoked_device', 'Este equipo fue retirado')
    // Quien tiene usuario entra con su contraseña: su PIN solo autoriza (ADR-013).
    const r = this.conPin(
      `device:${connection.deviceId}`,
      pin,
      (u) => this.entraConPin(u.id),
      PIN_INCORRECTO,
    )
    if (!r.ok) return r
    const session = inTransaction(this.db, () =>
      this.abrirSesion(connection.deviceId, r.user.id, this.clock()),
    )
    return { ok: true, ...session, user: r.user, permissions: this.permisosDe(r.user.id) }
  }

  /** Cierra la sesión que hubiera en el equipo y abre otra (dentro de una transacción). */
  private abrirSesion(deviceId: string, userId: string, now: string) {
    const sesionId = newId()
    const secret = this.secretoDe(sesionId)
    this.cerrarSesiones('device_id = ?', deviceId, now)
    this.db
      .prepare(
        `INSERT INTO sessions (id, restaurant_id, user_id, device_id, secret_hash, start, last_used)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sesionId, this.restaurantId, userId, deviceId, huellaSecreto(secret), now, now)
    return { sesionId, secret }
  }

  cerrarSesion(
    connection: Connection,
    data: { sesionId: string; secret: string },
  ): { ok: true } | ErrorAcceso {
    const session = this.sesionAbierta(connection, data.sesionId, data.secret)
    if (!session.ok) return session
    this.cerrarSesiones('id = ?', data.sesionId, this.clock())
    return { ok: true }
  }

  // ── Autorización de supervisor ───────────────────────────────────────

  /**
   * El supervisor escribe su PIN en el dispositivo del mesero, sin cerrarle la sesión. El hub
   * emite un comprobante de un solo uso para el evento exacto que se autoriza: el dispositivo
   * manda su `huella` (`authorizableFingerprint`) y el comprobante solo vale para ese contenido, desde
   * esa sesión.
   */
  autorizar(
    connection: Connection,
    data: {
      sesionId: string
      secret: string
      pin: string
      action: string
      aggregateId: string
      eventId: string
      fingerprint: string
    },
  ): { ok: true; authorizationId: string; supervisor: { id: string; name: string } } | ErrorAcceso {
    const session = this.sesionAbierta(connection, data.sesionId, data.secret)
    if (!session.ok) return session
    const action = data.action
    if (!isPermission(action)) return error('invalid_data', 'Acción desconocida')
    if (!/^[0-9a-f]{64}$/.test(data.fingerprint))
      return error('invalid_data', 'Falta la huella del evento')

    // Escribir el propio PIN no autoriza, y cuenta como un intento más: si no, alternar el PIN
    // propio con PIN ajenos evitaría la espera.
    const r = this.conPin(
      `device:${connection.deviceId}`,
      data.pin,
      (u) => u.id !== session.userId && this.tienePermiso(u.id, action),
      PIN_SIN_PERMISO,
    )
    if (!r.ok) {
      const own = esPinConFormato(data.pin) && this.usuarioPorPin(data.pin)?.id === session.userId
      return own
        ? error('self_authorization', 'Otra persona con el permiso debe escribir su PIN')
        : r
    }

    const already = this.db
      .prepare('SELECT 1 FROM authorizations WHERE restaurant_id = ? AND event_id = ?')
      .get(this.restaurantId, data.eventId)
    if (already) return error('already_authorized', 'Esa acción ya tiene una autorización')

    const authorizationId = newId()
    this.db
      .prepare(
        `INSERT INTO authorizations (id, restaurant_id, supervisor_id, action, aggregate_id, event_id,
           issued_at, content_hash, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        authorizationId,
        this.restaurantId,
        r.user.id,
        action,
        data.aggregateId,
        data.eventId,
        this.clock(),
        data.fingerprint,
        data.sesionId,
      )
    return { ok: true, authorizationId, supervisor: { id: r.user.id, name: r.user.name } }
  }

  // ── Control de acceso de los eventos (AccessControl) ─────────────────

  verify(connection: Connection, event: NewEvent, order: OrderState | null): AccessVerdict {
    const no = (reason: string): AccessVerdict => ({ ok: false, reason })
    // Algo que el evento hizo antes de un cambio del administrador (archivar al usuario, quitarle
    // un permiso) no se pierde: lo revisa el gerente.
    const review = (reason: string): AccessVerdict => ({ ok: false, reason, quarantine: true })

    if (!event.session_id) return no('no_session')
    const session = this.db
      .prepare('SELECT * FROM sessions WHERE restaurant_id = ? AND id = ?')
      .get(this.restaurantId, event.session_id)
    if (!session) return review('unknown_session')
    if (session.device_id !== connection.deviceId) return no('foreign_session')
    if (session.user_id !== event.user_id) return no('user_mismatch')
    // La firma prueba que lo creó quien tenía la sesión abierta, no otro que usa su `session_id`.
    const signature = signEvent(event, this.secretoDe(event.session_id))
    if (!event.signature || !constantTimeEqual(event.signature, signature))
      return Date.parse(String(session.start)) < this.claveDesde
        ? review('password_changed')
        : no('invalid_signature')

    // La sesión se juzga a la hora del evento: lo hecho sin conexión mientras estaba abierta vale.
    const time = Date.parse(event.hub_estimated_time)
    if (time < Date.parse(String(session.start)) - TOLERANCIA_RELOJ_MS) return no('session_closed')
    if (
      session.closed_at !== null &&
      time > Date.parse(String(session.closed_at)) + TOLERANCIA_RELOJ_MS
    )
      return no('session_closed')
    const change = this.ultimoCambioDe(event.user_id)
    if (!this.usuarioActivo(event.user_id))
      return time < change ? review('user_archived') : no('user_inactive')

    const permission = permissionFor(event, order)
    if (!permission) return no('hub_only')
    // El tipo guardado, no el de la conexión: entrar con contraseña vuelve de caja un celular
    // que ya estaba conectado (ADR-013).
    if (ONLY_FROM_REGISTER.has(event.type) && this.tipoDe(connection) !== 'register')
      return no('register_only')
    if (this.tienePermiso(event.user_id, permission))
      return { ok: true, authorizedById: null, authorizationId: null }

    if (!event.authorization_id)
      return time < change ? review('permissions_changed') : no('no_permission')
    const a = this.db
      .prepare('SELECT * FROM authorizations WHERE restaurant_id = ? AND id = ?')
      .get(this.restaurantId, event.authorization_id)
    if (!a || !this.comprobanteVale(a, event, permission, time)) return no('invalid_authorization')
    return { ok: true, authorizedById: String(a.supervisor_id), authorizationId: String(a.id) }
  }

  recordUse(event: NewEvent, verdict: Extract<AccessVerdict, { ok: true }>) {
    const now = this.clock()
    // Lo recibido también cuenta como uso de la sesión (sin pasar de la hora del hub).
    const time = new Date(
      Math.min(Date.parse(event.hub_estimated_time), Date.parse(now)),
    ).toISOString()
    this.db
      .prepare(
        'UPDATE sessions SET last_used = max(last_used, ?) WHERE restaurant_id = ? AND id = ?',
      )
      .run(time, this.restaurantId, event.session_id)
    if (verdict.authorizationId)
      this.db
        .prepare(
          'UPDATE authorizations SET used_at = ? WHERE restaurant_id = ? AND id = ? AND used_at IS NULL',
        )
        .run(now, this.restaurantId, verdict.authorizationId)
  }

  // ── Usuarios ─────────────────────────────────────────────────────────

  /** Crea un usuario con un PIN nuevo. El PIN se devuelve solo esta vez: no se guarda en claro. */
  crearUsuario(data: DatosUsuario, autor: Autor = SISTEMA): { userId: string; pin: string } {
    return inTransaction(this.db, () => this.insertUser(data, autor))
  }

  /** Como `crearUsuario`, dentro de una transacción que ya abrió quien llama. */
  insertUser(data: DatosUsuario, autor: Autor = SISTEMA): { userId: string; pin: string } {
    const name = data.name.trim()
    if (name.length === 0 || name.length > 60)
      throw new ErrorDatos('El nombre debe tener entre 1 y 60 letras')
    const role = this.db
      .prepare('SELECT 1 FROM roles WHERE restaurant_id = ? AND id = ? AND active = 1')
      .get(this.restaurantId, data.rolId)
    if (!role) throw new ErrorDatos('Ese rol no existe o está archivado')

    const now = this.clock()
    const userId = insertVersioned(
      this.db,
      'users',
      this.restaurantId,
      { name, role_id: data.rolId },
      autor,
      now,
      data.id,
    )
    const pin = this.pinLibre()
    this.db
      .prepare(
        `INSERT INTO user_credentials (user_id, restaurant_id, pin_hash, pin_generated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(userId, this.restaurantId, huellaPin(this.key, this.restaurantId, pin), now)
    if (data.user !== undefined && data.password !== undefined)
      this.fijarContrasena(userId, data.user, data.password)
    return { userId, pin }
  }

  /**
   * Da o cambia el usuario y la contraseña (desde entonces entra con ellos y su PIN solo autoriza).
   * Cierra sus sesiones: quien conocía la contraseña vieja no debe seguir adentro. Lanza un error
   * con un mensaje para la pantalla si el usuario no sirve, está tomado o la contraseña es corta.
   */
  ponerContrasena(userId: string, user: string, password: string) {
    inTransaction(this.db, () => this.fijarContrasena(userId, user, password))
  }

  /** Como `ponerContrasena`, dentro de una transacción que ya abrió quien llama. */
  fijarContrasena(userId: string, user: string, password: string) {
    const name = normalizarUsuario(user)
    if (!name)
      throw new ErrorDatos(
        'El usuario lleva de 3 a 40 letras (sin tildes ni espacios), números, punto o guion',
      )
    if (!esContrasenaValida(password))
      throw new ErrorDatos('La contraseña debe tener al menos 8 caracteres')
    const taken = this.db
      .prepare(
        `SELECT 1 FROM user_credentials WHERE restaurant_id = ? AND username = ?
           AND current = 1 AND user_id <> ?`,
      )
      .get(this.restaurantId, name, userId)
    if (taken) throw new ErrorDatos(`Ya hay alguien con el usuario «${name}»`)
    const now = this.clock()
    const change = this.db
      .prepare(
        `UPDATE user_credentials SET username = ?, password_hash = ?,
           password_changed_at = ? WHERE restaurant_id = ? AND user_id = ?`,
      )
      .run(name, huellaContrasena(password, this.costoContrasena), now, this.restaurantId, userId)
    if (Number(change.changes) === 0) throw new Error('Ese usuario no tiene credencial')
    this.cerrarSesiones('user_id = ?', userId, now)
  }

  /** Le quita usuario y contraseña: desde entonces entra con su PIN. Cierra sus sesiones. */
  quitarContrasena(userId: string) {
    const now = this.clock()
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE user_credentials SET username = NULL, password_hash = NULL,
             password_changed_at = ? WHERE restaurant_id = ? AND user_id = ?`,
        )
        .run(now, this.restaurantId, userId)
      this.cerrarSesiones('user_id = ?', userId, now)
    })
  }

  /** El usuario con que entra esa persona, o `null` si entra con su PIN. */
  usuarioDe(userId: string): string | null {
    const f = this.db
      .prepare('SELECT username FROM user_credentials WHERE restaurant_id = ? AND user_id = ?')
      .get(this.restaurantId, userId)
    return f?.username == null ? null : String(f.username)
  }

  tieneContrasena(userId: string): boolean {
    return this.usuarioDe(userId) !== null
  }

  /**
   * Para quien olvidó su PIN, si se filtró, o tras perder la clave del hub. Cierra sus sesiones:
   * quien conocía el PIN viejo no debe seguir adentro.
   */
  regenerarPin(userId: string): string {
    const now = this.clock()
    return inTransaction(this.db, () => {
      const pin = this.pinLibre()
      const change = this.db
        .prepare(
          `UPDATE user_credentials SET pin_hash = ?, pin_generated_at = ?
           WHERE restaurant_id = ? AND user_id = ?`,
        )
        .run(huellaPin(this.key, this.restaurantId, pin), now, this.restaurantId, userId)
      if (Number(change.changes) === 0) throw new Error('Ese usuario no tiene credencial')
      this.cerrarSesiones('user_id = ?', userId, now)
      return pin
    })
  }

  /** Archiva al usuario: su PIN queda libre y sus sesiones se cierran. */
  archivarUsuario(userId: string, autor: Autor = SISTEMA) {
    const now = this.clock()
    inTransaction(this.db, () => {
      actualizarVersionado(this.db, 'users', this.restaurantId, userId, { active: 0 }, autor, now)
      this.cerrarSesiones('user_id = ?', userId, now)
    })
  }

  permisosDe(userId: string): Permission[] {
    return this.db
      .prepare(
        `SELECT rp.permission FROM users u
         JOIN roles r ON r.id = u.role_id AND r.active = 1
         JOIN role_permissions rp ON rp.role_id = r.id AND rp.active = 1
         WHERE u.restaurant_id = ? AND u.id = ? AND u.active = 1
         ORDER BY rp.permission`,
      )
      .all(this.restaurantId, userId)
      .map((f) => String(f.permission))
      .filter(isPermission)
  }

  // ── Internos ─────────────────────────────────────────────────────────

  /**
   * Busca al dueño del PIN con la espera por intentos de `quien`. Un PIN que no existe y uno sin
   * permiso dan el mismo `mensaje`: así no se sabe que el PIN es de alguien del restaurante.
   * Un acierto no borra los fallos: si no, alternar el PIN propio con PIN ajenos evitaría la
   * espera. Los fallos se olvidan solos tras un rato sin errores.
   */
  private conPin(
    who: string,
    pin: string,
    vale: (user: UsuarioSesion) => boolean,
    message: string,
  ): { ok: true; user: UsuarioSesion } | ErrorAcceso {
    const delay = this.attempts.waitMs(who)
    if (delay > 0) return esperar(delay)
    const user = esPinConFormato(pin) ? this.usuarioPorPin(pin) : undefined
    if (!user || !vale(user)) return error('wrong_pin', message, this.attempts.fallo(who))
    return { ok: true, user }
  }

  /**
   * Busca a quien entra con usuario y contraseña. La espera va por quien intenta y también por el
   * usuario: probar contraseñas de una cuenta desde muchas IP no evita el freno. Un usuario que
   * no existe y una contraseña errada dan la misma respuesta y tardan lo mismo.
   */
  private conContrasena(
    who: string,
    user: string,
    password: string,
  ): { ok: true; user: UsuarioSesion } | ErrorAcceso {
    const name = normalizarUsuario(user)
    // Lo escrito no se guarda en la cuenta de intentos: pudo ser la contraseña en el campo errado.
    const check = `user:${name ?? 'invalid'}`
    const delay = Math.max(this.attempts.waitMs(who), this.attempts.waitMs(check))
    if (delay > 0) return esperar(delay)
    const f = name
      ? this.db
          .prepare(
            `SELECT u.id, u.name, u.active, r.name AS role, c.password_hash
             FROM user_credentials c
             JOIN users u ON u.id = c.user_id
             JOIN roles r ON r.id = u.role_id
             WHERE c.restaurant_id = ? AND c.username = ? AND c.current = 1`,
          )
          .get(this.restaurantId, name)
      : undefined
    // Siempre se compara, con el mismo costo: no delata si el usuario existe ni si está activo.
    const guardada = f ? String(f.password_hash) : this.padding()
    // Una contraseña más larga que lo permitido nunca es la buena (no se corta para compararla).
    const coincide =
      contrasenaCoincide(password.slice(0, LARGO_MAXIMO_CONTRASENA), guardada) &&
      password.length <= LARGO_MAXIMO_CONTRASENA
    if (f?.active !== 1 || !coincide) {
      const ms = Math.max(
        this.attempts.fallo(who),
        this.attempts.fallo(check, { count: false, tope: ESPERA_MAXIMA_CUENTA_MS }),
      )
      return error('invalid_credentials', CREDENCIALES_INCORRECTAS, ms)
    }
    return { ok: true, user: { id: String(f.id), name: String(f.name), role: String(f.role) } }
  }

  private padding(): string {
    this.huellaDeRelleno ??= huellaContrasena('relleno', this.costoContrasena)
    return this.huellaDeRelleno
  }

  private usuarioPorPin(pin: string): UsuarioSesion | undefined {
    const f = this.db
      .prepare(
        `SELECT u.id, u.name, r.name AS role FROM user_credentials c
         JOIN users u ON u.id = c.user_id AND u.active = 1
         JOIN roles r ON r.id = u.role_id
         WHERE c.restaurant_id = ? AND c.pin_hash = ? AND c.current = 1`,
      )
      .get(this.restaurantId, huellaPin(this.key, this.restaurantId, pin))
    return f ? { id: String(f.id), name: String(f.name), role: String(f.role) } : undefined
  }

  /** El secreto de una sesión sale de la clave del hub: así puede comprobar firmas sin guardarlo. */
  private secretoDe(sesionId: string): string {
    return secretoDeSesion(this.key, this.restaurantId, sesionId)
  }

  private sesionAbierta(
    connection: Connection,
    sesionId: string,
    secret: string,
  ): { ok: true; userId: string } | ErrorAcceso {
    if (connection.revokedAt) return error('revoked_device', 'Este equipo fue retirado')
    const s = this.db
      .prepare('SELECT * FROM sessions WHERE restaurant_id = ? AND id = ?')
      .get(this.restaurantId, sesionId)
    const vale =
      s !== undefined &&
      s.device_id === connection.deviceId &&
      s.closed_at === null &&
      mismaHuella(String(s.secret_hash), huellaSecreto(secret)) &&
      this.usuarioActivo(String(s.user_id))
    if (!vale) return error('invalid_session', 'La sesión se cerró: vuelve a entrar')
    return { ok: true, userId: String(s.user_id) }
  }

  private cerrarSesiones(filtro: string, value: SqlValue, now: string) {
    this.db
      .prepare(
        `UPDATE sessions SET closed_at = ? WHERE restaurant_id = ? AND ${filtro} AND closed_at IS NULL`,
      )
      .run(now, this.restaurantId, value)
  }

  private comprobanteVale(a: Row, event: NewEvent, permission: Permission, time: number): boolean {
    const emitida = Date.parse(String(a.issued_at))
    return (
      a.event_id === event.id &&
      a.aggregate_id === event.aggregate_id &&
      a.action === permission &&
      a.session_id === event.session_id &&
      a.content_hash === authorizableFingerprint(event) &&
      a.used_at === null &&
      a.supervisor_id !== event.user_id &&
      // La hora va dentro de la huella: la fijó el dispositivo al pedir el comprobante.
      time >= emitida - TOLERANCIA_RELOJ_MS &&
      time <= emitida + VIGENCIA_AUTORIZACION_MS &&
      Date.parse(this.clock()) <= emitida + ENTREGA_AUTORIZADO_MS &&
      this.tienePermiso(String(a.supervisor_id), permission)
    )
  }

  private tienePermiso(userId: string, permission: Permission): boolean {
    return this.permisosDe(userId).includes(permission)
  }

  private usuarioActivo(userId: string): boolean {
    const f = this.db
      .prepare('SELECT active FROM users WHERE restaurant_id = ? AND id = ?')
      .get(this.restaurantId, userId)
    return f?.active === 1
  }

  /** Último cambio del usuario, su rol o los permisos del rol (ms); 0 si no existe. */
  private ultimoCambioDe(userId: string): number {
    const f = this.db
      .prepare(
        `SELECT max(u.updated_at, r.updated_at,
           coalesce((SELECT max(updated_at) FROM role_permissions WHERE role_id = r.id), '')) AS m
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.restaurant_id = ? AND u.id = ?`,
      )
      .get(this.restaurantId, userId)
    return f?.m ? Date.parse(String(f.m)) : 0
  }

  /** Crea el equipo y su token (dentro de una transacción). El token se ve solo esta vez. */
  private registrarDispositivo(
    name: string,
    type: DeviceType,
    aprobadoPor: string,
    now: string,
  ): { deviceId: string; token: string } {
    const token = nuevoSecreto()
    const deviceId = insertVersioned(
      this.db,
      'devices',
      this.restaurantId,
      {
        location_id: this.sedePrincipal(),
        name,
        type,
        paired_at: now,
        revoked_at: null,
        revocation_sequence: null,
      },
      { userId: aprobadoPor, deviceId: null },
      now,
    )
    this.db
      .prepare(
        `INSERT INTO device_credentials (device_id, restaurant_id, token_hash, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(deviceId, this.restaurantId, huellaSecreto(token), now)
    return { deviceId, token }
  }

  private tipoDe(connection: Connection): DeviceType {
    const f = this.db
      .prepare('SELECT type FROM devices WHERE restaurant_id = ? AND id = ?')
      .get(this.restaurantId, connection.deviceId)
    return f ? (String(f.type) as DeviceType) : connection.type
  }

  private hayDispositivos(): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM devices WHERE restaurant_id = ? AND active = 1 AND revoked_at IS NULL LIMIT 1',
        )
        .get(this.restaurantId) !== undefined
    )
  }

  private sedePrincipal(): string {
    const f = this.db
      .prepare(
        'SELECT id FROM locations WHERE restaurant_id = ? AND active = 1 ORDER BY created_at, id LIMIT 1',
      )
      .get(this.restaurantId)
    if (!f) throw new Error('El restaurante no tiene sede')
    return String(f.id)
  }

  /** Un PIN que no tenga ningún usuario activo. */
  private pinLibre(): string {
    for (let i = 0; i < 500; i++) {
      const pin = generarPin()
      const ocupado = this.db
        .prepare(
          'SELECT 1 FROM user_credentials WHERE restaurant_id = ? AND pin_hash = ? AND current = 1',
        )
        .get(this.restaurantId, huellaPin(this.key, this.restaurantId, pin))
      if (!ocupado) return pin
    }
    throw new ErrorDatos('No quedan PIN libres: archiva usuarios que ya no trabajen')
  }
}
