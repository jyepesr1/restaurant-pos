import { describe, expect, it } from 'vitest'
import { type OrderEvent, validateNewEvent } from '../events/order'
import { newId } from '../id'
import { cashPaymentData, event } from '../testing/factory'
import { DENOMINATIONS, shiftReconciliation } from './shift'

// The shift reconciliation (task 1.7, docs/DINERO.md#caja), shared by the hub and the register.

const shift = newId()
const register = newId()
const shiftEvent = <T extends OrderEvent['type']>(type: T, data: never) =>
  event(shift, type, data, { aggregate_type: 'register_shift' } as never)
const open = (base: number) => shiftEvent('ShiftOpened', { register_id: register, base } as never)
const pay = (data: ReturnType<typeof cashPaymentData>) => event(newId(), 'PaymentRecorded', data)
const move = (type: 'entry' | 'output' | 'tip_payout', amount: number) =>
  shiftEvent('CashMovementRecorded', {
    movement_id: newId(),
    type,
    amount,
    description: 'Prueba',
    to_whom: type === 'tip_payout' ? 'Equipo' : null,
    days: type === 'tip_payout' ? ['2026-10-26'] : [],
  } as never)

describe('shiftReconciliation', () => {
  it('the DINERO.md example: base 200.000, cash 36.810 (−10, tip 3.000), tips 20.000 → 219.800', () => {
    const c = shiftReconciliation(
      [
        open(200_000),
        pay(
          cashPaymentData(36_810, {
            rounding_adjustment: -10,
            tip: 3_000,
            register_shift_id: shift,
          }),
        ),
        move('tip_payout', 20_000),
      ],
      shift,
    )
    expect(c?.cash.expected).toBe(219_800)
    expect(c?.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 36_800, tip: 3_000, payments: 1 },
    ])
  })

  it('entries add, outflows subtract; card does not go into cash', () => {
    const card = cashPaymentData(50_000, {
      register_shift_id: shift,
      method: 'card',
      tendered: null,
      change: null,
      rounding: null,
      cardTerminal: {
        card_terminal_id: newId(),
        franchise: null,
        last4: null,
        approval_code: null,
        receipt: null,
      },
    })
    const c = shiftReconciliation(
      [open(100_000), move('entry', 30_000), move('output', 12_000), pay(card)],
      shift,
    )
    expect(c?.cash).toMatchObject({ entries: 30_000, outflows: 12_000, expected: 118_000 })
    expect(c?.byMethod.find((m) => m.method === 'card')?.sale).toBe(50_000)
  })

  it('a cash payment voided in this shift returns what was charged; one from another shift does not count', () => {
    const payment = cashPaymentData(20_000, { tip: 2_000, register_shift_id: shift })
    const fromOther = cashPaymentData(5_000, { register_shift_id: newId() })
    const c = shiftReconciliation(
      [
        open(0),
        pay(payment),
        pay(fromOther),
        event(
          newId(),
          'PaymentVoided',
          { payment_id: payment.payment_id, register_shift_id: shift },
          {
            reason: 'Error',
          },
        ),
      ],
      shift,
    )
    expect(c?.cash).toMatchObject({ charged: 22_000, refunds: 22_000, expected: 0 })
    expect(c?.byMethod).toEqual([])
  })

  it('keeps each count and the close', () => {
    const cashCount = newId()
    const c = shiftReconciliation(
      [
        open(50_000),
        shiftEvent('CashCountRecorded', {
          cash_count_id: cashCount,
          tally: [{ value: 50_000, quantity: 1 }],
          counted_cash: 50_000,
        } as never),
        shiftEvent('ShiftClosed', {
          cash_count_id: cashCount,
          expected_cash: 50_000,
          counted_cash: 50_000,
          variance: 0,
          justification: null,
        } as never),
      ],
      shift,
    )
    expect(c?.cashCounts).toHaveLength(1)
    expect(c?.closed).toMatchObject({ expected: 50_000, counted: 50_000, variance: 0 })
  })

  it('without an opening there is no reconciliation', () => {
    expect(shiftReconciliation([], shift)).toBeNull()
  })

  it('the Colombian denominations, from largest to smallest', () => {
    const values = DENOMINATIONS.map((d) => d.value)
    expect(values).toEqual([...values].sort((a, b) => b - a))
    expect(values[0]).toBe(100_000)
  })
})

describe('register schemas (task 1.7)', () => {
  const envelope = (type: string, data: unknown) => {
    // As the register creates it: without the fields the hub adds.
    const {
      sequence: _s,
      received_at: _r,
      business_day: _d,
      assignments: _a,
      affects: _f,
      authorized_by_id: _p,
      ...fresh
    } = open(0) as unknown as Record<string, unknown>
    return { ...fresh, type, data }
  }
  const ok = (e: unknown) => validateNewEvent(e).ok

  it('the count must add up to what was counted', () => {
    const tally = [{ value: 20_000, quantity: 3 }]
    expect(
      ok(envelope('CashCountRecorded', { cash_count_id: newId(), tally, counted_cash: 60_000 })),
    ).toBe(true)
    expect(
      ok(envelope('CashCountRecorded', { cash_count_id: newId(), tally, counted_cash: 50_000 })),
    ).toBe(false)
  })

  it('the variance is what was counted minus what was expected', () => {
    const base = {
      cash_count_id: newId(),
      expected_cash: 100_000,
      counted_cash: 98_000,
      justification: null,
    }
    expect(ok(envelope('ShiftClosed', { ...base, variance: -2_000 }))).toBe(true)
    expect(ok(envelope('ShiftClosed', { ...base, variance: 2_000 }))).toBe(false)
  })

  it('only the tip payout says to whom and for which days', () => {
    const m = { movement_id: newId(), amount: 1_000, description: 'x' }
    expect(
      ok(envelope('CashMovementRecorded', { ...m, type: 'output', to_whom: null, days: [] })),
    ).toBe(true)
    expect(
      ok(envelope('CashMovementRecorded', { ...m, type: 'output', to_whom: 'Ana', days: [] })),
    ).toBe(false)
    expect(
      ok(
        envelope('CashMovementRecorded', {
          ...m,
          type: 'tip_payout',
          to_whom: null,
          days: ['2026-10-26'],
        }),
      ),
    ).toBe(false)
    expect(
      ok(
        envelope('CashMovementRecorded', {
          ...m,
          type: 'tip_payout',
          to_whom: 'Ana',
          days: ['2026-10-26'],
        }),
      ),
    ).toBe(true)
  })
})
