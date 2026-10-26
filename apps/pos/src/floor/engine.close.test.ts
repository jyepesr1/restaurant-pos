import 'fake-indexeddb/auto'
import { newId, signEvent } from '@pos/core'
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
  registerReconciliation,
  shiftOfRegister,
  shiftSummary,
} from './checks'
import { type Device, Floor, type Session } from './engine'
import { DeviceDatabase } from './store'
import { itemData, testCatalog } from './testing'

// End to end, in memory (task 1.7): the register (engine + IndexedDB) talks to an in-memory hub
// with the checkout rules. Open shift → cash checkout → cash in → tip payout → cash count →
// confirmed close → new shift; and the closes the hub rejects, explained in words. The
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
  const db = new DeviceDatabase(`closeout-${newId()}`)
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
      'cash_movement',
      'close_register_shift',
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

const TODAY = '2026-10-26'

/** A cash checkout of the $100.050 order: 100.000 is charged (−50) plus a 5.000 tip. */
const cashCharge = (shift: string) => paymentData(shift, null, 'cash', 100_050, 5_000, 105_000)

const tallyOf = (counted: number) =>
  [
    { value: 100_000, quantity: Math.floor(counted / 100_000) },
    { value: 50, quantity: (counted % 100_000) / 50 },
  ].filter((c) => c.quantity > 0)

async function count(floor: Floor, shift: string, counted: number) {
  const cashCount = newId()
  const r = await resolve(
    floor.recordConfirmed('CashCountRecorded', shift, {
      cash_count_id: cashCount,
      tally: tallyOf(counted),
      counted_cash: counted,
    }),
  )
  return { cashCount, r }
}

const closeData = (
  cashCount: string,
  expected: number,
  counted: number,
  justification: string | null = null,
) => ({
  cash_count_id: cashCount,
  expected_cash: expected,
  counted_cash: counted,
  variance: counted - expected,
  justification,
})

const message = (r: { ok: boolean }) => (r as unknown as { error: Error }).error.message

describe('end to end: open shift → checkout → cash in → tips → cash count → close → new shift', () => {
  it('everything is confirmed, the shift closes with variance 0 and the register opens another', async () => {
    const h = setupHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(200_000)
    await until(() => noPending(floor))

    const order = await orderOfHundred(floor)
    const payment = cashCharge(shift)
    expect(payment).toMatchObject({ rounding_adjustment: -50, change: 0, tendered: 105_000 })
    expect((await resolve(floor.recordConfirmed('PaymentRecorded', order, payment))).ok).toBe(true)
    expect((await resolve(floor.recordConfirmed('OrderClosed', order, {}))).ok).toBe(true)

    const entry = await resolve(
      floor.recordConfirmed('CashMovementRecorded', shift, {
        movement_id: newId(),
        type: 'entry',
        amount: 20_000,
        description: 'Cambio para el turno',
        to_whom: null,
        days: [],
      }),
    )
    expect(entry.ok).toBe(true)
    const tips = await resolve(
      floor.recordConfirmed('CashMovementRecorded', shift, {
        movement_id: newId(),
        type: 'tip_payout',
        amount: 5_000,
        description: 'Propinas de hoy',
        to_whom: 'Equipo de sala',
        days: [TODAY],
      }),
    )
    expect(tips.ok).toBe(true)

    // 200.000 + (100.000 + 5.000) + 20.000 − 5.000 = 320.000, at the register and in the hub.
    const before = registerReconciliation(await locals(floor), shift)
    expect(before?.cash).toMatchObject({
      charged: 105_000,
      entries: 20_000,
      tipPayouts: 5_000,
      expected: 320_000,
    })
    expect(h.hub.reconciliation(shift)).toEqual(before)

    const { cashCount, r: tally } = await count(floor, shift, 320_000)
    expect(tally.ok).toBe(true)
    const closeout = await resolve(
      floor.recordConfirmed('ShiftClosed', shift, closeData(cashCount, 320_000, 320_000)),
    )
    expect(closeout.ok).toBe(true)
    await until(() => noPending(floor))

    // Closed in the hub and at the register; what is saved here is confirmed.
    expect(h.hub.openShift(e.deviceId)).toBeNull()
    const savedList = await locals(floor)
    expect(savedList.every((l) => l.status === 'confirmed')).toBe(true)
    expect(shiftOfRegister(savedList, e.deviceId)).toBeNull()
    expect(registerReconciliation(savedList, shift)?.closed).toMatchObject({
      expected: 320_000,
      counted: 320_000,
      variance: 0,
    })
    expect(shiftSummary(savedList, shift).byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 100_000, tip: 5_000, payments: 1 },
    ])

    // One more payment to that shift no longer gets in, and it is explained in words.
    const anotherOrder = await orderOfHundred(floor)
    const late = await resolve(
      floor.recordConfirmed(
        'PaymentRecorded',
        anotherOrder,
        paymentData(shift, null, 'nequi', 100_050, 0),
      ),
    )
    expect(message(late)).toBe('La caja no tiene turno abierto: ábrela en «Caja».')

    // The new shift starts from zero.
    const fresh = await floor.openShift(50_000)
    await until(() => noPending(floor))
    expect(h.hub.openShift(e.deviceId)).toMatchObject({ id: fresh, base: 50_000 })
    const after = await locals(floor)
    expect(shiftOfRegister(after, e.deviceId)).toMatchObject({ id: fresh, base: 50_000 })
    expect(registerReconciliation(after, fresh)).toMatchObject({
      cash: { charged: 0, entries: 0, expected: 50_000 },
      byMethod: [],
      cashCounts: [],
      closed: null,
    })
  })

  it('a shortage of $1.000 or more without justification is rejected by the hub and closes with one', async () => {
    const h = setupHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(100_000)
    const { cashCount } = await count(floor, shift, 98_000)
    const without = await resolve(
      floor.recordConfirmed('ShiftClosed', shift, closeData(cashCount, 100_000, 98_000)),
    )
    expect(message(without)).toBe('Escribe por qué no cuadra la caja.')
    // The shift stays open here and in the hub, and the rejected close stays in view.
    expect(h.hub.openShift(e.deviceId)).not.toBeNull()
    const savedList = await locals(floor)
    expect(shiftOfRegister(savedList, e.deviceId)?.id).toBe(shift)
    expect(savedList.filter((l) => l.status === 'rejected').map((l) => l.reason)).toEqual([
      'missing_justification',
    ])
    const withIt = await resolve(
      floor.recordConfirmed(
        'ShiftClosed',
        shift,
        closeData(cashCount, 100_000, 98_000, 'Se pagó un domicilio'),
      ),
    )
    expect(withIt.ok).toBe(true)
    expect(shiftOfRegister(await locals(floor), e.deviceId)).toBeNull()
  })

  it('a shortage below the threshold ($999) closes without justification', async () => {
    const h = setupHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(100_000)
    const { cashCount } = await count(floor, shift, 99_050)
    const r = await resolve(
      floor.recordConfirmed('ShiftClosed', shift, closeData(cashCount, 100_000, 99_050)),
    )
    expect(r.ok).toBe(true)
    expect(h.hub.openShift(e.deviceId)).toBeNull()
  })
})

describe('the rejected close, with the reason in words', () => {
  /** Shift with a cash checkout (expected 305.000: base 200.000 + 105.000) and a count. */
  async function ready() {
    const h = setupHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(200_000)
    const order = await orderOfHundred(floor)
    await resolve(floor.recordConfirmed('PaymentRecorded', order, cashCharge(shift)))
    const { cashCount } = await count(floor, shift, 305_000)
    return { h, floor, e, shift, cashCount }
  }

  it('with a stale expected amount (without the tip): expected_mismatch', async () => {
    const t = await ready()
    const r = await resolve(
      t.floor.recordConfirmed(
        'ShiftClosed',
        t.shift,
        closeData(t.cashCount, 300_000, 305_000, 'x'),
      ),
    )
    expect(message(r)).toBe(
      'La caja registró algo que este equipo aún no tenía: espera un momento y vuelve a contar.',
    )
    expect(t.h.hub.openShift(t.e.deviceId)).not.toBeNull()
    expect(shiftOfRegister(await locals(t.floor), t.e.deviceId)?.id).toBe(t.shift)
  })

  it('with a count that does not exist: cash_count_not_found', async () => {
    const t = await ready()
    const r = await resolve(
      t.floor.recordConfirmed('ShiftClosed', t.shift, closeData(newId(), 305_000, 305_000)),
    )
    expect(message(r)).toBe('La caja no tiene ese conteo: vuelve a contar.')
  })

  it('with a counted amount different from the count: counted_mismatch', async () => {
    const t = await ready()
    const r = await resolve(
      t.floor.recordConfirmed(
        'ShiftClosed',
        t.shift,
        closeData(t.cashCount, 305_000, 300_000, 'x'),
      ),
    )
    expect(message(r)).toBe('Lo contado no coincide con el conteo guardado: vuelve a contar.')
  })

  it('with a count that is not the latest: cash_count_not_latest', async () => {
    const t = await ready()
    await count(t.floor, t.shift, 305_000)
    const r = await resolve(
      t.floor.recordConfirmed('ShiftClosed', t.shift, closeData(t.cashCount, 305_000, 305_000)),
    )
    expect(message(r)).toBe('La caja se cierra con el último conteo: vuelve a contar.')
  })

  it('with money moved after the count: stale_cash_count', async () => {
    const t = await ready()
    await resolve(
      t.floor.recordConfirmed('CashMovementRecorded', t.shift, {
        movement_id: newId(),
        type: 'output',
        amount: 5_000,
        description: 'Hielo',
        to_whom: null,
        days: [],
      }),
    )
    const r = await resolve(
      t.floor.recordConfirmed(
        'ShiftClosed',
        t.shift,
        closeData(t.cashCount, 300_000, 305_000, 'x'),
      ),
    )
    expect(message(r)).toBe('Hubo pagos o movimientos después del conteo: vuelve a contar.')
    // Counting again, it closes.
    const fresh = await count(t.floor, t.shift, 300_000)
    const ok = await resolve(
      t.floor.recordConfirmed('ShiftClosed', t.shift, closeData(fresh.cashCount, 300_000, 300_000)),
    )
    expect(ok.ok).toBe(true)
  })

  it('a movement or a count without an open shift: no_shift', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const shift = newId()
    const m = await resolve(
      floor.recordConfirmed('CashMovementRecorded', shift, {
        movement_id: newId(),
        type: 'entry',
        amount: 1_000,
        description: 'x',
        to_whom: null,
        days: [],
      }),
    )
    expect(message(m)).toBe('La caja no tiene turno abierto: ábrela en «Caja».')
    expect(message((await count(floor, shift, 1_000)).r)).toBe(
      'La caja no tiene turno abierto: ábrela en «Caja».',
    )
  })

  it('the rejected movement disappears from the register reconciliation', async () => {
    const t = await ready()
    const another = await register(t.h, 'Caja 2')
    // The other register tries to move cash in this one's shift.
    const r = await resolve(
      another.floor.recordConfirmed('CashMovementRecorded', t.shift, {
        movement_id: newId(),
        type: 'entry',
        amount: 1_000,
        description: 'x',
        to_whom: null,
        days: [],
      }),
    )
    expect(message(r)).toBe('Ese turno es de otra caja: cobra desde la caja donde se abrió.')
    expect(t.h.hub.reconciliation(t.shift)?.cash.entries).toBe(0)
  })
})

describe('offline', () => {
  it('the close stays pending: the shift stays open here until the hub accepts it', async () => {
    const h = setupHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(10_000)
    await until(() => noPending(floor))
    const { cashCount } = await count(floor, shift, 10_000)

    floor.simulateOffline(true)
    const r = await resolve(
      floor.recordConfirmed('ShiftClosed', shift, closeData(cashCount, 10_000, 10_000)),
    )
    expect(message(r)).toMatch(/Quedó pendiente/)
    const pending = await locals(floor)
    expect(pending.at(-1)).toMatchObject({ status: 'pending' })
    expect(shiftOfRegister(pending, e.deviceId)?.id).toBe(shift)
    expect(h.hub.openShift(e.deviceId)).not.toBeNull()

    floor.simulateOffline(false)
    await until(() => noPending(floor))
    expect(h.hub.openShift(e.deviceId)).toBeNull()
    expect(shiftOfRegister(await locals(floor), e.deviceId)).toBeNull()
    // It arrived only once.
    const closings = (await locals(floor)).filter((l) => l.event.type === 'ShiftClosed')
    expect(closings).toHaveLength(1)
  })

  it('a movement made offline adds to the local reconciliation on save and is confirmed on return', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const shift = await floor.openShift(10_000)
    await until(() => noPending(floor))
    floor.simulateOffline(true)
    await floor.record('CashMovementRecorded', shift, {
      movement_id: newId(),
      type: 'output',
      amount: 3_000,
      description: 'Taxi',
      to_whom: null,
      days: [],
    })
    expect(registerReconciliation(await locals(floor), shift)?.cash.expected).toBe(7_000)
    expect(h.hub.reconciliation(shift)?.cash.expected).toBe(10_000)
    floor.simulateOffline(false)
    await until(() => noPending(floor))
    expect(h.hub.reconciliation(shift)?.cash.expected).toBe(7_000)
  })
})
