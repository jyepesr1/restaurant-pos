import { aggregateOf, newId, otherMethodsReconciliation } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { HubSync } from './hub/hub'
import { TAMANO_PAGINA } from './protocolo'
import { accesoLibre } from './pruebas/acceso'
import { AHORA, AlmacenQueSeCae, eventosDe, item, type Montaje, montar } from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// Movimientos, arqueo y cierre de caja en el hub (tarea 1.7, `problemaDeCaja` y `HubSync.cuadre`):
// sin turno o en el de otra caja, los cuatro rechazos del cierre, lo que pasa después de cerrar, el
// reinicio con un turno a medias y el multirestaurante.

const SODEXO = newId()
const DATAFONO = newId()
const REGLAS = {
  multiple: 100,
  mode: 'nearest_half_down',
  medios: ['cash', 'card', 'nequi', 'daviplata', 'breb', 'transfer'],
  mediosPropios: [SODEXO],
  cardTerminals: [DATAFONO],
}

const conexionDe = (m: Montaje, node: Nodo) => {
  const connection = m.network.tokens.get(`token-${node.name}`)
  if (!connection) throw new Error(`Sin token para ${node.name}`)
  return connection
}

const reason = (r: unknown) => {
  const x = r as { status: string; reason?: string }
  return x.status === 'rejected' ? x.reason : x.status
}

function entorno(options: { umbral?: number } = {}) {
  const m = montar()
  const register = m.network.device('register')
  const register2 = m.network.device('register2')
  const ana = m.network.device('ana')
  const cfg = { umbral: options.umbral ?? 1000 }
  const nuevoHub = () =>
    new HubSync(m.almacen, {
      restauranteId: m.restauranteId,
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      access: accesoLibre,
      instancia: 'hub-1',
      clock: m.network.horaIso,
      reglasCobro: () => ({ ...REGLAS, umbralDiferencia: cfg.umbral }),
    })
  const status = { hub: nuevoHub() }

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
    aggregate_type: aggregateOf(type as never),
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
  const send = (node: Nodo, events: Record<string, unknown>[], hub = status.hub) =>
    hub.recibirLote(conexionDe(m, node), events)
  const one = (node: Nodo, event: Record<string, unknown>, hub = status.hub) =>
    send(node, [event], hub).resultados[0]

  const abrirTurno = (node: Nodo, base = 100_000, shift = newId()) => {
    const result = one(
      node,
      crudo(node, 'ShiftOpened', shift, { register_id: node.dispositivoId, base }),
    )
    expect(reason(result)).toBe('confirmed')
    return shift
  }
  const abrirPedido = (node: Nodo, price = 40_900) => {
    const order = newId()
    one(node, crudo(node, 'OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 }))
    one(node, crudo(node, 'ItemAdded', order, item(price)))
    return order
  }
  /** Efectivo parcial (el saldo no queda en 0): sin ajuste de redondeo. */
  const pagoEf = (shift: string, amount: number, tip = 0) => ({
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    method: 'cash',
    amount,
    tip,
    tendered: amount + tip,
    change: 0,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: null,
    charge_reference: null,
  })
  const pagoNequi = (shift: string, amount: number, tip = 0) => ({
    ...pagoEf(shift, amount, tip),
    method: 'nequi',
    tendered: null,
    change: null,
  })
  const pagoPropio = (shift: string, amount: number) => ({
    ...pagoNequi(shift, amount),
    method: 'other',
    custom_method_id: SODEXO,
  })
  const cobrar = (node: Nodo, order: string, data: { payment_id: string }) => {
    const r = one(node, crudo(node, 'PaymentRecorded', order, data))
    expect(reason(r)).toBe('confirmed')
    return data.payment_id
  }
  const movement = (
    node: Nodo,
    shift: string,
    type: 'entry' | 'output' | 'tip_payout',
    amount: number,
  ) =>
    one(
      node,
      crudo(node, 'CashMovementRecorded', shift, {
        movement_id: newId(),
        type,
        amount,
        description: `Prueba ${type}`,
        to_whom: type === 'tip_payout' ? 'Equipo' : null,
        days: type === 'tip_payout' ? ['2026-10-24'] : [],
      }),
    )
  /** El conteo de `contado` pesos: billetes de $1.000 y, si sobra, monedas de $1 (cualquier monto). */
  const conteoDe = (counted: number) =>
    [
      { value: 1_000, quantity: Math.floor(counted / 1_000) },
      { value: 1, quantity: counted % 1_000 },
    ].filter((c) => c.quantity > 0)
  /** Registra un conteo que suma `contado`. */
  const contar = (node: Nodo, shift: string, counted: number) => {
    const cashCount = newId()
    const r = one(
      node,
      crudo(node, 'CashCountRecorded', shift, {
        cash_count_id: cashCount,
        tally: conteoDe(counted),
        counted_cash: counted,
      }),
    )
    return { cashCount, result: r }
  }
  const datosCierre = (
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
  // Desde la 1.8 el cierre trae los demás medios tal como los calcula el hub con el conteo.
  const otrosDe = (shift: string, cashCount: string) => {
    const reconciliation = status.hub.reconciliation(shift)
    const tally = reconciliation?.cashCounts.find((a) => a.id === cashCount)
    return reconciliation && tally
      ? otherMethodsReconciliation(reconciliation, tally).map((o) => ({
          method: o.method,
          custom_method_id: o.customMethodId,
          expected: o.expected,
          reported: o.reported,
          variance: o.variance,
        }))
      : []
  }
  const close = (
    node: Nodo,
    shift: string,
    cashCount: string,
    expected: number,
    counted: number,
    justification: string | null = null,
  ) =>
    one(
      node,
      crudo(node, 'ShiftClosed', shift, {
        ...datosCierre(cashCount, expected, counted, justification),
        other_methods: otrosDe(shift, cashCount),
      }),
    )
  const voidItem = (node: Nodo, order: string, paymentId: string, shift: string) =>
    one(
      node,
      crudo(node, 'PaymentVoided', order, { payment_id: paymentId, register_shift_id: shift }),
    )

  return {
    m,
    register,
    register2,
    ana,
    cfg,
    status,
    nuevoHub,
    crudo,
    send,
    one,
    abrirTurno,
    abrirPedido,
    pagoEf,
    pagoNequi,
    pagoPropio,
    cobrar,
    movement,
    contar,
    conteoDe,
    close,
    voidItem,
    datosCierre,
  }
}

describe('movimiento, arqueo y cierre: turno y caja', () => {
  const tres = (e: ReturnType<typeof entorno>, node: Nodo, shift: string) => ({
    movement: e.movement(node, shift, 'entry', 1_000),
    cashCount: e.contar(node, shift, 1_000).result,
    closeout: e.close(node, shift, newId(), 1_000, 1_000),
  })

  it('sin turno (id inventado): los tres se rechazan con sin_turno y no dejan huella', () => {
    const e = entorno()
    const before = e.m.almacen.maxSecuencia()
    const r = tres(e, e.register, newId())
    expect(reason(r.movement)).toBe('no_shift')
    expect(reason(r.cashCount)).toBe('no_shift')
    expect(reason(r.closeout)).toBe('no_shift')
    expect(e.m.almacen.maxSecuencia()).toBe(before)
  })

  it('el id de un pedido tampoco es un turno: sin_turno', () => {
    const e = entorno()
    e.abrirTurno(e.register)
    const order = e.abrirPedido(e.register)
    expect(reason(e.movement(e.register, order, 'entry', 1_000))).toBe('no_shift')
  })

  it('el turno de OTRA caja: turno_de_otra_caja en los tres, y el turno sigue intacto', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 50_000)
    e.abrirTurno(e.register2, 7_000)
    const before = e.m.almacen.maxSecuencia()
    const r = tres(e, e.register2, shift)
    expect(reason(r.movement)).toBe('other_register_shift')
    expect(reason(r.cashCount)).toBe('other_register_shift')
    expect(reason(r.closeout)).toBe('other_register_shift')
    expect(e.m.almacen.maxSecuencia()).toBe(before)
    expect(e.status.hub.turnoAbierto(e.register.dispositivoId)?.id).toBe(shift)
    expect(e.status.hub.reconciliation(shift)?.cash.expected).toBe(50_000)
  })

  it('un equipo sin turno propio (el mesero) tampoco mueve ni cierra el turno de la caja', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register)
    const r = tres(e, e.ana, shift)
    expect(Object.values(r).map(reason)).toEqual([
      'other_register_shift',
      'other_register_shift',
      'other_register_shift',
    ])
  })

  it('el rechazo se repite igual si se reenvía el mismo evento', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register)
    const mov = e.crudo(e.register2, 'CashMovementRecorded', shift, {
      movement_id: newId(),
      type: 'entry',
      amount: 5,
      description: 'x',
      to_whom: null,
      days: [],
    })
    const a = e.one(e.register2, mov)
    const b = e.one(e.register2, mov)
    expect(reason(a)).toBe('other_register_shift')
    expect(b).toEqual(a)
  })

  it('movimientos y arqueos del turno propio se aceptan y el cuadre los refleja', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 100_000)
    expect(reason(e.movement(e.register, shift, 'entry', 20_000))).toBe('confirmed')
    expect(reason(e.movement(e.register, shift, 'output', 5_000))).toBe('confirmed')
    expect(reason(e.movement(e.register, shift, 'tip_payout', 3_000))).toBe('confirmed')
    const firstOne = e.contar(e.register, shift, 110_000)
    const secondOne = e.contar(e.register, shift, 112_000)
    expect(reason(firstOne.result)).toBe('confirmed')
    expect(reason(secondOne.result)).toBe('confirmed')
    const c = e.status.hub.reconciliation(shift)
    expect(c?.cash).toMatchObject({
      entries: 20_000,
      outflows: 5_000,
      tipPayouts: 3_000,
      expected: 112_000,
    })
    expect(c?.cashCounts.map((a) => a.counted)).toEqual([110_000, 112_000])
    expect(c?.movements.map((x) => x.type)).toEqual(['entry', 'output', 'tip_payout'])
  })

  it('la hora del cuadre es la del hub, no la del reloj del dispositivo', () => {
    const e = entorno()
    e.register.desfaseMs = -3 * 60 * 60 * 1000
    const shift = e.abrirTurno(e.register)
    e.movement(e.register, shift, 'entry', 1_000)
    const saved = eventosDe(e.m).find((x) => x.type === 'CashMovementRecorded')
    const c = e.status.hub.reconciliation(shift)
    expect(c?.movements[0]?.time).toBe(saved?.received_at)
    expect(c?.openedAt).toBe(eventosDe(e.m)[0]?.received_at)
  })

  it('un movimiento con el esquema roto (salida con a_quien) se rechaza antes de tocar el turno', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register)
    const r = e.one(
      e.register,
      e.crudo(e.register, 'CashMovementRecorded', shift, {
        movement_id: newId(),
        type: 'output',
        amount: 100,
        description: 'x',
        to_whom: 'Ana',
        days: [],
      }),
    )
    expect(reason(r)).toMatch(/^esquema:/)
    expect(e.status.hub.reconciliation(shift)?.movements).toEqual([])
  })

  it('cuadre de un turno que no existe o ya cerrado: null', () => {
    const e = entorno()
    expect(e.status.hub.reconciliation(newId())).toBeNull()
  })
})

describe('cierre de caja: las cuatro reglas y el cierre correcto', () => {
  /** Base 100.000, cobro en efectivo de 30.000 con 2.000 de propina y un conteo de 132.000. */
  function turnoCobrado(umbral = 1000) {
    const e = entorno({ umbral })
    const shift = e.abrirTurno(e.register, 100_000)
    const order = e.abrirPedido(e.register)
    e.cobrar(e.register, order, e.pagoEf(shift, 30_000, 2_000))
    return { ...e, shift, order, expected: 132_000 }
  }

  it('arqueo_inexistente: cierra sin haber contado', () => {
    const t = turnoCobrado()
    expect(reason(t.close(t.register, t.shift, newId(), t.expected, t.expected))).toBe(
      'cash_count_not_found',
    )
    expect(t.status.hub.turnoAbierto(t.register.dispositivoId)).not.toBeNull()
  })

  it('arqueo_inexistente: el conteo es de otro turno (otra caja)', () => {
    const t = turnoCobrado()
    const shift2 = t.abrirTurno(t.register2, 0)
    const ajeno = t.contar(t.register2, shift2, 132_000)
    expect(reason(ajeno.result)).toBe('confirmed')
    expect(reason(t.close(t.register, t.shift, ajeno.cashCount, t.expected, 132_000))).toBe(
      'cash_count_not_found',
    )
  })

  it('arqueo_inexistente: el id del arqueo es el de un movimiento', () => {
    const t = turnoCobrado()
    const mov = t.crudo(t.register, 'CashMovementRecorded', t.shift, {
      movement_id: newId(),
      type: 'entry',
      amount: 1_000,
      description: 'x',
      to_whom: null,
      days: [],
    })
    t.one(t.register, mov)
    const id = (mov.data as { movement_id: string }).movement_id
    expect(reason(t.close(t.register, t.shift, id, 133_000, 1_000))).toBe('cash_count_not_found')
  })

  it('contado_distinto: el cierre dice otro contado que el del arqueo (aunque la diferencia sea consecuente)', () => {
    const t = turnoCobrado()
    const { cashCount } = t.contar(t.register, t.shift, 132_000)
    expect(reason(t.close(t.register, t.shift, cashCount, t.expected, 131_000, 'Faltó'))).toBe(
      'counted_mismatch',
    )
    expect(reason(t.close(t.register, t.shift, cashCount, t.expected, 133_000, 'Sobró'))).toBe(
      'counted_mismatch',
    )
  })

  it('esperado_distinto: el cierre dice otro esperado que el del hub', () => {
    const t = turnoCobrado()
    const { cashCount } = t.contar(t.register, t.shift, 132_000)
    // Un esperado viejo (sin la propina) y uno inventado.
    expect(reason(t.close(t.register, t.shift, cashCount, 130_000, 132_000, 'x'))).toBe(
      'expected_mismatch',
    )
    expect(reason(t.close(t.register, t.shift, cashCount, 0, 132_000, 'x'))).toBe(
      'expected_mismatch',
    )
  })

  describe('arqueo_desactualizado: hubo dinero después del último conteo', () => {
    it('un movimiento (entrada, salida o pago de propinas) después de contar', () => {
      for (const type of ['entry', 'output', 'tip_payout'] as const) {
        const t = turnoCobrado()
        const { cashCount } = t.contar(t.register, t.shift, 132_000)
        t.movement(t.register, t.shift, type, 1_000)
        const nuevoEsperado = type === 'entry' ? 133_000 : 131_000
        expect(
          reason(t.close(t.register, t.shift, cashCount, nuevoEsperado, 132_000, 'x')),
          type,
        ).toBe('stale_cash_count')
        expect(t.status.hub.turnoAbierto(t.register.dispositivoId), type).not.toBeNull()
      }
    })

    it('un pago, aunque sea de otro medio, después de contar', () => {
      const t = turnoCobrado()
      const { cashCount } = t.contar(t.register, t.shift, 132_000)
      t.cobrar(t.register, t.order, t.pagoNequi(t.shift, 500))
      expect(reason(t.close(t.register, t.shift, cashCount, 132_000, 132_000))).toBe(
        'stale_cash_count',
      )
    })

    it('una anulación y un reembolso después de contar', () => {
      const t = turnoCobrado()
      const other = t.cobrar(t.register, t.order, t.pagoNequi(t.shift, 500))
      const { cashCount } = t.contar(t.register, t.shift, 132_000)
      t.voidItem(t.register, t.order, other, t.shift)
      expect(reason(t.close(t.register, t.shift, cashCount, 132_000, 132_000))).toBe(
        'stale_cash_count',
      )
      const t2 = turnoCobrado()
      const payment = t2.cobrar(t2.register, t2.order, t2.pagoNequi(t2.shift, 500))
      const a2 = t2.contar(t2.register, t2.shift, 132_000)
      const r = t2.one(
        t2.register,
        t2.crudo(t2.register, 'RefundRecorded', t2.order, {
          payment_id: payment,
          refund_id: newId(),
          sale_amount: 100,
          tip_amount: 0,
          method: 'nequi',
          register_shift_id: t2.shift,
        }),
      )
      expect(reason(r)).toBe('confirmed')
      expect(reason(t2.close(t2.register, t2.shift, a2.cashCount, 132_000, 132_000))).toBe(
        'stale_cash_count',
      )
    })

    it('anular después de contar un pago de un turno anterior también desactualiza el conteo', () => {
      const e = entorno()
      const t1 = e.abrirTurno(e.register, 0)
      const order = e.abrirPedido(e.register)
      const payment = e.cobrar(e.register, order, e.pagoEf(t1, 10_000))
      const a1 = e.contar(e.register, t1, 10_000)
      e.close(e.register, t1, a1.cashCount, 10_000, 10_000)
      const t2 = e.abrirTurno(e.register, 50_000)
      const { cashCount } = e.contar(e.register, t2, 50_000)
      e.voidItem(e.register, order, payment, t2)
      expect(reason(e.close(e.register, t2, cashCount, 40_000, 50_000, 'x'))).toBe(
        'stale_cash_count',
      )
    })

    it('volver a contar lo arregla: el conteo nuevo es el último y el esperado es el nuevo', () => {
      const t = turnoCobrado()
      const oldOne = t.contar(t.register, t.shift, 132_000)
      t.movement(t.register, t.shift, 'output', 12_000)
      const fresh = t.contar(t.register, t.shift, 120_000)
      expect(reason(t.close(t.register, t.shift, oldOne.cashCount, 120_000, 132_000, 'x'))).toBe(
        'cash_count_not_latest',
      )
      expect(reason(t.close(t.register, t.shift, fresh.cashCount, 120_000, 120_000))).toBe(
        'confirmed',
      )
    })

    it('un movimiento rechazado (de otra caja) o un pago del turno de otra caja no desactualizan', () => {
      const t = turnoCobrado()
      t.abrirTurno(t.register2, 0)
      const { cashCount } = t.contar(t.register, t.shift, 132_000)
      expect(reason(t.movement(t.register2, t.shift, 'entry', 1_000))).toBe('other_register_shift')
      const anotherOrder = t.abrirPedido(t.register2)
      t.cobrar(
        t.register2,
        anotherOrder,
        t.pagoNequi(t.status.hub.turnoAbierto(t.register2.dispositivoId)?.id ?? '', 500),
      )
      expect(reason(t.close(t.register, t.shift, cashCount, 132_000, 132_000))).toBe('confirmed')
    })

    it('tras reiniciar el hub, el conteo sigue desactualizado', () => {
      const t = turnoCobrado()
      const { cashCount } = t.contar(t.register, t.shift, 132_000)
      t.movement(t.register, t.shift, 'entry', 1_000)
      t.status.hub = t.nuevoHub()
      expect(reason(t.close(t.register, t.shift, cashCount, 133_000, 132_000, 'x'))).toBe(
        'stale_cash_count',
      )
    })
  })

  describe('arqueo_no_es_el_ultimo', () => {
    it('cerrar con el primero de dos conteos se rechaza; con el último se acepta', () => {
      const t = turnoCobrado()
      const a1 = t.contar(t.register, t.shift, 130_000)
      const a2 = t.contar(t.register, t.shift, 132_000)
      expect(reason(t.close(t.register, t.shift, a1.cashCount, t.expected, 130_000, 'Faltó'))).toBe(
        'cash_count_not_latest',
      )
      expect(t.status.hub.turnoAbierto(t.register.dispositivoId)).not.toBeNull()
      expect(reason(t.close(t.register, t.shift, a2.cashCount, t.expected, 132_000))).toBe(
        'confirmed',
      )
    })

    it('con tres conteos solo vale el tercero', () => {
      const t = turnoCobrado()
      const a = [130_000, 131_000, 132_000].map((c) => t.contar(t.register, t.shift, c).cashCount)
      expect(reason(t.close(t.register, t.shift, a[0] ?? '', t.expected, 130_000, 'x'))).toBe(
        'cash_count_not_latest',
      )
      expect(reason(t.close(t.register, t.shift, a[1] ?? '', t.expected, 131_000, 'x'))).toBe(
        'cash_count_not_latest',
      )
      expect(reason(t.close(t.register, t.shift, a[2] ?? '', t.expected, 132_000))).toBe(
        'confirmed',
      )
    })

    it('un conteo repetido con el mismo contado no engaña: se compara el id, no el monto', () => {
      const t = turnoCobrado()
      const a1 = t.contar(t.register, t.shift, 132_000)
      t.contar(t.register, t.shift, 132_000)
      expect(reason(t.close(t.register, t.shift, a1.cashCount, t.expected, 132_000))).toBe(
        'cash_count_not_latest',
      )
    })
  })

  it('el orden de las reglas: inexistente, no es el último, desactualizado, contado, esperado, justificación', () => {
    const t = turnoCobrado(0)
    const a1 = t.contar(t.register, t.shift, 131_000)
    const a2 = t.contar(t.register, t.shift, 132_000)
    // Todo mal a la vez, y sin justificación.
    expect(reason(t.close(t.register, t.shift, newId(), 1, 2))).toBe('cash_count_not_found')
    expect(reason(t.close(t.register, t.shift, a1.cashCount, 1, 2))).toBe('cash_count_not_latest')
    t.movement(t.register, t.shift, 'entry', 1_000)
    expect(reason(t.close(t.register, t.shift, a2.cashCount, 1, 2))).toBe('stale_cash_count')
    const a3 = t.contar(t.register, t.shift, 133_000)
    expect(reason(t.close(t.register, t.shift, a3.cashCount, 1, 2))).toBe('counted_mismatch')
    expect(reason(t.close(t.register, t.shift, a3.cashCount, 1, 133_000))).toBe('expected_mismatch')
    expect(reason(t.close(t.register, t.shift, a3.cashCount, 133_000, 133_000))).toBe('confirmed')
  })

  describe('falta_justificacion', () => {
    /** Un turno de base 100.000 sin cobros; cuenta `contado` y cierra con `justificacion`. */
    function cierraCon(umbral: number, counted: number, justification: string | null) {
      const e = entorno({ umbral })
      const shift = e.abrirTurno(e.register, 100_000)
      const { cashCount } = e.contar(e.register, shift, counted)
      return reason(e.close(e.register, shift, cashCount, 100_000, counted, justification))
    }

    it('umbral 0: cualquier diferencia pide justificación; sin diferencia, no', () => {
      expect(cierraCon(0, 100_000, null)).toBe('confirmed')
      expect(cierraCon(0, 99_999, null)).toBe('missing_justification')
      expect(cierraCon(0, 100_001, null)).toBe('missing_justification')
      expect(cierraCon(0, 99_000, null)).toBe('missing_justification')
      expect(cierraCon(0, 101_000, null)).toBe('missing_justification')
      expect(cierraCon(0, 99_000, 'Falta un billete')).toBe('confirmed')
    })

    it('umbral 1.000: por debajo se cierra sin más; desde 1.000 (faltante o sobrante) pide justificación', () => {
      expect(cierraCon(1000, 100_000, null)).toBe('confirmed')
      expect(cierraCon(1000, 99_999, null)).toBe('confirmed')
      expect(cierraCon(1000, 100_001, null)).toBe('confirmed')
      expect(cierraCon(1000, 99_001, null)).toBe('confirmed')
      expect(cierraCon(1000, 100_999, null)).toBe('confirmed')
      expect(cierraCon(1000, 99_000, null)).toBe('missing_justification')
      expect(cierraCon(1000, 101_000, null)).toBe('missing_justification')
      expect(cierraCon(1000, 98_999, null)).toBe('missing_justification')
      expect(cierraCon(1000, 99_000, null)).toBe('missing_justification')
      expect(cierraCon(1000, 101_000, null)).toBe('missing_justification')
      expect(cierraCon(1000, 98_000, null)).toBe('missing_justification')
      expect(cierraCon(1000, 99_000, 'Propina de la mesa 4')).toBe('confirmed')
    })

    it('umbral 2.000: una diferencia de 1.000 no pide justificación; de 2.000 sí (el borde es inclusivo)', () => {
      expect(cierraCon(2000, 99_000, null)).toBe('confirmed')
      expect(cierraCon(2000, 101_000, null)).toBe('confirmed')
      expect(cierraCon(2000, 98_000, null)).toBe('missing_justification')
      expect(cierraCon(2000, 102_000, null)).toBe('missing_justification')
    })

    it('una justificación presente se acepta aunque no hiciera falta', () => {
      expect(cierraCon(1000, 100_000, 'Todo bien')).toBe('confirmed')
    })

    it('una justificación vacía o de espacios no llega: el esquema la rechaza', () => {
      for (const j of ['', '   ']) expect(cierraCon(0, 99_000, j)).toMatch(/^esquema:/)
    })

    it('el umbral que vale es el vigente al cerrar: si el administrador lo cambia con el hub andando', () => {
      const e = entorno({ umbral: 5_000 })
      const shift = e.abrirTurno(e.register, 100_000)
      const { cashCount } = e.contar(e.register, shift, 99_000)
      e.cfg.umbral = 1_000
      expect(reason(e.close(e.register, shift, cashCount, 100_000, 99_000))).toBe(
        'missing_justification',
      )
      e.cfg.umbral = 5_000
      expect(reason(e.close(e.register, shift, cashCount, 100_000, 99_000))).toBe('confirmed')
    })

    it('un hub sin reglas de cobro usa el umbral de fábrica ($1.000)', () => {
      const e = entorno()
      const sinReglas = e.m.hub()
      const shift = newId()
      const connection = conexionDe(e.m, e.register)
      sinReglas.recibirLote(connection, [
        e.crudo(e.register, 'ShiftOpened', shift, {
          register_id: e.register.dispositivoId,
          base: 10_000,
        }),
      ])
      const tryAction = (counted: number, justification: string | null = null) => {
        const cashCount = newId()
        sinReglas.recibirLote(connection, [
          e.crudo(e.register, 'CashCountRecorded', shift, {
            cash_count_id: cashCount,
            tally: e.conteoDe(counted),
            counted_cash: counted,
          }),
        ])
        return reason(
          sinReglas.recibirLote(connection, [
            e.crudo(
              e.register,
              'ShiftClosed',
              shift,
              e.datosCierre(cashCount, 10_000, counted, justification),
            ),
          ]).resultados[0],
        )
      }
      expect(tryAction(9_000)).toBe('missing_justification')
      expect(tryAction(9_001)).toBe('confirmed')
    })
  })

  it('el cierre correcto: se confirma, el turno ya no está abierto y el cuadre queda cerrado', () => {
    const t = turnoCobrado()
    const { cashCount } = t.contar(t.register, t.shift, t.expected)
    const r = t.close(t.register, t.shift, cashCount, t.expected, t.expected)
    expect(reason(r)).toBe('confirmed')
    expect(t.status.hub.turnoAbierto(t.register.dispositivoId)).toBeNull()
    expect(t.status.hub.reconciliation(t.shift)?.closed).not.toBeNull()
    const closeout = eventosDe(t.m).find((x) => x.type === 'ShiftClosed')
    expect(closeout?.aggregate_id).toBe(t.shift)
    expect(closeout?.data).toMatchObject({ expected_cash: 132_000, variance: 0 })
  })

  it('con varios conteos, cada uno queda guardado', () => {
    const t = turnoCobrado()
    t.contar(t.register, t.shift, 130_000)
    t.contar(t.register, t.shift, 132_000)
    expect(t.status.hub.reconciliation(t.shift)?.cashCounts.map((a) => a.counted)).toEqual([
      130_000, 132_000,
    ])
    expect(eventosDe(t.m).filter((x) => x.type === 'CashCountRecorded')).toHaveLength(2)
  })

  it('un faltante con la diferencia y la justificación queda guardado tal cual', () => {
    const t = turnoCobrado(0)
    const { cashCount } = t.contar(t.register, t.shift, 130_000)
    expect(
      reason(t.close(t.register, t.shift, cashCount, t.expected, 130_000, 'Falta un vale')),
    ).toBe('confirmed')
    const closeout = eventosDe(t.m).find((x) => x.type === 'ShiftClosed')
    expect(closeout?.data).toMatchObject({ variance: -2_000, justification: 'Falta un vale' })
  })

  it('reenviar el mismo cierre confirmado es idempotente; un segundo cierre con otro id, sin_turno', () => {
    const t = turnoCobrado()
    const { cashCount } = t.contar(t.register, t.shift, t.expected)
    const closeout = t.crudo(
      t.register,
      'ShiftClosed',
      t.shift,
      t.datosCierre(cashCount, t.expected, t.expected),
    )
    const a = t.one(t.register, closeout)
    const b = t.one(t.register, closeout)
    expect(reason(a)).toBe('confirmed')
    expect(reason(b)).toBe('confirmed')
    expect(eventosDe(t.m).filter((x) => x.type === 'ShiftClosed')).toHaveLength(1)
    expect(reason(t.close(t.register, t.shift, cashCount, t.expected, t.expected))).toBe('no_shift')
  })

  it('un cierre rechazado se rechaza igual al reenviarlo; con el esperado corregido y otro id se acepta', () => {
    const t = turnoCobrado()
    const { cashCount } = t.contar(t.register, t.shift, t.expected)
    const oldOne = t.crudo(
      t.register,
      'ShiftClosed',
      t.shift,
      t.datosCierre(cashCount, 130_000, 132_000, 'x'),
    )
    expect(reason(t.one(t.register, oldOne))).toBe('expected_mismatch')
    expect(reason(t.one(t.register, oldOne))).toBe('expected_mismatch')
    expect(reason(t.close(t.register, t.shift, cashCount, t.expected, t.expected))).toBe(
      'confirmed',
    )
  })

  it('en un lote: el cierre antes de su arqueo se rechaza y lo que sigue del turno depende de él (depende_de_rechazado)', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 10_000)
    const cashCount = newId()
    const r = e.send(e.register, [
      e.crudo(e.register, 'ShiftClosed', shift, e.datosCierre(cashCount, 10_000, 10_000)),
      e.crudo(e.register, 'CashCountRecorded', shift, {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: 10 }],
        counted_cash: 10_000,
      }),
    ])
    expect(r.resultados.map(reason)).toEqual(['cash_count_not_found', 'depends_on_rejected'])
    expect(e.status.hub.turnoAbierto(e.register.dispositivoId)).not.toBeNull()
  })

  it('en un lote: arqueo y cierre en orden se confirman juntos', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 10_000)
    const cashCount = newId()
    const r = e.send(e.register, [
      e.crudo(e.register, 'CashCountRecorded', shift, {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: 10 }],
        counted_cash: 10_000,
      }),
      e.crudo(e.register, 'ShiftClosed', shift, e.datosCierre(cashCount, 10_000, 10_000)),
    ])
    expect(r.resultados.map(reason)).toEqual(['confirmed', 'confirmed'])
    expect(e.status.hub.turnoAbierto(e.register.dispositivoId)).toBeNull()
  })

  it('el cierre no toca a los demás turnos abiertos', () => {
    const t = turnoCobrado()
    const other = t.abrirTurno(t.register2, 5_000)
    const { cashCount } = t.contar(t.register, t.shift, t.expected)
    t.close(t.register, t.shift, cashCount, t.expected, t.expected)
    expect(t.status.hub.turnoAbierto(t.register2.dispositivoId)?.id).toBe(other)
    expect(t.status.hub.reconciliation(other)?.cash.expected).toBe(5_000)
  })
})

describe('después del cierre', () => {
  function closed() {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 100_000)
    const order = e.abrirPedido(e.register)
    const payment = e.cobrar(e.register, order, e.pagoEf(shift, 10_000))
    const { cashCount } = e.contar(e.register, shift, 110_000)
    expect(reason(e.close(e.register, shift, cashCount, 110_000, 110_000))).toBe('confirmed')
    return { ...e, shift, order, payment }
  }

  it('un pago, una anulación y un reembolso a ese turno se rechazan con sin_turno', () => {
    const c = closed()
    const before = c.m.almacen.maxSecuencia()
    const payment = c.one(
      c.register,
      c.crudo(c.register, 'PaymentRecorded', c.order, c.pagoEf(c.shift, 5_000)),
    )
    expect(reason(payment)).toBe('no_shift')
    expect(reason(c.voidItem(c.register, c.order, c.payment, c.shift))).toBe('no_shift')
    const refund = c.one(
      c.register,
      c.crudo(c.register, 'RefundRecorded', c.order, {
        payment_id: c.payment,
        refund_id: newId(),
        sale_amount: 1_000,
        tip_amount: 0,
        method: 'cash',
        register_shift_id: c.shift,
      }),
    )
    expect(reason(refund)).toBe('no_shift')
    expect(c.m.almacen.maxSecuencia()).toBe(before)
    expect(Object.keys(c.status.hub.order(c.order)?.payments ?? {})).toHaveLength(1)
  })

  it('un movimiento, otro arqueo y otro cierre al turno cerrado: sin_turno', () => {
    const c = closed()
    expect(reason(c.movement(c.register, c.shift, 'entry', 1_000))).toBe('no_shift')
    expect(reason(c.contar(c.register, c.shift, 1_000).result)).toBe('no_shift')
    expect(reason(c.close(c.register, c.shift, newId(), 0, 0))).toBe('no_shift')
  })

  it('el id del turno cerrado no se puede reabrir (turno_ya_existe)', () => {
    const c = closed()
    const r = c.one(
      c.register,
      c.crudo(c.register, 'ShiftOpened', c.shift, {
        register_id: c.register.dispositivoId,
        base: 1,
      }),
    )
    expect(reason(r)).toBe('shift_already_exists')
  })

  it('la misma caja abre otro turno, con su propia base, y el cuadre del nuevo no hereda nada', () => {
    const c = closed()
    const fresh = c.abrirTurno(c.register, 30_000)
    expect(fresh).not.toBe(c.shift)
    expect(c.status.hub.turnoAbierto(c.register.dispositivoId)).toMatchObject({
      id: fresh,
      base: 30_000,
    })
    expect(c.status.hub.reconciliation(fresh)?.cash).toMatchObject({
      charged: 0,
      entries: 0,
      expected: 30_000,
    })
    expect(c.status.hub.reconciliation(fresh)?.byMethod).toEqual([])
  })

  it('en el turno nuevo se cobra con normalidad y el cierre cuadra solo con lo suyo', () => {
    const c = closed()
    const fresh = c.abrirTurno(c.register, 30_000)
    c.cobrar(c.register, c.order, c.pagoEf(fresh, 8_000, 500))
    // Lo del turno anterior (110.000) no cuenta: el esperado es 30.000 + 8.500.
    expect(c.status.hub.reconciliation(fresh)?.cash.expected).toBe(38_500)
    const { cashCount } = c.contar(c.register, fresh, 38_500)
    expect(reason(c.close(c.register, fresh, cashCount, 38_500, 38_500))).toBe('confirmed')
    expect(c.status.hub.turnoAbierto(c.register.dispositivoId)).toBeNull()
  })
})

describe('anular, en este turno, el pago de un turno anterior', () => {
  /** Turno 1 con un pago de 30.000 (+2.000 de propina) ya cerrado; turno 2 abierto con base 100.000. */
  function dosTurnos() {
    const e = entorno()
    const t1 = e.abrirTurno(e.register, 0)
    const order = e.abrirPedido(e.register)
    const payment = e.cobrar(e.register, order, e.pagoEf(t1, 30_000, 2_000))
    const { cashCount } = e.contar(e.register, t1, 32_000)
    expect(reason(e.close(e.register, t1, cashCount, 32_000, 32_000))).toBe('confirmed')
    const t2 = e.abrirTurno(e.register, 100_000)
    return { ...e, t1, t2, order, payment }
  }

  it('la anulación cae en el turno 2: devuelve lo cobrado (monto + propina) y el esperado baja', () => {
    const d = dosTurnos()
    expect(reason(d.voidItem(d.register, d.order, d.payment, d.t2))).toBe('confirmed')
    const c = d.status.hub.reconciliation(d.t2)
    expect(c?.cash).toMatchObject({ charged: 0, refunds: 32_000, expected: 68_000 })
    expect(c?.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: -30_000, tip: -2_000, payments: -1 },
    ])
  })

  it('el cierre del turno 2 debe traer ese esperado: con el de antes de anular, esperado_distinto', () => {
    const d = dosTurnos()
    d.voidItem(d.register, d.order, d.payment, d.t2)
    const { cashCount } = d.contar(d.register, d.t2, 68_000)
    expect(reason(d.close(d.register, d.t2, cashCount, 100_000, 68_000, 'x'))).toBe(
      'expected_mismatch',
    )
    expect(reason(d.close(d.register, d.t2, cashCount, 68_000, 68_000))).toBe('confirmed')
  })

  it('con otros movimientos del turno 2 todo suma: base + entrada + cobro − reversa − salida', () => {
    const d = dosTurnos()
    d.movement(d.register, d.t2, 'entry', 5_000)
    d.cobrar(d.register, d.order, d.pagoEf(d.t2, 10_000))
    d.voidItem(d.register, d.order, d.payment, d.t2)
    d.movement(d.register, d.t2, 'output', 1_000)
    expect(d.status.hub.reconciliation(d.t2)?.cash.expected).toBe(
      100_000 + 5_000 + 10_000 - 32_000 - 1_000,
    )
  })

  it('anular un pago de OTRA caja en este turno es turno_de_otra_caja solo si el turno no es de esta caja', () => {
    const d = dosTurnos()
    const turno2Ajeno = d.abrirTurno(d.register2, 0)
    // La caja 2 anula, en su propio turno, un pago que cobró la caja 1 en su turno 1 ya cerrado.
    expect(reason(d.voidItem(d.register2, d.order, d.payment, turno2Ajeno))).toBe('confirmed')
    expect(d.status.hub.reconciliation(turno2Ajeno)?.cash).toMatchObject({ refunds: 32_000 })
    // La caja 1 no puede anularlo en el turno de la caja 2.
    expect(reason(d.voidItem(d.register, d.order, newId(), turno2Ajeno))).toBe(
      'other_register_shift',
    )
  })

  it('un reembolso en efectivo en el turno 2 de un pago del turno 1 resta del cajón del turno 2', () => {
    const d = dosTurnos()
    const r = d.one(
      d.register,
      d.crudo(d.register, 'RefundRecorded', d.order, {
        payment_id: d.payment,
        refund_id: newId(),
        sale_amount: 4_000,
        tip_amount: 500,
        method: 'cash',
        register_shift_id: d.t2,
      }),
    )
    expect(reason(r)).toBe('confirmed')
    expect(d.status.hub.reconciliation(d.t2)?.cash).toMatchObject({
      refunds: 4_500,
      expected: 95_500,
    })
  })

  // El reembolso trae al turno el pago original (como la anulación), así que no se pierde el medio propio.
  it('un reembolso de un pago de medio propio de otro turno queda en el renglón de ese medio propio', () => {
    const e = entorno()
    const t1 = e.abrirTurno(e.register, 0)
    const order = e.abrirPedido(e.register)
    const payment = e.cobrar(e.register, order, e.pagoPropio(t1, 20_000))
    const { cashCount } = e.contar(e.register, t1, 0)
    // El Sodexo no se reportó en el conteo (1.8): el cierre lo marca y pide justificarlo.
    e.close(e.register, t1, cashCount, 0, 0, 'Sodexo sin reporte')
    const t2 = e.abrirTurno(e.register, 0)
    const r = e.one(
      e.register,
      e.crudo(e.register, 'RefundRecorded', order, {
        payment_id: payment,
        refund_id: newId(),
        sale_amount: 5_000,
        tip_amount: 0,
        method: 'other',
        register_shift_id: t2,
      }),
    )
    expect(reason(r)).toBe('confirmed')
    expect(e.status.hub.reconciliation(t2)?.byMethod).toEqual([
      { method: 'other', customMethodId: SODEXO, sale: -5_000, tip: 0, payments: 0 },
    ])
  })
})

describe('reinicio del hub con un turno a medias', () => {
  /** Turno 1 cerrado y turno 2 con cobro, entrada, salida, anulación del pago del turno 1 y un conteo. */
  function aMedias() {
    const e = entorno()
    const t1 = e.abrirTurno(e.register, 0)
    const order = e.abrirPedido(e.register)
    const pago1 = e.cobrar(e.register, order, e.pagoEf(t1, 30_000, 2_000))
    const a1 = e.contar(e.register, t1, 32_000)
    e.close(e.register, t1, a1.cashCount, 32_000, 32_000)
    const t2 = e.abrirTurno(e.register, 100_000)
    e.movement(e.register, t2, 'entry', 5_000)
    e.cobrar(e.register, order, e.pagoEf(t2, 10_000))
    e.cobrar(e.register, order, e.pagoNequi(t2, 800, 100))
    e.voidItem(e.register, order, pago1, t2)
    e.movement(e.register, t2, 'output', 1_000)
    e.contar(e.register, t2, 82_000)
    return { ...e, t1, t2, order, pago1 }
  }
  const ESPERADO = 100_000 + 5_000 + 10_000 - 32_000 - 1_000

  it('el cuadre se reconstruye idéntico: lo cobrado, las devoluciones, los movimientos y los conteos', () => {
    const a = aMedias()
    const before = a.status.hub.reconciliation(a.t2)
    expect(before?.cash.expected).toBe(ESPERADO)
    const reiniciado = a.nuevoHub()
    expect(reiniciado.reconciliation(a.t2)).toEqual(before)
    expect(reiniciado.turnoAbierto(a.register.dispositivoId)?.id).toBe(a.t2)
    // El turno cerrado no reaparece.
    expect(reiniciado.reconciliation(a.t1)?.closed).not.toBeNull()
  })

  it('tras el reinicio el cierre se acepta con el esperado reconstruido y se rechaza con otro', () => {
    const a = aMedias()
    a.status.hub = a.nuevoHub()
    const cashCount = a.status.hub.reconciliation(a.t2)?.cashCounts[0]?.id ?? ''
    expect(reason(a.close(a.register, a.t2, cashCount, ESPERADO + 1_000, 82_000, 'x'))).toBe(
      'expected_mismatch',
    )
    expect(reason(a.close(a.register, a.t2, cashCount, ESPERADO, 82_000))).toBe('confirmed')
  })

  it('un turno cerrado sigue cerrado tras el reinicio: nada se le puede agregar y la caja abre otro', () => {
    const a = aMedias()
    const cashCount = a.status.hub.reconciliation(a.t2)?.cashCounts[0]?.id ?? ''
    a.close(a.register, a.t2, cashCount, ESPERADO, 82_000)
    a.status.hub = a.nuevoHub()
    expect(a.status.hub.turnoAbierto(a.register.dispositivoId)).toBeNull()
    expect(a.status.hub.reconciliation(a.t2)?.closed).not.toBeNull()
    expect(reason(a.movement(a.register, a.t2, 'entry', 1_000))).toBe('no_shift')
    expect(reason(a.contar(a.register, a.t2, 1_000).result)).toBe('no_shift')
    const next = a.abrirTurno(a.register, 5_000)
    expect(a.status.hub.reconciliation(next)?.cash.expected).toBe(5_000)
  })

  it('los conteos o movimientos rechazados no reaparecen tras el reinicio', () => {
    const a = aMedias()
    a.movement(a.register2, a.t2, 'entry', 99_000) // de otra caja: rechazado
    a.close(a.register, a.t2, newId(), 0, 0) // sin conteo: rechazado
    const reiniciado = a.nuevoHub()
    expect(reiniciado.reconciliation(a.t2)?.cash.entries).toBe(5_000)
    expect(reiniciado.reconciliation(a.t2)?.cash.expected).toBe(ESPERADO)
  })

  it('con eventos de más de una página entre medias, el turno se reconstruye completo', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 1_000)
    const order = e.abrirPedido(e.register, 1_000_000)
    e.cobrar(e.register, order, e.pagoEf(shift, 20_000))
    // Más de una página de eventos de pedidos ajenos al turno, en un solo lote.
    const relleno: Record<string, unknown>[] = []
    for (let i = 0; i < TAMANO_PAGINA + 20; i++) {
      const p = newId()
      relleno.push(
        e.crudo(e.ana, 'OrderOpened', p, { channel: 'dine_in', table_id: null, guests: 1 }),
      )
    }
    for (let i = 0; i < relleno.length; i += 100) e.send(e.ana, relleno.slice(i, i + 100))
    e.movement(e.register, shift, 'entry', 2_000)
    e.status.hub = e.nuevoHub()
    expect(eventosDe(e.m).length).toBeGreaterThan(TAMANO_PAGINA)
    expect(e.status.hub.reconciliation(shift)?.cash).toMatchObject({
      charged: 20_000,
      entries: 2_000,
      expected: 23_000,
    })
  })

  it('el hub se cae al guardar el cierre: al volver sigue a medias, y el cierre reenviado se acepta una vez', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 10_000)
    const { cashCount } = e.contar(e.register, shift, 10_000)
    const closeout = e.crudo(
      e.register,
      'ShiftClosed',
      shift,
      e.datosCierre(cashCount, 10_000, 10_000),
    )
    const almacen = e.m.almacen as AlmacenQueSeCae
    almacen.caerEn = 1
    expect(() => e.one(e.register, closeout)).toThrow('apag')
    expect(almacen.caido).toBe(true)
    almacen.caido = false
    e.status.hub = e.nuevoHub()
    expect(e.status.hub.turnoAbierto(e.register.dispositivoId)?.id).toBe(shift)
    expect(eventosDe(e.m).filter((x) => x.type === 'ShiftClosed')).toHaveLength(0)
    expect(reason(e.one(e.register, closeout))).toBe('confirmed')
    expect(reason(e.one(e.register, closeout))).toBe('confirmed')
    expect(eventosDe(e.m).filter((x) => x.type === 'ShiftClosed')).toHaveLength(1)
  })
})

describe('multirestaurante: el cuadre es de cada restaurante', () => {
  function two() {
    const e = entorno()
    const otroId = newId()
    e.m.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(otroId, otroId, AHORA, AHORA)
    const nuevoHubB = () =>
      new HubSync(new AlmacenSqlite(e.m.db, otroId), {
        restauranteId: otroId,
        timeZone: 'America/Bogota',
        inicioDiaOperativo: '06:00',
        access: accesoLibre,
        instancia: 'hub-b',
        clock: e.m.network.horaIso,
        reglasCobro: () => ({ ...REGLAS, umbralDiferencia: 0 }),
      })
    return { ...e, otroId, hubB: nuevoHubB(), nuevoHubB }
  }

  it('el movimiento, el arqueo y el cierre del turno de A no existen en B (sin_turno)', () => {
    const d = two()
    const shift = d.abrirTurno(d.register, 50_000)
    const enB = (type: string, data: unknown) =>
      reason(
        d.send(d.register, [d.crudo(d.register, type, shift, data, { base_sequence: 0 })], d.hubB)
          .resultados[0],
      )
    expect(
      enB('CashMovementRecorded', {
        movement_id: newId(),
        type: 'entry',
        amount: 1_000,
        description: 'x',
        to_whom: null,
        days: [],
      }),
    ).toBe('no_shift')
    expect(enB('CashCountRecorded', { cash_count_id: newId(), tally: [], counted_cash: 0 })).toBe(
      'no_shift',
    )
    expect(enB('ShiftClosed', d.datosCierre(newId(), 0, 0))).toBe('no_shift')
    expect(d.hubB.reconciliation(shift)).toBeNull()
    expect(d.status.hub.reconciliation(shift)?.cash.expected).toBe(50_000)
  })

  it('cada restaurante tiene su turno y su cuadre aunque sea la misma caja y haya cierres en uno', () => {
    const d = two()
    const turnoA = d.abrirTurno(d.register, 10_000)
    const turnoB = newId()
    const rB = d.send(
      d.register,
      [
        d.crudo(
          d.register,
          'ShiftOpened',
          turnoB,
          { register_id: d.register.dispositivoId, base: 20_000 },
          { base_sequence: 0 },
        ),
        d.crudo(
          d.register,
          'CashMovementRecorded',
          turnoB,
          {
            movement_id: newId(),
            type: 'entry',
            amount: 3_000,
            description: 'x',
            to_whom: null,
            days: [],
          },
          { base_sequence: 0 },
        ),
      ],
      d.hubB,
    )
    expect(rB.resultados.map(reason)).toEqual(['confirmed', 'confirmed'])
    d.movement(d.register, turnoA, 'output', 4_000)
    expect(d.status.hub.reconciliation(turnoA)?.cash.expected).toBe(6_000)
    expect(d.hubB.reconciliation(turnoB)?.cash.expected).toBe(23_000)

    // Cerrar el de A no cierra el de B.
    const { cashCount } = d.contar(d.register, turnoA, 6_000)
    expect(reason(d.close(d.register, turnoA, cashCount, 6_000, 6_000))).toBe('confirmed')
    expect(d.status.hub.turnoAbierto(d.register.dispositivoId)).toBeNull()
    expect(d.hubB.turnoAbierto(d.register.dispositivoId)?.id).toBe(turnoB)

    // Reiniciar cada hub reconstruye solo lo suyo.
    expect(d.nuevoHub().turnoAbierto(d.register.dispositivoId)).toBeNull()
    const reiniciadoB = d.nuevoHubB()
    expect(reiniciadoB.reconciliation(turnoB)?.cash).toMatchObject({
      entries: 3_000,
      expected: 23_000,
    })
    expect(reiniciadoB.reconciliation(turnoA)).toBeNull()
  })

  it('el umbral es de cada restaurante: un faltante de $500 se cierra solo en A (umbral 1.000), no en B (umbral 0)', () => {
    const d = two()
    const enB = (event: Record<string, unknown>) =>
      reason(d.send(d.register, [event], d.hubB).resultados[0])
    const turnoB = newId()
    expect(
      enB(
        d.crudo(
          d.register,
          'ShiftOpened',
          turnoB,
          { register_id: d.register.dispositivoId, base: 10_000 },
          { base_sequence: 0 },
        ),
      ),
    ).toBe('confirmed')
    const arqueoB = newId()
    enB(
      d.crudo(
        d.register,
        'CashCountRecorded',
        turnoB,
        { cash_count_id: arqueoB, tally: d.conteoDe(9_500), counted_cash: 9_500 },
        { base_sequence: 0 },
      ),
    )
    expect(
      enB(
        d.crudo(d.register, 'ShiftClosed', turnoB, d.datosCierre(arqueoB, 10_000, 9_500), {
          base_sequence: 0,
        }),
      ),
    ).toBe('missing_justification')

    const turnoA = d.abrirTurno(d.register, 10_000)
    const { cashCount } = d.contar(d.register, turnoA, 9_500)
    expect(reason(d.close(d.register, turnoA, cashCount, 10_000, 9_500))).toBe('confirmed')
  })
})

describe('con la red simulada: la caja cierra sin conexión, el hub se apaga y llegan duplicados', () => {
  /** La caja abre turno, mueve efectivo, cuenta y cierra; cada evento se guarda en el dispositivo. */
  async function cajaCierra(register: Nodo, base = 100_000) {
    const shift = newId()
    const cashCount = newId()
    const turnoCaja = { aggregate_type: 'register_shift' } as never
    await register.crear(
      shift,
      'ShiftOpened',
      { register_id: register.dispositivoId, base },
      turnoCaja,
    )
    await register.crear(
      shift,
      'CashMovementRecorded',
      {
        movement_id: newId(),
        type: 'entry',
        amount: 20_000,
        description: 'Cambio',
        to_whom: null,
        days: [],
      },
      turnoCaja,
    )
    await register.crear(
      shift,
      'CashCountRecorded',
      { cash_count_id: cashCount, tally: [{ value: 20_000, quantity: 6 }], counted_cash: 120_000 },
      turnoCaja,
    )
    await register.crear(
      shift,
      'ShiftClosed',
      {
        cash_count_id: cashCount,
        expected_cash: base + 20_000,
        counted_cash: 120_000,
        variance: 120_000 - (base + 20_000),
        justification: 'Se pagó un domicilio',
      },
      turnoCaja,
    )
    return shift
  }
  const types = (m: Montaje) => eventosDe(m).map((x) => x.type)
  const CUATRO = ['ShiftOpened', 'CashMovementRecorded', 'CashCountRecorded', 'ShiftClosed']

  it('todo sin conexión: al reconectar los cuatro se confirman en orden y el turno queda cerrado', async () => {
    const m = montar()
    const register = m.network.device('register')
    const ana = m.network.device('ana')
    const shift = await cajaCierra(register)
    expect(await register.cliente.pendingList()).toBe(4)
    await m.network.conectarTodos()
    expect(types(m)).toEqual(CUATRO)
    expect(m.hub().turnoAbierto(register.dispositivoId)).toBeNull()
    expect(m.hub().reconciliation(shift)?.closed).not.toBeNull()
    expect(await register.cliente.pendingList()).toBe(0)
    expect((await ana.cliente.locales()).map((l) => l.event.type)).toEqual(CUATRO)
  })

  it('un lote duplicado por la red no repite movimientos ni cierres', async () => {
    const m = montar()
    const register = m.network.device('register')
    await m.network.conectarTodos()
    register.rule('to_hub', 'push', 'duplicate', 4)
    await cajaCierra(register)
    await m.network.settle()
    expect(types(m)).toEqual(CUATRO)
    expect(await register.cliente.pendingList()).toBe(0)
  })

  it('el hub se apaga justo al guardar el conteo: al volver, el arqueo y el cierre se completan sin duplicar', async () => {
    const m = montar()
    const register = m.network.device('register')
    await m.network.conectarTodos()
    if (m.almacen instanceof AlmacenQueSeCae) m.almacen.caerEn = 3
    const shift = await cajaCierra(register)
    await m.network.settle()
    await m.network.conectarTodos()
    await m.network.settle()
    expect(types(m)).toEqual(CUATRO)
    expect(m.hub().turnoAbierto(register.dispositivoId)).toBeNull()
    expect(eventosDe(m).every((x) => x.aggregate_id === shift)).toBe(true)
  })

  it('el hub se apaga justo al guardar el cierre: el turno vuelve abierto y el cierre llega una sola vez', async () => {
    const m = montar()
    const register = m.network.device('register')
    await m.network.conectarTodos()
    if (m.almacen instanceof AlmacenQueSeCae) m.almacen.caerEn = 4
    await cajaCierra(register)
    await m.network.settle()
    await m.network.conectarTodos()
    await m.network.settle()
    expect(types(m).filter((x) => x === 'ShiftClosed')).toHaveLength(1)
    expect(m.hub().turnoAbierto(register.dispositivoId)).toBeNull()
  })

  it('con el reloj de la caja 3 horas atrasado el cierre se acepta igual', async () => {
    const m = montar()
    const register = m.network.device('register')
    register.desfaseMs = -3 * 60 * 60 * 1000
    await m.network.conectarTodos()
    await cajaCierra(register)
    await m.network.settle()
    expect(types(m)).toEqual(CUATRO)
  })

  it('con el reloj adelantado un día, también', async () => {
    const m = montar()
    const register = m.network.device('register')
    register.desfaseMs = 24 * 60 * 60 * 1000
    await m.network.conectarTodos()
    await cajaCierra(register)
    await m.network.settle()
    expect(types(m)).toEqual(CUATRO)
    expect(m.hub().turnoAbierto(register.dispositivoId)).toBeNull()
  })
})

describe('informe del hub (tarea 1.9): datosDeInforme y cierreDeTurno', () => {
  const DAY = '2026-10-24'

  it('junta los pedidos cerrados, los pagos del día y el cierre del turno con su cuadre', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 50_000)
    const closed = e.abrirPedido(e.register, 30_000)
    e.cobrar(e.register, closed, e.pagoEf(shift, 30_000, 3_000))
    expect(reason(e.one(e.register, e.crudo(e.register, 'OrderClosed', closed, {})))).toBe(
      'confirmed',
    )
    // Un abono de una mesa que sigue abierta: cuenta por medio, no en ventas.
    const opened = e.abrirPedido(e.register, 20_000)
    const abono = e.cobrar(e.register, opened, e.pagoNequi(shift, 5_000))
    e.voidItem(e.register, opened, abono, shift)
    e.movement(e.register, shift, 'tip_payout', 1_000)
    const { cashCount } = e.contar(e.register, shift, 82_000)
    expect(reason(e.close(e.register, shift, cashCount, 82_000, 82_000))).toBe('confirmed')

    const data = e.status.hub.datosDeInforme(DAY, DAY)
    expect(data.closings?.map((c) => [c.before, c.after.id])).toEqual([[null, closed]])
    // El pago de Nequi se anuló el mismo día: aparece con su anulación.
    expect(data.events.map((x) => x.type)).toEqual([
      'PaymentRecorded',
      'PaymentRecorded',
      'PaymentVoided',
      'CashMovementRecorded',
    ])
    expect(data.cierresDeCaja).toHaveLength(1)
    expect(data.cierresDeCaja[0]).toMatchObject({
      businessDay: DAY,
      abiertoPor: e.register.userId,
      cerradoPor: e.register.userId,
    })
    expect(data.cierresDeCaja[0]?.reconciliation.closed).toMatchObject({
      expected: 82_000,
      variance: 0,
    })
    // Ya cerrado, el cuadre sale de la base y es el mismo que vio la caja al cerrar.
    expect(e.status.hub.reconciliation(shift)?.cash.expected).toBe(82_000)
    expect(e.status.hub.datosDeInforme('2026-10-25', '2026-10-25')).toMatchObject({
      closings: [],
      events: [],
      cierresDeCaja: [],
    })
  })

  it('una anulación de hoy trae el pago original de otro día, y un reinicio da lo mismo', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register)
    const order = e.abrirPedido(e.register, 30_000)
    const payment = e.cobrar(e.register, order, e.pagoNequi(shift, 10_000))
    // Al otro día operativo (después de las 6:00 a. m.).
    e.m.network.advance(24 * 60 * 60 * 1000)
    e.voidItem(e.register, order, payment, shift)
    const today = e.status.hub.datosDeInforme('2026-10-25', '2026-10-25')
    expect(today.events.map((x) => `${x.type}:${x.business_day}`)).toEqual([
      `PaymentRecorded:${DAY}`,
      'PaymentVoided:2026-10-25',
    ])
    expect(e.nuevoHub().datosDeInforme('2026-10-25', '2026-10-25')).toEqual(today)
    expect(e.status.hub.cierreDeTurno(shift)).toBeNull()
  })
})
