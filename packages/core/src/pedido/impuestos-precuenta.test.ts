import { describe, expect, it } from 'vitest'
import type { EventoPedido } from '../eventos/pedido'
import { nuevoId } from '../id'
import { copiaItem, enOrden, evento } from '../pruebas/fabrica'
import { aplicarEvento } from './aplicar'
import type { EstadoPedido } from './estado'
import { impuestosDelPedido, propinaPendienteDeCuenta, totalesPedido } from './totales'

// El impuesto discriminado de la precuenta (tarea 1.6) y la propina que le falta a una cuenta
// dividida pagada en parte.

function pedidoCon(...items: Parameters<typeof copiaItem>[0][]): EstadoPedido {
  const id = nuevoId()
  const eventos: EventoPedido[] = [
    evento(id, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 2 }),
    ...items.map((i) => evento(id, 'ItemAgregado', copiaItem(i))),
  ]
  return eventos.reduce<EstadoPedido | null>((estado, e) => {
    const r = aplicarEvento(estado, enOrden(e, estado?.ultimaSecuencia ?? 0))
    if (r.problema) throw new Error(r.problema.tipo)
    return r.estado
  }, null) as EstadoPedido
}

describe('impuestosDelPedido', () => {
  it('$40.900 al 8 %: INC $3.030 y base $37.870 (el desglose DIAN es 302.963 centésimas)', () => {
    expect(impuestosDelPedido(pedidoCon({}))).toEqual([
      { tipo: 'inc', tarifa: 800, base: 37_870, impuesto: 3_030 },
    ])
  })

  it('agrupa por tipo y tarifa, y base + impuesto da el neto del pedido', () => {
    const pedido = pedidoCon(
      { precio_unitario: 30_900, cantidad: 2 },
      { precio_unitario: 12_000, impuesto_tipo: 'iva', tarifa: 1900 },
      { precio_unitario: 8_000, impuesto_tipo: 'exento', tarifa: 0 },
    )
    const grupos = impuestosDelPedido(pedido)
    expect(grupos.map((g) => `${g.tipo}:${g.tarifa}`)).toEqual(['inc:800', 'iva:1900', 'exento:0'])
    expect(grupos.find((g) => g.tipo === 'exento')).toMatchObject({ base: 8_000, impuesto: 0 })
    expect(grupos.reduce((a, g) => a + g.base + g.impuesto, 0)).toBe(totalesPedido(pedido).neto)
  })

  it('un pedido sin productos no tiene impuestos', () => {
    expect(impuestosDelPedido(pedidoCon())).toEqual([])
  })
})

describe('propinaPendienteDeCuenta', () => {
  const cuenta = { monto: 33_334, propinaSugerida: 3_087 }
  it('sin pagos, la de la cuenta; pagada, 0', () => {
    expect(propinaPendienteDeCuenta(cuenta, 33_334)).toBe(3_087)
    expect(propinaPendienteDeCuenta(cuenta, 0)).toBe(0)
  })
  it('pagada en parte: la parte de la propina que corresponde a lo que falta', () => {
    // Pagó 20.000 de 33.334: faltan 13.334 → 3.087 × 13.334 / 33.334 ≈ 1.235.
    const falta = propinaPendienteDeCuenta(cuenta, 13_334)
    expect(falta).toBe(1_235)
    // Lo sugerido en el pago parcial y lo que falta suman la propina entera.
    expect(propinaPendienteDeCuenta(cuenta, 33_334) - falta + falta).toBe(3_087)
  })
})
