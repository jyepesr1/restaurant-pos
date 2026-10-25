import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { abrirPedido, eventosDe, montar } from './pruebas/montaje'

// Agotado (86) en la sincronización: el hub lo acepta con su secuencia, lo difunde a todos y no
// lo confunde con un pedido (tarea 1.3).

describe('eventos de producto', () => {
  it('un agotado se confirma, llega a los demás y no crea ningún pedido', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    const celular = m.red.dispositivo('celular')
    await caja.conectar()
    await celular.conectar()
    await m.red.estabilizar()

    const producto = nuevoId()
    await caja.crear(
      producto,
      'ProductoAgotado',
      { producto_id: producto, variante_id: null },
      { agregado_tipo: 'producto' },
    )
    const pedido = await abrirPedido(celular)
    await m.red.estabilizar()

    expect(eventosDe(m).map((e) => [e.tipo, e.secuencia])).toEqual([
      ['ProductoAgotado', 1],
      ['PedidoAbierto', 2],
    ])
    const delCelular = (await celular.cliente.locales()).find(
      (l) => l.evento.tipo === 'ProductoAgotado',
    )
    expect(delCelular?.estado).toBe('confirmado')
    expect(m.hub().pedido(producto)).toBeNull()
    expect(m.hub().pedido(pedido)?.estado).toBe('abierto')
    expect(await celular.cliente.pedido(producto)).toBeNull()
  })

  it('tras reiniciar el hub, los agotados no estorban al reconstruir los pedidos', async () => {
    const m = montar()
    const caja = m.red.dispositivo('caja')
    await caja.conectar()
    const producto = nuevoId()
    await caja.crear(
      producto,
      'ProductoAgotado',
      { producto_id: producto, variante_id: null },
      { agregado_tipo: 'producto' },
    )
    const pedido = await abrirPedido(caja)
    await m.red.estabilizar()
    const sala = m.crearSala()
    expect(sala).toBeDefined()
    expect(m.hub().pedido(pedido)?.estado).toBe('abierto')
    expect(m.hub().tienePedidoAbierto('x')).toBe(false)
  })
})
