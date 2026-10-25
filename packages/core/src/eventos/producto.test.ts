import { describe, expect, it } from 'vitest'
import { permisoPara } from '../acceso/permisos'
import { nuevoId } from '../id'
import { aplicarEvento, reconstruir } from '../pedido/aplicar'
import { agregadoDe, type EventoNuevo, validarEventoNuevo } from './pedido'

// Agotado (86): eventos del producto, no del pedido. Viajan en la misma secuencia que los pedidos.

const producto = nuevoId()
const sobre = (tipo: string, datos: unknown, campos: Record<string, unknown> = {}) => ({
  id: nuevoId(),
  tipo,
  version_esquema: 1,
  agregado_tipo: 'producto',
  agregado_id: producto,
  relacionados: [],
  datos,
  sesion_id: null,
  usuario_id: nuevoId(),
  dispositivo_id: nuevoId(),
  autorizacion_id: null,
  motivo: null,
  hora_dispositivo: '2026-10-24T20:00:00.000Z',
  hora_estimada_hub: '2026-10-24T20:00:00.000Z',
  secuencia_base: 0,
  ...campos,
})

describe('eventos de producto (agotado)', () => {
  it('se validan con su agregado: el producto', () => {
    for (const tipo of ['ProductoAgotado', 'ProductoDisponible'])
      expect(validarEventoNuevo(sobre(tipo, { producto_id: producto, variante_id: null })).ok).toBe(
        true,
      )
    expect(
      validarEventoNuevo(
        sobre('ProductoAgotado', { producto_id: producto, variante_id: nuevoId() }),
      ).ok,
    ).toBe(true)
  })

  it('rechaza un agotado que dice ser de un pedido, o de otro producto', () => {
    const r1 = validarEventoNuevo(
      sobre(
        'ProductoAgotado',
        { producto_id: producto, variante_id: null },
        { agregado_tipo: 'pedido' },
      ),
    )
    expect(r1.ok).toBe(false)
    const r2 = validarEventoNuevo(
      sobre('ProductoAgotado', { producto_id: nuevoId(), variante_id: null }),
    )
    expect(r2.ok).toBe(false)
  })

  it('un evento de pedido no puede decir que es de un producto', () => {
    const r = validarEventoNuevo(
      sobre(
        'PedidoAbierto',
        { canal: 'salon', mesa_id: null, comensales: 2 },
        { agregado_tipo: 'producto' },
      ),
    )
    expect(r.ok).toBe(false)
  })

  it('pide el permiso agotar_producto y no toca ningún pedido', () => {
    const e = sobre('ProductoAgotado', { producto_id: producto, variante_id: null }) as EventoNuevo
    expect(permisoPara(e)).toBe('agotar_producto')
    expect(agregadoDe('ProductoDisponible')).toBe('producto')
    expect(agregadoDe('ItemAgregado')).toBe('pedido')
    expect(aplicarEvento(null, e).problema?.tipo).toBe('no_es_del_pedido')
    expect(reconstruir([e], producto)).toBeNull()
  })
})
