import { newId } from '@pos/core'
import { FloorSync, type HubMessage } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import {
  add,
  authorizeEvent,
  type HubSetup,
  OPEN_ORDER,
  orderWithSentItem,
  setupHub,
  voidData,
} from './hub-setup'
import { SYSTEM, updateVersioned } from './records'
import { AUTHORIZATION_TTL_MS, AUTHORIZED_DELIVERY_MS } from './service'

// Races between the supervisor approval, the session, the device clock and revocation, with the
// full sync hub (docs/SYNC.md#seguridad).

interface ApprovalOptions {
  who?: 'manager' | 'admin'
  /** Event time relative to when the approval was issued (the device sets it on request). */
  offset?: number
  /** Item being voided (by default, the one that does exist). */
  itemId?: string
}

/** The waiter has a sent item and asks the manager to authorize voiding it. */
function withApproval(m: HubSetup, o: ApprovalOptions = {}) {
  const base = orderWithSentItem(m)
  // A while after the session opens, so events "before" the approval can be tested.
  m.advance(5 * 60_000)
  const issued = m.clock()
  const time = add(issued, o.offset ?? 0)
  const withoutApproval = m.event(
    base.connection,
    base.session,
    'ItemVoided',
    voidData(o.itemId ?? base.itemId),
    {
      aggregate_id: base.order,
      reason: 'El cliente cambió de idea',
      base_sequence: 3,
      device_time: time,
      hub_estimated_time: time,
    },
  )
  const { approval, event } = authorizeEvent(
    m,
    base.connection,
    base.session,
    m.people[o.who ?? 'manager'].pin,
    withoutApproval,
  )
  /** The authorized event, with tweaks the device should not be able to make (and signed again). */
  const voidItem = (extras: object = {}) => m.signed(base.session, { ...event, ...extras })
  return {
    ...base,
    event,
    eventId: event.id,
    authorizationId: approval.authorizationId,
    issued,
    voidItem,
  }
}

const approval = (m: HubSetup) =>
  m.db.prepare('SELECT supervisor_id, used_at FROM authorizations').get()
const events = (m: HubSetup) => Number(m.db.prepare('SELECT count(*) AS n FROM events').get()?.n)
const changeRole = (m: HubSetup, userId: string, roleId: string) =>
  updateVersioned(m.db, 'users', m.restaurantId, userId, { role_id: roleId }, SYSTEM, m.clock())

describe('one approval, one event', () => {
  it('two events with the same approval in one batch: only its own passes', () => {
    const m = setupHub()
    const c = withApproval(m)
    const other = c.voidItem({ id: newId() })
    const r = m.hub.receiveBatch(c.connection, [c.voidItem(), other])

    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'rejected'])
    expect(r.results[1]).toMatchObject({ reason: 'invalid_authorization' })
    expect(approval(m)).toMatchObject({ used_at: m.clock() })
  })

  it('an intruder going first with an approval not meant for it does not spend it: the legitimate one gets in in another batch', () => {
    const m = setupHub()
    const c = withApproval(m)
    const other = c.voidItem({ id: newId() })

    // In the same batch, the rejection drags along the next ones of the same order (they depend
    // on it).
    const combined = m.hub.receiveBatch(c.connection, [other, c.voidItem()])
    expect(combined.results.map((x) => x.status)).toEqual(['rejected', 'rejected'])
    expect(approval(m)).toMatchObject({ used_at: null })

    // But the approval still belongs to its event: in a separate batch, the legitimate one passes.
    const separate = setupHub()
    const d = withApproval(separate)
    separate.hub.receiveBatch(d.connection, [d.voidItem({ id: newId() })])
    expect(separate.hub.receiveBatch(d.connection, [d.voidItem()]).results[0]?.status).toBe(
      'confirmed',
    )
  })

  it('the same event twice in the batch is stored once and both get the same response', () => {
    const m = setupHub()
    const c = withApproval(m)
    const before = events(m)
    const r = m.hub.receiveBatch(c.connection, [c.voidItem(), c.voidItem()])

    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(r.results[0]).toEqual(r.results[1])
    expect(events(m)).toBe(before + 1)
  })

  it('the same id with other content does not take advantage of the already used approval', () => {
    const m = setupHub()
    const c = withApproval(m)
    m.hub.receiveBatch(c.connection, [c.voidItem()])
    const other = m.hub.receiveBatch(c.connection, [c.voidItem({ reason: 'Otro motivo' })])

    expect(other.results[0]).toMatchObject({ status: 'rejected', reason: 'duplicate_id' })
  })

  it('an event rejected by an order rule does not spend the approval', () => {
    const m = setupHub()
    // The item does not exist: the approval is valid for that content, but the rule rejects it.
    const c = withApproval(m, { itemId: newId() })
    const r = m.hub.receiveBatch(c.connection, [c.voidItem()])

    expect(r.results[0]?.status).toBe('rejected')
    expect(r.results[0]).not.toMatchObject({ reason: 'invalid_authorization' })
    expect(approval(m)).toMatchObject({ used_at: null })
    expect(events(m)).toBe(3)
  })

  it('an approval whose event is rejected by schema is not spent either', () => {
    const m = setupHub()
    const c = withApproval(m)
    const r = m.hub.receiveBatch(c.connection, [{ ...c.voidItem(), data: 'no es un objeto' }])

    expect(r.results[0]?.status).toBe('rejected')
    expect(approval(m)).toMatchObject({ used_at: null })
  })

  it('the approval is for that exact content: any change invalidates it and does not spend it', () => {
    const m = setupHub()
    const c = withApproval(m)
    const changes: Record<string, object> = {
      anotherOrder: { aggregate_id: newId() },
      otherQuantity: { data: { ...voidData(c.itemId), quantity: 2 } },
      otherItem: { data: { ...voidData(newId()) } },
      alreadyPrepared: { data: { ...voidData(c.itemId), already_prepared: true } },
      otherReason: { reason: 'Cambiado a escondidas' },
      otherTime: {
        device_time: add(c.issued, 1000),
        hub_estimated_time: add(c.issued, 1000),
      },
    }
    for (const [name, change] of Object.entries(changes)) {
      const r = m.hub.receiveBatch(c.connection, [c.voidItem(change)])
      expect(r.results[0], name).toMatchObject({ status: 'rejected' })
      expect(approval(m), name).toMatchObject({ used_at: null })
    }
    // The original event, after so many failed attempts with the same id, is still valid.
    expect(m.hub.receiveBatch(c.connection, [c.voidItem()]).results[0]?.status).toBe('confirmed')
  })

  it('what the device may adjust when resending (base_sequence) does not invalidate the approval', () => {
    const m = setupHub()
    const c = withApproval(m)
    expect(
      m.hub.receiveBatch(c.connection, [c.voidItem({ base_sequence: 0 })]).results[0]?.status,
    ).toBe('confirmed')
  })

  it('the approval belongs to the session that requested it: another session of the same user cannot use it', () => {
    const m = setupHub()
    const c = withApproval(m)
    m.advance(1000)
    const another = m.signIn(c.connection, 'waiter')
    const stolen = m.signed(another, { ...c.event, session_id: another.sessionId })

    expect(m.hub.receiveBatch(c.connection, [stolen]).results[0]).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
    // And the event from the original session, created before the switch, is still valid.
    expect(m.hub.receiveBatch(c.connection, [c.voidItem()]).results[0]?.status).toBe('confirmed')
  })

  it('an approval from one phone does not work on another device, even for the same user', () => {
    const m = setupHub()
    const c = withApproval(m)
    const other = m.pair('waiter', 'Otro celular').connection
    const s = m.signIn(other, 'waiter')
    const copy = m.signed(s, {
      ...c.event,
      session_id: s.sessionId,
      device_id: other.deviceId,
    })

    expect(m.hub.receiveBatch(other, [copy]).results[0]).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
  })
})

describe('the supervisor changes before the event arrives', () => {
  const approvalRejection = { status: 'rejected', reason: 'invalid_authorization' }

  it('if the supervisor is archived after authorizing, the approval is no longer valid', () => {
    const m = setupHub()
    const c = withApproval(m)
    m.access.archiveUser(m.people.manager.userId)

    const r = m.hub.receiveBatch(c.connection, [c.voidItem()])
    expect(r.results[0]).toMatchObject(approvalRejection)
    expect(m.hub.order(c.order)?.items[c.itemId]?.status).toBe('sent')
  })

  it('if the supervisor is moved to a role without the permission, it stops being valid', () => {
    const m = setupHub()
    const c = withApproval(m)
    changeRole(m, m.people.manager.userId, m.roles.waiter)

    expect(m.hub.receiveBatch(c.connection, [c.voidItem()]).results[0]).toMatchObject(
      approvalRejection,
    )
  })

  it('if the permission is removed from the supervisor role, it stops being valid', () => {
    const m = setupHub()
    const c = withApproval(m)
    m.db
      .prepare(
        "UPDATE role_permissions SET active = 0 WHERE role_id = ? AND permission = 'void_sent_item'",
      )
      .run(m.roles.manager)

    expect(m.hub.receiveBatch(c.connection, [c.voidItem()]).results[0]).toMatchObject(
      approvalRejection,
    )
  })

  it('if the whole supervisor role is archived, it stops being valid', () => {
    const m = setupHub()
    const c = withApproval(m)
    m.db.prepare('UPDATE roles SET active = 0 WHERE id = ?').run(m.roles.manager)

    expect(m.hub.receiveBatch(c.connection, [c.voidItem()]).results[0]).toMatchObject(
      approvalRejection,
    )
  })

  it('a supervisor who changed PIN is still the same supervisor: the approval is valid', () => {
    const m = setupHub()
    const c = withApproval(m)
    m.access.regeneratePin(m.people.manager.userId)

    expect(m.hub.receiveBatch(c.connection, [c.voidItem()]).results[0]).toMatchObject({
      status: 'confirmed',
      acceptance: { authorized_by_id: m.people.manager.userId },
    })
  })

  it('if the waiter already has the permission when the event arrives, the approval is not needed', () => {
    const m = setupHub()
    const c = withApproval(m)
    changeRole(m, m.people.waiter.userId, m.roles.manager)

    const r = m.hub.receiveBatch(c.connection, [c.voidItem()])
    expect(r.results[0]).toMatchObject({
      status: 'confirmed',
      acceptance: { authorized_by_id: null },
    })
    // The approval was not spent: it was not needed.
    expect(approval(m)).toMatchObject({ used_at: null })
  })

  describe('the event author loses the permission or is archived', () => {
    /** The manager voids an item offline; then the admin changes her situation. */
    function managerWithoutConnection() {
      const m = setupHub()
      const { connection } = m.pair('waiter')
      const session = m.signIn(connection, 'manager')
      const voidItem = (time: string) =>
        m.event(connection, session, 'ItemVoided', voidData(newId()), {
          reason: 'x',
          device_time: time,
          hub_estimated_time: time,
        })
      return { m, connection, session, voidItem }
    }

    it('what was done before the change goes to quarantine for someone to review; what came after, rejected', () => {
      const { m, connection, voidItem } = managerWithoutConnection()
      const before = voidItem(m.clock())
      m.advance(10 * 60_000)
      changeRole(m, m.people.manager.userId, m.roles.waiter)
      const change = m.clock()
      m.advance(10 * 60_000)
      const after = voidItem(add(change, 1000))

      const r = m.hub.receiveBatch(connection, [before, after])
      expect(r.results.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
      expect(r.results[1]).toMatchObject({ reason: 'no_permission' })
      expect(
        m.db.prepare('SELECT reason FROM quarantined_events WHERE event_id = ?').get(before.id)
          ?.reason,
      ).toBe('permissions_changed')
      expect(events(m)).toBe(0)
    })

    it('the edge: exactly at the instant of the change already counts as after', () => {
      const { m, connection, voidItem } = managerWithoutConnection()
      m.advance(10 * 60_000)
      changeRole(m, m.people.manager.userId, m.roles.waiter)
      const change = m.clock()

      const r = m.hub.receiveBatch(connection, [voidItem(add(change, -1)), voidItem(change)])
      expect(r.results.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
    })

    it('an archived user: what came before archiving is reviewed, what came after is rejected', () => {
      const { m, connection, voidItem } = managerWithoutConnection()
      const before = voidItem(m.clock())
      m.advance(10 * 60_000)
      m.access.archiveUser(m.people.manager.userId)
      const closeout = m.clock()
      const rightAfter = voidItem(add(closeout, 1000))
      const muchLater = voidItem(add(closeout, 61_000))

      const r = m.hub.receiveBatch(connection, [before, rightAfter, muchLater])
      expect(r.results.map((x) => x.status)).toEqual(['quarantine', 'rejected', 'rejected'])
      expect(r.results.slice(1)).toMatchObject([
        { reason: 'user_inactive' },
        { reason: 'session_closed' },
      ])
    })

    it('another user being changed does not cast doubt on this one: without permission it is still a rejection', () => {
      const m = setupHub()
      const { connection } = m.pair('waiter')
      const session = m.signIn(connection, 'waiter')
      const before = m.event(connection, session, 'ItemVoided', voidData(newId()), {
        reason: 'x',
      })
      m.advance(10 * 60_000)
      changeRole(m, m.people.cashier.userId, m.roles.reports)

      expect(m.hub.receiveBatch(connection, [before]).results[0]).toMatchObject({
        status: 'rejected',
        reason: 'no_permission',
      })
    })
  })
})

describe('event that arrives late but was created in time', () => {
  it('offline: created 119 s after the approval and received half an hour later, it is valid', () => {
    const m = setupHub()
    const c = withApproval(m, { offset: 119_000 })
    m.advance(30 * 60_000)

    const r = m.hub.receiveBatch(c.connection, [c.voidItem()])
    expect(r.results[0]).toMatchObject({
      status: 'confirmed',
      acceptance: { authorized_by_id: m.people.manager.userId },
    })
  })

  it('the validity edges: -60 s and +120 s are valid; one millisecond more is not', () => {
    const cases: [number, 'confirmed' | 'rejected'][] = [
      [-60_001, 'rejected'],
      [-60_000, 'confirmed'],
      [0, 'confirmed'],
      [AUTHORIZATION_TTL_MS, 'confirmed'],
      [AUTHORIZATION_TTL_MS + 1, 'rejected'],
    ]
    for (const [offset, expected] of cases) {
      const m = setupHub()
      const c = withApproval(m, { offset })
      const r = m.hub.receiveBatch(c.connection, [c.voidItem()])
      expect(r.results[0]?.status, `desfase ${offset}`).toBe(expected)
      if (expected === 'rejected')
        expect(r.results[0]).toMatchObject({ reason: 'invalid_authorization' })
    }
  })

  it('an event timed long after the approval (clock ahead) does not stretch the validity', () => {
    const m = setupHub()
    const c = withApproval(m, { offset: 10 * 60_000 })

    expect(m.hub.receiveBatch(c.connection, [c.voidItem()]).results[0]).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
  })

  it('the approval is delivered to the hub within 12 hours at most', () => {
    const cases: [number, 'confirmed' | 'rejected'][] = [
      [AUTHORIZED_DELIVERY_MS - 1, 'confirmed'],
      [AUTHORIZED_DELIVERY_MS, 'confirmed'],
      [AUTHORIZED_DELIVERY_MS + 1, 'rejected'],
    ]
    for (const [delay, expected] of cases) {
      const m = setupHub()
      const c = withApproval(m)
      m.advance(delay)
      const r = m.hub.receiveBatch(c.connection, [c.voidItem()])
      expect(r.results[0]?.status, `espera ${delay}`).toBe(expected)
    }
  })
})

describe('sessions and clock', () => {
  it('the edges of the 60 s tolerance at session start', () => {
    const cases: [number, 'confirmed' | 'rejected'][] = [
      [-60_001, 'rejected'],
      [-60_000, 'confirmed'],
      [0, 'confirmed'],
    ]
    for (const [offset, expected] of cases) {
      const m = setupHub()
      m.advance(60 * 60_000)
      const { connection } = m.pair('waiter')
      const session = m.signIn(connection, 'waiter')
      const time = add(m.clock(), offset)
      const ev = m.event(connection, session, 'OrderOpened', OPEN_ORDER, {
        device_time: time,
        hub_estimated_time: time,
      })
      const r = m.hub.receiveBatch(connection, [ev])
      expect(r.results[0]?.status, `desfase ${offset}`).toBe(expected)
      if (expected === 'rejected') expect(r.results[0]).toMatchObject({ reason: 'session_closed' })
    }
  })

  it('the edges of the 60 s tolerance at session close', () => {
    const cases: [number, 'confirmed' | 'rejected'][] = [
      [0, 'confirmed'],
      [60_000, 'confirmed'],
      [60_001, 'rejected'],
    ]
    for (const [offset, expected] of cases) {
      const m = setupHub()
      const { connection } = m.pair('waiter')
      const session = m.signIn(connection, 'waiter')
      m.advance(30 * 60_000)
      const closeout = m.clock()
      expect(m.access.closeSession(connection, session)).toEqual({ ok: true })
      const time = add(closeout, offset)
      const ev = m.event(connection, session, 'OrderOpened', OPEN_ORDER, {
        device_time: time,
        hub_estimated_time: time,
      })
      // Received much later: what counts is the event time.
      m.advance(60 * 60_000)
      const r = m.hub.receiveBatch(connection, [ev])
      expect(r.results[0]?.status, `desfase ${offset}`).toBe(expected)
    }
  })

  it('with the session open, an event with a future time is accepted but the hub uses its own time', () => {
    const m = setupHub()
    const { connection } = m.pair('waiter')
    const session = m.signIn(connection, 'waiter')
    const futureTime = add(m.clock(), 3 * 60 * 60_000)
    const ev = m.event(connection, session, 'OrderOpened', OPEN_ORDER, {
      device_time: futureTime,
      hub_estimated_time: futureTime,
    })

    const r = m.hub.receiveBatch(connection, [ev])
    expect(r.results[0]?.status).toBe('confirmed')
    const row = m.db.prepare('SELECT received_at, business_day FROM events').get()
    expect(row?.received_at).toBe(m.clock())
    // 20:00 UTC = 15:00 in Bogotá: the business day is today's, not the fast clock's 23:00.
    expect(row?.business_day).toBe('2026-10-24')
  })

  it('with the session closed, the future time cannot be used to sneak in after the close', () => {
    const m = setupHub()
    const { connection } = m.pair('waiter')
    const session = m.signIn(connection, 'waiter')
    m.advance(10 * 60_000)
    m.access.closeSession(connection, session)
    const futureTime = add(m.clock(), 10 * 60_000)
    const ev = m.event(connection, session, 'OrderOpened', OPEN_ORDER, {
      device_time: futureTime,
      hub_estimated_time: futureTime,
    })

    expect(m.hub.receiveBatch(connection, [ev]).results[0]).toMatchObject({
      status: 'rejected',
      reason: 'session_closed',
    })
  })

  it('a time that is not a time is rejected by schema, it does not sneak through the comparison', () => {
    const m = setupHub()
    const { connection } = m.pair('waiter')
    const session = m.signIn(connection, 'waiter')
    for (const garbage of ['mañana', '', '2026-13-45T99:99:99Z', 'NaN', '0']) {
      const ev = m.event(connection, session, 'OrderOpened', OPEN_ORDER, {
        hub_estimated_time: garbage,
      })
      const r = m.hub.receiveBatch(connection, [ev])
      expect(r.results[0]?.status, garbage).toBe('rejected')
    }
    expect(events(m)).toBe(0)
  })

  it('user switch on the device: what the first one created before is valid, what was created after is not', () => {
    const m = setupHub()
    const { connection } = m.pair('waiter')
    const ana = m.signIn(connection, 'waiter')
    const before = m.event(connection, ana, 'OrderOpened', OPEN_ORDER)
    m.advance(10 * 60_000)
    m.signIn(connection, 'waiter2')
    m.advance(5 * 60_000)
    const after = m.event(connection, ana, 'OrderOpened', OPEN_ORDER)

    const r = m.hub.receiveBatch(connection, [before, after])
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'rejected'])
    expect(r.results[1]).toMatchObject({ reason: 'session_closed' })
  })

  it('receiving events counts as session use, without going past the hub time or going back', () => {
    const m = setupHub()
    const { connection } = m.pair('waiter')
    const session = m.signIn(connection, 'waiter')
    const latest = () =>
      m.db.prepare('SELECT last_used FROM sessions WHERE id = ?').get(session.sessionId)?.last_used

    m.advance(10 * 60_000)
    const recent = m.event(connection, session, 'OrderOpened', OPEN_ORDER)
    m.hub.receiveBatch(connection, [recent])
    expect(latest()).toBe(m.clock())

    // An old event arriving later does not move the last use back.
    const oldOne = add(m.clock(), -5 * 60_000)
    m.advance(1000)
    m.hub.receiveBatch(connection, [
      m.event(connection, session, 'OrderOpened', OPEN_ORDER, {
        device_time: oldOne,
        hub_estimated_time: oldOne,
      }),
    ])
    expect(latest()).toBe(add(m.clock(), -1000))

    // One with a future time does not move it beyond the hub clock.
    const futureTime = add(m.clock(), 30_000)
    m.hub.receiveBatch(connection, [
      m.event(connection, session, 'OrderOpened', OPEN_ORDER, {
        device_time: futureTime,
        hub_estimated_time: futureTime,
      }),
    ])
    expect(latest()).toBe(m.clock())
  })

  it('the session secret, not its id, is what allows requesting an approval', () => {
    const m = setupHub()
    const { connection, session } = orderWithSentItem(m)
    const r = m.access.authorize(connection, {
      sessionId: session.sessionId,
      secret: 'x'.repeat(43),
      pin: m.people.manager.pin,
      action: 'void_sent_item',
      aggregateId: newId(),
      eventId: newId(),
      fingerprint: '0'.repeat(64),
    })
    expect(r).toMatchObject({ ok: false, code: 'invalid_session' })
    expect(m.db.prepare('SELECT count(*) AS n FROM authorizations').get()?.n).toBe(0)
  })
})

describe('event signatures', () => {
  function inSession() {
    const m = setupHub()
    const { connection } = m.pair('waiter')
    const session = m.signIn(connection, 'waiter')
    return { m, connection, session }
  }

  it('without a signature, or with a signature not from this session, the event is rejected', () => {
    const { m, connection, session } = inSession()
    const another = m.signIn(m.pair('waiter', 'Otro').connection, 'waiter2')
    const ev = m.event(connection, session, 'OrderOpened', OPEN_ORDER)
    const { signature: _signature, ...unsigned } = ev
    const cases = {
      unsigned,
      foreignSignature: m.signed(another, ev),
      zeroSignature: { ...ev, signature: '0'.repeat(64) },
    }
    for (const [name, badCase] of Object.entries(cases)) {
      const r = m.hub.receiveBatch(connection, [{ ...badCase, id: newId() }])
      expect(r.results[0], name).toMatchObject({
        status: 'rejected',
        reason: 'invalid_signature',
      })
    }
    expect(events(m)).toBe(0)
  })

  it('changing any field after signing invalidates the signature', () => {
    const { m, connection, session } = inSession()
    const ev = m.event(connection, session, 'OrderOpened', OPEN_ORDER)
    const changes: Record<string, object> = {
      data: { data: { ...OPEN_ORDER, guests: 9 } },
      time: { hub_estimated_time: add(m.clock(), 1000) },
      reason: { reason: 'other' },
      aggregate: { aggregate_id: newId() },
    }
    for (const [name, change] of Object.entries(changes)) {
      const r = m.hub.receiveBatch(connection, [{ ...ev, id: newId(), ...change }])
      expect(r.results[0], name).toMatchObject({ reason: 'invalid_signature' })
    }
  })

  it('the event id is inside the signature: the signature cannot be reused with another id', () => {
    const { m, connection, session } = inSession()
    const ev = m.event(connection, session, 'OrderOpened', OPEN_ORDER)
    expect(m.hub.receiveBatch(connection, [{ ...ev, id: newId() }]).results[0]).toMatchObject({
      reason: 'invalid_signature',
    })
  })

  it('session and user are checked before the signature', () => {
    const { m, connection, session } = inSession()
    const ev = m.event(connection, session, 'OrderOpened', OPEN_ORDER)
    const other = m.event(connection, session, 'OrderOpened', OPEN_ORDER, {
      user_id: m.people.manager.userId,
    })

    expect(m.access.verify(connection, { ...ev, session_id: newId() }, null)).toMatchObject({
      reason: 'unknown_session',
      quarantine: true,
    })
    expect(m.access.verify(connection, other, null)).toMatchObject({ reason: 'user_mismatch' })
  })

  it('base_sequence is not signed: the device lowers it to 0 when resending to a restored hub', () => {
    const { m, connection, session } = inSession()
    const ev = m.event(connection, session, 'OrderOpened', OPEN_ORDER, { base_sequence: 7 })
    const r = m.hub.receiveBatch(connection, [{ ...ev, base_sequence: 0 }])

    expect(r.results[0]?.status).toBe('confirmed')
  })

  it('the signature is not stored with the event', () => {
    const { m, connection, session } = inSession()
    const ev = m.event(connection, session, 'OrderOpened', OPEN_ORDER)
    m.hub.receiveBatch(connection, [ev])

    const saved = JSON.stringify(m.db.prepare('SELECT * FROM events').get())
    expect(saved).not.toContain(String(ev.signature))
  })
})

describe('the permission depends on the content and on the order state', () => {
  const extra = (price: number) => ({
    modifier_id: newId(),
    name: 'Extra',
    extra_price: price,
  })

  function withItemWithExtra() {
    const m = setupHub()
    const base = orderWithSentItem(m, [extra(3000)])
    const patch = (modifiers: object[], extras: object = {}) =>
      m.event(
        base.connection,
        base.session,
        'ItemModifiedAfterSend',
        { item_id: base.itemId, ticket_id: base.ticketId, modifiers },
        { aggregate_id: base.order, base_sequence: 3, ...extras },
      )
    return { m, base, patch }
  }

  it('making a sent item cheaper is a partial void: the waiter cannot, not even by removing all extras', () => {
    const { m, base, patch } = withItemWithExtra()
    for (const modifiers of [[], [extra(1000)], [extra(2999)]]) {
      const r = m.hub.receiveBatch(base.connection, [patch(modifiers, { id: newId() })])
      expect(r.results[0], JSON.stringify(modifiers.map((x) => x.extra_price))).toMatchObject({
        status: 'rejected',
        reason: 'no_permission',
      })
    }
  })

  it('swapping for something equal or more expensive, or only the notes, can be done by anyone with «take_order»', () => {
    const { m, base, patch } = withItemWithExtra()
    const notes = m.event(
      base.connection,
      base.session,
      'ItemModifiedAfterSend',
      { item_id: base.itemId, ticket_id: base.ticketId, notes: 'sin hielo' },
      { aggregate_id: base.order, base_sequence: 3 },
    )
    const r = m.hub.receiveBatch(base.connection, [
      patch([extra(3000)]),
      patch([extra(8000)], { base_sequence: 4 }),
      { ...notes, base_sequence: 5 },
    ])
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
  })

  it('with a «void_sent_item» approval it can be made cheaper, and the supervisor is recorded', () => {
    const { m, base, patch } = withItemWithExtra()
    const { event } = authorizeEvent(
      m,
      base.connection,
      base.session,
      m.people.manager.pin,
      patch([]),
    )

    expect(m.hub.receiveBatch(base.connection, [event]).results[0]).toMatchObject({
      status: 'confirmed',
      acceptance: { authorized_by_id: m.people.manager.userId },
    })
  })

  it('a «take_order» approval is not enough to make it cheaper', () => {
    const { m, base, patch } = withItemWithExtra()
    // The manager has both permissions; the approval is issued only for the weaker one.
    const { event } = authorizeEvent(
      m,
      base.connection,
      base.session,
      m.people.manager.pin,
      patch([]),
      'take_order',
    )

    expect(m.hub.receiveBatch(base.connection, [event]).results[0]).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
  })
})

describe('revoking a device with pending work', () => {
  /** A phone connected to the floor, with its session open, and a register with the admin. */
  function withFloor() {
    const m = setupHub()
    const floor = new FloorSync(m.hub, m.access.authenticate)
    const phone = m.pair('waiter')
    const session = m.signIn(phone.connection, 'waiter')
    const register = m.pair('register').connection
    const admin = m.signIn(register, 'admin')
    const received: HubMessage[] = []
    const link = floor.connect((x) => received.push(x))
    link.receive({
      type: 'hello',
      token: phone.token,
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })
    const revoke = () => {
      const r = m.access.revokeDevice(register, {
        ...admin,
        deviceId: phone.connection.deviceId,
      })
      if (!r.ok) throw new Error(r.message)
      floor.revoke(phone.connection.deviceId, r.revokedAt)
      return r.revokedAt
    }
    const results = () => received.flatMap((x) => (x.type === 'result' ? x.results : []))
    return { m, floor, phone, session, register, admin, link, received, revoke, results }
  }

  const open = (c: ReturnType<typeof withFloor>, time: string) =>
    c.m.event(c.phone.connection, c.session, 'OrderOpened', OPEN_ORDER, {
      device_time: time,
      hub_estimated_time: time,
    })

  it('revoking between two batches: the first one gets in, the second does not', () => {
    const c = withFloor()
    c.link.receive({
      type: 'push',
      batch_id: 'l1',
      events: [open(c, c.m.clock())],
    })
    c.m.advance(1000)
    c.revoke()
    c.m.advance(1000)
    c.link.receive({
      type: 'push',
      batch_id: 'l2',
      events: [open(c, c.m.clock())],
    })

    expect(c.results().map((x) => x.status)).toEqual(['confirmed', 'rejected'])
    expect(events(c.m)).toBe(1)
  })

  it('a batch created before the revocation but received after goes to quarantine, it is neither lost nor accepted', () => {
    const c = withFloor()
    const before = open(c, c.m.clock())
    c.m.advance(5000)
    const revokedAt = c.revoke()
    c.link.receive({ type: 'push', batch_id: 'l1', events: [before] })

    expect(c.results().map((x) => x.status)).toEqual(['quarantine'])
    expect(events(c.m)).toBe(0)
    expect(
      c.m.db.prepare('SELECT reason FROM quarantined_events WHERE event_id = ?').get(before.id)
        ?.reason,
    ).toBe('revoked_device')
    expect(revokedAt).toBe(c.m.clock())
  })

  it('the edge: an event with the exact time of the revocation no longer counts as before', () => {
    const c = withFloor()
    c.m.advance(5000)
    const revokedAt = c.revoke()
    c.link.receive({
      type: 'push',
      batch_id: 'l1',
      events: [open(c, add(revokedAt, -1)), open(c, revokedAt), open(c, add(revokedAt, 1))],
    })

    expect(c.results().map((x) => x.status)).toEqual(['quarantine', 'rejected', 'rejected'])
  })

  it('a mixed batch from a revoked device: each event goes its own way and the batch is not cut', () => {
    const c = withFloor()
    const a = open(c, c.m.clock())
    c.m.advance(5000)
    c.revoke()
    c.m.advance(5000)
    const b = open(c, c.m.clock())
    c.link.receive({ type: 'push', batch_id: 'l1', events: [a, b, a] })

    // The third repeats the first: same response.
    expect(c.results().map((x) => x.status)).toEqual(['quarantine', 'rejected', 'quarantine'])
  })

  it('an approval requested before the revocation is not spent by what stays in quarantine', () => {
    const c = withFloor()
    const withoutApproval = c.m.event(
      c.phone.connection,
      c.session,
      'ItemVoided',
      voidData(newId()),
      { reason: 'x' },
    )
    const { event } = authorizeEvent(
      c.m,
      c.phone.connection,
      c.session,
      c.m.people.manager.pin,
      withoutApproval,
    )
    c.m.advance(10_000)
    c.revoke()
    c.link.receive({ type: 'push', batch_id: 'l1', events: [event] })

    expect(c.results().map((x) => x.status)).toEqual(['quarantine'])
    expect(approval(c.m)).toMatchObject({ used_at: null })
    expect(events(c.m)).toBe(0)
  })

  it('revoking closes the device sessions: even if an old connection does not find out, it cannot request approvals', () => {
    const c = withFloor()
    const oldConnection = c.phone.connection // still believes it is not revoked
    c.revoke()

    expect(
      c.m.access.authorize(oldConnection, {
        ...c.session,
        pin: c.m.people.manager.pin,
        action: 'void_sent_item',
        aggregateId: newId(),
        eventId: newId(),
        fingerprint: '0'.repeat(64),
      }),
    ).toMatchObject({ ok: false, code: 'invalid_session' })
    expect(c.m.access.closeSession(oldConnection, c.session)).toMatchObject({ ok: false })
    const upToDate = c.m.access.authenticate(c.phone.token)
    expect(upToDate?.revokedAt).toBe(c.m.clock())
    expect(c.m.access.startSession(upToDate as never, c.m.people.waiter.pin)).toMatchObject({
      code: 'revoked_device',
    })
  })

  it('a revoked device does not approve pairings even with the admin PIN', () => {
    const c = withFloor()
    c.revoke()
    const upToDate = c.m.access.authenticate(c.phone.token) as never

    expect(
      c.m.access.createPairing(
        { pin: c.m.people.admin.pin, name: 'Intruso', type: 'register' },
        upToDate,
      ),
    ).toMatchObject({ ok: false, code: 'revoked_device' })
  })

  it('revoking twice does not change the date or alert twice', () => {
    const c = withFloor()
    const first = c.revoke()
    c.m.advance(60_000)
    const r2 = c.m.access.revokeDevice(c.register, {
      ...c.admin,
      deviceId: c.phone.connection.deviceId,
    })

    expect(r2).toEqual({ ok: true, revokedAt: first })
    expect(c.m.revokedIds).toEqual([c.phone.connection.deviceId])
  })

  it('a device that does not exist cannot be removed, nor with the id of something else', () => {
    const c = withFloor()
    for (const id of [newId(), '', c.m.restaurantId, c.m.people.waiter.userId])
      expect(c.m.access.revokeDevice(c.register, { ...c.admin, deviceId: id }), id).toMatchObject({
        ok: false,
        code: 'invalid_data',
      })
    expect(c.m.revokedIds).toEqual([])
  })

  it('the revocation sequence stays on the device, with who removed it', () => {
    const c = withFloor()
    orderWithSentItem(c.m)
    c.revoke()
    const row = c.m.db
      .prepare(
        'SELECT revoked_at, revocation_sequence, user_id, device_id FROM devices WHERE id = ?',
      )
      .get(c.phone.connection.deviceId)

    expect(row).toEqual({
      revoked_at: c.m.clock(),
      revocation_sequence: 3,
      user_id: c.m.people.admin.userId,
      device_id: c.register.deviceId,
    })
  })

  it('after 500 quarantined events from a revoked device, the following ones are rejected', () => {
    const c = withFloor()
    const oldEvents = Array.from({ length: 501 }, () => open(c, c.m.clock()))
    c.m.advance(5000)
    c.revoke()
    for (let i = 0; i < oldEvents.length; i += 100)
      c.link.receive({
        type: 'push',
        batch_id: `l${i}`,
        events: oldEvents.slice(i, i + 100),
      })

    const statuses = c.results().map((x) => x.status)
    expect(statuses.filter((e) => e === 'quarantine')).toHaveLength(500)
    expect(statuses.at(-1)).toBe('rejected')
  })
})
