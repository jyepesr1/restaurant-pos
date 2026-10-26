import { describe, expect, it } from 'vitest'
import { validarEventoNuevo } from '../eventos/pedido'
import { nuevoId } from '../id'
import { aplicarTodos, enviarItems, problemaDe } from '../pruebas/ayudas'
import { copiaItem, evento, HORA, MESERO } from '../pruebas/fabrica'
import { aplicarEvento } from './aplicar'
import type { EstadoPedido } from './estado'
import { totalesPedido } from './totales'

// Mover productos a otra mesa (tarea 1.5): `ItemsMovidos`, con el pedido de destino en
// `relacionados`. La copia que viaja debe ser exactamente el ítem del origen.

type Copia = ReturnType<typeof copiaItem>
type Movido = { item: Copia; estado: 'enviado'; cantidad_anulada: number; agregado_por: string }

const movido = (item: Copia, extras: Partial<Movido> = {}): Movido => ({
  item,
  estado: 'enviado',
  cantidad_anulada: 0,
  agregado_por: MESERO,
  ...extras,
})

/** Origen con un ítem enviado y destino recién abierto. */
function dosPedidos(campos: Partial<Copia> = {}) {
  const origen = nuevoId()
  const destino = nuevoId()
  const item = copiaItem(campos)
  const estadoOrigen = aplicarTodos([
    evento(origen, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 2 }),
    evento(origen, 'ItemAgregado', item),
    enviarItems(origen, [item.item_id]),
  ])
  const estadoDestino = aplicarTodos([
    evento(destino, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 1 }),
  ])
  const mover = (items: Movido[], extras = {}) =>
    evento(origen, 'ItemsMovidos', { pedido_destino_id: destino, items }, extras)
  return { origen, destino, item, estadoOrigen, estadoDestino, mover }
}

const aplicaEnAmbos = (m: ReturnType<typeof dosPedidos>, e: ReturnType<typeof m.mover>) => ({
  origen: aplicarEvento(m.estadoOrigen, e),
  destino: aplicarEvento(m.estadoDestino, e),
})

describe('ItemsMovidos: lo que llega al destino', () => {
  it('el ítem sale del origen y entra al destino con su id, su estado y quién lo agregó', () => {
    const m = dosPedidos()
    const r = aplicaEnAmbos(m, m.mover([movido(m.item)]))
    expect(r.origen.problema).toBeNull()
    expect(r.destino.problema).toBeNull()
    expect(r.origen.estado?.items).toEqual({})
    const llegado = r.destino.estado?.items[m.item.item_id]
    expect(llegado).toMatchObject({
      id: m.item.item_id,
      estado: 'enviado',
      agregadoPor: MESERO,
      cantidad: 1,
      precioUnitario: m.item.precio_unitario,
    })
  })

  it('con modificadores, nota, comensal y curso: la copia llega igual', () => {
    const mod = { modificador_id: nuevoId(), nombre: 'Extra limón', precio_extra: 2000 }
    const m = dosPedidos({
      modificadores: [mod],
      notas: 'sin hielo',
      comensal: 3,
      curso: 'fuerte',
    })
    const r = aplicaEnAmbos(m, m.mover([movido(m.item)]))
    expect(r.destino.problema).toBeNull()
    expect(r.destino.estado?.items[m.item.item_id]).toMatchObject({
      notas: 'sin hielo',
      comensal: 3,
      curso: 'fuerte',
      modificadores: [{ modificadorId: mod.modificador_id, precioExtra: 2000 }],
    })
  })

  it('una anulación parcial viaja: lo anulado sigue anulado y el neto se conserva', () => {
    const m = dosPedidos({ cantidad: 3 })
    const anulado = aplicarTodos(
      [
        evento(
          m.origen,
          'ItemAnulado',
          { item_id: m.item.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
          { motivo: 'Error del mesero' },
        ),
      ],
      m.estadoOrigen,
    )
    const e = m.mover([movido(m.item, { cantidad_anulada: 1 })])
    const origen = aplicarEvento(anulado, e)
    const destino = aplicarEvento(m.estadoDestino, e)
    expect(origen.problema).toBeNull()
    expect(destino.problema).toBeNull()
    expect(destino.estado?.items[m.item.item_id]).toMatchObject({ cantidad: 3, cantidadAnulada: 1 })
    expect(totalesPedido(destino.estado as EstadoPedido).neto).toBe(totalesPedido(anulado).neto)
    expect(totalesPedido(origen.estado as EstadoPedido).neto).toBe(0)
  })

  it('si la copia dice que no se anuló nada pero sí se anuló, es copia_distinta en el origen', () => {
    const m = dosPedidos({ cantidad: 3 })
    const anulado = aplicarTodos(
      [
        evento(
          m.origen,
          'ItemAnulado',
          { item_id: m.item.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
          { motivo: 'x' },
        ),
      ],
      m.estadoOrigen,
    )
    expect(problemaDe(anulado, m.mover([movido(m.item, { cantidad_anulada: 0 })]))).toBe(
      'copia_distinta',
    )
  })

  it('el destino conserva lo suyo y suma lo movido', () => {
    const m = dosPedidos()
    const propio = copiaItem({ nombre: 'Aperol' })
    const destinoConItem = aplicarTodos(
      [evento(m.destino, 'ItemAgregado', propio)],
      m.estadoDestino,
    )
    const r = aplicarEvento(destinoConItem, m.mover([movido(m.item)]))
    expect(r.problema).toBeNull()
    expect(Object.keys(r.estado?.items ?? {}).sort()).toEqual(
      [propio.item_id, m.item.item_id].sort(),
    )
    // El que llega se ordena después de los del destino.
    const orden = (id: string) => r.estado?.items[id]?.orden ?? 0
    expect(orden(m.item.item_id)).toBeGreaterThan(orden(propio.item_id))
  })

  it('mover una línea ya entregada la deja entregada en el destino', () => {
    const m = dosPedidos()
    const entregado = aplicarTodos(
      [evento(m.origen, 'ItemEntregado', { item_ids: [m.item.item_id] })],
      m.estadoOrigen,
    )
    const e = m.mover([{ ...movido(m.item), estado: 'enviado' }])
    // La copia dice «enviado» pero el ítem está entregado: no coincide.
    expect(problemaDe(entregado, e)).toBe('copia_distinta')
    const bien = evento(m.origen, 'ItemsMovidos', {
      pedido_destino_id: m.destino,
      items: [{ ...movido(m.item), estado: 'entregado' as never }],
    })
    expect(aplicarEvento(entregado, bien).problema).toBeNull()
    expect(aplicarEvento(m.estadoDestino, bien).estado?.items[m.item.item_id]?.estado).toBe(
      'entregado',
    )
  })

  it('mover varios a la vez los mueve todos o ninguno', () => {
    const m = dosPedidos()
    const otro = copiaItem()
    const dos = aplicarTodos(
      [evento(m.origen, 'ItemAgregado', otro), enviarItems(m.origen, [otro.item_id])],
      m.estadoOrigen,
    )
    const bien = m.mover([movido(m.item), movido(otro)])
    const r = aplicarEvento(dos, bien)
    expect(r.problema).toBeNull()
    expect(r.estado?.items).toEqual({})
    // Si uno no coincide, ninguno se mueve.
    const mal = m.mover([movido(m.item), movido({ ...otro, precio_unitario: 1 })])
    const rm = aplicarEvento(dos, mal)
    expect(rm.problema?.tipo).toBe('copia_distinta')
    expect(rm.estado).toBe(dos)
  })

  it('mover algo cambia solo el reparto: la suma de los dos pedidos se conserva', () => {
    const m = dosPedidos({ cantidad: 2, precio_unitario: 12_900 })
    const antes = totalesPedido(m.estadoOrigen).neto + totalesPedido(m.estadoDestino).neto
    const r = aplicaEnAmbos(m, m.mover([movido(m.item)]))
    const despues =
      totalesPedido(r.origen.estado as EstadoPedido).neto +
      totalesPedido(r.destino.estado as EstadoPedido).neto
    expect(despues).toBe(antes)
  })
})

describe('ItemsMovidos: lo que se rechaza', () => {
  it.each([
    ['otro producto', { producto_id: nuevoId() }],
    ['otro precio', { precio_unitario: 1 }],
    ['otra tarifa', { tarifa: 1900 }],
    ['otro impuesto', { impuesto_tipo: 'iva' as const }],
    ['otra cantidad', { cantidad: 5 }],
    [
      'otros modificadores',
      { modificadores: [{ modificador_id: nuevoId(), nombre: 'x', precio_extra: 0 }] },
    ],
  ])('una copia con %s no coincide con el ítem del origen', (_n, cambio) => {
    const m = dosPedidos()
    const e = m.mover([movido({ ...m.item, ...cambio })])
    expect(problemaDe(m.estadoOrigen, e)).toBe('copia_distinta')
  })

  it('con otro agregado_por tampoco coincide', () => {
    const m = dosPedidos()
    expect(problemaDe(m.estadoOrigen, m.mover([movido(m.item, { agregado_por: nuevoId() })]))).toBe(
      'copia_distinta',
    )
  })

  it('un ítem que el origen no tiene es item_inexistente', () => {
    const m = dosPedidos()
    expect(problemaDe(m.estadoOrigen, m.mover([movido(copiaItem())]))).toBe('item_inexistente')
  })

  it('un ítem ya anulado del todo no se mueve', () => {
    const m = dosPedidos()
    const anulado = aplicarTodos(
      [
        evento(
          m.origen,
          'ItemAnulado',
          { item_id: m.item.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
          { motivo: 'x' },
        ),
      ],
      m.estadoOrigen,
    )
    expect(problemaDe(anulado, m.mover([movido(m.item)]))).toBe('item_inexistente')
  })

  it('un ítem con descuento no se mueve hasta retirarlo', () => {
    const m = dosPedidos()
    const conDescuento = aplicarTodos(
      [
        evento(
          m.origen,
          'DescuentoAplicado',
          {
            descuento_id: nuevoId(),
            alcance: 'item',
            regla: 'valor',
            valor: 1000,
            cantidad_unidades: null,
            montos: [{ item_id: m.item.item_id, monto: 1000 }],
          },
          { motivo: 'm' },
        ),
      ],
      m.estadoOrigen,
    )
    expect(problemaDe(conDescuento, m.mover([movido(m.item)]))).toBe('tiene_descuentos')
  })

  it('el mismo ítem dos veces en el destino es item_ya_existe', () => {
    const m = dosPedidos()
    const ya = aplicarTodos([evento(m.destino, 'ItemAgregado', { ...m.item })], m.estadoDestino)
    expect(problemaDe(ya, m.mover([movido(m.item)]))).toBe('item_ya_existe')
  })

  it.each(['cerrado', 'cancelado'] as const)('un destino %s no recibe nada', (final) => {
    const m = dosPedidos()
    const cerrado = aplicarTodos(
      [
        evento(
          m.destino,
          final === 'cerrado' ? 'PedidoCerrado' : 'PedidoCancelado',
          {},
          { motivo: 'x' },
        ),
      ],
      m.estadoDestino,
    )
    expect(problemaDe(cerrado, m.mover([movido(m.item)]))).toBe('pedido_cerrado')
  })

  it('un pedido que no es ni origen ni destino ignora el evento', () => {
    const m = dosPedidos()
    const tercero = aplicarTodos([
      evento(nuevoId(), 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 1 }),
    ])
    expect(problemaDe(tercero, m.mover([movido(m.item)]))).toBe('evento_ajeno')
  })

  it('un origen con la cuenta dividida no mueve', () => {
    const m = dosPedidos()
    const dividido = aplicarTodos(
      [
        evento(m.origen, 'CuentaDividida', {
          cuentas: [
            { cuenta_id: nuevoId(), nombre: 'A', monto: 20_000, propina_sugerida: 0, items: [] },
            { cuenta_id: nuevoId(), nombre: 'B', monto: 20_900, propina_sugerida: 0, items: [] },
          ],
        }),
      ],
      m.estadoOrigen,
    )
    expect(problemaDe(dividido, m.mover([movido(m.item)]))).toBe('pedido_dividido')
  })
})

describe('esquema de ItemsMovidos', () => {
  const sobre = (datos: unknown, relacionados: string[], agregado = nuevoId()) => ({
    id: nuevoId(),
    tipo: 'ItemsMovidos',
    version_esquema: 1,
    agregado_tipo: 'pedido',
    agregado_id: agregado,
    relacionados,
    datos,
    sesion_id: null,
    usuario_id: MESERO,
    dispositivo_id: nuevoId(),
    autorizacion_id: null,
    motivo: null,
    hora_dispositivo: HORA,
    hora_estimada_hub: HORA,
    secuencia_base: 0,
  })
  const { catalogo_version: _v, precio_canal_id: _c, ...sinCatalogo } = copiaItem()
  const unItem = { item: sinCatalogo, estado: 'enviado', cantidad_anulada: 0, agregado_por: MESERO }

  it('exige el destino en relacionados', () => {
    const destino = nuevoId()
    const datos = { pedido_destino_id: destino, items: [unItem] }
    expect(validarEventoNuevo(sobre(datos, [destino])).ok).toBe(true)
    expect(validarEventoNuevo(sobre(datos, [])).ok).toBe(false)
    expect(validarEventoNuevo(sobre(datos, [nuevoId()])).ok).toBe(false)
  })

  it('no puede ser del pedido a sí mismo', () => {
    const mismo = nuevoId()
    expect(
      validarEventoNuevo(sobre({ pedido_destino_id: mismo, items: [unItem] }, [mismo], mismo)).ok,
    ).toBe(false)
  })

  it('exige al menos un ítem y rechaza repetidos', () => {
    const destino = nuevoId()
    expect(validarEventoNuevo(sobre({ pedido_destino_id: destino, items: [] }, [destino])).ok).toBe(
      false,
    )
    expect(
      validarEventoNuevo(sobre({ pedido_destino_id: destino, items: [unItem, unItem] }, [destino]))
        .ok,
    ).toBe(false)
  })
})
