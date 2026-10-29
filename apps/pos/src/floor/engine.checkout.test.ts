import 'fake-indexeddb/auto'
import { newId, orderTotals, signEvent } from '@pos/core'
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
import {
  type CheckoutRules,
  cashPayment,
  inEqualParts,
  shiftOfRegister,
  shiftSummary,
} from './checks'
import { type Device, Floor, type Session } from './engine'
import { openOrders } from './projection'
import { DeviceDatabase } from './store'
import { itemData, testCatalog } from './testing'

// End to end, in memory: the register (engine + IndexedDB) talks to a memory hub with the
// checkout rules. Open shift → split → two payments (cash and card) → close the order. The
// timers are fake: nothing really waits.

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
/** Lets the simulated clock run until the promise settles (resolved or rejected). */
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
  const db = new DeviceDatabase(`checkout-${newId()}`)
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
      'split_check',
      'open_register_shift',
    ],
    lastUsed: Date.now(),
  }
  await db.saveSetting('device', e)
  await db.saveSetting('session', session)
  await db.saveSetting('catalog', testCatalog())
  const floor = new Floor({ db, open: (m) => h.open(m) })
  floors.push(floor)
  await floor.load()
  await until(() => floor.snapshot().connection === 'connected')
  return { floor, e }
}

const locals = async (s: Floor) => (await s.sync?.locals()) ?? []
const stateOf = async (s: Floor, id: string) =>
  openOrders(await locals(s)).find((p) => p.status.id === id)?.status ?? null
const noPending = (s: Floor) => s.snapshot().pendingList === 0

/** An order of two products adding up to $100.050, already in the hub. */
async function orderOfHundred(floor: Floor) {
  const order = newId()
  await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
  await floor.record('ItemAdded', order, itemData({ unit_price: 60_050, name: 'Tagliata' }))
  await floor.record('ItemAdded', order, itemData({ unit_price: 40_000, name: 'Pizza' }))
  await until(() => noPending(floor))
  return order
}

const paymentData = (
  shift: string,
  checkId: string | null,
  method: 'cash' | 'card' | 'nequi',
  balance: number,
  tip: number,
  tendered = 0,
) => {
  const c = cashPayment({ balance, amount: balance, tip, tendered }, RULES)
  const served = tendered || c.amountDue
  const f = cashPayment({ balance, amount: balance, tip, tendered: served }, RULES)
  return {
    payment_id: newId(),
    check_id: checkId,
    register_shift_id: shift,
    method,
    amount: balance,
    tip,
    tendered: method === 'cash' ? served : null,
    change: method === 'cash' ? f.change : null,
    rounding_adjustment: method === 'cash' ? f.adjustment : 0,
    rounding: method === 'cash' ? f.rounding : null,
    cardTerminal:
      method === 'card'
        ? {
            card_terminal_id: CARD_TERMINAL,
            franchise: null,
            last4: null,
            approval_code: null,
            receipt: null,
            card_type: 'credit' as const,
          }
        : null,
    charge_reference: null,
  }
}

describe('end to end: open shift → split → cash and card → close', () => {
  it('everything is confirmed, the order is closed and the shift summary reconciles', async () => {
    const h = setupHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(200_000)
    await until(() => noPending(floor))
    expect(h.hub.openShift(e.deviceId)).toMatchObject({ id: shift, base: 200_000 })

    const order = await orderOfHundred(floor)
    const status = await stateOf(floor, order)
    if (!status) throw new Error('no order')
    const checks = inEqualParts(status, 2, RULES, newId)
    expect(checks.map((c) => c.amount)).toEqual([50_025, 50_025])
    await floor.record('CheckSplit', order, { checks })
    await until(() => noPending(floor))

    // Check 1 in cash: 50.025 is charged as 50.000 (−25) with the rounded tip.
    const p1 = paymentData(shift, checks[0]?.check_id as string, 'cash', 50_025, 4_600, 60_000)
    expect(p1).toMatchObject({ rounding_adjustment: -25, change: 5_400 })
    const r1 = await resolve(floor.recordConfirmed('PaymentRecorded', order, p1))
    expect(r1.ok).toBe(true)

    // Check 2 by card.
    const p2 = paymentData(shift, checks[1]?.check_id as string, 'card', 50_025, 4_629)
    const r2 = await resolve(floor.recordConfirmed('PaymentRecorded', order, p2))
    expect(r2.ok).toBe(true)

    const closeout = await resolve(floor.recordConfirmed('OrderClosed', order, {}))
    expect(closeout.ok).toBe(true)
    await until(() => noPending(floor))

    const closed = h.hub.order(order)
    expect(closed?.status).toBe('closed')
    expect(orderTotals(closed as never)).toMatchObject({
      balance: 0,
      paid: 100_050,
      roundingAdjustments: -25,
      tips: 9_229,
    })
    // The order is no longer open on the register and everything saved here is confirmed.
    expect(await stateOf(floor, order)).toBeNull()
    const savedList = await locals(floor)
    expect(savedList.every((l) => l.status === 'confirmed')).toBe(true)
    expect(savedList.map((l) => l.event.type)).toEqual([
      'ShiftOpened',
      'OrderOpened',
      'ItemAdded',
      'ItemAdded',
      'CheckSplit',
      'PaymentRecorded',
      'PaymentRecorded',
      'OrderClosed',
    ])
    const summary = shiftSummary(savedList, shift)
    expect(summary.payments).toBe(2)
    expect(summary.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 50_000, tip: 4_600, payments: 1 },
      { method: 'card', customMethodId: null, sale: 50_025, tip: 4_629, payments: 1 },
    ])
    expect(shiftOfRegister(savedList, e.deviceId)).toMatchObject({
      id: shift,
      pendingConfirmation: false,
    })
  })

  it('closing with a pending balance: the hub rejects it and recordConfirmed throws the reason in words', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const shift = await floor.openShift(0)
    const order = await orderOfHundred(floor)
    const partial = paymentData(shift, null, 'nequi', 100_050, 0)
    const r = await resolve(
      floor.recordConfirmed('PaymentRecorded', order, { ...partial, amount: 50_000 }),
    )
    expect(r.ok).toBe(true)
    const closeout = await resolve(floor.recordConfirmed('OrderClosed', order, {}))
    expect(closeout).toMatchObject({ ok: false })
    expect((closeout as { error: Error }).error.message).toBe(
      'Todavía queda saldo: alguien agregó algo mientras cobrabas.',
    )
    expect(h.hub.order(order)?.status).toBe('open')
  })

  it('charging without an open shift: the hub rejects it with «no_shift» put in words and the payment disappears', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const order = await orderOfHundred(floor)
    const fake = newId()
    const r = await resolve(
      floor.recordConfirmed('PaymentRecorded', order, paymentData(fake, null, 'nequi', 100_050, 0)),
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: Error }).error.message).toBe(
      'La caja no tiene turno abierto: ábrela en «Caja».',
    )
    expect(Object.keys((await stateOf(floor, order))?.payments ?? {})).toEqual([])
  })

  it('a second shift of the same register is rejected (shift_already_open) and the first one continues', async () => {
    const h = setupHub()
    const { floor, e } = await register(h)
    const firstOne = await floor.openShift(100)
    await until(() => noPending(floor))
    await floor.openShift(999)
    await until(() => noPending(floor))
    expect(h.hub.openShift(e.deviceId)).toMatchObject({ id: firstOne, base: 100 })
    const rejectedList = (await locals(floor)).filter((l) => l.status === 'rejected')
    expect(rejectedList).toHaveLength(1)
    expect(rejectedList[0]?.reason).toBe('shift_already_open')
    expect(shiftOfRegister(await locals(floor), e.deviceId)?.id).toBe(firstOne)
  })

  it('a card with a card terminal that no longer exists is rejected with its message', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const shift = await floor.openShift(0)
    const order = await orderOfHundred(floor)
    const payment = paymentData(shift, null, 'card', 100_050, 0)
    const r = await resolve(
      floor.recordConfirmed('PaymentRecorded', order, {
        ...payment,
        cardTerminal: { ...(payment.cardTerminal as object), card_terminal_id: newId() } as never,
      }),
    )
    expect((r as { error: Error }).error.message).toBe('Ese datáfono ya no está: elige otro.')
  })

  it('the same payment resent (same payment_id) is not charged twice', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const shift = await floor.openShift(0)
    const order = await orderOfHundred(floor)
    const partial = { ...paymentData(shift, null, 'nequi', 100_050, 0), amount: 30_000 }
    await resolve(floor.recordConfirmed('PaymentRecorded', order, partial))
    const another = await resolve(floor.recordConfirmed('PaymentRecorded', order, partial))
    expect(another).toMatchObject({ ok: false })
    expect(Object.keys(h.hub.order(order)?.payments ?? {})).toHaveLength(1)
    expect(orderTotals(h.hub.order(order) as never).paid).toBe(30_000)
  })

  it('without the hub answering, recordConfirmed fails saying it stayed pending (do not charge again)', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const shift = await floor.openShift(0)
    const order = await orderOfHundred(floor)
    floor.simulateOffline(true)
    const r = await resolve(
      floor.recordConfirmed(
        'PaymentRecorded',
        order,
        paymentData(shift, null, 'nequi', 100_050, 0),
      ),
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: Error }).error.message).toMatch(/Quedó pendiente/)
    // It was saved here: when the connection comes back it reaches the hub only once.
    floor.simulateOffline(false)
    await until(() => noPending(floor))
    expect(Object.keys(h.hub.order(order)?.payments ?? {})).toHaveLength(1)
  })
})
