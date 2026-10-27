import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { MAX_EVENT_BYTES } from './cloud'
import {
  count,
  createWorld,
  flatEvent,
  SEED,
  savedEvents,
  statuses,
  type World,
} from './testing/world'

// The edges of an event and of the upload sequence: format, size, characters Postgres does not
// accept, and "how far everything is in" (last_sequence contiguous from 1).

let m: World
beforeAll(async () => {
  m = await createWorld()
})

const largestContiguous = (sequences: number[]) => {
  const sequenceSet = new Set(sequences)
  let k = 0
  while (sequenceSet.has(k + 1)) k++
  return k
}

describe('last_sequence: contiguous from 1', () => {
  it('with no events it is 0, and with gaps it stops before the gap', async () => {
    const { hub } = await m.newHub()
    expect(await m.cloud.lastSequence(hub)).toBe(0)
    await m.cloud.receiveEvents(hub, [flatEvent(1), flatEvent(2), flatEvent(4), flatEvent(5)])
    expect(await m.cloud.lastSequence(hub)).toBe(2)
    await m.cloud.receiveEvents(hub, [flatEvent(3)])
    expect(await m.cloud.lastSequence(hub)).toBe(5)
  })

  it('if sequence 1 is missing, it is 0 even if there are stored events', async () => {
    const { hub } = await m.newHub()
    await m.cloud.receiveEvents(hub, [flatEvent(2), flatEvent(3)])
    expect(await m.cloud.lastSequence(hub)).toBe(0)
  })

  it('property: regardless of order, batch split or resends, it is the largest k with 1..k complete', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 25 }), { minLength: 1, maxLength: 40 }),
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 8 }),
        async (sequences, sizes) => {
          const { hub } = await m.newHub()
          let previous = 0
          let from = 0
          let i = 0
          const arrivals: number[] = []
          while (from < sequences.length) {
            const sz = sizes[i++ % sizes.length] ?? 1
            const chunk = sequences.slice(from, from + sz)
            await m.cloud.receiveEvents(
              hub,
              chunk.map((s) => flatEvent(s)),
            )
            arrivals.push(...chunk)
            from += sz
            const now = await m.cloud.lastSequence(hub)
            expect(now).toBe(largestContiguous(arrivals))
            // It never goes back.
            expect(now).toBeGreaterThanOrEqual(previous)
            previous = now
          }
        },
      ),
      { seed: SEED, numRuns: 25 },
    )
  })

  it('two events with the same hub sequence (different ids) do not count it twice', async () => {
    const { hub } = await m.newHub()
    await m.cloud.receiveEvents(hub, [
      flatEvent(1),
      flatEvent(2, { sequence: 1 }),
      flatEvent(3, { sequence: 2 }),
    ])
    expect(await m.cloud.lastSequence(hub)).toBe(2)
  })

  it('an invalid event does not count: the hub must resend it', async () => {
    const { hub } = await m.newHub()
    await m.cloud.receiveEvents(hub, [flatEvent(1), { ...flatEvent(2), data: 'x' }, flatEvent(3)])
    expect(await m.cloud.lastSequence(hub)).toBe(1)
  })

  it('a divergent variant of a stored event does not move the sequence', async () => {
    const { hub } = await m.newHub()
    await m.cloud.receiveEvents(hub, [flatEvent(1)])
    await m.cloud.receiveEvents(hub, [flatEvent(2), flatEvent(1, { sequence: 3, data: { v: 1 } })])
    expect(await m.cloud.lastSequence(hub)).toBe(2)
  })

  it('two hubs of the same restaurant each keep their own count', async () => {
    const a = await m.newHub()
    await m.cloud.receiveEvents(a.hub, [flatEvent(1), flatEvent(2)])
    const b = await m.newHub()
    await m.cloud.receiveEvents(b.hub, [flatEvent(101, { sequence: 1 })])
    expect(await m.cloud.lastSequence(a.hub)).toBe(2)
    expect(await m.cloud.lastSequence(b.hub)).toBe(1)
  })

  it('many events at once: 500 in one batch and the sequence reaches 500', async () => {
    const { hub, restaurantId } = await m.newHub()
    const r = await m.cloud.receiveEvents(
      hub,
      Array.from({ length: 500 }, (_, i) => flatEvent(i + 1)),
    )
    expect(statuses(r).every((e) => e === 'saved')).toBe(true)
    expect(await m.cloud.lastSequence(hub)).toBe(500)
    expect(await count(m.db, 'events', restaurantId)).toBe(500)
  })

  it('a very large sequence (safe integer limit) is saved without losing precision', async () => {
    const { hub, restaurantId } = await m.newHub()
    const [r] = await m.cloud.receiveEvents(hub, [
      flatEvent(1, { sequence: Number.MAX_SAFE_INTEGER }),
    ])
    expect(r?.status).toBe('saved')
    const [row] = await savedEvents(m.db, restaurantId)
    expect(row?.hub_sequence).toBe(String(Number.MAX_SAFE_INTEGER))
    expect(await m.cloud.lastSequence(hub)).toBe(0)
  })
})

describe('event format', () => {
  const invalidCases: [string, Record<string, unknown>][] = [
    ['no id', { id: undefined }],
    ['id that is not a ULID', { id: 'abc' }],
    ['id with letters that do not exist (I, L, O, U)', { id: 'I'.repeat(26) }],
    ['lowercase id', { id: '0e'.padEnd(26, 'a') }],
    ['numeric id', { id: 12345 }],
    ['empty type', { type: '' }],
    ['type longer than 60 characters', { type: 'x'.repeat(61) }],
    ['empty aggregate_type', { aggregate_type: '' }],
    ['long aggregate_type', { aggregate_type: 'x'.repeat(31) }],
    ['short aggregate_id', { aggregate_id: 'ABC' }],
    ['sequence 0', { sequence: 0 }],
    ['negative sequence', { sequence: -1 }],
    ['decimal sequence', { sequence: 1.5 }],
    ['sequence as text', { sequence: '1' }],
    ['sequence larger than a safe integer', { sequence: 2 ** 60 }],
    ['null sequence', { sequence: null }],
    ['received_at without time zone', { received_at: '2026-10-26T15:00:00' }],
    ['received_at that is not a date', { received_at: 'yesterday' }],
    ['business_day in another format', { business_day: '26/10/2026' }],
    ['impossible business_day', { business_day: '2026-02-30' }],
    ['business_day month 13', { business_day: '2026-13-01' }],
    ['null data', { data: null }],
    ['data as a list', { data: [] }],
    ['data as text', { data: 'x' }],
    ['no data', { data: undefined }],
  ]

  it.each(invalidCases)(
    '%s: is invalid and does not sink the rest of the batch',
    async (_name, change) => {
      const { hub, restaurantId } = await m.newHub()
      const badCase = { ...flatEvent(2), ...change }
      const r = await m.cloud.receiveEvents(hub, [flatEvent(1), badCase, flatEvent(3)])
      expect(r[1]?.status).toBe('invalid')
      expect([r[0]?.status, r[2]?.status]).toEqual(['saved', 'saved'])
      expect(await count(m.db, 'events', restaurantId)).toBe(2)
    },
  )

  it('what is not an object (null, numbers, text, lists) is invalid and does not return an id', async () => {
    const { hub } = await m.newHub()
    const r = await m.cloud.receiveEvents(hub, [null, 1, 'x', [], true, undefined, {}])
    expect(r).toEqual(Array(7).fill({ id: null, status: 'invalid', reason: 'format' }))
  })

  it('an invalid id that is a long text is not returned to the hub (arbitrary input is not echoed)', async () => {
    const { hub } = await m.newHub()
    const [r] = await m.cloud.receiveEvents(hub, [{ ...flatEvent(1), id: 'x'.repeat(5000) }])
    expect(r).toEqual({ id: null, status: 'invalid', reason: 'format' })
  })

  it('extra fields are kept (the cloud does not reject what the hub accepted)', async () => {
    const { hub, restaurantId } = await m.newHub()
    const e = flatEvent(1, {
      schema_version: 3,
      related: [],
      future_field: { a: [1, 2, { b: null }] },
    })
    const [r] = await m.cloud.receiveEvents(hub, [e])
    expect(r?.status).toBe('saved')
    const [row] = await savedEvents(m.db, restaurantId)
    expect(row?.content).toEqual(e)
  })

  it('the same invalid structure twice in the batch gets two responses', async () => {
    const { hub } = await m.newHub()
    const badCase = { ...flatEvent(1), sequence: 0 }
    const r = await m.cloud.receiveEvents(hub, [badCase, badCase])
    expect(statuses(r)).toEqual(['invalid', 'invalid'])
  })

  it('a whole batch of invalid ones does not touch the database', async () => {
    const { hub, restaurantId } = await m.newHub()
    const r = await m.cloud.receiveEvents(hub, [{}, { id: 'x' }])
    expect(statuses(r)).toEqual(['invalid', 'invalid'])
    expect(await count(m.db, 'events', restaurantId)).toBe(0)
  })

  it('property: with arbitrary data the whole batch never fails; each event is saved or invalid', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.jsonValue(), { minLength: 1, maxLength: 6 }),
        async (anyValues) => {
          const { hub } = await m.newHub()
          const events = anyValues.map((v, i) => flatEvent(i + 1, { data: { v } }))
          const r = await m.cloud.receiveEvents(hub, [...events, ...anyValues])
          expect(r).toHaveLength(events.length + anyValues.length)
          for (const x of r.slice(0, events.length))
            expect(['saved', 'invalid']).toContain(x.status)
          for (const x of r.slice(events.length)) expect(x.status).toBe('invalid')
        },
      ),
      { seed: SEED, numRuns: 25 },
    )
  })
})

describe('size', () => {
  /** An event whose JSON is exactly `bytes` bytes. */
  function withSize(n: number, bytes: number) {
    const base = flatEvent(n, { data: { notes: '' } })
    const empty = new TextEncoder().encode(JSON.stringify(base)).length
    return { ...base, data: { notes: 'x'.repeat(bytes - empty) } }
  }

  it('the limit is exact: 64 KB goes in, one more byte does not', async () => {
    const { hub } = await m.newHub()
    const atLimit = withSize(1, MAX_EVENT_BYTES)
    const oversized = withSize(2, MAX_EVENT_BYTES + 1)
    expect(new TextEncoder().encode(JSON.stringify(atLimit)).length).toBe(MAX_EVENT_BYTES)
    const r = await m.cloud.receiveEvents(hub, [atLimit, oversized])
    expect(r).toEqual([
      { id: atLimit.id, status: 'saved' },
      { id: oversized.id, status: 'invalid', reason: 'too_large' },
    ])
  })

  it('the limit is measured in bytes, not characters (accents and emojis weigh more)', async () => {
    const { hub } = await m.newHub()
    const e = flatEvent(1, { data: { notes: 'ñ'.repeat(MAX_EVENT_BYTES / 2) } })
    const [r] = await m.cloud.receiveEvents(hub, [e])
    expect(r?.status).toBe('invalid')
    const emojis = flatEvent(2, { data: { notes: '🍺'.repeat(MAX_EVENT_BYTES / 4) } })
    const [r2] = await m.cloud.receiveEvents(hub, [emojis])
    expect(r2?.status).toBe('invalid')
  })

  it('a huge event repeated in the batch is not counted as saved', async () => {
    const { hub, restaurantId } = await m.newHub()
    const large = withSize(1, MAX_EVENT_BYTES + 10)
    const r = await m.cloud.receiveEvents(hub, [large, large])
    expect(statuses(r)).toEqual(['invalid', 'invalid'])
    expect(await count(m.db, 'events', restaurantId)).toBe(0)
  })
})

describe('text Postgres does not accept', () => {
  const cases: [string, (text: string) => Record<string, unknown>][] = [
    ['\\u0000 in a value', (t) => ({ data: { note: t } })],
    ['\\u0000 in a value name', (t) => ({ data: { [t]: 1 } })],
    ['\\u0000 in a nested list', (t) => ({ data: { a: [{ b: [t] }] } })],
    ['\\u0000 in the type', (t) => ({ type: t })],
    ['\\u0000 in an extra field', (t) => ({ extra: t })],
    ['\\u0000 in an extra field name', (t) => ({ [t]: 1 })],
  ]
  const badOnes = ['a\u0000b', '\ud800', 'x\udfff', '\u0000']
  for (const [name, act] of cases)
    it(`${name} or a lone surrogate: that event is invalid and the batch continues`, async () => {
      const { hub, restaurantId } = await m.newHub()
      for (const [i, t] of badOnes.entries()) {
        const r = await m.cloud.receiveEvents(hub, [
          flatEvent(10 * i + 1),
          flatEvent(10 * i + 2, act(t)),
          flatEvent(10 * i + 3),
        ])
        expect(r[1], JSON.stringify(t)).toMatchObject({
          status: 'invalid',
          reason: 'invalid_character',
        })
        expect([r[0]?.status, r[2]?.status]).toEqual(['saved', 'saved'])
      }
      expect(await count(m.db, 'events', restaurantId)).toBe(badOnes.length * 2)
    })

  it('odd but valid text (emojis, accents, ñ, common controls, full surrogate pair) is saved', async () => {
    const { hub, restaurantId } = await m.newHub()
    const notes = 'Té con ñandú 🍹 \t\n\r   \u{1F600} \u0001'
    const [r] = await m.cloud.receiveEvents(hub, [flatEvent(1, { data: { notes } })])
    expect(r?.status).toBe('saved')
    const [row] = await savedEvents(m.db, restaurantId)
    expect(row?.content).toMatchObject({ data: { notes } })
  })

  it('property: any arbitrary Unicode text never produces an error in the batch', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 40 }), async (text) => {
        const { hub } = await m.newHub()
        const [r, s] = await m.cloud.receiveEvents(hub, [
          flatEvent(1, { data: { text } }),
          flatEvent(2),
        ])
        expect(['saved', 'invalid']).toContain(r?.status)
        expect(s?.status).toBe('saved')
      }),
      { seed: SEED, numRuns: 40 },
    )
  })
})

describe('dates at the edge of what Postgres accepts', () => {
  const dates: Record<string, unknown>[] = [
    { received_at: '0000-01-01T00:00:00Z' },
    { received_at: '9999-12-31T23:59:59.999Z' },
    { received_at: '2026-10-26T15:00:00+23:59' },
    { received_at: '2026-10-26T15:00:00.123456789Z' },
    { business_day: '0000-01-01' },
    { business_day: '9999-12-31' },
    { business_day: '2024-02-29' },
    { business_day: '2026-02-29' },
  ]
  it.each(dates)('%j: that event is saved or rejected, without breaking the batch', async (f) => {
    const { hub } = await m.newHub()
    const r = await m.cloud.receiveEvents(hub, [flatEvent(1), flatEvent(2, f), flatEvent(3)])
    expect([r[0]?.status, r[2]?.status]).toEqual(['saved', 'saved'])
    expect(['saved', 'invalid']).toContain(r[1]?.status)
  })

  it('a skewed device clock (date in the future or the past) does not change what is stored', async () => {
    const { hub, restaurantId } = await m.newHub()
    const e = flatEvent(1, { received_at: '2031-01-01T00:00:00Z', business_day: '2019-05-05' })
    const [r] = await m.cloud.receiveEvents(hub, [e])
    expect(r?.status).toBe('saved')
    const [row] = await savedEvents(m.db, restaurantId)
    expect(row?.content).toEqual(e)
    const [two] = await m.cloud.receiveEvents(hub, [e])
    expect(two?.status).toBe('already_stored')
  })

  it('the saved date is set by the cloud, not the event', async () => {
    const { hub, restaurantId } = await m.newHub()
    await m.cloud.receiveEvents(hub, [flatEvent(1, { received_at: '2000-01-01T00:00:00Z' })])
    const [row] = (
      await m.db.query<{ old: boolean }>(
        "SELECT saved_at > '2020-01-01' AS old FROM events WHERE restaurant_id = $1",
        [restaurantId],
      )
    ).rows
    expect(row?.old).toBe(true)
  })
})

describe('extreme nesting', () => {
  it('a value nested thousands of levels deep does not sink the batch', async () => {
    const { hub } = await m.newHub()
    let deep: unknown = 'fin'
    for (let i = 0; i < 5000; i++) deep = { a: deep }
    const [a, b, c] = await m.cloud.receiveEvents(hub, [
      flatEvent(1),
      flatEvent(2, { data: { deep } }),
      flatEvent(3),
    ])
    expect([a?.status, c?.status]).toEqual(['saved', 'saved'])
    expect(['saved', 'invalid']).toContain(b?.status)
  })
})
