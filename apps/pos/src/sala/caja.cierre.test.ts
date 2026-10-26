import { newId } from '@pos/core'
import type { EstadoLocal, EventoLocal } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { cuadreDeCaja, resumenTurno, turnoDeCaja } from './cuentas'
import { local, TIME } from './pruebas'

// Lo que la caja ve del turno (tarea 1.7): cuál está abierto aunque haya cerrados, el cuadre con lo
// guardado aquí (confirmado y pendiente, nunca lo rechazado) y el resumen por medio.

const CAJA = newId()
const time = (h: number) => `2026-10-26T${String(h).padStart(2, '0')}:00:00.000Z`

const shiftEvent = <T extends Parameters<typeof local>[0]>(
  type: T,
  shift: string,
  data: unknown,
  status: EstadoLocal = 'confirmed',
  extras: object = {},
) =>
  local(type, shift, data as never, status, {
    aggregate_type: 'register_shift',
    ...extras,
  } as never)

const open = (base: number, register = CAJA, status: EstadoLocal = 'confirmed', h = 8) => {
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
  status: EstadoLocal = 'confirmed',
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
const contar = (shift: string, counted: number, status: EstadoLocal = 'confirmed') => {
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
  status: EstadoLocal = 'confirmed',
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
  status: EstadoLocal = 'confirmed',
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

describe('turnoDeCaja: los turnos cerrados', () => {
  it('un turno con su TurnoCerrado confirmado ya no está abierto', () => {
    const t = open(100_000)
    const a = contar(t.shift, 100_000)
    expect(turnoDeCaja([t.e, a.e, close(t.shift, a.cashCount, 100_000, 100_000)], CAJA)).toBeNull()
  })

  it('el cierre pendiente (aún sin confirmar) no lo cierra: sigue abierto hasta que el hub acepte', () => {
    const t = open(100_000)
    const a = contar(t.shift, 100_000)
    const r = turnoDeCaja(
      [t.e, a.e, close(t.shift, a.cashCount, 100_000, 100_000, 'pending')],
      CAJA,
    )
    expect(r).toMatchObject({ id: t.shift, base: 100_000, porConfirmar: false })
  })

  it('el cierre rechazado deja el turno abierto', () => {
    const t = open(100_000)
    const a = contar(t.shift, 100_000)
    const rejected = close(t.shift, a.cashCount, 1, 100_000, 'rejected')
    expect(turnoDeCaja([t.e, a.e, rejected], CAJA)?.id).toBe(t.shift)
  })

  it('un cierre rechazado y luego uno confirmado: cerrado', () => {
    const t = open(100_000)
    const a = contar(t.shift, 100_000)
    expect(
      turnoDeCaja(
        [
          t.e,
          a.e,
          close(t.shift, a.cashCount, 1, 100_000, 'rejected'),
          close(t.shift, a.cashCount, 100_000, 100_000),
        ],
        CAJA,
      ),
    ).toBeNull()
  })

  it('cerrado el primero y abierto el segundo: el segundo es el turno de la caja', () => {
    const oldOne = open(100_000, CAJA, 'confirmed', 8)
    const fresh = open(50_000, CAJA, 'confirmed', 20)
    const a = contar(oldOne.shift, 100_000)
    const events = [oldOne.e, a.e, close(oldOne.shift, a.cashCount, 100_000, 100_000), fresh.e]
    expect(turnoDeCaja(events, CAJA)).toMatchObject({ id: fresh.shift, base: 50_000 })
    // También si el orden de la lista es otro.
    expect(turnoDeCaja([...events].reverse(), CAJA)?.id).toBe(fresh.shift)
  })

  it('un nuevo turno todavía pendiente, con el anterior cerrado, ya es el turno (por confirmar)', () => {
    const oldOne = open(100_000, CAJA, 'confirmed', 8)
    const fresh = open(50_000, CAJA, 'pending', 20)
    const a = contar(oldOne.shift, 100_000)
    const r = turnoDeCaja(
      [oldOne.e, a.e, close(oldOne.shift, a.cashCount, 100_000, 100_000), fresh.e],
      CAJA,
    )
    expect(r).toMatchObject({ id: fresh.shift, porConfirmar: true })
  })

  it('el cierre del turno de otra caja no cierra el mío, y el cierre de un turno no cierra al otro', () => {
    const mio = open(1_000)
    const ajeno = open(2_000, newId())
    const a = contar(ajeno.shift, 2_000)
    const events = [mio.e, ajeno.e, a.e, close(ajeno.shift, a.cashCount, 2_000, 2_000)]
    expect(turnoDeCaja(events, CAJA)?.id).toBe(mio.shift)
  })

  it('un cierre sin su apertura no inventa turno', () => {
    expect(turnoDeCaja([close(newId(), newId(), 0, 0)], CAJA)).toBeNull()
  })

  it('movimientos y conteos no son turnos', () => {
    const t = open(100)
    expect(turnoDeCaja([move(t.shift, 'entry', 5), contar(t.shift, 5).e], CAJA)).toBeNull()
  })

  it('un turno cerrado por un cierre confirmado de OTRO turno con id distinto no se confunde', () => {
    const a = open(1_000, CAJA, 'confirmed', 8)
    const b = open(2_000, CAJA, 'confirmed', 9)
    const c = contar(a.shift, 1_000)
    // El primero se cerró; el segundo (por error de datos, también de esta caja) sigue.
    const r = turnoDeCaja([a.e, b.e, c.e, close(a.shift, c.cashCount, 1_000, 1_000)], CAJA)
    expect(r?.id).toBe(b.shift)
  })
})

describe('cuadreDeCaja', () => {
  it('el ejemplo de DINERO.md con lo guardado aquí: 219.800', () => {
    const t = open(200_000)
    const p = payment(t.shift, {
      amount: 36_810,
      rounding_adjustment: -10,
      tip: 3_000,
      tendered: 39_800,
      rounding: { multiple: 100, mode: 'nearest_half_down' },
    })
    const c = cuadreDeCaja([t.e, p.e, move(t.shift, 'tip_payout', 20_000)], t.shift)
    expect(c?.cash.expected).toBe(219_800)
    expect(c?.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 36_800, tip: 3_000, payments: 1 },
    ])
  })

  it('un movimiento o un pago pendiente cuenta (ya está guardado aquí)', () => {
    const t = open(10_000)
    const c = cuadreDeCaja(
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

  it('lo rechazado por el hub no cuenta: ni el movimiento, ni el pago, ni el conteo, ni el cierre', () => {
    const t = open(10_000)
    const a = contar(t.shift, 10_000, 'rejected')
    const c = cuadreDeCaja(
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

  it('una apertura rechazada: sin cuadre', () => {
    const t = open(10_000, CAJA, 'rejected')
    expect(cuadreDeCaja([t.e], t.shift)).toBeNull()
  })

  it('una apertura pendiente sí da cuadre', () => {
    const t = open(10_000, CAJA, 'pending')
    expect(cuadreDeCaja([t.e], t.shift)?.cash.expected).toBe(10_000)
  })

  it('con el cierre confirmado el cuadre lo dice; con el pendiente también (se ve que se envió)', () => {
    const t = open(10_000)
    const a = contar(t.shift, 9_000)
    const closeout = close(t.shift, a.cashCount, 10_000, 9_000, 'confirmed', 'Falta un vale')
    expect(cuadreDeCaja([t.e, a.e, closeout], t.shift)?.closed).toMatchObject({
      expected: 10_000,
      counted: 9_000,
      variance: -1_000,
      justification: 'Falta un vale',
    })
    const pending = close(t.shift, a.cashCount, 10_000, 9_000, 'pending', 'Falta un vale')
    expect(cuadreDeCaja([t.e, a.e, pending], t.shift)?.closed?.variance).toBe(-1_000)
  })

  it('varios conteos: todos, en el orden de la lista, y el esperado no cambia', () => {
    const t = open(10_000)
    const a1 = contar(t.shift, 9_000)
    const a2 = contar(t.shift, 10_000)
    const c = cuadreDeCaja([t.e, a1.e, a2.e], t.shift)
    expect(c?.cashCounts.map((a) => a.counted)).toEqual([9_000, 10_000])
    expect(c?.cash.expected).toBe(10_000)
  })

  it('una anulación en este turno de un pago del turno anterior resta de este cajón', () => {
    const oldOne = open(0, CAJA, 'confirmed', 8)
    const today = open(100_000, CAJA, 'confirmed', 20)
    const p = payment(oldOne.shift, { amount: 30_000, tip: 2_000, tendered: 32_000 })
    const voidEntry = local(
      'PaymentVoided',
      newId(),
      { payment_id: p.data.payment_id, register_shift_id: today.shift } as never,
      'confirmed',
      { reason: 'Error' },
    )
    const c = cuadreDeCaja([oldOne.e, today.e, p.e, voidEntry], today.shift)
    expect(c?.cash).toMatchObject({ refunds: 32_000, expected: 68_000 })
  })

  it('sin apertura o de un turno desconocido, null', () => {
    expect(cuadreDeCaja([], newId())).toBeNull()
  })
})

describe('resumenTurno: lo rechazado y los turnos', () => {
  it('un pago rechazado no suma; uno pendiente sí', () => {
    const t = open(0)
    const r = resumenTurno(
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

  it('los medios que quedan en cero (pago + anulación) no salen y los pagos netos suman 0', () => {
    const t = open(0)
    const p = payment(t.shift, { amount: 5_000, tendered: 5_000 })
    const voidEntry = local(
      'PaymentVoided',
      newId(),
      { payment_id: p.data.payment_id, register_shift_id: t.shift } as never,
      'confirmed',
      { reason: 'Error' },
    )
    expect(resumenTurno([p.e, voidEntry], t.shift)).toEqual({ byMethod: [], payments: 0 })
  })

  it('un reembolso de un pago de medio propio de un turno anterior queda en el renglón del medio propio', () => {
    const SODEXO = newId()
    const oldOne = open(0, CAJA, 'confirmed', 8)
    const today = open(0, CAJA, 'confirmed', 20)
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
      resumenTurno([oldOne.e, today.e, p.e, refund] as EventoLocal[], today.shift).byMethod,
    ).toEqual([{ method: 'other', customMethodId: SODEXO, sale: -5_000, tip: 0, payments: 0 }])
  })
})

describe('los pagos de un turno cerrado siguen contando en su turno', () => {
  it('después del cierre, el resumen y el cuadre del turno cerrado no cambian', () => {
    const t = open(10_000)
    const p = payment(t.shift, { amount: 5_000, tendered: 5_000 })
    const a = contar(t.shift, 15_000)
    const closeout = close(t.shift, a.cashCount, 15_000, 15_000)
    const events = [t.e, p.e, a.e, closeout]
    expect(cuadreDeCaja(events, t.shift)?.cash.expected).toBe(15_000)
    expect(resumenTurno(events, t.shift).payments).toBe(1)
    expect(TIME).toBeTruthy()
  })
})
