import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { AHORA, item, type Montaje, montar } from './pruebas/montaje'
import type { Nodo } from './pruebas/red'

// `tienePedidoAbierto` (tarea 1.2): lo que consulta el editor del plano antes de archivar una
// mesa. Se prueba con eventos reales contra el hub, sin pasar por el cliente.

const conexionDe = (m: Montaje, nodo: Nodo) => {
  const conexion = m.red.tokens.get(`token-${nodo.nombre}`)
  if (!conexion) throw new Error(`Sin token para ${nodo.nombre}`)
  return conexion
}

const CON_MOTIVO = new Set(['PedidoCancelado', 'PedidoReabierto'])

function equipo() {
  const m = montar()
  const nodo = m.red.dispositivo('ana')
  const otro = m.red.dispositivo('beto')
  // Por defecto el dispositivo conoce todo lo del hub (secuencia_base = la última).
  const enviarDe = (
    quien: Nodo,
    pedido: string,
    tipo: string,
    datos: unknown,
    extras: object = {},
  ) => {
    const r = m.hub().recibirLote(conexionDe(m, quien), [
      {
        id: nuevoId(),
        tipo,
        version_esquema: 1,
        agregado_tipo: 'pedido',
        agregado_id: pedido,
        relacionados: [],
        datos,
        sesion_id: null,
        usuario_id: quien.usuarioId,
        dispositivo_id: quien.dispositivoId,
        autorizacion_id: null,
        motivo: CON_MOTIVO.has(tipo) ? 'Prueba' : null,
        hora_dispositivo: AHORA,
        hora_estimada_hub: AHORA,
        secuencia_base: m.almacen.maxSecuencia(),
        ...extras,
      },
    ])
    return r.resultados[0]
  }
  const enviar = (pedido: string, tipo: string, datos: unknown, extras: object = {}) =>
    enviarDe(nodo, pedido, tipo, datos, extras)
  const abrir = (mesa: string | null, pedido = nuevoId()) => {
    const r = enviar(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: mesa, comensales: 2 })
    return { pedido, resultado: r }
  }
  return { m, nodo, otro, enviar, enviarDe, abrir }
}

describe('HubSync.tienePedidoAbierto', () => {
  it('una mesa sin pedidos, o que no existe, no está ocupada', () => {
    const { m } = equipo()
    expect(m.hub().tienePedidoAbierto(nuevoId())).toBe(false)
    expect(m.hub().tienePedidoAbierto('')).toBe(false)
  })

  it('se ocupa al abrir el pedido y se libera al cerrarlo', () => {
    const { m, enviar, abrir } = equipo()
    const mesa = nuevoId()
    const { pedido } = abrir(mesa)
    expect(m.hub().tienePedidoAbierto(mesa)).toBe(true)
    expect(enviar(pedido, 'PedidoCerrado', {})?.estado).toBe('confirmado')
    expect(m.hub().tienePedidoAbierto(mesa)).toBe(false)
  })

  it('se libera al cancelar el pedido', () => {
    const { m, enviar, abrir } = equipo()
    const mesa = nuevoId()
    const { pedido } = abrir(mesa)
    enviar(pedido, 'ItemAgregado', item())
    expect(m.hub().tienePedidoAbierto(mesa)).toBe(true)
    expect(enviar(pedido, 'PedidoCancelado', {})?.estado).toBe('confirmado')
    expect(m.hub().tienePedidoAbierto(mesa)).toBe(false)
  })

  it('un pedido reabierto vuelve a ocupar su mesa', () => {
    const { m, enviar, abrir } = equipo()
    const mesa = nuevoId()
    const { pedido } = abrir(mesa)
    enviar(pedido, 'PedidoCerrado', {})
    expect(m.hub().tienePedidoAbierto(mesa)).toBe(false)
    expect(enviar(pedido, 'PedidoReabierto', {})?.estado).toBe('confirmado')
    expect(m.hub().tienePedidoAbierto(mesa)).toBe(true)
  })

  it('un pedido que no se pudo cerrar (saldo pendiente) sigue ocupando la mesa', () => {
    const { m, enviar, abrir } = equipo()
    const mesa = nuevoId()
    const { pedido } = abrir(mesa)
    enviar(pedido, 'ItemAgregado', item())
    expect(enviar(pedido, 'PedidoCerrado', {})).toMatchObject({
      estado: 'rechazado',
      motivo: 'saldo_pendiente',
    })
    expect(m.hub().tienePedidoAbierto(mesa)).toBe(true)
  })

  it('mover el pedido a otra mesa libera la de origen y ocupa la de destino', () => {
    const { m, enviar, abrir } = equipo()
    const origen = nuevoId()
    const destino = nuevoId()
    const { pedido } = abrir(origen)
    enviar(pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: destino })
    expect(m.hub().tienePedidoAbierto(origen)).toBe(false)
    expect(m.hub().tienePedidoAbierto(destino)).toBe(true)
  })

  it('un pedido sin mesa (barra, para llevar) no ocupa ninguna', () => {
    const { m, abrir } = equipo()
    abrir(null)
    expect(m.hub().tienePedidoAbierto(nuevoId())).toBe(false)
  })

  it('con varios pedidos en la misma mesa (conflicto), sigue ocupada hasta cerrar el último', () => {
    const { m, otro, enviar, enviarDe, abrir } = equipo()
    const mesa = nuevoId()
    const uno = abrir(mesa)
    // Otro mesero abre la misma mesa sin saber del primer pedido (secuencia_base 0): se acepta y
    // se avisa en caja.
    const dos = nuevoId()
    const r = enviarDe(
      otro,
      dos,
      'PedidoAbierto',
      { canal: 'salon', mesa_id: mesa, comensales: 1 },
      { secuencia_base: 0 },
    )
    expect(r).toMatchObject({ estado: 'confirmado', conflicto: 'mesa_duplicada' })
    enviar(uno.pedido, 'PedidoCerrado', {})
    expect(m.hub().tienePedidoAbierto(mesa)).toBe(true)
    enviarDe(otro, dos, 'PedidoCerrado', {})
    expect(m.hub().tienePedidoAbierto(mesa)).toBe(false)
  })

  it('un pedido rechazado (mesa ocupada que el dispositivo conocía) no cuenta dos veces', () => {
    const { m, otro: beto, enviar, enviarDe } = equipo()
    const mesa = nuevoId()
    const uno = nuevoId()
    enviar(uno, 'PedidoAbierto', { canal: 'salon', mesa_id: mesa, comensales: 2 })
    // Beto ya conocía el primer pedido (su base es la última): se rechaza.
    const otro = enviarDe(beto, nuevoId(), 'PedidoAbierto', {
      canal: 'salon',
      mesa_id: mesa,
      comensales: 1,
    })
    expect(otro).toMatchObject({ estado: 'rechazado', motivo: 'mesa_ocupada' })
    enviar(uno, 'PedidoCerrado', {})
    expect(m.hub().tienePedidoAbierto(mesa)).toBe(false)
  })

  it('al reiniciar el hub, las mesas ocupadas se reconstruyen de los eventos guardados', () => {
    const { m, enviar, abrir } = equipo()
    const ocupada = nuevoId()
    const cerrada = nuevoId()
    const cancelada = nuevoId()
    abrir(ocupada)
    enviar(abrir(cerrada).pedido, 'PedidoCerrado', {})
    enviar(abrir(cancelada).pedido, 'PedidoCancelado', {})
    m.red.caerHub()
    const nuevo = m.hub()
    expect(nuevo.tienePedidoAbierto(ocupada)).toBe(true)
    expect(nuevo.tienePedidoAbierto(cerrada)).toBe(false)
    expect(nuevo.tienePedidoAbierto(cancelada)).toBe(false)
  })

  it('SalaSync responde lo mismo que el hub', () => {
    const { m, abrir } = equipo()
    const mesa = nuevoId()
    abrir(mesa)
    expect(m.red.sala.tienePedidoAbierto(mesa)).toBe(true)
    expect(m.red.sala.tienePedidoAbierto(nuevoId())).toBe(false)
  })

  it('lo consulta bien con muchos pedidos abiertos y cerrados', () => {
    const { m, enviar, abrir } = equipo()
    const mesas = Array.from({ length: 60 }, () => nuevoId())
    const pedidos = mesas.map((mesa) => abrir(mesa).pedido)
    // Se cierran las pares.
    for (const [i, p] of pedidos.entries()) if (i % 2 === 0) enviar(p, 'PedidoCerrado', {})
    for (const [i, mesa] of mesas.entries())
      expect(m.hub().tienePedidoAbierto(mesa)).toBe(i % 2 === 1)
  })
})
