import { authorizableFingerprint, newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { ensureAdmin, ensureRestaurant, ensureRoles } from './initial'
import { AUTHORIZATION_TTL_MS, CODE_TTL_MS } from './service'
import { setupAccess, signed } from './setup'

const open = { channel: 'dine_in', table_id: null, guests: 2 }

describe('startup', () => {
  it('creates the restaurant, location, roles and admin only once', () => {
    const m = setupAccess()
    const now = m.clock()
    expect(ensureRestaurant(m.db, now)).toBe(m.restaurantId)
    expect(m.roles).toMatchObject(ensureRoles(m.db, m.restaurantId, now))
    expect(ensureAdmin(m.db, m.access, m.roles.admin, false)).toEqual({
      pin: null,
      user: null,
      password: null,
      alerts: [],
    })

    const check = (tableName: string) =>
      Number(m.db.prepare(`SELECT count(*) AS n FROM ${tableName}`).get()?.n)
    expect(check('restaurants')).toBe(1)
    expect(check('locations')).toBe(1)
    expect(check('roles')).toBe(6)
    expect(m.access.permissionsOf(m.people.waiter.userId)).toEqual([
      'mark_preparation',
      'remove_unsent_item',
      'take_order',
      'view_own_reports',
    ])
    // Each catalog record took a different version from the counter.
    const versions = m.db.prepare('SELECT version FROM role_permissions').all()
    expect(new Set(versions.map((f) => f.version)).size).toBe(versions.length)
  })

  it("if the PIN key was lost, it regenerates the admin's PIN and alerts", () => {
    const m = setupAccess()
    const r = ensureAdmin(m.db, m.access, m.roles.admin, true)

    expect(r.pin).toMatch(/^\d{4}$/)
    expect(r.alerts.join(' ')).toMatch(/clave de los PIN/)
    expect(
      m.access.createPairing({ pin: m.people.admin.pin, name: 'X', type: 'register' }, null),
    ).toMatchObject({ ok: false })
    expect(
      m.access.createPairing({ pin: r.pin as string, name: 'X', type: 'register' }, null),
    ).toMatchObject({ ok: true })
  })
})

describe('pairing a device', () => {
  it('with an admin PIN it gives a code; the code is exchanged for a token only once', () => {
    const m = setupAccess()
    const code = m.access.createPairing(
      { pin: m.people.admin.pin, name: 'Celular Ana', type: 'waiter' },
      null,
    )
    if (!code.ok) throw new Error(code.message)
    const r = m.access.pair(code.code.toLowerCase(), '10.0.0.6')
    if (!r.ok) throw new Error(r.message)

    expect(m.access.authenticate(r.token)).toEqual({
      deviceId: r.deviceId,
      type: 'waiter',
      revokedAt: null,
    })
    expect(m.access.pair(code.code, '10.0.0.6')).toMatchObject({
      ok: false,
      code: 'invalid_code',
    })
    // The database keeps the token's fingerprint, not the token.
    const credential = m.db.prepare('SELECT token_hash FROM device_credentials').get()
    expect(credential?.token_hash).not.toBe(r.token)
    expect(m.access.authenticate('other')).toBeNull()
  })

  it("a waiter's PIN does not approve, with the same message as a PIN that does not exist", () => {
    const m = setupAccess()
    const withWaiter = m.access.createPairing(
      { pin: m.people.waiter.pin, name: 'X', type: 'waiter' },
      null,
    )
    expect(withWaiter).toMatchObject({ ok: false, code: 'wrong_pin' })
    const nonexistent = m.access.createPairing({ pin: '0001', name: 'X', type: 'waiter' }, null)
    expect(nonexistent).toMatchObject({ ok: false, code: 'wrong_pin' })
    expect(withWaiter).toEqual(nonexistent)
  })

  it('the code expires after 5 minutes', () => {
    const m = setupAccess()
    const code = m.access.createPairing({ pin: m.people.admin.pin, name: 'X', type: 'kds' }, null)
    if (!code.ok) throw new Error(code.message)
    m.advance(CODE_TTL_MS)
    expect(m.access.pair(code.code, 'ip')).toMatchObject({ code: 'invalid_code' })
  })

  it('rejects an empty name or an unknown type', () => {
    const m = setupAccess()
    const pin = m.people.admin.pin
    expect(m.access.createPairing({ pin, name: '  ', type: 'register' }, null)).toMatchObject({
      code: 'invalid_data',
    })
    expect(m.access.createPairing({ pin, name: 'X', type: 'tostadora' }, null)).toMatchObject({
      code: 'invalid_data',
    })
  })

  it('trying random codes from an IP makes it wait', () => {
    const m = setupAccess()
    for (let i = 0; i < 3; i++) m.access.pair('AAAAAAAA', '10.0.0.66')
    expect(m.access.pair('AAAAAAAA', '10.0.0.66')).toMatchObject({ code: 'wait' })
    expect(m.access.pair('AAAAAAAA', '10.0.0.67')).toMatchObject({ code: 'invalid_code' })
  })
})

describe('PIN sessions', () => {
  it('the PIN identifies the person and brings their permissions', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const r = m.signIn(connection, 'cashier')

    expect(r.user).toMatchObject({ name: 'Carlos', role: 'Cajero' })
    expect(r.permissions).toContain('record_payment')
    expect(r.secret).not.toBe('')
    const row = m.db.prepare('SELECT secret_hash FROM sessions').get()
    expect(row?.secret_hash).not.toBe(r.secret)
  })

  it('three wrong PINs on a device make it wait; not the others', () => {
    const m = setupAccess()
    const a = m.pair('waiter', 'A').connection
    const b = m.pair('waiter', 'B').connection
    const wrongPins = ['0001', '0002', '0003']
    const r = wrongPins.map((pin) => m.access.startSession(a, pin))

    expect(r.map((x) => (x.ok ? 'ok' : x.waitMs))).toEqual([0, 0, 2000])
    expect(m.access.startSession(a, m.people.waiter.pin)).toMatchObject({ code: 'wait' })
    expect(m.access.startSession(b, m.people.waiter.pin)).toMatchObject({ ok: true })
    m.advance(2000)
    expect(m.access.startSession(a, m.people.waiter.pin)).toMatchObject({ ok: true })
  })

  it("entering another PIN closes the device's previous session", () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const ana = m.signIn(connection, 'waiter')
    m.signIn(connection, 'waiter2')

    expect(m.access.closeSession(connection, ana)).toMatchObject({ code: 'invalid_session' })
  })

  it('closing the session requires its secret and the same device', () => {
    const m = setupAccess()
    const a = m.pair().connection
    const b = m.pair().connection
    const s = m.signIn(a, 'waiter')

    expect(m.access.closeSession(a, { ...s, secret: 'x' })).toMatchObject({ ok: false })
    expect(m.access.closeSession(b, s)).toMatchObject({ ok: false })
    expect(m.access.closeSession(a, s)).toEqual({ ok: true })
  })

  it('PINs are unique among active users; archiving frees the PIN and closes their sessions', () => {
    const m = setupAccess()
    const pins = new Set<string>()
    for (let i = 0; i < 300; i++)
      pins.add(m.access.createUser({ name: `U${i}`, roleId: m.roles.waiter }).pin)
    expect(pins.size).toBe(300)

    const { connection } = m.pair()
    const s = m.signIn(connection, 'waiter')
    m.access.archiveUser(m.people.waiter.userId)
    expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({
      code: 'wrong_pin',
    })
    expect(m.access.closeSession(connection, s)).toMatchObject({ code: 'invalid_session' })
  })

  it('regenerating the PIN invalidates the previous one', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const fresh = m.access.regeneratePin(m.people.waiter.userId)
    expect(m.access.startSession(connection, m.people.waiter.pin).ok).toBe(
      fresh === m.people.waiter.pin,
    )
    expect(m.access.startSession(connection, fresh)).toMatchObject({ ok: true })
  })
})

describe('which events each person can create', () => {
  it('the waiter takes orders; voiding a sent item asks for authorization', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const s = m.signIn(connection, 'waiter')

    expect(m.access.verify(connection, m.event(connection, s, 'OrderOpened', open), null)).toEqual({
      ok: true,
      authorizedById: null,
      authorizationId: null,
    })
    expect(
      m.access.verify(connection, m.event(connection, s, 'ItemVoided', {}, { reason: 'x' }), null),
    ).toEqual({ ok: false, reason: 'no_permission' })
  })

  it("with the manager's PIN, the approval is valid for that event, once", () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const s = m.signIn(connection, 'waiter')
    const voidItem = m.event(connection, s, 'ItemVoided', {}, { reason: 'Se equivocó' })
    const a = m.access.authorize(connection, {
      ...s,
      pin: m.people.manager.pin,
      action: 'void_sent_item',
      aggregateId: voidItem.aggregate_id,
      eventId: voidItem.id,
      fingerprint: authorizableFingerprint(voidItem),
    })
    if (!a.ok) throw new Error(a.message)
    expect(a.supervisor.name).toBe('Gloria')
    const withApproval = signed(s, { ...voidItem, authorization_id: a.authorizationId })

    const v = m.access.verify(connection, withApproval, null)
    expect(v).toEqual({
      ok: true,
      authorizedById: m.people.manager.userId,
      authorizationId: a.authorizationId,
    })
    if (v.ok) m.access.recordUse(withApproval, v)
    expect(m.access.verify(connection, withApproval, null)).toEqual({
      ok: false,
      reason: 'invalid_authorization',
    })
    // The waiter's session stays open.
    expect(m.access.closeSession(connection, s)).toEqual({ ok: true })
  })

  it('the approval does not work for another event, another order, another action or after 2 minutes', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const s = m.signIn(connection, 'waiter')
    const voidItem = m.event(connection, s, 'ItemVoided', {}, { reason: 'x' })
    const a = m.access.authorize(connection, {
      ...s,
      pin: m.people.manager.pin,
      action: 'void_sent_item',
      aggregateId: voidItem.aggregate_id,
      eventId: voidItem.id,
      fingerprint: authorizableFingerprint(voidItem),
    })
    if (!a.ok) throw new Error(a.message)
    // Each change is signed again, as a tampered device would do.
    const withIt = (changes: object) =>
      m.access.verify(
        connection,
        signed(s, { ...voidItem, authorization_id: a.authorizationId, ...changes }),
        null,
      )

    expect(withIt({ id: newId() })).toMatchObject({ reason: 'invalid_authorization' })
    expect(withIt({ aggregate_id: newId() })).toMatchObject({ reason: 'invalid_authorization' })
    expect(withIt({ type: 'OrderCanceled' })).toMatchObject({ reason: 'invalid_authorization' })
    const late = new Date(Date.parse(m.clock()) + AUTHORIZATION_TTL_MS + 1).toISOString()
    expect(withIt({ hub_estimated_time: late })).toMatchObject({ reason: 'invalid_authorization' })
    expect(withIt({})).toMatchObject({ ok: true })
  })

  it('nobody authorizes themselves, and a PIN without the permission does not authorize', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const s = m.signIn(connection, 'manager')
    const data = {
      ...s,
      // The cashier can authorize voids (ADR-013), not comps.
      action: 'comp',
      aggregateId: newId(),
      eventId: newId(),
      fingerprint: 'a'.repeat(64),
    }

    expect(m.access.authorize(connection, { ...data, pin: m.people.manager.pin })).toMatchObject({
      code: 'self_authorization',
    })
    expect(m.access.authorize(connection, { ...data, pin: m.people.cashier.pin })).toMatchObject({
      code: 'wrong_pin',
    })
    expect(m.access.authorize(connection, { ...data, pin: m.people.admin.pin })).toMatchObject({
      ok: true,
    })
    expect(m.access.authorize(connection, { ...data, pin: m.people.admin.pin })).toMatchObject({
      code: 'already_authorized',
    })
  })

  it('payments and closes only from the register, even if the user is a cashier (not from the kitchen screen)', () => {
    const m = setupAccess()
    // A phone becomes a register when the cashier signs in with a password (ADR-013); a kitchen
    // screen does not.
    const phone = m.pair('kds').connection
    const register = m.pair('register').connection
    const onPhone = m.signIn(phone, 'cashier')
    const atRegister = m.signIn(register, 'cashier')

    expect(m.access.verify(phone, m.event(phone, onPhone, 'OrderClosed', {}), null)).toEqual({
      ok: false,
      reason: 'register_only',
    })
    expect(
      m.access.verify(register, m.event(register, atRegister, 'OrderClosed', {}), null),
    ).toMatchObject({
      ok: true,
    })
  })

  it('the hub does not trust what the event says: session, user and device must match', () => {
    const m = setupAccess()
    const a = m.pair().connection
    const b = m.pair().connection
    const sa = m.signIn(a, 'waiter')
    const ev = m.event(a, sa, 'OrderOpened', open)

    expect(m.access.verify(a, { ...ev, session_id: null }, null)).toMatchObject({
      reason: 'no_session',
    })
    expect(m.access.verify(b, ev, null)).toMatchObject({ reason: 'foreign_session' })
    expect(m.access.verify(a, { ...ev, user_id: m.people.manager.userId }, null)).toMatchObject({
      reason: 'user_mismatch',
    })
    expect(m.access.verify(a, { ...ev, session_id: newId() }, null)).toEqual({
      ok: false,
      reason: 'unknown_session',
      quarantine: true,
    })
    expect(
      m.access.verify(a, signed(sa, { ...ev, type: 'RescueOrderCreated' } as typeof ev), null),
    ).toMatchObject({ reason: 'hub_only' })
  })

  it("the session is judged at the event's time: what was done offline before the close is valid", () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const s = m.signIn(connection, 'waiter')
    const before = m.event(connection, s, 'OrderOpened', open)
    m.advance(40 * 60_000)
    m.access.closeSession(connection, s)
    m.advance(5 * 60_000)
    const after = m.event(connection, s, 'OrderOpened', open)

    expect(m.access.verify(connection, before, null)).toMatchObject({ ok: true })
    expect(m.access.verify(connection, after, null)).toMatchObject({ reason: 'session_closed' })
  })

  it('the permission is evaluated with the role on receipt: an archived user no longer creates anything', () => {
    const m = setupAccess()
    const { connection } = m.pair()
    const s = m.signIn(connection, 'waiter')
    const ev = m.event(connection, s, 'OrderOpened', open)
    m.access.archiveUser(m.people.waiter.userId)

    expect(m.access.verify(connection, ev, null)).toMatchObject({ reason: 'user_inactive' })
  })
})

describe('revoking a device', () => {
  it('only the admin, not the device itself, and it notifies the floor', () => {
    const m = setupAccess()
    const register = m.pair('register').connection
    const phone = m.pair('waiter')
    const manager = m.signIn(register, 'manager')
    const data = { deviceId: phone.connection.deviceId }

    expect(m.access.revokeDevice(register, { ...manager, ...data })).toMatchObject({
      code: 'no_permission',
    })
    const admin = m.signIn(register, 'admin')
    expect(
      m.access.revokeDevice(register, { ...admin, deviceId: register.deviceId }),
    ).toMatchObject({ code: 'invalid_data' })
    const r = m.access.revokeDevice(register, { ...admin, ...data })

    expect(r).toEqual({ ok: true, revokedAt: m.clock() })
    expect(m.revokedIds).toEqual([phone.connection.deviceId])
    expect(m.access.authenticate(phone.token)?.revokedAt).toBe(m.clock())
    expect(
      m.access.startSession(m.access.authenticate(phone.token) as never, m.people.waiter.pin),
    ).toMatchObject({ code: 'revoked_device' })
  })
})
