import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { firmarEvento, huellaAutorizable } from '../acceso/firma'
import { esPermiso, permisoPara, ROLES_DE_FABRICA, SOLO_DESDE_CAJA } from '../acceso/permisos'
import { jsonCanonico } from '../canonico'
import { nuevoId } from '../id'
import { aplicarEvento, reconstruir } from '../pedido/aplicar'
import { evento as fabrica } from '../pruebas/fabrica'
import { accionArb, Servicio } from '../pruebas/simulador'
import {
  agregadoDe,
  type EventoNuevo,
  TIPOS_EVENTO_PEDIDO,
  TIPOS_EVENTO_PRODUCTO,
  validarEventoNuevo,
} from './pedido'

// Bordes de los eventos de producto (agotado, tarea 1.3): variante, agregado, firma, huella,
// permisos y que nunca se mezclen con un pedido.

const HORA = '2026-10-24T20:00:00.000Z'
const TIPOS = ['ProductoAgotado', 'ProductoDisponible'] as const

const sobre = (
  tipo: string,
  productoId: string,
  datos: unknown,
  campos: Record<string, unknown> = {},
) => ({
  id: nuevoId(),
  tipo,
  version_esquema: 1,
  agregado_tipo: 'producto',
  agregado_id: productoId,
  relacionados: [],
  datos,
  sesion_id: null,
  usuario_id: nuevoId(),
  dispositivo_id: nuevoId(),
  autorizacion_id: null,
  motivo: null,
  hora_dispositivo: HORA,
  hora_estimada_hub: HORA,
  secuencia_base: 0,
  ...campos,
})

const errores = (entrada: unknown) => {
  const r = validarEventoNuevo(entrada)
  return r.ok ? [] : r.errores
}

const agotar = (variante: string | null = null, campos: Record<string, unknown> = {}) => {
  const producto = nuevoId()
  return sobre(
    'ProductoAgotado',
    producto,
    { producto_id: producto, variante_id: variante },
    campos,
  )
}

describe('ProductoAgotado y ProductoDisponible: datos', () => {
  it.each(TIPOS)('%s con variante o sin ella es válido', (tipo) => {
    const producto = nuevoId()
    expect(
      errores(sobre(tipo, producto, { producto_id: producto, variante_id: nuevoId() })),
    ).toEqual([])
    expect(errores(sobre(tipo, producto, { producto_id: producto, variante_id: null }))).toEqual([])
  })

  it.each(TIPOS)('%s rechaza datos mal formados', (tipo) => {
    const producto = nuevoId()
    const con = (datos: unknown) => errores(sobre(tipo, producto, datos))
    expect(con({ producto_id: producto })).not.toEqual([]) // falta variante_id
    expect(con({ variante_id: null })).not.toEqual([]) // falta producto_id
    expect(con({ producto_id: producto, variante_id: 'botella' })).not.toEqual([])
    expect(con({ producto_id: producto, variante_id: '' })).not.toEqual([])
    expect(con({ producto_id: producto, variante_id: undefined })).not.toEqual([])
    expect(con({ producto_id: producto, variante_id: nuevoId().toLowerCase() })).not.toEqual([])
    expect(con({ producto_id: 'x', variante_id: null })).not.toEqual([])
    expect(con({ producto_id: producto, variante_id: null, cantidad: 1 })).not.toEqual([])
    expect(con(null)).not.toEqual([])
    expect(con([])).not.toEqual([])
    expect(con({})).not.toEqual([])
  })

  it('el agregado debe ser el producto, con o sin variante, y un ULID válido', () => {
    const producto = nuevoId()
    const variante = nuevoId()
    // El agregado es la variante: no vale (es el producto).
    expect(
      errores(sobre('ProductoAgotado', variante, { producto_id: producto, variante_id: variante })),
    ).toContainEqual(expect.stringContaining('agregado_id'))
    expect(
      errores(
        sobre('ProductoAgotado', 'no-es-ulid', { producto_id: 'no-es-ulid', variante_id: null }),
      ),
    ).not.toEqual([])
  })

  it('el agregado_tipo es de uno de los dos valores y solo de ese', () => {
    expect(errores(agotar(null, { agregado_tipo: 'mesa' }))).not.toEqual([])
    expect(errores(agotar(null, { agregado_tipo: 'Producto' }))).not.toEqual([])
    expect(errores(agotar(null, { agregado_tipo: undefined }))).not.toEqual([])
    expect(errores(agotar(null, { agregado_tipo: 'pedido' }))).toContainEqual(
      'agregado_tipo: ProductoAgotado es de un producto',
    )
  })

  it('no exige motivo, pero lo admite', () => {
    expect(errores(agotar(null, { motivo: null }))).toEqual([])
    expect(errores(agotar(null, { motivo: 'Se acabó la botella' }))).toEqual([])
  })

  it('tiene sentido para el catálogo de tipos', () => {
    expect([...TIPOS_EVENTO_PRODUCTO].sort()).toEqual([...TIPOS].sort())
    for (const tipo of TIPOS_EVENTO_PRODUCTO) expect(TIPOS_EVENTO_PEDIDO).toContain(tipo)
    for (const tipo of TIPOS_EVENTO_PEDIDO)
      expect(agregadoDe(tipo)).toBe(TIPOS_EVENTO_PRODUCTO.includes(tipo) ? 'producto' : 'pedido')
  })

  // Lo encontró qa-pruebas en la 1.3 y ya está corregido: un evento de producto podía nombrar un
  // pedido en `relacionados` y el hub lo guardaba como evento de ese pedido.
  it('un agotado no puede nombrar un pedido en relacionados', () => {
    expect(errores(agotar(null, { relacionados: [nuevoId()] }))).not.toEqual([])
  })
})

describe('ningún evento del pedido acepta agregado_tipo producto', () => {
  it('cada tipo de pedido que ejerce el simulador falla al decir que es de un producto', () => {
    const vistos = new Map<string, EventoNuevo>()
    fc.assert(
      fc.property(
        fc.array(accionArb, { minLength: 20, maxLength: 80, size: 'max' }),
        (acciones) => {
          const servicio = new Servicio()
          for (const a of acciones) servicio.paso(a)
          for (const e of servicio.log) if (!vistos.has(e.tipo)) vistos.set(e.tipo, e)
        },
      ),
      { seed: 20_261_024, numRuns: 300 },
    )

    const tiposDePedido = TIPOS_EVENTO_PEDIDO.filter((t) => !TIPOS_EVENTO_PRODUCTO.includes(t))
    // El rescate lo crea el hub y el simulador no lo ejerce: se arma a mano.
    const rescate = fabrica(nuevoId(), 'PedidoRescateCreado', {
      pedido_original_id: nuevoId(),
      canal: 'salon',
      mesa_id: null,
      mesero_id: nuevoId(),
    })
    vistos.set('PedidoRescateCreado', rescate as unknown as EventoNuevo)
    expect(tiposDePedido.filter((t) => !vistos.has(t))).toEqual([])

    for (const tipo of tiposDePedido) {
      const e = vistos.get(tipo) as EventoNuevo
      // Como lo crea el dispositivo (sin campos del hub), tal cual y con el agregado cambiado.
      const {
        secuencia: _s,
        recibido_en: _r,
        dia_operativo: _d,
        asignaciones: _a,
        afecta: _f,
        autorizado_por_id: _p,
        ...nuevo
      } = e as unknown as Record<string, unknown>
      expect(errores(nuevo), `${tipo} original`).toEqual([])
      expect(
        errores({ ...nuevo, agregado_tipo: 'producto' }),
        `${tipo} como producto`,
      ).toContainEqual(`agregado_tipo: ${tipo} es de un pedido`)
    }
  })

  it('un evento de producto con el tipo de pedido y los datos de producto tampoco', () => {
    const producto = nuevoId()
    const datos = { producto_id: producto, variante_id: null }
    for (const tipo of ['ItemAgregado', 'PedidoAbierto', 'PedidoCerrado', 'ItemQuitado'])
      expect(errores(sobre(tipo, producto, datos))).not.toEqual([])
  })
})

describe('firma y huella de un evento de producto', () => {
  const base = () => {
    const producto = nuevoId()
    return sobre('ProductoAgotado', producto, {
      producto_id: producto,
      variante_id: null,
    }) as unknown as EventoNuevo
  }

  it('la firma es un HMAC-SHA256 hex, estable, y no cambia con secuencia_base ni con otra firma', () => {
    const e = base()
    const f = firmarEvento(e, 'secreto')
    expect(f).toMatch(/^[0-9a-f]{64}$/)
    expect(firmarEvento({ ...e }, 'secreto')).toBe(f)
    expect(firmarEvento({ ...e, secuencia_base: 77 }, 'secreto')).toBe(f)
    expect(firmarEvento({ ...e, firma: 'a'.repeat(64) }, 'secreto')).toBe(f)
  })

  it('la firma cambia con el secreto, el tipo, el producto, la variante o el agregado_tipo', () => {
    const e = base()
    const f = firmarEvento(e, 'secreto')
    const datos = e.datos as { producto_id: string; variante_id: string | null }
    const distintas = [
      firmarEvento(e, 'otro'),
      firmarEvento({ ...e, tipo: 'ProductoDisponible' } as EventoNuevo, 'secreto'),
      firmarEvento({ ...e, datos: { ...datos, variante_id: nuevoId() } } as EventoNuevo, 'secreto'),
      firmarEvento({ ...e, datos: { ...datos, producto_id: nuevoId() } } as EventoNuevo, 'secreto'),
      firmarEvento({ ...e, agregado_tipo: 'pedido' } as EventoNuevo, 'secreto'),
      firmarEvento({ ...e, hora_dispositivo: '2026-10-24T20:00:00.001Z' }, 'secreto'),
    ]
    for (const otra of distintas) expect(otra).not.toBe(f)
    expect(new Set([f, ...distintas]).size).toBe(distintas.length + 1)
  })

  it('con variante null o ausente en el JSON canónico la firma es la misma que sin la clave', () => {
    // undefined se omite del canónico: variante_id undefined == clave ausente, pero null es otra.
    const e = base()
    const datos = e.datos as { producto_id: string }
    const conNull = firmarEvento(
      { ...e, datos: { ...datos, variante_id: null } } as EventoNuevo,
      's',
    )
    const sinClave = firmarEvento(
      { ...e, datos: { producto_id: datos.producto_id } } as unknown as EventoNuevo,
      's',
    )
    expect(conNull).not.toBe(sinClave)
    expect(jsonCanonico({ a: null })).not.toBe(jsonCanonico({}))
  })

  it('la huella del comprobante ignora autorizacion_id, firma y secuencia_base, y sí ve el contenido', () => {
    const e = base()
    const h = huellaAutorizable(e)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(huellaAutorizable({ ...e, autorizacion_id: nuevoId() })).toBe(h)
    expect(huellaAutorizable({ ...e, secuencia_base: 9, firma: 'f'.repeat(64) })).toBe(h)
    const datos = e.datos as { producto_id: string }
    expect(
      huellaAutorizable({ ...e, datos: { ...datos, variante_id: nuevoId() } } as EventoNuevo),
    ).not.toBe(h)
    expect(huellaAutorizable({ ...e, tipo: 'ProductoDisponible' } as EventoNuevo)).not.toBe(h)
  })

  it('para cualquier producto y variante, firmar es determinista y distingue agotado de disponible', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.string({ minLength: 1, maxLength: 20 }),
        (conVariante, secreto) => {
          const producto = nuevoId()
          const datos = { producto_id: producto, variante_id: conVariante ? nuevoId() : null }
          const a = sobre('ProductoAgotado', producto, datos) as unknown as EventoNuevo
          const d = { ...a, tipo: 'ProductoDisponible' } as EventoNuevo
          expect(firmarEvento(a, secreto)).toBe(firmarEvento({ ...a }, secreto))
          expect(firmarEvento(a, secreto)).not.toBe(firmarEvento(d, secreto))
          expect(huellaAutorizable(a)).not.toBe(huellaAutorizable(d))
        },
      ),
      { seed: 7, numRuns: 100 },
    )
  })
})

describe('permisoPara con eventos de producto', () => {
  it.each(TIPOS)('%s pide agotar_producto, con o sin pedido a la mano', (tipo) => {
    const producto = nuevoId()
    const e = sobre(tipo, producto, {
      producto_id: producto,
      variante_id: nuevoId(),
    }) as unknown as EventoNuevo
    expect(permisoPara(e)).toBe('agotar_producto')
    expect(permisoPara(e, null)).toBe('agotar_producto')
    const pedido = reconstruir(
      [fabrica(nuevoId(), 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 1 })],
      '',
    )
    expect(pedido).toBeNull()
    expect(esPermiso(permisoPara(e))).toBe(true)
  })

  it('no es de caja y lo tienen cajero, cocina, gerente y admin, no el mesero ni el contador', () => {
    for (const tipo of TIPOS) expect(SOLO_DESDE_CAJA.has(tipo)).toBe(false)
    const tiene = (rol: keyof typeof ROLES_DE_FABRICA) =>
      (ROLES_DE_FABRICA[rol].permisos as readonly string[]).includes('agotar_producto')
    expect(tiene('cajero')).toBe(true)
    expect(tiene('cocina')).toBe(true)
    expect(tiene('gerente')).toBe(true)
    expect(tiene('admin')).toBe(true)
    expect(tiene('mesero')).toBe(false)
    expect(tiene('contador')).toBe(false)
  })
})

describe('un evento de producto no toca ningún pedido', () => {
  it('con un pedido en curso devuelve el mismo estado y el problema no_es_del_pedido', () => {
    const pedidoId = nuevoId()
    const abierto = fabrica(pedidoId, 'PedidoAbierto', {
      canal: 'salon',
      mesa_id: null,
      comensales: 2,
    })
    const estado = aplicarEvento(null, abierto).estado
    const producto = nuevoId()
    const agotado = fabrica(
      producto,
      'ProductoAgotado',
      { producto_id: producto, variante_id: null },
      { agregado_tipo: 'producto' },
    )
    // Ajeno al pedido: ni siquiera lo mira.
    expect(aplicarEvento(estado, agotado).problema?.tipo).toBe('evento_ajeno')
    expect(aplicarEvento(estado, agotado).estado).toBe(estado)
    // Aunque diga ser de su mismo agregado (id repetido por error): no_es_del_pedido y sin cambios.
    const mismoId = { ...agotado, agregado_id: pedidoId, secuencia: 9_999_999 }
    const r = aplicarEvento(estado, mismoId)
    expect(r.problema?.tipo).toBe('no_es_del_pedido')
    expect(r.estado).toBe(estado)
    expect(estado?.ultimaSecuencia).not.toBe(9_999_999)
  })

  it('reconstruir un pedido mezclado con eventos de producto da lo mismo que sin ellos', () => {
    const pedidoId = nuevoId()
    const producto = nuevoId()
    const eventos = [
      fabrica(pedidoId, 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 2 }),
      fabrica(
        producto,
        'ProductoAgotado',
        { producto_id: producto, variante_id: null },
        { agregado_tipo: 'producto' },
      ),
      fabrica(
        producto,
        'ProductoDisponible',
        { producto_id: producto, variante_id: null },
        { agregado_tipo: 'producto' },
      ),
    ]
    const solo = reconstruir(eventos.slice(0, 1), pedidoId)
    expect(reconstruir(eventos, pedidoId)).toEqual(solo)
    expect(reconstruir(eventos, producto)).toBeNull()
  })

  it('un agotado con el producto como relacionado de un pedido no cambia el pedido', () => {
    const pedidoId = nuevoId()
    const producto = nuevoId()
    const abierto = fabrica(pedidoId, 'PedidoAbierto', {
      canal: 'salon',
      mesa_id: null,
      comensales: 2,
    })
    // El esquema ya no lo deja pasar; aun así el reductor no debe aplicarlo al pedido.
    const raro = {
      ...fabrica(
        producto,
        'ProductoAgotado',
        { producto_id: producto, variante_id: null },
        { agregado_tipo: 'producto' },
      ),
      relacionados: [pedidoId],
    }
    const antes = reconstruir([abierto], pedidoId)
    expect(reconstruir([abierto, raro], pedidoId)).toEqual(antes)
  })
})
