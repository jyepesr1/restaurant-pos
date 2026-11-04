import 'fake-indexeddb/auto'
import { newId, type OrderEvent, signEvent } from '@pos/core'
import {
  type AccessControl,
  type Channel,
  type DeviceMessage,
  FloorSync,
  type Handlers,
  HubSync,
  MemoryStore,
} from '@pos/sync'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CheckoutRules, pendingMoneyOf, registerReconciliation } from './checks'
import { type Device, Floor, type Session } from './engine'
import { DeviceDatabase } from './store'
import { itemData, testCatalog } from './testing'
import { UnappliedError } from './unapplied'

// End to end, in memory (task 1.7b): two registers and a hub. One charges an order the other
// already closed while it was offline: the hub saves the payment without applying it. The device
// says so with a notice that stays until «Entendido» (also after closing the app), the payment
// is not shown as done, the register keeps it apart and the close asks to explain it. The timers
// are fake: nothing really waits.

const T0 = new Date('2026-10-26T15:00:00.000Z')
const RULES: CheckoutRules = {
  paymentMethods: ['cash', 'card', 'nequi'],
  suggestedTip: 1000,
  roundingMode: 'half_up',
  cashRounding: 100,
  cashRoundingMode: 'nearest_half_down',
  printsPreBill: false,
}
const CARD_TERMINAL = newId()

const accessWithSignature: AccessControl = {
  verify: (_c, event) =>
    event.session_id && event.signature === signEvent(event, `secreto-${event.session_id}`)
      ? { ok: true, authorizedById: null, authorizationId: null }
      : { ok: false, reason: 'invalid_signature' },
  recordUse: () => {},
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: T0,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  )
})

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r))
}
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    await vi.advanceTimersByTimeAsync(Math.min(100, ms - t))
    await settle(3)
  }
}
async function until(condition: () => Promise<boolean> | boolean, maxMs = 20_000) {
  for (let t = 0; t <= maxMs; t += 100) {
    if (await condition()) return
    await advance(100)
  }
  throw new Error('Not met within the simulated time')
}
/** Lets the simulated clock run until the promise settles (well or badly). */
async function resolve<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  let r: { ok: true; value: T } | { ok: false; error: Error } | null = null
  promise.then(
    (value) => {
      r = { ok: true, value }
    },
    (error) => {
      r = { ok: false, error }
    },
  )
  await until(() => r !== null)
  return r as never
}

function setupHub() {
  const tokens = new Map<string, Device>()
  const hub = new HubSync(new MemoryStore(), {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-test',
    clock: () => new Date(Date.now()).toISOString(),
    access: accessWithSignature,
    checkoutRules: () => ({
      multiple: 100,
      mode: 'nearest_half_down',
      methods: RULES.paymentMethods,
      cardTerminals: [CARD_TERMINAL],
      varianceThreshold: 1000,
    }),
  })
  const hubFloor = new FloorSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { deviceId: e.deviceId, type: e.type, revokedAt: null } : null
  })
  const h = {
    hub,
    tokens,
    received: [] as DeviceMessage[],
    open(m: Handlers): Channel {
      let link: ReturnType<FloorSync['connect']> | null = null
      let closed = false
      setTimeout(() => {
        if (closed) return
        link = hubFloor.connect((msg) => {
          const copy = JSON.parse(JSON.stringify(msg))
          setTimeout(() => {
            if (!closed) m.onMessage(copy)
          })
        })
        m.onOpen()
      })
      return {
        send: (msg) => {
          if (!link || closed) return
          const copy = JSON.parse(JSON.stringify(msg)) as DeviceMessage
          h.received.push(copy)
          link.receive(copy)
        },
        close: () => {
          closed = true
          link?.close()
          link = null
        },
      }
    },
  }
  return h
}
type Hub = ReturnType<typeof setupHub>

const floors: Floor[] = []
const databases: DeviceDatabase[] = []
afterEach(async () => {
  for (const s of floors.splice(0)) s.simulateOffline(true)
  await settle(10)
  vi.useRealTimers()
  await settle(10)
  for (const b of databases.splice(0)) await b.delete()
  vi.unstubAllGlobals()
})

async function register(h: Hub, name = 'Caja 1') {
  const db = new DeviceDatabase(`unapplied-${newId()}`)
  databases.push(db)
  const e: Device = { deviceId: newId(), token: newId(), name, type: 'register' }
  h.tokens.set(e.token, e)
  const sessionId = newId()
  const session: Session = {
    sessionId,
    secret: `secreto-${sessionId}`,
    user: { id: newId(), name: 'Carlos', role: 'Cajero' },
    permissions: [
      'take_order',
      'record_payment',
      'close_table',
      'open_register_shift',
      'close_register_shift',
    ],
    lastUsed: Date.now(),
  }
  await db.saveSetting('device', e)
  await db.saveSetting('session', session)
  await db.saveSetting('catalog', testCatalog())
  return { floor: await start(h, db), e, db, userId: session.user.id }
}

/** The last connection each app opened: a test can pass it a message as if from the hub. */
const handlersOf = new Map<Floor, Handlers>()

/** Opens the app on that device's database (again, after closing it). */
async function start(h: Hub, db: DeviceDatabase) {
  const floor: Floor = new Floor({
    db,
    open: (m) => {
      handlersOf.set(floor, m)
      return h.open(m)
    },
  })
  floors.push(floor)
  await floor.load()
  await until(() => floor.snapshot().connection === 'connected')
  return floor
}

const locals = async (s: Floor) => (await s.sync?.locals()) ?? []
const noPending = (s: Floor) => s.snapshot().pendingList === 0

const cash = (shift: string, amount: number) => ({
  payment_id: newId(),
  check_id: null,
  register_shift_id: shift,
  method: 'cash' as const,
  amount,
  tip: 0,
  tendered: amount,
  change: 0,
  rounding_adjustment: 0,
  rounding: null,
  cardTerminal: null,
  charge_reference: null,
})

const NOTICE =
  'El pago de $40.000 en efectivo del pedido #1 no se aplicó: la cuenta ya estaba cerrada. Si ya recibiste ese dinero, devuélvelo al cliente. Si aún debe, reabre la cuenta y cobra otra vez.'

/**
 * Register 1 and register 2 each with its shift; an order of $40.000. Register 1 goes offline and
 * charges it; meanwhile register 2 charges and closes it. When register 1 comes back, the hub
 * saves its payment without applying it (`order_closed`).
 */
async function lateCharge() {
  const h = setupHub()
  const one = await register(h, 'Caja 1')
  const two = await register(h, 'Caja 2')
  const shift1 = await one.floor.openShift(100_000)
  const shift2 = await two.floor.openShift(0)
  const order = newId()
  await one.floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
  await one.floor.record('ItemAdded', order, itemData({ unit_price: 40_000, name: 'Pinsa' }))
  await until(() => noPending(one.floor) && noPending(two.floor))
  await until(async () => (await locals(two.floor)).some((l) => l.event.aggregate_id === order))

  one.floor.simulateOffline(true)
  const charging = resolve(
    one.floor.recordConfirmed('PaymentRecorded', order, cash(shift1, 40_000), {}, 60_000),
  )
  await settle(5)
  const paid = await resolve(
    two.floor.recordConfirmed('PaymentRecorded', order, cash(shift2, 40_000)),
  )
  const closed = await resolve(two.floor.recordConfirmed('OrderClosed', order, {}))
  expect([paid.ok, closed.ok]).toEqual([true, true])
  one.floor.simulateOffline(false)
  return { h, one, two, order, shift1, shift2, charged: await charging }
}

describe('a payment the hub saved without applying it', () => {
  it('recordConfirmed fails with what to do; the notice shows and the register keeps it apart', async () => {
    const { h, one, shift1, charged, order } = await lateCharge()
    expect(charged.ok).toBe(false)
    const error = (charged as { error: Error }).error
    expect(error).toBeInstanceOf(UnappliedError)
    expect(error.message).toBe(NOTICE)
    expect(one.floor.snapshot().unappliedNotices).toEqual([
      { eventId: expect.any(String), text: NOTICE, userId: one.userId },
    ])

    // The hub has the order closed with the other register's payment only.
    expect(Object.keys(h.hub.order(order)?.payments ?? {})).toHaveLength(1)
    const saved = await locals(one.floor)
    const late = saved.find((l) => l.event.type === 'PaymentRecorded' && l.own)
    expect(late).toMatchObject({ status: 'confirmed', event: { unapplied: true } })
    const reconciliation = registerReconciliation(saved, shift1)
    expect(reconciliation?.cash).toMatchObject({ charged: 0, expected: 100_000 })
    expect(reconciliation?.unapplied.map((u) => [u.type, u.method, u.amount])).toEqual([
      ['PaymentRecorded', 'cash', 40_000],
    ])
    expect(pendingMoneyOf(saved, shift1)).toBe(0)
  })

  it('the notice survives closing the app, and «Entendido» removes it for good', async () => {
    const { h, one } = await lateCharge()
    await until(() => one.floor.snapshot().unappliedNotices.length === 1)
    one.floor.simulateOffline(true)

    const reopened = await start(h, one.db)
    await until(() => reopened.snapshot().unappliedNotices.length === 1)
    const [notice] = reopened.snapshot().unappliedNotices
    expect(notice?.text).toBe(NOTICE)

    await reopened.acknowledgeUnapplied(notice?.eventId as string)
    expect(reopened.snapshot().unappliedNotices).toEqual([])
    reopened.simulateOffline(true)
    const again = await start(h, one.db)
    await settle(10)
    expect(again.snapshot().unappliedNotices).toEqual([])
  })

  it('the other register, whose payment did apply, gets no notice', async () => {
    const { two } = await lateCharge()
    await settle(10)
    expect(two.floor.snapshot().unappliedNotices).toEqual([])
  })

  it('closing the register: without explaining it the hub rejects the close, with it it closes', async () => {
    const { one, shift1 } = await lateCharge()
    const cashCount = newId()
    const counted = await resolve(
      one.floor.recordConfirmed('CashCountRecorded', shift1, {
        cash_count_id: cashCount,
        tally: [{ value: 100_000, quantity: 1 }],
        counted_cash: 100_000,
      }),
    )
    expect(counted.ok).toBe(true)
    const close = (justification: string | null) =>
      resolve(
        one.floor.recordConfirmed('ShiftClosed', shift1, {
          cash_count_id: cashCount,
          expected_cash: 100_000,
          counted_cash: 100_000,
          variance: 0,
          justification,
        }),
      )
    const without = await close(null)
    expect((without as { error: Error }).error.message).toBe(
      'Falta explicar por qué no cuadra la caja o qué pasó con los movimientos no aplicados.',
    )
    const withIt = await close('El cliente ya había pagado en la Caja 2: se le devolvió')
    expect(withIt.ok).toBe(true)
  })
})

/**
 * The hub sends its copy of one of this device's events without the mark, as a hub restored from
 * a backup that applied it this time.
 */
async function judgedAppliedAgain(floor: Floor, eventId: string | undefined) {
  const late = (await locals(floor)).find((l) => l.event.id === eventId)
  const handlers = handlersOf.get(floor)
  if (!late || !handlers) throw new Error('No such event or connection')
  const { unapplied: _, ...applied } = late.event
  handlers.onMessage({
    type: 'events',
    events: [applied as OrderEvent],
    until: 0,
    has_more: false,
  })
}

describe('a notice whose event the hub judged again as applied (restored hub)', () => {
  it('goes away when the hub’s copy comes without the mark, and does not come back', async () => {
    const { h, one } = await lateCharge()
    await until(() => one.floor.snapshot().unappliedNotices.length === 1)
    const eventId = one.floor.snapshot().unappliedNotices[0]?.eventId
    await judgedAppliedAgain(one.floor, eventId)
    await until(() => one.floor.snapshot().unappliedNotices.length === 0)
    const now = (await locals(one.floor)).find((l) => l.event.id === eventId)
    expect(now?.status).toBe('confirmed')
    expect(now?.event.unapplied).toBeUndefined()

    one.floor.simulateOffline(true)
    const reopened = await start(h, one.db)
    await settle(10)
    expect(reopened.snapshot().unappliedNotices).toEqual([])
  })

  it('a notice of another event stays when one is judged again', async () => {
    const { one } = await lateCharges(2)
    one.floor.simulateOffline(false)
    await until(() => one.floor.snapshot().unappliedNotices.length === 2)
    const [first, second] = one.floor.snapshot().unappliedNotices
    await judgedAppliedAgain(one.floor, first?.eventId)
    await until(() => one.floor.snapshot().unappliedNotices.length === 1)
    expect(one.floor.snapshot().unappliedNotices.map((n) => n.eventId)).toEqual([second?.eventId])
  })
})

/**
 * Like `lateCharge`, with `howMany` orders: register 1 charges every one while offline, register 2
 * charges and closes them all meanwhile.
 */
async function lateCharges(howMany: number) {
  const h = setupHub()
  const one = await register(h, 'Caja 1')
  const two = await register(h, 'Caja 2')
  const shift1 = await one.floor.openShift(100_000)
  const shift2 = await two.floor.openShift(0)
  const orders = Array.from({ length: howMany }, () => newId())
  for (const order of orders) {
    await one.floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
    await one.floor.record('ItemAdded', order, itemData({ unit_price: 40_000, name: 'Pinsa' }))
  }
  await until(() => noPending(one.floor) && noPending(two.floor))
  await until(async () => (await locals(two.floor)).length >= howMany * 2 + 2)

  one.floor.simulateOffline(true)
  for (const order of orders) await one.floor.record('PaymentRecorded', order, cash(shift1, 40_000))
  for (const order of orders) {
    const paid = await resolve(
      two.floor.recordConfirmed('PaymentRecorded', order, cash(shift2, 40_000)),
    )
    const closed = await resolve(two.floor.recordConfirmed('OrderClosed', order, {}))
    expect([paid.ok, closed.ok]).toEqual([true, true])
  }
  return { h, one, two, orders, shift1, shift2 }
}

describe('several payments the hub did not apply at once', () => {
  it('each one has its own notice; «Entendido» removes only that one, also after a restart', async () => {
    const { h, one, shift1 } = await lateCharges(2)
    // Offline: the money is pending, counted as always and the register does not close yet.
    let saved = await locals(one.floor)
    expect(pendingMoneyOf(saved, shift1)).toBe(2)
    expect(registerReconciliation(saved, shift1)?.cash.charged).toBe(80_000)
    expect(one.floor.snapshot().unappliedNotices).toEqual([])

    one.floor.simulateOffline(false)
    await until(() => one.floor.snapshot().unappliedNotices.length === 2)
    saved = await locals(one.floor)
    expect(pendingMoneyOf(saved, shift1)).toBe(0)
    const reconciliation = registerReconciliation(saved, shift1)
    expect(reconciliation?.cash).toMatchObject({ charged: 0, expected: 100_000 })
    expect(reconciliation?.unapplied).toHaveLength(2)
    const notices = one.floor.snapshot().unappliedNotices
    expect(new Set(notices.map((n) => n.eventId)).size).toBe(2)
    for (const n of notices) expect(n.text).toContain('El pago de $40.000 en efectivo')

    await one.floor.acknowledgeUnapplied(notices[0]?.eventId as string)
    expect(one.floor.snapshot().unappliedNotices.map((n) => n.eventId)).toEqual([
      notices[1]?.eventId,
    ])
    one.floor.simulateOffline(true)
    const reopened = await start(h, one.db)
    await settle(10)
    expect(reopened.snapshot().unappliedNotices.map((n) => n.eventId)).toEqual([
      notices[1]?.eventId,
    ])
  })

  it('the register close waits while any of the money is unconfirmed and no notice is lost on the way', async () => {
    const { one, shift1 } = await lateCharges(2)
    const during = await locals(one.floor)
    expect(pendingMoneyOf(during, shift1)).toBe(2)
    // Back online, the hub confirms them one after another: the count never goes up, and ends at 0.
    one.floor.simulateOffline(false)
    let last = 2
    for (let t = 0; t < 20_000 && last > 0; t += 100) {
      await advance(100)
      const now = pendingMoneyOf(await locals(one.floor), shift1)
      expect(now).toBeLessThanOrEqual(last)
      last = now
    }
    expect(last).toBe(0)
    await until(() => one.floor.snapshot().unappliedNotices.length === 2)
  })
})
