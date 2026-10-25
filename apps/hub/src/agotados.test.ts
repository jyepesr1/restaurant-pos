import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { montarHub } from './acceso/montaje-hub'

// Agotado (86) con el control de acceso real: lo marca quien tiene `agotar_producto` (cajero,
// cocina, gerente), no el mesero; y el hub lo guarda en la secuencia sin tocar pedidos.

describe('agotados en el hub', () => {
  it('el mesero no puede marcar agotado; el cajero sí, y se confirma con su secuencia', () => {
    const m = montarHub()
    const producto = nuevoId()
    const datos = { producto_id: producto, variante_id: null }
    const extras = { agregado_tipo: 'producto' as const, agregado_id: producto }

    const celular = m.emparejar('mesero')
    const mesero = m.entrar(celular.conexion, 'mesero')
    const r1 = m.hub.recibirLote(celular.conexion, [
      m.evento(celular.conexion, mesero, 'ProductoAgotado', datos, extras),
    ])
    expect(r1.resultados).toEqual([
      expect.objectContaining({ estado: 'rechazado', motivo: 'sin_permiso' }),
    ])

    const caja = m.emparejar('caja')
    const cajero = m.entrar(caja.conexion, 'cajero')
    const r2 = m.hub.recibirLote(caja.conexion, [
      m.evento(caja.conexion, cajero, 'ProductoAgotado', datos, extras),
      m.evento(caja.conexion, cajero, 'ProductoDisponible', datos, extras),
    ])
    expect(r2.resultados.map((r) => r.estado)).toEqual(['confirmado', 'confirmado'])
    expect(m.hub.pedido(producto)).toBeNull()
  })

  it('un agotado con agregado de pedido se rechaza por formato', () => {
    const m = montarHub()
    const producto = nuevoId()
    const caja = m.emparejar('caja')
    const cajero = m.entrar(caja.conexion, 'cajero')
    const r = m.hub.recibirLote(caja.conexion, [
      m.evento(
        caja.conexion,
        cajero,
        'ProductoAgotado',
        { producto_id: producto, variante_id: null },
        {
          agregado_id: producto,
        },
      ),
    ])
    expect(r.resultados[0]).toMatchObject({ estado: 'rechazado' })
    expect((r.resultados[0] as { motivo: string }).motivo).toMatch(/esquema/)
  })
})
