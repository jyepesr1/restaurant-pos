import { newId } from '@pos/core'
import type { EventoLocal } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { estadoMesa, pedidosAbiertos as proyectar } from './proyeccion'
import { datosItem, inOrder, local, opening } from './pruebas'

// Estado de mesa «cuenta» (tarea 1.6): se pidió la precuenta o ya hay un pago parcial. Gana a
// «en cocina» y «servida», y pierde ante «tomando» y «listo».

const COCINA = newId()
const SHIFT = newId()
const payment = (amount: number) => ({
  payment_id: newId(),
  check_id: null,
  register_shift_id: SHIFT,
  method: 'nequi' as const,
  amount,
  tip: 0,
  tendered: null,
  change: null,
  rounding_adjustment: 0,
  rounding: null,
  cardTerminal: null,
  charge_reference: null,
})

/** Un pedido con un plato; `enviado` lo manda a cocina; `estadoItem` lo lleva al estado pedido. */
function table(
  options: { sent?: boolean; ready?: boolean; served?: boolean } = {},
  more: (id: string) => EventoLocal[] = () => [],
) {
  const id = newId()
  const dish = datosItem({ unit_price: 20_000 })
  const events: EventoLocal[] = [
    local('OrderOpened', id, { ...opening, table_id: newId() }),
    local('ItemAdded', id, dish),
  ]
  if (options.sent || options.ready || options.served)
    events.push(
      local('ItemsSent', id, {
        tickets: [{ ticket_id: newId(), station_id: COCINA, item_ids: [dish.item_id] }],
      }),
    )
  if (options.ready || options.served)
    events.push(local('ItemReady', id, { item_ids: [dish.item_id] }))
  if (options.served) events.push(local('ItemServed', id, { item_ids: [dish.item_id] }))
  events.push(...more(id))
  return estadoMesa(proyectar(inOrder(events)))
}

const preBill = (id: string) =>
  local('PreBillPrinted', id, { check_id: null, subtotal: 20_000, suggested_tip: 1_852 })

describe('estadoMesa: cuenta', () => {
  it('una mesa sin pedidos es libre', () => {
    expect(estadoMesa([])).toBe('free')
  })

  it('servida y con la precuenta pedida: «cuenta»', () => {
    expect(table({ served: true })).toBe('served')
    expect(table({ served: true }, (id) => [preBill(id)])).toBe('check')
  })

  it('con la precuenta pedida aunque aún haya algo en cocina: «cuenta» gana a «en cocina»', () => {
    expect(table({ sent: true })).toBe('in_kitchen')
    expect(table({ sent: true }, (id) => [preBill(id)])).toBe('check')
  })

  it('un pago parcial deja la mesa en «cuenta» (sin precuenta)', () => {
    expect(table({ served: true }, (id) => [local('PaymentRecorded', id, payment(5_000))])).toBe(
      'check',
    )
    expect(table({ sent: true }, (id) => [local('PaymentRecorded', id, payment(5_000))])).toBe(
      'check',
    )
  })

  it('un pago parcial anulado ya no cuenta', () => {
    const e = table({ served: true }, (id) => {
      const p = payment(5_000)
      return [
        local('PaymentRecorded', id, p),
        local('PaymentVoided', id, { payment_id: p.payment_id, register_shift_id: SHIFT }),
      ]
    })
    expect(e).toBe('served')
  })

  it('algo listo para llevar gana a «cuenta»', () => {
    expect(table({ ready: true }, (id) => [preBill(id)])).toBe('ready')
  })

  it('algo sin enviar gana a «cuenta»: «tomando»', () => {
    expect(table({ sent: true }, (id) => [preBill(id), local('ItemAdded', id, datosItem())])).toBe(
      'taking',
    )
  })

  it('agregar un producto después de pedir la precuenta la invalida: vuelve a su estado', () => {
    const e = table({ served: true }, (id) => [preBill(id), local('ItemAdded', id, datosItem())])
    expect(e).toBe('taking')
  })

  it('con un pedido unido a la mesa (varios pedidos), basta que uno pida la cuenta', () => {
    const a = newId()
    const b = newId()
    const tableId = newId()
    const pa = datosItem()
    const pb = datosItem()
    const base: EventoLocal[] = [
      local('OrderOpened', a, { ...opening, table_id: tableId }),
      local('ItemAdded', a, pa),
      local('OrderOpened', b, { ...opening, table_id: tableId }),
      local('ItemAdded', b, pb),
    ]
    const all = inOrder([
      ...base,
      local('ItemsSent', a, {
        tickets: [{ ticket_id: newId(), station_id: COCINA, item_ids: [pa.item_id] }],
      }),
      local('ItemsSent', b, {
        tickets: [{ ticket_id: newId(), station_id: COCINA, item_ids: [pb.item_id] }],
      }),
      preBill(a),
    ])
    expect(estadoMesa(proyectar(all))).toBe('check')
  })
})
