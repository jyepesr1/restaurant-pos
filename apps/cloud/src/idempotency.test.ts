import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  batch,
  count,
  createWorld,
  flatEvent,
  SEED,
  savedEvents,
  statuses,
  type World,
} from './testing/world'

// Idempotency of event uploads (ADR-007, ADR-016): no matter how many times, in what order or
// split into how many batches the same thing arrives, the cloud ends up with exactly the same
// events. A single database for the whole file; each run uses a new restaurant, so they do not
// get in each other's way.

const RUNS = { seed: SEED, numRuns: 25 }

let m: World
beforeAll(async () => {
  m = await createWorld()
})

describe('resending a batch', () => {
  it('N times leaves exactly the same events, and the rest respond already_stored', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 2, max: 5 }),
        async (n, times) => {
          const { hub, restaurantId } = await m.newHub()
          const events = batch(1, n)
          const firstResult = await m.cloud.receiveEvents(hub, events)
          expect(statuses(firstResult).every((e) => e === 'saved')).toBe(true)
          const before = await savedEvents(m.db, restaurantId)
          for (let i = 1; i < times; i++) {
            const another = await m.cloud.receiveEvents(hub, events)
            expect(another.map((r) => r.id)).toEqual(events.map((e) => e.id))
            expect(statuses(another).every((e) => e === 'already_stored')).toBe(true)
          }
          expect(await savedEvents(m.db, restaurantId)).toEqual(before)
          expect(await count(m.db, 'divergent_events', restaurantId)).toBe(0)
          expect(await m.cloud.lastSequence(hub)).toBe(n)
        },
      ),
      RUNS,
    )
  })

  it('in any order leaves the same as in order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 300 }), { minLength: 1, maxLength: 40 }),
        async (numbers) => {
          const mixedUp = await m.newHub()
          const ordered = await m.newHub()
          const events = numbers.map((n) => flatEvent(n))
          const inOrder = [...events].sort((a, b) => a.sequence - b.sequence)
          const r1 = await m.cloud.receiveEvents(mixedUp.hub, events)
          const r2 = await m.cloud.receiveEvents(ordered.hub, inOrder)
          // Each event's result follows the position in which it arrived.
          expect(r1.map((r) => r.id)).toEqual(events.map((e) => e.id))
          expect(statuses(r1)).toEqual(events.map(() => 'saved'))
          expect(statuses(r2)).toEqual(inOrder.map(() => 'saved'))
          const removeHub = (rows: Awaited<ReturnType<typeof savedEvents>>) =>
            rows.map(({ hub_id: _h, ...rest }) => rest)
          expect(removeHub(await savedEvents(m.db, mixedUp.restaurantId))).toEqual(
            removeHub(await savedEvents(m.db, ordered.restaurantId)),
          )
          expect(await m.cloud.lastSequence(mixedUp.hub)).toBe(
            await m.cloud.lastSequence(ordered.hub),
          )
        },
      ),
      RUNS,
    )
  })

  it('split into batches of any size (with or without overlap) leaves the same as all at once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 300 }), { minLength: 1, maxLength: 40 }),
        fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 10 }),
        fc.boolean(),
        async (numbers, sizes, overlap) => {
          const whole = await m.newHub()
          const splitHub = await m.newHub()
          const events = numbers.map((n) => flatEvent(n))
          await m.cloud.receiveEvents(whole.hub, events)
          let from = 0
          let i = 0
          const savedTotals = new Map<string, number>()
          while (from < events.length) {
            const batchSize = sizes[i++ % sizes.length] ?? 1
            const chunk = events.slice(from, from + batchSize)
            // With overlap, the batch repeats the last two events of the previous one (a partial
            // retry).
            const sent = overlap ? [...events.slice(Math.max(0, from - 2), from), ...chunk] : chunk
            const r = await m.cloud.receiveEvents(splitHub.hub, sent)
            for (const x of r)
              if (x.status === 'saved' && x.id)
                savedTotals.set(x.id, (savedTotals.get(x.id) ?? 0) + 1)
            from += batchSize
          }
          // Each event was saved exactly once over the whole run.
          expect([...savedTotals.values()].every((v) => v === 1)).toBe(true)
          expect(savedTotals.size).toBe(events.length)
          const removeHub = (rows: Awaited<ReturnType<typeof savedEvents>>) =>
            rows.map(({ hub_id: _h, ...rest }) => rest)
          expect(removeHub(await savedEvents(m.db, splitHub.restaurantId))).toEqual(
            removeHub(await savedEvents(m.db, whole.restaurantId)),
          )
        },
      ),
      RUNS,
    )
  })

  it('a batch with a part already stored responds each event in its position', async () => {
    const { hub } = await m.newHub()
    const events = batch(1, 6)
    await m.cloud.receiveEvents(hub, [events[1], events[4]] as never)
    const r = await m.cloud.receiveEvents(hub, events)
    expect(r.map((x) => [x.id, x.status])).toEqual(
      events.map((e, i) => [e.id, i === 1 || i === 4 ? 'already_stored' : 'saved']),
    )
  })
})

describe('the same id within the same batch', () => {
  it('with the same content: saved once and the others are already_stored', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 15 }), { minLength: 1, maxLength: 40 }),
        async (numbers) => {
          const { hub, restaurantId } = await m.newHub()
          const events = numbers.map((n) => flatEvent(n))
          const r = await m.cloud.receiveEvents(hub, events)
          const seen = new Set<number>()
          const expected = numbers.map((n) => {
            const firstTime = !seen.has(n)
            seen.add(n)
            return firstTime ? 'saved' : 'already_stored'
          })
          expect(statuses(r)).toEqual(expected)
          expect(await count(m.db, 'events', restaurantId)).toBe(new Set(numbers).size)
          expect(await count(m.db, 'divergent_events', restaurantId)).toBe(0)
        },
      ),
      RUNS,
    )
  })

  it('with other content: the first is saved and the second is divergent, without overwriting the first', async () => {
    const { hub, restaurantId } = await m.newHub()
    const a = flatEvent(1, { data: { quantity: 1 } })
    const b = flatEvent(1, { data: { quantity: 99 } })
    const r = await m.cloud.receiveEvents(hub, [a, b])
    expect(r.map((x) => x.status)).toEqual(['saved', 'divergent'])
    const [saved] = await savedEvents(m.db, restaurantId)
    expect(saved?.content).toMatchObject({ data: { quantity: 1 } })
  })

  it('with other content: the divergent one is recorded for review (not discarded, ADR-007)', async () => {
    const { hub, restaurantId } = await m.newHub()
    const a = flatEvent(1, { data: { quantity: 1 } })
    const b = flatEvent(1, { data: { quantity: 99 } })
    await m.cloud.receiveEvents(hub, [a, b])
    // The response said "divergent" (kept for review): it has to be in divergent_events.
    expect(await count(m.db, 'divergent_events', restaurantId)).toBe(1)
  })

  it('the order decides which one is saved: the first to arrive', async () => {
    const { hub, restaurantId } = await m.newHub()
    const a = flatEvent(1, { data: { quantity: 1 } })
    const b = flatEvent(1, { data: { quantity: 99 } })
    await m.cloud.receiveEvents(hub, [b, a])
    const [saved] = await savedEvents(m.db, restaurantId)
    expect(saved?.content).toMatchObject({ data: { quantity: 99 } })
  })
})

describe('concurrent batches with the same events', () => {
  it('the same batch sent several times at once: each event is saved only once', async () => {
    const { hub, restaurantId } = await m.newHub()
    const events = batch(1, 30)
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => m.cloud.receiveEvents(hub, events)),
    )
    for (const e of events) {
      const verdicts = responses.map((r) => r.find((x) => x.id === e.id)?.status)
      expect(verdicts.filter((v) => v === 'saved')).toHaveLength(1)
      expect(verdicts.filter((v) => v === 'already_stored')).toHaveLength(5)
    }
    expect(await count(m.db, 'events', restaurantId)).toBe(30)
    expect(await count(m.db, 'divergent_events', restaurantId)).toBe(0)
  })

  it('overlapping batches, at once and in different order: the exact union, without duplicates', async () => {
    const { hub, restaurantId } = await m.newHub()
    const all = batch(1, 40)
    const batches = [
      all.slice(0, 20),
      all.slice(10, 30).reverse(),
      all.slice(25),
      [...all].reverse(),
    ]
    const responses = await Promise.all(batches.map((l) => m.cloud.receiveEvents(hub, l)))
    const savedList = responses.flat().filter((r) => r.status === 'saved')
    expect(new Set(savedList.map((g) => g.id)).size).toBe(40)
    expect(savedList).toHaveLength(40)
    expect(await count(m.db, 'events', restaurantId)).toBe(40)
    expect(await m.cloud.lastSequence(hub)).toBe(40)
  })

  it('a variant with other content sent at the same time as the original: the stored one is one of the two and nothing is lost', async () => {
    const { hub, restaurantId } = await m.newHub()
    const a = flatEvent(1, { data: { quantity: 1 } })
    const b = flatEvent(1, { data: { quantity: 99 } })
    const [ra, rb] = await Promise.all([
      m.cloud.receiveEvents(hub, [a]),
      m.cloud.receiveEvents(hub, [b]),
    ])
    expect([ra[0]?.status, rb[0]?.status].sort()).toEqual(['divergent', 'saved'])
    expect(await count(m.db, 'events', restaurantId)).toBe(1)
    expect(await count(m.db, 'divergent_events', restaurantId)).toBe(1)
  })

  it('the same batch uploaded at once by two restaurants: each one saves its own', async () => {
    const a = await m.newHub()
    const b = await m.newHub()
    const events = batch(1, 10)
    const [ra, rb] = await Promise.all([
      m.cloud.receiveEvents(a.hub, events),
      m.cloud.receiveEvents(b.hub, events),
    ])
    expect(statuses(ra).every((e) => e === 'saved')).toBe(true)
    expect(statuses(rb).every((e) => e === 'saved')).toBe(true)
  })
})

describe('divergent_events', () => {
  it('what is already stored never changes, and the same divergent content repeated is not duplicated', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 2, max: 5 }),
        async (n, variants, times) => {
          const { hub, restaurantId } = await m.newHub()
          const originals = batch(1, n)
          await m.cloud.receiveEvents(hub, originals)
          const before = await savedEvents(m.db, restaurantId)
          // `variants` different contents per event; each one is sent `times` times.
          const altered = originals.flatMap((e) =>
            Array.from({ length: variants }, (_, v) => ({
              ...e,
              data: { ...e.data, variant: v + 1 },
            })),
          )
          for (let i = 0; i < times; i++) {
            const r = await m.cloud.receiveEvents(
              hub,
              i % 2 === 0 ? altered : [...altered].reverse().map((x) => x),
            )
            // The ids repeated within the batch (several variants of the same event) all get
            // "divergent"; none is "saved".
            expect(statuses(r).every((e) => e === 'divergent')).toBe(true)
          }
          expect(await savedEvents(m.db, restaurantId)).toEqual(before)
        },
      ),
      RUNS,
    )
  })

  it('each divergent content is kept only once, even if it arrives in different batches and times', async () => {
    const { hub, restaurantId } = await m.newHub()
    const original = flatEvent(1)
    await m.cloud.receiveEvents(hub, [original])
    const v1 = { ...original, data: { quantity: 77 } }
    const v2 = { ...original, data: { quantity: 78 } }
    for (const submission of [[v1], [v1], [v2], [v1], [v2], [original]]) {
      const [r] = await m.cloud.receiveEvents(hub, submission)
      expect(r?.status).toBe(submission[0] === original ? 'already_stored' : 'divergent')
    }
    expect(await count(m.db, 'divergent_events', restaurantId)).toBe(2)
    const [saved] = await savedEvents(m.db, restaurantId)
    expect(saved?.content).toEqual(original)
  })

  it('the same divergent content, sent several times at once, is kept only once', async () => {
    const { hub, restaurantId } = await m.newHub()
    const original = flatEvent(1)
    await m.cloud.receiveEvents(hub, [original])
    const variant = { ...original, data: { quantity: 42 } }
    const r = await Promise.all(
      Array.from({ length: 5 }, () => m.cloud.receiveEvents(hub, [variant])),
    )
    expect(r.every((x) => x[0]?.status === 'divergent')).toBe(true)
    expect(await count(m.db, 'divergent_events', restaurantId)).toBe(1)
  })

  it('stores who sent it and the content received', async () => {
    const { hub, restaurantId } = await m.newHub()
    const original = flatEvent(1)
    await m.cloud.receiveEvents(hub, [original])
    const variant = { ...original, data: { quantity: 42 } }
    await m.cloud.receiveEvents(hub, [variant])
    const rows = (
      await m.db.query<{ event_id: string; hub_id: string; content: unknown }>(
        'SELECT event_id, hub_id, content FROM divergent_events WHERE restaurant_id = $1',
        [restaurantId],
      )
    ).rows
    expect(rows).toEqual([{ event_id: original.id, hub_id: hub.id, content: variant }])
  })

  it('what is not part of what happened (base_sequence, signature, key order) does not count as divergent', async () => {
    const { hub, restaurantId } = await m.newHub()
    const original = flatEvent(1, { base_sequence: 5, signature: 'a'.repeat(64) })
    await m.cloud.receiveEvents(hub, [original])
    const reordered = Object.fromEntries(
      Object.entries({ ...original, base_sequence: 0, signature: 'b'.repeat(64) }).reverse(),
    )
    const [r] = await m.cloud.receiveEvents(hub, [reordered])
    expect(r?.status).toBe('already_stored')
    expect(await count(m.db, 'divergent_events', restaurantId)).toBe(0)
  })

  it('changing any meaningful field does make it divergent', async () => {
    const { hub, restaurantId } = await m.newHub()
    const base = flatEvent(1)
    await m.cloud.receiveEvents(hub, [base])
    const changes: Record<string, unknown>[] = [
      { type: 'ItemVoided' },
      { sequence: 2 },
      { received_at: '2026-10-26T15:00:00.001Z' },
      { business_day: '2026-10-27' },
      { aggregate_id: flatEvent(99).aggregate_id },
      { new_field: 1 },
      { data: {} },
    ]
    for (const change of changes) {
      const [r] = await m.cloud.receiveEvents(hub, [{ ...base, ...change }])
      expect(r?.status, JSON.stringify(change)).toBe('divergent')
    }
    expect(await count(m.db, 'divergent_events', restaurantId)).toBe(changes.length)
  })

  it('a hub at the same location that sends other content for an existing id is also kept for review', async () => {
    const a = await m.newHub()
    const secondCode = await m.cloud.createCode(a.restaurantId)
    if (!secondCode) throw new Error('no code')
    const registration = await m.cloud.registerHub({
      code: secondCode.code,
      restaurant_id: a.restaurantId,
      hub_id: flatEvent(500).id,
      location_id: a.hub.locationId,
      name: 'Caja 2',
      instance: 'i2',
    })
    if (!registration.ok) throw new Error(registration.reason)
    const hub2 = await m.cloud.authenticate(registration.credential)
    if (!hub2) throw new Error('no hub 2')
    const original = flatEvent(1)
    await m.cloud.receiveEvents(a.hub, [original])
    const [r] = await m.cloud.receiveEvents(hub2, [{ ...original, data: { x: 1 } }])
    expect(r?.status).toBe('divergent')
    const [same] = await m.cloud.receiveEvents(hub2, [original])
    expect(same?.status).toBe('already_stored')
    // Once it sends the same content, the second one has its sequence 1 in the cloud too.
    expect(await m.cloud.lastSequence(hub2)).toBe(1)
    expect(await m.cloud.lastSequence(a.hub)).toBe(1)
  })

  it('a hub registered again after a revocation resends everything and catches up', async () => {
    const a = await m.newHub()
    await m.cloud.receiveEvents(a.hub, batch(1, 30))
    expect(await m.cloud.lastSequence(a.hub)).toBe(30)
    await m.cloud.revokeHub(a.hub.id)
    const again = await m.newHub(a.restaurantId)
    expect(await m.cloud.lastSequence(again.hub)).toBe(0)
    // It resends from 1: the first 30 were already stored and count, the rest are new.
    const results = await m.cloud.receiveEvents(again.hub, batch(1, 40))
    expect(results.filter((r) => r.status === 'already_stored')).toHaveLength(30)
    expect(results.filter((r) => r.status === 'saved')).toHaveLength(10)
    expect(await m.cloud.lastSequence(again.hub)).toBe(40)
    expect(await count(m.db, 'events', a.restaurantId)).toBe(40)
  })

  it('an invalid event still stops the sequence where it is, even with stored ones after it', async () => {
    const a = await m.newHub()
    await m.cloud.receiveEvents(a.hub, batch(1, 5))
    const again = await m.newHub(a.restaurantId)
    const events = batch(1, 8)
    events[2] = { ...events[2], business_day: 'nunca' } as (typeof events)[number]
    await m.cloud.receiveEvents(again.hub, events)
    expect(await m.cloud.lastSequence(again.hub)).toBe(2)
  })
})
