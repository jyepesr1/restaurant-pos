import { newId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { montarHub } from './acceso/montaje-hub'

// Agotado (86) con el control de acceso real: lo marca quien tiene `mark_product_sold_out` (cajero,
// cocina, gerente), no el mesero; y el hub lo guarda en la secuencia sin tocar pedidos.

describe('agotados en el hub', () => {
  it('el mesero no puede marcar agotado; el cajero sí, y se confirma con su secuencia', () => {
    const m = montarHub()
    const product = newId()
    const data = { product_id: product, variant_id: null }
    const extras = { aggregate_type: 'product' as const, aggregate_id: product }

    const phone = m.emparejar('waiter')
    const waiter = m.entrar(phone.connection, 'waiter')
    const r1 = m.hub.receiveBatch(phone.connection, [
      m.event(phone.connection, waiter, 'ProductSoldOut', data, extras),
    ])
    expect(r1.results).toEqual([
      expect.objectContaining({ status: 'rejected', reason: 'no_permission' }),
    ])

    const register = m.emparejar('register')
    const cashier = m.entrar(register.connection, 'cashier')
    const r2 = m.hub.receiveBatch(register.connection, [
      m.event(register.connection, cashier, 'ProductSoldOut', data, extras),
      m.event(register.connection, cashier, 'ProductAvailable', data, extras),
    ])
    expect(r2.results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(m.hub.order(product)).toBeNull()
  })

  it('un agotado con agregado de pedido se rechaza por formato', () => {
    const m = montarHub()
    const product = newId()
    const register = m.emparejar('register')
    const cashier = m.entrar(register.connection, 'cashier')
    const r = m.hub.receiveBatch(register.connection, [
      m.event(
        register.connection,
        cashier,
        'ProductSoldOut',
        { product_id: product, variant_id: null },
        {
          aggregate_id: product,
        },
      ),
    ])
    expect(r.results[0]).toMatchObject({ status: 'rejected' })
    expect((r.results[0] as { reason: string }).reason).toMatch(/schema/)
  })
})
