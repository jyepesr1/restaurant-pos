import { type ApplicableEvent, newId, orderTotals, rebuild } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { porEnviar, unidadesPorEnviar } from './pedido'
import { estadoMesa, itemsVigentes, pedidosAbiertos } from './proyeccion'
import { datosItem as item, local, opening } from './pruebas'

// `unidadesPorEnviar` (lo que dice «Enviar N» y el aviso) y la proyección del pedido con `notas`.

const estadoCon = (...fabricas: ((p: string) => ReturnType<typeof local>)[]) => {
  const p = newId()
  const locales = [local('OrderOpened', p, opening), ...fabricas.map((f) => f(p))]
  const status = rebuild(
    locales.map((l) => l.event),
    p,
  )
  if (!status) throw new Error('sin estado')
  return { p, locales, status }
}
const adds =
  (data: ReturnType<typeof item>, e: 'confirmed' | 'pending' = 'confirmed') =>
  (p: string) =>
    local('ItemAdded', p, data, e)

describe('unidadesPorEnviar', () => {
  it('un pedido sin ítems o sin nada por enviar da 0', () => {
    expect(unidadesPorEnviar(estadoCon().status)).toBe(0)
    const a = item({ quantity: 2 })
    const { status } = estadoCon(adds(a), (p) =>
      local('ItemsSent', p, {
        tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [a.item_id] }],
      }),
    )
    expect(unidadesPorEnviar(status)).toBe(0)
  })

  it('3 Aperol en una línea son 3 unidades, no 1', () => {
    const { status } = estadoCon(adds(item({ quantity: 3 })))
    expect(porEnviar(status)).toHaveLength(1)
    expect(unidadesPorEnviar(status)).toBe(3)
  })

  it('suma las unidades de todas las líneas sin enviar', () => {
    const { status } = estadoCon(
      adds(item({ quantity: 3 })),
      adds(item({ quantity: 2 })),
      adds(item({ quantity: 1 })),
    )
    expect(unidadesPorEnviar(status)).toBe(6)
  })

  it('lo ya enviado no cuenta; lo agregado después sí', () => {
    const a = item({ quantity: 4 })
    const b = item({ quantity: 2 })
    const { status } = estadoCon(
      adds(a),
      (p) =>
        local('ItemsSent', p, {
          tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [a.item_id] }],
        }),
      adds(b),
    )
    expect(unidadesPorEnviar(status)).toBe(2)
  })

  it('sumar o restar unidades a una línea (ItemCambiado) se refleja', () => {
    const a = item({ quantity: 2 })
    const { status } = estadoCon(adds(a), (p) =>
      local('ItemChanged', p, { item_id: a.item_id, quantity: 5 }),
    )
    expect(unidadesPorEnviar(status)).toBe(5)
  })

  it('una línea quitada no cuenta', () => {
    const a = item({ quantity: 3 })
    const b = item({ quantity: 1 })
    const { status } = estadoCon(adds(a), adds(b), (p) =>
      local('ItemRemoved', p, { item_id: a.item_id }),
    )
    expect(unidadesPorEnviar(status)).toBe(1)
  })

  it('con anulaciones parciales (línea movida con unidades ya anuladas) descuenta lo anulado', () => {
    // Un ítem sin enviar puede llegar con unidades anuladas desde otro pedido (ItemsMoved).
    const target = newId()
    const source = newId()
    const a = item({ quantity: 5 })
    const locales = [
      local('OrderOpened', target, opening),
      local(
        'ItemsMoved',
        source,
        {
          target_order_id: target,
          items: [{ item: a, status: 'pending', voided_quantity: 2, added_by: newId() }],
        },
        'confirmed',
        { related: [target] },
      ),
    ]
    const status = rebuild(
      locales.map((l) => l.event),
      target,
    )
    expect(status?.items[a.item_id]).toMatchObject({
      quantity: 5,
      voidedQuantity: 2,
      status: 'pending',
    })
    expect(status && unidadesPorEnviar(status)).toBe(3)
  })

  it('una línea movida con todas las unidades anuladas menos una cuenta 1', () => {
    const target = newId()
    const a = item({ quantity: 4 })
    const status = rebuild(
      [
        local('OrderOpened', target, opening),
        local(
          'ItemsMoved',
          newId(),
          {
            target_order_id: target,
            items: [{ item: a, status: 'pending', voided_quantity: 3, added_by: newId() }],
          },
          'confirmed',
          { related: [target] },
        ),
      ].map((l) => l.event),
      target,
    )
    expect(status && unidadesPorEnviar(status)).toBe(1)
  })

  it('lo retenido (curso en espera) no se manda con «Enviar»: no cuenta; al marchar sí', () => {
    const entry = item({ quantity: 2, course: 'entry' })
    const main = item({ quantity: 3, course: 'main' })
    const sinCurso = item({ quantity: 1 })
    const held = estadoCon(
      (p) => local('CourseHeld', p, { course: 'main' }),
      adds(entry),
      adds(main),
      adds(sinCurso),
    ).status
    expect(held.items[main.item_id]?.status).toBe('held')
    expect(unidadesPorEnviar(held)).toBe(3)
    const fired = estadoCon(
      (p) => local('CourseHeld', p, { course: 'main' }),
      adds(entry),
      adds(main),
      adds(sinCurso),
      (p) => local('CourseFired', p, { course: 'main' }),
    ).status
    expect(unidadesPorEnviar(fired)).toBe(6)
  })

  it('propiedad: es la suma de (cantidad − anulada) de las líneas pendientes y nunca menos que las líneas', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20 }), { maxLength: 15 }),
        fc.array(fc.boolean(), { maxLength: 15 }),
        (cantidades, enviadas) => {
          const data = cantidades.map((quantity) => item({ quantity }))
          const aEnviar = data.filter((_, i) => enviadas[i])
          const { status } = estadoCon(
            ...data.map((d) => adds(d)),
            ...(aEnviar.length
              ? [
                  (p: string) =>
                    local('ItemsSent', p, {
                      tickets: [
                        {
                          ticket_id: newId(),
                          station_id: newId(),
                          item_ids: aEnviar.map((d) => d.item_id),
                        },
                      ],
                    }),
                ]
              : []),
          )
          const expected = cantidades.reduce((n, c, i) => n + (enviadas[i] ? 0 : c), 0)
          expect(unidadesPorEnviar(status)).toBe(expected)
          expect(unidadesPorEnviar(status)).toBeGreaterThanOrEqual(porEnviar(status).length)
        },
      ),
      { seed: 20_261_025, numRuns: 150 },
    )
  })
})

describe('la proyección del pedido con notas', () => {
  const note =
    (notes: string | null, e: 'confirmed' | 'pending' = 'confirmed') =>
    (p: string) =>
      local('OrderNoteChanged', p, { notes }, e)

  it('muestra la nota confirmada del hub', () => {
    const { locales } = estadoCon(note('alérgico al maní'))
    expect(pedidosAbiertos(locales)[0]?.status.notes).toBe('alérgico al maní')
  })

  it('un pedido sin nota la trae en null (también el de antes de existir el evento)', () => {
    const { locales } = estadoCon(adds(item()))
    const visible = pedidosAbiertos(locales)[0]
    expect(visible?.status.notes).toBeNull()
    expect(visible?.status).toHaveProperty('notes', null)
  })

  it('la nota propia aún pendiente se ve encima de la confirmada, sin conexión', () => {
    const { locales, p } = estadoCon(note('vieja'))
    const all = [...locales, local('OrderNoteChanged', p, { notes: 'nueva' }, 'pending')]
    const visible = pedidosAbiertos(all)[0]
    expect(visible?.status.notes).toBe('nueva')
    expect(visible?.porConfirmar).toBe(true)
    expect(visible?.itemsPorConfirmar.size).toBe(0)
  })

  it('quitar la nota estando pendiente la deja en null', () => {
    const { locales, p } = estadoCon(note('vieja'))
    const all = [...locales, local('OrderNoteChanged', p, { notes: null }, 'pending')]
    expect(pedidosAbiertos(all)[0]?.status.notes).toBeNull()
  })

  it('una nota que el hub rechazó no cuenta', () => {
    const { locales, p } = estadoCon(note('buena'))
    const rechazada = {
      ...local('OrderNoteChanged', p, { notes: 'mala' }, 'pending'),
      status: 'rejected' as const,
    }
    expect(pedidosAbiertos([...locales, rechazada])[0]?.status.notes).toBe('buena')
  })

  it('con dos notas confirmadas manda la de mayor secuencia, aunque lleguen desordenadas', () => {
    const { locales, p } = estadoCon()
    const a = local('OrderNoteChanged', p, { notes: 'primera' })
    const b = local('OrderNoteChanged', p, { notes: 'segunda' })
    expect(pedidosAbiertos([locales[0] as never, b, a])[0]?.status.notes).toBe('segunda')
  })

  it('la nota no cambia el total, las líneas ni el estado de la mesa', () => {
    const base = estadoCon(adds(item({ quantity: 2 })))
    const withIt = estadoCon(adds(item({ quantity: 2 })), note('algo'))
    const vb = pedidosAbiertos(base.locales)
    const vc = pedidosAbiertos(withIt.locales)
    expect(vc[0]?.total).toBe(vb[0]?.total)
    expect(estadoMesa(vc)).toBe(estadoMesa(vb))
    expect(itemsVigentes(withIt.status)).toHaveLength(1)
    expect(orderTotals(withIt.status).net).toBe(orderTotals(base.status).net)
  })

  it('un pedido cancelado deja de verse aunque tenga nota', () => {
    const { locales, p } = estadoCon(note('algo'))
    const canceled = [
      ...locales,
      local('OrderCanceled', p, {}, 'confirmed', { reason: 'Se fueron' }),
    ]
    expect(pedidosAbiertos(canceled)).toEqual([])
  })

  it('una nota que llega con el pedido cerrado no cambia el estado (el reductor la rechaza)', () => {
    const { locales, p } = estadoCon(note('antes'))
    const closed = rebuild(
      [
        ...locales,
        local('OrderCanceled', p, {}, 'confirmed', { reason: 'Se fueron' }),
        local('OrderNoteChanged', p, { notes: 'tarde' }),
      ].map((l) => l.event as ApplicableEvent),
      p,
    )
    expect(closed?.status).toBe('canceled')
    expect(closed?.notes).toBe('antes')
  })
})
