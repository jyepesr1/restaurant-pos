import { aggregateOf, newId, otherMethodsReconciliation } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { HubSync } from './hub/hub'
import { accesoLibre } from './pruebas/acceso'
import { AHORA, AlmacenQueSeCae, eventosDe, item, type Montaje, montar } from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// El cierre de caja con los demás medios en el hub (tarea 1.8): `other_methods_mismatch`, la
// justificación por un medio que no es efectivo, el cierre correcto con tarjeta y Nequi, la
// compatibilidad con la 1.7, el reinicio del hub, la red simulada y el multirestaurante.

const SODEXO = newId()
const QR = newId()
const DATAFONO = newId()
const REGLAS = {
  multiple: 100,
  mode: 'nearest_half_down',
  medios: ['cash', 'card', 'nequi', 'daviplata', 'breb', 'transfer'],
  mediosPropios: [SODEXO, QR],
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

type Reporte = { method: string; custom_method_id: string | null; reported: number }
type Line = Reporte & { expected: number; variance: number }
const res = (method: string, reported: number, own: string | null = null): Reporte => ({
  method,
  custom_method_id: own,
  reported,
})
const lin = (
  method: string,
  expected: number,
  reported: number,
  own: string | null = null,
): Line => ({
  ...res(method, reported, own),
  expected,
  variance: reported - expected,
})

function entorno(options: { umbral?: number } = {}) {
  const m = montar()
  const register = m.network.device('register')
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
  /** En otro hub (otro restaurante) la secuencia base de A no vale: se parte de 0. */
  const deHub = (hub: HubSync): Record<string, unknown> =>
    hub === status.hub ? {} : { base_sequence: 0 }
  const send = (node: Nodo, events: Record<string, unknown>[], hub = status.hub) =>
    hub.recibirLote(conexionDe(m, node), events)
  const one = (node: Nodo, event: Record<string, unknown>, hub = status.hub) =>
    send(node, [event], hub).resultados[0]

  const abrirTurno = (node: Nodo, base = 100_000, shift = newId()) => {
    expect(
      reason(
        one(node, crudo(node, 'ShiftOpened', shift, { register_id: node.dispositivoId, base })),
      ),
    ).toBe('confirmed')
    return shift
  }
  const abrirPedido = (node: Nodo, price = 1_000_000, hub = status.hub) => {
    const order = newId()
    one(
      node,
      crudo(
        node,
        'OrderOpened',
        order,
        { channel: 'dine_in', table_id: null, guests: 2 },
        deHub(hub),
      ),
      hub,
    )
    one(node, crudo(node, 'ItemAdded', order, item(price), deHub(hub)), hub)
    return order
  }
  const base = (shift: string, amount: number, tip: number) => ({
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    amount,
    tip,
    tendered: null,
    change: null,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: null,
    charge_reference: null,
  })
  const pagoEf = (shift: string, amount: number, tip = 0) => ({
    ...base(shift, amount, tip),
    method: 'cash',
    tendered: amount + tip,
    change: 0,
  })
  const cardPaymentData = (shift: string, amount: number, tip = 0) => ({
    ...base(shift, amount, tip),
    method: 'card',
    cardTerminal: {
      card_terminal_id: DATAFONO,
      franchise: null,
      last4: null,
      approval_code: null,
      receipt: null,
      card_type: 'credit',
    },
  })
  const pagoNequi = (shift: string, amount: number, tip = 0) => ({
    ...base(shift, amount, tip),
    method: 'nequi',
  })
  const pagoPropio = (shift: string, id: string, amount: number, tip = 0) => ({
    ...base(shift, amount, tip),
    method: 'other',
    custom_method_id: id,
  })
  const cobrar = (node: Nodo, order: string, data: { payment_id: string }, hub = status.hub) => {
    expect(reason(one(node, crudo(node, 'PaymentRecorded', order, data, deHub(hub)), hub))).toBe(
      'confirmed',
    )
    return data.payment_id
  }
  const voidItem = (node: Nodo, order: string, paymentId: string, shift: string) =>
    one(
      node,
      crudo(node, 'PaymentVoided', order, { payment_id: paymentId, register_shift_id: shift }),
    )
  const conteoDe = (counted: number) =>
    [
      { value: 1_000, quantity: Math.floor(counted / 1_000) },
      { value: 1, quantity: counted % 1_000 },
    ].filter((c) => c.quantity > 0)
  /** Un conteo de `contado` pesos en efectivo y los reportes de los demás medios (si se dan). */
  const contar = (
    node: Nodo,
    shift: string,
    counted: number,
    others?: Reporte[],
    hub = status.hub,
  ) => {
    const cashCount = newId()
    const result = one(
      node,
      crudo(
        node,
        'CashCountRecorded',
        shift,
        {
          cash_count_id: cashCount,
          tally: conteoDe(counted),
          counted_cash: counted,
          ...(others ? { others } : {}),
        },
        deHub(hub),
      ),
      hub,
    )
    return { cashCount, result }
  }
  /** Las líneas que debe traer el cierre: las que calcula el hub con el conteo. */
  const lineasDe = (shift: string, cashCount: string, hub = status.hub): Line[] => {
    const reconciliation = hub.reconciliation(shift)
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
  /** Cierra con lo que se pida; sin `other_methods` se manda el cierre tal cual lo calcula el hub. */
  const close = (
    node: Nodo,
    shift: string,
    cashCount: string,
    expected: number,
    counted: number,
    options: {
      justification?: string | null
      other_methods?: unknown
      sinCampo?: boolean
      hub?: HubSync
    } = {},
  ) => {
    const hub = options.hub ?? status.hub
    const data: Record<string, unknown> = {
      cash_count_id: cashCount,
      expected_cash: expected,
      counted_cash: counted,
      variance: counted - expected,
      justification: options.justification ?? null,
    }
    if (!options.sinCampo)
      data.other_methods = options.other_methods ?? lineasDe(shift, cashCount, hub)
    return one(node, crudo(node, 'ShiftClosed', shift, data, deHub(hub)), hub)
  }

  return {
    m,
    register,
    ana,
    cfg,
    deHub,
    status,
    nuevoHub,
    crudo,
    send,
    one,
    abrirTurno,
    abrirPedido,
    pagoEf,
    cardPaymentData,
    pagoNequi,
    pagoPropio,
    cobrar,
    voidItem,
    contar,
    conteoDe,
    close,
    lineasDe,
  }
}

/** Base 100.000, tarjeta 100.000 + 10.000 de propina y Nequi 30.000; efectivo contado 100.000. */
function conTarjetaYNequi(umbral = 1000) {
  const e = entorno({ umbral })
  const shift = e.abrirTurno(e.register, 100_000)
  const order = e.abrirPedido(e.register)
  e.cobrar(e.register, order, e.cardPaymentData(shift, 100_000, 10_000))
  e.cobrar(e.register, order, e.pagoNequi(shift, 30_000))
  return { ...e, shift, order, ESPERADO_TARJETA: 110_000, ESPERADO_NEQUI: 30_000 }
}

describe('cierre con tarjeta y Nequi', () => {
  it('el cierre correcto: cada medio reportado igual a lo registrado, se confirma y queda guardado', () => {
    const t = conTarjetaYNequi()
    const { cashCount, result } = t.contar(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    expect(reason(result)).toBe('confirmed')
    const closeout = t.close(t.register, t.shift, cashCount, 100_000, 100_000)
    expect(reason(closeout)).toBe('confirmed')
    expect(t.status.hub.turnoAbierto(t.register.dispositivoId)).toBeNull()
    const saved = eventosDe(t.m).find((x) => x.type === 'ShiftClosed')
    expect(saved?.type === 'ShiftClosed' && saved.data.other_methods).toEqual([
      lin('card', 110_000, 110_000),
      lin('nequi', 30_000, 30_000),
    ])
  })

  it('con diferencia en un medio pero justificada: se confirma y la diferencia queda guardada con su signo', () => {
    const t = conTarjetaYNequi()
    const { cashCount } = t.contar(t.register, t.shift, 100_000, [
      res('card', 105_000),
      res('nequi', 31_500),
    ])
    expect(reason(t.close(t.register, t.shift, cashCount, 100_000, 100_000))).toBe(
      'missing_justification',
    )
    expect(
      reason(
        t.close(t.register, t.shift, cashCount, 100_000, 100_000, {
          justification: 'El datáfono se reinició',
        }),
      ),
    ).toBe('confirmed')
    const saved = eventosDe(t.m).find((x) => x.type === 'ShiftClosed')
    expect(saved?.type === 'ShiftClosed' && saved.data.other_methods).toEqual([
      lin('card', 110_000, 105_000),
      lin('nequi', 30_000, 31_500),
    ])
  })

  it('con un medio propio y otro reportado sin pagos (un cobro que no se registró)', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 0)
    const order = e.abrirPedido(e.register)
    e.cobrar(e.register, order, e.pagoPropio(shift, SODEXO, 20_000))
    const { cashCount } = e.contar(e.register, shift, 0, [
      res('other', 20_000, SODEXO),
      res('daviplata', 5_000),
    ])
    expect(e.lineasDe(shift, cashCount)).toEqual([
      lin('other', 20_000, 20_000, SODEXO),
      lin('daviplata', 0, 5_000),
    ])
    expect(reason(e.close(e.register, shift, cashCount, 0, 0))).toBe('missing_justification')
    expect(
      reason(
        e.close(e.register, shift, cashCount, 0, 0, {
          justification: 'Un cobro por Daviplata sin registrar',
        }),
      ),
    ).toBe('confirmed')
  })

  it('el orden de las líneas del cierre no importa', () => {
    const t = conTarjetaYNequi()
    const { cashCount } = t.contar(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    expect(
      reason(
        t.close(t.register, t.shift, cashCount, 100_000, 100_000, {
          other_methods: [lin('nequi', 30_000, 30_000), lin('card', 110_000, 110_000)],
        }),
      ),
    ).toBe('confirmed')
  })

  it('un reembolso o una anulación bajan lo esperado: el cierre debe traer lo neto', () => {
    const t = conTarjetaYNequi()
    const payment = t.cobrar(t.register, t.order, t.pagoNequi(t.shift, 10_000))
    t.voidItem(t.register, t.order, payment, t.shift)
    const { cashCount } = t.contar(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    expect(t.lineasDe(t.shift, cashCount)).toEqual([
      lin('card', 110_000, 110_000),
      lin('nequi', 30_000, 30_000),
    ])
    expect(reason(t.close(t.register, t.shift, cashCount, 100_000, 100_000))).toBe('confirmed')
  })
})

describe('otros_medios_distintos', () => {
  function ready() {
    const t = conTarjetaYNequi()
    const { cashCount } = t.contar(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    const cerrarCon = (other_methods: unknown) =>
      reason(t.close(t.register, t.shift, cashCount, 100_000, 100_000, { other_methods }))
    return { ...t, cashCount, cerrarCon }
  }

  it('falta un medio: el cierre no trae el Nequi', () => {
    expect(ready().cerrarCon([lin('card', 110_000, 110_000)])).toBe('other_methods_mismatch')
  })

  it('falta todo: una lista vacía con pagos digitales', () => {
    expect(ready().cerrarCon([])).toBe('other_methods_mismatch')
  })

  it('sin el campo `otros_medios` (un cliente de la 1.7) con pagos digitales', () => {
    const t = conTarjetaYNequi()
    const { cashCount } = t.contar(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    expect(
      reason(t.close(t.register, t.shift, cashCount, 100_000, 100_000, { sinCampo: true })),
    ).toBe('other_methods_mismatch')
  })

  it('sobra un medio: una línea con reportado que el conteo no tiene', () => {
    expect(
      ready().cerrarCon([
        lin('card', 110_000, 110_000),
        lin('nequi', 30_000, 30_000),
        lin('daviplata', 0, 5_000),
      ]),
    ).toBe('other_methods_mismatch')
  })

  it('sobra un medio en 0 y 0: el hub no lo lista, así que el cierre con él es distinto', () => {
    expect(
      ready().cerrarCon([
        lin('card', 110_000, 110_000),
        lin('nequi', 30_000, 30_000),
        lin('daviplata', 0, 0),
      ]),
    ).toBe('other_methods_mismatch')
  })

  // El esquema ya rechaza la línea repetida y el medio propio sin id, antes de comparar con el hub.
  it('una línea repetida: el esquema la rechaza', () => {
    expect(
      ready().cerrarCon([
        lin('card', 110_000, 110_000),
        lin('card', 110_000, 110_000),
        lin('nequi', 30_000, 30_000),
      ]),
    ).toMatch(/^esquema: .*Un medio aparece dos veces/)
  })

  it('otro esperado: dice $1 menos o más de lo que registró el hub', () => {
    expect(ready().cerrarCon([lin('card', 109_999, 110_000), lin('nequi', 30_000, 30_000)])).toBe(
      'other_methods_mismatch',
    )
    expect(ready().cerrarCon([lin('card', 110_001, 110_000), lin('nequi', 30_000, 30_000)])).toBe(
      'other_methods_mismatch',
    )
  })

  it('otro reportado: dice otro valor que el conteo, aunque la diferencia sea consecuente', () => {
    expect(ready().cerrarCon([lin('card', 110_000, 100_000), lin('nequi', 30_000, 30_000)])).toBe(
      'other_methods_mismatch',
    )
    expect(ready().cerrarCon([lin('card', 110_000, 110_000), lin('nequi', 30_000, 30_001)])).toBe(
      'other_methods_mismatch',
    )
  })

  it('una línea con la diferencia mal calculada no llega: el esquema la rechaza', () => {
    const r = ready().cerrarCon([
      { ...lin('card', 110_000, 110_000), variance: 5 },
      lin('nequi', 30_000, 30_000),
    ])
    expect(r).toMatch(/^esquema:/)
  })

  it('el efectivo entre los demás medios: el esquema lo rechaza', () => {
    const r = ready().cerrarCon([
      lin('cash', 0, 0),
      lin('card', 110_000, 110_000),
      lin('nequi', 30_000, 30_000),
    ])
    expect(r).toMatch(/^esquema:/)
  })

  it('un medio cambiado por otro (Nequi dicho como Daviplata)', () => {
    expect(
      ready().cerrarCon([lin('card', 110_000, 110_000), lin('daviplata', 30_000, 30_000)]),
    ).toBe('other_methods_mismatch')
  })

  it('un medio propio con otro id: distinto', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 0)
    const order = e.abrirPedido(e.register)
    e.cobrar(e.register, order, e.pagoPropio(shift, SODEXO, 20_000))
    const { cashCount } = e.contar(e.register, shift, 0, [res('other', 20_000, SODEXO)])
    expect(
      reason(
        e.close(e.register, shift, cashCount, 0, 0, {
          other_methods: [lin('other', 20_000, 20_000, QR)],
        }),
      ),
    ).toBe('other_methods_mismatch')
    expect(
      reason(
        e.close(e.register, shift, cashCount, 0, 0, {
          other_methods: [lin('other', 20_000, 20_000, SODEXO)],
        }),
      ),
    ).toBe('confirmed')
  })

  it('un medio propio sin id en el cierre: el esquema lo rechaza', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 0)
    const order = e.abrirPedido(e.register)
    e.cobrar(e.register, order, e.pagoPropio(shift, SODEXO, 20_000))
    const { cashCount } = e.contar(e.register, shift, 0, [res('other', 20_000, SODEXO)])
    expect(
      reason(
        e.close(e.register, shift, cashCount, 0, 0, {
          other_methods: [lin('other', 20_000, 20_000, null)],
        }),
      ),
    ).toMatch(/^esquema: .*Un medio propio dice cuál es/)
  })

  it('un rechazo no cierra el turno ni deja huella; con las líneas correctas se acepta', () => {
    const t = ready()
    const before = t.m.almacen.maxSecuencia()
    expect(t.cerrarCon([])).toBe('other_methods_mismatch')
    expect(t.m.almacen.maxSecuencia()).toBe(before)
    expect(t.status.hub.turnoAbierto(t.register.dispositivoId)?.id).toBe(t.shift)
    expect(t.cerrarCon(t.lineasDe(t.shift, t.cashCount))).toBe('confirmed')
  })

  it('el rechazo se repite igual si se reenvía', () => {
    const t = ready()
    const data = {
      cash_count_id: t.cashCount,
      expected_cash: 100_000,
      counted_cash: 100_000,
      variance: 0,
      justification: null,
      other_methods: [],
    }
    const event = t.crudo(t.register, 'ShiftClosed', t.shift, data)
    expect(reason(t.one(t.register, event))).toBe('other_methods_mismatch')
    expect(reason(t.one(t.register, event))).toBe('other_methods_mismatch')
  })

  it('el orden de las reglas: el esperado en efectivo va antes que los demás medios, y estos antes que la justificación', () => {
    const t = conTarjetaYNequi(0)
    const { cashCount } = t.contar(t.register, t.shift, 99_000, [
      res('card', 1),
      res('nequi', 30_000),
    ])
    // Todo mal a la vez: el esperado en efectivo (1) y las líneas (vacías), sin justificación.
    expect(reason(t.close(t.register, t.shift, cashCount, 1, 99_000, { other_methods: [] }))).toBe(
      'expected_mismatch',
    )
    expect(
      reason(t.close(t.register, t.shift, cashCount, 100_000, 99_000, { other_methods: [] })),
    ).toBe('other_methods_mismatch')
    expect(reason(t.close(t.register, t.shift, cashCount, 100_000, 99_000))).toBe(
      'missing_justification',
    )
  })

  it('un pago digital después del conteo: el conteo queda desactualizado, y con uno nuevo se cierra', () => {
    const t = conTarjetaYNequi()
    const { cashCount } = t.contar(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    t.cobrar(t.register, t.order, t.pagoNequi(t.shift, 5_000))
    expect(reason(t.close(t.register, t.shift, cashCount, 100_000, 100_000))).toBe(
      'stale_cash_count',
    )
    const other = t.contar(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 35_000),
    ])
    expect(reason(t.close(t.register, t.shift, other.cashCount, 100_000, 100_000))).toBe(
      'confirmed',
    )
  })

  it('con varios conteos solo vale el reporte del último', () => {
    const t = conTarjetaYNequi()
    const firstOne = t.contar(t.register, t.shift, 100_000, [res('card', 1), res('nequi', 1)])
    const latest = t.contar(t.register, t.shift, 100_000, [
      res('card', 110_000),
      res('nequi', 30_000),
    ])
    expect(reason(t.close(t.register, t.shift, firstOne.cashCount, 100_000, 100_000))).toBe(
      'cash_count_not_latest',
    )
    expect(reason(t.close(t.register, t.shift, latest.cashCount, 100_000, 100_000))).toBe(
      'confirmed',
    )
  })

  it('los reportes del arqueo con el esquema roto (efectivo, repetidos, medio propio sin id) se rechazan', () => {
    const t = conTarjetaYNequi()
    const malos: Reporte[][] = [
      [res('cash', 1)],
      [res('card', 1), res('card', 2)],
      [res('other', 1, null)],
      [res('card', 1, SODEXO)],
    ]
    for (const others of malos)
      expect(reason(t.contar(t.register, t.shift, 100_000, others).result)).toMatch(/^esquema:/)
  })
})

describe('falta_justificacion por un medio que no es efectivo', () => {
  /** Cuenta con `reportado` en la tarjeta (esperado 10.000) y cierra con `justificacion`. */
  function cierraCon(umbral: number, reported: number, justification: string | null = null) {
    const e = entorno({ umbral })
    const shift = e.abrirTurno(e.register, 0)
    e.cobrar(e.register, e.abrirPedido(e.register), e.cardPaymentData(shift, 10_000))
    const { cashCount } = e.contar(e.register, shift, 0, [res('card', reported)])
    return reason(e.close(e.register, shift, cashCount, 0, 0, { justification }))
  }

  it('umbral 1.000: por debajo se cierra; desde 1.000 de faltante o de sobrante pide justificación', () => {
    expect(cierraCon(1000, 10_000)).toBe('confirmed')
    expect(cierraCon(1000, 9_999)).toBe('confirmed')
    expect(cierraCon(1000, 10_001)).toBe('confirmed')
    expect(cierraCon(1000, 9_001)).toBe('confirmed')
    expect(cierraCon(1000, 10_999)).toBe('confirmed')
    expect(cierraCon(1000, 9_000)).toBe('missing_justification')
    expect(cierraCon(1000, 11_000)).toBe('missing_justification')
    expect(cierraCon(1000, 8_999)).toBe('missing_justification')
    expect(cierraCon(1000, 11_001)).toBe('missing_justification')
    expect(cierraCon(1000, 0)).toBe('missing_justification')
  })

  it('con justificación se acepta aunque la diferencia sea grande', () => {
    expect(cierraCon(1000, 0, 'No llegó el cierre del datáfono')).toBe('confirmed')
    expect(cierraCon(1000, 20_000, 'Cobros de otro turno')).toBe('confirmed')
  })

  it('umbral 0: cualquier diferencia de $1 pide justificación; sin diferencia, no', () => {
    expect(cierraCon(0, 10_000)).toBe('confirmed')
    expect(cierraCon(0, 9_999)).toBe('missing_justification')
    expect(cierraCon(0, 10_001)).toBe('missing_justification')
  })

  it('umbral 2.000: el borde es inclusivo', () => {
    expect(cierraCon(2000, 8_001)).toBe('confirmed')
    expect(cierraCon(2000, 12_000)).toBe('missing_justification')
    expect(cierraCon(2000, 8_000)).toBe('missing_justification')
    expect(cierraCon(2000, 11_999)).toBe('confirmed')
  })

  it('el efectivo cuadra y la tarjeta no: igual se pide justificación', () => {
    expect(cierraCon(1000, 5_000)).toBe('missing_justification')
  })

  it('la tarjeta cuadra y el efectivo no cuadra por poco: por debajo del umbral no se pide', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 10_000)
    e.cobrar(e.register, e.abrirPedido(e.register), e.cardPaymentData(shift, 10_000))
    const { cashCount } = e.contar(e.register, shift, 9_500, [res('card', 10_000)])
    expect(reason(e.close(e.register, shift, cashCount, 10_000, 9_500))).toBe('confirmed')
  })

  it('cada medio se mide aparte: dos diferencias de $600 (efectivo y tarjeta) con umbral 1.000 no piden justificación', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 10_000)
    e.cobrar(e.register, e.abrirPedido(e.register), e.cardPaymentData(shift, 10_000))
    const { cashCount } = e.contar(e.register, shift, 9_400, [res('card', 9_400)])
    expect(reason(e.close(e.register, shift, cashCount, 10_000, 9_400))).toBe('confirmed')
  })

  it('uno de varios medios con la diferencia grande basta; un sobrante de un medio reportado sin pagos también', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 0)
    e.cobrar(e.register, e.abrirPedido(e.register), e.cardPaymentData(shift, 10_000))
    const { cashCount } = e.contar(e.register, shift, 0, [res('card', 10_000), res('breb', 1_000)])
    expect(reason(e.close(e.register, shift, cashCount, 0, 0))).toBe('missing_justification')
    const two = e.contar(e.register, shift, 0, [res('card', 10_000), res('breb', 999)])
    expect(reason(e.close(e.register, shift, two.cashCount, 0, 0))).toBe('confirmed')
  })

  it('lo esperado negativo (se anuló un pago de un turno anterior) y nada reportado: la diferencia es el sobrante', () => {
    const e = entorno()
    const t1 = e.abrirTurno(e.register, 0)
    const order = e.abrirPedido(e.register)
    const payment = e.cobrar(e.register, order, e.cardPaymentData(t1, 5_000))
    const a1 = e.contar(e.register, t1, 0, [res('card', 5_000)])
    expect(reason(e.close(e.register, t1, a1.cashCount, 0, 0))).toBe('confirmed')
    const t2 = e.abrirTurno(e.register, 0)
    e.voidItem(e.register, order, payment, t2)
    const a2 = e.contar(e.register, t2, 0, [])
    expect(e.lineasDe(t2, a2.cashCount)).toEqual([lin('card', -5_000, 0)])
    expect(reason(e.close(e.register, t2, a2.cashCount, 0, 0))).toBe('missing_justification')
    expect(
      reason(e.close(e.register, t2, a2.cashCount, 0, 0, { justification: 'Devolución de ayer' })),
    ).toBe('confirmed')
  })

  it('un día de solo devoluciones: el cierre dice el neto en negativo y cuadra sin justificación', () => {
    const e = entorno()
    const t1 = e.abrirTurno(e.register, 0)
    const order = e.abrirPedido(e.register)
    const payment = e.cobrar(e.register, order, e.cardPaymentData(t1, 5_000))
    const a1 = e.contar(e.register, t1, 0, [res('card', 5_000)])
    expect(reason(e.close(e.register, t1, a1.cashCount, 0, 0))).toBe('confirmed')
    const t2 = e.abrirTurno(e.register, 0)
    e.voidItem(e.register, order, payment, t2)
    const a2 = e.contar(e.register, t2, 0, [res('card', -5_000)])
    expect(e.lineasDe(t2, a2.cashCount)).toEqual([lin('card', -5_000, -5_000)])
    expect(reason(e.close(e.register, t2, a2.cashCount, 0, 0))).toBe('confirmed')
    const saved = eventosDe(e.m)
      .filter((x) => x.type === 'ShiftClosed')
      .at(-1)
    expect(saved?.type === 'ShiftClosed' && saved.data.other_methods).toEqual([
      lin('card', -5_000, -5_000),
    ])
  })

  it('reportar en negativo cuando lo esperado es positivo es una diferencia grande', () => {
    expect(cierraCon(1000, -1)).toBe('missing_justification')
  })

  it('el umbral que vale es el vigente al cerrar', () => {
    const e = entorno({ umbral: 5_000 })
    const shift = e.abrirTurno(e.register, 0)
    e.cobrar(e.register, e.abrirPedido(e.register), e.cardPaymentData(shift, 10_000))
    const { cashCount } = e.contar(e.register, shift, 0, [res('card', 8_000)])
    e.cfg.umbral = 1_000
    expect(reason(e.close(e.register, shift, cashCount, 0, 0))).toBe('missing_justification')
    e.cfg.umbral = 5_000
    expect(reason(e.close(e.register, shift, cashCount, 0, 0))).toBe('confirmed')
  })

  it('un hub sin reglas de cobro usa el umbral de fábrica ($1.000) también para los demás medios', () => {
    const e = entorno()
    const sinReglas = e.m.hub()
    const connection = conexionDe(e.m, e.register)
    const shift = newId()
    sinReglas.recibirLote(connection, [
      e.crudo(e.register, 'ShiftOpened', shift, { register_id: e.register.dispositivoId, base: 0 }),
    ])
    const order = newId()
    sinReglas.recibirLote(connection, [
      e.crudo(e.register, 'OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 1 }),
      e.crudo(e.register, 'ItemAdded', order, item(100_000)),
    ])
    expect(
      reason(
        sinReglas.recibirLote(connection, [
          e.crudo(e.register, 'PaymentRecorded', order, e.pagoNequi(shift, 10_000)),
        ]).resultados[0],
      ),
    ).toBe('confirmed')
    const tryAction = (reported: number) => {
      const cashCount = newId()
      sinReglas.recibirLote(connection, [
        e.crudo(e.register, 'CashCountRecorded', shift, {
          cash_count_id: cashCount,
          tally: [],
          counted_cash: 0,
          others: [res('nequi', reported)],
        }),
      ])
      return reason(
        sinReglas.recibirLote(connection, [
          e.crudo(e.register, 'ShiftClosed', shift, {
            cash_count_id: cashCount,
            expected_cash: 0,
            counted_cash: 0,
            variance: 0,
            justification: null,
            other_methods: [lin('nequi', 10_000, reported)],
          }),
        ]).resultados[0],
      )
    }
    expect(tryAction(9_000)).toBe('missing_justification')
    expect(tryAction(9_001)).toBe('confirmed')
  })
})

describe('compatibilidad con la 1.7: sin pagos digitales', () => {
  it('un turno solo con efectivo se cierra sin el campo `otros_medios` y con el conteo sin `otros`', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 100_000)
    e.cobrar(e.register, e.abrirPedido(e.register), e.pagoEf(shift, 30_000, 2_000))
    const { cashCount, result } = e.contar(e.register, shift, 132_000)
    expect(reason(result)).toBe('confirmed')
    expect(
      reason(e.close(e.register, shift, cashCount, 132_000, 132_000, { sinCampo: true })),
    ).toBe('confirmed')
    const saved = eventosDe(e.m).find((x) => x.type === 'ShiftClosed')
    expect(saved?.type === 'ShiftClosed' && saved.data.other_methods).toBeUndefined()
  })

  it('un turno sin ningún pago, con `otros_medios: []` o sin el campo', () => {
    for (const sinCampo of [true, false]) {
      const e = entorno()
      const shift = e.abrirTurno(e.register, 5_000)
      const { cashCount } = e.contar(e.register, shift, 5_000)
      expect(reason(e.close(e.register, shift, cashCount, 5_000, 5_000, { sinCampo }))).toBe(
        'confirmed',
      )
    }
  })

  it('un conteo con reportes en 0 de medios sin pagos se cierra sin el campo (todo en 0 no sale)', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 0)
    const { cashCount } = e.contar(e.register, shift, 0, [
      res('card', 0),
      res('nequi', 0),
      res('other', 0, SODEXO),
    ])
    expect(reason(e.close(e.register, shift, cashCount, 0, 0, { sinCampo: true }))).toBe(
      'confirmed',
    )
  })

  it('un turno con pagos digitales anulados por completo (neto 0) se cierra sin `otros_medios`', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 0)
    const order = e.abrirPedido(e.register)
    const payment = e.cobrar(e.register, order, e.pagoNequi(shift, 8_000, 800))
    e.voidItem(e.register, order, payment, shift)
    const { cashCount } = e.contar(e.register, shift, 0)
    expect(reason(e.close(e.register, shift, cashCount, 0, 0, { sinCampo: true }))).toBe(
      'confirmed',
    )
  })

  it('un turno con pagos digitales y un conteo de la 1.7 (sin `otros`) no se puede cerrar sin decirlo: la diferencia es el total', () => {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 0)
    e.cobrar(e.register, e.abrirPedido(e.register), e.pagoNequi(shift, 8_000))
    const { cashCount } = e.contar(e.register, shift, 0)
    expect(reason(e.close(e.register, shift, cashCount, 0, 0, { sinCampo: true }))).toBe(
      'other_methods_mismatch',
    )
    expect(e.lineasDe(shift, cashCount)).toEqual([lin('nequi', 8_000, 0)])
    expect(reason(e.close(e.register, shift, cashCount, 0, 0))).toBe('missing_justification')
    expect(
      reason(
        e.close(e.register, shift, cashCount, 0, 0, { justification: 'Sin cierre de la app' }),
      ),
    ).toBe('confirmed')
  })
})

describe('reinicio del hub con tarjeta y Nequi a medias', () => {
  function aMedias() {
    const e = entorno()
    const shift = e.abrirTurno(e.register, 100_000)
    const order = e.abrirPedido(e.register)
    e.cobrar(e.register, order, e.cardPaymentData(shift, 100_000, 10_000))
    e.cobrar(e.register, order, e.pagoNequi(shift, 30_000))
    e.cobrar(e.register, order, e.pagoPropio(shift, SODEXO, 20_000))
    const { cashCount } = e.contar(e.register, shift, 100_000, [
      res('card', 108_000),
      res('nequi', 30_000),
      res('other', 20_000, SODEXO),
    ])
    return { ...e, shift, order, cashCount }
  }

  it('el conteo conserva lo reportado por cada medio', () => {
    const t = aMedias()
    const before = t.status.hub.reconciliation(t.shift)
    const after = t.nuevoHub().reconciliation(t.shift)
    expect(after).toEqual(before)
    expect(after?.cashCounts[0]?.others).toEqual([
      { method: 'card', customMethodId: null, reported: 108_000 },
      { method: 'nequi', customMethodId: null, reported: 30_000 },
      { method: 'other', customMethodId: SODEXO, reported: 20_000 },
    ])
  })

  it('tras el reinicio, el cierre con las líneas reconstruidas se acepta y con otras se rechaza', () => {
    const t = aMedias()
    const reiniciado = t.nuevoHub()
    const lines = t.lineasDe(t.shift, t.cashCount, reiniciado)
    expect(lines).toEqual([
      lin('card', 110_000, 108_000),
      lin('nequi', 30_000, 30_000),
      lin('other', 20_000, 20_000, SODEXO),
    ])
    expect(
      reason(
        t.close(t.register, t.shift, t.cashCount, 100_000, 100_000, {
          hub: reiniciado,
          other_methods: lines.slice(1),
        }),
      ),
    ).toBe('other_methods_mismatch')
    expect(
      reason(
        t.close(t.register, t.shift, t.cashCount, 100_000, 100_000, {
          hub: reiniciado,
          other_methods: lines,
        }),
      ),
    ).toBe('missing_justification')
    expect(
      reason(
        t.close(t.register, t.shift, t.cashCount, 100_000, 100_000, {
          hub: reiniciado,
          other_methods: lines,
          justification: 'Propinas del cierre',
        }),
      ),
    ).toBe('confirmed')
    expect(reiniciado.turnoAbierto(t.register.dispositivoId)).toBeNull()
  })

  it('un turno cerrado con otros medios sigue cerrado tras el reinicio', () => {
    const t = aMedias()
    t.close(t.register, t.shift, t.cashCount, 100_000, 100_000, {
      justification: 'Propinas del cierre',
    })
    const reiniciado = t.nuevoHub()
    expect(reiniciado.turnoAbierto(t.register.dispositivoId)).toBeNull()
    expect(reiniciado.reconciliation(t.shift)?.closed).not.toBeNull()
    expect(
      reason(
        t.one(
          t.register,
          t.crudo(t.register, 'CashCountRecorded', t.shift, {
            cash_count_id: newId(),
            tally: [],
            counted_cash: 0,
            others: [],
          }),
          reiniciado,
        ),
      ),
    ).toBe('no_shift')
  })

  it('un pago digital después del conteo sigue desactualizando el conteo tras el reinicio', () => {
    const t = aMedias()
    t.cobrar(t.register, t.order, t.pagoNequi(t.shift, 1_000))
    const reiniciado = t.nuevoHub()
    expect(
      reason(t.close(t.register, t.shift, t.cashCount, 100_000, 100_000, { hub: reiniciado })),
    ).toBe('stale_cash_count')
  })
})

describe('multirestaurante: los demás medios son de cada restaurante', () => {
  function two(umbralB = 0) {
    const e = entorno()
    const otroId = newId()
    e.m.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(otroId, otroId, AHORA, AHORA)
    const hubB = new HubSync(new AlmacenSqlite(e.m.db, otroId), {
      restauranteId: otroId,
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      access: accesoLibre,
      instancia: 'hub-b',
      clock: e.m.network.horaIso,
      reglasCobro: () => ({ ...REGLAS, umbralDiferencia: umbralB }),
    })
    return { ...e, hubB }
  }
  const enB = (d: ReturnType<typeof two>, type: string, aggregate: string, data: unknown) =>
    reason(
      d.one(d.register, d.crudo(d.register, type, aggregate, data, { base_sequence: 0 }), d.hubB),
    )

  it('los pagos digitales de A no cuentan en B: el mismo turno de B se cierra sin `otros_medios`', () => {
    const d = two()
    const turnoA = d.abrirTurno(d.register, 0)
    d.cobrar(d.register, d.abrirPedido(d.register), d.cardPaymentData(turnoA, 50_000))
    const turnoB = newId()
    expect(enB(d, 'ShiftOpened', turnoB, { register_id: d.register.dispositivoId, base: 0 })).toBe(
      'confirmed',
    )
    const arqueoB = newId()
    expect(
      enB(d, 'CashCountRecorded', turnoB, {
        cash_count_id: arqueoB,
        tally: [],
        counted_cash: 0,
        others: [],
      }),
    ).toBe('confirmed')
    expect(
      enB(d, 'ShiftClosed', turnoB, {
        cash_count_id: arqueoB,
        expected_cash: 0,
        counted_cash: 0,
        variance: 0,
        justification: null,
        other_methods: [],
      }),
    ).toBe('confirmed')
    // El turno de A sigue abierto y su tarjeta, esperada.
    expect(d.status.hub.turnoAbierto(d.register.dispositivoId)?.id).toBe(turnoA)
    expect(d.status.hub.reconciliation(turnoA)?.byMethod).toMatchObject([
      { method: 'card', sale: 50_000 },
    ])
  })

  it('el cierre de A con sus líneas no sirve en B (sin_turno) y cada uno cuadra con lo suyo', () => {
    const d = two(1000)
    const turnoA = d.abrirTurno(d.register, 0)
    d.cobrar(d.register, d.abrirPedido(d.register), d.cardPaymentData(turnoA, 50_000))
    const a = d.contar(d.register, turnoA, 0, [res('card', 50_000)])
    expect(
      enB(d, 'ShiftClosed', turnoA, {
        cash_count_id: a.cashCount,
        expected_cash: 0,
        counted_cash: 0,
        variance: 0,
        justification: null,
        other_methods: d.lineasDe(turnoA, a.cashCount),
      }),
    ).toBe('no_shift')

    const turnoB = newId()
    enB(d, 'ShiftOpened', turnoB, { register_id: d.register.dispositivoId, base: 0 })
    const orderB = d.abrirPedido(d.register, 1_000_000, d.hubB)
    d.cobrar(d.register, orderB, d.pagoNequi(turnoB, 7_000), d.hubB)
    const arqueoB = newId()
    enB(d, 'CashCountRecorded', turnoB, {
      cash_count_id: arqueoB,
      tally: [],
      counted_cash: 0,
      others: [res('nequi', 7_000)],
    })
    expect(d.lineasDe(turnoB, arqueoB, d.hubB)).toEqual([lin('nequi', 7_000, 7_000)])
    expect(reason(d.close(d.register, turnoA, a.cashCount, 0, 0))).toBe('confirmed')
    expect(d.status.hub.turnoAbierto(d.register.dispositivoId)).toBeNull()
    // El de B sigue abierto hasta que se cierra con lo suyo.
    expect(d.hubB.turnoAbierto(d.register.dispositivoId)?.id).toBe(turnoB)
    expect(reason(d.close(d.register, turnoB, arqueoB, 0, 0, { hub: d.hubB }))).toBe('confirmed')
  })

  it('el umbral es de cada restaurante: una diferencia de $500 en la tarjeta se cierra en A (1.000) y no en B (0)', () => {
    const d = two(0)
    const turnoA = d.abrirTurno(d.register, 0)
    d.cobrar(d.register, d.abrirPedido(d.register), d.cardPaymentData(turnoA, 10_000))
    const a = d.contar(d.register, turnoA, 0, [res('card', 9_500)])
    expect(reason(d.close(d.register, turnoA, a.cashCount, 0, 0))).toBe('confirmed')

    const turnoB = newId()
    enB(d, 'ShiftOpened', turnoB, { register_id: d.register.dispositivoId, base: 0 })
    const orderB = d.abrirPedido(d.register, 1_000_000, d.hubB)
    d.cobrar(d.register, orderB, d.cardPaymentData(turnoB, 10_000), d.hubB)
    const b = d.contar(d.register, turnoB, 0, [res('card', 9_500)], d.hubB)
    expect(reason(d.close(d.register, turnoB, b.cashCount, 0, 0, { hub: d.hubB }))).toBe(
      'missing_justification',
    )
  })
})

describe('con la red simulada: la caja cierra con tarjeta y Nequi sin conexión', () => {
  /** La caja cobra, cuenta con los reportes y cierra, todo guardado en el dispositivo. */
  async function cajaCierra(
    register: Nodo,
    m: Montaje,
    options: { reportadoTarjeta?: number } = {},
  ) {
    const shift = newId()
    const order = newId()
    const cashCount = newId()
    const turnoCaja = { aggregate_type: 'register_shift' } as never
    const payment = (method: 'card' | 'nequi', amount: number, tip = 0) => ({
      payment_id: newId(),
      check_id: null,
      register_shift_id: shift,
      method,
      amount,
      tip,
      tendered: null,
      change: null,
      rounding_adjustment: 0,
      rounding: null,
      cardTerminal: null,
      charge_reference: null,
    })
    await register.crear(
      shift,
      'ShiftOpened',
      { register_id: register.dispositivoId, base: 10_000 },
      turnoCaja,
    )
    await register.crear(order, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 2 })
    await register.crear(order, 'ItemAdded', item(1_000_000))
    await register.crear(order, 'PaymentRecorded', payment('nequi', 30_000, 3_000))
    const reported = options.reportadoTarjeta ?? 33_000
    await register.crear(
      shift,
      'CashCountRecorded',
      {
        cash_count_id: cashCount,
        tally: [{ value: 10_000, quantity: 1 }],
        counted_cash: 10_000,
        others: [{ method: 'nequi', custom_method_id: null, reported }],
      },
      turnoCaja,
    )
    await register.crear(
      shift,
      'ShiftClosed',
      {
        cash_count_id: cashCount,
        expected_cash: 10_000,
        counted_cash: 10_000,
        variance: 0,
        justification: reported === 33_000 ? null : 'No cuadró Nequi',
        other_methods: [
          {
            method: 'nequi',
            custom_method_id: null,
            expected: 33_000,
            reported,
            variance: reported - 33_000,
          },
        ],
      },
      turnoCaja,
    )
    expect(m).toBeDefined()
    return shift
  }
  const types = (m: Montaje) => eventosDe(m).map((x) => x.type)
  const SEIS = [
    'ShiftOpened',
    'OrderOpened',
    'ItemAdded',
    'PaymentRecorded',
    'CashCountRecorded',
    'ShiftClosed',
  ]

  it('todo sin conexión: al reconectar se confirman en orden y el turno queda cerrado', async () => {
    const m = montar()
    const register = m.network.device('register')
    await cajaCierra(register, m)
    expect(await register.cliente.pendingList()).toBe(6)
    await m.network.conectarTodos()
    expect(types(m)).toEqual(SEIS)
    expect(m.hub().turnoAbierto(register.dispositivoId)).toBeNull()
    expect(await register.cliente.pendingList()).toBe(0)
  })

  it('un lote duplicado por la red no repite el cierre', async () => {
    const m = montar()
    const register = m.network.device('register')
    await m.network.conectarTodos()
    register.rule('to_hub', 'push', 'duplicate', 6)
    await cajaCierra(register, m)
    await m.network.settle()
    expect(types(m)).toEqual(SEIS)
  })

  it('el hub se apaga justo al guardar el cierre: el turno vuelve abierto y el cierre llega una sola vez', async () => {
    const m = montar()
    const register = m.network.device('register')
    await m.network.conectarTodos()
    if (m.almacen instanceof AlmacenQueSeCae) m.almacen.caerEn = 6
    await cajaCierra(register, m)
    await m.network.settle()
    await m.network.conectarTodos()
    await m.network.settle()
    expect(types(m).filter((x) => x === 'ShiftClosed')).toHaveLength(1)
    expect(m.hub().turnoAbierto(register.dispositivoId)).toBeNull()
  })

  it('el hub se apaga al guardar el conteo con los reportes: al volver, el arqueo y el cierre se completan', async () => {
    const m = montar()
    const register = m.network.device('register')
    await m.network.conectarTodos()
    if (m.almacen instanceof AlmacenQueSeCae) m.almacen.caerEn = 5
    await cajaCierra(register, m)
    await m.network.settle()
    await m.network.conectarTodos()
    await m.network.settle()
    expect(types(m)).toEqual(SEIS)
  })

  it('con el reloj de la caja 3 horas atrasado o un día adelantado el cierre se acepta igual', async () => {
    for (const desfase of [-3 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]) {
      const m = montar()
      const register = m.network.device('register')
      register.desfaseMs = desfase
      await m.network.conectarTodos()
      await cajaCierra(register, m)
      await m.network.settle()
      expect(types(m)).toEqual(SEIS)
      expect(m.hub().turnoAbierto(register.dispositivoId)).toBeNull()
    }
  })

  it('un cierre con un reporte distinto y justificación, offline, se acepta al reconectar', async () => {
    const m = montar()
    const register = m.network.device('register')
    await cajaCierra(register, m, { reportadoTarjeta: 20_000 })
    await m.network.conectarTodos()
    expect(types(m)).toEqual(SEIS)
  })
})
