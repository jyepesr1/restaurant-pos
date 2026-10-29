import { type NewEvent, newId, PERMISSIONS, signEvent } from '@pos/core'
import { applyMigrations } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import type { Connection } from '@pos/sync'
import { Attempts } from './attempts'
import { ensureAdmin, ensureRestaurant, ensureRoles } from './initial'
import { SYSTEM } from './records'
import { AccessService } from './service'
import { saveRole } from './staff'

// Setup for the access tests: a hub with an in-memory database, a manual clock and one user
// per role. Besides the built-in ones, a custom «Gerente» role (what was built-in before
// ADR-013) and «Cocina». Tests only.

export const START = Date.parse('2026-10-24T20:00:00.000Z')

export type Session = { sessionId: string; secret: string; user: { id: string } }

/** The event with that session's signature (what the app does after each change to the event). */
export const signed = <E extends NewEvent>(session: Session, event: E): E => {
  const { signature: _old, ...unsigned } = event
  return { ...unsigned, signature: signEvent(unsigned as NewEvent, session.secret) } as E
}

export function setupAccess() {
  const db = openDatabase(':memory:')
  applyMigrations(db)
  let ms = START
  const clock = () => new Date(ms).toISOString()
  const alerts: string[] = []
  const revokedIds: string[] = []
  const attempts = new Attempts(
    () => ms,
    (n) => alerts.push(n),
  )
  const restaurantId = ensureRestaurant(db, clock())
  const roles = ensureRoles(db, restaurantId, clock())
  const access = new AccessService({
    db,
    restaurantId,
    key: Buffer.alloc(32, 7),
    clock,
    attempts,
    onRevoke: (id) => revokedIds.push(id),
    // Fast: this is not where we test how costly guessing a password is.
    passwordCost: 1,
  })
  const admin = ensureAdmin(db, access, roles.admin, false)
  const customRoles = {
    manager: saveRole(
      db,
      restaurantId,
      access,
      {
        name: 'Gerente',
        permissions: PERMISSIONS.filter(
          (p) => !['manage_users', 'manage_devices', 'view_own_reports'].includes(p),
        ),
      },
      SYSTEM,
      clock(),
    ),
    kitchen: saveRole(
      db,
      restaurantId,
      access,
      { name: 'Cocina', permissions: ['mark_preparation', 'mark_product_sold_out'] },
      SYSTEM,
      clock(),
    ),
  }
  const allRoles = { ...roles, ...customRoles }
  const people: Record<
    'admin' | 'manager' | 'cashier' | 'waiter' | 'waiter2',
    { userId: string; pin: string; user?: string; password?: string }
  > = {
    admin: {
      userId: '',
      pin: admin.pin as string,
      user: admin.user as string,
      password: admin.password as string,
    },
    // With register or admin permissions you sign in with a password (ADR-013).
    manager: {
      ...access.createUser({
        name: 'Gloria',
        roleId: customRoles.manager,
        user: 'gloria',
        password: 'clave-de-gloria',
      }),
      user: 'gloria',
      password: 'clave-de-gloria',
    },
    cashier: {
      ...access.createUser({
        name: 'Carlos',
        roleId: roles.cashier,
        user: 'carlos',
        password: 'clave-de-carlos',
      }),
      user: 'carlos',
      password: 'clave-de-carlos',
    },
    waiter: access.createUser({ name: 'Ana', roleId: roles.waiter }),
    waiter2: access.createUser({ name: 'Luis', roleId: roles.waiter }),
  }
  people.admin.userId = String(
    db.prepare("SELECT id FROM users WHERE name = 'Administrador'").get()?.id,
  )

  let approver: Connection | null = null

  /** Pairs a device of that type (approved by the admin) and returns its connection. */
  function pair(type: 'waiter' | 'register' | 'kds' = 'waiter', name = `Equipo ${type}`) {
    // The first is approved without a device (the freshly installed register); the rest, from it.
    const code = access.createPairing({ pin: people.admin.pin, name, type }, approver)
    if (!code.ok) throw new Error(code.message)
    const r = access.pair(code.code, '10.0.0.9')
    if (!r.ok) throw new Error(r.message)
    const connection = access.authenticate(r.token) as Connection
    approver ??= connection
    return { token: r.token, connection }
  }

  /**
   * Opens a session on that device: with their PIN, or with user and password if they have them
   * (the admin). Signing in with a password turns the device into a register (ADR-013).
   */
  function signIn(connection: Connection, who: keyof typeof people) {
    const p = people[who]
    const r =
      p.user && p.password
        ? access.signIn({ user: p.user, password: p.password }, connection, '10.0.0.9')
        : access.startSession(connection, p.pin)
    if (!r.ok) throw new Error(r.message)
    return r
  }

  /** An event as the app would create it on that device, with that session, already signed. */
  function event(
    connection: Connection,
    session: Session,
    type: string,
    data: unknown,
    extras: Partial<NewEvent> = {},
  ) {
    return signed(session, {
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: newId(),
      related: [],
      data,
      session_id: session.sessionId,
      user_id: session.user.id,
      device_id: connection.deviceId,
      authorization_id: null,
      reason: null,
      device_time: clock(),
      hub_estimated_time: clock(),
      base_sequence: 0,
      ...extras,
    } as NewEvent)
  }

  return {
    signed,
    db,
    access,
    roles: allRoles,
    restaurantId,
    people,
    alerts,
    revokedIds,
    clock,
    advance: (n: number) => {
      ms += n
    },
    pair,
    signIn,
    event,
  }
}

export type AccessSetup = ReturnType<typeof setupAccess>
