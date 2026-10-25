import { nuevoId, reconstruir } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { comandasDeCurso, datosItem, lineaIgual } from './pedido'
import { agotados, claveAgotado, masPedidos, pedidosAbiertos } from './proyeccion'
import { apertura, catalogoDePrueba, datosItem as item, local } from './pruebas'

const simple = {
  id: nuevoId(),
  nombre: 'Limonada',
  descripcion: null,
  favorito: false,
  precio: 9_900,
  impuesto: { tipo: 'inc' as const, tarifa: 800 },
  variantes: [],
  grupos: [],
}
const conPlatos = () =>
  catalogoDePrueba({
    categorias: [{ id: nuevoId(), nombre: 'Bebidas', estacionId: 'E-BARRA', productos: [simple] }],
  })

// Toma de pedido de la 1.3: agotados, lo más pedido, la línea que suma, marchar un curso y los
// datos del ítem con persona, curso y nota.

const agotado = (
  producto: string,
  estado: 'confirmado' | 'pendiente' = 'confirmado',
  variante: string | null = null,
) =>
  local('ProductoAgotado', producto, { producto_id: producto, variante_id: variante }, estado, {
    agregado_tipo: 'producto',
  })
const disponible = (producto: string, estado: 'confirmado' | 'pendiente' = 'confirmado') =>
  local('ProductoDisponible', producto, { producto_id: producto, variante_id: null }, estado, {
    agregado_tipo: 'producto',
  })

describe('agotados (86)', () => {
  it('el último evento manda; lo propio pendiente va encima de lo confirmado', () => {
    const p = nuevoId()
    expect(agotados([agotado(p)])).toEqual(new Set([p]))
    expect(agotados([agotado(p), disponible(p)])).toEqual(new Set())
    // Confirmado "disponible", pero este equipo lo acaba de marcar agotado sin conexión.
    expect(agotados([disponible(p), agotado(p, 'pendiente')])).toEqual(new Set([p]))
  })

  it('una variante se agota sola (la botella, no la copa)', () => {
    const p = nuevoId()
    const botella = nuevoId()
    expect(agotados([agotado(p, 'confirmado', botella)])).toEqual(
      new Set([claveAgotado(p, botella)]),
    )
  })

  it('un evento rechazado no cuenta, y los eventos de producto no se vuelven pedidos', () => {
    const p = nuevoId()
    const rechazado = { ...agotado(p), estado: 'rechazado' as const }
    expect(agotados([rechazado])).toEqual(new Set())
    const pedido = nuevoId()
    expect(
      pedidosAbiertos([agotado(p), local('PedidoAbierto', pedido, apertura)]).map(
        (x) => x.estado.id,
      ),
    ).toEqual([pedido])
  })
})

describe('lo más pedido', () => {
  it('cuenta unidades por producto, del más al menos', () => {
    const pedido = nuevoId()
    const a = nuevoId()
    const b = nuevoId()
    const locales = [
      local('PedidoAbierto', pedido, apertura),
      local('ItemAgregado', pedido, item({ producto_id: a, cantidad: 1 })),
      local('ItemAgregado', pedido, item({ producto_id: b, cantidad: 3 })),
      local('ItemAgregado', pedido, item({ producto_id: a, cantidad: 1 })),
    ]
    expect(masPedidos(locales)).toEqual([b, a])
    expect(masPedidos(locales, 1)).toEqual([b])
  })
})

describe('el mismo producto otra vez', () => {
  const pedidoCon = (...datos: ReturnType<typeof item>[]) => {
    const pedido = nuevoId()
    return reconstruir(
      [
        local('PedidoAbierto', pedido, apertura),
        ...datos.map((d) => local('ItemAgregado', pedido, d)),
      ].map((l) => l.evento),
      pedido,
    )
  }

  it('suma a la línea sin enviar igual: mismo producto, persona, curso, sin nota', () => {
    const producto = nuevoId()
    const primera = item({ producto_id: producto })
    const estado = pedidoCon(primera)
    expect(lineaIgual(estado, item({ producto_id: producto }))?.id).toBe(primera.item_id)
  })

  it('no suma si cambia la persona, el curso, la nota o las opciones', () => {
    const producto = nuevoId()
    const estado = pedidoCon(item({ producto_id: producto }))
    expect(lineaIgual(estado, item({ producto_id: producto, comensal: 2 }))).toBeNull()
    expect(lineaIgual(estado, item({ producto_id: producto, curso: 'fuerte' }))).toBeNull()
    expect(lineaIgual(estado, item({ producto_id: producto, notas: 'sin hielo' }))).toBeNull()
    expect(
      lineaIgual(
        estado,
        item({
          producto_id: producto,
          modificadores: [{ modificador_id: nuevoId(), nombre: 'Doble', precio_extra: 0 }],
        }),
      ),
    ).toBeNull()
    expect(lineaIgual(null, item({ producto_id: producto }))).toBeNull()
  })
})

describe('marchar un curso', () => {
  it('manda solo lo del curso, por estación', () => {
    const catalogo = conPlatos()
    const pedido = nuevoId()
    const entrada = item({ producto_id: simple.id, curso: 'entrada' })
    const fuerte = item({ producto_id: simple.id, curso: 'fuerte' })
    const estado = reconstruir(
      [
        local('PedidoAbierto', pedido, apertura),
        local('ItemAgregado', pedido, entrada),
        local('ItemAgregado', pedido, fuerte),
      ].map((l) => l.evento),
      pedido,
    )
    if (!estado) throw new Error('falta')
    const datos = comandasDeCurso(catalogo, estado, 'fuerte')
    expect(datos?.comandas).toEqual([
      expect.objectContaining({ estacion_id: 'E-BARRA', item_ids: [fuerte.item_id] }),
    ])
    expect(comandasDeCurso(catalogo, estado, 'postre')).toBeNull()
  })
})

describe('datos del ítem', () => {
  it('llevan persona, curso, cantidad y la nota recortada (vacía es null)', () => {
    const catalogo = conPlatos()
    const p = simple
    expect(
      datosItem(
        catalogo,
        p,
        null,
        {},
        { comensal: 2, curso: 'postre', cantidad: 3, notas: '  sin azúcar ' },
      ),
    ).toMatchObject({
      comensal: 2,
      curso: 'postre',
      cantidad: 3,
      notas: 'sin azúcar',
    })
    expect(datosItem(catalogo, p, null, {}, { notas: '   ' }).notas).toBeNull()
  })
})
