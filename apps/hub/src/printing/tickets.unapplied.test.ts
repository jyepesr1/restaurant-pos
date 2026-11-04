import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { setupPrinting } from './printing-setup'

// Events the hub saved without applying (`unapplied`, task 1.7b) change nothing in the order, so
// the kitchen has nothing to be told: no void ticket for a void that did not happen.

function kitchenWithOrder() {
  const t = setupPrinting()
  const printer = t.newPrinter('Cocina', [t.kitchen])
  const ana = t.device('waiter')
  const registerA = t.device('admin', 'register')
  const registerB = t.device('admin', 'register')
  const { order, items } = t.orderWith(
    ana,
    [{ name: 'Tagliata', station: t.kitchen, quantity: 2 }],
    t.table('12'),
  )
  t.send(ana, order, items)
  return { t, printer, registerA, registerB, order, items }
}

const voidOf = (itemId: string | undefined, quantity: number) => ({
  item_id: itemId,
  quantity,
  already_prepared: false,
  ticket_id: null,
})

describe('what the hub did not apply does not reach the kitchen', () => {
  it('a stale void of more units than are left is saved as not applied and prints no void ticket', async () => {
    const { t, printer, registerA, registerB, order, items } = kitchenWithOrder()
    await t.queue.runOnce()
    const stale = Number(t.db.prepare('SELECT max(sequence) AS s FROM events').get()?.s ?? 0)
    expect(registerA.submit(order, 'ItemVoided', voidOf(items[0]?.id, 1)).status).toBe('confirmed')
    await t.queue.runOnce()
    const printed = printer.paper.received.length
    const late = registerB.submit(order, 'ItemVoided', voidOf(items[0]?.id, 2), {
      base_sequence: stale,
    })
    expect(late.status).toBe('confirmed')
    expect(late.accepted?.unapplied).toBe(true)
    await t.queue.runOnce()
    expect(printer.paper.received).toHaveLength(printed)
  })

  it('a stale cancellation of an order already canceled is saved as not applied and prints no void tickets', async () => {
    const { t, printer, registerA, registerB, order } = kitchenWithOrder()
    await t.queue.runOnce()
    const stale = Number(t.db.prepare('SELECT max(sequence) AS s FROM events').get()?.s ?? 0)
    expect(
      registerA.submit(order, 'OrderCanceled', {}, { reason: 'Error del mesero' }).status,
    ).toBe('confirmed')
    await t.queue.runOnce()
    const printed = printer.paper.received.length
    const late = registerB.submit(
      order,
      'OrderCanceled',
      {},
      { reason: 'Error del mesero', base_sequence: stale },
    )
    expect(late.accepted?.unapplied).toBe(true)
    await t.queue.runOnce()
    expect(printer.paper.received).toHaveLength(printed)
  })

  it('a second send of dishes already sent is saved as not applied (what the kitchen screen must leave out) and prints nothing', async () => {
    const { t, printer, registerB, order, items } = kitchenWithOrder()
    await t.queue.runOnce()
    const printed = printer.paper.received.length
    const late = registerB.submit(
      order,
      'ItemsSent',
      {
        tickets: [{ ticket_id: newId(), station_id: t.kitchen, item_ids: items.map((i) => i.id) }],
      },
      { base_sequence: 0 },
    )
    expect(late.status).toBe('confirmed')
    expect(late.result).toMatchObject({ conflict: 'item_already_sent' })
    expect(late.accepted?.unapplied).toBe(true)
    await t.queue.runOnce()
    expect(printer.paper.received).toHaveLength(printed)
  })
})
