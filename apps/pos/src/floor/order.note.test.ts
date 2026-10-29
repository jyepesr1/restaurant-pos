import { type ApplicableEvent, newId, orderTotals, rebuild } from '@pos/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { pendingSend, unitsToSend } from './order'
import { currentItems, openOrders, tableStatus } from './projection'
import { itemData as item, local, opening } from './testing'

// `unitsToSend` (what «Enviar N» and the notice say) and the order projection with `notes`.

const stateWith = (...factories: ((p: string) => ReturnType<typeof local>)[]) => {
  const p = newId()
  const locals = [local('OrderOpened', p, opening), ...factories.map((f) => f(p))]
  const status = rebuild(
    locals.map((l) => l.event),
    p,
  )
  if (!status) throw new Error('no status')
  return { p, locals, status }
}
const adds =
  (data: ReturnType<typeof item>, e: 'confirmed' | 'pending' = 'confirmed') =>
  (p: string) =>
    local('ItemAdded', p, data, e)

describe('unitsToSend', () => {
  it('an order with no items or nothing to send gives 0', () => {
    expect(unitsToSend(stateWith().status)).toBe(0)
    const a = item({ quantity: 2 })
    const { status } = stateWith(adds(a), (p) =>
      local('ItemsSent', p, {
        tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [a.item_id] }],
      }),
    )
    expect(unitsToSend(status)).toBe(0)
  })

  it('3 Aperol on one line are 3 units, not 1', () => {
    const { status } = stateWith(adds(item({ quantity: 3 })))
    expect(pendingSend(status)).toHaveLength(1)
    expect(unitsToSend(status)).toBe(3)
  })

  it('adds the units of all unsent lines', () => {
    const { status } = stateWith(
      adds(item({ quantity: 3 })),
      adds(item({ quantity: 2 })),
      adds(item({ quantity: 1 })),
    )
    expect(unitsToSend(status)).toBe(6)
  })

  it('what was already sent does not count; what was added afterwards does', () => {
    const a = item({ quantity: 4 })
    const b = item({ quantity: 2 })
    const { status } = stateWith(
      adds(a),
      (p) =>
        local('ItemsSent', p, {
          tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [a.item_id] }],
        }),
      adds(b),
    )
    expect(unitsToSend(status)).toBe(2)
  })

  it('adding or removing units on a line (ItemChanged) is reflected', () => {
    const a = item({ quantity: 2 })
    const { status } = stateWith(adds(a), (p) =>
      local('ItemChanged', p, { item_id: a.item_id, quantity: 5 }),
    )
    expect(unitsToSend(status)).toBe(5)
  })

  it('a removed line does not count', () => {
    const a = item({ quantity: 3 })
    const b = item({ quantity: 1 })
    const { status } = stateWith(adds(a), adds(b), (p) =>
      local('ItemRemoved', p, { item_id: a.item_id }),
    )
    expect(unitsToSend(status)).toBe(1)
  })

  it('with partial voids (a moved line with units already voided) subtracts what was voided', () => {
    // An unsent item can arrive with voided units from another order (ItemsMoved).
    const target = newId()
    const source = newId()
    const a = item({ quantity: 5 })
    const locals = [
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
      locals.map((l) => l.event),
      target,
    )
    expect(status?.items[a.item_id]).toMatchObject({
      quantity: 5,
      voidedQuantity: 2,
      status: 'pending',
    })
    expect(status && unitsToSend(status)).toBe(3)
  })

  it('a moved line with all units voided but one counts 1', () => {
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
    expect(status && unitsToSend(status)).toBe(1)
  })

  it('held items (course on hold) are not sent with «Enviar»: they do not count; once fired they do', () => {
    const entry = item({ quantity: 2, course: 'starter' })
    const main = item({ quantity: 3, course: 'main' })
    const withoutCourse = item({ quantity: 1 })
    const held = stateWith(
      (p) => local('CourseHeld', p, { course: 'main' }),
      adds(entry),
      adds(main),
      adds(withoutCourse),
    ).status
    expect(held.items[main.item_id]?.status).toBe('held')
    expect(unitsToSend(held)).toBe(3)
    const fired = stateWith(
      (p) => local('CourseHeld', p, { course: 'main' }),
      adds(entry),
      adds(main),
      adds(withoutCourse),
      (p) => local('CourseFired', p, { course: 'main' }),
    ).status
    expect(unitsToSend(fired)).toBe(6)
  })

  it('property: it is the sum of (quantity − voided) of pending lines and never less than the lines', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20 }), { maxLength: 15 }),
        fc.array(fc.boolean(), { maxLength: 15 }),
        (quantities, sentTickets) => {
          const data = quantities.map((quantity) => item({ quantity }))
          const toSend = data.filter((_, i) => sentTickets[i])
          const { status } = stateWith(
            ...data.map((d) => adds(d)),
            ...(toSend.length
              ? [
                  (p: string) =>
                    local('ItemsSent', p, {
                      tickets: [
                        {
                          ticket_id: newId(),
                          station_id: newId(),
                          item_ids: toSend.map((d) => d.item_id),
                        },
                      ],
                    }),
                ]
              : []),
          )
          const expected = quantities.reduce((n, c, i) => n + (sentTickets[i] ? 0 : c), 0)
          expect(unitsToSend(status)).toBe(expected)
          expect(unitsToSend(status)).toBeGreaterThanOrEqual(pendingSend(status).length)
        },
      ),
      { seed: 20_261_025, numRuns: 150 },
    )
  })
})

describe('the order projection with notes', () => {
  const note =
    (notes: string | null, e: 'confirmed' | 'pending' = 'confirmed') =>
    (p: string) =>
      local('OrderNoteChanged', p, { notes }, e)

  it('shows the note confirmed by the hub', () => {
    const { locals } = stateWith(note('alérgico al maní'))
    expect(openOrders(locals)[0]?.status.notes).toBe('alérgico al maní')
  })

  it('an order without a note has it as null (also one from before the event existed)', () => {
    const { locals } = stateWith(adds(item()))
    const visible = openOrders(locals)[0]
    expect(visible?.status.notes).toBeNull()
    expect(visible?.status).toHaveProperty('notes', null)
  })

  it('own note still pending shows over the confirmed one, while offline', () => {
    const { locals, p } = stateWith(note('vieja'))
    const all = [...locals, local('OrderNoteChanged', p, { notes: 'nueva' }, 'pending')]
    const visible = openOrders(all)[0]
    expect(visible?.status.notes).toBe('nueva')
    expect(visible?.pendingConfirmation).toBe(true)
    expect(visible?.itemsToConfirm.size).toBe(0)
  })

  it('removing the note while pending leaves it null', () => {
    const { locals, p } = stateWith(note('vieja'))
    const all = [...locals, local('OrderNoteChanged', p, { notes: null }, 'pending')]
    expect(openOrders(all)[0]?.status.notes).toBeNull()
  })

  it('a note the hub rejected does not count', () => {
    const { locals, p } = stateWith(note('buena'))
    const rejectedEvent = {
      ...local('OrderNoteChanged', p, { notes: 'mala' }, 'pending'),
      status: 'rejected' as const,
    }
    expect(openOrders([...locals, rejectedEvent])[0]?.status.notes).toBe('buena')
  })

  it('with two confirmed notes the higher sequence wins, even if they arrive unordered', () => {
    const { locals, p } = stateWith()
    const a = local('OrderNoteChanged', p, { notes: 'primera' })
    const b = local('OrderNoteChanged', p, { notes: 'segunda' })
    expect(openOrders([locals[0] as never, b, a])[0]?.status.notes).toBe('segunda')
  })

  it('the note does not change the total, the lines or the table status', () => {
    const base = stateWith(adds(item({ quantity: 2 })))
    const withIt = stateWith(adds(item({ quantity: 2 })), note('algo'))
    const vb = openOrders(base.locals)
    const vc = openOrders(withIt.locals)
    expect(vc[0]?.total).toBe(vb[0]?.total)
    expect(tableStatus(vc)).toBe(tableStatus(vb))
    expect(currentItems(withIt.status)).toHaveLength(1)
    expect(orderTotals(withIt.status).net).toBe(orderTotals(base.status).net)
  })

  it('a canceled order stops showing even if it has a note', () => {
    const { locals, p } = stateWith(note('algo'))
    const canceled = [
      ...locals,
      local('OrderCanceled', p, {}, 'confirmed', { reason: 'Se fueron' }),
    ]
    expect(openOrders(canceled)).toEqual([])
  })

  it('a note that arrives with the order closed does not change the status (the reducer rejects it)', () => {
    const { locals, p } = stateWith(note('antes'))
    const closed = rebuild(
      [
        ...locals,
        local('OrderCanceled', p, {}, 'confirmed', { reason: 'Se fueron' }),
        local('OrderNoteChanged', p, { notes: 'tarde' }),
      ].map((l) => l.event as ApplicableEvent),
      p,
    )
    expect(closed?.status).toBe('canceled')
    expect(closed?.notes).toBe('antes')
  })
})
