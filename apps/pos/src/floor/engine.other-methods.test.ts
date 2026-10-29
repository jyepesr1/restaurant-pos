import 'fake-indexeddb/auto'
import { newId, otherMethodsReconciliation, signEvent } from '@pos/core'
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
import { type CheckoutRules, registerReconciliation, shiftOfRegister, shiftSummary } from './checks'
import { type Device, Floor, type Session } from './engine'
import { shiftCloseMethods, withSign } from './Register'
import { DeviceDatabase } from './store'
import { itemData, testCatalog } from './testing'

// End to end, in memory (task 1.8): the register (engine + IndexedDB) talks to an in-memory hub
// with the checkout rules. Open shift → charge by card and Nequi → count with the card terminal's
// and the app's closing reports → close confirmed; and with a different report, which asks for a
// justification. The close is built the way the register screen does it (`shiftCloseMethods`,
// `withSign`, `otherMethodsReconciliation`). Timers are fake: nothing really waits.

const T0 = new Date('2026-10-26T15:00:00.000Z')
const SODEXO = newId()
const RULES: CheckoutRules = {
  paymentMethods: ['cash', 'card', 'nequi'],
  customMethods: [{ id: SODEXO, name: 'Sodexo' }],
  suggestedTip: 1000,
  roundingMode: 'half_up',
  cashRounding: 100,
  cashRoundingMode: 'nearest_half_down',
  printsPreBill: false,
}
const CARD_TERMINAL = newId()
const CATALOG = testCatalog({
  cardTerminals: [{ id: CARD_TERMINAL, name: 'Datáfono 1', provider: 'bold' }],
})

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
/** Lets the simulated clock run until the promise settles (either way). */
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
      customMethods: [SODEXO],
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
  await db.saveSetting('catalog', CATALOG)
  const floor = new Floor({ db, open: (m) => h.open(m) })
  floors.push(floor)
  await floor.load()
  await until(() => floor.snapshot().connection === 'connected')
  return { floor, e }
}

const locals = async (s: Floor) => (await s.sync?.locals()) ?? []
const noPending = (s: Floor) => s.snapshot().pendingList === 0

/** An order of two products totaling $100.050, already in the hub. */
async function orderOfHundred(floor: Floor) {
  const order = newId()
  await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
  await floor.record('ItemAdded', order, itemData({ unit_price: 60_050, name: 'Tagliata' }))
  await floor.record('ItemAdded', order, itemData({ unit_price: 40_000, name: 'Pizza' }))
  await until(() => noPending(floor))
  return order
}

const tallyOf = (counted: number) =>
  [
    { value: 100_000, quantity: Math.floor(counted / 100_000) },
    { value: 50, quantity: (counted % 100_000) / 50 },
  ].filter((c) => c.quantity > 0)

const message = (r: { ok: boolean }) => (r as unknown as { error: Error }).error.message

/** A partial payment of `amount` with the given method, no rounding: card, Nequi or Sodexo. */
const payment = (shift: string, method: 'card' | 'nequi' | 'own', amount: number, tip = 0) => ({
  payment_id: newId(),
  check_id: null,
  register_shift_id: shift,
  method: method === 'own' ? ('other' as const) : method,
  ...(method === 'own' ? { custom_method_id: SODEXO } : {}),
  amount,
  tip,
  tendered: null,
  change: null,
  rounding_adjustment: 0,
  rounding: null,
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
})

/** A shift with a $50.000 float and a $100.050 order charged by card (60.050 + 6.000) and Nequi. */
async function shiftCharged(h: Hub) {
  const { floor, e } = await register(h)
  const shift = await floor.openShift(50_000)
  const order = await orderOfHundred(floor)
  expect(
    (
      await resolve(
        floor.recordConfirmed('PaymentRecorded', order, payment(shift, 'card', 60_050, 6_000)),
      )
    ).ok,
  ).toBe(true)
  expect(
    (
      await resolve(
        floor.recordConfirmed('PaymentRecorded', order, payment(shift, 'nequi', 40_000)),
      )
    ).ok,
  ).toBe(true)
  await until(() => noPending(floor))
  return { floor, e, shift, order }
}

/**
 * What the close screen does: builds the methods, reads what was typed, saves the count and closes
 * with the lines that come out of the count. Returns the result of each step.
 */
async function closeAsRegister(
  floor: Floor,
  shift: string,
  counted: number,
  written: Record<string, string>,
  justification: string | null = null,
) {
  const savedList = await locals(floor)
  const reconciliation = registerReconciliation(savedList, shift)
  if (!reconciliation) throw new Error('No reconciliation')
  const methods = shiftCloseMethods(RULES, reconciliation, CATALOG)
  const reportedMethods = methods.map((m) => ({
    method: m.method,
    custom_method_id: m.customMethodId,
    reported: withSign(written[m.key] ?? ''),
  }))
  const cashCount = newId()
  const tally = await resolve(
    floor.recordConfirmed('CashCountRecorded', shift, {
      cash_count_id: cashCount,
      tally: tallyOf(counted),
      counted_cash: counted,
      others: reportedMethods,
    }),
  )
  const others = otherMethodsReconciliation(reconciliation, {
    id: cashCount,
    tally: [],
    counted,
    others: reportedMethods.map((r) => ({
      method: r.method,
      customMethodId: r.custom_method_id,
      reported: r.reported,
    })),
    time: '',
  })
  const closeout = await resolve(
    floor.recordConfirmed('ShiftClosed', shift, {
      cash_count_id: cashCount,
      expected_cash: reconciliation.cash.expected,
      counted_cash: counted,
      variance: counted - reconciliation.cash.expected,
      justification,
      other_methods: others.map((o) => ({
        method: o.method,
        custom_method_id: o.customMethodId,
        expected: o.expected,
        reported: o.reported,
        variance: o.variance,
      })),
    }),
  )
  return { tally, closeout, others, cashCount, methods, reconciliation }
}

describe('end to end (1.8): open shift → charge by card and Nequi → count with the reports → close', () => {
  it('with matching reports: it is confirmed, saved and the shift closes', async () => {
    const h = setupHub()
    const { floor, e, shift } = await shiftCharged(h)

    // The register and the hub see the same thing before closing.
    const before = registerReconciliation(await locals(floor), shift)
    expect(before?.byMethod).toEqual([
      { method: 'card', customMethodId: null, sale: 60_050, tip: 6_000, payments: 1 },
      { method: 'nequi', customMethodId: null, sale: 40_000, tip: 0, payments: 1 },
    ])
    expect(h.hub.reconciliation(shift)).toEqual(before)

    const r = await closeAsRegister(floor, shift, 50_000, {
      'card:': '66.050',
      'nequi:': '40.000',
    })
    expect(r.methods.map((m) => m.key)).toEqual(['card:', 'nequi:', `other:${SODEXO}`])
    expect(r.tally.ok).toBe(true)
    expect(r.closeout.ok).toBe(true)
    expect(r.others).toEqual([
      { method: 'card', customMethodId: null, expected: 66_050, reported: 66_050, variance: 0 },
      { method: 'nequi', customMethodId: null, expected: 40_000, reported: 40_000, variance: 0 },
    ])
    await until(() => noPending(floor))

    expect(h.hub.openShift(e.deviceId)).toBeNull()
    const savedList = await locals(floor)
    expect(savedList.every((l) => l.status === 'confirmed')).toBe(true)
    expect(shiftOfRegister(savedList, e.deviceId)).toBeNull()
    expect(registerReconciliation(savedList, shift)?.closed).toMatchObject({
      expected: 50_000,
      counted: 50_000,
      variance: 0,
      otherMethods: r.others,
    })
    expect(shiftSummary(savedList, shift).byMethod.map((m) => [m.method, m.sale + m.tip])).toEqual([
      ['card', 66_050],
      ['nequi', 40_000],
    ])
  })

  it('Sodexo with no charges and nothing typed does not count: the close omits it', async () => {
    const h = setupHub()
    const { floor, shift } = await shiftCharged(h)
    const r = await closeAsRegister(floor, shift, 50_000, {
      'card:': '66.050',
      'nequi:': '40.000',
    })
    expect(r.others.map((o) => o.method)).toEqual(['card', 'nequi'])
    expect(r.closeout.ok).toBe(true)
  })

  it('with a different report: the hub asks for a justification and closes with it', async () => {
    const h = setupHub()
    const { floor, e, shift } = await shiftCharged(h)
    const without = await closeAsRegister(floor, shift, 50_000, {
      'card:': '66.050',
      'nequi:': '35.000',
    })
    expect(without.others.find((o) => o.method === 'nequi')).toMatchObject({
      expected: 40_000,
      reported: 35_000,
      variance: -5_000,
    })
    expect(without.closeout.ok).toBe(false)
    expect(message(without.closeout)).toBe('Escribe por qué no cuadra la caja.')
    // The shift stays open here and in the hub; the rejected close stays visible.
    expect(h.hub.openShift(e.deviceId)).not.toBeNull()
    let savedList = await locals(floor)
    expect(shiftOfRegister(savedList, e.deviceId)?.id).toBe(shift)
    expect(savedList.filter((l) => l.status === 'rejected').map((l) => l.reason)).toEqual([
      'missing_justification',
    ])

    // With the same count and a justification.
    const cashCount = without.cashCount
    const withIt = await resolve(
      floor.recordConfirmed('ShiftClosed', shift, {
        cash_count_id: cashCount,
        expected_cash: 50_000,
        counted_cash: 50_000,
        variance: 0,
        justification: 'Nequi no mostró un pago de $5.000',
        other_methods: without.others.map((o) => ({
          method: o.method,
          custom_method_id: o.customMethodId,
          expected: o.expected,
          reported: o.reported,
          variance: o.variance,
        })),
      }),
    )
    expect(withIt.ok).toBe(true)
    await until(() => noPending(floor))
    savedList = await locals(floor)
    expect(shiftOfRegister(savedList, e.deviceId)).toBeNull()
    expect(registerReconciliation(savedList, shift)?.closed).toMatchObject({
      justification: 'Nequi no mostró un pago de $5.000',
      otherMethods: [
        { method: 'card', variance: 0 },
        { method: 'nequi', expected: 40_000, reported: 35_000, variance: -5_000 },
      ],
    })
  })

  it('below the threshold ($999 variance on card) it closes without justification', async () => {
    const h = setupHub()
    const { floor, e, shift } = await shiftCharged(h)
    const r = await closeAsRegister(floor, shift, 50_000, {
      'card:': '65.051',
      'nequi:': '40.000',
    })
    expect(r.closeout.ok).toBe(true)
    expect(h.hub.openShift(e.deviceId)).toBeNull()
  })

  it('a custom method (Sodexo) with a charge and a different typed amount', async () => {
    const h = setupHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(0)
    const order = await orderOfHundred(floor)
    expect(
      (
        await resolve(
          floor.recordConfirmed('PaymentRecorded', order, payment(shift, 'own', 30_000)),
        )
      ).ok,
    ).toBe(true)
    const r = await closeAsRegister(floor, shift, 0, { [`other:${SODEXO}`]: '30.000' })
    expect(r.closeout.ok).toBe(true)
    expect(r.others).toEqual([
      { method: 'other', customMethodId: SODEXO, expected: 30_000, reported: 30_000, variance: 0 },
    ])
    expect(h.hub.openShift(e.deviceId)).toBeNull()
  })

  it('a report typed for a method with no charges (an unrecorded charge): overage that asks for justification', async () => {
    const h = setupHub()
    const { floor, shift } = await shiftCharged(h)
    const r = await closeAsRegister(floor, shift, 50_000, {
      'card:': '66.050',
      'nequi:': '40.000',
      [`other:${SODEXO}`]: '12.000',
    })
    expect(r.others.at(-1)).toMatchObject({
      method: 'other',
      expected: 0,
      reported: 12_000,
      variance: 12_000,
    })
    expect(message(r.closeout)).toBe('Escribe por qué no cuadra la caja.')
  })

  it('a close with the lines of another count (stale): other_methods_mismatch, said in words', async () => {
    const h = setupHub()
    const { floor, e, shift } = await shiftCharged(h)
    const cashCount = newId()
    await resolve(
      floor.recordConfirmed('CashCountRecorded', shift, {
        cash_count_id: cashCount,
        tally: tallyOf(50_000),
        counted_cash: 50_000,
        others: [
          { method: 'card', custom_method_id: null, reported: 66_050 },
          { method: 'nequi', custom_method_id: null, reported: 40_000 },
        ],
      }),
    )
    const r = await resolve(
      floor.recordConfirmed('ShiftClosed', shift, {
        cash_count_id: cashCount,
        expected_cash: 50_000,
        counted_cash: 50_000,
        variance: 0,
        justification: null,
        other_methods: [],
      }),
    )
    expect(message(r)).toBe(
      'Los demás medios no coinciden con lo que registró la caja: recarga la app (puede estar desactualizada) y vuelve a contar.',
    )
    expect(h.hub.openShift(e.deviceId)).not.toBeNull()
  })

  it('a Nequi charge after the count makes the close stale: it says so in words and, after recounting, closes', async () => {
    const h = setupHub()
    const { floor, e, shift } = await shiftCharged(h)
    const firstClose = await closeAsRegister(
      floor,
      shift,
      50_000,
      { 'card:': '66.050', 'nequi:': '40.000' },
      null,
    )
    // That close was accepted; to test the mismatch another shift is set up.
    expect(firstClose.closeout.ok).toBe(true)

    const t2 = await floor.openShift(0)
    const order = await orderOfHundred(floor)
    expect(
      (await resolve(floor.recordConfirmed('PaymentRecorded', order, payment(t2, 'nequi', 10_000))))
        .ok,
    ).toBe(true)
    const cashCount = newId()
    await resolve(
      floor.recordConfirmed('CashCountRecorded', t2, {
        cash_count_id: cashCount,
        tally: [],
        counted_cash: 0,
        others: [{ method: 'nequi', custom_method_id: null, reported: 10_000 }],
      }),
    )
    expect(
      (await resolve(floor.recordConfirmed('PaymentRecorded', order, payment(t2, 'nequi', 5_000))))
        .ok,
    ).toBe(true)
    const late = await resolve(
      floor.recordConfirmed('ShiftClosed', t2, {
        cash_count_id: cashCount,
        expected_cash: 0,
        counted_cash: 0,
        variance: 0,
        justification: null,
        other_methods: [
          {
            method: 'nequi',
            custom_method_id: null,
            expected: 10_000,
            reported: 10_000,
            variance: 0,
          },
        ],
      }),
    )
    expect(message(late)).toBe('Hubo pagos o movimientos después del conteo: vuelve a contar.')
    expect(h.hub.openShift(e.deviceId)?.id).toBe(t2)
    const another = await closeAsRegister(floor, t2, 0, { 'nequi:': '15.000', 'card:': '' })
    expect(another.closeout.ok).toBe(true)
    expect(h.hub.openShift(e.deviceId)).toBeNull()
  })
})
