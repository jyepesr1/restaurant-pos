import { newId } from '@pos/core'
import { readEscpos } from '@pos/printing'
import { HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { montarAcceso } from '../acceso/montaje'
import { ABRIR, item } from '../acceso/montaje-hub'
import { insertVersioned, SISTEMA } from '../acceso/registros'
import { ColaImpresion } from './cola'
import { trabajosDeEvento } from './comandas'
import { abrirImpresoraDePrueba, type ImpresoraDePrueba } from './impresora-prueba'

// De punta a punta en el hub (ADR-015): el mesero envía, el hub guarda la comanda en la cola en
// la misma transacción del evento y la cola la manda a la impresora de red de la estación.

const openHandles: ImpresoraDePrueba[] = []
afterEach(async () => {
  for (const i of openHandles.splice(0)) await i.close()
})

async function setup() {
  const m = montarAcceso()
  const now = m.clock()
  const kitchen = insertVersioned(
    m.db,
    'stations',
    m.restaurantId,
    { name: 'Cocina', position: 1 },
    SISTEMA,
    now,
  )
  const bar = insertVersioned(
    m.db,
    'stations',
    m.restaurantId,
    { name: 'Barra', position: 2 },
    SISTEMA,
    now,
  )
  const options = { db: m.db, restaurantId: m.restaurantId, timeZone: 'America/Bogota' }
  const queue = new ColaImpresion({ db: m.db, restaurantId: m.restaurantId })
  const hub = new HubSync(new SqliteStore(m.db, m.restaurantId), {
    restaurantId: m.restaurantId,
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-1',
    clock: m.clock,
    access: m.access,
    onSave: (event, changes) => {
      trabajosDeEvento(options, event, changes)
    },
  })
  const printer = async (name: string, stations: string[], fallback: string | null = null) => {
    const mockPrinter = await abrirImpresoraDePrueba()
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
      SISTEMA,
      now,
    )
    return { id, mockPrinter }
  }
  const { connection } = m.emparejar('waiter')
  const session = m.entrar(connection, 'waiter')
  /** Abre un pedido con un plato de cocina y una bebida de barra, y los envía. */
  const send = () => {
    const order = newId()
    const dish = {
      ...item([{ modifier_id: newId(), name: 'Término medio', extra_price: 0 }]),
      name: 'Tagliata',
      guest: 1,
    }
    const bebida = { ...item(), name: 'Aperol Spritz' }
    const en = { aggregate_id: order }
    const base = m.db.prepare('SELECT coalesce(max(sequence), 0) AS s FROM events').get()
      ?.s as number
    const r = hub.receiveBatch(connection, [
      m.event(connection, session, 'OrderOpened', ABRIR, { ...en, base_sequence: base }),
      m.event(connection, session, 'ItemAdded', dish, { ...en, base_sequence: base + 1 }),
      m.event(connection, session, 'ItemAdded', bebida, { ...en, base_sequence: base + 2 }),
      m.event(
        connection,
        session,
        'ItemsSent',
        {
          tickets: [
            { ticket_id: newId(), station_id: kitchen, item_ids: [dish.item_id] },
            { ticket_id: newId(), station_id: bar, item_ids: [bebida.item_id] },
          ],
        },
        { ...en, base_sequence: base + 3 },
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
  /** Un evento más del mismo equipo, después de todo lo que ya hay. */
  const other = (order: string, type: Parameters<typeof m.event>[2], data: object) => {
    const base = m.db.prepare('SELECT coalesce(max(sequence), 0) AS s FROM events').get()
      ?.s as number
    return hub.receiveBatch(connection, [
      m.event(connection, session, type, data, { aggregate_id: order, base_sequence: base }),
    ])
  }
  return { m, queue, hub, kitchen, bar, printer, send, other }
}

const pendingList = (m: ReturnType<typeof montarAcceso>) =>
  Number(m.db.prepare("SELECT count(*) AS n FROM print_jobs WHERE status = 'pending'").get()?.n)

describe('comandas impresas', () => {
  it('cada estación imprime lo suyo, con número del día seguido', async () => {
    const t = await setup()
    const kitchen = await t.printer('Cocina', [t.kitchen])
    const bar = await t.printer('Barra', [t.bar])
    const sent = t.send()
    expect(Object.values(sent?.assignments.ticket_numbers ?? {})).toEqual([1, 2])
    expect(pendingList(t.m)).toBe(2)
    await t.queue.runOnce()
    expect(pendingList(t.m)).toBe(0)
    await kitchen.mockPrinter.esperar(1)
    await bar.mockPrinter.esperar(1)
    const enCocina = readEscpos(kitchen.mockPrinter.received[0] as Uint8Array).text
    expect(enCocina).toContain('COCINA')
    expect(enCocina).toContain('Tagliata')
    expect(enCocina).toContain('> Término medio')
    expect(enCocina).toMatch(/Mesa +#1/)
    expect(enCocina).not.toContain('Aperol')
    expect(readEscpos(bar.mockPrinter.received[0] as Uint8Array).text).toContain('Aperol Spritz')
    // Un segundo envío sigue la numeración del día.
    const other = t.send()
    expect(Object.values(other?.assignments.ticket_numbers ?? {})).toEqual([3, 4])
  })

  it('una estación sin impresora no deja trabajos', async () => {
    const t = await setup()
    await t.printer('Barra', [t.bar])
    t.send()
    expect(pendingList(t.m)).toBe(1)
  })

  it('si la impresora no responde, se reintenta, y a los 3 fallos sale por la de respaldo', async () => {
    const t = await setup()
    const fallback = await t.printer('Respaldo', [])
    const kitchen = await t.printer('Cocina', [t.kitchen], fallback.id)
    await kitchen.mockPrinter.apagar(true)
    let now = Date.now()
    const queue = new ColaImpresion({
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
    await fallback.mockPrinter.esperar(1)
    expect(fallback.mockPrinter.received).toHaveLength(1)
    expect(readEscpos(fallback.mockPrinter.received[0] as Uint8Array).text).toContain('Tagliata')
    const row = t.m.db.prepare("SELECT * FROM print_jobs WHERE type = 'ticket'").get()
    expect(row?.status).toBe('printed')
    expect(row?.printed_on_id).toBe(fallback.id)
    expect(Number(row?.attempts)).toBe(4)
  })

  it('el reintento del mismo envío no duplica la comanda', async () => {
    const t = await setup()
    await t.printer('Cocina', [t.kitchen])
    const event = t.send()
    if (!event) throw new Error('sin evento')
    const changes = [{ before: null, after: t.hub.order(event.aggregate_id) }]
    // Ya enviado: no queda nada «pendiente → enviado» y no se arma nada nuevo.
    expect(
      trabajosDeEvento(
        { db: t.m.db, restaurantId: t.m.restaurantId, timeZone: 'America/Bogota' },
        event,
        changes,
      ),
    ).toBe(0)
    expect(pendingList(t.m)).toBe(1)
  })

  it('la principal se vuelve a probar al vencer su espera y, si ya responde, imprime lo suyo', async () => {
    const t = await setup()
    const fallback = await t.printer('Respaldo', [])
    const kitchen = await t.printer('Cocina', [t.kitchen], fallback.id)
    await kitchen.mockPrinter.apagar(true)
    let now = Date.now()
    const queue = new ColaImpresion({
      db: t.m.db,
      restaurantId: t.m.restaurantId,
      clock: () => now,
    })
    t.send()
    for (let i = 0; i < 3; i++) {
      if (i > 0) now += 60_000
      await queue.runOnce()
    }
    await kitchen.mockPrinter.apagar(false)
    now += 60_000
    t.send()
    await queue.runOnce()
    await queue.runOnce()
    await kitchen.mockPrinter.esperar(2)
    expect(kitchen.mockPrinter.received).toHaveLength(2)
    expect(fallback.mockPrinter.received).toHaveLength(0)
    expect(queue.status().find((e) => e.id === kitchen.id)?.status).toBe('ready')
  })

  it('cambiar la nota del pedido con platos en cocina imprime «NOTA NUEVA» en cada estación con algo pendiente', async () => {
    const t = await setup()
    const kitchen = await t.printer('Cocina', [t.kitchen])
    const bar = await t.printer('Barra', [t.bar])
    const sent = t.send()
    if (!sent) throw new Error('sin envío')
    await t.queue.runOnce()
    const r = t.other(sent.aggregate_id, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    expect(r.results[0]?.status).toBe('confirmed')
    await t.queue.runOnce()
    await kitchen.mockPrinter.esperar(2)
    await bar.mockPrinter.esperar(2)
    const note = readEscpos(kitchen.mockPrinter.received[1] as Uint8Array).text
    expect(note).toContain('NOTA NUEVA')
    expect(note).toContain('NOTA DEL PEDIDO: alérgico al maní')
    expect(readEscpos(bar.mockPrinter.received[1] as Uint8Array).text).toContain('alérgico al maní')

    // Quitarla también se avisa en papel.
    t.other(sent.aggregate_id, 'OrderNoteChanged', { notes: null })
    await t.queue.runOnce()
    await kitchen.mockPrinter.esperar(3)
    expect(readEscpos(kitchen.mockPrinter.received[2] as Uint8Array).text).toContain(
      'SE QUITÓ LA NOTA DEL PEDIDO',
    )
  })

  it('la nota de un pedido sin nada en cocina no imprime nada', async () => {
    const t = await setup()
    await t.printer('Cocina', [t.kitchen])
    const sent = t.send()
    if (!sent) throw new Error('sin envío')
    const order = t.hub.order(sent.aggregate_id)
    const ids = Object.keys(order?.items ?? {})
    t.other(sent.aggregate_id, 'ItemServed', { item_ids: ids })
    const before = pendingList(t.m)
    t.other(sent.aggregate_id, 'OrderNoteChanged', { notes: 'cumpleaños' })
    expect(pendingList(t.m)).toBe(before)
  })
})
