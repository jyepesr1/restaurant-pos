import { newId, type OrderEvent, report } from '@pos/core'
import { describe, expect, it } from 'vitest'
import {
  cardPaymentData,
  cashPaymentData,
  event,
  itemCopy,
  SHIFT,
  WAITER,
} from '../../core/src/testing/factory'
import { AlmacenMemoria } from './hub/almacen'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { cierreDeTurno, cuadreGuardado, datosDeInforme } from './hub/informe'
import { cargar, numerar } from './pruebas/historias'
import { baseSqlite } from './pruebas/montaje'

// El período de los reportes (docs/KPIS.md#período) con casos armados a mano, en los dos almacenes.
// Cada día es un día operativo: el 23 es «ayer», el 24 «hoy», el 25 «mañana».

const CONFIG = { sales_by_waiter: 'added_by', rounding_mode: 'half_up' } as const
const D23 = '2026-10-23'
const D24 = '2026-10-24'
const D25 = '2026-10-25'
const D26 = '2026-10-26'

const aplicarEnAmbos = (events: OrderEvent[]) => {
  const memory = new AlmacenMemoria()
  const { db, restauranteId } = baseSqlite()
  const sqlite = new AlmacenSqlite(db, restauranteId)
  const list = numerar(events)
  cargar(memory, list)
  cargar(sqlite, list)
  return [memory, sqlite] as const
}

const open = (id: string) =>
  event(id, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 })

/** Un pedido de `precio` pagado en efectivo y cerrado el `dia`. */
function pedidoCobrado(price: number, day: string, pagoDia = day) {
  const id = newId()
  const item = itemCopy({ unit_price: price })
  const payment = cashPaymentData(price)
  return {
    id,
    item,
    payment,
    events: [
      open(id),
      event(id, 'ItemAdded', item),
      event(id, 'PaymentRecorded', payment, { business_day: pagoDia }),
      event(id, 'OrderClosed', {}, { business_day: day }),
    ] as OrderEvent[],
  }
}
const reabrir = (id: string) => event(id, 'OrderReopened', {}, { reason: 'Se olvidó algo' })

const ventasDe = (a: AlmacenMemoria | AlmacenSqlite, from: string, until = from) =>
  report({ ...datosDeInforme(a, from, until), config: CONFIG })

const send = (id: string, itemId: string) =>
  event(id, 'ItemsSent', {
    tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [itemId] }],
  })

describe('período: pedidos reabiertos (lo ya reportado de un día no cambia)', () => {
  /** Cerrada el 24 con $30.000; reabierta, agrega $10.000 y se cierra otra vez el 25. */
  function conAdicion() {
    const x = pedidoCobrado(30_000, D24)
    const extra = itemCopy({ unit_price: 10_000, name: 'Postre' })
    const pagoExtra = cashPaymentData(10_000)
    const events = [
      ...x.events,
      reabrir(x.id),
      event(x.id, 'ItemAdded', extra),
      event(x.id, 'PaymentRecorded', pagoExtra, { business_day: D25 }),
      event(x.id, 'OrderClosed', {}, { business_day: D25 }),
    ]
    return { x, extra, events }
  }

  it('cerrada el 24 y vuelta a cerrar el 25: el 25 suma solo la diferencia', () => {
    const { events } = conAdicion()
    for (const a of aplicarEnAmbos(events)) {
      expect(ventasDe(a, D24).sales).toMatchObject({
        net: 30_000,
        gross: 30_000,
        checks: 1,
        guests: 2,
      })
      // El 25 suma lo nuevo, pero no es otra cuenta ni otros comensales.
      expect(ventasDe(a, D25).sales).toMatchObject({
        net: 10_000,
        gross: 10_000,
        checks: 0,
        guests: 0,
      })
      expect(ventasDe(a, D25).byProduct).toEqual([
        expect.objectContaining({ name: 'Postre', units: 1, net: 10_000 }),
      ])
      expect(ventasDe(a, D23).sales.net).toBe(0)
      expect(ventasDe(a, D26).sales.net).toBe(0)
      // Los dos días juntos son el pedido final, una sola cuenta.
      expect(ventasDe(a, D24, D25).sales).toMatchObject({
        net: 40_000,
        checks: 1,
        guests: 2,
      })
    }
  })

  it('cerrada, reabierta y cerrada de nuevo sin cambios: el segundo cierre suma cero', () => {
    const x = pedidoCobrado(12_000, D24)
    const events = [
      ...x.events,
      reabrir(x.id),
      event(x.id, 'OrderClosed', {}, { business_day: D25 }),
    ]
    for (const a of aplicarEnAmbos(events)) {
      expect(ventasDe(a, D24).sales.net).toBe(12_000)
      expect(ventasDe(a, D25).sales).toMatchObject({
        net: 0,
        gross: 0,
        checks: 0,
        guests: 0,
      })
      expect(ventasDe(a, D25).byProduct).toEqual([])
      expect(datosDeInforme(a, D25, D25).closings).toHaveLength(1)
    }
  })

  it('reabierta y todavía abierta sigue contando el día de su cierre anterior, con lo que tenía', () => {
    const x = pedidoCobrado(30_000, D24)
    const extra = itemCopy({ unit_price: 5_000 })
    // Se reabre el 25 y se le agrega algo que aún no se paga ni se cierra.
    const events = [...x.events, reabrir(x.id), event(x.id, 'ItemAdded', extra)]
    for (const a of aplicarEnAmbos(events)) {
      expect(ventasDe(a, D24).sales).toMatchObject({ net: 30_000, checks: 1 })
      expect(ventasDe(a, D25).sales).toMatchObject({ net: 0, checks: 0 })
      expect(ventasDe(a, D23, D26).sales.net).toBe(30_000)
    }
  })

  it('al reabrir se anula un producto y se reembolsa: el segundo día resta, y nada del primero cambia', () => {
    const id = newId()
    const item = itemCopy({ unit_price: 20_000, quantity: 2, name: 'Cerveza' })
    const payment = cashPaymentData(40_000)
    const events = [
      open(id),
      event(id, 'ItemAdded', item),
      send(id, item.item_id),
      event(id, 'PaymentRecorded', payment, { business_day: D24 }),
      event(id, 'OrderClosed', {}, { business_day: D24 }),
      reabrir(id),
      event(
        id,
        'RefundRecorded',
        {
          payment_id: payment.payment_id,
          refund_id: newId(),
          sale_amount: 20_000,
          tip_amount: 0,
          method: 'cash',
          register_shift_id: SHIFT,
        },
        { reason: 'Error', business_day: D25 },
      ),
      event(
        id,
        'ItemVoided',
        { item_id: item.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        { reason: 'Error', business_day: D25 },
      ),
      event(id, 'OrderClosed', {}, { business_day: D25 }),
    ]
    for (const a of aplicarEnAmbos(events)) {
      expect(ventasDe(a, D24).sales).toMatchObject({ net: 40_000, gross: 40_000, voided: 0 })
      const d25 = ventasDe(a, D25)
      expect(d25.sales).toMatchObject({ net: -20_000, gross: 0, voided: 20_000, checks: 0 })
      expect(d25.byProduct).toEqual([expect.objectContaining({ units: -1, net: -20_000 })])
      expect(d25.byMethod).toEqual([expect.objectContaining({ method: 'cash', sale: -20_000 })])
      expect(ventasDe(a, D24, D25).sales.net).toBe(20_000)
    }
  })

  it('un descuento quitado al reabrir sale en el segundo cierre con monto negativo', () => {
    const id = newId()
    const item = itemCopy({ unit_price: 10_000 })
    const discount = newId()
    const events = [
      open(id),
      event(id, 'ItemAdded', item),
      event(
        id,
        'DiscountApplied',
        {
          discount_id: discount,
          scope: 'item',
          rule: 'value',
          value: 2_000,
          unit_count: null,
          amounts: [{ item_id: item.item_id, amount: 2_000 }],
        },
        { reason: 'Cliente frecuente' },
      ),
      event(id, 'PaymentRecorded', cashPaymentData(8_000)),
      event(id, 'OrderClosed', {}, { business_day: D24 }),
      reabrir(id),
      event(id, 'DiscountRemoved', { discount_id: discount }, { reason: 'Se canceló' }),
      event(id, 'PaymentRecorded', cashPaymentData(2_000), { business_day: D25 }),
      event(id, 'OrderClosed', {}, { business_day: D25 }),
    ]
    for (const a of aplicarEnAmbos(events)) {
      expect(ventasDe(a, D24).discounts).toEqual([expect.objectContaining({ amount: 2_000 })])
      expect(ventasDe(a, D24).sales).toMatchObject({ net: 8_000, discounts: 2_000 })
      expect(ventasDe(a, D25).discounts).toEqual([expect.objectContaining({ amount: -2_000 })])
      expect(ventasDe(a, D25).sales).toMatchObject({ net: 2_000, discounts: -2_000 })
    }
  })

  it('reabierta, con el pago anulado y cancelada: el día 24 no cambia y la cancelación cuenta el 25', () => {
    const x = pedidoCobrado(20_000, D24)
    const anulaPago = event(
      x.id,
      'PaymentVoided',
      { payment_id: x.payment.payment_id, register_shift_id: SHIFT },
      { reason: 'm', business_day: D25 },
    )
    const events = [
      ...x.events,
      reabrir(x.id),
      anulaPago,
      event(x.id, 'OrderCanceled', {}, { reason: 'Se fueron', business_day: D25 }),
    ]
    for (const a of aplicarEnAmbos(events)) {
      expect(ventasDe(a, D24).sales).toMatchObject({ net: 20_000, checks: 1 })
      const r = ventasDe(a, D25)
      expect(r.sales.net).toBe(0)
      expect(r.byMethod).toEqual([expect.objectContaining({ sale: -20_000 })])
      expect(r.cancellations).toEqual([
        expect.objectContaining({ orderId: x.id, reason: 'Se fueron' }),
      ])
    }
  })

  it('cada cierre trae el pedido al cerrar y como estaba en el anterior (null el primero)', () => {
    const { x, events } = conAdicion()
    for (const a of aplicarEnAmbos(events)) {
      const [firstOne] = datosDeInforme(a, D24, D24).closings
      expect(firstOne?.before).toBeNull()
      expect(firstOne?.after.id).toBe(x.id)
      const [secondOne] = datosDeInforme(a, D25, D25).closings
      expect(Object.keys(secondOne?.before?.items ?? {})).toHaveLength(1)
      expect(Object.keys(secondOne?.after.items ?? {})).toHaveLength(2)
      // Un período que abarca los dos trae los dos, en orden.
      expect(datosDeInforme(a, D24, D25).closings.map((c) => c.before === null)).toEqual([
        true,
        false,
      ])
    }
  })

  it('el cierre del día 25 de una mesa nueva sí es una cuenta, aunque el 24 se haya cerrado otra', () => {
    const a1 = pedidoCobrado(10_000, D24)
    const b1 = pedidoCobrado(15_000, D25)
    for (const a of aplicarEnAmbos([...a1.events, ...b1.events])) {
      expect(ventasDe(a, D24).sales.checks).toBe(1)
      expect(ventasDe(a, D25).sales).toMatchObject({ checks: 1, net: 15_000 })
    }
  })
})

describe('período: pagos, anulaciones y reembolsos', () => {
  it('una anulación de hoy de un pago de ayer resta hoy y no ayer, con el medio del pago original', () => {
    const id = newId()
    const item = itemCopy({ unit_price: 25_000 })
    const payment = cardPaymentData(25_000, { tip: 2_000 })
    const events = [
      open(id),
      event(id, 'ItemAdded', item),
      event(id, 'PaymentRecorded', payment, { business_day: D23 }),
      event(
        id,
        'PaymentVoided',
        { payment_id: payment.payment_id, register_shift_id: SHIFT },
        { reason: 'm', business_day: D24 },
      ),
    ]
    for (const a of aplicarEnAmbos(events)) {
      const today = report({ ...datosDeInforme(a, D24, D24), config: CONFIG })
      expect(today.byMethod).toEqual([
        { method: 'card', customMethodId: null, sale: -25_000, tip: -2_000, payments: -1 },
      ])
      const yesterday = report({ ...datosDeInforme(a, D23, D23), config: CONFIG })
      expect(yesterday.byMethod).toEqual([
        { method: 'card', customMethodId: null, sale: 25_000, tip: 2_000, payments: 1 },
      ])
      // Los dos días juntos se compensan: no queda nada.
      expect(report({ ...datosDeInforme(a, D23, D24), config: CONFIG }).byMethod).toEqual([])
      // Un día aparte no ve ni el pago ni la anulación.
      expect(datosDeInforme(a, D25, D25).events).toEqual([])
    }
  })

  it('un reembolso parcial de un pago de otro día resta ese día y su pago original no se cuenta dos veces', () => {
    const id = newId()
    const item = itemCopy({ unit_price: 40_000 })
    const payment = cashPaymentData(40_000, { tip: 4_000 })
    const events = [
      open(id),
      event(id, 'ItemAdded', item),
      event(id, 'PaymentRecorded', payment, { business_day: D23 }),
      event(
        id,
        'RefundRecorded',
        {
          payment_id: payment.payment_id,
          refund_id: newId(),
          sale_amount: 10_000,
          tip_amount: 1_000,
          method: 'cash',
          register_shift_id: SHIFT,
        },
        { reason: 'm', business_day: D25 },
      ),
    ]
    for (const a of aplicarEnAmbos(events)) {
      const d = datosDeInforme(a, D25, D25)
      expect(d.events.map((e) => e.type)).toEqual(['PaymentRecorded', 'RefundRecorded'])
      const r = report({ ...d, config: CONFIG })
      expect(r.byMethod).toEqual([
        { method: 'cash', customMethodId: null, sale: -10_000, tip: -1_000, payments: 0 },
      ])
      expect(r.tipPool.tips).toBe(-1_000)
    }
  })

  it('un pago de una mesa que cierra otro día cuenta por medio el día del pago y en ventas el del cierre', () => {
    const x = pedidoCobrado(50_000, D25, D24)
    for (const a of aplicarEnAmbos(x.events)) {
      const d24 = report({ ...datosDeInforme(a, D24, D24), config: CONFIG })
      const d25 = report({ ...datosDeInforme(a, D25, D25), config: CONFIG })
      expect(d24.sales.net).toBe(0)
      expect(d24.byMethod).toEqual([expect.objectContaining({ method: 'cash', sale: 50_000 })])
      expect(d25.sales.net).toBe(50_000)
      expect(d25.byMethod).toEqual([])
    }
  })

  it('un período sin eventos da un informe en ceros', () => {
    for (const a of aplicarEnAmbos([])) {
      const r = report({ ...datosDeInforme(a, D24, D24), config: CONFIG })
      expect(r.sales).toMatchObject({ net: 0, checks: 0, averageTicket: 0 })
      expect(r.byMethod).toEqual([])
      expect(datosDeInforme(a, D24, D24).cierresDeCaja).toEqual([])
    }
  })
})

describe('período: turnos que cruzan días', () => {
  /** Un turno abierto el 24 y cerrado el 25, con un pago de cada día y uno de ayer. */
  function shift() {
    const t = newId()
    const c = (type: string, data: unknown, day: string) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'register_shift',
      aggregate_id: t,
      related: [],
      data,
      session_id: null,
      user_id: WAITER,
      device_id: newId(),
      authorization_id: null,
      reason: null,
      device_time: '2026-10-24T20:00:00.000Z',
      hub_estimated_time: '2026-10-24T20:00:00.000Z',
      base_sequence: 0,
      received_at: '2026-10-24T20:00:00.000Z',
      business_day: day,
      assignments: {},
      affects: [],
      authorized_by_id: null,
      sequence: 0,
    })
    const cashCount = newId()
    const a = pedidoCobrado(10_000, D24)
    const b = pedidoCobrado(20_000, D25)
    const pa = { ...a.payment, register_shift_id: t }
    const pb = { ...b.payment, register_shift_id: t }
    const events = [
      c('ShiftOpened', { register_id: newId(), base: 50_000 }, D24),
      event(a.id, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }),
      event(a.id, 'ItemAdded', a.item),
      event(a.id, 'PaymentRecorded', pa, { business_day: D24 }),
      event(a.id, 'OrderClosed', {}, { business_day: D24 }),
      event(b.id, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }),
      event(b.id, 'ItemAdded', b.item),
      event(b.id, 'PaymentRecorded', pb, { business_day: D25 }),
      event(b.id, 'OrderClosed', {}, { business_day: D25 }),
      c(
        'CashCountRecorded',
        { cash_count_id: cashCount, tally: [{ value: 1_000, quantity: 80 }], counted_cash: 80_000 },
        D25,
      ),
      c(
        'ShiftClosed',
        {
          cash_count_id: cashCount,
          expected_cash: 80_000,
          counted_cash: 80_000,
          variance: 0,
          justification: null,
          other_methods: [],
        },
        D25,
      ),
    ] as unknown as OrderEvent[]
    return { t, events }
  }

  it('el cierre se lista el día en que se cierra y conoce el día en que se abrió', () => {
    const { t, events } = shift()
    for (const a of aplicarEnAmbos(events)) {
      expect(datosDeInforme(a, D24, D24).cierresDeCaja).toEqual([])
      const [closeout] = datosDeInforme(a, D25, D25).cierresDeCaja
      expect(closeout).toMatchObject({ businessDay: D25, diaApertura: D24 })
      expect(closeout?.reconciliation.cash).toMatchObject({ charged: 30_000, expected: 80_000 })
      expect(cierreDeTurno(a, t)?.diaApertura).toBe(D24)
      expect(datosDeInforme(a, D24, D25).cierresDeCaja).toHaveLength(1)
    }
  })

  it('el cuadre cuenta los cobros de los dos días del turno', () => {
    const { t, events } = shift()
    for (const a of aplicarEnAmbos(events)) {
      expect(cuadreGuardado(a, t)?.cash.charged).toBe(30_000)
      expect(a.cobrosDeTurno(t, D24)).toHaveLength(2)
      // Cobros anteriores a la apertura no son de este turno.
      expect(a.cobrosDeTurno(t, D25)).toHaveLength(1)
      expect(a.cobrosDeTurno(t, D26)).toHaveLength(0)
    }
  })
})

describe('período: anulaciones de ítems que luego se unen o se mueven a otra mesa', () => {
  const voidItem = (id: string, itemId: string, quantity: number) =>
    event(
      id,
      'ItemVoided',
      { item_id: itemId, quantity, already_prepared: true, ticket_id: null },
      { reason: 'Se cayó' },
    )

  it('tras unir las mesas la anulación sigue con su producto y su valor, de punta a punta', () => {
    const source = newId()
    const target = newId()
    const item = itemCopy({ unit_price: 12_000, quantity: 3, name: 'Limonada' })
    const events = [
      open(source),
      open(target),
      event(source, 'ItemAdded', item),
      send(source, item.item_id),
      voidItem(source, item.item_id, 2),
      event(
        target,
        'OrdersMerged',
        {
          source_order_id: source,
          items: [{ item, status: 'sent', voided_quantity: 2, added_by: WAITER }],
        },
        { related: [source] },
      ),
    ]
    for (const a of aplicarEnAmbos(events)) {
      const r = report({ ...datosDeInforme(a, D24, D24), config: CONFIG })
      expect(r.voids).toEqual([
        expect.objectContaining({ name: 'Limonada', units: 2, value: 24_000 }),
      ])
    }
  })

  it('tras mover el ítem a otra mesa la anulación sigue con su producto y su valor', () => {
    const source = newId()
    const target = newId()
    const item = itemCopy({ unit_price: 9_000, quantity: 2, name: 'Cerveza' })
    const events = [
      open(source),
      open(target),
      event(source, 'ItemAdded', item),
      send(source, item.item_id),
      voidItem(source, item.item_id, 1),
      event(
        source,
        'ItemsMoved',
        {
          target_order_id: target,
          items: [{ item, status: 'sent', voided_quantity: 1, added_by: WAITER }],
        },
        { related: [target] },
      ),
    ]
    for (const a of aplicarEnAmbos(events)) {
      const r = report({ ...datosDeInforme(a, D24, D24), config: CONFIG })
      expect(r.voids).toEqual([
        expect.objectContaining({ name: 'Cerveza', units: 1, value: 9_000, orderId: source }),
      ])
    }
  })

  it('dos anulaciones del mismo ítem cada una con el precio que tenía, y una de un pedido ajeno no se mezcla', () => {
    const id = newId()
    const other = newId()
    const item = itemCopy({ unit_price: 5_000, quantity: 4 })
    const itemOtro = itemCopy({ unit_price: 7_000, quantity: 1, name: 'Otra cosa' })
    const events = [
      open(id),
      open(other),
      event(id, 'ItemAdded', item),
      event(other, 'ItemAdded', itemOtro),
      send(id, item.item_id),
      send(other, itemOtro.item_id),
      voidItem(id, item.item_id, 1),
      voidItem(other, itemOtro.item_id, 1),
      voidItem(id, item.item_id, 2),
    ]
    for (const a of aplicarEnAmbos(events)) {
      const r = report({ ...datosDeInforme(a, D24, D24), config: CONFIG })
      expect(r.voids.map((x) => [x.orderId === id, x.units, x.value])).toEqual([
        [true, 1, 5_000],
        [false, 1, 7_000],
        [true, 2, 10_000],
      ])
    }
  })
})
