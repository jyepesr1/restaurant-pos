import { newId, type OrderEvent } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { HubSync } from './hub/hub'
import { accesoLibre } from './pruebas/acceso'
import { AHORA, AlmacenQueSeCae, item, type Montaje, montar, venLoMismo } from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// Reglas de la caja en el hub (tarea 1.6, `problemaDeCaja`): un turno abierto por caja, pagos,
// anulaciones y reembolsos dentro del turno de la caja que los registra, y el redondeo del efectivo
// del restaurante. El turno vive en memoria y se reconstruye de los eventos al reiniciar.

const REDONDEO = { multiple: 100, mode: 'nearest_half_down' }
/** El datáfono activo del restaurante en estas pruebas. */
const DATAFONO = newId()
const REGLAS = {
  ...REDONDEO,
  medios: ['cash', 'card', 'nequi', 'daviplata', 'breb', 'transfer'],
  cardTerminals: [DATAFONO],
}
type Reglas = {
  multiple: number
  mode: string
  medios: string[]
  mediosPropios?: string[]
  cardTerminals: string[]
}

const conexionDe = (m: Montaje, node: Nodo) => {
  const connection = m.network.tokens.get(`token-${node.name}`)
  if (!connection) throw new Error(`Sin token para ${node.name}`)
  return connection
}

/** Un hub con las reglas de cobro del restaurante sobre el almacén del montaje. */
function hubConReglas(m: Montaje, reglas: () => Reglas = () => REGLAS) {
  return new HubSync(m.almacen, {
    restauranteId: m.restauranteId,
    timeZone: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    access: accesoLibre,
    instancia: 'hub-1',
    clock: m.network.horaIso,
    reglasCobro: reglas,
  })
}

function device(options: { reglas?: boolean } = {}) {
  const m = montar()
  const register = m.network.device('register')
  const register2 = m.network.device('register2')
  const ana = m.network.device('ana')
  const status: { hub: HubSync } = {
    hub: options.reglas === false ? m.hub() : hubConReglas(m),
  }

  const crudo = (
    node: Nodo,
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
    device_id: node.dispositivoId,
    authorization_id: null,
    reason: type === 'PaymentVoided' || type === 'RefundRecorded' ? 'Prueba' : null,
    device_time: AHORA,
    hub_estimated_time: AHORA,
    base_sequence: m.almacen.maxSecuencia(),
    ...extras,
  })
  const send = (node: Nodo, events: Record<string, unknown>[]) =>
    status.hub.recibirLote(conexionDe(m, node), events)
  const one = (node: Nodo, event: Record<string, unknown>) => send(node, [event]).resultados[0]

  const abrirTurno = (node: Nodo, base = 200_000, shift = newId()) => {
    const r = one(
      node,
      crudo(node, 'ShiftOpened', shift, { register_id: node.dispositivoId, base }),
    )
    return { shift, result: r }
  }
  const abrirPedido = (node: Nodo, price: number) => {
    const order = newId()
    one(node, crudo(node, 'OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 }))
    one(node, crudo(node, 'ItemAdded', order, item(price)))
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
      card_terminal_id: DATAFONO,
      franchise: 'Visa',
      last4: '4242',
      approval_code: null,
      receipt: null,
    },
    charge_reference: null,
    ...fields,
  })
  /** Efectivo que cancela el saldo `monto`, con el ajuste que da la regla del restaurante. */
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
    crudo,
    send,
    one,
    abrirTurno,
    abrirPedido,
    cardPaymentData,
    cashPaymentData,
  }
}

const reason = (r: unknown) => (r as { status: string; reason?: string }).reason
const stateOf = (r: unknown) => (r as { status: string }).status

describe('turno de caja: uno por caja', () => {
  it('abre el turno: confirmado, y el hub lo recuerda con su base, quién y cuándo', () => {
    const { register, status, abrirTurno } = device()
    const { shift, result } = abrirTurno(register, 150_000)
    expect(result).toMatchObject({ status: 'confirmed' })
    expect(status.hub.turnoAbierto(register.dispositivoId)).toEqual({
      id: shift,
      registerId: register.dispositivoId,
      base: 150_000,
      openedAt: expect.any(String),
      userId: register.userId,
    })
  })

  it('una caja sin turno no tiene turno abierto', () => {
    const { register, ana, status } = device()
    expect(status.hub.turnoAbierto(register.dispositivoId)).toBeNull()
    expect(status.hub.turnoAbierto(ana.dispositivoId)).toBeNull()
    expect(status.hub.turnoAbierto(newId())).toBeNull()
  })

  it('el segundo turno de la misma caja se rechaza con turno_ya_abierto y el primero sigue', () => {
    const { m, register, status, abrirTurno } = device()
    const firstOne = abrirTurno(register)
    const before = m.almacen.maxSecuencia()
    const secondOne = abrirTurno(register, 50_000)
    expect(secondOne.result).toMatchObject({ status: 'rejected', reason: 'shift_already_open' })
    expect(status.hub.turnoAbierto(register.dispositivoId)?.id).toBe(firstOne.shift)
    expect(status.hub.turnoAbierto(register.dispositivoId)?.base).toBe(200_000)
    expect(m.almacen.maxSecuencia()).toBe(before)
  })

  it('el rechazo se repite igual si la caja reenvía el mismo evento', () => {
    const { register, status, crudo, send, abrirTurno } = device()
    abrirTurno(register)
    const shift2 = crudo(register, 'ShiftOpened', newId(), {
      register_id: register.dispositivoId,
      base: 1,
    })
    const a = send(register, [shift2]).resultados[0]
    const b = send(register, [shift2]).resultados[0]
    expect(a).toMatchObject({ status: 'rejected', reason: 'shift_already_open' })
    expect(b).toEqual(a)
    expect(status.hub.turnoAbierto(register.dispositivoId)?.base).toBe(200_000)
  })

  it('reenviar el mismo TurnoAbierto confirmado es idempotente: no es un segundo turno', () => {
    const { m, register, crudo, send } = device()
    const shift = crudo(register, 'ShiftOpened', newId(), {
      register_id: register.dispositivoId,
      base: 10,
    })
    const a = send(register, [shift]).resultados[0]
    const b = send(register, [shift]).resultados[0]
    expect(stateOf(a)).toBe('confirmed')
    expect(b).toEqual(a)
    expect(m.almacen.maxSecuencia()).toBe(1)
  })

  it('dos cajas distintas pueden tener su turno abierto al mismo tiempo', () => {
    const { register, register2, status, abrirTurno } = device()
    const a = abrirTurno(register)
    const b = abrirTurno(register2, 0)
    expect(stateOf(b.result)).toBe('confirmed')
    expect(status.hub.turnoAbierto(register.dispositivoId)?.id).toBe(a.shift)
    expect(status.hub.turnoAbierto(register2.dispositivoId)?.id).toBe(b.shift)
  })

  it('el id del turno de otra caja no se puede reusar (turno_ya_existe)', () => {
    const { register, register2, status, abrirTurno } = device()
    const a = abrirTurno(register)
    const reuso = abrirTurno(register2, 0, a.shift)
    expect(reuso.result).toMatchObject({ status: 'rejected', reason: 'shift_already_exists' })
    expect(status.hub.turnoAbierto(register2.dispositivoId)).toBeNull()
  })

  it('caja_distinta: una caja no abre el turno de otra', () => {
    const { register, register2, status, one, crudo } = device()
    const r = one(
      register,
      crudo(register, 'ShiftOpened', newId(), { register_id: register2.dispositivoId, base: 0 }),
    )
    expect(r).toMatchObject({ status: 'rejected', reason: 'register_mismatch' })
    expect(status.hub.turnoAbierto(register2.dispositivoId)).toBeNull()
    expect(status.hub.turnoAbierto(register.dispositivoId)).toBeNull()
  })

  it('caja_distinta también si el caja_id es de un equipo que no existe', () => {
    const { register, one, crudo } = device()
    const r = one(
      register,
      crudo(register, 'ShiftOpened', newId(), { register_id: newId(), base: 0 }),
    )
    expect(reason(r)).toBe('register_mismatch')
  })

  it('un TurnoAbierto con formato inválido (base negativa) se rechaza por esquema', () => {
    const { register, status, one, crudo } = device()
    const r = one(
      register,
      crudo(register, 'ShiftOpened', newId(), { register_id: register.dispositivoId, base: -5 }),
    )
    expect(reason(r)).toMatch(/^esquema/)
    expect(status.hub.turnoAbierto(register.dispositivoId)).toBeNull()
  })

  it('un TurnoAbierto firmado como evento de pedido se rechaza por esquema', () => {
    const { register, one, crudo } = device()
    const r = one(
      register,
      crudo(
        register,
        'ShiftOpened',
        newId(),
        { register_id: register.dispositivoId, base: 0 },
        { aggregate_type: 'order' },
      ),
    )
    expect(reason(r)).toMatch(/^esquema/)
  })

  it('un TurnoAbierto no toca ningún pedido: el pedido abierto queda como estaba', () => {
    const { register, ana, status, abrirPedido, abrirTurno } = device()
    const order = abrirPedido(ana, 40_900)
    const before = status.hub.order(order)
    abrirTurno(register)
    expect(status.hub.order(order)).toEqual(before)
  })
})

describe('TurnoAbierto: no se mezcla con el pedido', () => {
  // BUG: el hub guarda un ShiftOpened que nombra un pedido en `relacionados` como evento de ese
  // pedido (packages/sync/src/hub/hub.ts: `agregados = pedidosDe(evento)` en `procesar`, que toma
  // `relacionados` sin mirar el aggregate_type). La causa de fondo es el esquema, ver
  // packages/core/src/eventos/pedido.ts (falta la guarda que sí tiene ProductSoldOut).
  it('un TurnoAbierto con un pedido en relacionados no queda en la historia del pedido', () => {
    const { register, ana, m, one, crudo, abrirPedido } = device()
    const order = abrirPedido(ana, 40_900)
    one(
      register,
      crudo(
        register,
        'ShiftOpened',
        newId(),
        { register_id: register.dispositivoId, base: 0 },
        { related: [order] },
      ),
    )
    expect(m.almacen.eventosDeAgregado(order).map((e) => e.type)).not.toContain('ShiftOpened')
  })
})

describe('pagos, anulaciones y reembolsos: turno y caja', () => {
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

  it('un pago sin turno se rechaza con sin_turno y no queda en el pedido', () => {
    const { register, status, one, crudo, abrirPedido, cardPaymentData } = device()
    const order = abrirPedido(register, 40_900)
    const r = one(
      register,
      crudo(register, 'PaymentRecorded', order, cardPaymentData(newId(), 40_900)),
    )
    expect(r).toMatchObject({ status: 'rejected', reason: 'no_shift' })
    expect(Object.keys(status.hub.order(order)?.payments ?? {})).toEqual([])
  })

  it('un pago con el turno abierto se acepta', () => {
    const { register, status, one, crudo, abrirPedido, abrirTurno, cardPaymentData } = device()
    const order = abrirPedido(register, 40_900)
    const { shift } = abrirTurno(register)
    const r = one(
      register,
      crudo(register, 'PaymentRecorded', order, cardPaymentData(shift, 40_900)),
    )
    expect(stateOf(r)).toBe('confirmed')
    expect(Object.values(status.hub.order(order)?.payments ?? {})[0]).toMatchObject({
      registerShiftId: shift,
      amount: 40_900,
    })
  })

  it('turno_de_otra_caja: la caja 2 no cobra en el turno de la caja 1', () => {
    const { register, register2, one, crudo, abrirPedido, abrirTurno, cardPaymentData } = device()
    const order = abrirPedido(register, 40_900)
    const { shift } = abrirTurno(register)
    abrirTurno(register2)
    const r = one(
      register2,
      crudo(register2, 'PaymentRecorded', order, cardPaymentData(shift, 40_900)),
    )
    expect(r).toMatchObject({ status: 'rejected', reason: 'other_register_shift' })
  })

  it('un equipo que no es caja (sin turno propio) tampoco cobra en el turno ajeno', () => {
    const { register, ana, one, crudo, abrirPedido, abrirTurno, cardPaymentData } = device()
    const order = abrirPedido(ana, 40_900)
    const { shift } = abrirTurno(register)
    const r = one(ana, crudo(ana, 'PaymentRecorded', order, cardPaymentData(shift, 40_900)))
    expect(reason(r)).toBe('other_register_shift')
  })

  it('un id de turno que es de un pedido o inventado no sirve: sin_turno', () => {
    const { register, one, crudo, abrirPedido, abrirTurno, cardPaymentData } = device()
    const order = abrirPedido(register, 40_900)
    abrirTurno(register)
    expect(
      reason(
        one(register, crudo(register, 'PaymentRecorded', order, cardPaymentData(order, 1_000))),
      ),
    ).toBe('no_shift')
    expect(
      reason(
        one(register, crudo(register, 'PaymentRecorded', order, cardPaymentData(newId(), 1_000))),
      ),
    ).toBe('no_shift')
  })

  it('PagoAnulado: sin_turno, turno_de_otra_caja y, con el turno propio, se acepta', () => {
    const { register, register2, status, one, crudo, abrirPedido, abrirTurno, cardPaymentData } =
      device()
    const order = abrirPedido(register, 40_900)
    const { shift } = abrirTurno(register)
    const { shift: shift2 } = abrirTurno(register2)
    const payment = cardPaymentData(shift, 40_900)
    expect(stateOf(one(register, crudo(register, 'PaymentRecorded', order, payment)))).toBe(
      'confirmed',
    )

    expect(
      reason(
        one(
          register,
          crudo(register, 'PaymentVoided', order, voidEntry(payment.payment_id, newId())),
        ),
      ),
    ).toBe('no_shift')
    expect(
      reason(
        one(
          register2,
          crudo(register2, 'PaymentVoided', order, voidEntry(payment.payment_id, shift)),
        ),
      ),
    ).toBe('other_register_shift')
    // La caja 2 con su propio turno sí puede anular: el pago cae en el turno en que se anula.
    expect(
      stateOf(
        one(
          register,
          crudo(register, 'PaymentVoided', order, voidEntry(payment.payment_id, shift)),
        ),
      ),
    ).toBe('confirmed')
    expect(status.hub.order(order)?.payments[payment.payment_id]?.voided).toBe(true)
    expect(shift2).toBeTruthy()
  })

  it('ReembolsoRegistrado: sin_turno, turno_de_otra_caja y, con el turno propio, se acepta', () => {
    const { register, register2, status, one, crudo, abrirPedido, abrirTurno, cardPaymentData } =
      device()
    const order = abrirPedido(register, 40_900)
    const { shift } = abrirTurno(register)
    abrirTurno(register2)
    const payment = cardPaymentData(shift, 40_900)
    one(register, crudo(register, 'PaymentRecorded', order, payment))

    expect(
      reason(
        one(
          register,
          crudo(register, 'RefundRecorded', order, refund(payment.payment_id, newId())),
        ),
      ),
    ).toBe('no_shift')
    expect(
      reason(
        one(
          register2,
          crudo(register2, 'RefundRecorded', order, refund(payment.payment_id, shift)),
        ),
      ),
    ).toBe('other_register_shift')
    expect(
      stateOf(
        one(register, crudo(register, 'RefundRecorded', order, refund(payment.payment_id, shift))),
      ),
    ).toBe('confirmed')
    expect(status.hub.order(order)?.payments[payment.payment_id]?.refundedSale).toBe(1_000)
  })

  it('un rechazo por turno no deja huella en el pedido ni hueco en las secuencias', () => {
    const { m, register, one, crudo, abrirPedido, cardPaymentData } = device()
    const order = abrirPedido(register, 40_900)
    const before = m.almacen.maxSecuencia()
    one(register, crudo(register, 'PaymentRecorded', order, cardPaymentData(newId(), 40_900)))
    expect(m.almacen.maxSecuencia()).toBe(before)
    expect(m.hub().conflictos()).toEqual([])
  })

  it('sin turno ni siquiera se puede cerrar: el pedido queda con saldo pendiente', () => {
    const { register, one, crudo, abrirPedido, cardPaymentData } = device()
    const order = abrirPedido(register, 40_900)
    one(register, crudo(register, 'PaymentRecorded', order, cardPaymentData(newId(), 40_900)))
    expect(reason(one(register, crudo(register, 'OrderClosed', order, {})))).toBe('pending_balance')
  })
})

describe('redondeo del efectivo: el del restaurante', () => {
  // Pedido de $36.810: el efectivo que lo cancela se cobra a $36.800 (ajuste −10).
  const cobrar = (rounding: object | null, options: { reglas?: boolean } = {}) => {
    const e = device(options)
    const order = e.abrirPedido(e.register, 36_810)
    const { shift } = e.abrirTurno(e.register)
    const r = e.one(
      e.register,
      e.crudo(
        e.register,
        'PaymentRecorded',
        order,
        e.cashPaymentData(shift, 36_810, -10, rounding),
      ),
    )
    return { ...e, order, shift, r }
  }

  it('con la regla del restaurante, el pago en efectivo se acepta', () => {
    const { r, status, order } = cobrar(REDONDEO)
    expect(stateOf(r)).toBe('confirmed')
    expect(status.hub.order(order)?.payments).toBeDefined()
  })

  it('redondeo_distinto: otro múltiplo', () => {
    expect(cobrar({ multiple: 50, mode: 'nearest_half_down' }).r).toMatchObject({
      status: 'rejected',
      reason: 'rounding_mismatch',
    })
  })

  it('redondeo_distinto: otro modo', () => {
    expect(reason(cobrar({ multiple: 100, mode: 'up' }).r)).toBe('rounding_mismatch')
    expect(reason(cobrar({ multiple: 100, mode: 'nearest_half_up' }).r)).toBe('rounding_mismatch')
  })

  it('si el restaurante cambia la regla, el hub usa la vigente en cada pago', () => {
    const e = device({ reglas: false })
    let rule: Reglas = { ...REGLAS }
    e.status.hub = hubConReglas(e.m, () => rule)
    const order = e.abrirPedido(e.register, 36_810)
    const { shift } = e.abrirTurno(e.register)
    rule = { ...REGLAS, multiple: 50 }
    const oldOne = e.one(
      e.register,
      e.crudo(
        e.register,
        'PaymentRecorded',
        order,
        e.cashPaymentData(shift, 36_810, -10, REDONDEO),
      ),
    )
    expect(reason(oldOne)).toBe('rounding_mismatch')
  })

  it('un pago sin redondeo (parcial o saldo ya redondo) no se compara', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 36_800)
    const { shift } = e.abrirTurno(e.register)
    const r = e.one(
      e.register,
      e.crudo(e.register, 'PaymentRecorded', order, e.cashPaymentData(shift, 36_800, 0, null)),
    )
    expect(stateOf(r)).toBe('confirmed')
  })

  it('un pago con tarjeta no tiene redondeo y no se ve afectado por la regla', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 36_810)
    const { shift } = e.abrirTurno(e.register)
    const r = e.one(
      e.register,
      e.crudo(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift, 36_810)),
    )
    expect(stateOf(r)).toBe('confirmed')
  })

  it('un hub sin la regla configurada no compara el redondeo', () => {
    const { r } = cobrar({ multiple: 50, mode: 'down' }, { reglas: false })
    // 50 con modo "abajo" da otro ajuste: el reductor lo rechaza, pero no por rounding_mismatch.
    expect(reason(r)).not.toBe('rounding_mismatch')
  })

  it('el rechazo por redondeo no crea el pago ni ocupa una secuencia', () => {
    const e = cobrar({ multiple: 1000, mode: 'up' })
    expect(Object.keys(e.status.hub.order(e.order)?.payments ?? {})).toEqual([])
  })
})

describe('medio y datáfono: los del restaurante', () => {
  const pagoNequi = (shift: string, amount: number) => ({
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

  it('medio_no_habilitado: un medio que el restaurante no recibe se rechaza', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 10_000)
    const { shift } = e.abrirTurno(e.register)
    e.status.hub = hubConReglas(e.m, () => ({ ...REGLAS, medios: ['cash', 'card'] }))
    const r = e.one(
      e.register,
      e.crudo(e.register, 'PaymentRecorded', order, pagoNequi(shift, 10_000)),
    )
    expect(r).toMatchObject({ status: 'rejected', reason: 'method_not_enabled' })
    expect(Object.keys(e.status.hub.order(order)?.payments ?? {})).toEqual([])
  })

  it('un medio habilitado se acepta, y el bono solo si el restaurante lo incluye', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 20_000)
    const { shift } = e.abrirTurno(e.register)
    expect(
      stateOf(
        e.one(e.register, e.crudo(e.register, 'PaymentRecorded', order, pagoNequi(shift, 10_000))),
      ),
    ).toBe('confirmed')
    const voucher = { ...pagoNequi(shift, 10_000), method: 'voucher' }
    expect(reason(e.one(e.register, e.crudo(e.register, 'PaymentRecorded', order, voucher)))).toBe(
      'method_not_enabled',
    )
    e.status.hub = hubConReglas(e.m, () => ({ ...REGLAS, medios: [...REGLAS.medios, 'voucher'] }))
    expect(stateOf(e.one(e.register, e.crudo(e.register, 'PaymentRecorded', order, voucher)))).toBe(
      'confirmed',
    )
  })

  it('si el administrador quita un medio con el hub andando, el siguiente pago ya no pasa', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 20_000)
    const { shift } = e.abrirTurno(e.register)
    let medios = [...REGLAS.medios]
    e.status.hub = hubConReglas(e.m, () => ({ ...REGLAS, medios }))
    expect(
      stateOf(
        e.one(e.register, e.crudo(e.register, 'PaymentRecorded', order, pagoNequi(shift, 5_000))),
      ),
    ).toBe('confirmed')
    medios = medios.filter((x) => x !== 'nequi')
    expect(
      reason(
        e.one(e.register, e.crudo(e.register, 'PaymentRecorded', order, pagoNequi(shift, 5_000))),
      ),
    ).toBe('method_not_enabled')
  })

  it('datafono_desconocido: la tarjeta nombra un datáfono que no está activo', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 10_000)
    const { shift } = e.abrirTurno(e.register)
    const ajeno = e.cardPaymentData(shift, 10_000, {
      cardTerminal: {
        card_terminal_id: newId(),
        franchise: null,
        last4: null,
        approval_code: null,
        receipt: null,
      },
    })
    const r = e.one(e.register, e.crudo(e.register, 'PaymentRecorded', order, ajeno))
    expect(r).toMatchObject({ status: 'rejected', reason: 'unknown_card_terminal' })
  })

  it('un datáfono archivado deja de valer aunque el celular siga mostrándolo', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 10_000)
    const { shift } = e.abrirTurno(e.register)
    e.status.hub = hubConReglas(e.m, () => ({ ...REGLAS, cardTerminals: [] }))
    const r = e.one(
      e.register,
      e.crudo(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift, 10_000)),
    )
    expect(reason(r)).toBe('unknown_card_terminal')
  })

  it('una tarjeta sin número de aprobación (solo el monto) se acepta con un datáfono activo', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 10_000)
    const { shift } = e.abrirTurno(e.register)
    const r = e.one(
      e.register,
      e.crudo(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift, 10_000)),
    )
    expect(stateOf(r)).toBe('confirmed')
  })

  it('el efectivo no necesita datáfono y no se afecta por la lista de datáfonos', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 36_800)
    const { shift } = e.abrirTurno(e.register)
    e.status.hub = hubConReglas(e.m, () => ({ ...REGLAS, cardTerminals: [] }))
    const r = e.one(
      e.register,
      e.crudo(e.register, 'PaymentRecorded', order, e.cashPaymentData(shift, 36_800, 0, null)),
    )
    expect(stateOf(r)).toBe('confirmed')
  })

  it('el orden de las reglas: sin turno gana a medio no habilitado', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 10_000)
    e.status.hub = hubConReglas(e.m, () => ({ ...REGLAS, medios: ['cash'] }))
    const r = e.one(
      e.register,
      e.crudo(e.register, 'PaymentRecorded', order, pagoNequi(newId(), 10_000)),
    )
    expect(reason(r)).toBe('no_shift')
  })

  it('anular y reembolsar no revisan el medio: se puede devolver lo cobrado por un medio que ya no se recibe', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 10_000)
    const { shift } = e.abrirTurno(e.register)
    const payment = pagoNequi(shift, 10_000)
    e.one(e.register, e.crudo(e.register, 'PaymentRecorded', order, payment))
    e.status.hub = hubConReglas(e.m, () => ({ ...REGLAS, medios: ['cash'] }))
    const r = e.one(
      e.register,
      e.crudo(e.register, 'PaymentVoided', order, {
        payment_id: payment.payment_id,
        register_shift_id: shift,
      }),
    )
    expect(stateOf(r)).toBe('confirmed')
  })
})

describe('medios propios del restaurante', () => {
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
  const montar = (activeRows: string[]) => {
    const e = device()
    e.status.hub = hubConReglas(e.m, () => ({ ...REGLAS, mediosPropios: activeRows }))
    const order = e.abrirPedido(e.register, 30_000)
    const { shift } = e.abrirTurno(e.register)
    return { ...e, order, shift }
  }

  it('un medio propio activo se acepta y queda en el pago', () => {
    const e = montar([SODEXO])
    const r = e.one(
      e.register,
      e.crudo(e.register, 'PaymentRecorded', e.order, own(e.shift, SODEXO, 10_000)),
    )
    expect(stateOf(r)).toBe('confirmed')
    expect(Object.values(e.status.hub.order(e.order)?.payments ?? {})[0]).toMatchObject({
      method: 'other',
      customMethodId: SODEXO,
    })
  })

  it('uno desconocido o archivado (fuera de la lista de activos) se rechaza con medio_no_habilitado', () => {
    const e = montar([SODEXO])
    const ajeno = e.one(
      e.register,
      e.crudo(e.register, 'PaymentRecorded', e.order, own(e.shift, newId(), 1_000)),
    )
    expect(ajeno).toMatchObject({ status: 'rejected', reason: 'method_not_enabled' })
    const archived = montar([])
    const r = archived.one(
      archived.register,
      archived.crudo(
        archived.register,
        'PaymentRecorded',
        archived.order,
        own(archived.shift, SODEXO, 1_000),
      ),
    )
    expect(reason(r)).toBe('method_not_enabled')
  })

  it('un hub sin la lista de medios propios (undefined) rechaza cualquier medio propio', () => {
    const e = device()
    e.status.hub = hubConReglas(e.m, () => ({ ...REGLAS }))
    const order = e.abrirPedido(e.register, 10_000)
    const { shift } = e.abrirTurno(e.register)
    const r = e.one(
      e.register,
      e.crudo(e.register, 'PaymentRecorded', order, own(shift, SODEXO, 1_000)),
    )
    expect(reason(r)).toBe('method_not_enabled')
  })

  it('«otro» sin id, o un id con otro medio, se rechaza por esquema', () => {
    const e = montar([SODEXO])
    expect(
      reason(
        e.one(
          e.register,
          e.crudo(e.register, 'PaymentRecorded', e.order, own(e.shift, null, 1_000)),
        ),
      ),
    ).toMatch(/^esquema/)
    expect(
      reason(
        e.one(
          e.register,
          e.crudo(e.register, 'PaymentRecorded', e.order, own(e.shift, SODEXO, 1_000, 'nequi')),
        ),
      ),
    ).toMatch(/^esquema/)
  })

  it('anular el pago de un medio propio archivado después sigue permitido', () => {
    const e = montar([SODEXO])
    const payment = own(e.shift, SODEXO, 10_000)
    e.one(e.register, e.crudo(e.register, 'PaymentRecorded', e.order, payment))
    e.status.hub = hubConReglas(e.m, () => ({ ...REGLAS, mediosPropios: [] }))
    const r = e.one(
      e.register,
      e.crudo(e.register, 'PaymentVoided', e.order, {
        payment_id: payment.payment_id,
        register_shift_id: e.shift,
      }),
    )
    expect(stateOf(r)).toBe('confirmed')
  })
})

describe('el turno sobrevive al reinicio del hub', () => {
  it('un hub nuevo sobre la misma base conoce el turno abierto y su base', () => {
    const e = device()
    const { shift } = e.abrirTurno(e.register, 120_000)
    const reiniciado = hubConReglas(e.m)
    expect(reiniciado.turnoAbierto(e.register.dispositivoId)).toMatchObject({
      id: shift,
      base: 120_000,
      userId: e.register.userId,
    })
  })

  it('tras el reinicio sigue rechazando el segundo turno y aceptando pagos en el turno', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 40_900)
    const { shift } = e.abrirTurno(e.register)
    e.status.hub = hubConReglas(e.m)
    expect(reason(e.abrirTurno(e.register).result)).toBe('shift_already_open')
    const r = e.one(
      e.register,
      e.crudo(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift, 40_900)),
    )
    expect(stateOf(r)).toBe('confirmed')
  })

  it('el turno rechazado no reaparece tras el reinicio, y el abierto conserva su base', () => {
    const e = device()
    const firstOne = e.abrirTurno(e.register, 100)
    e.abrirTurno(e.register, 999)
    const reiniciado = hubConReglas(e.m)
    expect(reiniciado.turnoAbierto(e.register.dispositivoId)?.id).toBe(firstOne.shift)
    expect(reiniciado.turnoAbierto(e.register.dispositivoId)?.base).toBe(100)
  })

  it('con varias páginas de eventos de pedido, el turno sigue ahí', () => {
    const e = device()
    const { shift } = e.abrirTurno(e.register)
    // Más eventos que una página de reconstrucción.
    for (let i = 0; i < 12; i++) e.abrirPedido(e.ana, 1_000 + i)
    const reiniciado = hubConReglas(e.m)
    expect(reiniciado.turnoAbierto(e.register.dispositivoId)?.id).toBe(shift)
  })

  it('un hub que reinicia sin conservar la base no inventa turnos', () => {
    const e = device()
    e.abrirTurno(e.register)
    const otraBase = montar()
    const empty = new HubSync(otraBase.almacen, {
      restauranteId: otraBase.restauranteId,
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      access: accesoLibre,
      instancia: 'hub-2',
      clock: otraBase.network.horaIso,
    })
    expect(empty.turnoAbierto(e.register.dispositivoId)).toBeNull()
  })
})

describe('un lote: abrir turno, pagar y cerrar el pedido', () => {
  it('todo en un solo lote queda confirmado y el pedido se cierra', () => {
    const e = device()
    const order = newId()
    const shift = newId()
    const payment = e.cashPaymentData(shift, 36_810, -10, REDONDEO)
    const base = e.m.almacen.maxSecuencia()
    const r = e.send(e.register, [
      e.crudo(
        e.register,
        'OrderOpened',
        order,
        { channel: 'dine_in', table_id: null, guests: 2 },
        { base_sequence: base },
      ),
      e.crudo(e.register, 'ItemAdded', order, item(36_810), { base_sequence: base }),
      e.crudo(
        e.register,
        'ShiftOpened',
        shift,
        { register_id: e.register.dispositivoId, base: 200_000 },
        { base_sequence: base },
      ),
      e.crudo(e.register, 'PaymentRecorded', order, payment, { base_sequence: base }),
      e.crudo(e.register, 'OrderClosed', order, {}, { base_sequence: base }),
    ])
    expect(r.resultados.map(stateOf)).toEqual(Array(5).fill('confirmed'))
    expect(r.aceptados.map((x: OrderEvent) => x.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(e.status.hub.order(order)).toMatchObject({ status: 'closed' })
    expect(e.status.hub.turnoAbierto(e.register.dispositivoId)?.id).toBe(shift)
  })

  it('el pago antes del turno en el mismo lote se rechaza con sin_turno y el cierre no pasa', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 40_900)
    const shift = newId()
    const r = e.send(e.register, [
      e.crudo(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift, 40_900)),
      e.crudo(e.register, 'ShiftOpened', shift, { register_id: e.register.dispositivoId, base: 0 }),
      e.crudo(e.register, 'OrderClosed', order, {}),
    ])
    expect(r.resultados.map((x) => (x.status === 'rejected' ? x.reason : x.status))).toEqual([
      'no_shift',
      'confirmed',
      'depends_on_rejected',
    ])
    expect(e.status.hub.order(order)?.status).toBe('open')
  })

  it('si el turno del lote se rechaza (ya hay uno), el pago de ese turno falla y lo demás sigue', () => {
    const e = device()
    const order = e.abrirPedido(e.register, 40_900)
    e.abrirTurno(e.register)
    const shift2 = newId()
    const r = e.send(e.register, [
      e.crudo(e.register, 'ShiftOpened', shift2, {
        register_id: e.register.dispositivoId,
        base: 0,
      }),
      e.crudo(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift2, 40_900)),
    ])
    expect(r.resultados.map((x) => (x.status === 'rejected' ? x.reason : x.status))).toEqual([
      'shift_already_open',
      'no_shift',
    ])
  })
})

describe('multirestaurante: el turno es de cada restaurante', () => {
  function dosRestaurantes() {
    const a = device()
    // Segundo restaurante en la misma base, con su propio hub y almacén.
    const otroId = newId()
    a.m.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(otroId, otroId, AHORA, AHORA)
    const hubB = new HubSync(new AlmacenSqlite(a.m.db, otroId), {
      restauranteId: otroId,
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      access: accesoLibre,
      instancia: 'hub-b',
      clock: a.m.network.horaIso,
      reglasCobro: () => REGLAS,
    })
    return { ...a, hubB, otroId }
  }

  it('el turno abierto en un restaurante no existe en el otro', () => {
    const e = dosRestaurantes()
    e.abrirTurno(e.register)
    expect(e.status.hub.turnoAbierto(e.register.dispositivoId)).not.toBeNull()
    expect(e.hubB.turnoAbierto(e.register.dispositivoId)).toBeNull()
  })

  it('un pago en el restaurante B con el turno del A se rechaza con sin_turno', () => {
    const e = dosRestaurantes()
    const { shift } = e.abrirTurno(e.register)
    const order = newId()
    const connection = conexionDe(e.m, e.register)
    const rB = e.hubB.recibirLote(connection, [
      e.crudo(
        e.register,
        'OrderOpened',
        order,
        { channel: 'dine_in', table_id: null, guests: 1 },
        { base_sequence: 0 },
      ),
      e.crudo(e.register, 'ItemAdded', order, item(10_000), { base_sequence: 0 }),
      e.crudo(e.register, 'PaymentRecorded', order, e.cardPaymentData(shift, 10_000), {
        base_sequence: 0,
      }),
    ])
    expect(rB.resultados.map((x) => (x.status === 'rejected' ? x.reason : x.status))).toEqual([
      'confirmed',
      'confirmed',
      'no_shift',
    ])
  })

  it('cada restaurante abre su turno aunque sea el mismo equipo de caja, y cada hub reinicia con el suyo', () => {
    const e = dosRestaurantes()
    const a = e.abrirTurno(e.register, 1_000)
    const connection = conexionDe(e.m, e.register)
    const turnoB = newId()
    const rB = e.hubB.recibirLote(connection, [
      e.crudo(
        e.register,
        'ShiftOpened',
        turnoB,
        { register_id: e.register.dispositivoId, base: 2_000 },
        { base_sequence: 0 },
      ),
    ]).resultados[0]
    expect(stateOf(rB)).toBe('confirmed')
    expect(e.hubB.turnoAbierto(e.register.dispositivoId)).toMatchObject({ id: turnoB, base: 2_000 })
    expect(e.status.hub.turnoAbierto(e.register.dispositivoId)).toMatchObject({
      id: a.shift,
      base: 1_000,
    })

    const reiniciadoB = new HubSync(new AlmacenSqlite(e.m.db, e.otroId), {
      restauranteId: e.otroId,
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      access: accesoLibre,
      instancia: 'hub-b2',
      clock: e.m.network.horaIso,
    })
    expect(reiniciadoB.turnoAbierto(e.register.dispositivoId)?.id).toBe(turnoB)
    expect(hubConReglas(e.m).turnoAbierto(e.register.dispositivoId)?.id).toBe(a.shift)
  })
})

describe('con la red simulada: caja sin conexión, hub apagado y mensajes duplicados', () => {
  /** La caja abre turno, cobra y cierra su pedido; devuelve lo necesario para revisar. */
  async function cajaCobra(m: Montaje, register: Nodo, price = 40_900) {
    const order = newId()
    const shift = newId()
    await register.crear(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 })
    await register.crear(order, 'ItemAdded', item(price))
    await register.crear(
      shift,
      'ShiftOpened',
      { register_id: register.dispositivoId, base: 100_000 },
      { aggregate_type: 'register_shift' },
    )
    await register.crear(order, 'PaymentRecorded', {
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
    await register.crear(order, 'OrderClosed', {})
    expect(m).toBeTruthy()
    return { order, shift }
  }

  it('la caja abre turno, cobra y cierra sin conexión; al reconectar todo se confirma y todos ven lo mismo', async () => {
    const m = montar()
    const register = m.network.device('register')
    const ana = m.network.device('ana')
    const { order } = await cajaCobra(m, register)
    expect(await register.cliente.pendingList()).toBe(5)

    await m.network.conectarTodos()
    expect(m.hub().order(order)?.status).toBe('closed')
    expect(m.hub().turnoAbierto(register.dispositivoId)).not.toBeNull()
    await venLoMismo(m.hub(), m.almacen.eventosDesde(0, 1_000), [register, ana], [order])
  })

  it('un lote duplicado por la red no abre dos turnos ni cobra dos veces', async () => {
    const m = montar()
    const register = m.network.device('register')
    const ana = m.network.device('ana')
    await m.network.conectarTodos()
    register.rule('to_hub', 'push', 'duplicate', 3)
    const { order } = await cajaCobra(m, register)
    await m.network.settle()
    const events = m.almacen.eventosDesde(0, 1_000)
    expect(events.filter((x) => x.type === 'ShiftOpened')).toHaveLength(1)
    expect(events.filter((x) => x.type === 'PaymentRecorded')).toHaveLength(1)
    await venLoMismo(m.hub(), events, [register, ana], [order])
  })

  it('el hub se apaga justo al guardar el pago: al volver, el turno sigue y el cobro se completa sin duplicar', async () => {
    const m = montar()
    const register = m.network.device('register')
    const ana = m.network.device('ana')
    await m.network.conectarTodos()
    // Eventos: 1 OrderOpened, 2 ItemAdded, 3 ShiftOpened, 4 PaymentRecorded (cae), 5 Cerrado.
    if (m.almacen instanceof AlmacenQueSeCae) m.almacen.caerEn = 4
    const { order, shift } = await cajaCobra(m, register)
    await m.network.settle()
    await m.network.conectarTodos()
    await m.network.settle()

    expect(m.hub().turnoAbierto(register.dispositivoId)?.id).toBe(shift)
    const events = m.almacen.eventosDesde(0, 1_000)
    expect(events.filter((x) => x.type === 'PaymentRecorded')).toHaveLength(1)
    expect(m.hub().order(order)?.status).toBe('closed')
    await venLoMismo(m.hub(), events, [register, ana], [order])
  })

  it('el reloj de la caja desfasado no cambia el turno: se acepta y el pedido cierra', async () => {
    const m = montar()
    const register = m.network.device('register')
    const ana = m.network.device('ana')
    register.desfaseMs = -3 * 60 * 60 * 1000
    await m.network.conectarTodos()
    const { order, shift } = await cajaCobra(m, register)
    await m.network.settle()
    expect(m.hub().turnoAbierto(register.dispositivoId)?.id).toBe(shift)
    await venLoMismo(m.hub(), m.almacen.eventosDesde(0, 1_000), [register, ana], [order])
  })

  it('el hub reinicia entre abrir el turno y cobrar: el cobro posterior sigue valiendo', async () => {
    const m = montar()
    const register = m.network.device('register')
    await m.network.conectarTodos()
    const shift = newId()
    await register.crear(
      shift,
      'ShiftOpened',
      { register_id: register.dispositivoId, base: 0 },
      { aggregate_type: 'register_shift' },
    )
    await m.network.settle()
    m.network.crashHub()
    await m.network.conectarTodos()
    expect(m.hub().turnoAbierto(register.dispositivoId)?.id).toBe(shift)
    const order = newId()
    await register.crear(order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 1 })
    await register.crear(order, 'ItemAdded', item(10_000))
    await register.crear(order, 'PaymentRecorded', {
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
