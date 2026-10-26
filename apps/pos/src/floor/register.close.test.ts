import { newId } from '@pos/core'
import type { LocalEvent, LocalState } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { registerReconciliation, shiftOfRegister, shiftSummary } from './checks'
import { local, TIME } from './testing'

// What the register sees of the shift (task 1.7): which one is open even with closed ones, the
// reconciliation with what is saved here (confirmed and pending, never rejected) and the summary
// by method.

const REGISTER = newId()
const time = (h: number) => `2026-10-26T${String(h).padStart(2, '0')}:00:00.000Z`

const shiftEvent = <T extends Parameters<typeof local>[0]>(
  type: T,
  shift: string,
  data: unknown,
  status: LocalState = 'confirmed',
  extras: object = {},
) =>
  local(type, shift, data as never, status, {
    aggregate_type: 'register_shift',
    ...extras,
  } as never)

const open = (base: number, register = REGISTER, status: LocalState = 'confirmed', h = 8) => {
  const shift = newId()
  const e = shiftEvent('ShiftOpened', shift, { register_id: register, base }, status, {
    hub_estimated_time: time(h),
    ...(status === 'confirmed' ? { received_at: time(h) } : {}),
  })
  return { shift, e }
}
const move = (
  shift: string,
  type: 'entry' | 'output' | 'tip_payout',
  amount: number,
  status: LocalState = 'confirmed',
) =>
  shiftEvent(
    'CashMovementRecorded',
    shift,
    {
      movement_id: newId(),
      type,
      amount,
      description: `Mov ${type}`,
      to_whom: type === 'tip_payout' ? 'Equipo' : null,
      days: type === 'tip_payout' ? ['2026-10-26'] : [],
    },
    status,
  )
const count = (shift: string, counted: number, status: LocalState = 'confirmed') => {
  const cashCount = newId()
  return {
    cashCount,
    e: shiftEvent(
      'CashCountRecorded',
      shift,
      {
        cash_count_id: cashCount,
        tally: [{ value: 1, quantity: counted }],
        counted_cash: counted,
      },
      status,
    ),
  }
}
const close = (
  shift: string,
  cashCount: string,
  expected: number,
  counted: number,
  status: LocalState = 'confirmed',
  justification: string | null = null,
) =>
  shiftEvent(
    'ShiftClosed',
    shift,
    {
      cash_count_id: cashCount,
      expected_cash: expected,
      counted_cash: counted,
      variance: counted - expected,
      justification,
    },
    status,
  )
const payment = (
  shift: string,
  fields: Record<string, unknown>,
  status: LocalState = 'confirmed',
  order = newId(),
) => {
  const data = {
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    method: 'cash',
    amount: 10_000,
    tip: 0,
    tendered: 10_000,
    change: 0,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: null,
    charge_reference: null,
    ...fields,
  }
  return { data, e: local('PaymentRecorded', order, data as never, status) }
}

describe('shiftOfRegister: closed shifts', () => {
  it('a shift with its ShiftClosed confirmed is no longer open', () => {
    const t = open(100_000)
    const a = count(t.shift, 100_000)
    expect(
      shiftOfRegister([t.e, a.e, close(t.shift, a.cashCount, 100_000, 100_000)], REGISTER),
    ).toBeNull()
  })

  it('the pending close (not yet confirmed) does not close it: it stays open until the hub accepts', () => {
    const t = open(100_000)
    const a = count(t.shift, 100_000)
    const r = shiftOfRegister(
      [t.e, a.e, close(t.shift, a.cashCount, 100_000, 100_000, 'pending')],
      REGISTER,
    )
    expect(r).toMatchObject({ id: t.shift, base: 100_000, pendingConfirmation: false })
  })

  it('the rejected close leaves the shift open', () => {
    const t = open(100_000)
    const a = count(t.shift, 100_000)
    const rejected = close(t.shift, a.cashCount, 1, 100_000, 'rejected')
    expect(shiftOfRegister([t.e, a.e, rejected], REGISTER)?.id).toBe(t.shift)
  })

  it('a rejected close and then a confirmed one: closed', () => {
    const t = open(100_000)
    const a = count(t.shift, 100_000)
    expect(
      shiftOfRegister(
        [
          t.e,
          a.e,
          close(t.shift, a.cashCount, 1, 100_000, 'rejected'),
          close(t.shift, a.cashCount, 100_000, 100_000),
        ],
        REGISTER,
      ),
    ).toBeNull()
  })

  it("the first one closed and the second one open: the second is the register's shift", () => {
    const oldOne = open(100_000, REGISTER, 'confirmed', 8)
    const fresh = open(50_000, REGISTER, 'confirmed', 20)
    const a = count(oldOne.shift, 100_000)
    const events = [oldOne.e, a.e, close(oldOne.shift, a.cashCount, 100_000, 100_000), fresh.e]
    expect(shiftOfRegister(events, REGISTER)).toMatchObject({ id: fresh.shift, base: 50_000 })
    // Also if the list order is different.
    expect(shiftOfRegister([...events].reverse(), REGISTER)?.id).toBe(fresh.shift)
  })

  it('a new shift still pending, with the previous one closed, is already the shift (to be confirmed)', () => {
    const oldOne = open(100_000, REGISTER, 'confirmed', 8)
    const fresh = open(50_000, REGISTER, 'pending', 20)
    const a = count(oldOne.shift, 100_000)
    const r = shiftOfRegister(
      [oldOne.e, a.e, close(oldOne.shift, a.cashCount, 100_000, 100_000), fresh.e],
      REGISTER,
    )
    expect(r).toMatchObject({ id: fresh.shift, pendingConfirmation: true })
  })

  it("closing another register's shift does not close mine, and closing one shift does not close the other", () => {
    const own = open(1_000)
    const outsider = open(2_000, newId())
    const a = count(outsider.shift, 2_000)
    const events = [own.e, outsider.e, a.e, close(outsider.shift, a.cashCount, 2_000, 2_000)]
    expect(shiftOfRegister(events, REGISTER)?.id).toBe(own.shift)
  })

  it('a close without its opening does not invent a shift', () => {
    expect(shiftOfRegister([close(newId(), newId(), 0, 0)], REGISTER)).toBeNull()
  })

  it('movements and counts are not shifts', () => {
    const t = open(100)
    expect(shiftOfRegister([move(t.shift, 'entry', 5), count(t.shift, 5).e], REGISTER)).toBeNull()
  })

  it('a shift closed by a confirmed close of ANOTHER shift with a different id is not confused', () => {
    const a = open(1_000, REGISTER, 'confirmed', 8)
    const b = open(2_000, REGISTER, 'confirmed', 9)
    const c = count(a.shift, 1_000)
    // The first one was closed; the second one (by a data error, also from this register) remains.
    const r = shiftOfRegister([a.e, b.e, c.e, close(a.shift, c.cashCount, 1_000, 1_000)], REGISTER)
    expect(r?.id).toBe(b.shift)
  })
})

describe('registerReconciliation', () => {
  it('the DINERO.md example with what is saved here: 219.800', () => {
    const t = open(200_000)
    const p = payment(t.shift, {
      amount: 36_810,
      rounding_adjustment: -10,
      tip: 3_000,
      tendered: 39_800,
      rounding: { multiple: 100, mode: 'nearest_half_down' },
    })
    const c = registerReconciliation([t.e, p.e, move(t.shift, 'tip_payout', 20_000)], t.shift)
    expect(c?.cash.expected).toBe(219_800)
    expect(c?.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 36_800, tip: 3_000, payments: 1 },
    ])
  })

  it('a pending movement or payment counts (it is already saved here)', () => {
    const t = open(10_000)
    const c = registerReconciliation(
      [
        t.e,
        move(t.shift, 'entry', 5_000, 'pending'),
        payment(t.shift, { amount: 1_000, tendered: 1_000 }, 'pending').e,
      ],
      t.shift,
    )
    expect(c?.cash.expected).toBe(16_000)
    expect(c?.movements).toHaveLength(1)
  })

  it('what the hub rejected does not count: not the movement, nor the payment, nor the count, nor the close', () => {
    const t = open(10_000)
    const a = count(t.shift, 10_000, 'rejected')
    const c = registerReconciliation(
      [
        t.e,
        move(t.shift, 'output', 5_000, 'rejected'),
        payment(t.shift, { amount: 1_000, tendered: 1_000 }, 'rejected').e,
        a.e,
        close(t.shift, a.cashCount, 10_000, 10_000, 'rejected'),
      ],
      t.shift,
    )
    expect(c).toMatchObject({
      cash: { expected: 10_000, outflows: 0, charged: 0 },
      movements: [],
      cashCounts: [],
      byMethod: [],
      closed: null,
    })
  })

  it('a rejected opening: no reconciliation', () => {
    const t = open(10_000, REGISTER, 'rejected')
    expect(registerReconciliation([t.e], t.shift)).toBeNull()
  })

  it('a pending opening does give a reconciliation', () => {
    const t = open(10_000, REGISTER, 'pending')
    expect(registerReconciliation([t.e], t.shift)?.cash.expected).toBe(10_000)
  })

  it('with the close confirmed the reconciliation says so; with the pending one too (it shows it was sent)', () => {
    const t = open(10_000)
    const a = count(t.shift, 9_000)
    const closeout = close(t.shift, a.cashCount, 10_000, 9_000, 'confirmed', 'Falta un vale')
    expect(registerReconciliation([t.e, a.e, closeout], t.shift)?.closed).toMatchObject({
      expected: 10_000,
      counted: 9_000,
      variance: -1_000,
      justification: 'Falta un vale',
    })
    const pending = close(t.shift, a.cashCount, 10_000, 9_000, 'pending', 'Falta un vale')
    expect(registerReconciliation([t.e, a.e, pending], t.shift)?.closed?.variance).toBe(-1_000)
  })

  it('several counts: all of them, in list order, and the expected amount does not change', () => {
    const t = open(10_000)
    const a1 = count(t.shift, 9_000)
    const a2 = count(t.shift, 10_000)
    const c = registerReconciliation([t.e, a1.e, a2.e], t.shift)
    expect(c?.cashCounts.map((a) => a.counted)).toEqual([9_000, 10_000])
    expect(c?.cash.expected).toBe(10_000)
  })

  it('a void in this shift of a payment from the previous shift subtracts from this drawer', () => {
    const oldOne = open(0, REGISTER, 'confirmed', 8)
    const today = open(100_000, REGISTER, 'confirmed', 20)
    const p = payment(oldOne.shift, { amount: 30_000, tip: 2_000, tendered: 32_000 })
    const voidEntry = local(
      'PaymentVoided',
      newId(),
      { payment_id: p.data.payment_id, register_shift_id: today.shift } as never,
      'confirmed',
      { reason: 'Error' },
    )
    const c = registerReconciliation([oldOne.e, today.e, p.e, voidEntry], today.shift)
    expect(c?.cash).toMatchObject({ refunds: 32_000, expected: 68_000 })
  })

  it('without an opening or from an unknown shift, null', () => {
    expect(registerReconciliation([], newId())).toBeNull()
  })
})

describe('shiftSummary: rejected payments and shifts', () => {
  it('a rejected payment does not add; a pending one does', () => {
    const t = open(0)
    const r = shiftSummary(
      [
        payment(t.shift, { amount: 5_000, tendered: 5_000 }, 'rejected').e,
        payment(t.shift, { amount: 7_000, tendered: 7_000 }, 'pending').e,
      ],
      t.shift,
    )
    expect(r).toEqual({
      byMethod: [{ method: 'cash', customMethodId: null, sale: 7_000, tip: 0, payments: 1 }],
      payments: 1,
    })
  })

  it('the methods that end at zero (payment + void) do not show and the net payments add up to 0', () => {
    const t = open(0)
    const p = payment(t.shift, { amount: 5_000, tendered: 5_000 })
    const voidEntry = local(
      'PaymentVoided',
      newId(),
      { payment_id: p.data.payment_id, register_shift_id: t.shift } as never,
      'confirmed',
      { reason: 'Error' },
    )
    expect(shiftSummary([p.e, voidEntry], t.shift)).toEqual({ byMethod: [], payments: 0 })
  })

  it("a refund of a custom-method payment from a previous shift stays in the custom method's row", () => {
    const SODEXO = newId()
    const oldOne = open(0, REGISTER, 'confirmed', 8)
    const today = open(0, REGISTER, 'confirmed', 20)
    const p = payment(oldOne.shift, {
      method: 'other',
      custom_method_id: SODEXO,
      amount: 20_000,
      tendered: null,
      change: null,
    })
    const refund = local(
      'RefundRecorded',
      newId(),
      {
        payment_id: p.data.payment_id,
        refund_id: newId(),
        sale_amount: 5_000,
        tip_amount: 0,
        method: 'other',
        register_shift_id: today.shift,
      } as never,
      'confirmed',
      { reason: 'Devolución' },
    )
    expect(
      shiftSummary([oldOne.e, today.e, p.e, refund] as LocalEvent[], today.shift).byMethod,
    ).toEqual([{ method: 'other', customMethodId: SODEXO, sale: -5_000, tip: 0, payments: 0 }])
  })
})

describe("a closed shift's payments still count in their shift", () => {
  it("after the close, the closed shift's summary and reconciliation do not change", () => {
    const t = open(10_000)
    const p = payment(t.shift, { amount: 5_000, tendered: 5_000 })
    const a = count(t.shift, 15_000)
    const closeout = close(t.shift, a.cashCount, 15_000, 15_000)
    const events = [t.e, p.e, a.e, closeout]
    expect(registerReconciliation(events, t.shift)?.cash.expected).toBe(15_000)
    expect(shiftSummary(events, t.shift).payments).toBe(1)
    expect(TIME).toBeTruthy()
  })
})
