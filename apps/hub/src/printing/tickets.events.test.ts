import { newId } from '@pos/core'
import { readEscpos } from '@pos/printing'
import { describe, expect, it } from 'vitest'
import { insertVersioned, SYSTEM } from '../access/records'
import { type PrintingSetup, setupPrinting } from './printing-setup'
import { jobsForEvent } from './tickets'

// From an accepted event to the tickets in the queue (ADR-015): numbering, repeated items, the
// ticket types (new, reprint, void, change), held courses, stations without a printer, archived
// ones, a hook failure and several restaurants in the same database.

const TIME = /(\d{1,2}):(\d{2})\s*([ap])\.\s*m\./

/** One printer per station (kitchen, bar, desserts), each with its own paper. */
function withPrinters(t: PrintingSetup) {
  return {
    kitchen: t.newPrinter('Cocina', [t.kitchen]),
    bar: t.newPrinter('Barra', [t.bar]),
    desserts: t.newPrinter('Postres', [t.desserts]),
  }
}

describe('ticket numbering per business day', () => {
  it('several stations in one send: one number per ticket, consecutive, each with its own', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol Spritz', station: t.bar },
      { name: 'Tiramisú', station: t.desserts },
    ])
    const r = t.send(ana, order, items)
    expect(r.status).toBe('confirmed')
    const numbers = r.accepted?.assignments.ticket_numbers as Record<string, number>
    expect(r.tickets.map((c) => numbers[c.ticket_id])).toEqual([1, 2, 3])
    const byStation = Object.fromEntries(
      t.jobs().map((f) => [t.content(f).station, t.content(f).number]),
    )
    expect(byStation).toEqual({ Cocina: 1, Barra: 2, Postres: 3 })
  })

  it('when the business day changes (6:00 a.m.) numbering goes back to 1', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const sendOrder = () => {
      const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
      t.send(ana, order, items)
    }
    sendOrder() // 3:00 p.m. on the 24th
    t.advance(14 * 3_600_000 + 59 * 60_000) // 5:59 a.m. on the 25th: still the 24th
    sendOrder()
    t.advance(60_000) // 6:00 a.m.
    sendOrder()
    t.advance(60_000)
    sendOrder()
    expect(t.jobs().map((f) => t.content(f).number)).toEqual([1, 2, 1, 2])
  })

  it('the ticket time is shown in the restaurant time zone', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    // START = 20:00 UTC = 3:00 p.m. in Bogotá.
    const time = TIME.exec(String(t.content(t.jobs()[0]).time))
    expect(time?.slice(1, 5)).toEqual(['3', '00', 'p'])
  })

  it('another time zone changes the printed time but not the numbers', () => {
    const t = setupPrinting({ timeZone: 'Europe/Madrid' })
    withPrinters(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    expect(TIME.exec(String(t.content(t.jobs()[0]).time))?.[1]).toBe('10')
  })
})

describe('ItemsSent with items already sent by another device', () => {
  /** Two waiters see the same order; the second did not learn what the first one sent. */
  function twoDevices() {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const luis = t.device('waiter2')
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Risotto', station: t.kitchen },
    ])
    const luisBase = Number(t.db.prepare('SELECT max(sequence) AS s FROM events').get()?.s)
    return { t, ana, luis, order, items, luisBase }
  }

  it('what was already sent is not printed twice: the second ticket has only what was missing', () => {
    const { t, ana, luis, order, items, luisBase } = twoDevices()
    t.send(ana, order, [items[0] as (typeof items)[0]])
    const r = luis.submit(
      order,
      'ItemsSent',
      {
        tickets: [{ ticket_id: newId(), station_id: t.kitchen, item_ids: items.map((i) => i.id) }],
      },
      { base_sequence: luisBase },
    )
    expect(r.status).toBe('confirmed')
    const jobs = t.jobs()
    expect(jobs).toHaveLength(2)
    expect(t.content(jobs[0]).items.map((i: { name: string }) => i.name)).toEqual(['Tagliata'])
    expect(t.content(jobs[1]).items.map((i: { name: string }) => i.name)).toEqual(['Risotto'])
  })

  it('a send where everything already went out, while out of date, is accepted and prints nothing', () => {
    const { t, ana, luis, order, items, luisBase } = twoDevices()
    t.send(ana, order, items)
    expect(t.jobs()).toHaveLength(1)
    const r = luis.submit(
      order,
      'ItemsSent',
      {
        tickets: [{ ticket_id: newId(), station_id: t.kitchen, item_ids: items.map((i) => i.id) }],
      },
      { base_sequence: luisBase },
    )
    expect(r.status).toBe('confirmed')
    expect(t.jobs()).toHaveLength(1)
    expect(t.saveFailures).toEqual([])
  })

  it('the same send resent by the same device does not duplicate the ticket', () => {
    const { t, ana, order, items } = twoDevices()
    const r = t.send(ana, order, items)
    expect(t.jobs()).toHaveLength(1)
    // The hub receives exactly the same event again (retry after an outage).
    const equal = ana.submit(order, 'ItemsSent', { tickets: r.tickets })
    expect(equal.status).toBe('rejected')
    expect(t.jobs()).toHaveLength(1)
  })

  it('calling the hook directly with an already applied event creates nothing', () => {
    const { t, ana, order, items } = twoDevices()
    const r = t.send(ana, order, items)
    if (!r.accepted) throw new Error('no event')
    const already = t.hub.order(order)
    expect(jobsForEvent(t.ticketOptions, r.accepted, [{ before: already, after: already }])).toBe(0)
    expect(t.jobs()).toHaveLength(1)
  })

  it('a send that prints nothing does not use up a ticket number', () => {
    // The hub numbers before knowing whether anything will become «sent»: the kitchen would see
    // ticket 1 and 3 without 2 existing on paper.
    const { t, ana, luis, order, items, luisBase } = twoDevices()
    t.send(ana, order, items)
    luis.submit(
      order,
      'ItemsSent',
      {
        tickets: [{ ticket_id: newId(), station_id: t.kitchen, item_ids: items.map((i) => i.id) }],
      },
      { base_sequence: luisBase },
    )
    const other = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    t.send(ana, other.order, other.items)
    const latest = t.jobs().at(-1)
    expect(t.content(latest).number).toBe(2)
  })
})

describe('a send made offline that arrives late', () => {
  it('it prints on arrival, with the arrival time and the number of the day it was made', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const luis = t.device('waiter2')
    // Luis builds the order and sends it at 11:30 p.m. offline; it arrives at 6:40 a.m.
    const { order, items } = t.orderWith(luis, [{ name: 'Tagliata', station: t.kitchen }])
    const before = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    t.send(ana, before.order, before.items) // number 1 of the 24th
    const sendTime = new Date(t.clock() + 8.5 * 3_600_000).toISOString() // 11:30 p.m. on the 24th
    t.advance(15 * 3_600_000 + 40 * 60_000) // 6:40 a.m. on the 25th
    const r = luis.submit(
      order,
      'ItemsSent',
      { tickets: [{ ticket_id: newId(), station_id: t.kitchen, item_ids: [items[0]?.id] }] },
      { device_time: sendTime, hub_estimated_time: sendTime },
    )
    expect(r.status).toBe('confirmed')
    expect(r.accepted?.business_day).toBe('2026-10-24')
    const latest = t.jobs().at(-1)
    expect(t.content(latest).number).toBe(2)
    expect(String(latest?.created_at)).toBe(r.accepted?.received_at)
    expect(TIME.exec(String(t.content(latest).time))?.slice(1, 5)).toEqual(['6', '40', 'a'])
    // Today the count starts at 1.
    const today = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    t.send(ana, today.order, today.items)
    expect(t.content(t.jobs().at(-1)).number).toBe(1)
  })

  it('it comes out of the printer even if the send arrives hours later, and only once', async () => {
    const t = setupPrinting()
    const { kitchen } = withPrinters(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.advance(3 * 3_600_000)
    t.send(ana, order, items)
    await t.queue.runOnce()
    await t.queue.runOnce()
    expect(kitchen.paper.received).toHaveLength(1)
  })
})

describe('reprint, void and change of what was already sent', () => {
  async function withSentOrder() {
    const t = setupPrinting()
    const printers = withPrinters(t)
    const ana = t.device('waiter')
    const register = t.device('admin', 'register')
    const table = t.table('12')
    const { order, items } = t.orderWith(
      ana,
      [
        {
          name: 'Tagliata',
          station: t.kitchen,
          options: ['Término medio'],
          quantity: 3,
          guest: 2,
        },
        { name: 'Risotto', station: t.kitchen, notes: 'sin queso' },
        { name: 'Aperol Spritz', station: t.bar },
      ],
      table,
    )
    const sent = t.send(ana, order, items)
    await t.queue.runOnce()
    return { t, printers, ana, register, order, items, sent, table }
  }

  it('TicketReprinted prints the ticket again with its original number, marked as a reprint', async () => {
    const { t, printers, ana, order, sent } = await withSentOrder()
    const kitchen = sent.tickets.find((c) => c.station_id === t.kitchen)
    ana.submit(order, 'TicketReprinted', { ticket_id: kitchen?.ticket_id })
    expect(t.pendingList()).toBe(1)
    await t.queue.runOnce()
    expect(printers.kitchen.paper.received).toHaveLength(2)
    const text = printers.kitchen.paper.texts()[1] as string
    expect(text).toContain('REIMPRESIÓN')
    expect(text).toMatch(/Mesa 12 +#1/)
    expect(text).toContain('3 x Tagliata')
    expect(text).toContain('Risotto')
    // The bar does not print the kitchen items.
    expect(printers.bar.paper.received).toHaveLength(1)
  })

  it('reprinting twice prints two tickets (each event is different)', async () => {
    const { t, printers, ana, order, sent } = await withSentOrder()
    const bar = sent.tickets.find((c) => c.station_id === t.bar)
    ana.submit(order, 'TicketReprinted', { ticket_id: bar?.ticket_id })
    ana.submit(order, 'TicketReprinted', { ticket_id: bar?.ticket_id })
    await t.queue.runOnce()
    expect(printers.bar.paper.received).toHaveLength(3)
  })

  it('reprinting a ticket that does not exist, or from another order, prints nothing and the event is accepted', async () => {
    const { t, ana, order, sent } = await withSentOrder()
    const other = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    const r1 = ana.submit(order, 'TicketReprinted', { ticket_id: newId() })
    const r2 = ana.submit(other.order, 'TicketReprinted', {
      ticket_id: sent.tickets[0]?.ticket_id,
    })
    expect([r1.status, r2.status]).toEqual(['confirmed', 'confirmed'])
    expect(t.pendingList()).toBe(0)
    expect(t.saveFailures).toEqual([])
  })

  it('the reprint excludes voided items and shows the remaining units', async () => {
    const { t, printers, register, ana, order, items, sent } = await withSentOrder()
    register.submit(order, 'ItemVoided', {
      item_id: items[0]?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    register.submit(order, 'ItemVoided', {
      item_id: items[1]?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    await t.queue.runOnce()
    const kitchen = sent.tickets.find((c) => c.station_id === t.kitchen)
    ana.submit(order, 'TicketReprinted', { ticket_id: kitchen?.ticket_id })
    await t.queue.runOnce()
    const text = printers.kitchen.paper.texts().at(-1) as string
    expect(text).toContain('REIMPRESIÓN')
    expect(text).toContain('2 x Tagliata')
    expect(text).not.toContain('Risotto')
  })

  it('if everything was voided, the reprint does not print an empty ticket', async () => {
    const { t, register, ana, order, items, sent } = await withSentOrder()
    for (const i of [items[0], items[1]])
      register.submit(order, 'ItemVoided', {
        item_id: i?.id,
        quantity: i?.name === 'Tagliata' ? 3 : 1,
        already_prepared: false,
        ticket_id: null,
      })
    await t.queue.runOnce()
    const before = t.jobs().length
    const kitchen = sent.tickets.find((c) => c.station_id === t.kitchen)
    ana.submit(order, 'TicketReprinted', { ticket_id: kitchen?.ticket_id })
    expect(t.jobs()).toHaveLength(before)
  })

  it('ItemVoided of what is in the kitchen prints the void ticket with the voided quantity', async () => {
    const { t, printers, register, order, items } = await withSentOrder()
    const r = register.submit(order, 'ItemVoided', {
      item_id: items[0]?.id,
      quantity: 2,
      already_prepared: false,
      ticket_id: null,
    })
    expect(r.status).toBe('confirmed')
    await t.queue.runOnce()
    const text = printers.kitchen.paper.texts().at(-1) as string
    expect(text).toContain('ANULAR')
    expect(text).toMatch(/Mesa 12 +#1/)
    expect(text).toContain('-2 x Tagliata')
    expect(text).toContain('> Término medio')
    expect(text).not.toContain('Risotto')
    expect(printers.bar.paper.received).toHaveLength(1)
  })

  it.each(['sent', 'in_preparation', 'ready'] as const)(
    'ItemVoided alerts the kitchen if the dish is «%s»',
    async (status) => {
      const { t, ana, register, order, items } = await withSentOrder()
      const id = items[1]?.id
      if (status === 'in_preparation') ana.submit(order, 'ItemInPreparation', { item_ids: [id] })
      if (status === 'ready') ana.submit(order, 'ItemReady', { item_ids: [id] })
      expect(t.hub.order(order)?.items[id as string]?.status).toBe(status)
      const before = t.jobs().length
      register.submit(order, 'ItemVoided', {
        item_id: id,
        quantity: 1,
        already_prepared: status === 'ready',
        ticket_id: null,
      })
      expect(t.jobs()).toHaveLength(before + 1)
    },
  )

  it('ItemVoided of something already served does not alert the kitchen', async () => {
    const { t, ana, register, order, items } = await withSentOrder()
    ana.submit(order, 'ItemServed', { item_ids: [items[1]?.id] })
    const before = t.jobs().length
    const r = register.submit(order, 'ItemVoided', {
      item_id: items[1]?.id,
      quantity: 1,
      already_prepared: true,
      ticket_id: null,
    })
    expect(r.status).toBe('confirmed')
    expect(t.jobs()).toHaveLength(before)
  })

  it('voiding what was not sent yet is rejected and does not print (it is removed, not voided)', async () => {
    const { t, ana, register } = await withSentOrder()
    const fresh = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    const before = t.jobs().length
    const r = register.submit(fresh.order, 'ItemVoided', {
      item_id: fresh.items[0]?.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    expect(r.status).toBe('rejected')
    expect(t.jobs()).toHaveLength(before)
  })

  it('voiding the same dish twice (partial quantity and then the rest) prints two voids', async () => {
    const { t, printers, register, order, items } = await withSentOrder()
    for (const quantity of [1, 2])
      register.submit(order, 'ItemVoided', {
        item_id: items[0]?.id,
        quantity,
        already_prepared: false,
        ticket_id: null,
      })
    await t.queue.runOnce()
    const texts = printers.kitchen.paper.texts()
    expect(texts.at(-2)).toContain('-1 x Tagliata')
    expect(texts.at(-1)).toContain('-2 x Tagliata')
  })

  it('ItemModifiedAfterSend prints the change ticket with the new options and notes', async () => {
    const { t, printers, ana, order, items, sent } = await withSentOrder()
    const kitchen = sent.tickets.find((c) => c.station_id === t.kitchen)
    const r = ana.submit(order, 'ItemModifiedAfterSend', {
      item_id: items[1]?.id,
      ticket_id: kitchen?.ticket_id,
      notes: 'sin queso y sin sal',
    })
    expect(r.status).toBe('confirmed')
    await t.queue.runOnce()
    const text = printers.kitchen.paper.texts().at(-1) as string
    expect(text).toContain('CAMBIO')
    expect(text).toMatch(/Mesa 12 +#1/)
    expect(text).toContain('Risotto')
    expect(text).toContain('NOTA: sin queso y sin sal')
    expect(text).not.toContain('Tagliata')
  })

  it('a change of options prints the new ones; removing the note leaves it without NOTA', async () => {
    const { t, printers, ana, order, items, sent } = await withSentOrder()
    const kitchen = sent.tickets.find((c) => c.station_id === t.kitchen)
    ana.submit(order, 'ItemModifiedAfterSend', {
      item_id: items[1]?.id,
      ticket_id: kitchen?.ticket_id,
      notes: null,
      modifiers: [{ modifier_id: newId(), name: 'Bien cocido', extra_price: 0 }],
    })
    await t.queue.runOnce()
    const text = printers.kitchen.paper.texts().at(-1) as string
    expect(text).toContain('> Bien cocido')
    expect(text).not.toContain('NOTA')
  })

  it('modifying something not yet sent is rejected and does not print', async () => {
    const { t, ana } = await withSentOrder()
    const fresh = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    const before = t.jobs().length
    const r = ana.submit(fresh.order, 'ItemModifiedAfterSend', {
      item_id: fresh.items[0]?.id,
      ticket_id: newId(),
      notes: 'x',
    })
    expect(r.status).toBe('rejected')
    expect(t.jobs()).toHaveLength(before)
  })

  it('events that are not about tickets (ready, served, discounts…) create no jobs', async () => {
    const { t, ana, order, items } = await withSentOrder()
    const before = t.jobs().length
    ana.submit(order, 'ItemReady', { item_ids: [items[0]?.id] })
    ana.submit(order, 'ItemServed', { item_ids: [items[0]?.id] })
    ana.submit(order, 'ItemReturnedToQueue', { item_ids: [items[0]?.id] })
    ana.submit(order, 'GuestsChanged', { guests: 5 })
    expect(t.jobs()).toHaveLength(before)
  })

  it('voiding a dish that was moved to another order (an item changing tables) alerts the kitchen', async () => {
    // The dish is still in the kitchen, but its ticket stayed in the events of the source order.
    const { t, ana, register, order, items } = await withSentOrder()
    const target = newId()
    ana.submit(target, 'OrderOpened', { channel: 'dine_in', table_id: null, guests: 1 })
    const original = t.hub.order(order)?.items[items[1]?.id as string]
    if (!original) throw new Error('no item')
    const moved = ana.submit(
      order,
      'ItemsMoved',
      {
        target_order_id: target,
        items: [
          {
            item: {
              item_id: original.id,
              product_id: original.productId,
              variant_id: original.variantId,
              name: original.name,
              unit_price: original.unitPrice,
              tax_type: original.taxType,
              rate: original.rate,
              quantity: original.quantity,
              guest: original.guest,
              course: original.course,
              modifiers: original.modifiers.map((m) => ({
                modifier_id: m.modifierId,
                name: m.name,
                extra_price: m.extraPrice,
              })),
              notes: original.notes,
            },
            status: 'sent',
            voided_quantity: 0,
            added_by: original.addedBy,
          },
        ],
      },
      { related: [target] },
    )
    expect(moved.result).toMatchObject({ status: 'confirmed' })
    const before = t.jobs().length
    const r = register.submit(target, 'ItemVoided', {
      item_id: original.id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    expect(r.status).toBe('confirmed')
    expect(t.jobs()).toHaveLength(before + 1)
  })
})

describe('data the ticket carries', () => {
  it.each([
    ['dine_in', 'Mesa'],
    ['takeout', 'Para llevar'],
    ['delivery', 'Domicilio'],
    ['bar', 'Barra'],
  ])('the %s channel without a table is announced as «%s»', (channel, target) => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(
      ana,
      [{ name: 'Pizza', station: t.kitchen }],
      null,
      channel,
    )
    t.send(ana, order, items)
    expect(t.content(t.jobs()[0]).target).toBe(target)
  })

  it('with a table it has «Mesa N», the waiter, the order number of the day and the guests', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('7'))
    t.send(ana, order, items)
    expect(t.content(t.jobs()[0])).toMatchObject({
      type: 'new',
      station: 'Cocina',
      target: 'Mesa 7',
      waiter: 'Ana',
      order: 1,
      guests: 2,
      number: 1,
    })
  })

  it('the options, notes, guest and course of each dish travel in the job', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [
      {
        name: 'Tagliata',
        station: t.kitchen,
        options: ['Término medio', 'Sin sal'],
        notes: 'alergia al maní',
        guest: 3,
        course: 'main',
        quantity: 2,
      },
    ])
    t.send(ana, order, items)
    expect(t.content(t.jobs()[0]).items).toEqual([
      {
        quantity: 2,
        name: 'Tagliata',
        guest: 3,
        course: 'main',
        options: ['Término medio', 'Sin sal'],
        notes: 'alergia al maní',
      },
    ])
  })

  it('a table that no longer exists does not break the ticket', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], newId())
    t.send(ana, order, items)
    expect(t.content(t.jobs()[0]).target).toBe('Mesa')
  })

  it('a table name with odd characters is printed without printer commands', async () => {
    const t = setupPrinting()
    const printers = withPrinters(t)
    const ana = t.device('waiter')
    const table = t.table('\x1bp\x00T\x1dV1')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza\x1b@', station: t.kitchen }], table)
    t.send(ana, order, items)
    await t.queue.runOnce()
    const bytes = printers.kitchen.paper.received[0] as Uint8Array
    expect(readEscpos(bytes).cuts).toBe(1)
    expect(readEscpos(bytes).text).toContain('Pizza')
  })
})

describe('held courses', () => {
  it('the ticket shows the courses still on hold and stops showing them once fired', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const order = t.open(ana)
    ana.submit(order, 'CourseHeld', { course: 'dessert' })
    const main = t.add(ana, order, {
      name: 'Tagliata',
      station: t.kitchen,
      course: 'main',
    })
    const dessert = t.add(ana, order, {
      name: 'Tiramisú',
      station: t.desserts,
      course: 'dessert',
    })
    expect(t.hub.order(order)?.items[dessert.id]?.status).toBe('held')
    t.send(ana, order, [main])
    expect(t.content(t.jobs()[0]).heldCourses).toEqual(['dessert'])
    // The dessert is fired: now it is sent and nothing is on hold anymore.
    ana.submit(order, 'CourseFired', { course: 'dessert' })
    t.send(ana, order, [dessert])
    expect(t.content(t.jobs().at(-1)).heldCourses).toEqual([])
  })

  it('several held courses are all shown, and only those with dishes', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const order = t.open(ana)
    ana.submit(order, 'CourseHeld', { course: 'main' })
    ana.submit(order, 'CourseHeld', { course: 'dessert' })
    const entry = t.add(ana, order, {
      name: 'Burrata',
      station: t.kitchen,
      course: 'starter',
    })
    t.add(ana, order, { name: 'Tagliata', station: t.kitchen, course: 'main' })
    t.send(ana, order, [entry])
    expect(t.content(t.jobs()[0]).heldCourses).toEqual(['main'])
  })

  it('if the course is held but has no dishes, it is not shown as on hold', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const order = t.open(ana)
    ana.submit(order, 'CourseHeld', { course: 'dessert' })
    const dish = t.add(ana, order, { name: 'Risotto', station: t.kitchen })
    t.send(ana, order, [dish])
    expect(t.content(t.jobs().at(-1)).heldCourses).toEqual([])
  })

  it('reprints do not carry the on-hold notice', () => {
    const t = setupPrinting()
    withPrinters(t)
    const ana = t.device('waiter')
    const order = t.open(ana)
    const dish = t.add(ana, order, {
      name: 'Tagliata',
      station: t.kitchen,
      course: 'main',
    })
    t.add(ana, order, { name: 'Tiramisú', station: t.desserts, course: 'dessert' })
    ana.submit(order, 'CourseHeld', { course: 'dessert' })
    const r = t.send(ana, order, [dish])
    expect(t.content(t.jobs()[0]).heldCourses).toEqual(['dessert'])
    ana.submit(order, 'TicketReprinted', { ticket_id: r.tickets[0]?.ticket_id })
    expect(t.content(t.jobs().at(-1))).toMatchObject({ type: 'reprint', heldCourses: [] })
  })
})

describe('stations and printers', () => {
  it('a station without a printer leaves no jobs and the send does not fail', () => {
    const t = setupPrinting()
    t.newPrinter('Barra', [t.bar])
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol', station: t.bar },
    ])
    const r = t.send(ana, order, items)
    expect(r.status).toBe('confirmed')
    expect(t.jobs().map((f) => t.content(f).station)).toEqual(['Barra'])
    expect(t.saveFailures).toEqual([])
  })

  it('with no printer at all nothing is created', () => {
    const t = setupPrinting()
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    expect(t.send(ana, order, items).status).toBe('confirmed')
    expect(t.jobs()).toEqual([])
  })

  it('two printers for the same station: each gets its copy', async () => {
    const t = setupPrinting()
    const a = t.newPrinter('Cocina 1', [t.kitchen])
    const b = t.newPrinter('Cocina 2', [t.kitchen])
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    expect(t.jobs()).toHaveLength(2)
    await t.queue.runOnce()
    expect(a.paper.received).toHaveLength(1)
    expect(b.paper.received).toHaveLength(1)
  })

  it('a printer for several stations prints both tickets, in order', async () => {
    const t = setupPrinting()
    const sole = t.newPrinter('Todo', [t.kitchen, t.bar])
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol', station: t.bar },
    ])
    t.send(ana, order, items)
    await t.queue.runOnce()
    expect(sole.paper.texts().map((x) => (x.includes('COCINA') ? 'cocina' : 'barra'))).toEqual([
      'cocina',
      'barra',
    ])
  })

  it('an archived printer receives no new tickets', () => {
    const t = setupPrinting()
    t.newPrinter('Vieja', [t.kitchen], { active: 0 })
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    expect(t.jobs()).toEqual([])
  })

  it('an archived station with old tickets keeps printing with its name', async () => {
    const t = setupPrinting()
    const printer = t.newPrinter('Cocina', [t.kitchen])
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    t.db.prepare('UPDATE stations SET active = 0 WHERE id = ?').run(t.kitchen)
    await t.queue.runOnce()
    expect(printer.paper.texts()[0]).toContain('COCINA')
  })

  it('a station that does not exist in the database is printed as «Estación»', () => {
    const t = setupPrinting()
    const ghost = newId()
    t.db.exec('PRAGMA foreign_keys = OFF')
    t.newPrinter('Fantasma', [ghost])
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: ghost }])
    t.send(ana, order, items)
    expect(t.content(t.jobs()[0]).station).toBe('Estación')
  })
})

describe('a failure while building the ticket', () => {
  it('does not reject the event: the order stays sent and the failure is reported', () => {
    const t = setupPrinting()
    t.newPrinter('Cocina', [t.kitchen])
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    // The queue table disappears: inserting into it blows up.
    t.db.exec('DROP TRIGGER print_jobs_no_delete')
    t.db.exec('DROP TABLE print_jobs')
    const r = t.send(ana, order, items)
    expect(r.status).toBe('confirmed')
    expect(t.hub.order(order)?.items[items[0]?.id as string]?.status).toBe('sent')
    expect(t.saveFailures).toHaveLength(1)
    expect(t.saveFailures[0]?.id).toBe(r.accepted?.id)
  })

  it('all or nothing: if the bar ticket fails the kitchen one is not left half done', () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    const bar = t.newPrinter('Barra', [t.bar])
    t.db.exec(
      `CREATE TRIGGER falla_barra BEFORE INSERT ON print_jobs
       WHEN NEW.printer_id = '${bar.id}'
       BEGIN SELECT RAISE(ABORT, 'impresora de la barra rota'); END`,
    )
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [
      { name: 'Tagliata', station: t.kitchen },
      { name: 'Aperol', station: t.bar },
    ])
    const r = t.send(ana, order, items)
    expect(r.status).toBe('confirmed')
    expect(t.saveFailures).toHaveLength(1)
    expect(t.jobs()).toEqual([])
    void kitchen
    // The hub keeps accepting events afterwards.
    expect(ana.submit(order, 'ItemReady', { item_ids: [items[0]?.id] }).status).toBe('confirmed')
  })

  it('the error building a ticket comes with the event id so it can be reprinted', () => {
    const t = setupPrinting()
    t.newPrinter('Cocina', [t.kitchen])
    t.db.exec('DROP TRIGGER print_jobs_no_delete')
    t.db.exec('DROP TABLE print_jobs')
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    const r = t.send(ana, order, items)
    expect(t.saveFailures.map((f) => f.id)).toEqual([r.accepted?.id])
  })
})

describe('several restaurants in the same database', () => {
  function withOtherRestaurant(t: PrintingSetup) {
    const other = newId()
    const now = t.clock
    t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(other, other, '2026-10-24T20:00:00.000Z', '2026-10-24T20:00:00.000Z')
    void now
    const station = insertVersioned(
      t.db,
      'stations',
      other,
      { name: 'Cocina de otro', position: 1 },
      SYSTEM,
      '2026-10-24T20:00:00.000Z',
    )
    return { other, station }
  }

  it('a printer from another restaurant never receives tickets from this one, not even with the same station', async () => {
    const t = setupPrinting()
    const myPrinter = t.newPrinter('Cocina', [t.kitchen])
    const { other } = withOtherRestaurant(t)
    const foreign = insertVersioned(
      t.db,
      'printers',
      other,
      {
        name: 'Ajena',
        connection: 'network',
        address: '10.9.9.9',
        port: 9100,
        width: 80,
        // Points (wrongly) to this restaurant's station.
        station_ids: JSON.stringify([t.kitchen]),
      },
      SYSTEM,
      '2026-10-24T20:00:00.000Z',
    )
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    const rows = t.jobs()
    expect(rows.map((f) => f.printer_id)).toEqual([myPrinter.id])
    expect(rows.some((f) => f.printer_id === foreign)).toBe(false)
  })

  it('one restaurant queue does not print or count the jobs of the other', async () => {
    const t = setupPrinting()
    const myPrinter = t.newPrinter('Cocina', [t.kitchen])
    const { other } = withOtherRestaurant(t)
    const otherQueue = t.createQueue({ restaurantId: other })
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Tagliata', station: t.kitchen }])
    t.send(ana, order, items)
    await otherQueue.runOnce()
    expect(myPrinter.paper.received).toHaveLength(0)
    expect(otherQueue.status()).toEqual([])
    expect(t.queue.status()).toMatchObject([{ id: myPrinter.id, pendingList: 1 }])
    await t.queue.runOnce()
    expect(myPrinter.paper.received).toHaveLength(1)
  })

  it('the waiter, the table and the station are looked up in the event restaurant', () => {
    const t = setupPrinting()
    t.newPrinter('Cocina', [t.kitchen])
    const { other } = withOtherRestaurant(t)
    // Another restaurant with a user of the same name does not change the printed waiter.
    const ana = t.device('waiter')
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }], t.table('3'))
    t.send(ana, order, items)
    expect(t.content(t.jobs()[0])).toMatchObject({
      waiter: 'Ana',
      target: 'Mesa 3',
      station: 'Cocina',
    })
    void other
  })
})
