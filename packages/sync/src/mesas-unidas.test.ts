import { newId, type OrderEvent } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AlmacenMemoria } from './hub/almacen'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { type Conexion, HubSync } from './hub/hub'
import { SalaSync } from './hub/sala'
import { accesoLibre } from './pruebas/acceso'
import { AHORA, baseSqlite, item, type Montaje, montar } from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// Tarea 1.5 en el hub: no se ocupa una mesa que otro pedido ya ocupa (también como mesa unida),
// ni al abrir, ni al cambiarse, ni al unir; mover productos exige estar en línea; y todo es por
// restaurante. Se prueba con eventos reales contra el hub, sin pasar por el cliente.

const conexionDe = (m: Montaje, node: Nodo) => {
  const connection = m.network.tokens.get(`token-${node.name}`)
  if (!connection) throw new Error(`Sin token para ${node.name}`)
  return connection
}

const CON_MOTIVO = new Set(['OrderCanceled', 'OrderReopened', 'ItemVoided'])

function device() {
  const m = montar()
  const ana = m.network.device('ana')
  const beto = m.network.device('beto')
  /** `conoce: false` manda `base_sequence: 0`: el equipo estaba sin conexión. */
  const mandar = (
    quien: Nodo,
    order: string,
    type: string,
    data: unknown,
    extras: Partial<Record<keyof OrderEvent, unknown>> & { conoce?: boolean } = {},
  ) => {
    const { conoce = true, ...rest } = extras
    const r = m.hub().recibirLote(conexionDe(m, quien), [
      {
        id: newId(),
        type,
        schema_version: 1,
        aggregate_type: 'order',
        aggregate_id: order,
        related: [],
        data,
        session_id: null,
        user_id: quien.userId,
        device_id: quien.dispositivoId,
        authorization_id: null,
        reason: CON_MOTIVO.has(type) ? 'Prueba' : null,
        device_time: AHORA,
        hub_estimated_time: AHORA,
        base_sequence: conoce ? m.almacen.maxSecuencia() : 0,
        ...rest,
      },
    ])
    return r.resultados[0]
  }
  const open = (quien: Nodo, table: string | null, extras = {}) => {
    const order = newId()
    const result = mandar(
      quien,
      order,
      'OrderOpened',
      { channel: 'dine_in', table_id: table, guests: 2 },
      extras,
    )
    return { order, result }
  }
  const merge = (quien: Nodo, order: string, tables: string[], extras = {}) =>
    mandar(quien, order, 'TablesMerged', { table_ids: tables }, extras)
  const separate = (quien: Nodo, order: string, tables: string[], extras = {}) =>
    mandar(quien, order, 'TablesSeparated', { table_ids: tables }, extras)
  const moveToTable = (quien: Nodo, order: string, table: string, extras = {}) =>
    mandar(quien, order, 'OrderMovedTable', { target_table_id: table }, extras)
  return { m, ana, beto, mandar, open, merge, separate, moveToTable }
}

describe('unir mesas en el hub', () => {
  it('unir una mesa libre se acepta y la mesa queda ocupada hasta separarla', () => {
    const { m, ana, open, merge, separate } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    expect(m.hub().tienePedidoAbierto(m2)).toBe(false)
    expect(merge(ana, order, [m2])).toMatchObject({ status: 'confirmed', conflict: null })
    expect(m.hub().tienePedidoAbierto(m2)).toBe(true)
    expect(m.hub().tienePedidoAbierto(m1)).toBe(true)
    expect(m.hub().order(order)?.mergedTables).toEqual([m2])
    expect(separate(ana, order, [m2])?.status).toBe('confirmed')
    expect(m.hub().tienePedidoAbierto(m2)).toBe(false)
    expect(m.hub().tienePedidoAbierto(m1)).toBe(true)
  })

  it('una mesa unida se libera al cerrar o cancelar el pedido y vuelve a ocuparse al reabrirlo', () => {
    const { m, ana, open, merge, mandar } = device()
    const [m1, m2, m3, m4] = [newId(), newId(), newId(), newId()]
    const a = open(ana, m1).order
    merge(ana, a, [m2])
    expect(mandar(ana, a, 'OrderClosed', {})?.status).toBe('confirmed')
    expect(m.hub().tienePedidoAbierto(m2)).toBe(false)
    expect(mandar(ana, a, 'OrderReopened', {})?.status).toBe('confirmed')
    expect(m.hub().tienePedidoAbierto(m2)).toBe(true)

    const b = open(ana, m3).order
    merge(ana, b, [m4])
    expect(mandar(ana, b, 'OrderCanceled', {})?.status).toBe('confirmed')
    expect(m.hub().tienePedidoAbierto(m4)).toBe(false)
    expect(m.hub().tienePedidoAbierto(m3)).toBe(false)
  })

  it('unir a un pedido sin mesa se rechaza por el reductor (sin_mesa), no por la mesa', () => {
    const { ana, open, merge } = device()
    const { order } = open(ana, null)
    expect(merge(ana, order, [newId()])).toMatchObject({
      status: 'rejected',
      reason: 'no_table',
    })
  })

  it('separar lo que no está unido se rechaza (mesas_no_unidas) y repetir la unión también', () => {
    const { ana, open, merge, separate } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    expect(separate(ana, order, [m2])).toMatchObject({
      status: 'rejected',
      reason: 'tables_not_merged',
    })
    merge(ana, order, [m2])
    expect(merge(ana, order, [m2])).toMatchObject({
      status: 'rejected',
      reason: 'tables_already_merged',
    })
  })

  it('la mesa unida de un pedido no deja unirla a otro: mesa_ocupada, sin importar lo que conozca', () => {
    const { ana, beto, open, merge } = device()
    const [m1, m2, m3] = [newId(), newId(), newId()]
    const one = open(ana, m1).order
    merge(ana, one, [m2])
    const two = open(beto, m3).order
    // Beto conoce todo: se rechaza.
    expect(merge(beto, two, [m2])).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
    // Beto estaba sin conexión: unir exige estar al día, también se rechaza.
    expect(merge(beto, two, [m2], { conoce: false })).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
  })

  it('unir la mesa principal de otro pedido también se rechaza', () => {
    const { ana, beto, open, merge } = device()
    const [m1, m3] = [newId(), newId()]
    open(ana, m1)
    const two = open(beto, m3).order
    expect(merge(beto, two, [m1])).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
    expect(merge(beto, two, [m1], { conoce: false })).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
  })

  it('una lista donde solo una mesa está ocupada se rechaza entera y no deja unida ninguna', () => {
    const { m, ana, beto, open, merge } = device()
    const [m1, free, ocupada] = [newId(), newId(), newId()]
    open(ana, ocupada)
    const two = open(beto, m1).order
    expect(merge(beto, two, [free, ocupada])).toMatchObject({ status: 'rejected' })
    expect(m.hub().order(two)?.mergedTables).toEqual([])
    expect(m.hub().tienePedidoAbierto(free)).toBe(false)
  })

  it('un pedido cerrado no ocupa nada: su mesa y sus unidas se pueden unir a otro', () => {
    const { ana, beto, open, merge, mandar } = device()
    const [m1, m2, m3] = [newId(), newId(), newId()]
    const one = open(ana, m1).order
    merge(ana, one, [m2])
    mandar(ana, one, 'OrderClosed', {})
    const two = open(beto, m3).order
    expect(merge(beto, two, [m1, m2])?.status).toBe('confirmed')
  })

  it('el rechazo es idempotente: reenviar el mismo evento da el mismo motivo', () => {
    const { m, ana, beto, open } = device()
    const [m1, m2] = [newId(), newId()]
    open(ana, m1)
    const two = open(beto, m2).order
    const event = {
      id: newId(),
      type: 'TablesMerged',
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: two,
      related: [],
      data: { table_ids: [m1] },
      session_id: null,
      user_id: beto.userId,
      device_id: beto.dispositivoId,
      authorization_id: null,
      reason: null,
      device_time: AHORA,
      hub_estimated_time: AHORA,
      base_sequence: m.almacen.maxSecuencia(),
    }
    const connection = conexionDe(m, beto)
    const a = m.hub().recibirLote(connection, [event]).resultados[0]
    const b = m.hub().recibirLote(connection, [event]).resultados[0]
    expect(a).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
    expect(b).toEqual(a)
  })
})

describe('abrir una mesa que otro pedido ocupa como unida', () => {
  it('si el equipo conocía el pedido, se rechaza como mesa_ocupada', () => {
    const { ana, beto, open, merge } = device()
    const [m1, m2] = [newId(), newId()]
    const one = open(ana, m1).order
    merge(ana, one, [m2])
    expect(open(beto, m2).result).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
  })

  it('si no lo conocía (sin conexión), se acepta y se avisa mesa_duplicada en caja', () => {
    const { m, ana, beto, open, merge } = device()
    const [m1, m2] = [newId(), newId()]
    const one = open(ana, m1).order
    merge(ana, one, [m2])
    const { result } = open(beto, m2, { conoce: false })
    expect(result).toMatchObject({ status: 'confirmed', conflict: 'duplicate_table' })
    expect(
      m
        .hub()
        .conflictos()
        .map((c) => c.type),
    ).toEqual(['duplicate_table'])
  })

  it('abrir en una mesa que dejó de estar unida es normal', () => {
    const { ana, beto, open, merge, separate } = device()
    const [m1, m2] = [newId(), newId()]
    const one = open(ana, m1).order
    merge(ana, one, [m2])
    separate(ana, one, [m2])
    expect(open(beto, m2).result).toMatchObject({ status: 'confirmed', conflict: null })
  })
})

describe('cambiarse de mesa', () => {
  it('a una mesa libre se acepta: libera la de antes y ocupa la nueva', () => {
    const { m, ana, open, moveToTable } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    expect(moveToTable(ana, order, m2)?.status).toBe('confirmed')
    expect(m.hub().tienePedidoAbierto(m1)).toBe(false)
    expect(m.hub().tienePedidoAbierto(m2)).toBe(true)
  })

  it('a una mesa ocupada se rechaza si el equipo conocía el otro pedido', () => {
    const { m, ana, beto, open, moveToTable } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    open(beto, m2)
    expect(moveToTable(ana, order, m2)).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
    expect(m.hub().order(order)?.tableId).toBe(m1)
  })

  it('a una mesa ocupada se rechaza también si el equipo no lo conocía: no es conflicto', () => {
    const { m, ana, beto, open, moveToTable } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    open(beto, m2)
    expect(moveToTable(ana, order, m2, { conoce: false })).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
    expect(m.hub().conflictos()).toEqual([])
  })

  it('a una mesa unida de otro pedido se rechaza', () => {
    const { ana, beto, open, merge, moveToTable } = device()
    const [m1, m2, m3] = [newId(), newId(), newId()]
    const { order } = open(ana, m1)
    const other = open(beto, m2).order
    merge(beto, other, [m3])
    expect(moveToTable(ana, order, m3)).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
    expect(moveToTable(ana, order, m3, { conoce: false })).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
  })

  it('a una de sus propias mesas unidas se acepta: la de antes queda libre', () => {
    const { m, ana, open, merge, moveToTable } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    merge(ana, order, [m2])
    expect(moveToTable(ana, order, m2)?.status).toBe('confirmed')
    expect(m.hub().order(order)).toMatchObject({ tableId: m2, mergedTables: [] })
    expect(m.hub().tienePedidoAbierto(m1)).toBe(false)
    expect(m.hub().tienePedidoAbierto(m2)).toBe(true)
  })

  it('a la mesa en la que ya está se acepta (no se choca consigo mismo)', () => {
    const { ana, open, moveToTable } = device()
    const m1 = newId()
    const { order } = open(ana, m1)
    expect(moveToTable(ana, order, m1)?.status).toBe('confirmed')
  })

  it('a la mesa de un pedido ya cerrado se acepta', () => {
    const { ana, beto, open, moveToTable, mandar } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    const other = open(beto, m2).order
    mandar(beto, other, 'OrderClosed', {})
    expect(moveToTable(ana, order, m2)?.status).toBe('confirmed')
  })

  it('dos equipos que quieren la misma mesa libre: gana el primero y el segundo se rechaza', () => {
    const { m, ana, beto, open, moveToTable } = device()
    const [m1, m2, free] = [newId(), newId(), newId()]
    const a = open(ana, m1).order
    const b = open(beto, m2).order
    expect(moveToTable(ana, a, free)?.status).toBe('confirmed')
    expect(moveToTable(beto, b, free, { conoce: false })).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
    expect(m.hub().order(b)?.tableId).toBe(m2)
  })

  it('dos pedidos que se unen a la misma libre: solo el primero queda con ella', () => {
    const { m, ana, beto, open, merge } = device()
    const [m1, m2, free] = [newId(), newId(), newId()]
    const a = open(ana, m1).order
    const b = open(beto, m2).order
    expect(merge(ana, a, [free])?.status).toBe('confirmed')
    expect(merge(beto, b, [free], { conoce: false })).toMatchObject({
      status: 'rejected',
      reason: 'table_occupied',
    })
    expect(m.hub().order(b)?.mergedTables).toEqual([])
  })
})

describe('un pedido vacío después de tener productos ya no ocupa su mesa', () => {
  const copy = (i: ReturnType<typeof item>) => {
    const { catalog_version: _v, price_channel_id: _c, ...rest } = i
    return rest
  }

  it('uno recién abierto, sin productos, sí la ocupa (y sus unidas también)', () => {
    const { m, ana, beto, open, merge } = device()
    const [m1, m2] = [newId(), newId()]
    const { order } = open(ana, m1)
    merge(ana, order, [m2])
    expect(m.hub().tienePedidoAbierto(m1)).toBe(true)
    expect(m.hub().tienePedidoAbierto(m2)).toBe(true)
    expect(open(beto, m1).result).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
  })

  it('al mover todos sus productos a otro pedido, su mesa y sus unidas quedan libres', () => {
    const { m, ana, beto, open, merge, mandar } = device()
    const [m1, m2, m3] = [newId(), newId(), newId()]
    const { order: source } = open(ana, m1)
    merge(ana, source, [m2])
    const it = item(12_900)
    mandar(ana, source, 'ItemAdded', it)
    mandar(ana, source, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    expect(m.hub().tienePedidoAbierto(m1)).toBe(true)
    const target = open(ana, m3).order
    const r = mandar(
      ana,
      source,
      'ItemsMoved',
      {
        target_order_id: target,
        items: [{ item: copy(it), status: 'sent', voided_quantity: 0, added_by: ana.userId }],
      },
      { related: [target] },
    )
    expect(r?.status).toBe('confirmed')
    // El origen sigue abierto pero vacío: ya no ocupa nada.
    expect(m.hub().order(source)?.status).toBe('open')
    expect(m.hub().tienePedidoAbierto(m1)).toBe(false)
    expect(m.hub().tienePedidoAbierto(m2)).toBe(false)
    expect(m.hub().tienePedidoAbierto(m3)).toBe(true)
    // Otro equipo puede abrir esas mesas, y cambiarse o unir a ellas.
    expect(open(beto, m1).result).toMatchObject({ status: 'confirmed', conflict: null })
    const other = open(beto, newId()).order
    expect(merge(beto, other, [m2])?.status).toBe('confirmed')
  })

  it('al anular todo lo que tenía, también se libera; con una unidad viva, no', () => {
    const { m, ana, open, mandar } = device()
    const m1 = newId()
    const { order } = open(ana, m1)
    const it = item(12_900, { quantity: 2 })
    mandar(ana, order, 'ItemAdded', it)
    mandar(ana, order, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    const voidItem = (quantity: number) =>
      mandar(ana, order, 'ItemVoided', {
        item_id: it.item_id,
        quantity,
        already_prepared: false,
        ticket_id: null,
      })
    expect(voidItem(1)?.status).toBe('confirmed')
    expect(m.hub().tienePedidoAbierto(m1)).toBe(true)
    expect(voidItem(1)?.status).toBe('confirmed')
    expect(m.hub().tienePedidoAbierto(m1)).toBe(false)
  })

  it('un pedido solo con lo ya entregado sigue ocupando la mesa (la cuenta no está cerrada)', () => {
    const { m, ana, open, mandar } = device()
    const m1 = newId()
    const { order } = open(ana, m1)
    const it = item()
    mandar(ana, order, 'ItemAdded', it)
    mandar(ana, order, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    mandar(ana, order, 'ItemServed', { item_ids: [it.item_id] })
    expect(m.hub().tienePedidoAbierto(m1)).toBe(true)
  })

  it('cambiarse a la mesa de un pedido vaciado se acepta', () => {
    const { ana, beto, open, mandar, moveToTable } = device()
    const [m1, m2] = [newId(), newId()]
    const empty = open(ana, m1).order
    const it = item()
    mandar(ana, empty, 'ItemAdded', it)
    mandar(ana, empty, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    mandar(ana, empty, 'ItemVoided', {
      item_id: it.item_id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    const other = open(beto, m2).order
    expect(moveToTable(beto, other, m1)?.status).toBe('confirmed')
  })

  // Un pedido vaciado suelta su mesa pero conserva `tableId`: si otro la toma y el vaciado recibe un
  // producto, volvería a ocuparla; el hub lo revisa como al abrir (`mesasQueToma`).
  it('agregar un producto a un pedido vaciado cuya mesa tomó otro se rechaza o se avisa', () => {
    const { ana, beto, open, mandar } = device()
    const m1 = newId()
    const { order } = open(ana, m1)
    const it = item()
    mandar(ana, order, 'ItemAdded', it)
    mandar(ana, order, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    mandar(ana, order, 'ItemVoided', {
      item_id: it.item_id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    expect(open(beto, m1).result?.status).toBe('confirmed')
    const r = mandar(ana, order, 'ItemAdded', item())
    expect(r?.status === 'rejected' || (r?.status === 'confirmed' && r.conflict !== null)).toBe(
      true,
    )
  })

  it('quitar lo que aún no se enviaba no suelta la mesa: otro mesero no puede abrirla', () => {
    const { ana, beto, open, mandar } = device()
    const m1 = newId()
    const { order } = open(ana, m1)
    const it = item()
    mandar(ana, order, 'ItemAdded', it)
    mandar(ana, order, 'ItemRemoved', { item_id: it.item_id })
    expect(open(beto, m1).result?.status).toBe('rejected')
  })

  // Reabrir una cuenta cuya mesa ya tomó otro pedido no deja dos pedidos abiertos en la mesa.
  it('reabrir una cuenta cuya mesa otro pedido ya tomó se rechaza o se avisa', () => {
    const { ana, beto, open, mandar } = device()
    const m1 = newId()
    const { order } = open(ana, m1)
    mandar(ana, order, 'OrderClosed', {})
    open(beto, m1)
    const r = mandar(ana, order, 'OrderReopened', {})
    expect(r?.status === 'rejected' || (r?.status === 'confirmed' && r.conflict !== null)).toBe(
      true,
    )
  })
})

describe('tienePedidoAbierto con mesas unidas', () => {
  it('cuenta las unidas, también tras reiniciar el hub y desde SalaSync', () => {
    const { m, ana, open, merge } = device()
    const [m1, m2, another] = [newId(), newId(), newId()]
    const { order } = open(ana, m1)
    merge(ana, order, [m2])
    expect(m.network.sala.tienePedidoAbierto(m2)).toBe(true)
    m.network.crashHub()
    expect(m.hub().tienePedidoAbierto(m2)).toBe(true)
    expect(m.hub().tienePedidoAbierto(another)).toBe(false)
    expect(m.network.sala.tienePedidoAbierto(m2)).toBe(true)
  })

  it('con el hub en memoria (sin SQLite) responde igual', () => {
    const hub = new HubSync(new AlmacenMemoria(), {
      restauranteId: '',
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-1',
      clock: () => AHORA,
      access: accesoLibre,
    })
    const withIt: Conexion = { dispositivoId: newId(), type: 'waiter', revocadoEn: null }
    const user = newId()
    const [m1, m2] = [newId(), newId()]
    const order = newId()
    const base = (type: string, data: unknown, base_sequence: number) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: order,
      related: [],
      data,
      session_id: null,
      user_id: user,
      device_id: withIt.dispositivoId,
      authorization_id: null,
      reason: null,
      device_time: AHORA,
      hub_estimated_time: AHORA,
      base_sequence,
    })
    const r = hub.recibirLote(withIt, [
      base('OrderOpened', { channel: 'dine_in', table_id: m1, guests: 2 }, 0),
      base('TablesMerged', { table_ids: [m2] }, 1),
    ])
    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(hub.tienePedidoAbierto(m2)).toBe(true)
  })

  it('una mesa unida a un pedido con otras unidas: solo esas cuentan', () => {
    const { m, ana, open, merge, separate } = device()
    const tables = Array.from({ length: 5 }, () => newId())
    const { order } = open(ana, tables[0] as string)
    merge(ana, order, tables.slice(1, 4))
    separate(ana, order, [tables[2] as string])
    expect(tables.map((x) => m.hub().tienePedidoAbierto(x))).toEqual([
      true,
      true,
      false,
      true,
      false,
    ])
  })
})

describe('mover productos a otra mesa', () => {
  const copy = (i: ReturnType<typeof item>) => {
    const { catalog_version: _v, price_channel_id: _c, ...rest } = i
    return rest
  }

  function conPlatoEnviado() {
    const e = device()
    const m1 = newId()
    const source = e.open(e.ana, m1).order
    const it = item(12_900, { quantity: 2 })
    e.mandar(e.ana, source, 'ItemAdded', it)
    e.mandar(e.ana, source, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }],
    })
    const movement = (target: string, extras = {}) => ({
      order: source,
      type: 'ItemsMoved',
      data: {
        target_order_id: target,
        items: [
          {
            item: copy(it),
            status: 'sent',
            voided_quantity: 0,
            added_by: e.ana.userId,
          },
        ],
      },
      extras: { related: [target], ...extras },
    })
    return { ...e, source, it, movement }
  }

  it('a una mesa libre, en un lote: se abre el pedido y se mueve, todo o nada', () => {
    const e = conPlatoEnviado()
    const target = newId()
    const free = newId()
    const hub = e.m.hub()
    const connection = conexionDe(e.m, e.ana)
    const base = e.m.almacen.maxSecuencia()
    const mov = e.movement(target)
    const envelope = (type: string, order: string, data: unknown, extras = {}) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: order,
      related: [],
      data,
      session_id: null,
      user_id: e.ana.userId,
      device_id: e.ana.dispositivoId,
      authorization_id: null,
      reason: null,
      device_time: AHORA,
      hub_estimated_time: AHORA,
      base_sequence: base,
      ...extras,
    })
    const r = hub.recibirLote(connection, [
      envelope('OrderOpened', target, { channel: 'dine_in', table_id: free, guests: 1 }),
      envelope('ItemsMoved', mov.order, mov.data, mov.extras),
    ])
    expect(r.resultados.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(hub.order(target)?.items[e.it.item_id]).toMatchObject({
      status: 'sent',
      quantity: 2,
    })
    expect(hub.order(e.source)?.items).toEqual({})
    expect(hub.tienePedidoAbierto(free)).toBe(true)
  })

  it('si la mesa del pedido nuevo está ocupada, se rechaza la apertura y también el movimiento', () => {
    const e = conPlatoEnviado()
    const ocupada = newId()
    e.open(e.beto, ocupada)
    const target = newId()
    const mov = e.movement(target)
    const base = e.m.almacen.maxSecuencia()
    const envelope = (type: string, order: string, data: unknown, extras = {}) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: order,
      related: [],
      data,
      session_id: null,
      user_id: e.ana.userId,
      device_id: e.ana.dispositivoId,
      authorization_id: null,
      reason: null,
      device_time: AHORA,
      hub_estimated_time: AHORA,
      base_sequence: base,
      ...extras,
    })
    const r = e.m
      .hub()
      .recibirLote(conexionDe(e.m, e.ana), [
        envelope('OrderOpened', target, { channel: 'dine_in', table_id: ocupada, guests: 1 }),
        envelope('ItemsMoved', mov.order, mov.data, mov.extras),
      ])
    expect(r.resultados[0]).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
    expect(r.resultados[1]).toMatchObject({ status: 'rejected', reason: 'depends_on_rejected' })
    // El plato sigue donde estaba.
    expect(e.m.hub().order(e.source)?.items[e.it.item_id]?.status).toBe('sent')
  })

  it('a un pedido que ya existe con otro equipo al día se acepta sin conflicto', () => {
    const e = conPlatoEnviado()
    const target = e.open(e.beto, newId()).order
    const mov = e.movement(target)
    const r = e.mandar(e.ana, mov.order, mov.type, mov.data, mov.extras)
    expect(r).toMatchObject({ status: 'confirmed', conflict: null })
  })

  it('sin estar al día y con el plato ya anulado por otro equipo: se rechaza, no es conflicto', () => {
    const e = conPlatoEnviado()
    const target = e.open(e.ana, newId()).order
    const baseDeAna = e.m.almacen.maxSecuencia()
    // Beto anula todo el plato mientras Ana no se entera.
    expect(
      e.mandar(e.beto, e.source, 'ItemVoided', {
        item_id: e.it.item_id,
        quantity: 2,
        already_prepared: false,
        ticket_id: null,
      })?.status,
    ).toBe('confirmed')
    const mov = e.movement(target)
    const r = e.mandar(e.ana, mov.order, mov.type, mov.data, {
      ...mov.extras,
      base_sequence: baseDeAna,
    })
    expect(r).toMatchObject({ status: 'rejected' })
    expect(e.m.hub().conflictos()).toEqual([])
    expect(e.m.hub().order(target)?.items).toEqual({})
  })

  it('en contraste, anular sin estar al día lo que otro ya anuló sí se acepta como conflicto', () => {
    const e = conPlatoEnviado()
    const baseDeAna = e.m.almacen.maxSecuencia()
    const voidItem = (quien: Nodo, extras = {}) =>
      e.mandar(
        quien,
        e.source,
        'ItemVoided',
        { item_id: e.it.item_id, quantity: 2, already_prepared: false, ticket_id: null },
        extras,
      )
    voidItem(e.beto)
    expect(voidItem(e.ana, { base_sequence: baseDeAna })).toMatchObject({
      status: 'confirmed',
      conflict: 'item_already_voided',
    })
  })

  it('sin estar al día, con la copia desfasada (otro anuló una unidad): copia_distinta, rechazado', () => {
    const e = conPlatoEnviado()
    const target = e.open(e.ana, newId()).order
    const baseDeAna = e.m.almacen.maxSecuencia()
    e.mandar(e.beto, e.source, 'ItemVoided', {
      item_id: e.it.item_id,
      quantity: 1,
      already_prepared: false,
      ticket_id: null,
    })
    const mov = e.movement(target)
    expect(
      e.mandar(e.ana, mov.order, mov.type, mov.data, {
        ...mov.extras,
        base_sequence: baseDeAna,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'mismatched_copy' })
  })

  it('al día y con un plato que ya no está en el origen: rechazado (item_inexistente)', () => {
    const e = conPlatoEnviado()
    const target = e.open(e.ana, newId()).order
    const mov = e.movement(target)
    expect(e.mandar(e.ana, mov.order, mov.type, mov.data, mov.extras)?.status).toBe('confirmed')
    // Moverlo otra vez desde el origen: ya no está.
    expect(e.mandar(e.ana, mov.order, mov.type, mov.data, mov.extras)).toMatchObject({
      status: 'rejected',
      reason: 'item_not_found',
    })
  })

  it('el mismo movimiento reenviado (respuesta perdida) da la misma respuesta y no mueve dos veces', () => {
    const e = conPlatoEnviado()
    const target = e.open(e.ana, newId()).order
    const mov = e.movement(target)
    const event = {
      id: newId(),
      type: mov.type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: mov.order,
      related: [target],
      data: mov.data,
      session_id: null,
      user_id: e.ana.userId,
      device_id: e.ana.dispositivoId,
      authorization_id: null,
      reason: null,
      device_time: AHORA,
      hub_estimated_time: AHORA,
      base_sequence: e.m.almacen.maxSecuencia(),
    }
    const connection = conexionDe(e.m, e.ana)
    const a = e.m.hub().recibirLote(connection, [event])
    const b = e.m.hub().recibirLote(connection, [event])
    expect(a.resultados[0]?.status).toBe('confirmed')
    expect(b.resultados).toEqual(a.resultados)
    expect(b.aceptados).toEqual([])
    expect(Object.keys(e.m.hub().order(target)?.items ?? {})).toEqual([e.it.item_id])
  })

  it('el evento llega a los dos pedidos: el hub lo cuenta en el origen y en el destino', () => {
    const e = conPlatoEnviado()
    const target = e.open(e.ana, newId()).order
    const mov = e.movement(target)
    e.mandar(e.ana, mov.order, mov.type, mov.data, mov.extras)
    const dedestino = e.m.almacen.eventosDeAgregado(target).map((x) => x.type)
    expect(dedestino).toEqual(['OrderOpened', 'ItemsMoved'])
  })
})

describe('varios restaurantes en la misma base', () => {
  function dosHubs() {
    const { db, restauranteId } = baseSqlite()
    const other = newId()
    db.prepare(
      `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
       VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
    ).run(other, other, AHORA, AHORA)
    const crear = (id: string) =>
      new HubSync(new AlmacenSqlite(db, id), {
        restauranteId: id,
        timeZone: 'America/Bogota',
        inicioDiaOperativo: '06:00',
        instancia: `hub-${id}`,
        clock: () => AHORA,
        access: accesoLibre,
      })
    return { db, one: crear(restauranteId), two: crear(other), restauranteId, other }
  }
  const deviceConn = (): Conexion => ({
    dispositivoId: newId(),
    type: 'waiter',
    revocadoEn: null,
  })
  const envelope = (
    withIt: Conexion,
    order: string,
    type: string,
    data: unknown,
    base_sequence = 0,
  ) => ({
    id: newId(),
    type,
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: order,
    related: [],
    data,
    session_id: null,
    user_id: newId(),
    device_id: withIt.dispositivoId,
    authorization_id: null,
    reason: null,
    device_time: AHORA,
    hub_estimated_time: AHORA,
    base_sequence,
  })

  it('la misma mesa en dos restaurantes no choca: ni al abrir, ni al unir, ni al cambiarse', () => {
    const { one, two } = dosHubs()
    const [cUno, cDos] = [deviceConn(), deviceConn()]
    const [table, another] = [newId(), newId()]
    const a = newId()
    const b = newId()
    expect(
      one.recibirLote(cUno, [
        envelope(cUno, a, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 1 }),
      ]).resultados[0]?.status,
    ).toBe('confirmed')
    expect(
      two.recibirLote(cDos, [
        envelope(cDos, b, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 1 }),
      ]).resultados[0],
    ).toMatchObject({ status: 'confirmed', conflict: null })
    // Unirla en uno no la ocupa en el otro.
    one.recibirLote(cUno, [envelope(cUno, a, 'TablesMerged', { table_ids: [another] }, 1)])
    expect(one.tienePedidoAbierto(another)).toBe(true)
    expect(two.tienePedidoAbierto(another)).toBe(false)
    expect(
      two.recibirLote(cDos, [envelope(cDos, b, 'OrderMovedTable', { target_table_id: another }, 1)])
        .resultados[0]?.status,
    ).toBe('confirmed')
  })

  it('cada hub solo ve y numera lo suyo', () => {
    const { one, two, db, restauranteId, other } = dosHubs()
    const [cUno, cDos] = [deviceConn(), deviceConn()]
    const table = newId()
    one.recibirLote(cUno, [
      envelope(cUno, newId(), 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 1 }),
    ])
    expect(two.tienePedidoAbierto(table)).toBe(false)
    two.recibirLote(cDos, [
      envelope(cDos, newId(), 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 1 }),
    ])
    const check = (r: string) =>
      db.prepare('SELECT count(*) AS n FROM events WHERE restaurant_id = ?').get(r)?.n
    expect([check(restauranteId), check(other)]).toEqual([1, 1])
    // Un hub nuevo sobre la misma base reconstruye solo lo de su restaurante.
    const reiniciado = new HubSync(new AlmacenSqlite(db, restauranteId), {
      restauranteId,
      timeZone: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-new',
      clock: () => AHORA,
      access: accesoLibre,
    })
    expect(reiniciado.tienePedidoAbierto(table)).toBe(true)
    expect(new SalaSync(reiniciado, () => null).tienePedidoAbierto(table)).toBe(true)
  })
})
