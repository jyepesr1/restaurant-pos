import { authorizableFingerprint, newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import {
  authorizeEvent,
  type HubSetup,
  item,
  OPEN_ORDER,
  orderWithSentItem,
  setupHub,
  sign,
  voidData,
} from './hub-setup'
import { AUTHORIZATION_TTL_MS, AUTHORIZED_DELIVERY_MS } from './service'

// Task 1.5 with the full hub (sync + access on the same database): voiding what was sent,
// canceling the order and making a sent dish cheaper require the permission or a supervisor's
// approval (ADR-008); moving, switching and merging tables can be done by any waiter.

const REASON = 'Error del mesero'

function scenario(modifiers: Parameters<typeof orderWithSentItem>[1] = []) {
  const m = setupHub()
  const p = orderWithSentItem(m, modifiers)
  const base = () =>
    Number(m.db.prepare('SELECT coalesce(max(sequence), 0) AS s FROM events').get()?.s)
  const create = (type: string, data: unknown, extras: Record<string, unknown> = {}) =>
    m.event(p.connection, p.session, type, data, {
      aggregate_id: p.order,
      base_sequence: base(),
      ...extras,
    } as never)
  const voidItem = (extras: Record<string, unknown> = {}) =>
    create('ItemVoided', voidData(p.itemId), { reason: REASON, ...extras })
  const cancel = (extras: Record<string, unknown> = {}) =>
    create('OrderCanceled', {}, { reason: REASON, ...extras })
  const send = (e: unknown) => m.hub.receiveBatch(p.connection, [e]).results[0]
  const authorize = (pin: string, e: Parameters<typeof authorizeEvent>[4], action: string) =>
    authorizeEvent(m, p.connection, p.session, pin, e, action)
  return { m, ...p, create, voidItem, cancel, send, authorize, base }
}

const pinOf = (m: HubSetup, who: 'manager' | 'cashier' | 'admin' | 'waiter2') => m.people[who].pin

describe('voiding what was sent (ItemVoided)', () => {
  it('the waiter without the permission and without approval: rejected (no_permission) and the dish stays', () => {
    const e = scenario()
    expect(e.send(e.voidItem())).toMatchObject({ status: 'rejected', reason: 'no_permission' })
    expect(e.m.hub.order(e.order)?.items[e.itemId]?.voidedQuantity).toBe(0)
  })

  it.each(['manager', 'cashier', 'admin'] as const)(
    'with the PIN of %s it is accepted and records who authorized it',
    (who) => {
      const e = scenario()
      const { event } = e.authorize(pinOf(e.m, who), e.voidItem(), 'void_sent_item')
      expect(e.send(event)).toMatchObject({
        status: 'confirmed',
        acceptance: { authorized_by_id: e.m.people[who].userId },
      })
      expect(e.m.hub.order(e.order)?.items[e.itemId]?.status).toBe('voided')
    },
  )

  it('the reason is saved with the event', () => {
    const e = scenario()
    const { event } = e.authorize(pinOf(e.m, 'manager'), e.voidItem(), 'void_sent_item')
    e.send(event)
    const row = e.m.db.prepare("SELECT reason FROM events WHERE type = 'ItemVoided'").get()
    expect(row?.reason).toBe(REASON)
  })

  it('without a reason, not even with approval: the schema rejects it', () => {
    const e = scenario()
    const withoutReason = e.voidItem({ reason: null })
    const { event } = e.authorize(pinOf(e.m, 'manager'), withoutReason, 'void_sent_item')
    expect(e.send(event)).toMatchObject({ status: 'rejected' })
    expect(String((e.send(event) as { reason?: string }).reason)).toContain('schema')
  })

  it('a PIN from another waiter (without the permission) does not authorize: no approval', () => {
    const e = scenario()
    const a = e.m.access.authorize(e.connection, {
      ...e.session,
      pin: pinOf(e.m, 'waiter2'),
      action: 'void_sent_item',
      aggregateId: e.order,
      eventId: newId(),
      fingerprint: 'a'.repeat(64),
    })
    expect(a.ok).toBe(false)
  })

  it('an expired approval (the event is created more than 2 minutes later) is not valid', () => {
    const e = scenario()
    const draft = e.voidItem()
    const a = e.m.access.authorize(e.connection, {
      ...e.session,
      pin: pinOf(e.m, 'manager'),
      action: 'void_sent_item',
      aggregateId: e.order,
      eventId: draft.id,
      fingerprint: authorizableFingerprint(draft),
    })
    if (!a.ok) throw new Error(a.message)
    e.m.advance(AUTHORIZATION_TTL_MS + 1_000)
    // The event would be rebuilt with the current time (the fingerprint includes the time, so it
    // changes too): we test with the late time set by hand on the same content.
    const late = sign(e.session, {
      ...draft,
      authorization_id: a.authorizationId,
      hub_estimated_time: e.m.clock(),
    })
    expect(e.send(late)).toMatchObject({ status: 'rejected', reason: 'invalid_authorization' })
  })

  it('an approval that arrives more than 12 hours after being issued is not valid', () => {
    const e = scenario()
    const { event } = e.authorize(pinOf(e.m, 'manager'), e.voidItem(), 'void_sent_item')
    e.m.advance(AUTHORIZED_DELIVERY_MS + 1_000)
    expect(e.send(event)).toMatchObject({ status: 'rejected', reason: 'invalid_authorization' })
  })

  it('an approval from another session on the same device is not valid', () => {
    const e = scenario()
    const draft = e.voidItem()
    const { approval } = e.authorize(pinOf(e.m, 'manager'), draft, 'void_sent_item')
    // The waiter closes their session and opens another: the event comes from the new session.
    e.m.access.closeSession(e.connection, e.session)
    const newSession = e.m.signIn(e.connection, 'waiter')
    const fromNew = sign(newSession, {
      ...draft,
      session_id: newSession.sessionId,
      authorization_id: approval.authorizationId,
    })
    expect(e.send(fromNew)).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
  })

  it('an approval for another fingerprint (the event changed afterwards) is not valid', () => {
    const e = scenario()
    const draft = e.voidItem()
    const { approval } = e.authorize(pinOf(e.m, 'manager'), draft, 'void_sent_item')
    const changed = sign(e.session, {
      ...draft,
      data: { ...draft.data, already_prepared: true },
      authorization_id: approval.authorizationId,
    } as never)
    expect(e.send(changed)).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
    // Changing the reason also changes the fingerprint.
    const otherReason = sign(e.session, {
      ...draft,
      reason: 'Demora',
      authorization_id: approval.authorizationId,
    })
    expect(e.send(otherReason)).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
  })

  it('a used approval does not work for another event', () => {
    const e = scenario()
    const firstVoid = e.voidItem()
    const { event, approval } = e.authorize(pinOf(e.m, 'manager'), firstVoid, 'void_sent_item')
    expect(e.send(event)?.status).toBe('confirmed')
    // A different event with the same approval.
    const secondVoid = sign(e.session, {
      ...e.voidItem(),
      authorization_id: approval.authorizationId,
    })
    expect(e.send(secondVoid)).toMatchObject({
      status: 'rejected',
      reason: 'invalid_authorization',
    })
    // Nor does requesting another approval for the same already authorized event.
    const another = e.m.access.authorize(e.connection, {
      ...e.session,
      pin: pinOf(e.m, 'admin'),
      action: 'void_sent_item',
      aggregateId: e.order,
      eventId: firstVoid.id,
      fingerprint: authorizableFingerprint(firstVoid),
    })
    expect(another).toMatchObject({ ok: false, code: 'already_authorized' })
  })

  it('an approval for another action (take_order) does not work for voiding', () => {
    const e = scenario()
    const draft = e.voidItem()
    const { event } = e.authorize(pinOf(e.m, 'manager'), draft, 'take_order')
    expect(e.send(event)).toMatchObject({ status: 'rejected', reason: 'invalid_authorization' })
  })

  it('someone with the permission does not authorize themselves with their own PIN', () => {
    const m = setupHub()
    const p = orderWithSentItem(m)
    // The cashier signs in on the waiter's phone (another session on another device).
    const { connection } = m.pair('register', 'Caja 2')
    const s = m.signIn(connection, 'cashier')
    const a = m.access.authorize(connection, {
      ...s,
      pin: m.people.cashier.pin,
      action: 'void_sent_item',
      aggregateId: p.order,
      eventId: newId(),
      fingerprint: 'b'.repeat(64),
    })
    expect(a).toMatchObject({ ok: false, code: 'self_authorization' })
  })

  it('the cashier voids directly, without approval, from their own device', () => {
    const m = setupHub()
    const p = orderWithSentItem(m)
    const { connection } = m.pair('register', 'Caja')
    const s = m.signIn(connection, 'cashier')
    const voidItem = m.event(connection, s, 'ItemVoided', voidData(p.itemId), {
      aggregate_id: p.order,
      reason: REASON,
      base_sequence: 3,
    })
    expect(m.hub.receiveBatch(connection, [voidItem]).results[0]).toMatchObject({
      status: 'confirmed',
      acceptance: { authorized_by_id: null },
    })
  })

  it('the approval is used up only if the event is accepted: a rule rejection leaves it usable', () => {
    const e = scenario()
    // More units than there are: the reducer rejects it.
    const tooMany = e.create(
      'ItemVoided',
      { ...voidData(e.itemId), quantity: 5 },
      { reason: REASON },
    )
    const { event, approval } = e.authorize(pinOf(e.m, 'manager'), tooMany, 'void_sent_item')
    expect(e.send(event)).toMatchObject({ status: 'rejected', reason: 'invalid_quantity' })
    const row = e.m.db
      .prepare('SELECT used_at FROM authorizations WHERE id = ?')
      .get(approval.authorizationId)
    expect(row?.used_at).toBeNull()
  })
})

describe('canceling the order (OrderCanceled)', () => {
  it('the waiter without approval: no_permission, and the order stays open', () => {
    const e = scenario()
    expect(e.send(e.cancel())).toMatchObject({ status: 'rejected', reason: 'no_permission' })
    expect(e.m.hub.order(e.order)?.status).toBe('open')
  })

  it.each(['manager', 'admin'] as const)('with the PIN of %s it is canceled', (who) => {
    const e = scenario()
    const { event } = e.authorize(pinOf(e.m, who), e.cancel(), 'cancel_order')
    expect(e.send(event)).toMatchObject({
      status: 'confirmed',
      acceptance: { authorized_by_id: e.m.people[who].userId },
    })
    expect(e.m.hub.order(e.order)?.status).toBe('canceled')
  })

  it('the cashier does not have cancel_order: their PIN gives no approval', () => {
    const e = scenario()
    const a = e.m.access.authorize(e.connection, {
      ...e.session,
      pin: pinOf(e.m, 'cashier'),
      action: 'cancel_order',
      aggregateId: e.order,
      eventId: newId(),
      fingerprint: 'c'.repeat(64),
    })
    expect(a.ok).toBe(false)
  })

  it('a void approval does not work for canceling (another action)', () => {
    const e = scenario()
    const { event } = e.authorize(pinOf(e.m, 'manager'), e.cancel(), 'void_sent_item')
    expect(e.send(event)).toMatchObject({ status: 'rejected', reason: 'invalid_authorization' })
  })

  it('without a reason the schema rejects it even with approval', () => {
    const e = scenario()
    const { event } = e.authorize(pinOf(e.m, 'manager'), e.cancel({ reason: null }), 'cancel_order')
    expect(e.send(event)).toMatchObject({ status: 'rejected' })
    expect(e.m.hub.order(e.order)?.status).toBe('open')
  })

  it('canceling an already canceled order is rejected (order_closed)', () => {
    const e = scenario()
    const { event } = e.authorize(pinOf(e.m, 'admin'), e.cancel(), 'cancel_order')
    e.send(event)
    const another = e.authorize(pinOf(e.m, 'admin'), e.cancel(), 'cancel_order')
    expect(e.send(another.event)).toMatchObject({ status: 'rejected', reason: 'order_closed' })
  })

  it('canceling frees the table and the merged ones', () => {
    const m = setupHub()
    const { connection } = m.pair('waiter')
    const s = m.signIn(connection, 'waiter')
    const [m1, m2] = [newId(), newId()]
    const order = newId()
    const en = { aggregate_id: order }
    const r = m.hub.receiveBatch(connection, [
      m.event(connection, s, 'OrderOpened', { ...OPEN_ORDER, table_id: m1 }, en),
      m.event(connection, s, 'TablesMerged', { table_ids: [m2] }, { ...en, base_sequence: 1 }),
    ])
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(m.hub.hasOpenOrder(m2)).toBe(true)
    const cancel = m.event(
      connection,
      s,
      'OrderCanceled',
      {},
      {
        ...en,
        reason: REASON,
        base_sequence: 2,
      },
    )
    const a = authorizeEvent(m, connection, s, m.people.admin.pin, cancel, 'cancel_order')
    expect(m.hub.receiveBatch(connection, [a.event]).results[0]?.status).toBe('confirmed')
    expect(m.hub.hasOpenOrder(m1)).toBe(false)
    expect(m.hub.hasOpenOrder(m2)).toBe(false)
  })
})

describe('changing an already sent dish (ItemModifiedAfterSend)', () => {
  const extra = { modifier_id: newId(), name: 'Extra limón', extra_price: 3000 }

  it('the waiter changes only the note without approval', () => {
    const e = scenario([extra])
    const r = e.send(
      e.create('ItemModifiedAfterSend', {
        item_id: e.itemId,
        ticket_id: e.ticketId,
        notes: 'sin hielo',
      }),
    )
    expect(r?.status).toBe('confirmed')
    expect(e.m.hub.order(e.order)?.items[e.itemId]?.notes).toBe('sin hielo')
  })

  it('removing the extra (cheaper) without approval is rejected; with the PIN of the cashier it is accepted', () => {
    const e = scenario([extra])
    const change = e.create('ItemModifiedAfterSend', {
      item_id: e.itemId,
      ticket_id: e.ticketId,
      modifiers: [],
    })
    expect(e.send(change)).toMatchObject({ status: 'rejected', reason: 'no_permission' })
    const { event } = e.authorize(pinOf(e.m, 'cashier'), change, 'void_sent_item')
    expect(e.send(event)?.status).toBe('confirmed')
    expect(e.m.hub.order(e.order)?.items[e.itemId]?.modifiers).toEqual([])
  })

  it('the waiter switches to a pricier extra on their own', () => {
    const e = scenario([extra])
    const r = e.send(
      e.create('ItemModifiedAfterSend', {
        item_id: e.itemId,
        ticket_id: e.ticketId,
        modifiers: [{ ...extra, extra_price: 5000 }],
      }),
    )
    expect(r?.status).toBe('confirmed')
  })
})

describe('any waiter can move, switch and merge tables', () => {
  it('OrderMovedTable, TablesMerged and TablesSeparated without approval', () => {
    const m = setupHub()
    const { connection } = m.pair('waiter')
    const s = m.signIn(connection, 'waiter')
    const [m1, m2, m3] = [newId(), newId(), newId()]
    const order = newId()
    const en = { aggregate_id: order }
    const r = m.hub.receiveBatch(connection, [
      m.event(connection, s, 'OrderOpened', { ...OPEN_ORDER, table_id: m1 }, en),
      m.event(connection, s, 'TablesMerged', { table_ids: [m2] }, { ...en, base_sequence: 1 }),
      m.event(connection, s, 'TablesSeparated', { table_ids: [m2] }, { ...en, base_sequence: 2 }),
      m.event(
        connection,
        s,
        'OrderMovedTable',
        { target_table_id: m3 },
        { ...en, base_sequence: 3 },
      ),
    ])
    expect(r.results.map((x) => x.status)).toEqual([
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
    ])
    expect(m.hub.order(order)).toMatchObject({ tableId: m3, mergedTables: [] })
  })

  it('ItemsMoved of a sent dish to a free table (batch with the opening), without approval', () => {
    const m = setupHub()
    const p = orderWithSentItem(m)
    const original = m.hub.order(p.order)?.items[p.itemId]
    if (!original) throw new Error('no item')
    const target = newId()
    const { catalog_version: _v, price_channel_id: _c, ...copy } = item()
    const moved = {
      item: {
        ...copy,
        item_id: original.id,
        product_id: original.productId,
        name: original.name,
        unit_price: original.unitPrice,
        rate: original.rate,
      },
      status: 'sent',
      voided_quantity: 0,
      added_by: m.people.waiter.userId,
    }
    const r = m.hub.receiveBatch(p.connection, [
      m.event(
        p.connection,
        p.session,
        'OrderOpened',
        { ...OPEN_ORDER, table_id: newId() },
        { aggregate_id: target, base_sequence: 3 },
      ),
      m.event(
        p.connection,
        p.session,
        'ItemsMoved',
        { target_order_id: target, items: [moved] },
        { aggregate_id: p.order, related: [target], base_sequence: 3 },
      ),
    ])
    expect(r.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(m.hub.order(target)?.items[p.itemId]?.status).toBe('sent')
  })
})
