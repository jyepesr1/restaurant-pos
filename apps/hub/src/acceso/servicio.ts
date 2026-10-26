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
import { type BaseSqlite, enTransaccion, type Fila, type ValorSql } from '@pos/db'
import type { Conexion, ControlAcceso, TipoDispositivo, VeredictoAcceso } from '@pos/sync'
import { Intentos } from './intentos'
import { type Autor, actualizarVersionado, insertarVersionado, SISTEMA } from './registros'
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
  esperaMs?: number
}

export interface UsuarioSesion {
  id: string
  name: string
  role: string
}

export interface OpcionesAcceso {
  db: BaseSqlite
  restauranteId: string
  /** Clave HMAC de los PIN y de los secretos de sesión (`cargarClave`). */
  key: Buffer
  clock?: () => string
  attempts?: Intentos
  /** Se revocó un dispositivo: la sala corta lo que recibe (`SalaSync.revocar`). */
  onRevoke?: (dispositivoId: string, revocadoEn: string) => void
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
  dispositivoId: string
  token: string
  name: string
  type: TipoDispositivo
}

export type DatosEntrada = { pin: string } | { user: string; password: string }

export type Entrada = {
  ok: true
  /** Solo si el hub registró este navegador ahora: el token se ve esta única vez. */
  device: EquipoNuevo | null
  /** El tipo del equipo tras entrar: con contraseña pasa a ser de caja. */
  type: TipoDispositivo
  sesionId: string
  secret: string
  user: UsuarioSesion
  permissions: Permission[]
}

const error = (code: CodigoAcceso, message: string, esperaMs?: number): ErrorAcceso => ({
  ok: false,
  code,
  message,
  ...(esperaMs === undefined ? {} : { esperaMs }),
})

const PIN_INCORRECTO = 'PIN incorrecto'
const CREDENCIALES_INCORRECTAS = 'Usuario o contraseña incorrectos'
/** Tope de la espera por usuario: probar contraseñas ajenas no deja afuera a nadie más de esto. */
const ESPERA_MAXIMA_CUENTA_MS = 10_000
const PIN_SIN_PERMISO = 'PIN incorrecto o sin permiso para esto'

const esperar = (ms: number) =>
  error('wait', `Demasiados intentos. Espera ${Math.ceil(ms / 1000)} s.`, ms)

const TIPOS_DISPOSITIVO: readonly TipoDispositivo[] = ['waiter', 'register', 'kds']

/** Mientras el hub no tiene ningún equipo, cualquiera de la red puede intentar emparejar la caja. */
const PRIMER_EMPAREJAMIENTO = 'global:first_pairing'

interface Emparejamiento {
  name: string
  type: TipoDispositivo
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

export class ServicioAcceso implements ControlAcceso {
  private readonly db: BaseSqlite
  private readonly restauranteId: string
  /** El restaurante de este hub. */
  get restaurant(): string {
    return this.restauranteId
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
    this.restauranteId = o.restauranteId
    this.key = o.key
    this.clock = o.clock ?? (() => new Date().toISOString())
    this.attempts = o.attempts ?? new Intentos(() => Date.parse(this.clock()))
    this.onRevoke = o.onRevoke
    this.claveDesde = o.claveDesde ? Date.parse(o.claveDesde) : 0
    this.costoContrasena = o.costoContrasena ?? COSTO_CONTRASENA
  }

  // ── Dispositivos ─────────────────────────────────────────────────────

  /** Token → dispositivo (el `Autenticador` de la sala). `null` si no existe o se archivó. */
  authenticate = (token: string): Conexion | null => {
    const fila = this.db
      .prepare(
        `SELECT d.id, d.type, d.revoked_at FROM device_credentials c
         JOIN devices d ON d.id = c.device_id
         WHERE c.restaurant_id = ? AND c.token_hash = ? AND d.active = 1`,
      )
      .get(this.restauranteId, huellaSecreto(token))
    if (!fila) return null
    return {
      dispositivoId: String(fila.id),
      type: String(fila.type) as TipoDispositivo,
      revocadoEn: fila.revoked_at === null ? null : String(fila.revoked_at),
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
    connection: Conexion | null,
  ): { ok: true; code: string; venceEn: string } | ErrorAcceso {
    const name = data.name.trim()
    if (name.length === 0 || name.length > 60)
      return error('invalid_data', 'El nombre del equipo debe tener entre 1 y 60 letras')
    if (!TIPOS_DISPOSITIVO.includes(data.type as TipoDispositivo))
      return error('invalid_data', 'Tipo de equipo desconocido')
    if (connection?.revocadoEn) return error('revoked_device', 'Este equipo fue retirado')
    if (!connection && this.hayDispositivos())
      return error('unpaired_device', 'Aprueba el emparejamiento desde la caja')

    const admin = this.conPin(
      connection ? `device:${connection.dispositivoId}` : PRIMER_EMPAREJAMIENTO,
      data.pin,
      (u) => this.tienePermiso(u.id, 'manage_devices'),
      PIN_SIN_PERMISO,
    )
    if (!admin.ok) return admin

    const ahora = Date.parse(this.clock())
    for (const [code, e] of this.emparejamientos)
      if (e.venceEn <= ahora) this.emparejamientos.delete(code)
    const code = nuevoCodigoEmparejamiento()
    const venceEn = ahora + VIGENCIA_CODIGO_MS
    this.emparejamientos.set(code, {
      name,
      type: data.type as TipoDispositivo,
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
  ):
    | { ok: true; dispositivoId: string; token: string; name: string; type: TipoDispositivo }
    | ErrorAcceso {
    const quien = `ip:${source}`
    const delay = this.attempts.esperaMs(quien)
    if (delay > 0) return esperar(delay)
    const normalizado = code.trim().toUpperCase()
    const e = this.emparejamientos.get(normalizado)
    const ahora = this.clock()
    if (!e || e.venceEn <= Date.parse(ahora)) {
      if (e) this.emparejamientos.delete(normalizado)
      return error(
        'invalid_code',
        'Código vencido o inválido: pide uno nuevo en la caja',
        this.attempts.fallo(quien),
      )
    }
    this.emparejamientos.delete(normalizado)

    const { dispositivoId, token } = enTransaccion(this.db, () =>
      this.registrarDispositivo(e.name, e.type, e.aprobadoPor, ahora),
    )
    return { ok: true, dispositivoId, token, name: e.name, type: e.type }
  }

  /**
   * Retira un dispositivo (robado, dañado, de alguien que se fue). Desde ya no recibe nada del
   * salón; lo que tenía pendiente de antes va a cuarentena.
   */
  revocarDispositivo(
    connection: Conexion,
    data: { sesionId: string; secret: string; dispositivoId: string },
  ): { ok: true; revocadoEn: string } | ErrorAcceso {
    const session = this.sesionAbierta(connection, data.sesionId, data.secret)
    if (!session.ok) return session
    if (!this.tienePermiso(session.userId, 'manage_devices'))
      return error('no_permission', 'Solo un administrador puede retirar equipos')
    if (data.dispositivoId === connection.dispositivoId)
      return error('invalid_data', 'No puedes retirar el equipo desde el que estás')

    const fila = this.db
      .prepare('SELECT revoked_at FROM devices WHERE restaurant_id = ? AND id = ?')
      .get(this.restauranteId, data.dispositivoId)
    if (!fila) return error('invalid_data', 'Ese equipo no existe')
    if (fila.revoked_at !== null) return { ok: true, revocadoEn: String(fila.revoked_at) }

    const ahora = this.clock()
    enTransaccion(this.db, () => {
      const max = this.db
        .prepare('SELECT coalesce(max(sequence), 0) AS m FROM events WHERE restaurant_id = ?')
        .get(this.restauranteId)
      actualizarVersionado(
        this.db,
        'devices',
        this.restauranteId,
        data.dispositivoId,
        { revoked_at: ahora, revocation_sequence: Number(max?.m ?? 0) },
        { userId: session.userId, dispositivoId: connection.dispositivoId },
        ahora,
      )
      this.cerrarSesiones('device_id = ?', data.dispositivoId, ahora)
      // Una pantalla retirada se lleva su usuario técnico: ya no marca nada.
      const screen = this.usuarioDePantalla(data.dispositivoId)
      if (screen)
        actualizarVersionado(
          this.db,
          'users',
          this.restauranteId,
          screen,
          { active: 0 },
          { userId: session.userId, dispositivoId: connection.dispositivoId },
          ahora,
        )
    })
    this.onRevoke?.(data.dispositivoId, ahora)
    return { ok: true, revocadoEn: ahora }
  }

  /**
   * Para acciones que no son eventos (editar el catálogo): la sesión debe ser de este equipo,
   * estar abierta y su usuario tener el permiso. Devuelve quién actúa.
   */
  usuarioConPermiso(
    connection: Conexion,
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
    connection: Conexion,
    data: { sesionId: string; secret: string; name: string; estacionIds: string[] },
  ):
    | { ok: true; sesionId: string; secret: string; user: UsuarioSesion; permissions: Permission[] }
    | ErrorAcceso {
    const session = this.sesionAbierta(connection, data.sesionId, data.secret)
    if (!session.ok) return session
    if (!this.tienePermiso(session.userId, 'manage_devices'))
      return error('no_permission', 'Solo un administrador puede convertir un equipo en pantalla')
    const name = data.name.trim().slice(0, 60)
    if (!name) return error('invalid_data', 'Ponle un nombre a la pantalla')
    const stations = [...new Set(data.estacionIds)]
    if (stations.length === 0) return error('invalid_data', 'Elige al menos una estación')
    for (const id of stations) {
      const existe = this.db
        .prepare('SELECT 1 FROM stations WHERE restaurant_id = ? AND id = ? AND active = 1')
        .get(this.restauranteId, id)
      if (!existe) return error('invalid_data', 'Esa estación no existe')
    }

    const ahora = this.clock()
    const autor = { userId: session.userId, dispositivoId: connection.dispositivoId }
    return enTransaccion(this.db, () => {
      actualizarVersionado(
        this.db,
        'devices',
        this.restauranteId,
        connection.dispositivoId,
        { type: 'kds', name, station_ids: JSON.stringify(stations) },
        autor,
        ahora,
      )
      const rolId = this.rolPantalla(autor, ahora)
      let userId = this.usuarioDePantalla(connection.dispositivoId)
      if (userId)
        actualizarVersionado(
          this.db,
          'users',
          this.restauranteId,
          userId,
          { name, active: 1 },
          autor,
          ahora,
        )
      else
        userId = insertarVersionado(
          this.db,
          'users',
          this.restauranteId,
          { name, role_id: rolId, screen: 1 },
          autor,
          ahora,
        )
      const abierta = this.abrirSesion(connection.dispositivoId, userId, ahora)
      return {
        ok: true as const,
        ...abierta,
        user: { id: userId, name, role: 'Pantalla de cocina' },
        permissions: this.permisosDe(userId),
      }
    })
  }

  /** El usuario técnico de una pantalla: el de alguna sesión suya. */
  usuarioDePantalla(dispositivoId: string): string | null {
    const f = this.db
      .prepare(
        `SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.restaurant_id = ? AND s.device_id = ? AND u.screen = 1
         ORDER BY s.start DESC LIMIT 1`,
      )
      .get(this.restauranteId, dispositivoId)
    return f ? String(f.id) : null
  }

  /** El rol oculto de las pantallas (se crea la primera vez), con `SCREEN_PERMISSIONS`. */
  private rolPantalla(autor: Autor, ahora: string): string {
    const f = this.db
      .prepare(
        'SELECT id FROM roles WHERE restaurant_id = ? AND hidden = 1 ORDER BY created_at LIMIT 1',
      )
      .get(this.restauranteId)
    if (f) return String(f.id)
    const rolId = insertarVersionado(
      this.db,
      'roles',
      this.restauranteId,
      { name: 'Pantalla de cocina', system: 1, hidden: 1 },
      autor,
      ahora,
    )
    for (const permission of SCREEN_PERMISSIONS)
      insertarVersionado(
        this.db,
        'role_permissions',
        this.restauranteId,
        { role_id: rolId, permission },
        autor,
        ahora,
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
  entrar(data: DatosEntrada, connection: Conexion | null, source: string): Entrada | ErrorAcceso {
    if (connection?.revocadoEn) return error('revoked_device', 'Este equipo fue retirado')
    const quien = connection ? `device:${connection.dispositivoId}` : `ip:${source}`
    const r =
      'pin' in data
        ? this.conPin(quien, data.pin, (u) => this.entraConPin(u.id), PIN_INCORRECTO)
        : this.conContrasena(quien, data.user, data.password)
    if (!r.ok) return r

    // Solo quien puede cobrar vuelve de caja el equipo: pagos y cierres salen de ahí.
    const permissions = this.permisosDe(r.user.id)
    const cobra = !('pin' in data) && permissions.some((p) => CHECKOUT_PERMISSIONS.has(p))
    const ahora = this.clock()
    return enTransaccion(this.db, () => {
      let device: EquipoNuevo | null = null
      let dispositivoId: string
      let type: TipoDispositivo
      if (connection) {
        dispositivoId = connection.dispositivoId
        type = connection.type
        if (cobra && type === 'waiter') {
          type = 'register'
          actualizarVersionado(
            this.db,
            'devices',
            this.restauranteId,
            dispositivoId,
            { type },
            { userId: r.user.id, dispositivoId },
            ahora,
          )
        }
      } else {
        type = cobra ? 'register' : 'waiter'
        const name = `Equipo de ${r.user.name}`.slice(0, 60)
        const fresh = this.registrarDispositivo(name, type, r.user.id, ahora)
        dispositivoId = fresh.dispositivoId
        device = { ...fresh, name, type }
      }
      const session = this.abrirSesion(dispositivoId, r.user.id, ahora)
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
    connection: Conexion,
    pin: string,
  ):
    | { ok: true; sesionId: string; secret: string; user: UsuarioSesion; permissions: Permission[] }
    | ErrorAcceso {
    if (connection.revocadoEn) return error('revoked_device', 'Este equipo fue retirado')
    // Quien tiene usuario entra con su contraseña: su PIN solo autoriza (ADR-013).
    const r = this.conPin(
      `device:${connection.dispositivoId}`,
      pin,
      (u) => this.entraConPin(u.id),
      PIN_INCORRECTO,
    )
    if (!r.ok) return r
    const session = enTransaccion(this.db, () =>
      this.abrirSesion(connection.dispositivoId, r.user.id, this.clock()),
    )
    return { ok: true, ...session, user: r.user, permissions: this.permisosDe(r.user.id) }
  }

  /** Cierra la sesión que hubiera en el equipo y abre otra (dentro de una transacción). */
  private abrirSesion(dispositivoId: string, userId: string, ahora: string) {
    const sesionId = newId()
    const secret = this.secretoDe(sesionId)
    this.cerrarSesiones('device_id = ?', dispositivoId, ahora)
    this.db
      .prepare(
        `INSERT INTO sessions (id, restaurant_id, user_id, device_id, secret_hash, start, last_used)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sesionId, this.restauranteId, userId, dispositivoId, huellaSecreto(secret), ahora, ahora)
    return { sesionId, secret }
  }

  cerrarSesion(
    connection: Conexion,
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
    connection: Conexion,
    data: {
      sesionId: string
      secret: string
      pin: string
      action: string
      agregadoId: string
      eventId: string
      fingerprint: string
    },
  ): { ok: true; autorizacionId: string; supervisor: { id: string; name: string } } | ErrorAcceso {
    const session = this.sesionAbierta(connection, data.sesionId, data.secret)
    if (!session.ok) return session
    const action = data.action
    if (!isPermission(action)) return error('invalid_data', 'Acción desconocida')
    if (!/^[0-9a-f]{64}$/.test(data.fingerprint))
      return error('invalid_data', 'Falta la huella del evento')

    // Escribir el propio PIN no autoriza, y cuenta como un intento más: si no, alternar el PIN
    // propio con PIN ajenos evitaría la espera.
    const r = this.conPin(
      `device:${connection.dispositivoId}`,
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
      .get(this.restauranteId, data.eventId)
    if (already) return error('already_authorized', 'Esa acción ya tiene una autorización')

    const autorizacionId = newId()
    this.db
      .prepare(
        `INSERT INTO authorizations (id, restaurant_id, supervisor_id, action, aggregate_id, event_id,
           issued_at, content_hash, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        autorizacionId,
        this.restauranteId,
        r.user.id,
        action,
        data.agregadoId,
        data.eventId,
        this.clock(),
        data.fingerprint,
        data.sesionId,
      )
    return { ok: true, autorizacionId, supervisor: { id: r.user.id, name: r.user.name } }
  }

  // ── Control de acceso de los eventos (ControlAcceso) ─────────────────

  verify(connection: Conexion, event: NewEvent, order: OrderState | null): VeredictoAcceso {
    const no = (reason: string): VeredictoAcceso => ({ ok: false, reason })
    // Algo que el evento hizo antes de un cambio del administrador (archivar al usuario, quitarle
    // un permiso) no se pierde: lo revisa el gerente.
    const revisar = (reason: string): VeredictoAcceso => ({ ok: false, reason, quarantine: true })

    if (!event.session_id) return no('no_session')
    const session = this.db
      .prepare('SELECT * FROM sessions WHERE restaurant_id = ? AND id = ?')
      .get(this.restauranteId, event.session_id)
    if (!session) return revisar('unknown_session')
    if (session.device_id !== connection.dispositivoId) return no('foreign_session')
    if (session.user_id !== event.user_id) return no('user_mismatch')
    // La firma prueba que lo creó quien tenía la sesión abierta, no otro que usa su `session_id`.
    const signature = signEvent(event, this.secretoDe(event.session_id))
    if (!event.signature || !constantTimeEqual(event.signature, signature))
      return Date.parse(String(session.start)) < this.claveDesde
        ? revisar('password_changed')
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
      return time < change ? revisar('user_archived') : no('user_inactive')

    const permission = permissionFor(event, order)
    if (!permission) return no('hub_only')
    // El tipo guardado, no el de la conexión: entrar con contraseña vuelve de caja un celular
    // que ya estaba conectado (ADR-013).
    if (ONLY_FROM_REGISTER.has(event.type) && this.tipoDe(connection) !== 'register')
      return no('register_only')
    if (this.tienePermiso(event.user_id, permission))
      return { ok: true, authorizedById: null, autorizacionId: null }

    if (!event.authorization_id)
      return time < change ? revisar('permissions_changed') : no('no_permission')
    const a = this.db
      .prepare('SELECT * FROM authorizations WHERE restaurant_id = ? AND id = ?')
      .get(this.restauranteId, event.authorization_id)
    if (!a || !this.comprobanteVale(a, event, permission, time)) return no('invalid_authorization')
    return { ok: true, authorizedById: String(a.supervisor_id), autorizacionId: String(a.id) }
  }

  registrarUso(event: NewEvent, veredicto: Extract<VeredictoAcceso, { ok: true }>) {
    const ahora = this.clock()
    // Lo recibido también cuenta como uso de la sesión (sin pasar de la hora del hub).
    const time = new Date(
      Math.min(Date.parse(event.hub_estimated_time), Date.parse(ahora)),
    ).toISOString()
    this.db
      .prepare(
        'UPDATE sessions SET last_used = max(last_used, ?) WHERE restaurant_id = ? AND id = ?',
      )
      .run(time, this.restauranteId, event.session_id)
    if (veredicto.autorizacionId)
      this.db
        .prepare(
          'UPDATE authorizations SET used_at = ? WHERE restaurant_id = ? AND id = ? AND used_at IS NULL',
        )
        .run(ahora, this.restauranteId, veredicto.autorizacionId)
  }

  // ── Usuarios ─────────────────────────────────────────────────────────

  /** Crea un usuario con un PIN nuevo. El PIN se devuelve solo esta vez: no se guarda en claro. */
  crearUsuario(data: DatosUsuario, autor: Autor = SISTEMA): { userId: string; pin: string } {
    return enTransaccion(this.db, () => this.insertUser(data, autor))
  }

  /** Como `crearUsuario`, dentro de una transacción que ya abrió quien llama. */
  insertUser(data: DatosUsuario, autor: Autor = SISTEMA): { userId: string; pin: string } {
    const name = data.name.trim()
    if (name.length === 0 || name.length > 60)
      throw new ErrorDatos('El nombre debe tener entre 1 y 60 letras')
    const role = this.db
      .prepare('SELECT 1 FROM roles WHERE restaurant_id = ? AND id = ? AND active = 1')
      .get(this.restauranteId, data.rolId)
    if (!role) throw new ErrorDatos('Ese rol no existe o está archivado')

    const ahora = this.clock()
    const userId = insertarVersionado(
      this.db,
      'users',
      this.restauranteId,
      { name, role_id: data.rolId },
      autor,
      ahora,
      data.id,
    )
    const pin = this.pinLibre()
    this.db
      .prepare(
        `INSERT INTO user_credentials (user_id, restaurant_id, pin_hash, pin_generated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(userId, this.restauranteId, huellaPin(this.key, this.restauranteId, pin), ahora)
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
    enTransaccion(this.db, () => this.fijarContrasena(userId, user, password))
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
      .get(this.restauranteId, name, userId)
    if (taken) throw new ErrorDatos(`Ya hay alguien con el usuario «${name}»`)
    const ahora = this.clock()
    const change = this.db
      .prepare(
        `UPDATE user_credentials SET username = ?, password_hash = ?,
           password_changed_at = ? WHERE restaurant_id = ? AND user_id = ?`,
      )
      .run(
        name,
        huellaContrasena(password, this.costoContrasena),
        ahora,
        this.restauranteId,
        userId,
      )
    if (Number(change.changes) === 0) throw new Error('Ese usuario no tiene credencial')
    this.cerrarSesiones('user_id = ?', userId, ahora)
  }

  /** Le quita usuario y contraseña: desde entonces entra con su PIN. Cierra sus sesiones. */
  quitarContrasena(userId: string) {
    const ahora = this.clock()
    enTransaccion(this.db, () => {
      this.db
        .prepare(
          `UPDATE user_credentials SET username = NULL, password_hash = NULL,
             password_changed_at = ? WHERE restaurant_id = ? AND user_id = ?`,
        )
        .run(ahora, this.restauranteId, userId)
      this.cerrarSesiones('user_id = ?', userId, ahora)
    })
  }

  /** El usuario con que entra esa persona, o `null` si entra con su PIN. */
  usuarioDe(userId: string): string | null {
    const f = this.db
      .prepare('SELECT username FROM user_credentials WHERE restaurant_id = ? AND user_id = ?')
      .get(this.restauranteId, userId)
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
    const ahora = this.clock()
    return enTransaccion(this.db, () => {
      const pin = this.pinLibre()
      const change = this.db
        .prepare(
          `UPDATE user_credentials SET pin_hash = ?, pin_generated_at = ?
           WHERE restaurant_id = ? AND user_id = ?`,
        )
        .run(huellaPin(this.key, this.restauranteId, pin), ahora, this.restauranteId, userId)
      if (Number(change.changes) === 0) throw new Error('Ese usuario no tiene credencial')
      this.cerrarSesiones('user_id = ?', userId, ahora)
      return pin
    })
  }

  /** Archiva al usuario: su PIN queda libre y sus sesiones se cierran. */
  archivarUsuario(userId: string, autor: Autor = SISTEMA) {
    const ahora = this.clock()
    enTransaccion(this.db, () => {
      actualizarVersionado(
        this.db,
        'users',
        this.restauranteId,
        userId,
        { active: 0 },
        autor,
        ahora,
      )
      this.cerrarSesiones('user_id = ?', userId, ahora)
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
      .all(this.restauranteId, userId)
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
    quien: string,
    pin: string,
    vale: (user: UsuarioSesion) => boolean,
    message: string,
  ): { ok: true; user: UsuarioSesion } | ErrorAcceso {
    const delay = this.attempts.esperaMs(quien)
    if (delay > 0) return esperar(delay)
    const user = esPinConFormato(pin) ? this.usuarioPorPin(pin) : undefined
    if (!user || !vale(user)) return error('wrong_pin', message, this.attempts.fallo(quien))
    return { ok: true, user }
  }

  /**
   * Busca a quien entra con usuario y contraseña. La espera va por quien intenta y también por el
   * usuario: probar contraseñas de una cuenta desde muchas IP no evita el freno. Un usuario que
   * no existe y una contraseña errada dan la misma respuesta y tardan lo mismo.
   */
  private conContrasena(
    quien: string,
    user: string,
    password: string,
  ): { ok: true; user: UsuarioSesion } | ErrorAcceso {
    const name = normalizarUsuario(user)
    // Lo escrito no se guarda en la cuenta de intentos: pudo ser la contraseña en el campo errado.
    const check = `user:${name ?? 'invalid'}`
    const delay = Math.max(this.attempts.esperaMs(quien), this.attempts.esperaMs(check))
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
          .get(this.restauranteId, name)
      : undefined
    // Siempre se compara, con el mismo costo: no delata si el usuario existe ni si está activo.
    const guardada = f ? String(f.password_hash) : this.relleno()
    // Una contraseña más larga que lo permitido nunca es la buena (no se corta para compararla).
    const coincide =
      contrasenaCoincide(password.slice(0, LARGO_MAXIMO_CONTRASENA), guardada) &&
      password.length <= LARGO_MAXIMO_CONTRASENA
    if (f?.active !== 1 || !coincide) {
      const ms = Math.max(
        this.attempts.fallo(quien),
        this.attempts.fallo(check, { contar: false, tope: ESPERA_MAXIMA_CUENTA_MS }),
      )
      return error('invalid_credentials', CREDENCIALES_INCORRECTAS, ms)
    }
    return { ok: true, user: { id: String(f.id), name: String(f.name), role: String(f.role) } }
  }

  private relleno(): string {
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
      .get(this.restauranteId, huellaPin(this.key, this.restauranteId, pin))
    return f ? { id: String(f.id), name: String(f.name), role: String(f.role) } : undefined
  }

  /** El secreto de una sesión sale de la clave del hub: así puede comprobar firmas sin guardarlo. */
  private secretoDe(sesionId: string): string {
    return secretoDeSesion(this.key, this.restauranteId, sesionId)
  }

  private sesionAbierta(
    connection: Conexion,
    sesionId: string,
    secret: string,
  ): { ok: true; userId: string } | ErrorAcceso {
    if (connection.revocadoEn) return error('revoked_device', 'Este equipo fue retirado')
    const s = this.db
      .prepare('SELECT * FROM sessions WHERE restaurant_id = ? AND id = ?')
      .get(this.restauranteId, sesionId)
    const vale =
      s !== undefined &&
      s.device_id === connection.dispositivoId &&
      s.closed_at === null &&
      mismaHuella(String(s.secret_hash), huellaSecreto(secret)) &&
      this.usuarioActivo(String(s.user_id))
    if (!vale) return error('invalid_session', 'La sesión se cerró: vuelve a entrar')
    return { ok: true, userId: String(s.user_id) }
  }

  private cerrarSesiones(filtro: string, value: ValorSql, ahora: string) {
    this.db
      .prepare(
        `UPDATE sessions SET closed_at = ? WHERE restaurant_id = ? AND ${filtro} AND closed_at IS NULL`,
      )
      .run(ahora, this.restauranteId, value)
  }

  private comprobanteVale(a: Fila, event: NewEvent, permission: Permission, time: number): boolean {
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
      .get(this.restauranteId, userId)
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
      .get(this.restauranteId, userId)
    return f?.m ? Date.parse(String(f.m)) : 0
  }

  /** Crea el equipo y su token (dentro de una transacción). El token se ve solo esta vez. */
  private registrarDispositivo(
    name: string,
    type: TipoDispositivo,
    aprobadoPor: string,
    ahora: string,
  ): { dispositivoId: string; token: string } {
    const token = nuevoSecreto()
    const dispositivoId = insertarVersionado(
      this.db,
      'devices',
      this.restauranteId,
      {
        location_id: this.sedePrincipal(),
        name,
        type,
        paired_at: ahora,
        revoked_at: null,
        revocation_sequence: null,
      },
      { userId: aprobadoPor, dispositivoId: null },
      ahora,
    )
    this.db
      .prepare(
        `INSERT INTO device_credentials (device_id, restaurant_id, token_hash, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(dispositivoId, this.restauranteId, huellaSecreto(token), ahora)
    return { dispositivoId, token }
  }

  private tipoDe(connection: Conexion): TipoDispositivo {
    const f = this.db
      .prepare('SELECT type FROM devices WHERE restaurant_id = ? AND id = ?')
      .get(this.restauranteId, connection.dispositivoId)
    return f ? (String(f.type) as TipoDispositivo) : connection.type
  }

  private hayDispositivos(): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM devices WHERE restaurant_id = ? AND active = 1 AND revoked_at IS NULL LIMIT 1',
        )
        .get(this.restauranteId) !== undefined
    )
  }

  private sedePrincipal(): string {
    const f = this.db
      .prepare(
        'SELECT id FROM locations WHERE restaurant_id = ? AND active = 1 ORDER BY created_at, id LIMIT 1',
      )
      .get(this.restauranteId)
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
        .get(this.restauranteId, huellaPin(this.key, this.restauranteId, pin))
      if (!ocupado) return pin
    }
    throw new ErrorDatos('No quedan PIN libres: archiva usuarios que ya no trabajen')
  }
}
