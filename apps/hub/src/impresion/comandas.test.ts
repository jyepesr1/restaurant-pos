import { newId } from '@pos/core'
import { leerEscpos } from '@pos/printing'
import { HubSync } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { montarAcceso } from '../acceso/montaje'
import { ABRIR, item } from '../acceso/montaje-hub'
import { insertarVersionado, SISTEMA } from '../acceso/registros'
import { ColaImpresion } from './cola'
import { trabajosDeEvento } from './comandas'
import { abrirImpresoraDePrueba, type ImpresoraDePrueba } from './impresora-prueba'

// De punta a punta en el hub (ADR-015): el mesero envía, el hub guarda la comanda en la cola en
// la misma transacción del evento y la cola la manda a la impresora de red de la estación.

const abiertas: ImpresoraDePrueba[] = []
afterEach(async () => {
  for (const i of abiertas.splice(0)) await i.close()
})

async function montar() {
  const m = montarAcceso()
  const ahora = m.clock()
  const kitchen = insertarVersionado(
    m.db,
    'stations',
    m.restauranteId,
    { name: 'Cocina', position: 1 },
    SISTEMA,
    ahora,
  )
  const bar = insertarVersionado(
    m.db,
    'stations',
    m.restauranteId,
    { name: 'Barra', position: 2 },
    SISTEMA,
    ahora,
  )
  const options = { db: m.db, restauranteId: m.restauranteId, timeZone: 'America/Bogota' }
  const cola = new ColaImpresion({ db: m.db, restauranteId: m.restauranteId })
  const hub = new HubSync(new AlmacenSqlite(m.db, m.restauranteId), {
    restauranteId: m.restauranteId,
    timeZone: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-1',
    clock: m.clock,
    access: m.access,
    onSave: (event, changes) => {
      trabajosDeEvento(options, event, changes)
    },
  })
  const printer = async (name: string, stations: string[], respaldo: string | null = null) => {
    const mockPrinter = await abrirImpresoraDePrueba()
    abiertas.push(mockPrinter)
    const id = insertarVersionado(
      m.db,
      'printers',
      m.restauranteId,
      {
        name,
        connection: 'network',
        address: '127.0.0.1',
        port: mockPrinter.port,
        width: 80,
        code_page: 'pc850',
        fallback_id: respaldo,
        station_ids: JSON.stringify(stations),
      },
      SISTEMA,
      ahora,
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
    const r = hub.recibirLote(connection, [
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
    expect(r.resultados.map((x) => x.status)).toEqual([
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
    ])
    return r.aceptados.at(-1)
  }
  /** Un evento más del mismo equipo, después de todo lo que ya hay. */
  const other = (order: string, type: Parameters<typeof m.event>[2], data: object) => {
    const base = m.db.prepare('SELECT coalesce(max(sequence), 0) AS s FROM events').get()
      ?.s as number
    return hub.recibirLote(connection, [
      m.event(connection, session, type, data, { aggregate_id: order, base_sequence: base }),
    ])
  }
  return { m, cola, hub, kitchen, bar, printer, send, other }
}

const pendingList = (m: ReturnType<typeof montarAcceso>) =>
  Number(m.db.prepare("SELECT count(*) AS n FROM print_jobs WHERE status = 'pending'").get()?.n)

describe('comandas impresas', () => {
  it('cada estación imprime lo suyo, con número del día seguido', async () => {
    const t = await montar()
    const kitchen = await t.printer('Cocina', [t.kitchen])
    const bar = await t.printer('Barra', [t.bar])
    const sent = t.send()
    expect(Object.values(sent?.assignments.ticket_numbers ?? {})).toEqual([1, 2])
    expect(pendingList(t.m)).toBe(2)
    await t.cola.runOnce()
    expect(pendingList(t.m)).toBe(0)
    await kitchen.mockPrinter.esperar(1)
    await bar.mockPrinter.esperar(1)
    const enCocina = leerEscpos(kitchen.mockPrinter.recibidos[0] as Uint8Array).text
    expect(enCocina).toContain('COCINA')
    expect(enCocina).toContain('Tagliata')
    expect(enCocina).toContain('> Término medio')
    expect(enCocina).toMatch(/Mesa +#1/)
    expect(enCocina).not.toContain('Aperol')
    expect(leerEscpos(bar.mockPrinter.recibidos[0] as Uint8Array).text).toContain('Aperol Spritz')
    // Un segundo envío sigue la numeración del día.
    const other = t.send()
    expect(Object.values(other?.assignments.ticket_numbers ?? {})).toEqual([3, 4])
  })

  it('una estación sin impresora no deja trabajos', async () => {
    const t = await montar()
    await t.printer('Barra', [t.bar])
    t.send()
    expect(pendingList(t.m)).toBe(1)
  })

  it('si la impresora no responde, se reintenta, y a los 3 fallos sale por la de respaldo', async () => {
    const t = await montar()
    const respaldo = await t.printer('Respaldo', [])
    const kitchen = await t.printer('Cocina', [t.kitchen], respaldo.id)
    await kitchen.mockPrinter.apagar(true)
    let ahora = Date.now()
    const cola = new ColaImpresion({
      db: t.m.db,
      restauranteId: t.m.restauranteId,
      clock: () => ahora,
    })
    t.send()
    for (let i = 0; i < 3; i++) {
      if (i > 0) ahora += 60_000
      await cola.runOnce()
    }
    expect(cola.status().find((e) => e.id === kitchen.id)?.status).toBe('failed')
    expect(kitchen.mockPrinter.recibidos).toHaveLength(0)
    await cola.runOnce()
    await respaldo.mockPrinter.esperar(1)
    expect(respaldo.mockPrinter.recibidos).toHaveLength(1)
    expect(leerEscpos(respaldo.mockPrinter.recibidos[0] as Uint8Array).text).toContain('Tagliata')
    const fila = t.m.db.prepare("SELECT * FROM print_jobs WHERE type = 'ticket'").get()
    expect(fila?.status).toBe('printed')
    expect(fila?.printed_on_id).toBe(respaldo.id)
    expect(Number(fila?.attempts)).toBe(4)
  })

  it('el reintento del mismo envío no duplica la comanda', async () => {
    const t = await montar()
    await t.printer('Cocina', [t.kitchen])
    const event = t.send()
    if (!event) throw new Error('sin evento')
    const changes = [{ before: null, after: t.hub.order(event.aggregate_id) }]
    // Ya enviado: no queda nada «pendiente → enviado» y no se arma nada nuevo.
    expect(
      trabajosDeEvento(
        { db: t.m.db, restauranteId: t.m.restauranteId, timeZone: 'America/Bogota' },
        event,
        changes,
      ),
    ).toBe(0)
    expect(pendingList(t.m)).toBe(1)
  })

  it('la principal se vuelve a probar al vencer su espera y, si ya responde, imprime lo suyo', async () => {
    const t = await montar()
    const respaldo = await t.printer('Respaldo', [])
    const kitchen = await t.printer('Cocina', [t.kitchen], respaldo.id)
    await kitchen.mockPrinter.apagar(true)
    let ahora = Date.now()
    const cola = new ColaImpresion({
      db: t.m.db,
      restauranteId: t.m.restauranteId,
      clock: () => ahora,
    })
    t.send()
    for (let i = 0; i < 3; i++) {
      if (i > 0) ahora += 60_000
      await cola.runOnce()
    }
    await kitchen.mockPrinter.apagar(false)
    ahora += 60_000
    t.send()
    await cola.runOnce()
    await cola.runOnce()
    await kitchen.mockPrinter.esperar(2)
    expect(kitchen.mockPrinter.recibidos).toHaveLength(2)
    expect(respaldo.mockPrinter.recibidos).toHaveLength(0)
    expect(cola.status().find((e) => e.id === kitchen.id)?.status).toBe('ready')
  })

  it('cambiar la nota del pedido con platos en cocina imprime «NOTA NUEVA» en cada estación con algo pendiente', async () => {
    const t = await montar()
    const kitchen = await t.printer('Cocina', [t.kitchen])
    const bar = await t.printer('Barra', [t.bar])
    const sent = t.send()
    if (!sent) throw new Error('sin envío')
    await t.cola.runOnce()
    const r = t.other(sent.aggregate_id, 'OrderNoteChanged', { notes: 'alérgico al maní' })
    expect(r.resultados[0]?.status).toBe('confirmed')
    await t.cola.runOnce()
    await kitchen.mockPrinter.esperar(2)
    await bar.mockPrinter.esperar(2)
    const note = leerEscpos(kitchen.mockPrinter.recibidos[1] as Uint8Array).text
    expect(note).toContain('NOTA NUEVA')
    expect(note).toContain('NOTA DEL PEDIDO: alérgico al maní')
    expect(leerEscpos(bar.mockPrinter.recibidos[1] as Uint8Array).text).toContain(
      'alérgico al maní',
    )

    // Quitarla también se avisa en papel.
    t.other(sent.aggregate_id, 'OrderNoteChanged', { notes: null })
    await t.cola.runOnce()
    await kitchen.mockPrinter.esperar(3)
    expect(leerEscpos(kitchen.mockPrinter.recibidos[2] as Uint8Array).text).toContain(
      'SE QUITÓ LA NOTA DEL PEDIDO',
    )
  })

  it('la nota de un pedido sin nada en cocina no imprime nada', async () => {
    const t = await montar()
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
