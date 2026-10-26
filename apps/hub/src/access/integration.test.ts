import { authorizableFingerprint, newId } from '@pos/core'
import { FloorSync, type HubMessage, HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { describe, expect, it } from 'vitest'
import { type AccessSetup, setupAccess, signed } from './setup'

// Task 0.7 criteria with the full hub (sync + access over the same database):
// a revoked device is rejected; a waiter cannot void without authorization, and every
// authorization records who gave it.

const item = () => ({
  item_id: newId(),
  product_id: newId(),
  variant_id: null,
  name: 'Aperol Spritz',
  unit_price: 32_000,
  tax_type: 'inc' as const,
  rate: 800,
  quantity: 1,
  guest: null,
  course: null,
  modifiers: [],
  notes: null,
  catalog_version: 1,
  price_channel_id: null,
})

function setupHub() {
  const m = setupAccess()
  const hub = new HubSync(new SqliteStore(m.db, m.restaurantId), {
    restaurantId: m.restaurantId,
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-1',
    clock: m.clock,
    access: m.access,
  })
  return { ...m, hub }
}

/** An order opened by the waiter with one item already sent to the kitchen. */
function orderWithSentItem(m: AccessSetup & { hub: HubSync }) {
  const { connection } = m.pair('waiter')
  const s = m.signIn(connection, 'waiter')
  const order = newId()
  const it = item()
  const en = { aggregate_id: order }
  const r = m.hub.receiveBatch(connection, [
    m.event(connection, s, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 2 }, en),
    m.event(connection, s, 'ItemAdded', it, { ...en, base_sequence: 1 }),
    m.event(
      connection,
      s,
      'ItemsSent',
      { tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }] },
      { ...en, base_sequence: 2 },
    ),
  ])
  expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
  return { connection, session: s, order, itemId: it.item_id }
}

describe('access in the sync hub', () => {
  it('a waiter cannot void a sent item without authorization', () => {
    const m = setupHub()
    const { connection, session, order, itemId } = orderWithSentItem(m)
    const voidItem = m.event(
      connection,
      session,
      'ItemVoided',
      { item_id: itemId, quantity: 1, already_prepared: false, ticket_id: null },
      { aggregate_id: order, reason: 'El cliente cambió de idea', base_sequence: 3 },
    )

    const r = m.hub.receiveBatch(connection, [voidItem])
    expect(r.results[0]).toMatchObject({ status: 'rejected', reason: 'no_permission' })
    expect(m.hub.order(order)?.items[itemId]?.status).toBe('sent')
  })

  it("with the manager's PIN it is voided, and who authorized it is recorded", () => {
    const m = setupHub()
    const { connection, session, order, itemId } = orderWithSentItem(m)
    // The app builds the event, requests the approval with its fingerprint and signs it with the
    // approval.
    const draft = m.event(
      connection,
      session,
      'ItemVoided',
      { item_id: itemId, quantity: 1, already_prepared: false, ticket_id: null },
      { aggregate_id: order, reason: 'El cliente cambió de idea', base_sequence: 3 },
    )
    const eventId = draft.id
    const a = m.access.authorize(connection, {
      ...session,
      pin: m.people.manager.pin,
      action: 'void_sent_item',
      aggregateId: order,
      eventId,
      fingerprint: authorizableFingerprint(draft),
    })
    if (!a.ok) throw new Error(a.message)
    const voidItem = signed(session, { ...draft, authorization_id: a.authorizationId })

    const r = m.hub.receiveBatch(connection, [voidItem])
    expect(r.results[0]).toMatchObject({
      status: 'confirmed',
      acceptance: { authorized_by_id: m.people.manager.userId },
    })
    const saved = m.db
      .prepare('SELECT user_id, authorized_by_id FROM events WHERE id = ?')
      .get(eventId)
    expect(saved).toEqual({
      user_id: m.people.waiter.userId,
      authorized_by_id: m.people.manager.userId,
    })
    const approval = m.db.prepare('SELECT supervisor_id, used_at FROM authorizations').get()
    expect(approval).toEqual({
      supervisor_id: m.people.manager.userId,
      used_at: m.clock(),
    })

    // Resending the same event (lost response) gives the same response, not "approval used".
    expect(m.hub.receiveBatch(connection, [voidItem]).results).toEqual(r.results)
  })

  it('what the waiter did offline counts as use of their session', () => {
    const m = setupHub()
    const { session } = orderWithSentItem(m)
    const row = m.db.prepare('SELECT last_used FROM sessions WHERE id = ?').get(session.sessionId)
    expect(row?.last_used).toBe(m.clock())
  })

  it('a revoked device is rejected: it cannot read the floor and what it sends next is not accepted', () => {
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
    const before = m.event(phone.connection, session, 'OrderOpened', {
      channel: 'bar',
      table_id: null,
      guests: 1,
    })

    m.advance(60_000)
    const r = m.access.revokeDevice(register, {
      ...admin,
      deviceId: phone.connection.deviceId,
    })
    if (!r.ok) throw new Error(r.message)
    floor.revoke(phone.connection.deviceId, r.revokedAt)
    m.advance(60_000)
    const after = m.event(phone.connection, session, 'OrderOpened', {
      channel: 'bar',
      table_id: null,
      guests: 1,
    })
    link.receive({ type: 'push', batch_id: 'l1', events: [before, after] })
    link.receive({ type: 'pull', from: 0 })

    const result = received.find((x) => x.type === 'result')
    expect(result?.type === 'result' && result.results.map((x) => x.status)).toEqual([
      'quarantine',
      'rejected',
    ])
    expect(
      received.filter((x) => x.type === 'error').map((x) => x.type === 'error' && x.code),
    ).toEqual(['revoked_token', 'revoked_token'])
    expect(m.db.prepare('SELECT count(*) AS n FROM events').get()?.n).toBe(0)

    // On reconnect, the token only works to deliver what is pending: it does not open a session.
    expect(
      m.access.startSession(m.access.authenticate(phone.token) as never, m.people.waiter.pin),
    ).toMatchObject({
      code: 'revoked_device',
    })
  })

  it('a cashier charges and closes from the register; the same cashier on the kitchen screen cannot', () => {
    const m = setupHub()
    const { order } = orderWithSentItem(m)
    // On a phone, signing in with a password makes it a register device (ADR-013); on the kitchen
    // screen it does not.
    const phone = m.pair('kds').connection
    const s = m.signIn(phone, 'cashier')
    const closeout = m.event(phone, s, 'OrderClosed', {}, { aggregate_id: order, base_sequence: 3 })

    expect(m.hub.receiveBatch(phone, [closeout]).results[0]).toMatchObject({
      status: 'rejected',
      reason: 'register_only',
    })
  })
})
