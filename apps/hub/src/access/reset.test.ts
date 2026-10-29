import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@pos/core'
import { type AccessControl, HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authorizeEvent, hubInDir, item, OPEN_ORDER, sign, voidData } from './hub-setup'
import { KEY_FILE } from './secrets'
import type { AccessService } from './service'

// The hub crashes or restarts with the same data folder (database + PIN key):
// docs/SYNC.md#fallas-y-qué-pasa and ADR-008.

type RunningHub = ReturnType<ReturnType<typeof hubInDir>['spinUp']>

/** What `ensureAdmin` returns when there is nothing new to show. */
const NO_CHANGE = { pin: null, user: null, password: null, alerts: [] }

describe('hub restarts and crashes', () => {
  let folder = ''
  let hubs: ReturnType<typeof hubInDir>
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'pos-restart-'))
    hubs = hubInDir(join(folder, 'data'))
  })
  afterEach(() => {
    hubs.shutDown()
    rmSync(folder, { recursive: true, force: true })
  })

  /** First startup: admin, a paired register device and its admin session. */
  function firstStartup() {
    const h = hubs.spinUp()
    const adminPin = h.admin.pin as string
    let firstOne: string | null = null
    const fresh = (type: 'waiter' | 'register', name: string) => {
      // The first device is approved without a device; the following ones, from that one.
      const approver = firstOne ? h.access.authenticate(firstOne) : null
      const c = h.access.createPairing({ pin: adminPin, name, type }, approver)
      if (!c.ok) throw new Error(c.message)
      const r = h.access.pair(c.code, '10.0.0.9')
      if (!r.ok) throw new Error(r.message)
      firstOne ??= r.token
      return {
        token: r.token,
        connection: h.access.authenticate(r.token) as NonNullable<
          ReturnType<AccessService['authenticate']>
        >,
      }
    }
    // The admin signs in with username and password (ADR-013); their PIN only authorizes.
    const credentials = {
      user: h.admin.user as string,
      password: h.admin.password as string,
    }
    return { h, adminPin, fresh, credentials }
  }

  const adminSession = (
    h: RunningHub,
    connection: Parameters<AccessService['startSession']>[0],
    credentials: { user: string; password: string },
  ) => {
    const r = h.access.signIn(credentials, connection, '10.0.0.9')
    if (!r.ok) throw new Error(r.message)
    return r
  }

  const session = (
    h: RunningHub,
    connection: Parameters<AccessService['startSession']>[0],
    pin: string,
  ) => {
    const r = h.access.startSession(connection, pin)
    if (!r.ok) throw new Error(r.message)
    return r
  }

  function event(
    _h: RunningHub,
    connection: { deviceId: string },
    s: { sessionId: string; secret: string; user: { id: string } },
    type: string,
    data: unknown,
    extras: object = {},
  ) {
    return sign(s, {
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: newId(),
      related: [],
      data,
      session_id: s.sessionId,
      user_id: s.user.id,
      device_id: connection.deviceId,
      authorization_id: null,
      reason: null,
      device_time: hubs.clock(),
      hub_estimated_time: hubs.clock(),
      base_sequence: 0,
      ...extras,
    } as never)
  }

  describe('with the same folder', () => {
    it('the key and the PINs still work, and no new admin is shown', () => {
      const { h, adminPin, fresh } = firstStartup()
      const waiter = h.access.createUser({ name: 'Ana', roleId: h.roles.waiter })
      const phone = fresh('waiter', 'Celular')
      expect(h.newKey).toBe(true)
      hubs.shutDown()

      const after = hubs.spinUp()
      expect(after.newKey).toBe(false)
      expect(after.admin).toEqual(NO_CHANGE)
      expect(after.restaurantId).toBe(h.restaurantId)
      // The device token, the waiter PIN and the admin PIN are just as valid.
      const connection = after.access.authenticate(phone.token)
      expect(connection).toMatchObject({
        deviceId: phone.connection.deviceId,
        revokedAt: null,
      })
      expect(session(after, connection as never, waiter.pin).user.name).toBe('Ana')
      const c = after.access.createPairing({ pin: adminPin, name: 'Otro', type: 'kds' }, connection)
      expect(c).toMatchObject({ ok: true })
    })

    it('a session opened before the restart is still valid, with its secret', () => {
      const { h, fresh } = firstStartup()
      const waiter = h.access.createUser({ name: 'Ana', roleId: h.roles.waiter })
      const { connection, token } = fresh('waiter', 'Celular')
      const s = session(h, connection, waiter.pin)
      const opened = event(h, connection, s, 'OrderOpened', OPEN_ORDER)
      hubs.shutDown()
      hubs.advance(30_000)

      const after = hubs.spinUp()
      const newOne = after.access.authenticate(token) as NonNullable<typeof connection>
      const r = after.hub.receiveBatch(newOne, [opened])
      expect(r.results[0]?.status).toBe('confirmed')
      expect(after.access.closeSession(newOne, s)).toEqual({ ok: true })
      expect(after.access.closeSession(newOne, { ...s, secret: 'other' })).toMatchObject({
        ok: false,
      })
    })

    it('a revoked device stays revoked after the restart', () => {
      const { h, adminPin, fresh, credentials } = firstStartup()
      const register = fresh('register', 'Caja')
      const phone = fresh('waiter', 'Celular')
      const admin = adminSession(h, register.connection, credentials)
      const r = h.access.revokeDevice(register.connection, {
        ...admin,
        deviceId: phone.connection.deviceId,
      })
      if (!r.ok) throw new Error(r.message)
      hubs.shutDown()

      const after = hubs.spinUp()
      expect(after.access.authenticate(phone.token)?.revokedAt).toBe(r.revokedAt)
      expect(
        after.access.startSession(after.access.authenticate(phone.token) as never, adminPin),
      ).toMatchObject({ code: 'revoked_device' })
    })

    it('an archived user stays archived: their PIN does not sign in after the restart', () => {
      const { h, fresh } = firstStartup()
      const luis = h.access.createUser({ name: 'Luis', roleId: h.roles.waiter })
      const phone = fresh('waiter', 'Celular')
      h.access.archiveUser(luis.userId)
      hubs.shutDown()

      const after = hubs.spinUp()
      expect(
        after.access.startSession(after.access.authenticate(phone.token) as never, luis.pin),
      ).toMatchObject({ code: 'wrong_pin' })
    })

    it('pending pairing codes are lost, and failure waits start from zero', () => {
      const { h, adminPin, fresh } = firstStartup()
      const ana = h.access.createUser({ name: 'Ana', roleId: h.roles.waiter })
      const phone = fresh('waiter', 'Celular')
      const c = h.access.createPairing({ pin: adminPin, name: 'X', type: 'kds' }, phone.connection)
      if (!c.ok) throw new Error(c.message)
      for (const pin of ['0001', '0002', '0003']) h.access.startSession(phone.connection, pin)
      expect(h.access.startSession(phone.connection, ana.pin)).toMatchObject({ code: 'wait' })
      hubs.shutDown()

      const after = hubs.spinUp()
      expect(after.access.pair(c.code, '10.0.0.1')).toMatchObject({
        code: 'invalid_code',
      })
      expect(after.access.startSession(phone.connection, ana.pin)).toMatchObject({ ok: true })
    })

    it('restarting several times does not duplicate the restaurant, roles or admin', () => {
      firstStartup()
      for (let i = 0; i < 4; i++) {
        hubs.shutDown()
        const h = hubs.spinUp()
        expect(h.admin).toEqual(NO_CHANGE)
      }
      const h = hubs.spinUp()
      const check = (t: string) => Number(h.db.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.n)
      expect([
        check('restaurants'),
        check('roles'),
        check('users'),
        check('user_credentials'),
      ]).toEqual([1, 4, 1, 1])
    })
  })

  describe('with the key deleted', () => {
    it('no stored PIN works; the admin gets a new one and an alert; devices stay paired', () => {
      const { h, adminPin, fresh, credentials } = firstStartup()
      const ana = h.access.createUser({ name: 'Ana', roleId: h.roles.waiter })
      const phone = fresh('waiter', 'Celular')
      const opened = session(h, phone.connection, ana.pin)
      hubs.shutDown()
      rmSync(join(folder, 'data', KEY_FILE))

      const after = hubs.spinUp()
      expect(after.newKey).toBe(true)
      expect(existsSync(join(folder, 'data', KEY_FILE))).toBe(true)
      expect(after.admin.pin).toMatch(/^\d{4}$/)
      expect(after.admin.alerts.join(' ')).toMatch(/clave de los PIN/)
      const connection = after.access.authenticate(phone.token) as NonNullable<
        typeof phone.connection
      >
      expect(connection.deviceId).toBe(phone.connection.deviceId)

      // The old PINs do not sign in; the new admin one does.
      hubs.advance(60_000)
      if (after.admin.pin !== adminPin)
        expect(after.access.startSession(connection, adminPin)).toMatchObject({
          code: 'wrong_pin',
        })
      hubs.advance(60_000)
      if (after.admin.pin !== ana.pin)
        expect(after.access.startSession(connection, ana.pin)).toMatchObject({
          code: 'wrong_pin',
        })
      // The password does not depend on the PIN key: the admin still signs in, and their new PIN
      // authorizes.
      hubs.advance(60_000)
      expect(after.admin.password).toBeNull()
      expect(after.access.signIn(credentials, connection, '10.0.0.9')).toMatchObject({
        ok: true,
        user: { name: 'Administrador' },
      })
      // The session Ana had open belongs to the device, not the key: it closed when the admin
      // signed in.
      expect(after.access.closeSession(connection, opened)).toMatchObject({ ok: false })
    })

    it('what a phone signed with the session from before the key was lost goes to quarantine: neither accepted nor lost', () => {
      const { h, fresh } = firstStartup()
      const ana = h.access.createUser({ name: 'Ana', roleId: h.roles.waiter })
      const phone = fresh('waiter', 'Celular')
      const s = session(h, phone.connection, ana.pin)
      const pending = event(h, phone.connection, s, 'OrderOpened', OPEN_ORDER)
      hubs.shutDown()
      rmSync(join(folder, 'data', KEY_FILE))
      hubs.advance(60_000)

      // Each session secret comes from the key: with another key, the signature no longer
      // matches. Since the session is from before the new key, the manager decides.
      const after = hubs.spinUp()
      const connection = after.access.authenticate(phone.token) as never
      const r = after.hub.receiveBatch(connection, [pending])
      expect(r.results[0]?.status).toBe('quarantine')
      expect(Number(after.db.prepare('SELECT count(*) AS n FROM events').get()?.n)).toBe(0)
    })

    it('with the new admin PIN each person PIN is regenerated, and the old one stops working', () => {
      const { h, fresh } = firstStartup()
      const ana = h.access.createUser({ name: 'Ana', roleId: h.roles.waiter })
      const register = fresh('register', 'Caja')
      hubs.shutDown()
      rmSync(join(folder, 'data', KEY_FILE))

      const after = hubs.spinUp()
      const newPin = after.access.regeneratePin(ana.userId)
      const c = after.access.createPairing(
        { pin: after.admin.pin as string, name: 'Cel', type: 'waiter' },
        after.access.authenticate(register.token),
      )
      if (!c.ok) throw new Error(c.message)
      const e = after.access.pair(c.code, 'ip')
      if (!e.ok) throw new Error(e.message)
      const connection = after.access.authenticate(e.token) as never
      expect(after.access.startSession(connection, newPin)).toMatchObject({
        ok: true,
        user: { name: 'Ana' },
      })
    })

    it('the new key stays in the folder: on restarting again the regenerated PINs work', () => {
      const { fresh } = firstStartup()
      const register = fresh('register', 'Caja')
      hubs.shutDown()
      rmSync(join(folder, 'data', KEY_FILE))
      const regenerated = hubs.spinUp()
      const pin = regenerated.admin.pin as string
      hubs.shutDown()

      const another = hubs.spinUp()
      expect(another.newKey).toBe(false)
      expect(another.admin).toEqual(NO_CHANGE)
      expect(
        another.access.createPairing(
          { pin, name: 'X', type: 'register' },
          another.access.authenticate(register.token),
        ),
      ).toMatchObject({
        ok: true,
      })
    })

    it('a new hub (empty folder) creates its admin without the lost-key alert', () => {
      const h = hubs.spinUp()
      expect(h.newKey).toBe(true)
      expect(h.admin.pin).toMatch(/^\d{4}$/)
      expect(h.admin.alerts).toEqual([])
    })

    it('if the key is deleted and the database too, it is a new hub and starts clean', () => {
      firstStartup()
      hubs.shutDown()
      rmSync(join(folder, 'data'), { recursive: true })

      const h = hubs.spinUp()
      expect(h.newKey).toBe(true)
      expect(h.admin.alerts).toEqual([])
      expect(Number(h.db.prepare('SELECT count(*) AS n FROM users').get()?.n)).toBe(1)
    })
  })

  describe('crash between authorizing and receiving the event', () => {
    /** The waiter has a sent item and the manager authorizes voiding it. */
    function withAuthorization() {
      const { h, fresh } = firstStartup()
      // By default, the cashier can authorize voids (ADR-013).
      const manager = h.access.createUser({ name: 'Gloria', roleId: h.roles.cashier })
      const ana = h.access.createUser({ name: 'Ana', roleId: h.roles.waiter })
      const { connection, token } = fresh('waiter', 'Celular')
      const s = session(h, connection, ana.pin)
      const order = newId()
      const it = item()
      const en = { aggregate_id: order }
      const batch = [
        event(h, connection, s, 'OrderOpened', OPEN_ORDER, en),
        event(h, connection, s, 'ItemAdded', it, { ...en, base_sequence: 1 }),
        event(
          h,
          connection,
          s,
          'ItemsSent',
          { tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }] },
          { ...en, base_sequence: 2 },
        ),
      ]
      expect(h.hub.receiveBatch(connection, batch).results.map((x) => x.status)).toEqual([
        'confirmed',
        'confirmed',
        'confirmed',
      ])
      const withoutApproval = event(h, connection, s, 'ItemVoided', voidData(it.item_id), {
        aggregate_id: order,
        reason: 'El cliente cambió de idea',
        base_sequence: 3,
      })
      const { approval, event: voidItem } = authorizeEvent(
        h,
        connection,
        s,
        manager.pin,
        withoutApproval as never,
      )
      return {
        h,
        token,
        voidItem,
        manager,
        order,
        itemId: it.item_id,
        authorizationId: approval.authorizationId,
      }
    }

    it('the hub shuts down after issuing the approval: when it comes back, the event arrives and is accepted', () => {
      const c = withAuthorization()
      hubs.shutDown()
      hubs.advance(90_000) // it takes a while to come back, but within the approval validity

      const after = hubs.spinUp()
      expect(after.db.prepare('SELECT supervisor_id, used_at FROM authorizations').get()).toEqual({
        supervisor_id: c.manager.userId,
        used_at: null,
      })
      const connection = after.access.authenticate(c.token) as never
      const r = after.hub.receiveBatch(connection, [c.voidItem])
      expect(r.results[0]).toMatchObject({
        status: 'confirmed',
        acceptance: { authorized_by_id: c.manager.userId },
      })
      expect(after.db.prepare('SELECT used_at FROM authorizations').get()?.used_at).toBe(
        hubs.clock(),
      )
    })

    it('if it comes back much later, the event is still valid by the time it was created, not when it arrived', () => {
      const c = withAuthorization()
      hubs.shutDown()
      hubs.advance(3 * 60 * 60_000)

      const after = hubs.spinUp()
      const connection = after.access.authenticate(c.token) as never
      expect(after.hub.receiveBatch(connection, [c.voidItem]).results[0]?.status).toBe('confirmed')
    })

    it('the approval is spent only once even if the hub restarts and the phone resends', () => {
      const c = withAuthorization()
      const connection = c.h.access.authenticate(c.token) as never
      const first = c.h.hub.receiveBatch(connection, [c.voidItem])
      hubs.shutDown()

      const after = hubs.spinUp()
      const connection2 = after.access.authenticate(c.token) as never
      const second = after.hub.receiveBatch(connection2, [c.voidItem])

      expect(second.results).toEqual(first.results)
      expect(
        Number(
          after.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'ItemVoided'").get()?.n,
        ),
      ).toBe(1)
    })

    it('the hub crashes while saving the authorized event: nothing is left half done and after restart the resend gets in', () => {
      const c = withAuthorization()
      // A store that "dies" while saving the event, like a power cut mid-write: from then on it
      // cannot even record a rejection, and the hub process ends.
      class StoreThatShutsDown extends SqliteStore {
        down = false
        override saveEvent(..._a: Parameters<SqliteStore['saveEvent']>): void {
          this.down = true
          throw new Error('the power went out')
        }
        override transaction<T>(job: () => T): T {
          if (this.down) throw new Error('the hub is down')
          return super.transaction(job)
        }
      }
      const configOf = (h: RunningHub) => ({
        restaurantId: h.restaurantId,
        timeZone: 'America/Bogota',
        businessDayStart: '06:00',
        instance: 'hub-1',
        clock: hubs.clock,
        access: h.access,
      })
      const check = (h: RunningHub) =>
        Number(h.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'ItemVoided'").get()?.n)
      const connection = c.h.access.authenticate(c.token) as never
      const dying = new HubSync(new StoreThatShutsDown(c.h.db, c.h.restaurantId), configOf(c.h))

      expect(() => dying.receiveBatch(connection, [c.voidItem])).toThrow(/hub is down/)
      expect(check(c.h)).toBe(0)
      expect(c.h.db.prepare('SELECT used_at FROM authorizations').get()?.used_at).toBeNull()

      hubs.shutDown()
      hubs.advance(20_000)
      const after = hubs.spinUp()
      const r = after.hub.receiveBatch(after.access.authenticate(c.token) as never, [c.voidItem])
      expect(r.results[0]).toMatchObject({
        status: 'confirmed',
        acceptance: { authorized_by_id: c.manager.userId },
      })
      expect(check(after)).toBe(1)
    })

    it('if it fails right when using the approval, the event and the approval stay as before', () => {
      const c = withAuthorization()
      let failing = true
      const crashes = (a: AccessService): AccessControl => ({
        verify: (connection, ev, order) => a.verify(connection, ev, order),
        recordUse: (ev, v) => {
          // The approval is spent before the transaction finishes...
          a.recordUse(ev, v)
          if (failing) throw new Error('the power went out')
        },
      })
      const hub = new HubSync(new SqliteStore(c.h.db, c.h.restaurantId), {
        restaurantId: c.h.restaurantId,
        timeZone: 'America/Bogota',
        businessDayStart: '06:00',
        instance: 'hub-1',
        clock: hubs.clock,
        access: crashes(c.h.access),
      })
      const connection = c.h.access.authenticate(c.token) as never
      const r = hub.receiveBatch(connection, [c.voidItem])

      // ...but the transaction is rolled back: neither event nor spent approval.
      expect(r.results[0]).toMatchObject({ status: 'rejected', reason: 'internal_error' })
      expect(
        Number(
          c.h.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'ItemVoided'").get()?.n,
        ),
      ).toBe(0)
      expect(c.h.db.prepare('SELECT used_at FROM authorizations').get()?.used_at).toBeNull()
      failing = false
    })
  })
})
