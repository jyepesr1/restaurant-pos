import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { insertVersioned, SYSTEM } from '../access/records'
import { type Device, type PrintingSetup, setupPrinting } from './printing-setup'

// Task 1.5 in the kitchen (ADR-015): canceling an order prints «ANULAR» for what the kitchen
// had, and changing tables or moving products prints «CAMBIO DE MESA» with the new table and
// «Antes: …».

function withPrinters(t: PrintingSetup) {
  return {
    kitchen: t.newPrinter('Cocina', [t.kitchen]),
    bar: t.newPrinter('Barra', [t.bar]),
  }
}

const jobsOfType = (t: PrintingSetup, type: string) =>
  t.jobs().filter((f) => t.content(f).type === type)

/** The moved item as the device sends it, taken from the real order. */
function movedFrom(t: PrintingSetup, order: string, itemId: string) {
  const i = t.hub.order(order)?.items[itemId]
  if (!i) throw new Error('no item')
  return {
    item: {
      item_id: i.id,
      product_id: i.productId,
      variant_id: i.variantId,
      name: i.name,
      unit_price: i.unitPrice,
      tax_type: i.taxType,
      rate: i.rate,
      quantity: i.quantity,
      guest: i.guest,
      course: i.course,
      modifiers: i.modifiers.map((m) => ({
        modifier_id: m.modifierId,
        name: m.name,
        extra_price: m.extraPrice,
      })),
      notes: i.notes,
    },
    status: i.status,
    voided_quantity: i.voidedQuantity,
    added_by: i.addedBy,
  }
}

function move(t: PrintingSetup, e: Device, source: string, target: string, ids: string[]) {
  return e.submit(
    source,
    'ItemsMoved',
    { target_order_id: target, items: ids.map((id) => movedFrom(t, source, id)) },
    { related: [target] },
  )
}

const cancel = (register: Device, order: string) =>
  register.submit(order, 'OrderCanceled', {}, { reason: 'Error del mesero' })

describe('canceling the order', () => {
  it('what the kitchen had prints as ANULAR, one ticket per ticket it went out on, with its number', async () => {
    const t = setupPrinting()
    const printers = withPrinters(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const { order, items } = t.orderWith(
      ana,
      [
        { name: 'Tagliata', station: t.kitchen, quantity: 2 },
        { name: 'Aperol Spritz', station: t.bar },
      ],
      t.table('5'),
    )
    t.send(ana, order, items)
    await t.queue.runOnce()
    expect(cancel(register, order).status).toBe('confirmed')
    const voids = jobsOfType(t, 'void')
    expect(voids).toHaveLength(2)
    const byStation = Object.fromEntries(voids.map((f) => [t.content(f).station, t.content(f)]))
    expect(byStation.Cocina).toMatchObject({ target: 'Mesa 5', number: 1 })
    expect(byStation.Cocina.items).toMatchObject([{ name: 'Tagliata', quantity: 2 }])
    expect(byStation.Barra.items).toMatchObject([{ name: 'Aperol Spritz', quantity: 1 }])
    await t.queue.runOnce()
    expect(printers.kitchen.paper.texts().at(-1)).toContain('ANULAR')
  })

  it('only what is still in the kitchen is voided: not what was served or voided, and the remaining units', async () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const { order, items } = t.orderWith(
      ana,
      [
        { name: 'Tagliata', station: t.kitchen, quantity: 3 },
        { name: 'Risotto', station: t.kitchen },
        { name: 'Pizza', station: t.kitchen },
      ],
      t.table('5'),
    )
    t.send(ana, order, items)
    const [tagliata, risotto, pizza] = items
    ana.submit(order, 'ItemServed', { item_ids: [risotto?.id] })
    register.submit(order, 'ItemVoided', {
      item_id: tagliata?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    register.submit(order, 'ItemVoided', {
      item_id: pizza?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    const before = jobsOfType(t, 'void').length
    cancel(register, order)
    const newJobs = jobsOfType(t, 'void').slice(before)
    expect(newJobs).toHaveLength(1)
    expect(t.content(newJobs[0]).items).toMatchObject([{ name: 'Tagliata', quantity: 2 }])
  })

  it('with nothing in the kitchen (only pending, served or an empty order) prints nothing', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const empty = t.open(ana, t.table('1'))
    const pendingList = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('2'))
    const served = t.orderWith(ana, [{ name: 'Risotto', station: t.kitchen }], t.table('3'))
    t.send(ana, served.order, served.items)
    ana.submit(served.order, 'ItemServed', { item_ids: [served.items[0]?.id] })
    const doneCount = t.jobs().length
    expect(cancel(register, empty).status).toBe('confirmed')
    expect(cancel(register, pendingList.order).status).toBe('confirmed')
    expect(cancel(register, served.order).status).toBe('confirmed')
    expect(t.jobs()).toHaveLength(doneCount)
    expect(t.saveFailures).toEqual([])
  })

  it('a dish that is already ready is still voided; a rejected cancellation does not print', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    ana.submit(order, 'ItemReady', { item_ids: [items[0]?.id] })
    // The waiter cannot cancel: it is rejected and there is no ticket.
    expect(ana.submit(order, 'OrderCanceled', {}, { reason: 'x' }).status).toBe('rejected')
    expect(jobsOfType(t, 'void')).toHaveLength(0)
    cancel(register, order)
    expect(jobsOfType(t, 'void')).toHaveLength(1)
  })

  it('carries "Mesa 5 + 6" when the order had merged tables', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const [m5, m6] = [t.table('5'), t.table('6')]
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], m5)
    ana.submit(order, 'TablesMerged', { table_ids: [m6] })
    t.send(ana, order, items)
    cancel(register, order)
    expect(t.content(jobsOfType(t, 'void')[0]).target).toBe('Mesa 5 + 6')
  })
})

describe('changing tables (transfer)', () => {
  it('with dishes in the kitchen, each station receives CAMBIO DE MESA with the new table and «Antes: Mesa 5»', async () => {
    const t = setupPrinting()
    const printers = withPrinters(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(
      ana,
      [
        { name: 'Tagliata', station: t.kitchen },
        { name: 'Aperol Spritz', station: t.bar },
      ],
      t.table('5'),
    )
    t.send(ana, order, items)
    await t.queue.runOnce()
    const m6 = t.table('6')
    expect(ana.submit(order, 'OrderMovedTable', { target_table_id: m6 }).status).toBe('confirmed')
    const moves = jobsOfType(t, 'move')
    expect(moves).toHaveLength(2)
    for (const f of moves)
      expect(t.content(f)).toMatchObject({ target: 'Mesa 6', before: 'Mesa 5' })
    await t.queue.runOnce()
    const text = printers.kitchen.paper.texts().at(-1) as string
    expect(text).toContain('CAMBIO DE MESA')
    expect(text).toContain('Antes: Mesa 5')
    expect(text).toMatch(/Mesa 6 +#1/)
    expect(text).toContain('1 x Tagliata')
  })

  it("keeps the original ticket's number and does not carry the order note", () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(
      ana,
      [{ name: 'Tagliata', station: t.kitchen }],
      t.table('5'),
    )
    ana.submit(order, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    t.send(ana, order, items)
    ana.submit(order, 'OrderMovedTable', { target_table_id: t.table('6') })
    const c = t.content(jobsOfType(t, 'move')[0])
    expect(c.number).toBe(1)
    expect(c.orderNote ?? null).toBeNull()
  })

  it('nothing in the kitchen, nothing to announce: pending, served and unsent orders do not print', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const a = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('1'))
    const b = t.orderWith(ana, [{ name: 'Risotto', station: t.kitchen }], t.table('2'))
    t.send(ana, b.order, b.items)
    ana.submit(b.order, 'ItemServed', { item_ids: [b.items[0]?.id] })
    expect(ana.submit(a.order, 'OrderMovedTable', { target_table_id: t.table('8') }).status).toBe(
      'confirmed',
    )
    expect(ana.submit(b.order, 'OrderMovedTable', { target_table_id: t.table('9') }).status).toBe(
      'confirmed',
    )
    expect(jobsOfType(t, 'move')).toHaveLength(0)
  })

  it('moving to the same table does not print', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const m5 = t.table('5')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], m5)
    t.send(ana, order, items)
    ana.submit(order, 'OrderMovedTable', { target_table_id: m5 })
    expect(jobsOfType(t, 'move')).toHaveLength(0)
  })

  it('with merged tables: «Antes: Mesa 5 + 6» and the new one keeps its group', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const [m5, m6, m7] = [t.table('5'), t.table('6'), t.table('7')]
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], m5)
    ana.submit(order, 'TablesMerged', { table_ids: [m6] })
    t.send(ana, order, items)
    ana.submit(order, 'OrderMovedTable', { target_table_id: m7 })
    expect(t.content(jobsOfType(t, 'move')[0])).toMatchObject({
      before: 'Mesa 5 + 6',
      target: 'Mesa 7 + 6',
    })
  })

  it('moving to one of its merged tables: the new one is only that one', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const [m5, m6] = [t.table('5'), t.table('6')]
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], m5)
    ana.submit(order, 'TablesMerged', { table_ids: [m6] })
    t.send(ana, order, items)
    ana.submit(order, 'OrderMovedTable', { target_table_id: m6 })
    expect(t.content(jobsOfType(t, 'move')[0])).toMatchObject({
      before: 'Mesa 5 + 6',
      target: 'Mesa 6',
    })
  })

  it('merging or separating tables without changing the main one does not notify the kitchen', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const [m5, m6] = [t.table('5'), t.table('6')]
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], m5)
    t.send(ana, order, items)
    const before = t.jobs().length
    ana.submit(order, 'TablesMerged', { table_ids: [m6] })
    ana.submit(order, 'TablesSeparated', { table_ids: [m6] })
    expect(t.jobs()).toHaveLength(before)
  })

  it('a bar order that moves to a table says «Antes: Barra»', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], null, 'bar')
    t.send(ana, order, items)
    ana.submit(order, 'OrderMovedTable', { target_table_id: t.table('4') })
    expect(t.content(jobsOfType(t, 'move')[0])).toMatchObject({
      before: 'Barra',
      target: 'Mesa 4',
    })
  })
})

describe('moving products (transfer)', () => {
  function sourceWithTwoStations() {
    const t = setupPrinting()
    const printers = withPrinters(t)
    const ana = t.device('waiter')
    const m5 = t.table('5')
    const { order, items } = t.orderWith(
      ana,
      [
        { name: 'Tagliata', station: t.kitchen },
        { name: 'Risotto', station: t.kitchen },
        { name: 'Aperol Spritz', station: t.bar },
      ],
      m5,
    )
    t.send(ana, order, items)
    return { t, printers, ana, order, items, m5 }
  }

  it('to a free table (new order): only what was moved prints, with the destination and «Antes: Mesa 5»', async () => {
    const { t, printers, ana, order, items } = sourceWithTwoStations()
    const target = newId()
    ana.submit(target, 'OrderOpened', { channel: 'dine_in', table_id: t.table('8'), guests: 1 })
    expect(move(t, ana, order, target, [items[1]?.id as string]).status).toBe('confirmed')
    const moves = jobsOfType(t, 'move')
    expect(moves).toHaveLength(1)
    expect(t.content(moves[0])).toMatchObject({
      station: 'Cocina',
      target: 'Mesa 8',
      before: 'Mesa 5',
      number: 1,
    })
    expect(t.content(moves[0]).items).toMatchObject([{ name: 'Risotto' }])
    await t.queue.runOnce()
    expect(printers.kitchen.paper.texts().at(-1)).toContain('Antes: Mesa 5')
  })

  it("to an existing order with products: the destination is that order's table", () => {
    const { t, ana, order, items } = sourceWithTwoStations()
    const other = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('9'))
    move(t, ana, order, other.order, [items[0]?.id as string])
    expect(t.content(jobsOfType(t, 'move')[0])).toMatchObject({
      target: 'Mesa 9',
      before: 'Mesa 5',
    })
    expect(t.content(jobsOfType(t, 'move')[0]).items).toMatchObject([{ name: 'Tagliata' }])
  })

  it('a destination with merged tables is announced as «Mesa 8 + 9»', () => {
    const { t, ana, order, items } = sourceWithTwoStations()
    const [m8, m9] = [t.table('8'), t.table('9')]
    const other = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], m8)
    ana.submit(other.order, 'TablesMerged', { table_ids: [m9] })
    move(t, ana, order, other.order, [items[0]?.id as string])
    expect(t.content(jobsOfType(t, 'move')[0]).target).toBe('Mesa 8 + 9')
  })

  it('dishes from two stations: one transfer ticket per ticket they went out on', () => {
    const { t, ana, order, items } = sourceWithTwoStations()
    const target = newId()
    ana.submit(target, 'OrderOpened', { channel: 'dine_in', table_id: t.table('8'), guests: 1 })
    move(
      t,
      ana,
      order,
      target,
      items.map((i) => i.id),
    )
    const byStation = Object.fromEntries(
      jobsOfType(t, 'move').map((f) => [t.content(f).station, t.content(f).items.length]),
    )
    expect(byStation).toEqual({ Cocina: 2, Barra: 1 })
  })

  it('pending or served items that are moved do not notify the kitchen; the rest do', () => {
    const { t, ana, order, items } = sourceWithTwoStations()
    const pending = t.add(ana, order, { name: 'Pan', station: t.kitchen })
    ana.submit(order, 'ItemServed', { item_ids: [items[1]?.id] })
    const target = newId()
    ana.submit(target, 'OrderOpened', { channel: 'dine_in', table_id: t.table('8'), guests: 1 })
    move(t, ana, order, target, [pending.id, items[1]?.id as string])
    expect(jobsOfType(t, 'move')).toHaveLength(0)
    move(t, ana, order, target, [items[0]?.id as string])
    expect(jobsOfType(t, 'move')).toHaveLength(1)
  })

  it('moving it again still finds the ticket from its original send', () => {
    const { t, ana, order, items } = sourceWithTwoStations()
    const [one, two] = [newId(), newId()]
    ana.submit(one, 'OrderOpened', { channel: 'dine_in', table_id: t.table('8'), guests: 1 })
    ana.submit(two, 'OrderOpened', { channel: 'dine_in', table_id: t.table('9'), guests: 1 })
    move(t, ana, order, one, [items[0]?.id as string])
    move(t, ana, one, two, [items[0]?.id as string])
    const moves = jobsOfType(t, 'move')
    expect(moves).toHaveLength(2)
    expect(t.content(moves[1])).toMatchObject({
      target: 'Mesa 9',
      before: 'Mesa 8',
      number: 1,
    })
  })

  it('a rejected move does not print', () => {
    const { t, ana, order, items } = sourceWithTwoStations()
    const target = newId() // does not exist
    const r = move(t, ana, order, target, [items[0]?.id as string])
    expect(r.status).toBe('rejected')
    expect(jobsOfType(t, 'move')).toHaveLength(0)
  })
})

describe('reprinting the ticket of dishes that were moved', () => {
  it('TicketReprinted on the destination order finds the source ticket', async () => {
    const t = setupPrinting()
    const printers = withPrinters(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(
      ana,
      [{ name: 'Tagliata', station: t.kitchen }],
      t.table('5'),
    )
    const sent = t.send(ana, order, items)
    const target = newId()
    ana.submit(target, 'OrderOpened', { channel: 'dine_in', table_id: t.table('8'), guests: 1 })
    move(t, ana, order, target, [items[0]?.id as string])
    await t.queue.runOnce()
    const ticketId = sent.tickets[0]?.ticket_id
    expect(ana.submit(target, 'TicketReprinted', { ticket_id: ticketId }).status).toBe('confirmed')
    const reprints = jobsOfType(t, 'reprint')
    expect(reprints).toHaveLength(1)
    expect(t.content(reprints[0])).toMatchObject({ target: 'Mesa 8', number: 1 })
    expect(t.content(reprints[0]).items).toMatchObject([{ name: 'Tagliata' }])
    await t.queue.runOnce()
    expect(printers.kitchen.paper.texts().at(-1)).toContain('REIMPRESIÓN')
  })

  it('a ticket that does not exist in any order prints nothing', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const { order } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    ana.submit(order, 'TicketReprinted', { ticket_id: newId() })
    expect(jobsOfType(t, 'reprint')).toHaveLength(0)
  })
})

describe('several restaurants in the same database (tables)', () => {
  it("the table name is looked up in the event's restaurant: another restaurant's table is not printed", () => {
    const t = setupPrinting()
    withPrinters(t)
    const other = newId()
    t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(other, other, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z')
    const otherLocation = insertVersioned(
      t.db,
      'locations',
      other,
      { name: 'Sede', address: null, time_zone: 'America/Bogota' },
      SYSTEM,
      '2026-10-24T20:00:00.000Z',
    )
    const otherZone = insertVersioned(
      t.db,
      'zones',
      other,
      { location_id: otherLocation, name: 'Salón', position: 1, level: 1 },
      SYSTEM,
      '2026-10-24T20:00:00.000Z',
    )
    const otherWaitersTable = insertVersioned(
      t.db,
      'dining_tables',
      other,
      {
        zone_id: otherZone,
        name: 'AJENA',
        shape: 'square',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        capacity: 4,
      },
      SYSTEM,
      '2026-10-24T20:00:00.000Z',
    )
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('5'))
    t.send(ana, order, items)
    ana.submit(order, 'OrderMovedTable', { target_table_id: otherWaitersTable })
    const c = t.content(jobsOfType(t, 'move')[0])
    expect(c.target).toBe('Mesa')
    expect(JSON.stringify(c)).not.toContain('AJENA')
    expect(c.before).toBe('Mesa 5')
  })

  it('a cancellation from another restaurant does not create jobs in this one', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('5'))
    t.send(ana, order, items)
    cancel(register, order)
    const rows = t.db.prepare('SELECT DISTINCT restaurant_id AS r FROM print_jobs').all()
    expect(rows.map((f) => f.r)).toEqual([t.restaurantId])
  })
})
