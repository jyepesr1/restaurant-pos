import { newId } from '@pos/core'
import type { LocalEvent } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { openOrders as project, tableStatus } from './projection'
import { inOrder, itemData, local, opening } from './testing'

// Table status `check` (task 1.6): the pre-bill was requested or there is already a partial
// payment. It beats `in_kitchen` and `served`, and loses to `taking` and `ready`.

const KITCHEN = newId()
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

/** An order with one dish; `sent` fires it to the kitchen; `ready`/`served` set that status. */
function table(
  options: { sent?: boolean; ready?: boolean; served?: boolean } = {},
  more: (id: string) => LocalEvent[] = () => [],
) {
  const id = newId()
  const dish = itemData({ unit_price: 20_000 })
  const events: LocalEvent[] = [
    local('OrderOpened', id, { ...opening, table_id: newId() }),
    local('ItemAdded', id, dish),
  ]
  if (options.sent || options.ready || options.served)
    events.push(
      local('ItemsSent', id, {
        tickets: [{ ticket_id: newId(), station_id: KITCHEN, item_ids: [dish.item_id] }],
      }),
    )
  if (options.ready || options.served)
    events.push(local('ItemReady', id, { item_ids: [dish.item_id] }))
  if (options.served) events.push(local('ItemServed', id, { item_ids: [dish.item_id] }))
  events.push(...more(id))
  return tableStatus(project(inOrder(events)))
}

const preBill = (id: string) =>
  local('PreBillPrinted', id, { check_id: null, subtotal: 20_000, suggested_tip: 1_852 })

describe('tableStatus: check', () => {
  it('a table with no orders is free', () => {
    expect(tableStatus([])).toBe('free')
  })

  it('served and with the pre-bill requested: `check`', () => {
    expect(table({ served: true })).toBe('served')
    expect(table({ served: true }, (id) => [preBill(id)])).toBe('check')
  })

  it('with the pre-bill requested even if something is still in the kitchen: `check` beats `in_kitchen`', () => {
    expect(table({ sent: true })).toBe('in_kitchen')
    expect(table({ sent: true }, (id) => [preBill(id)])).toBe('check')
  })

  it('a partial payment leaves the table in `check` (without a pre-bill)', () => {
    expect(table({ served: true }, (id) => [local('PaymentRecorded', id, payment(5_000))])).toBe(
      'check',
    )
    expect(table({ sent: true }, (id) => [local('PaymentRecorded', id, payment(5_000))])).toBe(
      'check',
    )
  })

  it('a voided partial payment no longer counts', () => {
    const e = table({ served: true }, (id) => {
      const p = payment(5_000)
      return [
        local('PaymentRecorded', id, p),
        local('PaymentVoided', id, { payment_id: p.payment_id, register_shift_id: SHIFT }),
      ]
    })
    expect(e).toBe('served')
  })

  it('something ready to take out beats `check`', () => {
    expect(table({ ready: true }, (id) => [preBill(id)])).toBe('ready')
  })

  it('something unsent beats `check`: `taking`', () => {
    expect(table({ sent: true }, (id) => [preBill(id), local('ItemAdded', id, itemData())])).toBe(
      'taking',
    )
  })

  it('adding a product after requesting the pre-bill invalidates it: it returns to its status', () => {
    const e = table({ served: true }, (id) => [preBill(id), local('ItemAdded', id, itemData())])
    expect(e).toBe('taking')
  })

  it('with an order merged into the table (several orders), it is enough that one requests the check', () => {
    const a = newId()
    const b = newId()
    const tableId = newId()
    const pa = itemData()
    const pb = itemData()
    const base: LocalEvent[] = [
      local('OrderOpened', a, { ...opening, table_id: tableId }),
      local('ItemAdded', a, pa),
      local('OrderOpened', b, { ...opening, table_id: tableId }),
      local('ItemAdded', b, pb),
    ]
    const all = inOrder([
      ...base,
      local('ItemsSent', a, {
        tickets: [{ ticket_id: newId(), station_id: KITCHEN, item_ids: [pa.item_id] }],
      }),
      local('ItemsSent', b, {
        tickets: [{ ticket_id: newId(), station_id: KITCHEN, item_ids: [pb.item_id] }],
      }),
      preBill(a),
    ])
    expect(tableStatus(project(all))).toBe('check')
  })
})
