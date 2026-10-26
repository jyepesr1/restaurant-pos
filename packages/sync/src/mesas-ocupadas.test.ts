import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AHORA, item, type Montaje, montar } from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// `tienePedidoAbierto` (tarea 1.2): lo que consulta el editor del plano antes de archivar una
// mesa. Se prueba con eventos reales contra el hub, sin pasar por el cliente.

const conexionDe = (m: Montaje, node: Nodo) => {
  const connection = m.network.tokens.get(`token-${node.name}`)
  if (!connection) throw new Error(`Sin token para ${node.name}`)
  return connection
}

const CON_MOTIVO = new Set(['OrderCanceled', 'OrderReopened'])

function device() {
  const m = montar()
  const node = m.network.device('ana')
  const other = m.network.device('beto')
  // Por defecto el dispositivo conoce todo lo del hub (base_sequence = la última).
  const enviarDe = (
    quien: Nodo,
    order: string,
    type: string,
    data: unknown,
    extras: object = {},
  ) => {
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
        base_sequence: m.almacen.maxSecuencia(),
        ...extras,
      },
    ])
    return r.resultados[0]
  }
  const send = (order: string, type: string, data: unknown, extras: object = {}) =>
    enviarDe(node, order, type, data, extras)
  const open = (table: string | null, order = newId()) => {
    const r = send(order, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 2 })
    return { order, result: r }
  }
  return { m, node, other, send, enviarDe, open }
}

describe('HubSync.tienePedidoAbierto', () => {
  it('una mesa sin pedidos, o que no existe, no está ocupada', () => {
    const { m } = device()
    expect(m.hub().tienePedidoAbierto(newId())).toBe(false)
    expect(m.hub().tienePedidoAbierto('')).toBe(false)
  })

  it('se ocupa al abrir el pedido y se libera al cerrarlo', () => {
    const { m, send, open } = device()
    const table = newId()
    const { order } = open(table)
    expect(m.hub().tienePedidoAbierto(table)).toBe(true)
    expect(send(order, 'OrderClosed', {})?.status).toBe('confirmed')
    expect(m.hub().tienePedidoAbierto(table)).toBe(false)
  })

  it('se libera al cancelar el pedido', () => {
    const { m, send, open } = device()
    const table = newId()
    const { order } = open(table)
    send(order, 'ItemAdded', item())
    expect(m.hub().tienePedidoAbierto(table)).toBe(true)
    expect(send(order, 'OrderCanceled', {})?.status).toBe('confirmed')
    expect(m.hub().tienePedidoAbierto(table)).toBe(false)
  })

  it('un pedido reabierto vuelve a ocupar su mesa', () => {
    const { m, send, open } = device()
    const table = newId()
    const { order } = open(table)
    send(order, 'OrderClosed', {})
    expect(m.hub().tienePedidoAbierto(table)).toBe(false)
    expect(send(order, 'OrderReopened', {})?.status).toBe('confirmed')
    expect(m.hub().tienePedidoAbierto(table)).toBe(true)
  })

  it('un pedido que no se pudo cerrar (saldo pendiente) sigue ocupando la mesa', () => {
    const { m, send, open } = device()
    const table = newId()
    const { order } = open(table)
    send(order, 'ItemAdded', item())
    expect(send(order, 'OrderClosed', {})).toMatchObject({
      status: 'rejected',
      reason: 'pending_balance',
    })
    expect(m.hub().tienePedidoAbierto(table)).toBe(true)
  })

  it('mover el pedido a otra mesa libera la de origen y ocupa la de destino', () => {
    const { m, send, open } = device()
    const source = newId()
    const target = newId()
    const { order } = open(source)
    send(order, 'OrderMovedTable', { target_table_id: target })
    expect(m.hub().tienePedidoAbierto(source)).toBe(false)
    expect(m.hub().tienePedidoAbierto(target)).toBe(true)
  })

  it('un pedido sin mesa (barra, para llevar) no ocupa ninguna', () => {
    const { m, open } = device()
    open(null)
    expect(m.hub().tienePedidoAbierto(newId())).toBe(false)
  })

  it('con varios pedidos en la misma mesa (conflicto), sigue ocupada hasta cerrar el último', () => {
    const { m, other, send, enviarDe, open } = device()
    const table = newId()
    const one = open(table)
    // Otro mesero abre la misma mesa sin saber del primer pedido (base_sequence 0): se acepta y
    // se avisa en caja.
    const two = newId()
    const r = enviarDe(
      other,
      two,
      'OrderOpened',
      { channel: 'dine_in', table_id: table, guests: 1 },
      { base_sequence: 0 },
    )
    expect(r).toMatchObject({ status: 'confirmed', conflict: 'duplicate_table' })
    send(one.order, 'OrderClosed', {})
    expect(m.hub().tienePedidoAbierto(table)).toBe(true)
    enviarDe(other, two, 'OrderClosed', {})
    expect(m.hub().tienePedidoAbierto(table)).toBe(false)
  })

  it('un pedido rechazado (mesa ocupada que el dispositivo conocía) no cuenta dos veces', () => {
    const { m, other: beto, send, enviarDe } = device()
    const table = newId()
    const one = newId()
    send(one, 'OrderOpened', { channel: 'dine_in', table_id: table, guests: 2 })
    // Beto ya conocía el primer pedido (su base es la última): se rechaza.
    const other = enviarDe(beto, newId(), 'OrderOpened', {
      channel: 'dine_in',
      table_id: table,
      guests: 1,
    })
    expect(other).toMatchObject({ status: 'rejected', reason: 'table_occupied' })
    send(one, 'OrderClosed', {})
    expect(m.hub().tienePedidoAbierto(table)).toBe(false)
  })

  it('al reiniciar el hub, las mesas ocupadas se reconstruyen de los eventos guardados', () => {
    const { m, send, open } = device()
    const ocupada = newId()
    const cerrada = newId()
    const cancelada = newId()
    open(ocupada)
    send(open(cerrada).order, 'OrderClosed', {})
    send(open(cancelada).order, 'OrderCanceled', {})
    m.network.crashHub()
    const fresh = m.hub()
    expect(fresh.tienePedidoAbierto(ocupada)).toBe(true)
    expect(fresh.tienePedidoAbierto(cerrada)).toBe(false)
    expect(fresh.tienePedidoAbierto(cancelada)).toBe(false)
  })

  it('SalaSync responde lo mismo que el hub', () => {
    const { m, open } = device()
    const table = newId()
    open(table)
    expect(m.network.sala.tienePedidoAbierto(table)).toBe(true)
    expect(m.network.sala.tienePedidoAbierto(newId())).toBe(false)
  })

  it('lo consulta bien con muchos pedidos abiertos y cerrados', () => {
    const { m, send, open } = device()
    const tables = Array.from({ length: 60 }, () => newId())
    const orders = tables.map((table) => open(table).order)
    // Se cierran las pares.
    for (const [i, p] of orders.entries()) if (i % 2 === 0) send(p, 'OrderClosed', {})
    for (const [i, table] of tables.entries())
      expect(m.hub().tienePedidoAbierto(table)).toBe(i % 2 === 1)
  })
})
