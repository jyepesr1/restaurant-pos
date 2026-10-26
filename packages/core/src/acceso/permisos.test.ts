import { describe, expect, it } from 'vitest'
import { TIPOS_EVENTO_PEDIDO } from '../eventos/pedido'
import { evento } from '../pruebas/fabrica'
import {
  DESCRIPCION_PERMISOS,
  esPermiso,
  PERMISOS,
  permisoPara,
  ROLES_DE_FABRICA,
  SOLO_DESDE_CAJA,
} from './permisos'

describe('permisos', () => {
  it('reconoce solo las claves fijas', () => {
    expect(esPermiso('tomar_pedido')).toBe(true)
    expect(esPermiso('borrar_todo')).toBe(false)
    expect(esPermiso(3)).toBe(false)
  })

  it('los roles de fábrica siguen la matriz de MODELO_DATOS.md (ADR-013)', () => {
    const tiene = (rol: keyof typeof ROLES_DE_FABRICA, permiso: string) =>
      (ROLES_DE_FABRICA[rol].permisos as readonly string[]).includes(permiso)

    expect(tiene('admin', 'administrar_dispositivos')).toBe(true)
    expect(tiene('admin', 'administrar_usuarios')).toBe(true)
    expect(tiene('cajero', 'administrar_usuarios')).toBe(false)
    expect(tiene('cajero', 'anular_item_enviado')).toBe(true)
    expect(tiene('mesero', 'anular_item_enviado')).toBe(false)
    expect(tiene('mesero', 'registrar_pago')).toBe(false)
    expect(tiene('cajero', 'cerrar_mesa')).toBe(true)
    expect(tiene('cajero', 'anular_pago')).toBe(false)
    expect(ROLES_DE_FABRICA.reportes.permisos).toEqual(['ver_reportes'])
    for (const rol of Object.values(ROLES_DE_FABRICA))
      for (const permiso of rol.permisos) expect(PERMISOS).toContain(permiso)
  })

  it('la pantalla de roles describe cada permiso una sola vez', () => {
    const descritos = DESCRIPCION_PERMISOS.flatMap((g) => g.permisos.map((p) => p.permiso))
    expect([...descritos].sort()).toEqual([...PERMISOS].sort())
  })

  it('cada tipo de evento tiene su permiso; la cortesía pide uno propio', () => {
    const pedido = evento('01JB0000000000000000000000', 'PedidoAbierto', {
      canal: 'salon',
      mesa_id: null,
      comensales: 2,
    })
    expect(permisoPara(pedido)).toBe('tomar_pedido')
    const anulado = { ...pedido, tipo: 'ItemAnulado' } as unknown as Parameters<
      typeof permisoPara
    >[0]
    expect(permisoPara(anulado)).toBe('anular_item_enviado')

    const descuento = (regla: string) =>
      ({ ...pedido, tipo: 'DescuentoAplicado', datos: { regla } }) as unknown as Parameters<
        typeof permisoPara
      >[0]
    expect(permisoPara(descuento('cortesia'))).toBe('cortesia')
    expect(permisoPara(descuento('porcentaje'))).toBe('descontar')

    const rescate = { ...pedido, tipo: 'PedidoRescateCreado' } as unknown as Parameters<
      typeof permisoPara
    >[0]
    expect(permisoPara(rescate)).toBeNull()
    for (const tipo of TIPOS_EVENTO_PEDIDO) {
      const p = permisoPara({ ...pedido, tipo } as unknown as Parameters<typeof permisoPara>[0])
      expect(p === null || esPermiso(p)).toBe(true)
    }
  })

  it('pagos y cierres solo desde la caja', () => {
    expect([...SOLO_DESDE_CAJA].sort()).toEqual(
      [
        'PagoAnulado',
        'PagoRegistrado',
        'PedidoCerrado',
        'ReembolsoRegistrado',
        'TurnoAbierto',
        'MovimientoCajaRegistrado',
        'ArqueoRegistrado',
        'TurnoCerrado',
      ].sort(),
    )
  })

  it('abaratar los modificadores de un ítem ya enviado pide anular; encarecer, no', () => {
    const itemId = '01JB0000000000000000000009'
    const cambio = (precios: number[]) =>
      ({
        ...evento('01JB0000000000000000000000', 'PedidoAbierto', {
          canal: 'salon',
          mesa_id: null,
          comensales: 2,
        }),
        tipo: 'ItemModificadoTrasEnvio',
        datos: {
          item_id: itemId,
          comanda_id: '01JB0000000000000000000008',
          modificadores: precios.map((precio_extra, i) => ({
            modificador_id: `01JB000000000000000000000${i}`,
            nombre: 'Extra',
            precio_extra,
          })),
        },
      }) as unknown as Parameters<typeof permisoPara>[0]
    const pedido = {
      items: {
        [itemId]: { modificadores: [{ modificadorId: 'x', nombre: 'Extra', precioExtra: 3000 }] },
      },
    } as unknown as Parameters<typeof permisoPara>[1]

    expect(permisoPara(cambio([]), pedido)).toBe('anular_item_enviado')
    expect(permisoPara(cambio([3000]), pedido)).toBe('tomar_pedido')
    expect(permisoPara(cambio([5000]), pedido)).toBe('tomar_pedido')
    expect(permisoPara(cambio([]), null)).toBe('tomar_pedido')
  })
})
