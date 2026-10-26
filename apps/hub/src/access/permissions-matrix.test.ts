import { isPermission, ORDER_EVENT_TYPES, PERMISSIONS, type Permission } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { authorizeEvent } from './hub-setup'
import { setupAccess } from './setup'

// The matrix from docs/MODELO_DATOS.md#permisos, written here by hand (not read from the code)
// and checked end to end: roles seeded in the database × each event type, through `verify`.
// The built-in ones are admin, cashier, reports and waiter (ADR-013); manager and kitchen are
// custom roles created by the setup, like the ones a restaurant would make.

type Role = 'admin' | 'manager' | 'cashier' | 'waiter' | 'kitchen' | 'reports'
const ROLES: Role[] = ['admin', 'manager', 'cashier', 'waiter', 'kitchen', 'reports']

const DOC: Record<Permission, Role[]> = {
  take_order: ['admin', 'manager', 'cashier', 'waiter'],
  remove_unsent_item: ['admin', 'manager', 'cashier', 'waiter'],
  void_sent_item: ['admin', 'manager', 'cashier'],
  cancel_order: ['admin', 'manager'],
  apply_discount: ['admin', 'manager', 'cashier'],
  comp: ['admin', 'manager'],
  reassign_table: ['admin', 'manager', 'cashier'],
  split_check: ['admin', 'manager', 'cashier'],
  record_payment: ['admin', 'manager', 'cashier'],
  void_payment: ['admin', 'manager'],
  close_table: ['admin', 'manager', 'cashier'],
  reopen_check: ['admin', 'manager'],
  open_register_shift: ['admin', 'manager', 'cashier'],
  close_register_shift: ['admin', 'manager', 'cashier'],
  cash_movement: ['admin', 'manager', 'cashier'],
  open_drawer_no_sale: ['admin', 'manager'],
  mark_preparation: ['admin', 'manager', 'waiter', 'kitchen'],
  mark_product_sold_out: ['admin', 'manager', 'cashier', 'kitchen'],
  edit_catalog: ['admin', 'manager'],
  edit_prices: ['admin', 'manager'],
  manage_users: ['admin'],
  manage_devices: ['admin'],
  view_reports: ['admin', 'manager', 'reports'],
  view_own_reports: ['cashier', 'waiter'],
}

/** Which permission each event requires, per the «Permiso» column of the doc's table. */
const EVENT_DOC: Record<string, Permission | null> = {
  OrderOpened: 'take_order',
  GuestsChanged: 'take_order',
  OrderNoteChanged: 'take_order',
  TablesMerged: 'take_order',
  TablesSeparated: 'take_order',
  ItemAdded: 'take_order',
  ItemChanged: 'take_order',
  ItemsSent: 'take_order',
  ItemModifiedAfterSend: 'take_order',
  TicketReprinted: 'take_order',
  CourseHeld: 'take_order',
  CourseFired: 'take_order',
  ItemsMoved: 'take_order',
  OrderMovedTable: 'take_order',
  OrdersMerged: 'take_order',
  PreBillPrinted: 'take_order',
  ItemRemoved: 'remove_unsent_item',
  ItemVoided: 'void_sent_item',
  OrderCanceled: 'cancel_order',
  DiscountApplied: 'apply_discount',
  DiscountRemoved: 'apply_discount',
  WaiterAssigned: 'reassign_table',
  CheckSplit: 'split_check',
  SplitUndone: 'split_check',
  PaymentRecorded: 'record_payment',
  PaymentVoided: 'void_payment',
  RefundRecorded: 'void_payment',
  OrderClosed: 'close_table',
  OrderReopened: 'reopen_check',
  ItemInPreparation: 'mark_preparation',
  ItemReady: 'mark_preparation',
  ItemServed: 'mark_preparation',
  ItemReturnedToQueue: 'mark_preparation',
  RescueOrderCreated: null,
  // Sold out (86): product events, not order events (task 1.3).
  ProductSoldOut: 'mark_product_sold_out',
  ProductAvailable: 'mark_product_sold_out',
  // Opening the register with the float (task 1.6): a shift event, not an order event.
  ShiftOpened: 'open_register_shift',
  // Cash movements, cash count and register close (task 1.7).
  CashMovementRecorded: 'cash_movement',
  CashCountRecorded: 'close_register_shift',
  ShiftClosed: 'close_register_shift',
}

const REGISTER_ONLY_DOC = [
  'ShiftOpened',
  'CashMovementRecorded',
  'CashCountRecorded',
  'ShiftClosed',
  'PaymentRecorded',
  'PaymentVoided',
  'RefundRecorded',
  'OrderClosed',
]

function setup() {
  const m = setupAccess()
  const kitchen = m.access.createUser({ name: 'Coco', roleId: m.roles.kitchen })
  // Viewing reports requires a password (ADR-013).
  const reports = m.access.createUser({
    name: 'Repo',
    roleId: m.roles.reports,
    user: 'repo',
    password: 'clave-de-repo',
  })
  const pin: Record<Role, string> = {
    admin: m.people.admin.pin,
    manager: m.people.manager.pin,
    cashier: m.people.cashier.pin,
    waiter: m.people.waiter.pin,
    kitchen: kitchen.pin,
    reports: reports.pin,
  }
  const users: Record<Role, string> = {
    admin: m.people.admin.userId,
    manager: m.people.manager.userId,
    cashier: m.people.cashier.userId,
    waiter: m.people.waiter.userId,
    kitchen: kitchen.userId,
    reports: reports.userId,
  }

  /** A device of the given type, with an open session for that role (one per role: no overlap). */
  function sessionOf(role: Role, type: 'register' | 'waiter' | 'kds') {
    const { connection } = m.pair(type, `${type}-${role}`)
    // Anyone with register or admin permissions signs in with username and password; everyone
    // else, with their PIN.
    const r =
      role === 'admin' || role === 'manager' || role === 'cashier'
        ? m.signIn(connection, role)
        : role === 'reports'
          ? m.access.signIn({ user: 'repo', password: 'clave-de-repo' }, connection, '10.0.0.9')
          : m.access.startSession(connection, pin[role])
    if (!r.ok) throw new Error(r.message)
    return { connection, session: r }
  }
  return { ...m, pin, users, sessionOf }
}

describe("the doc's permission matrix, by role", () => {
  it("the doc's table covers every permission key and every event type", () => {
    expect(Object.keys(DOC).sort()).toEqual([...PERMISSIONS].sort())
    expect(Object.keys(EVENT_DOC).sort()).toEqual([...ORDER_EVENT_TYPES].sort())
  })

  it('each role seeded in the database has exactly the permissions in its column', () => {
    const m = setup()
    for (const role of ROLES) {
      const expectedList = PERMISSIONS.filter((p) => DOC[p].includes(role)).sort()
      expect(m.access.permissionsOf(m.users[role]), role).toEqual(expectedList)
    }
  })

  it('the session hands the device the permissions of its role', () => {
    const m = setup()
    for (const role of ROLES) {
      const { session } = m.sessionOf(role, 'register')
      expect([...session.permissions].sort(), role).toEqual(
        PERMISSIONS.filter((p) => DOC[p].includes(role)).sort(),
      )
    }
  })

  for (const role of ROLES) {
    it(`${role}: each event is accepted or denied per the matrix (from a register)`, () => {
      const m = setup()
      const { connection, session } = m.sessionOf(role, 'register')
      const failures: string[] = []
      for (const type of ORDER_EVENT_TYPES) {
        const permission = EVENT_DOC[type] as Permission | null
        const v = m.access.verify(connection, m.event(connection, session, type, {}), null)
        const expected =
          permission === null
            ? { ok: false, reason: 'hub_only' }
            : DOC[permission].includes(role)
              ? { ok: true, authorizedById: null, authorizationId: null }
              : { ok: false, reason: 'no_permission' }
        if (JSON.stringify(v) !== JSON.stringify(expected))
          failures.push(`${type}: ${JSON.stringify(v)} (expected ${JSON.stringify(expected)})`)
      }
      expect(failures).toEqual([])
    })
  }

  it('a comp requires its own permission, not the discount one', () => {
    const m = setup()
    for (const role of ROLES) {
      const { connection, session } = m.sessionOf(role, 'register')
      const comp = m.event(connection, session, 'DiscountApplied', { rule: 'comp' })
      const percent = m.event(connection, session, 'DiscountApplied', { rule: 'percent' })
      expect(m.access.verify(connection, comp, null).ok, `${role} comp`).toBe(
        DOC.comp.includes(role),
      )
      expect(m.access.verify(connection, percent, null).ok, `${role} discount`).toBe(
        DOC.apply_discount.includes(role),
      )
    }
  })

  it('if a role loses only «comp», it can still discount (and the other way around)', () => {
    const m = setup()
    const { connection, session } = m.sessionOf('manager', 'register')
    const comp = m.event(connection, session, 'DiscountApplied', { rule: 'comp' })
    const percent = m.event(connection, session, 'DiscountApplied', { rule: 'percent' })

    m.db
      .prepare("UPDATE role_permissions SET active = 0 WHERE permission = 'comp' AND role_id = ?")
      .run(m.roles.manager)
    expect(m.access.verify(connection, comp, null)).toEqual({
      ok: false,
      reason: 'no_permission',
    })
    expect(m.access.verify(connection, percent, null).ok).toBe(true)
  })

  it('payments, refunds and closes only come from a register: not even the admin from a KDS', () => {
    const m = setup()
    for (const deviceType of ['waiter', 'kds'] as const)
      for (const role of ROLES) {
        // Someone who can charge signing in with a password turns a phone into a register
        // (ADR-013): tested separately.
        if (['admin', 'manager', 'cashier'].includes(role) && deviceType === 'waiter') continue
        const { connection, session } = m.sessionOf(role, deviceType)
        for (const type of REGISTER_ONLY_DOC)
          expect(
            m.access.verify(connection, m.event(connection, session, type, {}), null),
            `${role}/${deviceType}/${type}`,
          ).toEqual({ ok: false, reason: 'register_only' })
      }
  })

  it('signing in with a password on a phone turns it into a register, and it can charge from there', () => {
    const m = setup()
    const { connection, session } = m.sessionOf('admin', 'waiter')
    expect(
      m.db.prepare('SELECT type FROM devices WHERE id = ?').get(connection.deviceId)?.type,
    ).toBe('register')
    // The connection opened before signing in still says «waiter»: the hub looks at the saved
    // device.
    expect(connection.type).toBe('waiter')
    for (const type of REGISTER_ONLY_DOC)
      expect(
        m.access.verify(connection, m.event(connection, session, type, {}), null).ok,
        type,
      ).toBe(true)
  })

  it('the rest of the events do not depend on the device type', () => {
    const m = setup()
    const types = ORDER_EVENT_TYPES.filter(
      (t) => !REGISTER_ONLY_DOC.includes(t) && EVENT_DOC[t] !== null,
    )
    for (const deviceType of ['waiter', 'register', 'kds'] as const) {
      const { connection, session } = m.sessionOf('manager', deviceType)
      for (const t of types)
        expect(m.access.verify(connection, m.event(connection, session, t, {}), null).ok, t).toBe(
          true,
        )
    }
  })

  it('only the hub emits RescueOrderCreated: not even the admin creates it', () => {
    const m = setup()
    const { connection, session } = m.sessionOf('admin', 'register')
    expect(
      m.access.verify(connection, m.event(connection, session, 'RescueOrderCreated', {}), null),
    ).toEqual({ ok: false, reason: 'hub_only' })
  })
})

describe('supervisor approval for each event without permission', () => {
  it('whoever lacks the permission gets it from a supervisor who has it, for every possible event', () => {
    const m = setup()
    // The waiter writes on a register: that way payments and closes are tested too.
    const { connection, session } = m.sessionOf('waiter', 'register')
    const withoutPermission = ORDER_EVENT_TYPES.filter((t) => {
      const p = EVENT_DOC[t] as Permission | null
      return p !== null && !DOC[p].includes('waiter')
    })
    expect(withoutPermission.length).toBeGreaterThan(10)

    for (const type of withoutPermission) {
      const ev = m.event(connection, session, type, { rule: 'comp' })
      const action = EVENT_DOC[type] as Permission
      // «comp» only applies to DiscountApplied with that rule.
      const required = type === 'DiscountApplied' ? 'comp' : action
      const { approval, event } = authorizeEvent(m, connection, session, m.pin.admin, ev, required)
      expect(m.access.verify(connection, event, null), type).toEqual({
        ok: true,
        authorizedById: m.users.admin,
        authorizationId: approval.authorizationId,
      })
    }
  })

  it('a supervisor without that permission cannot issue the approval, role by role and permission by permission', () => {
    const m = setup()
    // The admin (with every permission) is on the phone; the others try to authorize.
    const { connection, session } = m.sessionOf('waiter', 'waiter')
    // Back-to-back attempts would hit the wait: each valid PIN (from someone without the
    // permission) counts as a failure. The clock moves forward enough that the wait never gets in
    // the way.
    for (const permission of PERMISSIONS)
      for (const role of ROLES) {
        m.advance(61_000)
        const r = m.access.authorize(connection, {
          ...session,
          pin: m.pin[role],
          action: permission,
          aggregateId: m.restaurantId,
          eventId: `${permission}-${role}`.padEnd(26, 'X').slice(0, 26),
          fingerprint: '0'.repeat(64),
        })
        if (role === 'waiter') {
          expect(r, `waiter/${permission}`).toMatchObject({ ok: false, code: 'self_authorization' })
        } else if (DOC[permission].includes(role)) {
          expect(r.ok, `${role}/${permission}`).toBe(true)
        } else {
          expect(r, `${role}/${permission}`).toMatchObject({ ok: false, code: 'wrong_pin' })
        }
      }
  })

  it('an approval for «discount» does not work for a comp, nor the other way around', () => {
    const m = setup()
    const { connection, session } = m.sessionOf('waiter', 'register')
    const tryAction = (issuedFor: Permission, rule: string) => {
      const ev = m.event(connection, session, 'DiscountApplied', { rule })
      const r = authorizeEvent(m, connection, session, m.pin.manager, ev, issuedFor)
      return m.access.verify(connection, r.event, null)
    }

    expect(tryAction('apply_discount', 'comp')).toEqual({
      ok: false,
      reason: 'invalid_authorization',
    })
    expect(tryAction('comp', 'percent')).toEqual({
      ok: false,
      reason: 'invalid_authorization',
    })
    expect(tryAction('comp', 'comp').ok).toBe(true)
    expect(tryAction('apply_discount', 'percent').ok).toBe(true)
  })

  it('the approval does not bypass the «register only» rule', () => {
    const m = setup()
    const { connection, session } = m.sessionOf('waiter', 'waiter')
    const ev = m.event(connection, session, 'PaymentRecorded', {})
    const r = authorizeEvent(m, connection, session, m.pin.admin, ev, 'record_payment')

    expect(m.access.verify(connection, r.event, null)).toEqual({
      ok: false,
      reason: 'register_only',
    })
  })

  it('an action that is not a permission (or a made-up one) is not authorized', () => {
    const m = setup()
    const { connection, session } = m.sessionOf('waiter', 'waiter')
    for (const action of ['delete_all', '', 'constructor', '__proto__', 'TAKE_ORDER'])
      expect(
        m.access.authorize(connection, {
          ...session,
          pin: m.pin.admin,
          action,
          aggregateId: m.restaurantId,
          eventId: `E-${action}`.padEnd(26, 'X').slice(0, 26),
          fingerprint: '0'.repeat(64),
        }),
        action,
      ).toMatchObject({ ok: false, code: 'invalid_data' })
    for (const p of PERMISSIONS) expect(isPermission(p)).toBe(true)
  })
})
