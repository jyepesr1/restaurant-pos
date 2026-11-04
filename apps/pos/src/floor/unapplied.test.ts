import { type ApplicableEvent, newId, type OrderState, rebuild } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { pendingMoneyOf } from './checks'
import { inOrder, itemData, local, opening, testCatalog } from './testing'
import { needsNotice, UnappliedError, unappliedText } from './unapplied'

// What the device says about its own events the hub saved without applying (task 1.7b), and the
// money of the shift it still waits for before closing the register.

const SHIFT = newId()
const TABLE = newId()
const catalog = testCatalog({
  tables: [
    {
      id: TABLE,
      zone_id: newId(),
      name: '5',
      shape: 'square',
      capacity: 4,
      x: 0,
      y: 0,
      width: 80,
      height: 80,
      rotation: 0,
    },
  ] as never,
  restaurant: {
    name: 'Prueba',
    sessionIdleMin: 30,
    checkout: {
      paymentMethods: ['cash', 'card', 'nequi'],
      suggestedTip: 1000,
      roundingMode: 'half_up',
      cashRounding: 100,
      cashRoundingMode: 'nearest_half_down',
      printsPreBill: false,
      customMethods: [{ id: 'qr', name: 'QR Bancolombia' }],
    },
  } as never,
})

const payment = (amount: number, fields: Record<string, unknown> = {}) => ({
  payment_id: newId(),
  check_id: null,
  register_shift_id: SHIFT,
  method: 'cash' as const,
  amount,
  tip: 0,
  tendered: amount,
  change: 0,
  rounding_adjustment: 0,
  rounding: null,
  cardTerminal: null,
  charge_reference: null,
  ...fields,
})

/** A closed order at table 5 with a $40.000 cash payment ($4.000 of it tip). */
function closedOrder() {
  const id = newId()
  const pinsa = itemData({ name: 'Pinsa', unit_price: 36_000 })
  const paid = payment(36_000, { tip: 4_000, tendered: 40_000 })
  const events = inOrder([
    local('OrderOpened', id, { ...opening, table_id: TABLE }),
    local('ItemAdded', id, pinsa),
    local('PaymentRecorded', id, paid),
    local('OrderClosed', id, {}),
  ]).map((l) => l.event)
  return { id, pinsa, paid, order: rebuild(events, id) as OrderState }
}

const eventOf = (l: ReturnType<typeof local>) => l.event as ApplicableEvent

describe('unappliedText', () => {
  it('a payment: how much, how, where, why, and what to do with the money', () => {
    const { id, order } = closedOrder()
    const late = eventOf(
      local('PaymentRecorded', id, payment(10_000, { tip: 500, tendered: 10_500 })),
    )
    expect(unappliedText(late, { catalog, order, conflict: 'order_closed' })).toBe(
      'El pago de $10.500 en efectivo de la Mesa 5 no se aplicó: la cuenta ya estaba cerrada. Si ya recibiste ese dinero, devuélvelo al cliente. Si aún debe, reabre la cuenta y cobra otra vez.',
    )
    // A method of the restaurant goes by its name; without the conflict, the order says why.
    const qr = eventOf(
      local(
        'PaymentRecorded',
        id,
        payment(8_000, {
          method: 'other',
          custom_method_id: 'qr',
          tendered: null,
          change: null,
        }),
      ),
    )
    expect(unappliedText(qr, { catalog, order })).toContain(
      'El pago de $8.000 en QR Bancolombia de la Mesa 5 no se aplicó: la cuenta ya estaba cerrada.',
    )
  })

  it('a voided payment and a refund: not to hand over money, and to redo it after reopening', () => {
    const { id, order, paid } = closedOrder()
    const voided = eventOf(
      local('PaymentVoided', id, { payment_id: paid.payment_id, register_shift_id: SHIFT }),
    )
    expect(unappliedText(voided, { catalog, order })).toBe(
      'La anulación del pago de $40.000 en efectivo de la Mesa 5 no se aplicó: la cuenta ya estaba cerrada. Si el pago sí debía anularse, reabre la cuenta y anúlalo otra vez. Si no, no entregues dinero.',
    )
    // Without its payment here, it does not make up an amount.
    const unknown = eventOf(
      local('PaymentVoided', id, { payment_id: newId(), register_shift_id: SHIFT }),
    )
    expect(unappliedText(unknown, { catalog, order })).toMatch(/^La anulación de un pago de la/)
    const refund = eventOf(
      local('RefundRecorded', id, {
        payment_id: paid.payment_id,
        refund_id: newId(),
        sale_amount: 5_000,
        tip_amount: 1_000,
        method: 'cash',
        register_shift_id: SHIFT,
      }),
    )
    expect(unappliedText(refund, { catalog, order })).toBe(
      'La devolución de $6.000 en efectivo de la Mesa 5 no se aplicó: la cuenta ya estaba cerrada. Si ya entregaste ese dinero, explícalo al cerrar la caja. Si no lo has entregado, no lo entregues.',
    )
  })

  it('a product void says which product and why, by the hub’s conflict', () => {
    const { id, order, pinsa } = closedOrder()
    const voided = eventOf(
      local('ItemVoided', id, {
        item_id: pinsa.item_id,
        quantity: 1,
        already_prepared: false,
        ticket_id: null,
      }),
    )
    expect(unappliedText(voided, { catalog, order, conflict: 'item_already_voided' })).toBe(
      'La anulación de 1 Pinsa en la Mesa 5 no se aplicó: ya estaba anulado. No hay que hacer nada.',
    )
    expect(unappliedText(voided, { catalog, order, conflict: 'item_not_found' })).toContain(
      'ese producto ya no estaba en la cuenta',
    )
  })

  it('a product added to a closed order did not go to the kitchen', () => {
    const { id, order } = closedOrder()
    const added = eventOf(local('ItemAdded', id, itemData({ name: 'Limonada', quantity: 2 })))
    expect(unappliedText(added, { catalog, order, conflict: 'order_closed' })).toBe(
      '2 Limonada no se agregó a la Mesa 5: la cuenta ya estaba cerrada. Esa comida no fue a cocina. Reabre la cuenta y envíala otra vez.',
    )
  })

  it('a send to the kitchen: redo it if it did not go, nothing to do if it had already gone', () => {
    const { id, order, pinsa } = closedOrder()
    const sent = eventOf(
      local('ItemsSent', id, {
        tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [pinsa.item_id] }],
      } as never),
    )
    expect(unappliedText(sent, { catalog, order, conflict: 'order_closed' })).toBe(
      'Lo que enviaste a cocina desde la Mesa 5 no se aplicó: la cuenta ya estaba cerrada. Esa comida no fue a cocina. Reabre la cuenta y envíala otra vez.',
    )
    expect(unappliedText(sent, { catalog, order, conflict: 'item_already_sent' })).toBe(
      'Lo que enviaste a cocina desde la Mesa 5 no se envió otra vez: ya se había enviado a cocina. No hay que hacer nada.',
    )
  })

  it('without a table: the order by its channel and number; without the order, a fallback', () => {
    const id = newId()
    const events = inOrder([
      local('OrderOpened', id, { ...opening, channel: 'takeout' }),
      local('OrderClosed', id, {}),
    ]).map((l) => l.event)
    const order = rebuild(events, id)
    const canceled = eventOf(local('OrderCanceled', id, {}))
    expect(unappliedText(canceled, { catalog, order })).toBe(
      'La cancelación del pedido Para llevar #1 no se aplicó: la cuenta ya estaba cerrada.',
    )
    const preBill = eventOf(
      local('PreBillPrinted', id, { check_id: null, subtotal: 0, suggested_tip: 0 }),
    )
    expect(unappliedText(preBill, { catalog: null, order: null })).toBe(
      'Un cambio en el pedido no se aplicó: otro equipo cambió la cuenta antes. Revisa la cuenta.',
    )
  })

  it('closing an order that was already closed changes nothing worth a notice', () => {
    expect(needsNotice({ type: 'OrderClosed' })).toBe(false)
    expect(needsNotice({ type: 'PaymentRecorded' })).toBe(true)
    expect(new UnappliedError('x')).toBeInstanceOf(Error)
  })
})

describe('pendingMoneyOf', () => {
  it('counts this device’s pending payments, voids, refunds and movements of that shift only', () => {
    const order = newId()
    const other = newId()
    const pending = (l: ReturnType<typeof local>) => ({ ...l, status: 'pending' as const })
    const locals = [
      local('PaymentRecorded', order, payment(10_000), 'pending'),
      local('PaymentVoided', order, { payment_id: newId(), register_shift_id: SHIFT }, 'pending'),
      local(
        'RefundRecorded',
        order,
        {
          payment_id: newId(),
          refund_id: newId(),
          sale_amount: 1_000,
          tip_amount: 0,
          method: 'cash',
          register_shift_id: SHIFT,
        },
        'pending',
      ),
      pending(
        local('CashMovementRecorded', SHIFT, {
          movement_id: newId(),
          type: 'cash_in',
          amount: 5_000,
          description: 'Cambio',
          to_whom: null,
          days: [],
        }),
      ),
      // Not counted: confirmed, rejected, another shift, another device, not money.
      local('PaymentRecorded', order, payment(10_000)),
      local('PaymentRecorded', order, payment(10_000), 'rejected'),
      local('PaymentRecorded', order, payment(10_000, { register_shift_id: other }), 'pending'),
      { ...local('PaymentRecorded', order, payment(10_000), 'pending'), own: false },
      local('ItemAdded', order, itemData(), 'pending'),
    ]
    expect(pendingMoneyOf(locals, SHIFT)).toBe(4)
    expect(pendingMoneyOf(locals, other)).toBe(1)
    expect(pendingMoneyOf([], SHIFT)).toBe(0)
  })
})
