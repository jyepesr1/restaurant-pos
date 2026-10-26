import { applyEvent, newId, type OrderState, rebuild, validateNewEvent } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { movedFrom } from './pedido'
import { datosItem, local, opening } from './pruebas'

// `movedFrom` (tarea 1.5): la copia con que un plato pasa a otro pedido debe ser exactamente la del
// ítem real, o el reductor del hub la rechaza (`copia_distinta`). Aquí se arma con el reductor
// de verdad, sin red.

type Local = ReturnType<typeof local>

interface Escenario {
  source: string
  target: string
  sourceState: OrderState
  targetState: OrderState
}

const stateOf = (events: Local[], order: string): OrderState => {
  const e = rebuild(
    events.map((l, i) => ({ ...l.event, sequence: i + 1 }) as never),
    order,
  )
  if (!e) throw new Error('sin estado')
  return e
}

/** Origen con los eventos dados (ya con su apertura) y un destino recién abierto. */
function scenario(build: (source: string) => Local[]): Escenario {
  const source = newId()
  const target = newId()
  return {
    source,
    target,
    sourceState: stateOf([local('OrderOpened', source, opening), ...build(source)], source),
    targetState: stateOf([local('OrderOpened', target, opening)], target),
  }
}

const send = (order: string, ids: string[]) =>
  local('ItemsSent', order, {
    tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: ids }],
  })

/** El evento de mover tal como lo arma la pantalla, sin los campos que pone el hub. */
const moverEvento = (e: Escenario, ids: string[]) =>
  local(
    'ItemsMoved',
    e.source,
    {
      target_order_id: e.target,
      items: ids.map((id) => movedFrom(e.sourceState.items[id] as never)),
    },
    'pending',
    { related: [e.target] },
  )

/** El reductor acepta el movimiento en el origen y en el destino. */
function accepted(e: Escenario, ids: string[]) {
  const ev = moverEvento(e, ids)
  const o = applyEvent(e.sourceState, ev.event)
  const d = applyEvent(e.targetState, ev.event)
  return { ev, o, d }
}

describe('movidoDe', () => {
  it('un plato enviado: el reductor lo acepta y lo pasa del origen al destino', () => {
    const it = datosItem({ quantity: 2 })
    const e = scenario((o) => [local('ItemAdded', o, it), send(o, [it.item_id])])
    const { o, d, ev } = accepted(e, [it.item_id])
    expect(o.issue).toBeNull()
    expect(d.issue).toBeNull()
    expect(o.status?.items[it.item_id]).toBeUndefined()
    expect(d.status?.items[it.item_id]).toMatchObject({ status: 'sent', quantity: 2 })
    // Y el esquema del evento (campos estrictos) también lo acepta.
    expect(validateNewEvent(ev.event).ok).toBe(true)
  })

  it('no lleva los campos de catálogo de ItemAgregado (el esquema es estricto)', () => {
    const it = datosItem()
    const e = scenario((o) => [local('ItemAdded', o, it)])
    const m = movedFrom(e.sourceState.items[it.item_id] as never)
    expect(Object.keys(m.item).sort()).toEqual(
      [
        'guest',
        'course',
        'tax_type',
        'item_id',
        'modifiers',
        'name',
        'notes',
        'unit_price',
        'product_id',
        'rate',
        'variant_id',
        'quantity',
      ].sort(),
    )
    expect(Object.keys(m).sort()).toEqual(['added_by', 'item', 'status', 'voided_quantity'])
  })

  it('con modificadores (y su precio extra): la copia coincide', () => {
    const mods = [
      { modifier_id: newId(), name: 'Extra limón', extra_price: 2000 },
      { modifier_id: newId(), name: 'Sin hielo', extra_price: 0 },
    ]
    const it = datosItem({ modifiers: mods })
    const e = scenario((o) => [local('ItemAdded', o, it), send(o, [it.item_id])])
    const { o, d } = accepted(e, [it.item_id])
    expect(o.issue).toBeNull()
    expect(d.status?.items[it.item_id]?.modifiers.map((m) => m.extraPrice)).toEqual([2000, 0])
  })

  it('con nota, comensal y curso: llegan igual', () => {
    const it = datosItem({ notes: 'sin hielo', guest: 3, course: 'main' })
    const e = scenario((o) => [local('ItemAdded', o, it), send(o, [it.item_id])])
    const { d } = accepted(e, [it.item_id])
    expect(d.status?.items[it.item_id]).toMatchObject({
      notes: 'sin hielo',
      guest: 3,
      course: 'main',
    })
  })

  it('con una nota cambiada después del envío, la copia lleva la nota nueva', () => {
    const it = datosItem({ notes: 'con hielo' })
    const e = scenario((o) => [
      local('ItemAdded', o, it),
      send(o, [it.item_id]),
      local('ItemModifiedAfterSend', o, {
        item_id: it.item_id,
        ticket_id: newId(),
        notes: 'sin hielo',
      }),
    ])
    const { o, d } = accepted(e, [it.item_id])
    expect(o.issue).toBeNull()
    expect(d.status?.items[it.item_id]?.notes).toBe('sin hielo')
  })

  it('con modificadores cambiados después del envío, la copia lleva los nuevos', () => {
    const it = datosItem({
      modifiers: [{ modifier_id: newId(), name: 'Extra', extra_price: 3000 }],
    })
    const e = scenario((o) => [
      local('ItemAdded', o, it),
      send(o, [it.item_id]),
      local('ItemModifiedAfterSend', o, {
        item_id: it.item_id,
        ticket_id: newId(),
        modifiers: [{ modifier_id: newId(), name: 'Otro', extra_price: 5000 }],
      }),
    ])
    const { o, d } = accepted(e, [it.item_id])
    expect(o.issue).toBeNull()
    expect(d.status?.items[it.item_id]?.modifiers.map((m) => m.extraPrice)).toEqual([5000])
  })

  it('con una anulación parcial: lo anulado viaja y el neto de los dos pedidos se conserva', () => {
    const it = datosItem({ quantity: 3, unit_price: 12_900 })
    const e = scenario((o) => [
      local('ItemAdded', o, it),
      send(o, [it.item_id]),
      local(
        'ItemVoided',
        o,
        { item_id: it.item_id, quantity: 1, already_prepared: false, ticket_id: null },
        'confirmed',
        { reason: 'Error del mesero' },
      ),
    ])
    expect(e.sourceState.items[it.item_id]?.voidedQuantity).toBe(1)
    const { o, d } = accepted(e, [it.item_id])
    expect(o.issue).toBeNull()
    expect(d.issue).toBeNull()
    expect(d.status?.items[it.item_id]).toMatchObject({ quantity: 3, voidedQuantity: 1 })
  })

  it.each(['in_preparation', 'ready', 'served'] as const)(
    'un plato %s conserva su estado en el destino',
    (status) => {
      const it = datosItem()
      const type = {
        in_preparation: 'ItemInPreparation',
        ready: 'ItemReady',
        served: 'ItemServed',
      }[status] as 'ItemReady'
      const e = scenario((o) => [
        local('ItemAdded', o, it),
        send(o, [it.item_id]),
        local(type, o, { item_ids: [it.item_id] }),
      ])
      const { o, d } = accepted(e, [it.item_id])
      expect(o.issue).toBeNull()
      expect(d.status?.items[it.item_id]?.status).toBe(status)
    },
  )

  it('un plato sin enviar (pendiente) también se mueve', () => {
    const it = datosItem()
    const e = scenario((o) => [local('ItemAdded', o, it)])
    const { o, d } = accepted(e, [it.item_id])
    expect(o.issue).toBeNull()
    expect(d.status?.items[it.item_id]?.status).toBe('pending')
  })

  it('varios platos de una vez, de distinto tipo, se aceptan juntos', () => {
    const a = datosItem({ quantity: 2, notes: 'x' })
    const b = datosItem({
      modifiers: [{ modifier_id: newId(), name: 'E', extra_price: 1000 }],
    })
    const c = datosItem({ tax_type: 'exempt', rate: 0 })
    const e = scenario((o) => [
      local('ItemAdded', o, a),
      local('ItemAdded', o, b),
      local('ItemAdded', o, c),
      send(o, [a.item_id, b.item_id]),
    ])
    const { o, d } = accepted(e, [a.item_id, b.item_id, c.item_id])
    expect(o.issue).toBeNull()
    expect(Object.keys(d.status?.items ?? {}).sort()).toEqual(
      [a.item_id, b.item_id, c.item_id].sort(),
    )
    expect(o.status?.items).toEqual({})
  })

  it('ida y vuelta: mover al destino y devolverlo al origen también se acepta', () => {
    const it = datosItem({ quantity: 2 })
    const e = scenario((o) => [local('ItemAdded', o, it), send(o, [it.item_id])])
    const { d } = accepted(e, [it.item_id])
    const runOnce = local(
      'ItemsMoved',
      e.target,
      { target_order_id: e.source, items: [movedFrom(d.status?.items[it.item_id] as never)] },
      'pending',
      { related: [e.source] },
    )
    const origenVacio = applyEvent(accepted(e, [it.item_id]).o.status, runOnce.event)
    expect(origenVacio.issue).toBeNull()
    expect(origenVacio.status?.items[it.item_id]?.quantity).toBe(2)
  })

  it('no inventa un agregado_por: es quien agregó el plato, no quien lo mueve', () => {
    const it = datosItem()
    const e = scenario((o) => [local('ItemAdded', o, it, 'confirmed', { user_id: newId() })])
    const real = e.sourceState.items[it.item_id]
    expect(movedFrom(real as never).added_by).toBe(real?.addedBy)
  })

  it('una copia con algo distinto sí la rechaza el reductor (la prueba prueba algo)', () => {
    const it = datosItem()
    const e = scenario((o) => [local('ItemAdded', o, it), send(o, [it.item_id])])
    const m = movedFrom(e.sourceState.items[it.item_id] as never)
    const ev = local(
      'ItemsMoved',
      e.source,
      { target_order_id: e.target, items: [{ ...m, item: { ...m.item, unit_price: 1 } }] },
      'pending',
      { related: [e.target] },
    )
    expect(applyEvent(e.sourceState, ev.event).issue?.type).toBe('mismatched_copy')
  })

  it('propiedad: cualquier plato, con lo que sea, se mueve y se conserva el neto', () => {
    fc.assert(
      fc.property(
        fc.record({
          quantity: fc.integer({ min: 1, max: 9 }),
          price: fc.constantFrom(0, 200, 12_900, 40_900),
          rate: fc.constantFrom(0, 800, 1900),
          extras: fc.array(fc.constantFrom(0, 1000, 3000), { maxLength: 3 }),
          note: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
          sent: fc.boolean(),
          voidItem: fc.nat(8),
        }),
        (c) => {
          const it = datosItem({
            quantity: c.quantity,
            unit_price: c.price,
            rate: c.rate,
            tax_type: c.rate === 0 ? 'exempt' : c.rate === 1900 ? 'iva' : 'inc',
            notes: c.note,
            modifiers: c.extras.map((p, i) => ({
              modifier_id: newId(),
              name: `M${i}`,
              extra_price: p,
            })),
          })
          const anulables = c.sent ? c.voidItem % c.quantity : 0
          const e = scenario((o) => [
            local('ItemAdded', o, it),
            ...(c.sent ? [send(o, [it.item_id])] : []),
            ...(anulables > 0
              ? [
                  local(
                    'ItemVoided',
                    o,
                    {
                      item_id: it.item_id,
                      quantity: anulables,
                      already_prepared: false,
                      ticket_id: null,
                    },
                    'confirmed',
                    { reason: 'x' },
                  ),
                ]
              : []),
          ])
          const { o, d } = accepted(e, [it.item_id])
          expect(o.issue).toBeNull()
          expect(d.issue).toBeNull()
          expect(d.status?.items[it.item_id]?.voidedQuantity).toBe(anulables)
        },
      ),
      { seed: 20_261_029, numRuns: 150 },
    )
  })
})
