import { applyEvent, newId, type OrderState, rebuild, validateNewEvent } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { movedFrom } from './order'
import { itemData, local, opening } from './testing'

// `movedFrom` (task 1.5): the copy with which a dish moves to another order must be exactly the
// real item's, or the hub reducer rejects it (`mismatched_copy`). Here it is built with the real
// reducer, without network.

type Local = ReturnType<typeof local>

interface Scenario {
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
  if (!e) throw new Error('no state')
  return e
}

/** Source with the given events (already with its opening) and a just-opened target. */
function scenario(build: (source: string) => Local[]): Scenario {
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

/** The move event as the screen builds it, without the fields the hub sets. */
const moveEvent = (e: Scenario, ids: string[]) =>
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

/** The reducer accepts the move in the source and in the target. */
function accepted(e: Scenario, ids: string[]) {
  const ev = moveEvent(e, ids)
  const o = applyEvent(e.sourceState, ev.event)
  const d = applyEvent(e.targetState, ev.event)
  return { ev, o, d }
}

describe('movedFrom', () => {
  it('a sent dish: the reducer accepts it and moves it from the source to the target', () => {
    const it = itemData({ quantity: 2 })
    const e = scenario((o) => [local('ItemAdded', o, it), send(o, [it.item_id])])
    const { o, d, ev } = accepted(e, [it.item_id])
    expect(o.issue).toBeNull()
    expect(d.issue).toBeNull()
    expect(o.status?.items[it.item_id]).toBeUndefined()
    expect(d.status?.items[it.item_id]).toMatchObject({ status: 'sent', quantity: 2 })
    // And the event schema (strict fields) accepts it too.
    expect(validateNewEvent(ev.event).ok).toBe(true)
  })

  it('does not carry the catalog fields of ItemAdded (the schema is strict)', () => {
    const it = itemData()
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

  it('with modifiers (and their extra price): the copy matches', () => {
    const mods = [
      { modifier_id: newId(), name: 'Extra limón', extra_price: 2000 },
      { modifier_id: newId(), name: 'Sin hielo', extra_price: 0 },
    ]
    const it = itemData({ modifiers: mods })
    const e = scenario((o) => [local('ItemAdded', o, it), send(o, [it.item_id])])
    const { o, d } = accepted(e, [it.item_id])
    expect(o.issue).toBeNull()
    expect(d.status?.items[it.item_id]?.modifiers.map((m) => m.extraPrice)).toEqual([2000, 0])
  })

  it('with note, guest and course: they arrive the same', () => {
    const it = itemData({ notes: 'sin hielo', guest: 3, course: 'main' })
    const e = scenario((o) => [local('ItemAdded', o, it), send(o, [it.item_id])])
    const { d } = accepted(e, [it.item_id])
    expect(d.status?.items[it.item_id]).toMatchObject({
      notes: 'sin hielo',
      guest: 3,
      course: 'main',
    })
  })

  it('with a note changed after sending, the copy carries the new note', () => {
    const it = itemData({ notes: 'con hielo' })
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

  it('with modifiers changed after sending, the copy carries the new ones', () => {
    const it = itemData({
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

  it('with a partial void: what was voided travels and the net of both orders is kept', () => {
    const it = itemData({ quantity: 3, unit_price: 12_900 })
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
    'a %s dish keeps its status in the target',
    (status) => {
      const it = itemData()
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

  it('an unsent (pending) dish also moves', () => {
    const it = itemData()
    const e = scenario((o) => [local('ItemAdded', o, it)])
    const { o, d } = accepted(e, [it.item_id])
    expect(o.issue).toBeNull()
    expect(d.status?.items[it.item_id]?.status).toBe('pending')
  })

  it('several dishes at once, of different kinds, are accepted together', () => {
    const a = itemData({ quantity: 2, notes: 'x' })
    const b = itemData({
      modifiers: [{ modifier_id: newId(), name: 'E', extra_price: 1000 }],
    })
    const c = itemData({ tax_type: 'exempt', rate: 0 })
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

  it('round trip: moving to the target and returning it to the source is also accepted', () => {
    const it = itemData({ quantity: 2 })
    const e = scenario((o) => [local('ItemAdded', o, it), send(o, [it.item_id])])
    const { d } = accepted(e, [it.item_id])
    const runOnce = local(
      'ItemsMoved',
      e.target,
      { target_order_id: e.source, items: [movedFrom(d.status?.items[it.item_id] as never)] },
      'pending',
      { related: [e.source] },
    )
    const emptySource = applyEvent(accepted(e, [it.item_id]).o.status, runOnce.event)
    expect(emptySource.issue).toBeNull()
    expect(emptySource.status?.items[it.item_id]?.quantity).toBe(2)
  })

  it('does not invent an added_by: it is who added the dish, not who moves it', () => {
    const it = itemData()
    const e = scenario((o) => [local('ItemAdded', o, it, 'confirmed', { user_id: newId() })])
    const real = e.sourceState.items[it.item_id]
    expect(movedFrom(real as never).added_by).toBe(real?.addedBy)
  })

  it('a copy with something different is rejected by the reducer (the test tests something)', () => {
    const it = itemData()
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

  it('property: any dish, with anything, moves and the net is kept', () => {
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
          const it = itemData({
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
          const voidable = c.sent ? c.voidItem % c.quantity : 0
          const e = scenario((o) => [
            local('ItemAdded', o, it),
            ...(c.sent ? [send(o, [it.item_id])] : []),
            ...(voidable > 0
              ? [
                  local(
                    'ItemVoided',
                    o,
                    {
                      item_id: it.item_id,
                      quantity: voidable,
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
          expect(d.status?.items[it.item_id]?.voidedQuantity).toBe(voidable)
        },
      ),
      { seed: 20_261_029, numRuns: 150 },
    )
  })
})
