import { type NewEvent, newId } from '@pos/core'
import { FloorSync, type HubMessage, HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { describe, expect, it } from 'vitest'
import { add, type HubSetup, item, OPEN_ORDER, setupHub } from './access/hub-setup'
import { SYSTEM, updateVersioned } from './access/records'

// Sold out (86) with the hub real access control: quarantine, revocation, broadcast to the other
// devices, and that an item of a sold-out product is accepted (docs/SYNC.md, task 1.3).

const FOR_PRODUCT = (product: string) => ({
  aggregate_type: 'product' as const,
  aggregate_id: product,
})
const data = (product: string, variant: string | null = null) => ({
  product_id: product,
  variant_id: variant,
})

const changeRole = (m: HubSetup, userId: string, roleId: string) =>
  updateVersioned(m.db, 'users', m.restaurantId, userId, { role_id: roleId }, SYSTEM, m.clock())

const stateIn = (m: HubSetup, id: string) =>
  m.db.prepare('SELECT status FROM quarantined_events WHERE event_id = ?').get(id) ??
  m.db.prepare('SELECT reason FROM rejected_events WHERE event_id = ?').get(id)

describe('quarantine and rejections of a sold-out event', () => {
  /** A cashier with a session open at the register, and a builder for a timed sold-out event. */
  function registerWithSession() {
    const m = setupHub()
    const { connection } = m.pair('register')
    const session = m.signIn(connection, 'cashier')
    const product = newId()
    const markSoldOut = (time = m.clock(), extras = {}) =>
      m.event(connection, session, 'ProductSoldOut', data(product), {
        ...FOR_PRODUCT(product),
        device_time: time,
        hub_estimated_time: time,
        ...extras,
      })
    return { m, connection, session, product, markSoldOut }
  }

  it('the cashier loses the permission: what came before goes to quarantine and what came after is rejected', () => {
    const { m, connection, markSoldOut } = registerWithSession()
    const before = markSoldOut()
    m.advance(10 * 60_000)
    changeRole(m, m.people.cashier.userId, m.roles.waiter)
    const change = m.clock()
    m.advance(10 * 60_000)
    const after = markSoldOut(add(change, 1000))

    const r = m.hub.receiveBatch(connection, [before, after])

    expect(r.results.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
    expect(r.results[1]).toMatchObject({ reason: 'no_permission' })
    expect(
      m.db.prepare('SELECT reason FROM quarantined_events WHERE event_id = ?').get(before.id)
        ?.reason,
    ).toBe('permissions_changed')
    // Neither one got into the sequence or changed any order.
    expect(m.db.prepare('SELECT count(*) AS n FROM events').get()?.n).toBe(0)
    expect(r.acceptedEvents).toEqual([])
  })

  it('the cashier is archived: what came before goes to quarantine and what came after is rejected', () => {
    const { m, connection, markSoldOut } = registerWithSession()
    const before = markSoldOut()
    m.advance(10 * 60_000)
    m.access.archiveUser(m.people.cashier.userId)
    const archived = m.clock()
    m.advance(10 * 60_000)
    const after = markSoldOut(add(archived, 1000))

    const r = m.hub.receiveBatch(connection, [before, after])

    expect(r.results.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
    expect(
      m.db.prepare('SELECT reason FROM quarantined_events WHERE event_id = ?').get(before.id)
        ?.reason,
    ).toBe('user_archived')
    expect(r.results[1]).toMatchObject({ reason: 'user_inactive' })
  })

  it('a revoked device: the sold-out event from before goes to quarantine and the one from after is rejected', () => {
    const { m, connection, markSoldOut } = registerWithSession()
    const before = markSoldOut()
    m.advance(60_000)
    const revoked = { ...connection, revokedAt: m.clock() }
    m.advance(60_000)
    const after = markSoldOut()

    const r = m.hub.receiveBatch(revoked, [before, after])

    expect(r.results.map((x) => x.status)).toEqual(['quarantine', 'rejected'])
    expect(r.results[1]).toMatchObject({ reason: 'revoked_device' })
    expect(
      m.db.prepare('SELECT reason FROM quarantined_events WHERE event_id = ?').get(before.id)
        ?.reason,
    ).toBe('revoked_device')
  })

  it('a session the hub does not know goes to quarantine, without bringing the hub down', () => {
    const { m, connection, session, product } = registerWithSession()
    const foreign = { ...session, sessionId: newId() }
    const e = m.event(connection, foreign, 'ProductSoldOut', data(product), FOR_PRODUCT(product))
    expect(m.hub.receiveBatch(connection, [e]).results).toEqual([
      { id: e.id, status: 'quarantine' },
    ])
  })

  it('without a session, with a tampered signature or from another device it is rejected', () => {
    const { m, connection, session, product, markSoldOut } = registerWithSession()
    const withoutSession = m.event(
      connection,
      { ...session, sessionId: null as unknown as string },
      'ProductSoldOut',
      data(product),
      { ...FOR_PRODUCT(product), session_id: null },
    )
    const tampered = { ...markSoldOut(), data: data(product, newId()) }
    const fromOther = { ...markSoldOut(), device_id: newId() }

    const r = m.hub.receiveBatch(connection, [withoutSession, tampered, fromOther])

    expect(r.results.map((x) => (x.status === 'rejected' ? x.reason : x.status))).toEqual([
      'no_session',
      'invalid_signature',
      'device_mismatch',
    ])
  })

  it('the waiter cannot, not even with another device sold-out event; cashier, manager and admin can', () => {
    const m = setupHub()
    const product = newId()
    const attempt = (who: 'waiter' | 'cashier' | 'manager' | 'admin') => {
      const { connection } = m.pair(who === 'cashier' ? 'register' : 'waiter')
      const session = m.signIn(connection, who)
      const e = m.event(connection, session, 'ProductSoldOut', data(product), FOR_PRODUCT(product))
      return m.hub.receiveBatch(connection, [e]).results[0]
    }
    expect(attempt('waiter')).toMatchObject({ status: 'rejected', reason: 'no_permission' })
    for (const who of ['cashier', 'manager', 'admin'] as const)
      expect(attempt(who), who).toMatchObject({ status: 'confirmed' })
  })

  it('a sold-out event rejected in the batch does not drag along the order or other products', () => {
    const m = setupHub()
    const { connection } = m.pair('waiter')
    const session = m.signIn(connection, 'waiter')
    const x = newId()
    const y = newId()
    const order = newId()
    const r = m.hub.receiveBatch(connection, [
      m.event(connection, session, 'OrderOpened', OPEN_ORDER, { aggregate_id: order }),
      m.event(connection, session, 'ProductSoldOut', data(x), FOR_PRODUCT(x)),
      m.event(connection, session, 'ProductAvailable', data(x), FOR_PRODUCT(x)),
      m.event(connection, session, 'ItemAdded', item(), {
        aggregate_id: order,
        base_sequence: 1,
      }),
      m.event(connection, session, 'ProductSoldOut', data(y), FOR_PRODUCT(y)),
    ])
    // The waiter has no permission: the product ones are rejected (the permission is judged
    // before the dependency), but the order and its item go their own way.
    expect(r.results.map((e) => (e.status === 'rejected' ? e.reason : e.status))).toEqual([
      'confirmed',
      'no_permission',
      'no_permission',
      'confirmed',
      'no_permission',
    ])
  })
})

describe('sold-out event content', () => {
  it('it is idempotent: the same event gets the same response; with other content, duplicate_id', () => {
    const m = setupHub()
    const { connection } = m.pair('register')
    const session = m.signIn(connection, 'cashier')
    const product = newId()
    const e = m.event(connection, session, 'ProductSoldOut', data(product), FOR_PRODUCT(product))

    const a = m.hub.receiveBatch(connection, [e])
    const b = m.hub.receiveBatch(connection, [e])
    expect(b.results).toEqual(a.results)
    expect(b.acceptedEvents).toEqual([])
    expect(m.db.prepare('SELECT count(*) AS n FROM events').get()?.n).toBe(1)

    const other = m.signed(session, { ...e, data: data(product, newId()) } as NewEvent)
    expect(m.hub.receiveBatch(connection, [other]).results[0]).toMatchObject({
      status: 'rejected',
      reason: 'duplicate_id',
    })
  })

  it('a made-up base_sequence is rejected just like in an order', () => {
    const m = setupHub()
    const { connection } = m.pair('register')
    const session = m.signIn(connection, 'cashier')
    const product = newId()
    const e = m.event(connection, session, 'ProductSoldOut', data(product), {
      ...FOR_PRODUCT(product),
      base_sequence: 50,
    })
    expect(m.hub.receiveBatch(connection, [e]).results[0]).toMatchObject({
      status: 'rejected',
      reason: 'invalid_base_sequence',
    })
  })

  it('it is stored as a product event and survives the restart without touching the orders', () => {
    const m = setupHub()
    const { connection } = m.pair('register')
    const session = m.signIn(connection, 'cashier')
    const order = newId()
    const product = newId()
    const r = m.hub.receiveBatch(connection, [
      m.event(connection, session, 'OrderOpened', OPEN_ORDER, { aggregate_id: order }),
      m.event(connection, session, 'ProductSoldOut', data(product), FOR_PRODUCT(product)),
      m.event(connection, session, 'ItemAdded', item(), {
        aggregate_id: order,
        base_sequence: 1,
      }),
      m.event(connection, session, 'ProductAvailable', data(product), FOR_PRODUCT(product)),
    ])
    expect(r.results.map((x) => x.status)).toEqual(Array(4).fill('confirmed'))
    expect(
      m.db
        .prepare('SELECT aggregate_type, aggregate_id FROM events WHERE type = ?')
        .get('ProductSoldOut'),
    ).toEqual({ aggregate_type: 'product', aggregate_id: product })
    const before = structuredClone(m.hub.order(order))

    const restarted = new HubSync(new SqliteStore(m.db, m.restaurantId), {
      restaurantId: m.restaurantId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      instance: 'hub-1',
      clock: m.clock,
      access: m.access,
    })
    expect(restarted.order(order)).toEqual(before)
    expect(restarted.order(product)).toBeNull()
    expect(restarted.hasOpenOrder(newId())).toBe(false)
    expect(restarted.pull(0, 'register').events.map((e) => e.type)).toEqual([
      'OrderOpened',
      'ProductSoldOut',
      'ItemAdded',
      'ProductAvailable',
    ])
  })
})

describe('an item of a sold-out product', () => {
  it('is accepted: whoever ordered it offline does not lose their order', () => {
    const m = setupHub()
    const register = m.pair('register')
    const cashier = m.signIn(register.connection, 'cashier')
    const phone = m.pair('waiter')
    const waiter = m.signIn(phone.connection, 'waiter')
    const order = newId()
    const product = newId()
    const it1 = { ...item(), product_id: product }

    // The register marks the product sold out (sequence 1); the waiter, unaware, orders it.
    m.hub.receiveBatch(register.connection, [
      m.event(register.connection, cashier, 'ProductSoldOut', data(product), FOR_PRODUCT(product)),
    ])
    const r = m.hub.receiveBatch(phone.connection, [
      m.event(phone.connection, waiter, 'OrderOpened', OPEN_ORDER, { aggregate_id: order }),
      m.event(phone.connection, waiter, 'ItemAdded', it1, { aggregate_id: order }),
    ])

    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(r.results[1]).toMatchObject({ conflict: null })
    expect(Object.keys(m.hub.order(order)?.items ?? {})).toEqual([it1.item_id])
    expect(m.hub.conflicts()).toEqual([])
  })

  it('it is not rejected either when the sold-out event arrives later in the same batch', () => {
    const m = setupHub()
    const { connection } = m.pair('register')
    const session = m.signIn(connection, 'cashier')
    const order = newId()
    const product = newId()
    const r = m.hub.receiveBatch(connection, [
      m.event(connection, session, 'OrderOpened', OPEN_ORDER, { aggregate_id: order }),
      m.event(connection, session, 'ProductSoldOut', data(product), FOR_PRODUCT(product)),
      m.event(
        connection,
        session,
        'ItemAdded',
        { ...item(), product_id: product },
        {
          aggregate_id: order,
          base_sequence: 1,
        },
      ),
    ])
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
  })
})

describe('the new notice reaches the other devices', () => {
  it('a sold-out event from the register reaches the phone and the kitchen, without the session of whoever made it', () => {
    const m = setupHub()
    const floor = new FloorSync(m.hub, m.access.authenticate)
    const register = m.pair('register')
    const phone = m.pair('waiter')
    const kitchen = m.pair('kds')
    const received: Record<string, HubMessage[]> = { register: [], phone: [], kitchen: [] }
    const open = (name: string, token: string) => {
      const link = floor.connect((x) => received[name]?.push(x))
      link.receive({ type: 'hello', token, hub_instance: null, until: 0, version_app: 'x' })
      return link
    }
    const atRegister = open('register', register.token)
    open('phone', phone.token)
    open('kitchen', kitchen.token)

    const cashier = m.signIn(register.connection, 'cashier')
    const product = newId()
    const bottle = newId()
    const e = m.event(
      register.connection,
      cashier,
      'ProductSoldOut',
      data(product, bottle),
      FOR_PRODUCT(product),
    )
    atRegister.receive({ type: 'push', batch_id: 'l1', events: [e] })

    for (const name of ['phone', 'kitchen', 'register']) {
      const fresh = received[name]?.find((x) => x.type === 'new')
      expect(fresh, name).toMatchObject({
        event: {
          id: e.id,
          type: 'ProductSoldOut',
          aggregate_type: 'product',
          sequence: 1,
          data: { product_id: product, variant_id: bottle },
        },
        previous_until: 0,
        until: 1,
      })
    }
    // The others do not get the session of whoever created it; the register, which owns it, does.
    const fromPhone = received.phone?.find((x) => x.type === 'new')
    expect(fromPhone?.type === 'new' && fromPhone.event.session_id).toBeNull()
    const fromRegister = received.register?.find((x) => x.type === 'new')
    expect(fromRegister?.type === 'new' && fromRegister.event.session_id).toBe(cashier.sessionId)
  })

  it('a revoked device does not get the notice, and one that connects later gets it with `pull`', () => {
    const m = setupHub()
    const floor = new FloorSync(m.hub, m.access.authenticate)
    const register = m.pair('register')
    const phone = m.pair('waiter')
    const received: HubMessage[] = []
    const link = floor.connect((x) => received.push(x))
    link.receive({
      type: 'hello',
      token: phone.token,
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })
    floor.revoke(phone.connection.deviceId, m.clock())

    const cashier = m.signIn(register.connection, 'cashier')
    const product = newId()
    m.hub.receiveBatch(register.connection, [
      m.event(register.connection, cashier, 'ProductSoldOut', data(product), FOR_PRODUCT(product)),
    ])
    expect(received.some((x) => x.type === 'new')).toBe(false)

    const late: HubMessage[] = []
    const other = floor.connect((x) => late.push(x))
    const newPhone = m.pair('waiter')
    other.receive({
      type: 'hello',
      token: newPhone.token,
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })
    other.receive({ type: 'pull', from: 0 })
    const events = late.find((x) => x.type === 'events')
    expect(events?.type === 'events' && events.events.map((e) => e.type)).toEqual([
      'ProductSoldOut',
    ])
  })
})

// Keeps the `stateIn` helper from going unused if the tests above are simplified.
void stateIn
