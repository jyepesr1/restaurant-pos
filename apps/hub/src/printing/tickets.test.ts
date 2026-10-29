import { newId } from '@pos/core'
import { readEscpos } from '@pos/printing'
import { HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { item, OPEN_ORDER } from '../access/hub-setup'
import { insertVersioned, SYSTEM } from '../access/records'
import { setupAccess } from '../access/setup'
import { PrintQueue } from './queue'
import { openTestPrinter, type TestPrinter } from './test-printer'
import { jobsForEvent } from './tickets'

// End to end on the hub (ADR-015): the waiter sends, the hub saves the ticket in the queue in
// the same transaction as the event and the queue sends it to the station's network printer.

const openHandles: TestPrinter[] = []
afterEach(async () => {
  for (const i of openHandles.splice(0)) await i.close()
})

async function setup() {
  const m = setupAccess()
  const now = m.clock()
  const kitchen = insertVersioned(
    m.db,
    'stations',
    m.restaurantId,
    { name: 'Cocina', position: 1 },
    SYSTEM,
    now,
  )
  const bar = insertVersioned(
    m.db,
    'stations',
    m.restaurantId,
    { name: 'Barra', position: 2 },
    SYSTEM,
    now,
  )
  const options = { db: m.db, restaurantId: m.restaurantId, timeZone: 'America/Bogota' }
  const queue = new PrintQueue({ db: m.db, restaurantId: m.restaurantId })
  const hub = new HubSync(new SqliteStore(m.db, m.restaurantId), {
    restaurantId: m.restaurantId,
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-1',
    clock: m.clock,
    access: m.access,
    onSave: (event, changes) => {
      jobsForEvent(options, event, changes)
    },
  })
  const printer = async (name: string, stations: string[], fallback: string | null = null) => {
    const mockPrinter = await openTestPrinter()
    openHandles.push(mockPrinter)
    const id = insertVersioned(
      m.db,
      'printers',
      m.restaurantId,
      {
        name,
        connection: 'network',
        address: '127.0.0.1',
        port: mockPrinter.port,
        width: 80,
        code_page: 'pc850',
        fallback_id: fallback,
        station_ids: JSON.stringify(stations),
      },
      SYSTEM,
      now,
    )
    return { id, mockPrinter }
  }
  const { connection } = m.pair('waiter')
  const session = m.signIn(connection, 'waiter')
  /** Opens an order with a kitchen dish and a bar drink, and sends them. */
  const send = () => {
    const order = newId()
    const dish = {
      ...item([{ modifier_id: newId(), name: 'Término medio', extra_price: 0 }]),
      name: 'Tagliata',
      guest: 1,
    }
    const drink = { ...item(), name: 'Aperol Spritz' }
    const inOrder = { aggregate_id: order }
    const base = m.db.prepare('SELECT coalesce(max(sequence), 0) AS s FROM events').get()
      ?.s as number
    const r = hub.receiveBatch(connection, [
      m.event(connection, session, 'OrderOpened', OPEN_ORDER, { ...inOrder, base_sequence: base }),
      m.event(connection, session, 'ItemAdded', dish, { ...inOrder, base_sequence: base + 1 }),
      m.event(connection, session, 'ItemAdded', drink, { ...inOrder, base_sequence: base + 2 }),
      m.event(
        connection,
        session,
        'ItemsSent',
        {
          tickets: [
            { ticket_id: newId(), station_id: kitchen, item_ids: [dish.item_id] },
            { ticket_id: newId(), station_id: bar, item_ids: [drink.item_id] },
          ],
        },
        { ...inOrder, base_sequence: base + 3 },
      ),
    ])
    expect(r.results.map((x) => x.status)).toEqual([
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
    ])
    return r.acceptedEvents.at(-1)
  }
  /** One more event from the same device, after everything already there. */
  const other = (order: string, type: Parameters<typeof m.event>[2], data: object) => {
    const base = m.db.prepare('SELECT coalesce(max(sequence), 0) AS s FROM events').get()
      ?.s as number
    return hub.receiveBatch(connection, [
      m.event(connection, session, type, data, { aggregate_id: order, base_sequence: base }),
    ])
  }
  return { m, queue, hub, kitchen, bar, printer, send, other }
}

const pendingList = (m: ReturnType<typeof setupAccess>) =>
  Number(m.db.prepare("SELECT count(*) AS n FROM print_jobs WHERE status = 'pending'").get()?.n)

describe('printed tickets', () => {
  it('each station prints its own, with consecutive daily numbering', async () => {
    const t = await setup()
    const kitchen = await t.printer('Cocina', [t.kitchen])
    const bar = await t.printer('Barra', [t.bar])
    const sent = t.send()
    expect(Object.values(sent?.assignments.ticket_numbers ?? {})).toEqual([1, 2])
    expect(pendingList(t.m)).toBe(2)
    await t.queue.runOnce()
    expect(pendingList(t.m)).toBe(0)
    await kitchen.mockPrinter.wait(1)
    await bar.mockPrinter.wait(1)
    const inKitchen = readEscpos(kitchen.mockPrinter.received[0] as Uint8Array).text
    expect(inKitchen).toContain('COCINA')
    expect(inKitchen).toContain('Tagliata')
    expect(inKitchen).toContain('> Término medio')
    expect(inKitchen).toMatch(/Mesa +#1/)
    expect(inKitchen).not.toContain('Aperol')
    expect(readEscpos(bar.mockPrinter.received[0] as Uint8Array).text).toContain('Aperol Spritz')
    // A second send continues the daily numbering.
    const other = t.send()
    expect(Object.values(other?.assignments.ticket_numbers ?? {})).toEqual([3, 4])
  })

  it('a station without a printer leaves no jobs', async () => {
    const t = await setup()
    await t.printer('Barra', [t.bar])
    t.send()
    expect(pendingList(t.m)).toBe(1)
  })

  it('if the printer does not respond, it retries, and after 3 failures prints on the fallback', async () => {
    const t = await setup()
    const fallback = await t.printer('Respaldo', [])
    const kitchen = await t.printer('Cocina', [t.kitchen], fallback.id)
    await kitchen.mockPrinter.shutDown(true)
    let now = Date.now()
    const queue = new PrintQueue({
      db: t.m.db,
      restaurantId: t.m.restaurantId,
      clock: () => now,
    })
    t.send()
    for (let i = 0; i < 3; i++) {
      if (i > 0) now += 60_000
      await queue.runOnce()
    }
    expect(queue.status().find((e) => e.id === kitchen.id)?.status).toBe('failed')
    expect(kitchen.mockPrinter.received).toHaveLength(0)
    await queue.runOnce()
    await fallback.mockPrinter.wait(1)
    expect(fallback.mockPrinter.received).toHaveLength(1)
    expect(readEscpos(fallback.mockPrinter.received[0] as Uint8Array).text).toContain('Tagliata')
    const row = t.m.db.prepare("SELECT * FROM print_jobs WHERE type = 'ticket'").get()
    expect(row?.status).toBe('printed')
    expect(row?.printed_on_id).toBe(fallback.id)
    expect(Number(row?.attempts)).toBe(4)
  })

  it('retrying the same send does not duplicate the ticket', async () => {
    const t = await setup()
    await t.printer('Cocina', [t.kitchen])
    const event = t.send()
    if (!event) throw new Error('no event')
    const changes = [{ before: null, after: t.hub.order(event.aggregate_id) }]
    // Already sent: nothing is left «pending → sent» and nothing new is built.
    expect(
      jobsForEvent(
        { db: t.m.db, restaurantId: t.m.restaurantId, timeZone: 'America/Bogota' },
        event,
        changes,
      ),
    ).toBe(0)
    expect(pendingList(t.m)).toBe(1)
  })

  it('the main printer is retried when its wait expires and, if it responds now, prints its own', async () => {
    const t = await setup()
    const fallback = await t.printer('Respaldo', [])
    const kitchen = await t.printer('Cocina', [t.kitchen], fallback.id)
    await kitchen.mockPrinter.shutDown(true)
    let now = Date.now()
    const queue = new PrintQueue({
      db: t.m.db,
      restaurantId: t.m.restaurantId,
      clock: () => now,
    })
    t.send()
    for (let i = 0; i < 3; i++) {
      if (i > 0) now += 60_000
      await queue.runOnce()
    }
    await kitchen.mockPrinter.shutDown(false)
    now += 60_000
    t.send()
    await queue.runOnce()
    await queue.runOnce()
    await kitchen.mockPrinter.wait(2)
    expect(kitchen.mockPrinter.received).toHaveLength(2)
    expect(fallback.mockPrinter.received).toHaveLength(0)
    expect(queue.status().find((e) => e.id === kitchen.id)?.status).toBe('ready')
  })

  it('changing the order note with dishes in the kitchen prints «NOTA NUEVA» at each station with something pending', async () => {
    const t = await setup()
    const kitchen = await t.printer('Cocina', [t.kitchen])
    const bar = await t.printer('Barra', [t.bar])
    const sent = t.send()
    if (!sent) throw new Error('no send')
    await t.queue.runOnce()
    const r = t.other(sent.aggregate_id, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    expect(r.results[0]?.status).toBe('confirmed')
    await t.queue.runOnce()
    await kitchen.mockPrinter.wait(2)
    await bar.mockPrinter.wait(2)
    const note = readEscpos(kitchen.mockPrinter.received[1] as Uint8Array).text
    expect(note).toContain('NOTA NUEVA')
    expect(note).toContain('NOTA DEL PEDIDO: alérgico al maní')
    expect(readEscpos(bar.mockPrinter.received[1] as Uint8Array).text).toContain('alérgico al maní')

    // Removing it is also announced on paper.
    t.other(sent.aggregate_id, 'OrderNoteChanged', { notes: null })
    await t.queue.runOnce()
    await kitchen.mockPrinter.wait(3)
    expect(readEscpos(kitchen.mockPrinter.received[2] as Uint8Array).text).toContain(
      'SE QUITÓ LA NOTA DEL PEDIDO',
    )
  })

  it('the note of an order with nothing in the kitchen prints nothing', async () => {
    const t = await setup()
    await t.printer('Cocina', [t.kitchen])
    const sent = t.send()
    if (!sent) throw new Error('no send')
    const order = t.hub.order(sent.aggregate_id)
    const ids = Object.keys(order?.items ?? {})
    t.other(sent.aggregate_id, 'ItemServed', { item_ids: ids })
    const before = pendingList(t.m)
    t.other(sent.aggregate_id, 'OrderNoteChanged', { notes: 'cumpleaños' })
    expect(pendingList(t.m)).toBe(before)
  })
})
