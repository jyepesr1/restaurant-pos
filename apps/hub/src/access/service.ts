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
import { Attempts } from './attempts'
import { type Author, insertVersioned, SYSTEM, updateVersioned } from './records'
import {
  generatePin,
  isValidPassword,
  isWellFormedPin,
  newPairingCode,
  newSecret,
  normalizeUsername,
  PASSWORD_COST,
  PASSWORD_MAX_LENGTH,
  passwordHash,
  passwordMatches,
  pinHash,
  sameHash,
  secretHash,
  sessionSecretFor,
} from './secrets'

// Sign-in (with PIN or with username and password), sessions, supervisor approvals, revocation and
// the code pairing that remains for the kitchen screen (ADR-008 and ADR-013,
// docs/SYNC.md#seguridad). All of this lives only in the hub.

/** The QR pairing code expires after 5 minutes and works once. */
export const CODE_TTL_MS = 5 * 60_000
/** The authorized event must be created within 2 minutes of the approval. */
export const AUTHORIZATION_TTL_MS = 2 * 60_000
/** And reach the hub within this time at the latest (it may have sat in the offline queue). */
export const AUTHORIZED_DELIVERY_MS = 12 * 60 * 60_000
/** Margin for the device clock, already corrected with the offset it learned. */
const CLOCK_TOLERANCE_MS = 60_000

export type AccessCode =
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

export interface AccessError {
  ok: false
  code: AccessCode
  message: string
  /** With `wait` and `wrong_pin`: how long to wait before trying again. */
  waitMs?: number
}

export interface SessionUser {
  id: string
  name: string
  role: string
}

export interface AccessOptions {
  db: SqliteDatabase
  restaurantId: string
  /** HMAC key for PINs and session secrets (`loadKey`). */
  key: Buffer
  clock?: () => string
  attempts?: Attempts
  /** A device was revoked: the floor cuts off what it receives (`FloorSync.revoke`). */
  onRevoke?: (deviceId: string, revokedAt: string) => void
  /**
   * Since when the key exists (`loadKey`). If it was lost and another was created, what is pending
   * from earlier sessions cannot be verified: it goes to quarantine instead of being lost.
   */
  keyFrom?: string
  /** Cost of the password hash (`PASSWORD_COST`); tests use less. */
  passwordCost?: number
}

/** The device the hub registered on sign-in from a browser without a token. */
export interface NewDevice {
  deviceId: string
  token: string
  name: string
  type: DeviceType
}

export type InputData = { pin: string } | { user: string; password: string }

export type SignInResult = {
  ok: true
  /** Only if the hub registered this browser now: the token is shown this one time. */
  device: NewDevice | null
  /** The device type after sign-in: with a password it becomes a register device. */
  type: DeviceType
  sessionId: string
  secret: string
  user: SessionUser
  permissions: Permission[]
}

const error = (code: AccessCode, message: string, waitMs?: number): AccessError => ({
  ok: false,
  code,
  message,
  ...(waitMs === undefined ? {} : { waitMs }),
})

const WRONG_PIN = 'PIN incorrecto'
const INVALID_CREDENTIALS = 'Usuario o contraseña incorrectos'
/** Cap on the per-username wait: guessing someone's password locks nobody out longer than this. */
const MAX_USERNAME_WAIT_MS = 10_000
const PIN_WITHOUT_PERMISSION = 'PIN incorrecto o sin permiso para esto'

const wait = (ms: number) =>
  error('wait', `Demasiados intentos. Espera ${Math.ceil(ms / 1000)} s.`, ms)

const DEVICE_TYPES: readonly DeviceType[] = ['waiter', 'register', 'kds']

/** While the hub has no devices, anyone on the network can try to pair the register. */
const FIRST_PAIRING = 'global:first_pairing'

interface Pairing {
  name: string
  type: DeviceType
  expiresAt: number
  approvedBy: string
}

/** An invalid value (name, username, password): its message can be shown on screen. */
export class DataError extends Error {}

export interface UserData {
  name: string
  roleId: string
  id?: string
  /** With username and password they sign in to the register; otherwise, by PIN (ADR-013). */
  user?: string
  password?: string
}

export class AccessService implements AccessControl {
  private readonly db: SqliteDatabase
  private readonly restaurantId: string
  /** This hub's restaurant. */
  get restaurant(): string {
    return this.restaurantId
  }
  private readonly key: Buffer
  private readonly clock: () => string
  private readonly attempts: Attempts
  private readonly onRevoke: AccessOptions['onRevoke']
  private readonly keyFrom: number
  private readonly passwordCost: number
  /**
   * Something to compare against when the user does not exist or is archived, with the same cost as
   * a real password: so it takes the same time and does not reveal which users exist.
   */
  private dummyHash: string | null = null
  /** Current pairing codes. In memory: they live 5 minutes. */
  private readonly pairings = new Map<string, Pairing>()

  constructor(o: AccessOptions) {
    this.db = o.db
    this.restaurantId = o.restaurantId
    this.key = o.key
    this.clock = o.clock ?? (() => new Date().toISOString())
    this.attempts = o.attempts ?? new Attempts(() => Date.parse(this.clock()))
    this.onRevoke = o.onRevoke
    this.keyFrom = o.keyFrom ? Date.parse(o.keyFrom) : 0
    this.passwordCost = o.passwordCost ?? PASSWORD_COST
  }

  // ── Devices ──────────────────────────────────────────────────────────

  /** Token → device (the floor's `Authenticator`). `null` if it does not exist or was archived. */
  authenticate = (token: string): Connection | null => {
    const row = this.db
      .prepare(
        `SELECT d.id, d.type, d.revoked_at FROM device_credentials c
         JOIN devices d ON d.id = c.device_id
         WHERE c.restaurant_id = ? AND c.token_hash = ? AND d.active = 1`,
      )
      .get(this.restaurantId, secretHash(token))
    if (!row) return null
    return {
      deviceId: String(row.id),
      type: String(row.type) as DeviceType,
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    }
  }

  /**
   * An admin approves pairing a new device with their PIN: returns the single-use code that goes
   * in the QR. It is requested from an already paired device (the register), so only a paired
   * device can try PINs. The only exception is the first one, when the hub has none: then there is
   * a single wait for the whole hub, because an IP is easy to change.
   */
  createPairing(
    data: { pin: string; name: string; type: string },
    connection: Connection | null,
  ): { ok: true; code: string; expiresAt: string } | AccessError {
    const name = data.name.trim()
    if (name.length === 0 || name.length > 60)
      return error('invalid_data', 'El nombre del equipo debe tener entre 1 y 60 letras')
    if (!DEVICE_TYPES.includes(data.type as DeviceType))
      return error('invalid_data', 'Tipo de equipo desconocido')
    if (connection?.revokedAt) return error('revoked_device', 'Este equipo fue retirado')
    if (!connection && this.hasDevices())
      return error('unpaired_device', 'Aprueba el emparejamiento desde la caja')

    const admin = this.withPin(
      connection ? `device:${connection.deviceId}` : FIRST_PAIRING,
      data.pin,
      (u) => this.hasPermission(u.id, 'manage_devices'),
      PIN_WITHOUT_PERMISSION,
    )
    if (!admin.ok) return admin

    const now = Date.parse(this.clock())
    for (const [code, e] of this.pairings) if (e.expiresAt <= now) this.pairings.delete(code)
    const code = newPairingCode()
    const expiresAt = now + CODE_TTL_MS
    this.pairings.set(code, {
      name,
      type: data.type as DeviceType,
      expiresAt,
      approvedBy: admin.user.id,
    })
    return { ok: true, code, expiresAt: new Date(expiresAt).toISOString() }
  }

  /**
   * The device exchanges the QR code for its own token. The token is shown only this time.
   * `source` (the IP) sets the wait: with 8 letters out of 31 possible, guessing a current code in
   * 5 minutes is impossible, but there is no reason to allow unlimited tries.
   */
  pair(
    code: string,
    source: string,
  ): { ok: true; deviceId: string; token: string; name: string; type: DeviceType } | AccessError {
    const who = `ip:${source}`
    const delay = this.attempts.waitMs(who)
    if (delay > 0) return wait(delay)
    const normalized = code.trim().toUpperCase()
    const e = this.pairings.get(normalized)
    const now = this.clock()
    if (!e || e.expiresAt <= Date.parse(now)) {
      if (e) this.pairings.delete(normalized)
      return error(
        'invalid_code',
        'Código vencido o inválido: pide uno nuevo en la caja',
        this.attempts.failure(who),
      )
    }
    this.pairings.delete(normalized)

    const { deviceId, token } = inTransaction(this.db, () =>
      this.registerDevice(e.name, e.type, e.approvedBy, now),
    )
    return { ok: true, deviceId, token, name: e.name, type: e.type }
  }

  /**
   * Removes a device (stolen, damaged, from someone who left). From now on it receives nothing from
   * the floor; whatever it had pending from before goes to quarantine.
   */
  revokeDevice(
    connection: Connection,
    data: { sessionId: string; secret: string; deviceId: string },
  ): { ok: true; revokedAt: string } | AccessError {
    const session = this.activeSession(connection, data.sessionId, data.secret)
    if (!session.ok) return session
    if (!this.hasPermission(session.userId, 'manage_devices'))
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
      updateVersioned(
        this.db,
        'devices',
        this.restaurantId,
        data.deviceId,
        { revoked_at: now, revocation_sequence: Number(max?.m ?? 0) },
        { userId: session.userId, deviceId: connection.deviceId },
        now,
      )
      this.closeSessions('device_id = ?', data.deviceId, now)
      // A removed screen takes its technical user with it: it no longer marks anything.
      const screen = this.screenUser(data.deviceId)
      if (screen)
        updateVersioned(
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
   * For actions that are not events (editing the catalog): the session must belong to this device,
   * be open and its user must have the permission. Returns who is acting.
   */
  userWithPermission(
    connection: Connection,
    data: { sessionId: string; secret: string },
    permission: Permission,
  ): { ok: true; userId: string } | AccessError {
    const session = this.activeSession(connection, data.sessionId, data.secret)
    if (!session.ok) return session
    if (!this.hasPermission(session.userId, permission))
      return error('no_permission', 'Tu rol no tiene permiso para esto')
    return { ok: true, userId: session.userId }
  }

  // ── Kitchen screen (ADR-015) ─────────────────────────────────────────

  /**
   * The admin turns the device they are on into a kitchen screen for those stations. Their
   * session is closed and the device keeps one for a technical user of its own for the screen,
   * which only marks ready and sold out and never signs in with PIN or password. Repeating it
   * changes the name and stations of the same screen.
   */
  convertToScreen(
    connection: Connection,
    data: { sessionId: string; secret: string; name: string; stationIds: string[] },
  ):
    | { ok: true; sessionId: string; secret: string; user: SessionUser; permissions: Permission[] }
    | AccessError {
    const session = this.activeSession(connection, data.sessionId, data.secret)
    if (!session.ok) return session
    if (!this.hasPermission(session.userId, 'manage_devices'))
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
    const author = { userId: session.userId, deviceId: connection.deviceId }
    return inTransaction(this.db, () => {
      updateVersioned(
        this.db,
        'devices',
        this.restaurantId,
        connection.deviceId,
        { type: 'kds', name, station_ids: JSON.stringify(stations) },
        author,
        now,
      )
      const roleId = this.screenRole(author, now)
      let userId = this.screenUser(connection.deviceId)
      if (userId)
        updateVersioned(
          this.db,
          'users',
          this.restaurantId,
          userId,
          { name, active: 1 },
          author,
          now,
        )
      else
        userId = insertVersioned(
          this.db,
          'users',
          this.restaurantId,
          { name, role_id: roleId, screen: 1 },
          author,
          now,
        )
      const opened = this.openSession(connection.deviceId, userId, now)
      return {
        ok: true as const,
        ...opened,
        user: { id: userId, name, role: 'Pantalla de cocina' },
        permissions: this.permissionsOf(userId),
      }
    })
  }

  /** A screen's technical user: the one from any of its sessions. */
  screenUser(deviceId: string): string | null {
    const f = this.db
      .prepare(
        `SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.restaurant_id = ? AND s.device_id = ? AND u.screen = 1
         ORDER BY s.start DESC LIMIT 1`,
      )
      .get(this.restaurantId, deviceId)
    return f ? String(f.id) : null
  }

  /** The hidden role for screens (created the first time), with `SCREEN_PERMISSIONS`. */
  private screenRole(author: Author, now: string): string {
    const f = this.db
      .prepare(
        'SELECT id FROM roles WHERE restaurant_id = ? AND hidden = 1 ORDER BY created_at LIMIT 1',
      )
      .get(this.restaurantId)
    if (f) return String(f.id)
    const roleId = insertVersioned(
      this.db,
      'roles',
      this.restaurantId,
      { name: 'Pantalla de cocina', system: 1, hidden: 1 },
      author,
      now,
    )
    for (const permission of SCREEN_PERMISSIONS)
      insertVersioned(
        this.db,
        'role_permissions',
        this.restaurantId,
        { role_id: roleId, permission },
        author,
        now,
      )
    return roleId
  }

  // ── Sign in (ADR-013) ────────────────────────────────────────────────

  /**
   * Sign in from any browser on the network, without pairing it first. Those without a username
   * (waiters) sign in with PIN; everyone else with username and password, and their PIN only
   * authorizes. Without a token (`connection` null), on success the hub registers the browser as a
   * device and gives it its token; the attempt wait then goes by IP (`source`). With a password
   * the device becomes a register device: it can charge from there if the role allows it.
   */
  signIn(
    data: InputData,
    connection: Connection | null,
    source: string,
  ): SignInResult | AccessError {
    if (connection?.revokedAt) return error('revoked_device', 'Este equipo fue retirado')
    const who = connection ? `device:${connection.deviceId}` : `ip:${source}`
    const r =
      'pin' in data
        ? this.withPin(who, data.pin, (u) => this.signsInWithPin(u.id), WRONG_PIN)
        : this.withPassword(who, data.user, data.password)
    if (!r.ok) return r

    // Only someone who can charge makes the device a register: payments and closes come from there.
    const permissions = this.permissionsOf(r.user.id)
    const charges = !('pin' in data) && permissions.some((p) => CHECKOUT_PERMISSIONS.has(p))
    const now = this.clock()
    return inTransaction(this.db, () => {
      let device: NewDevice | null = null
      let deviceId: string
      let type: DeviceType
      if (connection) {
        deviceId = connection.deviceId
        type = connection.type
        if (charges && type === 'waiter') {
          type = 'register'
          updateVersioned(
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
        type = charges ? 'register' : 'waiter'
        const name = `Equipo de ${r.user.name}`.slice(0, 60)
        const fresh = this.registerDevice(name, type, r.user.id, now)
        deviceId = fresh.deviceId
        device = { ...fresh, name, type }
      }
      const session = this.openSession(deviceId, r.user.id, now)
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
   * Whether that person can sign in with just their PIN: they have no username and their role has
   * no permission that requires a password (`PASSWORD_PERMISSIONS`).
   */
  signsInWithPin(userId: string): boolean {
    return (
      !this.hasPassword(userId) &&
      !this.permissionsOf(userId).some((p) => PASSWORD_PERMISSIONS.has(p))
    )
  }

  // ── Sessions ─────────────────────────────────────────────────────────

  /**
   * Opens a session with the PIN. Closes any session on that device: typing another PIN switches
   * user instantly. The secret is handed over only this time; the device signs the session's
   * events with it, and forgets it when closing the session.
   */
  startSession(
    connection: Connection,
    pin: string,
  ):
    | { ok: true; sessionId: string; secret: string; user: SessionUser; permissions: Permission[] }
    | AccessError {
    if (connection.revokedAt) return error('revoked_device', 'Este equipo fue retirado')
    // Someone with a username signs in with their password: their PIN only authorizes (ADR-013).
    const r = this.withPin(
      `device:${connection.deviceId}`,
      pin,
      (u) => this.signsInWithPin(u.id),
      WRONG_PIN,
    )
    if (!r.ok) return r
    const session = inTransaction(this.db, () =>
      this.openSession(connection.deviceId, r.user.id, this.clock()),
    )
    return { ok: true, ...session, user: r.user, permissions: this.permissionsOf(r.user.id) }
  }

  /** Closes any session on the device and opens another (inside a transaction). */
  private openSession(deviceId: string, userId: string, now: string) {
    const sessionId = newId()
    const secret = this.secretOf(sessionId)
    this.closeSessions('device_id = ?', deviceId, now)
    this.db
      .prepare(
        `INSERT INTO sessions (id, restaurant_id, user_id, device_id, secret_hash, start, last_used)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, this.restaurantId, userId, deviceId, secretHash(secret), now, now)
    return { sessionId, secret }
  }

  closeSession(
    connection: Connection,
    data: { sessionId: string; secret: string },
  ): { ok: true } | AccessError {
    const session = this.activeSession(connection, data.sessionId, data.secret)
    if (!session.ok) return session
    this.closeSessions('id = ?', data.sessionId, this.clock())
    return { ok: true }
  }

  // ── Supervisor authorization ─────────────────────────────────────────

  /**
   * The supervisor types their PIN on the waiter's device, without closing the waiter's session.
   * The hub issues a single-use approval for the exact event being authorized: the device sends
   * its `fingerprint` (`authorizableFingerprint`) and the approval is only valid for that content,
   * from that session.
   */
  authorize(
    connection: Connection,
    data: {
      sessionId: string
      secret: string
      pin: string
      action: string
      aggregateId: string
      eventId: string
      fingerprint: string
    },
  ): { ok: true; authorizationId: string; supervisor: { id: string; name: string } } | AccessError {
    const session = this.activeSession(connection, data.sessionId, data.secret)
    if (!session.ok) return session
    const action = data.action
    if (!isPermission(action)) return error('invalid_data', 'Acción desconocida')
    if (!/^[0-9a-f]{64}$/.test(data.fingerprint))
      return error('invalid_data', 'Falta la huella del evento')

    // Typing one's own PIN does not authorize, and counts as one more attempt: otherwise,
    // alternating one's own PIN with other people's PINs would avoid the wait.
    const r = this.withPin(
      `device:${connection.deviceId}`,
      data.pin,
      (u) => u.id !== session.userId && this.hasPermission(u.id, action),
      PIN_WITHOUT_PERMISSION,
    )
    if (!r.ok) {
      const own = isWellFormedPin(data.pin) && this.userByPin(data.pin)?.id === session.userId
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
        data.sessionId,
      )
    return { ok: true, authorizationId, supervisor: { id: r.user.id, name: r.user.name } }
  }

  // ── Event access control (AccessControl) ─────────────────────────────

  verify(connection: Connection, event: NewEvent, order: OrderState | null): AccessVerdict {
    const deny = (reason: string): AccessVerdict => ({ ok: false, reason })
    // Something the event did before an admin change (archiving the user, removing a permission)
    // is not lost: the manager reviews it.
    const review = (reason: string): AccessVerdict => ({ ok: false, reason, quarantine: true })

    if (!event.session_id) return deny('no_session')
    const session = this.db
      .prepare('SELECT * FROM sessions WHERE restaurant_id = ? AND id = ?')
      .get(this.restaurantId, event.session_id)
    if (!session) return review('unknown_session')
    if (session.device_id !== connection.deviceId) return deny('foreign_session')
    if (session.user_id !== event.user_id) return deny('user_mismatch')
    // The signature proves it was created by whoever had the session open, not someone else using
    // its `session_id`.
    const signature = signEvent(event, this.secretOf(event.session_id))
    if (!event.signature || !constantTimeEqual(event.signature, signature))
      return Date.parse(String(session.start)) < this.keyFrom
        ? review('password_changed')
        : deny('invalid_signature')

    // The session is judged at the event's time: what was done offline while it was open counts.
    const time = Date.parse(event.hub_estimated_time)
    if (time < Date.parse(String(session.start)) - CLOCK_TOLERANCE_MS) return deny('session_closed')
    if (
      session.closed_at !== null &&
      time > Date.parse(String(session.closed_at)) + CLOCK_TOLERANCE_MS
    )
      return deny('session_closed')
    const change = this.lastChangeOf(event.user_id)
    if (!this.isUserActive(event.user_id))
      return time < change ? review('user_archived') : deny('user_inactive')

    const permission = permissionFor(event, order)
    if (!permission) return deny('hub_only')
    // The stored type, not the connection's: signing in with a password makes an already
    // connected phone a register device (ADR-013).
    if (ONLY_FROM_REGISTER.has(event.type) && this.typeOf(connection) !== 'register')
      return deny('register_only')
    if (this.hasPermission(event.user_id, permission))
      return { ok: true, authorizedById: null, authorizationId: null }

    if (!event.authorization_id)
      return time < change ? review('permissions_changed') : deny('no_permission')
    const a = this.db
      .prepare('SELECT * FROM authorizations WHERE restaurant_id = ? AND id = ?')
      .get(this.restaurantId, event.authorization_id)
    if (!a || !this.approvalIsValid(a, event, permission, time))
      return deny('invalid_authorization')
    return { ok: true, authorizedById: String(a.supervisor_id), authorizationId: String(a.id) }
  }

  recordUse(event: NewEvent, verdict: Extract<AccessVerdict, { ok: true }>) {
    const now = this.clock()
    // What is received also counts as session use (never later than the hub's time).
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

  // ── Users ────────────────────────────────────────────────────────────

  /** Creates a user with a new PIN. It is returned only this time: it is not stored in clear. */
  createUser(data: UserData, author: Author = SYSTEM): { userId: string; pin: string } {
    return inTransaction(this.db, () => this.insertUser(data, author))
  }

  /** Like `createUser`, inside a transaction the caller already opened. */
  insertUser(data: UserData, author: Author = SYSTEM): { userId: string; pin: string } {
    const name = data.name.trim()
    if (name.length === 0 || name.length > 60)
      throw new DataError('El nombre debe tener entre 1 y 60 letras')
    const role = this.db
      .prepare('SELECT 1 FROM roles WHERE restaurant_id = ? AND id = ? AND active = 1')
      .get(this.restaurantId, data.roleId)
    if (!role) throw new DataError('Ese rol no existe o está archivado')

    const now = this.clock()
    const userId = insertVersioned(
      this.db,
      'users',
      this.restaurantId,
      { name, role_id: data.roleId },
      author,
      now,
      data.id,
    )
    const pin = this.freePin()
    this.db
      .prepare(
        `INSERT INTO user_credentials (user_id, restaurant_id, pin_hash, pin_generated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(userId, this.restaurantId, pinHash(this.key, this.restaurantId, pin), now)
    if (data.user !== undefined && data.password !== undefined)
      this.setPassword(userId, data.user, data.password)
    return { userId, pin }
  }

  /**
   * Sets or changes the username and password (from then on they sign in with them and their PIN
   * only authorizes). Closes their sessions: whoever knew the old password must not stay signed in.
   * Throws an error with an on-screen message if the username is invalid or taken, or the password
   * is too short.
   */
  assignPassword(userId: string, user: string, password: string) {
    inTransaction(this.db, () => this.setPassword(userId, user, password))
  }

  /** Like `assignPassword`, inside a transaction the caller already opened. */
  setPassword(userId: string, user: string, password: string) {
    const name = normalizeUsername(user)
    if (!name)
      throw new DataError(
        'El usuario lleva de 3 a 40 letras (sin tildes ni espacios), números, punto o guion',
      )
    if (!isValidPassword(password))
      throw new DataError('La contraseña debe tener al menos 8 caracteres')
    const taken = this.db
      .prepare(
        `SELECT 1 FROM user_credentials WHERE restaurant_id = ? AND username = ?
           AND current = 1 AND user_id <> ?`,
      )
      .get(this.restaurantId, name, userId)
    if (taken) throw new DataError(`Ya hay alguien con el usuario «${name}»`)
    const now = this.clock()
    const change = this.db
      .prepare(
        `UPDATE user_credentials SET username = ?, password_hash = ?,
           password_changed_at = ? WHERE restaurant_id = ? AND user_id = ?`,
      )
      .run(name, passwordHash(password, this.passwordCost), now, this.restaurantId, userId)
    if (Number(change.changes) === 0) throw new Error('Ese usuario no tiene credencial')
    this.closeSessions('user_id = ?', userId, now)
  }

  /** Removes username and password: from then on they sign in with their PIN. Closes sessions. */
  removePassword(userId: string) {
    const now = this.clock()
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE user_credentials SET username = NULL, password_hash = NULL,
             password_changed_at = ? WHERE restaurant_id = ? AND user_id = ?`,
        )
        .run(now, this.restaurantId, userId)
      this.closeSessions('user_id = ?', userId, now)
    })
  }

  /** The username that person signs in with, or `null` if they sign in with their PIN. */
  userOf(userId: string): string | null {
    const f = this.db
      .prepare('SELECT username FROM user_credentials WHERE restaurant_id = ? AND user_id = ?')
      .get(this.restaurantId, userId)
    return f?.username == null ? null : String(f.username)
  }

  hasPassword(userId: string): boolean {
    return this.userOf(userId) !== null
  }

  /**
   * For someone who forgot their PIN, if it leaked, or after losing the hub key. Closes their
   * sessions: whoever knew the old PIN must not stay signed in.
   */
  regeneratePin(userId: string): string {
    const now = this.clock()
    return inTransaction(this.db, () => {
      const pin = this.freePin()
      const change = this.db
        .prepare(
          `UPDATE user_credentials SET pin_hash = ?, pin_generated_at = ?
           WHERE restaurant_id = ? AND user_id = ?`,
        )
        .run(pinHash(this.key, this.restaurantId, pin), now, this.restaurantId, userId)
      if (Number(change.changes) === 0) throw new Error('Ese usuario no tiene credencial')
      this.closeSessions('user_id = ?', userId, now)
      return pin
    })
  }

  /** Archives the user: their PIN becomes free and their sessions are closed. */
  archiveUser(userId: string, author: Author = SYSTEM) {
    const now = this.clock()
    inTransaction(this.db, () => {
      updateVersioned(this.db, 'users', this.restaurantId, userId, { active: 0 }, author, now)
      this.closeSessions('user_id = ?', userId, now)
    })
  }

  permissionsOf(userId: string): Permission[] {
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

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Looks up the PIN's owner with the attempt wait of `who`. A PIN that does not exist and one
   * without permission give the same `message`: so nobody learns the PIN belongs to someone in the
   * restaurant. A success does not clear the failures: otherwise, alternating one's own PIN with
   * other people's would avoid the wait. Failures are forgotten on their own after a while
   * without errors.
   */
  private withPin(
    who: string,
    pin: string,
    isValid: (user: SessionUser) => boolean,
    message: string,
  ): { ok: true; user: SessionUser } | AccessError {
    const delay = this.attempts.waitMs(who)
    if (delay > 0) return wait(delay)
    const user = isWellFormedPin(pin) ? this.userByPin(pin) : undefined
    if (!user || !isValid(user)) return error('wrong_pin', message, this.attempts.failure(who))
    return { ok: true, user }
  }

  /**
   * Looks up whoever signs in with username and password. The wait goes by the attempter and also
   * by the username: trying an account's passwords from many IPs does not avoid the brake. A
   * username that does not exist and a wrong password give the same answer and take the same time.
   */
  private withPassword(
    who: string,
    user: string,
    password: string,
  ): { ok: true; user: SessionUser } | AccessError {
    const name = normalizeUsername(user)
    // What was typed is not kept in the attempt count: it could be the password in the wrong field.
    const check = `user:${name ?? 'invalid'}`
    const delay = Math.max(this.attempts.waitMs(who), this.attempts.waitMs(check))
    if (delay > 0) return wait(delay)
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
    // It always compares, at the same cost: it does not reveal if the user exists or is active.
    const saved = f ? String(f.password_hash) : this.padding()
    // A password longer than allowed is never the right one (it is not truncated to compare it).
    const matches =
      passwordMatches(password.slice(0, PASSWORD_MAX_LENGTH), saved) &&
      password.length <= PASSWORD_MAX_LENGTH
    if (f?.active !== 1 || !matches) {
      const ms = Math.max(
        this.attempts.failure(who),
        this.attempts.failure(check, { count: false, cap: MAX_USERNAME_WAIT_MS }),
      )
      return error('invalid_credentials', INVALID_CREDENTIALS, ms)
    }
    return { ok: true, user: { id: String(f.id), name: String(f.name), role: String(f.role) } }
  }

  private padding(): string {
    this.dummyHash ??= passwordHash('relleno', this.passwordCost)
    return this.dummyHash
  }

  private userByPin(pin: string): SessionUser | undefined {
    const f = this.db
      .prepare(
        `SELECT u.id, u.name, r.name AS role FROM user_credentials c
         JOIN users u ON u.id = c.user_id AND u.active = 1
         JOIN roles r ON r.id = u.role_id
         WHERE c.restaurant_id = ? AND c.pin_hash = ? AND c.current = 1`,
      )
      .get(this.restaurantId, pinHash(this.key, this.restaurantId, pin))
    return f ? { id: String(f.id), name: String(f.name), role: String(f.role) } : undefined
  }

  /** A session secret derives from the hub key: so it can verify signatures without storing it. */
  private secretOf(sessionId: string): string {
    return sessionSecretFor(this.key, this.restaurantId, sessionId)
  }

  private activeSession(
    connection: Connection,
    sessionId: string,
    secret: string,
  ): { ok: true; userId: string } | AccessError {
    if (connection.revokedAt) return error('revoked_device', 'Este equipo fue retirado')
    const s = this.db
      .prepare('SELECT * FROM sessions WHERE restaurant_id = ? AND id = ?')
      .get(this.restaurantId, sessionId)
    const isValid =
      s !== undefined &&
      s.device_id === connection.deviceId &&
      s.closed_at === null &&
      sameHash(String(s.secret_hash), secretHash(secret)) &&
      this.isUserActive(String(s.user_id))
    if (!isValid) return error('invalid_session', 'La sesión se cerró: vuelve a entrar')
    return { ok: true, userId: String(s.user_id) }
  }

  private closeSessions(filter: string, value: SqlValue, now: string) {
    this.db
      .prepare(
        `UPDATE sessions SET closed_at = ? WHERE restaurant_id = ? AND ${filter} AND closed_at IS NULL`,
      )
      .run(now, this.restaurantId, value)
  }

  private approvalIsValid(a: Row, event: NewEvent, permission: Permission, time: number): boolean {
    const issued = Date.parse(String(a.issued_at))
    return (
      a.event_id === event.id &&
      a.aggregate_id === event.aggregate_id &&
      a.action === permission &&
      a.session_id === event.session_id &&
      a.content_hash === authorizableFingerprint(event) &&
      a.used_at === null &&
      a.supervisor_id !== event.user_id &&
      // The time is inside the fingerprint: the device set it when requesting the approval.
      time >= issued - CLOCK_TOLERANCE_MS &&
      time <= issued + AUTHORIZATION_TTL_MS &&
      Date.parse(this.clock()) <= issued + AUTHORIZED_DELIVERY_MS &&
      this.hasPermission(String(a.supervisor_id), permission)
    )
  }

  private hasPermission(userId: string, permission: Permission): boolean {
    return this.permissionsOf(userId).includes(permission)
  }

  private isUserActive(userId: string): boolean {
    const f = this.db
      .prepare('SELECT active FROM users WHERE restaurant_id = ? AND id = ?')
      .get(this.restaurantId, userId)
    return f?.active === 1
  }

  /** Last change to the user, their role or the role's permissions (ms); 0 if it does not exist. */
  private lastChangeOf(userId: string): number {
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

  /** Creates the device and its token (inside a transaction). The token is shown only this time. */
  private registerDevice(
    name: string,
    type: DeviceType,
    approvedBy: string,
    now: string,
  ): { deviceId: string; token: string } {
    const token = newSecret()
    const deviceId = insertVersioned(
      this.db,
      'devices',
      this.restaurantId,
      {
        location_id: this.mainLocation(),
        name,
        type,
        paired_at: now,
        revoked_at: null,
        revocation_sequence: null,
      },
      { userId: approvedBy, deviceId: null },
      now,
    )
    this.db
      .prepare(
        `INSERT INTO device_credentials (device_id, restaurant_id, token_hash, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(deviceId, this.restaurantId, secretHash(token), now)
    return { deviceId, token }
  }

  private typeOf(connection: Connection): DeviceType {
    const f = this.db
      .prepare('SELECT type FROM devices WHERE restaurant_id = ? AND id = ?')
      .get(this.restaurantId, connection.deviceId)
    return f ? (String(f.type) as DeviceType) : connection.type
  }

  private hasDevices(): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM devices WHERE restaurant_id = ? AND active = 1 AND revoked_at IS NULL LIMIT 1',
        )
        .get(this.restaurantId) !== undefined
    )
  }

  private mainLocation(): string {
    const f = this.db
      .prepare(
        'SELECT id FROM locations WHERE restaurant_id = ? AND active = 1 ORDER BY created_at, id LIMIT 1',
      )
      .get(this.restaurantId)
    if (!f) throw new Error('El restaurante no tiene sede')
    return String(f.id)
  }

  /** A PIN that no active user has. */
  private freePin(): string {
    for (let i = 0; i < 500; i++) {
      const pin = generatePin()
      const taken = this.db
        .prepare(
          'SELECT 1 FROM user_credentials WHERE restaurant_id = ? AND pin_hash = ? AND current = 1',
        )
        .get(this.restaurantId, pinHash(this.key, this.restaurantId, pin))
      if (!taken) return pin
    }
    throw new DataError('No quedan PIN libres: archiva usuarios que ya no trabajen')
  }
}
