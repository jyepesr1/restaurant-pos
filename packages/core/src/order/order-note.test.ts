import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { permissionFor } from '../access/permissions'
import { type OrderEvent, validateNewEvent } from '../events/order'
import { newId } from '../id'
import { event, inOrder, itemCopy, TIME, WAITER } from '../testing/factory'
import { shuffle } from '../testing/freeze'
import { actionArb, Service } from '../testing/simulator'
import { applyEvent, rebuild } from './apply'
import type { OrderState } from './state'
import { orderTotals } from './totals'

// `OrderNoteChanged { notes }`: the note for the whole order («alérgico al maní»). It goes on every
// ticket and on the kitchen card. Decision of these tests on a closed or canceled order: the
// note is NOT in NO_AMOUNTS, so it is rejected with `order_closed` (same as GuestsChanged); to
// change it, the order must be reopened.

function applyAll(events: OrderEvent[], initial: OrderState | null = null): OrderState {
  return events.reduce<OrderState | null>((status, e) => {
    const r = applyEvent(status, inOrder(e, status?.lastSequence ?? 0))
    if (r.issue) throw new Error(`${e.type}: ${r.issue.type} (${r.issue.description})`)
    return r.status
  }, initial) as OrderState
}

function opened() {
  const order = newId()
  return {
    order,
    status: applyAll([
      event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }),
    ]),
  }
}

const note = (order: string, notes: string | null) => event(order, 'OrderNoteChanged', { notes })

/** Applies a single event and returns the full result (with `issue` if there is one). */
const tryAction = (status: OrderState, e: OrderEvent) =>
  applyEvent(status, inOrder(e, status.lastSequence))

describe('OrderNoteChanged: the reducer', () => {
  it('a freshly opened order has no note (null, not undefined)', () => {
    const { status } = opened()
    expect(status.notes).toBeNull()
    expect(status).toHaveProperty('notes', null)
  })

  it('sets the note as is when it has no extra spaces', () => {
    const { order, status } = opened()
    expect(applyAll([note(order, 'alérgico al maní')], status).notes).toBe('alérgico al maní')
  })

  it.each([
    ['empty string', ''],
    ['one space', ' '],
    ['only spaces', '     '],
    ['tabs and line breaks', '\t\n  \r\n'],
    ['null', null],
  ])('removes the note when it gets %s', (_, value) => {
    const { order, status } = opened()
    const withIt = applyAll([note(order, 'sin cebolla')], status)
    expect(withIt.notes).toBe('sin cebolla')
    expect(applyAll([note(order, value)], withIt).notes).toBeNull()
  })

  it('removing a note that does not exist is valid and leaves null', () => {
    const { order, status } = opened()
    expect(applyAll([note(order, null)], status).notes).toBeNull()
    expect(applyAll([note(order, '   ')], status).notes).toBeNull()
  })

  it('trims leading and trailing spaces, but keeps the inner ones', () => {
    const { order, status } = opened()
    expect(applyAll([note(order, '  todo   junto \n')], status).notes).toBe('todo   junto')
  })

  it('accepts exactly 500 characters and keeps them whole', () => {
    const { order, status } = opened()
    const long = 'a'.repeat(500)
    expect(applyAll([note(order, long)], status).notes).toBe(long)
  })

  it('500 characters with spaces at the edges are stored trimmed (fewer than 500)', () => {
    const { order, status } = opened()
    const withBorders = ` ${'b'.repeat(498)} `
    expect(withBorders).toHaveLength(500)
    expect(applyAll([note(order, withBorders)], status).notes).toBe('b'.repeat(498))
  })

  it('500 spaces leave the note as null', () => {
    const { order, status } = opened()
    expect(applyAll([note(order, ' '.repeat(500))], status).notes).toBeNull()
  })

  it('text with emojis, accents and quotes passes intact', () => {
    const { order, status } = opened()
    const text = '¡Cumpleaños! «sin maní» 🎂 ñandú'
    expect(applyAll([note(order, text)], status).notes).toBe(text)
  })

  it('last one wins: changing the note replaces the previous one, it does not accumulate', () => {
    const { order, status } = opened()
    const final = applyAll(
      [note(order, 'primera'), note(order, 'segunda'), note(order, 'tercera')],
      status,
    )
    expect(final.notes).toBe('tercera')
  })

  it('the same note twice in a row is valid and leaves the same state', () => {
    const { order, status } = opened()
    const once = applyAll([note(order, 'sin sal')], status)
    const two = applyAll([note(order, 'sin sal')], once)
    expect({ ...two, lastSequence: 0 }).toEqual({ ...once, lastSequence: 0 })
  })

  it('does not touch items, discounts, payments or totals', () => {
    const { order, status } = opened()
    const pizza = itemCopy()
    const withItem = applyAll([event(order, 'ItemAdded', pizza)], status)
    const withIt = applyAll([note(order, 'alérgico')], withItem)
    expect(orderTotals(withIt)).toEqual(orderTotals(withItem))
    expect(withIt.items).toEqual(withItem.items)
    expect(withIt.guests).toBe(withItem.guests)
    expect(withIt.status).toBe('open')
  })

  it('the note survives sending items to the kitchen', () => {
    const { order, status } = opened()
    const pizza = itemCopy()
    const final = applyAll(
      [
        note(order, 'alérgico al maní'),
        event(order, 'ItemAdded', pizza),
        event(order, 'ItemsSent', {
          tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [pizza.item_id] }],
        }),
      ],
      status,
    )
    expect(final.notes).toBe('alérgico al maní')
  })

  it('does not mutate the input state', () => {
    const { order, status } = opened()
    const copy = structuredClone(status)
    applyEvent(status, inOrder(note(order, 'x'), status.lastSequence))
    expect(status).toEqual(copy)
  })

  it('an event from another order does not change the note', () => {
    const { status } = opened()
    const r = tryAction(status, note(newId(), 'ajena'))
    expect(r.issue?.type).toBe('foreign_event')
    expect(r.status?.notes).toBeNull()
  })

  it('without an open order there is nothing to put the note on (order_not_found)', () => {
    const r = applyEvent(null, note(newId(), 'x'))
    expect(r.issue?.type).toBe('order_not_found')
    expect(r.status).toBeNull()
  })

  it('an already applied event (same sequence) is ignored', () => {
    const { order, status } = opened()
    const e = inOrder(note(order, 'una vez'), status.lastSequence)
    const one = applyEvent(status, e)
    expect(one.status?.notes).toBe('una vez')
    const two = applyEvent(one.status, { ...e, data: { notes: 'otra' } })
    expect(two.issue?.type).toBe('event_already_applied')
    expect(two.status?.notes).toBe('una vez')
  })
})

describe('OrderNoteChanged with the order closed or canceled', () => {
  const closed = () => {
    const { order, status } = opened()
    const pizza = itemCopy({ unit_price: 10_000 })
    const withItem = applyAll([event(order, 'ItemAdded', pizza)], status)
    // Void the unsent item: it goes to zero and the order can close without payments.
    return { order, withItem }
  }

  it('canceled: the note is rejected with order_closed and the state does not change', () => {
    const { order, status } = opened()
    const withIt = applyAll([note(order, 'antes')], status)
    const canceled = applyAll([event(order, 'OrderCanceled', {}, { reason: 'Se fueron' })], withIt)
    expect(canceled.status).toBe('canceled')
    const r = tryAction(canceled, note(order, 'después'))
    expect(r.issue?.type).toBe('order_closed')
    expect(r.status?.notes).toBe('antes')
  })

  it('canceled: the note cannot be removed either', () => {
    const { order, status } = opened()
    const withIt = applyAll([note(order, 'antes')], status)
    const canceled = applyAll([event(order, 'OrderCanceled', {}, { reason: 'Se fueron' })], withIt)
    const r = tryAction(canceled, note(order, null))
    expect(r.issue?.type).toBe('order_closed')
    expect(r.status?.notes).toBe('antes')
  })

  it('closed: rejected with order_closed; once reopened, it is accepted again', () => {
    const { order, withItem } = closed()
    const afterRemoval = applyAll(
      [
        event(order, 'ItemRemoved', { item_id: Object.keys(withItem.items)[0] as string }),
        note(order, 'antes'),
        event(order, 'OrderClosed', {}, { business_day: '2026-10-24' }),
      ],
      withItem,
    )
    expect(afterRemoval.status).toBe('closed')
    const r = tryAction(afterRemoval, note(order, 'después'))
    expect(r.issue?.type).toBe('order_closed')
    expect(r.status?.notes).toBe('antes')

    const reopened = applyAll(
      [event(order, 'OrderReopened', {}, { reason: 'Faltó cobrar algo' })],
      afterRemoval,
    )
    expect(reopened.notes).toBe('antes')
    expect(applyAll([note(order, 'después')], reopened).notes).toBe('después')
  })
})

describe('old orders and rebuilding', () => {
  it('rebuilding an order without any OrderNoteChanged gives null notes', () => {
    const order = newId()
    const pizza = itemCopy()
    const log = [
      event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 3 }),
      event(order, 'ItemAdded', pizza),
      event(order, 'GuestsChanged', { guests: 4 }),
    ]
    const status = rebuild(log, order)
    expect(status).toHaveProperty('notes', null)
    expect(status?.notes).toBeNull()
    expect(status?.guests).toBe(4)
  })

  it('a rescue order is also born without a note', () => {
    const original = newId()
    const rescue = newId()
    const e = event(rescue, 'RescueOrderCreated', {
      original_order_id: original,
      table_id: null,
      waiter_id: newId(),
      channel: 'dine_in',
    })
    const status = rebuild([e], rescue)
    expect(status?.notes ?? null).toBeNull()
  })

  it('rebuilding with the note in the middle of the log leaves it set', () => {
    const order = newId()
    const log = [
      event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }),
      note(order, 'alérgico al maní'),
      event(order, 'ItemAdded', itemCopy()),
    ]
    expect(rebuild(log, order)?.notes).toBe('alérgico al maní')
  })

  it('rebuilding ignores a duplicate note event (same id)', () => {
    const order = newId()
    const opening = event(order, 'OrderOpened', {
      channel: 'dine_in',
      table_id: newId(),
      guests: 2,
    })
    const n = note(order, 'una')
    const log = [opening, n, n]
    expect(rebuild(log, order)?.notes).toBe('una')
  })

  it('rebuilding with out-of-order events gives the note of the last sequence', () => {
    const order = newId()
    const log = [
      event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }),
      note(order, 'vieja'),
      note(order, 'nueva'),
    ]
    for (const seedValue of [1, 2, 3, 4, 5, 99]) {
      expect(rebuild(shuffle(log, seedValue), order)?.notes).toBe('nueva')
    }
    expect(rebuild([...log].reverse(), order)?.notes).toBe('nueva')
  })

  it('on merging orders, the target keeps ITS note and the source note is lost (known gap)', () => {
    // Documents the current behavior (apply.ts, OrdersMerged): the note of the order being
    // merged is lost along with the canceled source. An allergy noted on the source no longer
    // shows on the target's tickets. Flagged in the QA report.
    const source = newId()
    const target = newId()
    const item = itemCopy()
    const opening = (id: string) =>
      event(id, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 })
    const eSource = [
      opening(source),
      note(source, 'alérgico al maní'),
      event(source, 'ItemAdded', item),
    ]
    const eTarget = [opening(target), note(target, 'cumpleaños')]
    const union = event(target, 'OrdersMerged', {
      source_order_id: source,
      items: [{ item, status: 'pending', voided_quantity: 0, added_by: WAITER }],
    })
    const log = [...eSource, ...eTarget, union]
    expect(rebuild(log, target)?.notes).toBe('cumpleaños')
    expect(rebuild(log, source)?.status).toBe('canceled')
  })
})

describe('OrderNoteChanged schema', () => {
  const envelope = (data: unknown) => ({
    id: newId(),
    type: 'OrderNoteChanged',
    schema_version: 1,
    aggregate_type: 'order',
    aggregate_id: newId(),
    related: [],
    data,
    session_id: null,
    user_id: newId(),
    device_id: newId(),
    authorization_id: null,
    reason: null,
    device_time: TIME,
    hub_estimated_time: TIME,
    base_sequence: 0,
  })
  const valid = (data: unknown) => validateNewEvent(envelope(data)).ok

  it('accepts text, empty and null; exactly 500 characters', () => {
    expect(valid({ notes: 'sin hielo' })).toBe(true)
    expect(valid({ notes: '' })).toBe(true)
    expect(valid({ notes: null })).toBe(true)
    expect(valid({ notes: 'a'.repeat(500) })).toBe(true)
  })

  it('rejects 501 characters, non-text types, a missing field and extra fields', () => {
    expect(valid({ notes: 'a'.repeat(501) })).toBe(false)
    expect(valid({ notes: 5 })).toBe(false)
    expect(valid({ notes: true })).toBe(false)
    expect(valid({ notes: ['x'] })).toBe(false)
    expect(valid({})).toBe(false)
    expect(valid({ notes: undefined })).toBe(false)
    expect(valid({ notes: 'x', extra: 1 })).toBe(false)
    expect(valid(null)).toBe(false)
  })

  it('the aggregate must be an order', () => {
    expect(validateNewEvent({ ...envelope({ notes: 'x' }), aggregate_type: 'product' }).ok).toBe(
      false,
    )
  })

  it('the permission it requires is take_order, with or without an order in the state', () => {
    const e = event(newId(), 'OrderNoteChanged', { notes: 'x' })
    expect(permissionFor(e)).toBe('take_order')
    expect(permissionFor(e, opened().status)).toBe('take_order')
    expect(permissionFor(event(newId(), 'OrderNoteChanged', { notes: null }))).toBe('take_order')
  })
})

describe('properties with the simulator', () => {
  const sequence = fc.array(actionArb, { minLength: 10, maxLength: 80, size: 'max' })
  const CONFIG = { seed: 20_261_025, numRuns: 400 }

  /** What should remain after the last note applied to that order. */
  const expectedNote = (service: Service, id: string): string | null => {
    const last = service.appliedEvents
      .filter((e) => e.type === 'OrderNoteChanged' && e.aggregate_id === id)
      .at(-1)
    if (last?.type !== 'OrderNoteChanged') return null
    return last.data.notes?.trim() || null
  }

  it('the state note is always the last applied note, trimmed, or null', () => {
    let withNote = 0
    fc.assert(
      fc.property(sequence, (actions) => {
        const service = new Service()
        for (const action of actions) service.step(action)
        expect(service.invalidCases).toEqual([])
        for (const p of [0, 1] as const) {
          const status = service.statuses[p]
          expect(status?.notes ?? null).toBe(expectedNote(service, service.orders[p]))
          if (status?.notes) withNote += 1
        }
      }),
      CONFIG,
    )
    // The simulator does exercise the note: it is not a vacuous property.
    expect(withNote).toBeGreaterThan(0)
  })

  it('never leaves a note that is empty, has edge spaces or is over 500', () => {
    fc.assert(
      fc.property(sequence, (actions) => {
        const service = new Service()
        for (const action of actions) service.step(action)
        for (const status of service.statuses) {
          if (!status || status.notes === null) continue
          expect(status.notes.length).toBeGreaterThan(0)
          expect(status.notes.length).toBeLessThanOrEqual(500)
          expect(status.notes).toBe(status.notes.trim())
        }
      }),
      { ...CONFIG, seed: 20_261_030 },
    )
  })

  it('rebuilding shuffled or reversed keeps the note', () => {
    fc.assert(
      fc.property(sequence, fc.integer({ min: 0, max: 2 ** 31 }), (actions, seedValue) => {
        const service = new Service()
        for (const action of actions) service.step(action)
        for (const p of [0, 1] as const) {
          const id = service.orders[p]
          const expected = service.statuses[p]?.notes ?? null
          expect(rebuild(shuffle(service.log, seedValue), id)?.notes ?? null).toBe(expected)
          expect(rebuild([...service.log].reverse(), id)?.notes ?? null).toBe(expected)
        }
      }),
      { ...CONFIG, seed: 20_261_031 },
    )
  })

  it('arbitrary text: the reducer always stores the trimmed text or null', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (text) => {
        const { order, status } = opened()
        const e = inOrder(note(order, text), status.lastSequence)
        const r = applyEvent(status, e)
        expect(r.issue).toBeNull()
        expect(r.status?.notes).toBe(text.trim() || null)
      }),
      { seed: 20_261_032, numRuns: 300 },
    )
  })
})
