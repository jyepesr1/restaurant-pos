import {
  aplicarEvento,
  type EstadoPedido,
  nuevoId,
  reconstruir,
  validarEventoNuevo,
} from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { movidoDe } from './pedido'
import { apertura, datosItem, local } from './pruebas'

// `movidoDe` (tarea 1.5): la copia con que un plato pasa a otro pedido debe ser exactamente la del
// ítem real, o el reductor del hub la rechaza (`copia_distinta`). Aquí se arma con el reductor
// de verdad, sin red.

type Local = ReturnType<typeof local>

interface Escenario {
  origen: string
  destino: string
  estadoOrigen: EstadoPedido
  estadoDestino: EstadoPedido
}

const estadoDe = (eventos: Local[], pedido: string): EstadoPedido => {
  const e = reconstruir(
    eventos.map((l, i) => ({ ...l.evento, secuencia: i + 1 }) as never),
    pedido,
  )
  if (!e) throw new Error('sin estado')
  return e
}

/** Origen con los eventos dados (ya con su apertura) y un destino recién abierto. */
function escenario(armar: (origen: string) => Local[]): Escenario {
  const origen = nuevoId()
  const destino = nuevoId()
  return {
    origen,
    destino,
    estadoOrigen: estadoDe([local('PedidoAbierto', origen, apertura), ...armar(origen)], origen),
    estadoDestino: estadoDe([local('PedidoAbierto', destino, apertura)], destino),
  }
}

const enviar = (pedido: string, ids: string[]) =>
  local('ItemsEnviados', pedido, {
    comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: ids }],
  })

/** El evento de mover tal como lo arma la pantalla, sin los campos que pone el hub. */
const moverEvento = (e: Escenario, ids: string[]) =>
  local(
    'ItemsMovidos',
    e.origen,
    {
      pedido_destino_id: e.destino,
      items: ids.map((id) => movidoDe(e.estadoOrigen.items[id] as never)),
    },
    'pendiente',
    { relacionados: [e.destino] },
  )

/** El reductor acepta el movimiento en el origen y en el destino. */
function aceptado(e: Escenario, ids: string[]) {
  const ev = moverEvento(e, ids)
  const o = aplicarEvento(e.estadoOrigen, ev.evento)
  const d = aplicarEvento(e.estadoDestino, ev.evento)
  return { ev, o, d }
}

describe('movidoDe', () => {
  it('un plato enviado: el reductor lo acepta y lo pasa del origen al destino', () => {
    const it = datosItem({ cantidad: 2 })
    const e = escenario((o) => [local('ItemAgregado', o, it), enviar(o, [it.item_id])])
    const { o, d, ev } = aceptado(e, [it.item_id])
    expect(o.problema).toBeNull()
    expect(d.problema).toBeNull()
    expect(o.estado?.items[it.item_id]).toBeUndefined()
    expect(d.estado?.items[it.item_id]).toMatchObject({ estado: 'enviado', cantidad: 2 })
    // Y el esquema del evento (campos estrictos) también lo acepta.
    expect(validarEventoNuevo(ev.evento).ok).toBe(true)
  })

  it('no lleva los campos de catálogo de ItemAgregado (el esquema es estricto)', () => {
    const it = datosItem()
    const e = escenario((o) => [local('ItemAgregado', o, it)])
    const m = movidoDe(e.estadoOrigen.items[it.item_id] as never)
    expect(Object.keys(m.item).sort()).toEqual(
      [
        'comensal',
        'curso',
        'impuesto_tipo',
        'item_id',
        'modificadores',
        'nombre',
        'notas',
        'precio_unitario',
        'producto_id',
        'tarifa',
        'variante_id',
        'cantidad',
      ].sort(),
    )
    expect(Object.keys(m).sort()).toEqual(['agregado_por', 'cantidad_anulada', 'estado', 'item'])
  })

  it('con modificadores (y su precio extra): la copia coincide', () => {
    const mods = [
      { modificador_id: nuevoId(), nombre: 'Extra limón', precio_extra: 2000 },
      { modificador_id: nuevoId(), nombre: 'Sin hielo', precio_extra: 0 },
    ]
    const it = datosItem({ modificadores: mods })
    const e = escenario((o) => [local('ItemAgregado', o, it), enviar(o, [it.item_id])])
    const { o, d } = aceptado(e, [it.item_id])
    expect(o.problema).toBeNull()
    expect(d.estado?.items[it.item_id]?.modificadores.map((m) => m.precioExtra)).toEqual([2000, 0])
  })

  it('con nota, comensal y curso: llegan igual', () => {
    const it = datosItem({ notas: 'sin hielo', comensal: 3, curso: 'fuerte' })
    const e = escenario((o) => [local('ItemAgregado', o, it), enviar(o, [it.item_id])])
    const { d } = aceptado(e, [it.item_id])
    expect(d.estado?.items[it.item_id]).toMatchObject({
      notas: 'sin hielo',
      comensal: 3,
      curso: 'fuerte',
    })
  })

  it('con una nota cambiada después del envío, la copia lleva la nota nueva', () => {
    const it = datosItem({ notas: 'con hielo' })
    const e = escenario((o) => [
      local('ItemAgregado', o, it),
      enviar(o, [it.item_id]),
      local('ItemModificadoTrasEnvio', o, {
        item_id: it.item_id,
        comanda_id: nuevoId(),
        notas: 'sin hielo',
      }),
    ])
    const { o, d } = aceptado(e, [it.item_id])
    expect(o.problema).toBeNull()
    expect(d.estado?.items[it.item_id]?.notas).toBe('sin hielo')
  })

  it('con modificadores cambiados después del envío, la copia lleva los nuevos', () => {
    const it = datosItem({
      modificadores: [{ modificador_id: nuevoId(), nombre: 'Extra', precio_extra: 3000 }],
    })
    const e = escenario((o) => [
      local('ItemAgregado', o, it),
      enviar(o, [it.item_id]),
      local('ItemModificadoTrasEnvio', o, {
        item_id: it.item_id,
        comanda_id: nuevoId(),
        modificadores: [{ modificador_id: nuevoId(), nombre: 'Otro', precio_extra: 5000 }],
      }),
    ])
    const { o, d } = aceptado(e, [it.item_id])
    expect(o.problema).toBeNull()
    expect(d.estado?.items[it.item_id]?.modificadores.map((m) => m.precioExtra)).toEqual([5000])
  })

  it('con una anulación parcial: lo anulado viaja y el neto de los dos pedidos se conserva', () => {
    const it = datosItem({ cantidad: 3, precio_unitario: 12_900 })
    const e = escenario((o) => [
      local('ItemAgregado', o, it),
      enviar(o, [it.item_id]),
      local(
        'ItemAnulado',
        o,
        { item_id: it.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
        'confirmado',
        { motivo: 'Error del mesero' },
      ),
    ])
    expect(e.estadoOrigen.items[it.item_id]?.cantidadAnulada).toBe(1)
    const { o, d } = aceptado(e, [it.item_id])
    expect(o.problema).toBeNull()
    expect(d.problema).toBeNull()
    expect(d.estado?.items[it.item_id]).toMatchObject({ cantidad: 3, cantidadAnulada: 1 })
  })

  it.each(['en_preparacion', 'listo', 'entregado'] as const)(
    'un plato %s conserva su estado en el destino',
    (estado) => {
      const it = datosItem()
      const tipo = {
        en_preparacion: 'ItemEnPreparacion',
        listo: 'ItemListo',
        entregado: 'ItemEntregado',
      }[estado] as 'ItemListo'
      const e = escenario((o) => [
        local('ItemAgregado', o, it),
        enviar(o, [it.item_id]),
        local(tipo, o, { item_ids: [it.item_id] }),
      ])
      const { o, d } = aceptado(e, [it.item_id])
      expect(o.problema).toBeNull()
      expect(d.estado?.items[it.item_id]?.estado).toBe(estado)
    },
  )

  it('un plato sin enviar (pendiente) también se mueve', () => {
    const it = datosItem()
    const e = escenario((o) => [local('ItemAgregado', o, it)])
    const { o, d } = aceptado(e, [it.item_id])
    expect(o.problema).toBeNull()
    expect(d.estado?.items[it.item_id]?.estado).toBe('pendiente')
  })

  it('varios platos de una vez, de distinto tipo, se aceptan juntos', () => {
    const a = datosItem({ cantidad: 2, notas: 'x' })
    const b = datosItem({
      modificadores: [{ modificador_id: nuevoId(), nombre: 'E', precio_extra: 1000 }],
    })
    const c = datosItem({ impuesto_tipo: 'exento', tarifa: 0 })
    const e = escenario((o) => [
      local('ItemAgregado', o, a),
      local('ItemAgregado', o, b),
      local('ItemAgregado', o, c),
      enviar(o, [a.item_id, b.item_id]),
    ])
    const { o, d } = aceptado(e, [a.item_id, b.item_id, c.item_id])
    expect(o.problema).toBeNull()
    expect(Object.keys(d.estado?.items ?? {}).sort()).toEqual(
      [a.item_id, b.item_id, c.item_id].sort(),
    )
    expect(o.estado?.items).toEqual({})
  })

  it('ida y vuelta: mover al destino y devolverlo al origen también se acepta', () => {
    const it = datosItem({ cantidad: 2 })
    const e = escenario((o) => [local('ItemAgregado', o, it), enviar(o, [it.item_id])])
    const { d } = aceptado(e, [it.item_id])
    const vuelta = local(
      'ItemsMovidos',
      e.destino,
      { pedido_destino_id: e.origen, items: [movidoDe(d.estado?.items[it.item_id] as never)] },
      'pendiente',
      { relacionados: [e.origen] },
    )
    const origenVacio = aplicarEvento(aceptado(e, [it.item_id]).o.estado, vuelta.evento)
    expect(origenVacio.problema).toBeNull()
    expect(origenVacio.estado?.items[it.item_id]?.cantidad).toBe(2)
  })

  it('no inventa un agregado_por: es quien agregó el plato, no quien lo mueve', () => {
    const it = datosItem()
    const e = escenario((o) => [
      local('ItemAgregado', o, it, 'confirmado', { usuario_id: nuevoId() }),
    ])
    const real = e.estadoOrigen.items[it.item_id]
    expect(movidoDe(real as never).agregado_por).toBe(real?.agregadoPor)
  })

  it('una copia con algo distinto sí la rechaza el reductor (la prueba prueba algo)', () => {
    const it = datosItem()
    const e = escenario((o) => [local('ItemAgregado', o, it), enviar(o, [it.item_id])])
    const m = movidoDe(e.estadoOrigen.items[it.item_id] as never)
    const ev = local(
      'ItemsMovidos',
      e.origen,
      { pedido_destino_id: e.destino, items: [{ ...m, item: { ...m.item, precio_unitario: 1 } }] },
      'pendiente',
      { relacionados: [e.destino] },
    )
    expect(aplicarEvento(e.estadoOrigen, ev.evento).problema?.tipo).toBe('copia_distinta')
  })

  it('propiedad: cualquier plato, con lo que sea, se mueve y se conserva el neto', () => {
    fc.assert(
      fc.property(
        fc.record({
          cantidad: fc.integer({ min: 1, max: 9 }),
          precio: fc.constantFrom(0, 200, 12_900, 40_900),
          tarifa: fc.constantFrom(0, 800, 1900),
          extras: fc.array(fc.constantFrom(0, 1000, 3000), { maxLength: 3 }),
          nota: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
          enviado: fc.boolean(),
          anular: fc.nat(8),
        }),
        (c) => {
          const it = datosItem({
            cantidad: c.cantidad,
            precio_unitario: c.precio,
            tarifa: c.tarifa,
            impuesto_tipo: c.tarifa === 0 ? 'exento' : c.tarifa === 1900 ? 'iva' : 'inc',
            notas: c.nota,
            modificadores: c.extras.map((p, i) => ({
              modificador_id: nuevoId(),
              nombre: `M${i}`,
              precio_extra: p,
            })),
          })
          const anulables = c.enviado ? c.anular % c.cantidad : 0
          const e = escenario((o) => [
            local('ItemAgregado', o, it),
            ...(c.enviado ? [enviar(o, [it.item_id])] : []),
            ...(anulables > 0
              ? [
                  local(
                    'ItemAnulado',
                    o,
                    {
                      item_id: it.item_id,
                      cantidad: anulables,
                      ya_preparado: false,
                      comanda_id: null,
                    },
                    'confirmado',
                    { motivo: 'x' },
                  ),
                ]
              : []),
          ])
          const { o, d } = aceptado(e, [it.item_id])
          expect(o.problema).toBeNull()
          expect(d.problema).toBeNull()
          expect(d.estado?.items[it.item_id]?.cantidadAnulada).toBe(anulables)
        },
      ),
      { seed: 20_261_029, numRuns: 150 },
    )
  })
})
