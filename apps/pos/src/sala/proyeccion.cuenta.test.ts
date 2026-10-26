import { nuevoId } from '@pos/core'
import type { EventoLocal } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { estadoMesa, pedidosAbiertos as proyectar } from './proyeccion'
import { apertura, datosItem, enOrden, local } from './pruebas'

// Estado de mesa «cuenta» (tarea 1.6): se pidió la precuenta o ya hay un pago parcial. Gana a
// «en cocina» y «servida», y pierde ante «tomando» y «listo».

const COCINA = nuevoId()
const TURNO = nuevoId()
const pago = (monto: number) => ({
  pago_id: nuevoId(),
  cuenta_id: null,
  turno_caja_id: TURNO,
  medio: 'nequi' as const,
  monto,
  propina: 0,
  recibido: null,
  cambio: null,
  ajuste_redondeo: 0,
  redondeo: null,
  datafono: null,
  referencia_cobro: null,
})

/** Un pedido con un plato; `enviado` lo manda a cocina; `estadoItem` lo lleva al estado pedido. */
function mesa(
  opciones: { enviado?: boolean; listo?: boolean; entregado?: boolean } = {},
  mas: (id: string) => EventoLocal[] = () => [],
) {
  const id = nuevoId()
  const plato = datosItem({ precio_unitario: 20_000 })
  const eventos: EventoLocal[] = [
    local('PedidoAbierto', id, { ...apertura, mesa_id: nuevoId() }),
    local('ItemAgregado', id, plato),
  ]
  if (opciones.enviado || opciones.listo || opciones.entregado)
    eventos.push(
      local('ItemsEnviados', id, {
        comandas: [{ comanda_id: nuevoId(), estacion_id: COCINA, item_ids: [plato.item_id] }],
      }),
    )
  if (opciones.listo || opciones.entregado)
    eventos.push(local('ItemListo', id, { item_ids: [plato.item_id] }))
  if (opciones.entregado) eventos.push(local('ItemEntregado', id, { item_ids: [plato.item_id] }))
  eventos.push(...mas(id))
  return estadoMesa(proyectar(enOrden(eventos)))
}

const precuenta = (id: string) =>
  local('PrecuentaImpresa', id, { cuenta_id: null, subtotal: 20_000, propina_sugerida: 1_852 })

describe('estadoMesa: cuenta', () => {
  it('una mesa sin pedidos es libre', () => {
    expect(estadoMesa([])).toBe('libre')
  })

  it('servida y con la precuenta pedida: «cuenta»', () => {
    expect(mesa({ entregado: true })).toBe('servida')
    expect(mesa({ entregado: true }, (id) => [precuenta(id)])).toBe('cuenta')
  })

  it('con la precuenta pedida aunque aún haya algo en cocina: «cuenta» gana a «en cocina»', () => {
    expect(mesa({ enviado: true })).toBe('en_cocina')
    expect(mesa({ enviado: true }, (id) => [precuenta(id)])).toBe('cuenta')
  })

  it('un pago parcial deja la mesa en «cuenta» (sin precuenta)', () => {
    expect(mesa({ entregado: true }, (id) => [local('PagoRegistrado', id, pago(5_000))])).toBe(
      'cuenta',
    )
    expect(mesa({ enviado: true }, (id) => [local('PagoRegistrado', id, pago(5_000))])).toBe(
      'cuenta',
    )
  })

  it('un pago parcial anulado ya no cuenta', () => {
    const e = mesa({ entregado: true }, (id) => {
      const p = pago(5_000)
      return [
        local('PagoRegistrado', id, p),
        local('PagoAnulado', id, { pago_id: p.pago_id, turno_caja_id: TURNO }),
      ]
    })
    expect(e).toBe('servida')
  })

  it('algo listo para llevar gana a «cuenta»', () => {
    expect(mesa({ listo: true }, (id) => [precuenta(id)])).toBe('listo')
  })

  it('algo sin enviar gana a «cuenta»: «tomando»', () => {
    expect(
      mesa({ enviado: true }, (id) => [precuenta(id), local('ItemAgregado', id, datosItem())]),
    ).toBe('tomando')
  })

  it('agregar un producto después de pedir la precuenta la invalida: vuelve a su estado', () => {
    const e = mesa({ entregado: true }, (id) => [
      precuenta(id),
      local('ItemAgregado', id, datosItem()),
    ])
    expect(e).toBe('tomando')
  })

  it('con un pedido unido a la mesa (varios pedidos), basta que uno pida la cuenta', () => {
    const a = nuevoId()
    const b = nuevoId()
    const mesaId = nuevoId()
    const pa = datosItem()
    const pb = datosItem()
    const base: EventoLocal[] = [
      local('PedidoAbierto', a, { ...apertura, mesa_id: mesaId }),
      local('ItemAgregado', a, pa),
      local('PedidoAbierto', b, { ...apertura, mesa_id: mesaId }),
      local('ItemAgregado', b, pb),
    ]
    const todos = enOrden([
      ...base,
      local('ItemsEnviados', a, {
        comandas: [{ comanda_id: nuevoId(), estacion_id: COCINA, item_ids: [pa.item_id] }],
      }),
      local('ItemsEnviados', b, {
        comandas: [{ comanda_id: nuevoId(), estacion_id: COCINA, item_ids: [pb.item_id] }],
      }),
      precuenta(a),
    ])
    expect(estadoMesa(proyectar(todos))).toBe('cuenta')
  })
})
