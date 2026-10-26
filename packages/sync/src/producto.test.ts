import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { abrirPedido, eventosDe, montar } from './pruebas/montaje'

// Agotado (86) en la sincronización: el hub lo acepta con su secuencia, lo difunde a todos y no
// lo confunde con un pedido (tarea 1.3).

describe('eventos de producto', () => {
  it('un agotado se confirma, llega a los demás y no crea ningún pedido', async () => {
    const m = montar()
    const register = m.network.device('register')
    const phone = m.network.device('phone')
    await register.connect()
    await phone.connect()
    await m.network.settle()

    const product = newId()
    await register.crear(
      product,
      'ProductSoldOut',
      { product_id: product, variant_id: null },
      { aggregate_type: 'product' },
    )
    const order = await abrirPedido(phone)
    await m.network.settle()

    expect(eventosDe(m).map((e) => [e.type, e.sequence])).toEqual([
      ['ProductSoldOut', 1],
      ['OrderOpened', 2],
    ])
    const delCelular = (await phone.cliente.locales()).find(
      (l) => l.event.type === 'ProductSoldOut',
    )
    expect(delCelular?.status).toBe('confirmed')
    expect(m.hub().order(product)).toBeNull()
    expect(m.hub().order(order)?.status).toBe('open')
    expect(await phone.cliente.order(product)).toBeNull()
  })

  it('tras reiniciar el hub, los agotados no estorban al reconstruir los pedidos', async () => {
    const m = montar()
    const register = m.network.device('register')
    await register.connect()
    const product = newId()
    await register.crear(
      product,
      'ProductSoldOut',
      { product_id: product, variant_id: null },
      { aggregate_type: 'product' },
    )
    const order = await abrirPedido(register)
    await m.network.settle()
    const sala = m.crearSala()
    expect(sala).toBeDefined()
    expect(m.hub().order(order)?.status).toBe('open')
    expect(m.hub().tienePedidoAbierto('x')).toBe(false)
  })
})
