import { describe, expect, it } from 'vitest'
import type { EventoNuevo } from '../eventos/pedido'
import { nuevoId } from '../id'
import type { EstadoPedido } from '../pedido/estado'
import { copiaItem, evento } from '../pruebas/fabrica'
import { type Permiso, permisoPara, ROLES_DE_FABRICA } from './permisos'

// El permiso de cada evento de la tarea 1.5 (mover, unir, anular, cancelar, cambiar lo enviado).

const pedido = nuevoId()
const comoNuevo = (e: unknown) => e as EventoNuevo
const MOTIVO = { motivo: 'Error del mesero' }

describe('permiso de los eventos de mesas', () => {
  it.each([
    ['MesasUnidas', evento(pedido, 'MesasUnidas', { mesa_ids: [nuevoId()] })],
    ['MesasSeparadas', evento(pedido, 'MesasSeparadas', { mesa_ids: [nuevoId()] })],
    ['PedidoMovidoDeMesa', evento(pedido, 'PedidoMovidoDeMesa', { mesa_destino_id: nuevoId() })],
  ])('%s pide tomar_pedido: lo hace cualquier mesero, sin supervisor', (_n, e) => {
    expect(permisoPara(comoNuevo(e))).toBe('tomar_pedido')
    for (const rol of Object.values(ROLES_DE_FABRICA).filter((r) => r.nombre !== 'Reportes'))
      expect(rol.permisos).toContain('tomar_pedido')
  })

  it('ItemsMovidos pide tomar_pedido', () => {
    const destino = nuevoId()
    const item = copiaItem()
    const e = evento(
      pedido,
      'ItemsMovidos',
      {
        pedido_destino_id: destino,
        items: [{ item, estado: 'enviado', cantidad_anulada: 0, agregado_por: nuevoId() }],
      },
      { relacionados: [destino] },
    )
    expect(permisoPara(comoNuevo(e))).toBe('tomar_pedido')
  })
})

describe('permiso de anular y cancelar', () => {
  const anular = evento(
    pedido,
    'ItemAnulado',
    { item_id: nuevoId(), cantidad: 1, ya_preparado: false, comanda_id: null },
    MOTIVO,
  )
  const cancelar = evento(pedido, 'PedidoCancelado', {}, MOTIVO)

  it('anular lo enviado pide anular_item_enviado y cancelar el pedido, cancelar_pedido', () => {
    expect(permisoPara(comoNuevo(anular))).toBe('anular_item_enviado')
    expect(permisoPara(comoNuevo(cancelar))).toBe('cancelar_pedido')
  })

  it('no dependen del estado del pedido', () => {
    const algo = { items: {} } as unknown as EstadoPedido
    expect(permisoPara(comoNuevo(anular), algo)).toBe('anular_item_enviado')
    expect(permisoPara(comoNuevo(cancelar), algo)).toBe('cancelar_pedido')
  })

  const tiene = (rol: keyof typeof ROLES_DE_FABRICA, permiso: Permiso) =>
    (ROLES_DE_FABRICA[rol].permisos as readonly Permiso[]).includes(permiso)

  it('el mesero no puede ninguna de las dos; el cajero anula pero no cancela; el admin ambas', () => {
    expect(tiene('mesero', 'anular_item_enviado')).toBe(false)
    expect(tiene('mesero', 'cancelar_pedido')).toBe(false)
    expect(tiene('cajero', 'anular_item_enviado')).toBe(true)
    expect(tiene('cajero', 'cancelar_pedido')).toBe(false)
    expect(tiene('admin', 'anular_item_enviado')).toBe(true)
    expect(tiene('admin', 'cancelar_pedido')).toBe(true)
    expect(tiene('reportes', 'anular_item_enviado')).toBe(false)
    expect(tiene('reportes', 'cancelar_pedido')).toBe(false)
  })
})

describe('permiso de cambiar lo ya enviado', () => {
  const item = nuevoId()
  const pedidoCon = (extras: number[]) =>
    ({
      items: {
        [item]: {
          modificadores: extras.map((precioExtra) => ({
            modificadorId: nuevoId(),
            nombre: 'Extra',
            precioExtra,
          })),
        },
      },
    }) as unknown as EstadoPedido
  const cambio = (datos: { notas?: string | null; modificadores?: { precio_extra: number }[] }) =>
    comoNuevo(
      evento(pedido, 'ItemModificadoTrasEnvio', {
        item_id: item,
        comanda_id: nuevoId(),
        ...(datos.notas !== undefined ? { notas: datos.notas } : {}),
        ...(datos.modificadores
          ? {
              modificadores: datos.modificadores.map((m) => ({
                modificador_id: nuevoId(),
                nombre: 'Extra',
                precio_extra: m.precio_extra,
              })),
            }
          : {}),
      }),
    )

  it('cambiar solo la nota pide tomar_pedido, también en un plato con extras', () => {
    expect(permisoPara(cambio({ notas: 'sin hielo' }), pedidoCon([3000]))).toBe('tomar_pedido')
    expect(permisoPara(cambio({ notas: null }), pedidoCon([3000]))).toBe('tomar_pedido')
    expect(permisoPara(cambio({ notas: 'sin hielo' }), null)).toBe('tomar_pedido')
  })

  it('quitar el cobro de un extra es una anulación parcial; igual o más caro, no', () => {
    const p = pedidoCon([3000])
    expect(permisoPara(cambio({ modificadores: [] }), p)).toBe('anular_item_enviado')
    expect(permisoPara(cambio({ modificadores: [{ precio_extra: 1000 }] }), p)).toBe(
      'anular_item_enviado',
    )
    expect(permisoPara(cambio({ modificadores: [{ precio_extra: 3000 }] }), p)).toBe('tomar_pedido')
    expect(
      permisoPara(cambio({ modificadores: [{ precio_extra: 3000 }, { precio_extra: 0 }] }), p),
    ).toBe('tomar_pedido')
    expect(permisoPara(cambio({ modificadores: [{ precio_extra: 4000 }] }), p)).toBe('tomar_pedido')
  })

  it('nota y modificadores juntos: manda el modificador que abarata', () => {
    expect(permisoPara(cambio({ notas: 'x', modificadores: [] }), pedidoCon([2000]))).toBe(
      'anular_item_enviado',
    )
  })

  it('sin extras de antes, cambiar modificadores gratis no pide permiso especial', () => {
    expect(permisoPara(cambio({ modificadores: [{ precio_extra: 0 }] }), pedidoCon([]))).toBe(
      'tomar_pedido',
    )
    expect(permisoPara(cambio({ modificadores: [] }), pedidoCon([]))).toBe('tomar_pedido')
  })

  it('un ítem que el estado no conoce no pide permiso especial (el reductor lo rechazará)', () => {
    const otro = { items: {} } as unknown as EstadoPedido
    expect(permisoPara(cambio({ modificadores: [] }), otro)).toBe('tomar_pedido')
  })
})
