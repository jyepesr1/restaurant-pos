import { newId, type OrderEvent } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { HubSync } from './hub/hub'
import { SqliteStore } from './hub/store-sqlite'
import { openAccess } from './testing/access'
import type { NetNode } from './testing/network'
import { CrashingStore, item, NOW, type Setup, seeTheSame, setup } from './testing/setup'

// Register rules in the hub (task 1.6, `registerIssue`): one open shift per register, payments,
// voids and refunds within the shift of the register that records them, and the restaurant's cash
// rounding. The shift lives in memory and is rebuilt from the events on restart.

const ROUNDING = { multiple: 100, mode: 'nearest_half_down' }
/** The restaurant's active card terminal in these tests. */
const CARD_TERMINAL = newId()
const RULES = {
  ...ROUNDING,
  methods: ['cash', 'card', 'nequi', 'daviplata', 'breb', 'transfer'],
  cardTerminals: [CARD_TERMINAL],
}
type Rules = {
  multiple: number
  mode: string
  methods: string[]
  customMethods?: string[]
  cardTerminals: string[]
}

const connectionOf = (m: Setup, node: NetNode) => {
  const connection = m.network.tokens.get(`token-${node.name}`)
  if (!connection) throw new Error(`No token for ${node.name}`)
  return connection
}

/** A hub with the restaurant's checkout rules over the setup's store. */
function hubWithRules(m: Setup, rules: () => Rules = () => RULES) {
  return new HubSync(m.store, {
    restaurantId: m.restaurantId,
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    access: openAccess,
    instance: 'hub-1',
    clock: m.network.isoTime,
    checkoutRules: rules,
  })
}

function device(options: { rules?: boolean } = {}) {
  const m = setup()
  const register = m.network.device('register')
  const register2 = m.network.device('register2')
  const ana = m.network.device('ana')
  const status: { hub: HubSync } = {
    hub: options.rules === false ? m.hub() : hubWithRules(m),
  }

  const raw = (
    node: NetNode,
    type: string,
    aggregate: string,
    data: unknown,
    extras: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: newId(),
    type,
    schema_version: 1,
    aggregate_type: type === 'ShiftOpened' ? 'register_shift' : 'order',
    aggregate_id: aggregate,
    related: [],
    data,
    session_id: null,
    user_id: node.userId,
    device_id: node.deviceId,
    authorization_id: null,
    reason: type === 'PaymentVoided' || type === 'RefundRecorded' ? 'Prueba' : null,
    device_time: NOW,
    hub_estimated_time: NOW,
    base_sequence: m.store.maxSequence(),
    ...extras,
  })
  const send = (node: NetNode, events: Record<string, unknown>[]) =>
    status.hub.receiveBatch(connectionOf(m, node), events)
  const one = (node: NetNode, event: Record<string, unknown>) => send(node, [event]).results[0]

  const openShift = (node: NetNode, base = 200_000, shift = newId()) => {
    const r = one(node, raw(node, 'ShiftOpened', shift, { register_id: node.deviceId, base }))
    return { shift, result: r }
  }
  const openOrder = (node: NetNode, price: number) => {
    const order = newId()
    one(node, raw(node, 'OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 }))
    one(node, raw(node, 'ItemAdded', order, item(price)))
    return order
  }
  const cardPaymentData = (shift: string, amount: number, fields: object = {}) => ({
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    method: 'card',
    amount,
    tip: 0,
    tendered: null,
    change: null,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: {
      card_terminal_id: CARD_TERMINAL,
      franchise: 'Visa',
      last4: '4242',
      approval_code: null,
      receipt: null,
    },
    charge_reference: null,
    ...fields,
  })
  /** Cash that settles the balance `amount`, with the adjustment given by the restaurant's rule. */
  const cashPaymentData = (
    shift: string,
    amount: number,
    adjustment: number,
    rounding: object | null,
  ) => ({
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    method: 'cash',
    amount,
    tip: 0,
    tendered: amount + adjustment,
    change: 0,
    rounding_adjustment: adjustment,
    rounding,
    cardTerminal: null,
    charge_reference: null,
  })
  return {
    m,
    register,
    register2,
    ana,
    status,
    raw,
    send,
    one,
    openShift,
    openOrder,
    cardPaymentData,
    cashPaymentData,
  }
}

const reason = (r: unknown) => (r as { status: string; reason?: string }).reason
const stateOf = (r: unknown) => (r as { status: string }).status

describe('register shift: one per register', () => {
  it('opens the shift: confirmed, and the hub remembers it with its base, who and when', () => {
    const { register, status, openShift } = device()
    const { shift, result } = openShift(register, 150_000)
    expect(result).toMatchObject({ status: 'confirmed' })
    expect(status.hub.openShift(register.deviceId)).toEqual({
      id: shift,
      registerId: register.deviceId,
      base: 150_000,
      openedAt: expect.any(String),
      userId: register.userId,
    })
  })

  it('a register with no shift has no open shift', () => {
    const { register, ana, status } = device()
    expect(status.hub.openShift(register.deviceId)).toBeNull()
    expect(status.hub.openShift(ana.deviceId)).toBeNull()
    expect(status.hub.openShift(newId())).toBeNull()
  })

  it('a second shift on the same register is rejected with shift_already_open and the first stays', () => {
    const { m, register, status, openShift } = device()
    const firstOne = openShift(register)
    const before = m.store.maxSequence()
    const secondOne = openShift(register, 50_000)
    expect(secondOne.result).toMatchObject({ status: 'rejected', reason: 'shift_already_open' })
    expect(status.hub.openShift(register.deviceId)?.id).toBe(firstOne.shift)
    expect(status.hub.openShift(register.deviceId)?.base).toBe(200_000)
    expect(m.store.maxSequence()).toBe(before)
  })

  it('the rejection repeats the same if the register resends the same event', () => {
    const { register, status, raw, send, openShift } = device()
    openShift(register)
    const shift2 = raw(register, 'ShiftOpened', newId(), {
      register_id: register.deviceId,
      base: 1,
    })
    const a = send(register, [shift2]).results[0]
    const b = send(register, [shift2]).results[0]
    expect(a).toMatchObject({ status: 'rejected', reason: 'shift_already_open' })
    expect(b).toEqual(a)
    expect(status.hub.openShift(register.deviceId)?.base).toBe(200_000)
  })

  it('resending the same confirmed ShiftOpened is idempotent: it is not a second shift', () => {
    const { m, register, raw, send } = device()
    const shift = raw(register, 'ShiftOpened', newId(), {
      register_id: register.deviceId,
      base: 10,
    })
    const a = send(register, [shift]).results[0]
    const b = send(register, [shift]).results[0]
    expect(stateOf(a)).toBe('confirmed')
    expect(b).toEqual(a)
    expect(m.store.maxSequence()).toBe(1)
  })

  it('two different registers can have their shifts open at the same time', () => {
    const { register, register2, status, openShift } = device()
    const a = openShift(register)
    const b = openShift(register2, 0)
    expect(stateOf(b.result)).toBe('confirmed')
    expect(status.hub.openShift(register.deviceId)?.id).toBe(a.shift)
    expect(status.hub.openShift(register2.deviceId)?.id).toBe(b.shift)
  })

  it('the shift id of another register cannot be reused (shift_already_exists)', () => {
    const { register, register2, status, openShift } = device()
    const a = openShift(register)
    const reuse = openShift(register2, 0, a.shift)
    expect(reuse.result).toMatchObject({ status: 'rejected', reason: 'shift_already_exists' })
    expect(status.hub.openShift(register2.deviceId)).toBeNull()
  })

  it('register_mismatch: a register does not open the shift of another', () => {
    const { register, register2, status, one, raw } = device()
    const r = one(
      register,
      raw(register, 'ShiftOpened', newId(), { register_id: register2.deviceId, base: 0 }),
    )
    expect(r).toMatchObject({ status: 'rejected', reason: 'register_mismatch' })
    expect(status.hub.openShift(register2.deviceId)).toBeNull()
    expect(status.hub.openShift(register.deviceId)).toBeNull()
  })

  it('register_mismatch also if the register_id is from a device that does not exist', () => {
    const { register, one, raw } = device()
    const r = one(
      register,
      raw(register, 'ShiftOpened', newId(), { register_id: newId(), base: 0 }),
    )
    expect(reason(r)).toBe('register_mismatch')
  })

  it('a ShiftOpened with an invalid format (negative base) is rejected by schema', () => {
    const { register, status, one, raw } = device()
    const r = one(
      register,
      raw(register, 'ShiftOpened', newId(), { register_id: register.deviceId, base: -5 }),
    )
    expect(reason(r)).toMatch(/^schema/)
    expect(status.hub.openShift(register.deviceId)).toBeNull()
  })

  it('a ShiftOpened signed as an order event is rejected by schema', () => {
    const { register, one, raw } = device()
    const r = one(
      register,
      raw(
        register,
        'ShiftOpened',
        newId(),
        { register_id: register.deviceId, base: 0 },
        { aggregate_type: 'order' },
      ),
    )
    expect(reason(r)).toMatch(/^schema/)
  })

  it('a ShiftOpened does not touch any order: the open order stays as it was', () => {
    const { register, ana, status, openOrder, openShift } = device()
    const order = openOrder(ana, 40_900)
    const before = status.hub.order(order)
    openShift(register)
    expect(status.hub.order(order)).toEqual(before)
  })
})

describe('ShiftOpened: does not mix with the order', () => {
  // BUG: the hub stores a ShiftOpened that names an order in `related` as an event of that order
  // (packages/sync/src/hub/hub.ts: `aggregates = ordersOf(event)` in `processEvent`, which takes
  // `related` without looking at the aggregate_type). The root cause is the schema, see
  // packages/core/src/events/order.ts (it lacks the guard that ProductSoldOut does have).
  it('a ShiftOpened with an order in related does not end up in the order history', () => {
    const { register, ana, m, one, raw, openOrder } = device()
    const order = openOrder(ana, 40_900)
    one(
      register,
      raw(
        register,
        'ShiftOpened',
        newId(),
        { register_id: register.deviceId, base: 0 },
        { related: [order] },
      ),
    )
    expect(m.store.aggregateEvents(order).map((e) => e.type)).not.toContain('ShiftOpened')
  })
})

describe('payments, voids and refunds: shift and register', () => {
  const voidEntry = (paymentId: string, shift: string) => ({
    payment_id: paymentId,
    register_shift_id: shift,
  })
  const refund = (paymentId: string, shift: string) => ({
    payment_id: paymentId,
    refund_id: newId(),
    sale_amount: 1_000,
    tip_amount: 0,
    method: 'card',
    register_shift_id: shift,
  })

  it('a payment with no shift is rejected with no_shift and does not stay in the order', () => {
    const { register, status, one, raw, openOrder, cardPaymentData } = device()
    const order = openOrder(register, 40_900)
    const r = one(
      register,
      raw(register, 'PaymentRecorded', order, cardPaymentData(newId(), 40_900)),
    )
    expect(r).toMatchObject({ status: 'rejected', reason: 'no_shift' })
    expect(Object.keys(status.hub.order(order)?.payments ?? {})).toEqual([])
  })

  it('a payment with the shift open is accepted', () => {
    const { register, status, one, raw, openOrder, openShift, cardPaymentData } = device()
    const order = openOrder(register, 40_900)
    const { shift } = openShift(register)
    const r = one(register, raw(register, 'PaymentRecorded', order, cardPaymentData(shift, 40_900)))
    expect(stateOf(r)).toBe('confirmed')
    expect(Object.values(status.hub.order(order)?.payments ?? {})[0]).toMatchObject({
      registerShiftId: shift,
      amount: 40_900,
    })
  })

  it('other_register_shift: register 2 does not charge in the shift of register 1', () => {
    const { register, register2, one, raw, openOrder, openShift, cardPaymentData } = device()
    const order = openOrder(register, 40_900)
    const { shift } = openShift(register)
    openShift(register2)
    const r = one(
      register2,
      raw(register2, 'PaymentRecorded', order, cardPaymentData(shift, 40_900)),
    )
    expect(r).toMatchObject({ status: 'rejected', reason: 'other_register_shift' })
  })

  it('a device that is not a register (no shift of its own) does not charge in another shift either', () => {
    const { register, ana, one, raw, openOrder, openShift, cardPaymentData } = device()
    const order = openOrder(ana, 40_900)
    const { shift } = openShift(register)
    const r = one(ana, raw(ana, 'PaymentRecorded', order, cardPaymentData(shift, 40_900)))
    expect(reason(r)).toBe('other_register_shift')
  })

  it('a shift id that belongs to an order or is made up does not work: no_shift', () => {
    const { register, one, raw, openOrder, openShift, cardPaymentData } = device()
    const order = openOrder(register, 40_900)
    openShift(register)
    expect(
      reason(one(register, raw(register, 'PaymentRecorded', order, cardPaymentData(order, 1_000)))),
    ).toBe('no_shift')
    expect(
      reason(
        one(register, raw(register, 'PaymentRecorded', order, cardPaymentData(newId(), 1_000))),
      ),
    ).toBe('no_shift')
  })

  it('PaymentVoided: no_shift, other_register_shift and, with its own shift, accepted', () => {
    const { register, register2, status, one, raw, openOrder, openShift, cardPaymentData } =
      device()
    const order = openOrder(register, 40_900)
    const { shift } = openShift(register)
    const { shift: shift2 } = openShift(register2)
    const payment = cardPaymentData(shift, 40_900)
    expect(stateOf(one(register, raw(register, 'PaymentRecorded', order, payment)))).toBe(
      'confirmed',
    )

    expect(
      reason(
        one(
          register,
          raw(register, 'PaymentVoided', order, voidEntry(payment.payment_id, newId())),
        ),
      ),
    ).toBe('no_shift')
    expect(
      reason(
        one(
          register2,
          raw(register2, 'PaymentVoided', order, voidEntry(payment.payment_id, shift)),
        ),
      ),
    ).toBe('other_register_shift')
    // Register 2 with its own shift can void: the payment falls in the shift where it is voided.
    expect(
      stateOf(
        one(register, raw(register, 'PaymentVoided', order, voidEntry(payment.payment_id, shift))),
      ),
    ).toBe('confirmed')
    expect(status.hub.order(order)?.payments[payment.payment_id]?.voided).toBe(true)
    expect(shift2).toBeTruthy()
  })

  it('RefundRecorded: no_shift, other_register_shift and, with its own shift, accepted', () => {
    const { register, register2, status, one, raw, openOrder, openShift, cardPaymentData } =
      device()
    const order = openOrder(register, 40_900)
    const { shift } = openShift(register)
    openShift(register2)
    const payment = cardPaymentData(shift, 40_900)
    one(register, raw(register, 'PaymentRecorded', order, payment))

    expect(
      reason(
        one(register, raw(register, 'RefundRecorded', order, refund(payment.payment_id, newId()))),
      ),
    ).toBe('no_shift')
    expect(
      reason(
        one(register2, raw(register2, 'RefundRecorded', order, refund(payment.payment_id, shift))),
      ),
    ).toBe('other_register_shift')
    expect(
      stateOf(
        one(register, raw(register, 'RefundRecorded', order, refund(payment.payment_id, shift))),
      ),
    ).toBe('confirmed')
    expect(status.hub.order(order)?.payments[payment.payment_id]?.refundedSale).toBe(1_000)
  })

  it('a shift rejection leaves no trace in the order and no gap in the sequences', () => {
    const { m, register, one, raw, openOrder, cardPaymentData } = device()
    const order = openOrder(register, 40_900)
    const before = m.store.maxSequence()
    one(register, raw(register, 'PaymentRecorded', order, cardPaymentData(newId(), 40_900)))
    expect(m.store.maxSequence()).toBe(before)
    expect(m.hub().conflicts()).toEqual([])
  })

  it('with no shift it cannot even close: the order stays with a pending balance', () => {
    const { register, one, raw, openOrder, cardPaymentData } = device()
    const order = openOrder(register, 40_900)
    one(register, raw(register, 'PaymentRecorded', order, cardPaymentData(newId(), 40_900)))
    expect(reason(one(register, raw(register, 'OrderClosed', order, {})))).toBe('pending_balance')
  })
})

describe('cash rounding: that of the restaurant', () => {
  // Order of $36.810: the cash that settles it is charged at $36.800 (adjustment −10).
  const charge = (rounding: object | null, options: { rules?: boolean } = {}) => {
    const e = device(options)
    const order = e.openOrder(e.register, 36_810)
    const { shift } = e.openShift(e.register)
    const r = e.one(
      e.register,
      e.raw(e.register, 'PaymentRecorded', order, e.cashPaymentData(shift, 36_810, -10, rounding)),
    )
    return { ...e, order, shift, r }
  }

  it('with the rule of the restaurant, the cash payment is accepted', () => {
    const { r, status, order } = charge(ROUNDING)
    expect(stateOf(r)).toBe('confirmed')
    expect(status.hub.order(order)?.payments).toBeDefined()
  })

  it('rounding_mismatch: another multiple', () => {
    expect(charge({ multiple: 50, mode: 'nearest_half_down' }).r).toMatchObject({
      status: 'rejected',
      reason: 'rounding_mismatch',
    })
  })

  it('rounding_mismatch: another mode', () => {
    expect(reason(charge({ multiple: 100, mode: 'up' }).r)).toBe('rounding_mismatch')
    expect(reason(charge({ multiple: 100, mode: 'nearest_half_up' }).r)).toBe('rounding_mismatch')
  })

  it('if the restaurant changes the rule, the hub uses the current one on each payment', () => {
    const e = device({ rules: false })
    let rule: Rules = { ...RULES }
    e.status.hub = hubWithRules(e.m, () => rule)
    const order = e.openOrder(e.register, 36_810)
    const { shift } = e.openShift(e.register)
    rule = { ...RULES, multiple: 50 }
    const oldOne = e.one(
      e.register,
      e.raw(e.register, 'PaymentRecorded', order, e.cashPaymentData(shift, 36_810, -10, ROUNDING)),
    )
    expect(reason(oldOne)).toBe('rounding_mismatch')
  })

  it('a payment with no rounding (partial or balance already round) is not compared', () => {
    const e = device()
    const order = e.openOrder(e.register, 36_800)
    const { shift } = e.openShift(e.register)
    const r = e.one(
      e.register,
      e.raw(e.register, 'PaymentRecorded', order, e.cashPaymentData(shift, 36_800, 0, null)),
    )
    expect(stateOf(r)).toBe('confirmed')
  })

  it('a card payment has no rounding and is not affected by the rule', () => {
    const e = device()
    const order = e.openOrder(e.register, 36_810)
    const { shift } = e.openShift(e.register)
    const r = e.one(
      e.register,
      e.raw(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift, 36_810)),
    )
    expect(stateOf(r)).toBe('confirmed')
  })

  it('a hub without the rule configured does not compare rounding', () => {
    const { r } = charge({ multiple: 50, mode: 'down' }, { rules: false })
    // 50 with mode "down" gives another adjustment: the reducer rejects it, but not for
    // rounding_mismatch.
    expect(reason(r)).not.toBe('rounding_mismatch')
  })

  it('the rounding rejection neither creates the payment nor takes a sequence', () => {
    const e = charge({ multiple: 1000, mode: 'up' })
    expect(Object.keys(e.status.hub.order(e.order)?.payments ?? {})).toEqual([])
  })
})

describe('method and card terminal: those of the restaurant', () => {
  const nequiPaymentOf = (shift: string, amount: number) => ({
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    method: 'nequi',
    amount,
    tip: 0,
    tendered: null,
    change: null,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: null,
    charge_reference: null,
  })

  it('method_not_enabled: a method the restaurant does not accept is rejected', () => {
    const e = device()
    const order = e.openOrder(e.register, 10_000)
    const { shift } = e.openShift(e.register)
    e.status.hub = hubWithRules(e.m, () => ({ ...RULES, methods: ['cash', 'card'] }))
    const r = e.one(
      e.register,
      e.raw(e.register, 'PaymentRecorded', order, nequiPaymentOf(shift, 10_000)),
    )
    expect(r).toMatchObject({ status: 'rejected', reason: 'method_not_enabled' })
    expect(Object.keys(e.status.hub.order(order)?.payments ?? {})).toEqual([])
  })

  it('an enabled method is accepted, and the voucher only if the restaurant includes it', () => {
    const e = device()
    const order = e.openOrder(e.register, 20_000)
    const { shift } = e.openShift(e.register)
    expect(
      stateOf(
        e.one(
          e.register,
          e.raw(e.register, 'PaymentRecorded', order, nequiPaymentOf(shift, 10_000)),
        ),
      ),
    ).toBe('confirmed')
    const voucher = { ...nequiPaymentOf(shift, 10_000), method: 'voucher' }
    expect(reason(e.one(e.register, e.raw(e.register, 'PaymentRecorded', order, voucher)))).toBe(
      'method_not_enabled',
    )
    e.status.hub = hubWithRules(e.m, () => ({ ...RULES, methods: [...RULES.methods, 'voucher'] }))
    expect(stateOf(e.one(e.register, e.raw(e.register, 'PaymentRecorded', order, voucher)))).toBe(
      'confirmed',
    )
  })

  it('if the admin removes a method while the hub is running, the next payment no longer goes through', () => {
    const e = device()
    const order = e.openOrder(e.register, 20_000)
    const { shift } = e.openShift(e.register)
    let methods = [...RULES.methods]
    e.status.hub = hubWithRules(e.m, () => ({ ...RULES, methods }))
    expect(
      stateOf(
        e.one(
          e.register,
          e.raw(e.register, 'PaymentRecorded', order, nequiPaymentOf(shift, 5_000)),
        ),
      ),
    ).toBe('confirmed')
    methods = methods.filter((x) => x !== 'nequi')
    expect(
      reason(
        e.one(
          e.register,
          e.raw(e.register, 'PaymentRecorded', order, nequiPaymentOf(shift, 5_000)),
        ),
      ),
    ).toBe('method_not_enabled')
  })

  it('unknown_card_terminal: the card names a card terminal that is not active', () => {
    const e = device()
    const order = e.openOrder(e.register, 10_000)
    const { shift } = e.openShift(e.register)
    const outsider = e.cardPaymentData(shift, 10_000, {
      cardTerminal: {
        card_terminal_id: newId(),
        franchise: null,
        last4: null,
        approval_code: null,
        receipt: null,
      },
    })
    const r = e.one(e.register, e.raw(e.register, 'PaymentRecorded', order, outsider))
    expect(r).toMatchObject({ status: 'rejected', reason: 'unknown_card_terminal' })
  })

  it('an archived card terminal stops being valid even if the phone still shows it', () => {
    const e = device()
    const order = e.openOrder(e.register, 10_000)
    const { shift } = e.openShift(e.register)
    e.status.hub = hubWithRules(e.m, () => ({ ...RULES, cardTerminals: [] }))
    const r = e.one(
      e.register,
      e.raw(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift, 10_000)),
    )
    expect(reason(r)).toBe('unknown_card_terminal')
  })

  it('a card with no approval number (only the amount) is accepted with an active card terminal', () => {
    const e = device()
    const order = e.openOrder(e.register, 10_000)
    const { shift } = e.openShift(e.register)
    const r = e.one(
      e.register,
      e.raw(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift, 10_000)),
    )
    expect(stateOf(r)).toBe('confirmed')
  })

  it('cash needs no card terminal and is not affected by the card terminal list', () => {
    const e = device()
    const order = e.openOrder(e.register, 36_800)
    const { shift } = e.openShift(e.register)
    e.status.hub = hubWithRules(e.m, () => ({ ...RULES, cardTerminals: [] }))
    const r = e.one(
      e.register,
      e.raw(e.register, 'PaymentRecorded', order, e.cashPaymentData(shift, 36_800, 0, null)),
    )
    expect(stateOf(r)).toBe('confirmed')
  })

  it('rule order: no shift wins over method not enabled', () => {
    const e = device()
    const order = e.openOrder(e.register, 10_000)
    e.status.hub = hubWithRules(e.m, () => ({ ...RULES, methods: ['cash'] }))
    const r = e.one(
      e.register,
      e.raw(e.register, 'PaymentRecorded', order, nequiPaymentOf(newId(), 10_000)),
    )
    expect(reason(r)).toBe('no_shift')
  })

  it('voiding and refunding do not check the method: what was charged by a method no longer accepted can be returned', () => {
    const e = device()
    const order = e.openOrder(e.register, 10_000)
    const { shift } = e.openShift(e.register)
    const payment = nequiPaymentOf(shift, 10_000)
    e.one(e.register, e.raw(e.register, 'PaymentRecorded', order, payment))
    e.status.hub = hubWithRules(e.m, () => ({ ...RULES, methods: ['cash'] }))
    const r = e.one(
      e.register,
      e.raw(e.register, 'PaymentVoided', order, {
        payment_id: payment.payment_id,
        register_shift_id: shift,
      }),
    )
    expect(stateOf(r)).toBe('confirmed')
  })
})

describe('custom methods of the restaurant', () => {
  const SODEXO = newId()
  const own = (shift: string, id: string | null, amount: number, method = 'other') => ({
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    method,
    ...(id ? { custom_method_id: id } : {}),
    amount,
    tip: 0,
    tendered: null,
    change: null,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: null,
    charge_reference: null,
  })
  const setup = (activeRows: string[]) => {
    const e = device()
    e.status.hub = hubWithRules(e.m, () => ({ ...RULES, customMethods: activeRows }))
    const order = e.openOrder(e.register, 30_000)
    const { shift } = e.openShift(e.register)
    return { ...e, order, shift }
  }

  it('an active custom method is accepted and stays in the payment', () => {
    const e = setup([SODEXO])
    const r = e.one(
      e.register,
      e.raw(e.register, 'PaymentRecorded', e.order, own(e.shift, SODEXO, 10_000)),
    )
    expect(stateOf(r)).toBe('confirmed')
    expect(Object.values(e.status.hub.order(e.order)?.payments ?? {})[0]).toMatchObject({
      method: 'other',
      customMethodId: SODEXO,
    })
  })

  it('an unknown or archived one (outside the active list) is rejected with method_not_enabled', () => {
    const e = setup([SODEXO])
    const outsider = e.one(
      e.register,
      e.raw(e.register, 'PaymentRecorded', e.order, own(e.shift, newId(), 1_000)),
    )
    expect(outsider).toMatchObject({ status: 'rejected', reason: 'method_not_enabled' })
    const archived = setup([])
    const r = archived.one(
      archived.register,
      archived.raw(
        archived.register,
        'PaymentRecorded',
        archived.order,
        own(archived.shift, SODEXO, 1_000),
      ),
    )
    expect(reason(r)).toBe('method_not_enabled')
  })

  it('a hub without the custom method list (undefined) rejects any custom method', () => {
    const e = device()
    e.status.hub = hubWithRules(e.m, () => ({ ...RULES }))
    const order = e.openOrder(e.register, 10_000)
    const { shift } = e.openShift(e.register)
    const r = e.one(
      e.register,
      e.raw(e.register, 'PaymentRecorded', order, own(shift, SODEXO, 1_000)),
    )
    expect(reason(r)).toBe('method_not_enabled')
  })

  it('«other» with no id, or an id with another method, is rejected by schema', () => {
    const e = setup([SODEXO])
    expect(
      reason(
        e.one(e.register, e.raw(e.register, 'PaymentRecorded', e.order, own(e.shift, null, 1_000))),
      ),
    ).toMatch(/^schema/)
    expect(
      reason(
        e.one(
          e.register,
          e.raw(e.register, 'PaymentRecorded', e.order, own(e.shift, SODEXO, 1_000, 'nequi')),
        ),
      ),
    ).toMatch(/^schema/)
  })

  it('voiding the payment of a custom method archived later is still allowed', () => {
    const e = setup([SODEXO])
    const payment = own(e.shift, SODEXO, 10_000)
    e.one(e.register, e.raw(e.register, 'PaymentRecorded', e.order, payment))
    e.status.hub = hubWithRules(e.m, () => ({ ...RULES, customMethods: [] }))
    const r = e.one(
      e.register,
      e.raw(e.register, 'PaymentVoided', e.order, {
        payment_id: payment.payment_id,
        register_shift_id: e.shift,
      }),
    )
    expect(stateOf(r)).toBe('confirmed')
  })
})

describe('the shift survives a hub restart', () => {
  it('a new hub on the same database knows the open shift and its base', () => {
    const e = device()
    const { shift } = e.openShift(e.register, 120_000)
    const restarted = hubWithRules(e.m)
    expect(restarted.openShift(e.register.deviceId)).toMatchObject({
      id: shift,
      base: 120_000,
      userId: e.register.userId,
    })
  })

  it('after the restart it keeps rejecting the second shift and accepting payments in the shift', () => {
    const e = device()
    const order = e.openOrder(e.register, 40_900)
    const { shift } = e.openShift(e.register)
    e.status.hub = hubWithRules(e.m)
    expect(reason(e.openShift(e.register).result)).toBe('shift_already_open')
    const r = e.one(
      e.register,
      e.raw(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift, 40_900)),
    )
    expect(stateOf(r)).toBe('confirmed')
  })

  it('the rejected shift does not reappear after the restart, and the open one keeps its base', () => {
    const e = device()
    const firstOne = e.openShift(e.register, 100)
    e.openShift(e.register, 999)
    const restarted = hubWithRules(e.m)
    expect(restarted.openShift(e.register.deviceId)?.id).toBe(firstOne.shift)
    expect(restarted.openShift(e.register.deviceId)?.base).toBe(100)
  })

  it('with several pages of order events, the shift is still there', () => {
    const e = device()
    const { shift } = e.openShift(e.register)
    // More events than one rebuild page.
    for (let i = 0; i < 12; i++) e.openOrder(e.ana, 1_000 + i)
    const restarted = hubWithRules(e.m)
    expect(restarted.openShift(e.register.deviceId)?.id).toBe(shift)
  })

  it('a hub that restarts without keeping the database does not make up shifts', () => {
    const e = device()
    e.openShift(e.register)
    const otherDatabase = setup()
    const empty = new HubSync(otherDatabase.store, {
      restaurantId: otherDatabase.restaurantId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      access: openAccess,
      instance: 'hub-2',
      clock: otherDatabase.network.isoTime,
    })
    expect(empty.openShift(e.register.deviceId)).toBeNull()
  })
})

describe('one batch: open shift, pay and close the order', () => {
  it('everything in a single batch is confirmed and the order closes', () => {
    const e = device()
    const order = newId()
    const shift = newId()
    const payment = e.cashPaymentData(shift, 36_810, -10, ROUNDING)
    const base = e.m.store.maxSequence()
    const r = e.send(e.register, [
      e.raw(
        e.register,
        'OrderOpened',
        order,
        { channel: 'dine_in', table_id: null, guests: 2 },
        { base_sequence: base },
      ),
      e.raw(e.register, 'ItemAdded', order, item(36_810), { base_sequence: base }),
      e.raw(
        e.register,
        'ShiftOpened',
        shift,
        { register_id: e.register.deviceId, base: 200_000 },
        { base_sequence: base },
      ),
      e.raw(e.register, 'PaymentRecorded', order, payment, { base_sequence: base }),
      e.raw(e.register, 'OrderClosed', order, {}, { base_sequence: base }),
    ])
    expect(r.results.map(stateOf)).toEqual(Array(5).fill('confirmed'))
    expect(r.acceptedEvents.map((x: OrderEvent) => x.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(e.status.hub.order(order)).toMatchObject({ status: 'closed' })
    expect(e.status.hub.openShift(e.register.deviceId)?.id).toBe(shift)
  })

  it('the payment before the shift in the same batch is rejected with no_shift and the close does not go through', () => {
    const e = device()
    const order = e.openOrder(e.register, 40_900)
    const shift = newId()
    const r = e.send(e.register, [
      e.raw(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift, 40_900)),
      e.raw(e.register, 'ShiftOpened', shift, { register_id: e.register.deviceId, base: 0 }),
      e.raw(e.register, 'OrderClosed', order, {}),
    ])
    expect(r.results.map((x) => (x.status === 'rejected' ? x.reason : x.status))).toEqual([
      'no_shift',
      'confirmed',
      'depends_on_rejected',
    ])
    expect(e.status.hub.order(order)?.status).toBe('open')
  })

  it('if the batch shift is rejected (one already exists), that shift payment fails and the rest goes on', () => {
    const e = device()
    const order = e.openOrder(e.register, 40_900)
    e.openShift(e.register)
    const shift2 = newId()
    const r = e.send(e.register, [
      e.raw(e.register, 'ShiftOpened', shift2, {
        register_id: e.register.deviceId,
        base: 0,
      }),
      e.raw(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift2, 40_900)),
    ])
    expect(r.results.map((x) => (x.status === 'rejected' ? x.reason : x.status))).toEqual([
      'shift_already_open',
      'no_shift',
    ])
  })
})

describe('multi-restaurant: the shift belongs to each restaurant', () => {
  function twoRestaurants() {
    const a = device()
    // Second restaurant in the same database, with its own hub and store.
    const otherId = newId()
    a.m.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(otherId, otherId, NOW, NOW)
    const hubB = new HubSync(new SqliteStore(a.m.db, otherId), {
      restaurantId: otherId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      access: openAccess,
      instance: 'hub-b',
      clock: a.m.network.isoTime,
      checkoutRules: () => RULES,
    })
    return { ...a, hubB, otherId }
  }

  it('the shift open in one restaurant does not exist in the other', () => {
    const e = twoRestaurants()
    e.openShift(e.register)
    expect(e.status.hub.openShift(e.register.deviceId)).not.toBeNull()
    expect(e.hubB.openShift(e.register.deviceId)).toBeNull()
  })

  it('a payment in restaurant B with the shift of A is rejected with no_shift', () => {
    const e = twoRestaurants()
    const { shift } = e.openShift(e.register)
    const order = newId()
    const connection = connectionOf(e.m, e.register)
    const rB = e.hubB.receiveBatch(connection, [
      e.raw(
        e.register,
        'OrderOpened',
        order,
        { channel: 'dine_in', table_id: null, guests: 1 },
        { base_sequence: 0 },
      ),
      e.raw(e.register, 'ItemAdded', order, item(10_000), { base_sequence: 0 }),
      e.raw(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift, 10_000), {
        base_sequence: 0,
      }),
    ])
    expect(rB.results.map((x) => (x.status === 'rejected' ? x.reason : x.status))).toEqual([
      'confirmed',
      'confirmed',
      'no_shift',
    ])
  })

  it('each restaurant opens its shift even if it is the same register device, and each hub restarts with its own', () => {
    const e = twoRestaurants()
    const a = e.openShift(e.register, 1_000)
    const connection = connectionOf(e.m, e.register)
    const shiftB = newId()
    const rB = e.hubB.receiveBatch(connection, [
      e.raw(
        e.register,
        'ShiftOpened',
        shiftB,
        { register_id: e.register.deviceId, base: 2_000 },
        { base_sequence: 0 },
      ),
    ]).results[0]
    expect(stateOf(rB)).toBe('confirmed')
    expect(e.hubB.openShift(e.register.deviceId)).toMatchObject({ id: shiftB, base: 2_000 })
    expect(e.status.hub.openShift(e.register.deviceId)).toMatchObject({
      id: a.shift,
      base: 1_000,
    })

    const restartedB = new HubSync(new SqliteStore(e.m.db, e.otherId), {
      restaurantId: e.otherId,
      timeZone: 'America/Bogota',
      businessDayStart: '06:00',
      access: openAccess,
      instance: 'hub-b2',
      clock: e.m.network.isoTime,
    })
    expect(restartedB.openShift(e.register.deviceId)?.id).toBe(shiftB)
    expect(hubWithRules(e.m).openShift(e.register.deviceId)?.id).toBe(a.shift)
  })
})

describe('with the simulated network: register offline, hub down and duplicate messages', () => {
  /** The register opens a shift, charges and closes its order; returns what is needed to check. */
  async function registerCharges(m: Setup, register: NetNode, price = 40_900) {
    const order = newId()
    const shift = newId()
    await register.create(order, 'OrderOpened', {
      channel: 'dine_in',
      table_id: newId(),
      guests: 2,
    })
    await register.create(order, 'ItemAdded', item(price))
    await register.create(
      shift,
      'ShiftOpened',
      { register_id: register.deviceId, base: 100_000 },
      { aggregate_type: 'register_shift' },
    )
    await register.create(order, 'PaymentRecorded', {
      payment_id: newId(),
      check_id: null,
      register_shift_id: shift,
      method: 'card',
      amount: price,
      tip: 0,
      tendered: null,
      change: null,
      rounding_adjustment: 0,
      rounding: null,
      cardTerminal: {
        card_terminal_id: newId(),
        franchise: null,
        last4: null,
        approval_code: null,
        receipt: null,
      },
      charge_reference: null,
    })
    await register.create(order, 'OrderClosed', {})
    expect(m).toBeTruthy()
    return { order, shift }
  }

  it('the register opens a shift, charges and closes offline; on reconnect everything is confirmed and all see the same', async () => {
    const m = setup()
    const register = m.network.device('register')
    const ana = m.network.device('ana')
    const { order } = await registerCharges(m, register)
    expect(await register.client.pendingList()).toBe(5)

    await m.network.connectAll()
    expect(m.hub().order(order)?.status).toBe('closed')
    expect(m.hub().openShift(register.deviceId)).not.toBeNull()
    await seeTheSame(m.hub(), m.store.eventsSince(0, 1_000), [register, ana], [order])
  })

  it('a batch duplicated by the network neither opens two shifts nor charges twice', async () => {
    const m = setup()
    const register = m.network.device('register')
    const ana = m.network.device('ana')
    await m.network.connectAll()
    register.rule('to_hub', 'push', 'duplicate', 3)
    const { order } = await registerCharges(m, register)
    await m.network.settle()
    const events = m.store.eventsSince(0, 1_000)
    expect(events.filter((x) => x.type === 'ShiftOpened')).toHaveLength(1)
    expect(events.filter((x) => x.type === 'PaymentRecorded')).toHaveLength(1)
    await seeTheSame(m.hub(), events, [register, ana], [order])
  })

  it('the hub goes down right when saving the payment: on return, the shift stays and the checkout completes without duplicating', async () => {
    const m = setup()
    const register = m.network.device('register')
    const ana = m.network.device('ana')
    await m.network.connectAll()
    // Events: 1 OrderOpened, 2 ItemAdded, 3 ShiftOpened, 4 PaymentRecorded (crash), 5 OrderClosed.
    if (m.store instanceof CrashingStore) m.store.crashAt = 4
    const { order, shift } = await registerCharges(m, register)
    await m.network.settle()
    await m.network.connectAll()
    await m.network.settle()

    expect(m.hub().openShift(register.deviceId)?.id).toBe(shift)
    const events = m.store.eventsSince(0, 1_000)
    expect(events.filter((x) => x.type === 'PaymentRecorded')).toHaveLength(1)
    expect(m.hub().order(order)?.status).toBe('closed')
    await seeTheSame(m.hub(), events, [register, ana], [order])
  })

  it('an out-of-sync register clock does not change the shift: accepted and the order closes', async () => {
    const m = setup()
    const register = m.network.device('register')
    const ana = m.network.device('ana')
    register.offsetMs = -3 * 60 * 60 * 1000
    await m.network.connectAll()
    const { order, shift } = await registerCharges(m, register)
    await m.network.settle()
    expect(m.hub().openShift(register.deviceId)?.id).toBe(shift)
    await seeTheSame(m.hub(), m.store.eventsSince(0, 1_000), [register, ana], [order])
  })

  it('the hub restarts between opening the shift and charging: the later checkout is still valid', async () => {
    const m = setup()
    const register = m.network.device('register')
    await m.network.connectAll()
    const shift = newId()
    await register.create(
      shift,
      'ShiftOpened',
      { register_id: register.deviceId, base: 0 },
      { aggregate_type: 'register_shift' },
    )
    await m.network.settle()
    m.network.crashHub()
    await m.network.connectAll()
    expect(m.hub().openShift(register.deviceId)?.id).toBe(shift)
    const order = newId()
    await register.create(order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 1 })
    await register.create(order, 'ItemAdded', item(10_000))
    await register.create(order, 'PaymentRecorded', {
      payment_id: newId(),
      check_id: null,
      register_shift_id: shift,
      method: 'nequi',
      amount: 10_000,
      tip: 0,
      tendered: null,
      change: null,
      rounding_adjustment: 0,
      rounding: null,
      cardTerminal: null,
      charge_reference: null,
    })
    await m.network.settle()
    expect(Object.keys(m.hub().order(order)?.payments ?? {})).toHaveLength(1)
  })
})
