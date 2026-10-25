import { type EventoAplicable, nuevoId, reconstruir, totalesPedido } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { porEnviar, unidadesPorEnviar } from './pedido'
import { estadoMesa, itemsVigentes, pedidosAbiertos } from './proyeccion'
import { apertura, datosItem as item, local } from './pruebas'

// `unidadesPorEnviar` (lo que dice «Enviar N» y el aviso) y la proyección del pedido con `notas`.

const estadoCon = (...fabricas: ((p: string) => ReturnType<typeof local>)[]) => {
  const p = nuevoId()
  const locales = [local('PedidoAbierto', p, apertura), ...fabricas.map((f) => f(p))]
  const estado = reconstruir(
    locales.map((l) => l.evento),
    p,
  )
  if (!estado) throw new Error('sin estado')
  return { p, locales, estado }
}
const agrega =
  (datos: ReturnType<typeof item>, e: 'confirmado' | 'pendiente' = 'confirmado') =>
  (p: string) =>
    local('ItemAgregado', p, datos, e)

describe('unidadesPorEnviar', () => {
  it('un pedido sin ítems o sin nada por enviar da 0', () => {
    expect(unidadesPorEnviar(estadoCon().estado)).toBe(0)
    const a = item({ cantidad: 2 })
    const { estado } = estadoCon(agrega(a), (p) =>
      local('ItemsEnviados', p, {
        comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [a.item_id] }],
      }),
    )
    expect(unidadesPorEnviar(estado)).toBe(0)
  })

  it('3 Aperol en una línea son 3 unidades, no 1', () => {
    const { estado } = estadoCon(agrega(item({ cantidad: 3 })))
    expect(porEnviar(estado)).toHaveLength(1)
    expect(unidadesPorEnviar(estado)).toBe(3)
  })

  it('suma las unidades de todas las líneas sin enviar', () => {
    const { estado } = estadoCon(
      agrega(item({ cantidad: 3 })),
      agrega(item({ cantidad: 2 })),
      agrega(item({ cantidad: 1 })),
    )
    expect(unidadesPorEnviar(estado)).toBe(6)
  })

  it('lo ya enviado no cuenta; lo agregado después sí', () => {
    const a = item({ cantidad: 4 })
    const b = item({ cantidad: 2 })
    const { estado } = estadoCon(
      agrega(a),
      (p) =>
        local('ItemsEnviados', p, {
          comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [a.item_id] }],
        }),
      agrega(b),
    )
    expect(unidadesPorEnviar(estado)).toBe(2)
  })

  it('sumar o restar unidades a una línea (ItemCambiado) se refleja', () => {
    const a = item({ cantidad: 2 })
    const { estado } = estadoCon(agrega(a), (p) =>
      local('ItemCambiado', p, { item_id: a.item_id, cantidad: 5 }),
    )
    expect(unidadesPorEnviar(estado)).toBe(5)
  })

  it('una línea quitada no cuenta', () => {
    const a = item({ cantidad: 3 })
    const b = item({ cantidad: 1 })
    const { estado } = estadoCon(agrega(a), agrega(b), (p) =>
      local('ItemQuitado', p, { item_id: a.item_id }),
    )
    expect(unidadesPorEnviar(estado)).toBe(1)
  })

  it('con anulaciones parciales (línea movida con unidades ya anuladas) descuenta lo anulado', () => {
    // Un ítem sin enviar puede llegar con unidades anuladas desde otro pedido (ItemsMovidos).
    const destino = nuevoId()
    const origen = nuevoId()
    const a = item({ cantidad: 5 })
    const locales = [
      local('PedidoAbierto', destino, apertura),
      local(
        'ItemsMovidos',
        origen,
        {
          pedido_destino_id: destino,
          items: [{ item: a, estado: 'pendiente', cantidad_anulada: 2, agregado_por: nuevoId() }],
        },
        'confirmado',
        { relacionados: [destino] },
      ),
    ]
    const estado = reconstruir(
      locales.map((l) => l.evento),
      destino,
    )
    expect(estado?.items[a.item_id]).toMatchObject({
      cantidad: 5,
      cantidadAnulada: 2,
      estado: 'pendiente',
    })
    expect(estado && unidadesPorEnviar(estado)).toBe(3)
  })

  it('una línea movida con todas las unidades anuladas menos una cuenta 1', () => {
    const destino = nuevoId()
    const a = item({ cantidad: 4 })
    const estado = reconstruir(
      [
        local('PedidoAbierto', destino, apertura),
        local(
          'ItemsMovidos',
          nuevoId(),
          {
            pedido_destino_id: destino,
            items: [{ item: a, estado: 'pendiente', cantidad_anulada: 3, agregado_por: nuevoId() }],
          },
          'confirmado',
          { relacionados: [destino] },
        ),
      ].map((l) => l.evento),
      destino,
    )
    expect(estado && unidadesPorEnviar(estado)).toBe(1)
  })

  it('lo retenido (curso en espera) no se manda con «Enviar»: no cuenta; al marchar sí', () => {
    const entrada = item({ cantidad: 2, curso: 'entrada' })
    const fuerte = item({ cantidad: 3, curso: 'fuerte' })
    const sinCurso = item({ cantidad: 1 })
    const retenido = estadoCon(
      (p) => local('CursoRetenido', p, { curso: 'fuerte' }),
      agrega(entrada),
      agrega(fuerte),
      agrega(sinCurso),
    ).estado
    expect(retenido.items[fuerte.item_id]?.estado).toBe('retenido')
    expect(unidadesPorEnviar(retenido)).toBe(3)
    const marchado = estadoCon(
      (p) => local('CursoRetenido', p, { curso: 'fuerte' }),
      agrega(entrada),
      agrega(fuerte),
      agrega(sinCurso),
      (p) => local('CursoMarchado', p, { curso: 'fuerte' }),
    ).estado
    expect(unidadesPorEnviar(marchado)).toBe(6)
  })

  it('propiedad: es la suma de (cantidad − anulada) de las líneas pendientes y nunca menos que las líneas', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20 }), { maxLength: 15 }),
        fc.array(fc.boolean(), { maxLength: 15 }),
        (cantidades, enviadas) => {
          const datos = cantidades.map((cantidad) => item({ cantidad }))
          const aEnviar = datos.filter((_, i) => enviadas[i])
          const { estado } = estadoCon(
            ...datos.map((d) => agrega(d)),
            ...(aEnviar.length
              ? [
                  (p: string) =>
                    local('ItemsEnviados', p, {
                      comandas: [
                        {
                          comanda_id: nuevoId(),
                          estacion_id: nuevoId(),
                          item_ids: aEnviar.map((d) => d.item_id),
                        },
                      ],
                    }),
                ]
              : []),
          )
          const esperado = cantidades.reduce((n, c, i) => n + (enviadas[i] ? 0 : c), 0)
          expect(unidadesPorEnviar(estado)).toBe(esperado)
          expect(unidadesPorEnviar(estado)).toBeGreaterThanOrEqual(porEnviar(estado).length)
        },
      ),
      { seed: 20_261_025, numRuns: 150 },
    )
  })
})

describe('la proyección del pedido con notas', () => {
  const nota =
    (notas: string | null, e: 'confirmado' | 'pendiente' = 'confirmado') =>
    (p: string) =>
      local('NotaPedidoCambiada', p, { notas }, e)

  it('muestra la nota confirmada del hub', () => {
    const { locales } = estadoCon(nota('alérgico al maní'))
    expect(pedidosAbiertos(locales)[0]?.estado.notas).toBe('alérgico al maní')
  })

  it('un pedido sin nota la trae en null (también el de antes de existir el evento)', () => {
    const { locales } = estadoCon(agrega(item()))
    const visible = pedidosAbiertos(locales)[0]
    expect(visible?.estado.notas).toBeNull()
    expect(visible?.estado).toHaveProperty('notas', null)
  })

  it('la nota propia aún pendiente se ve encima de la confirmada, sin conexión', () => {
    const { locales, p } = estadoCon(nota('vieja'))
    const todos = [...locales, local('NotaPedidoCambiada', p, { notas: 'nueva' }, 'pendiente')]
    const visible = pedidosAbiertos(todos)[0]
    expect(visible?.estado.notas).toBe('nueva')
    expect(visible?.porConfirmar).toBe(true)
    expect(visible?.itemsPorConfirmar.size).toBe(0)
  })

  it('quitar la nota estando pendiente la deja en null', () => {
    const { locales, p } = estadoCon(nota('vieja'))
    const todos = [...locales, local('NotaPedidoCambiada', p, { notas: null }, 'pendiente')]
    expect(pedidosAbiertos(todos)[0]?.estado.notas).toBeNull()
  })

  it('una nota que el hub rechazó no cuenta', () => {
    const { locales, p } = estadoCon(nota('buena'))
    const rechazada = {
      ...local('NotaPedidoCambiada', p, { notas: 'mala' }, 'pendiente'),
      estado: 'rechazado' as const,
    }
    expect(pedidosAbiertos([...locales, rechazada])[0]?.estado.notas).toBe('buena')
  })

  it('con dos notas confirmadas manda la de mayor secuencia, aunque lleguen desordenadas', () => {
    const { locales, p } = estadoCon()
    const a = local('NotaPedidoCambiada', p, { notas: 'primera' })
    const b = local('NotaPedidoCambiada', p, { notas: 'segunda' })
    expect(pedidosAbiertos([locales[0] as never, b, a])[0]?.estado.notas).toBe('segunda')
  })

  it('la nota no cambia el total, las líneas ni el estado de la mesa', () => {
    const base = estadoCon(agrega(item({ cantidad: 2 })))
    const con = estadoCon(agrega(item({ cantidad: 2 })), nota('algo'))
    const vb = pedidosAbiertos(base.locales)
    const vc = pedidosAbiertos(con.locales)
    expect(vc[0]?.total).toBe(vb[0]?.total)
    expect(estadoMesa(vc)).toBe(estadoMesa(vb))
    expect(itemsVigentes(con.estado)).toHaveLength(1)
    expect(totalesPedido(con.estado).neto).toBe(totalesPedido(base.estado).neto)
  })

  it('un pedido cancelado deja de verse aunque tenga nota', () => {
    const { locales, p } = estadoCon(nota('algo'))
    const cancelado = [
      ...locales,
      local('PedidoCancelado', p, {}, 'confirmado', { motivo: 'Se fueron' }),
    ]
    expect(pedidosAbiertos(cancelado)).toEqual([])
  })

  it('una nota que llega con el pedido cerrado no cambia el estado (el reductor la rechaza)', () => {
    const { locales, p } = estadoCon(nota('antes'))
    const cerrado = reconstruir(
      [
        ...locales,
        local('PedidoCancelado', p, {}, 'confirmado', { motivo: 'Se fueron' }),
        local('NotaPedidoCambiada', p, { notas: 'tarde' }),
      ].map((l) => l.evento as EventoAplicable),
      p,
    )
    expect(cerrado?.estado).toBe('cancelado')
    expect(cerrado?.notas).toBe('antes')
  })
})
