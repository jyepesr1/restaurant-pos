import type { CloudStatus } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { fakeCloud, jsonResponse, manualTimers, memoryCounter, memoryEvents } from './testing'
import {
  CHECK_EVERY_MS,
  CloudUploader,
  EVENTS_PER_BATCH,
  RETRY_DELAYS_MS,
  STUCK_RETRY_MS,
  type UploaderOptions,
} from './uploader'

// The uploader alone, against a fake cloud that fails on command (task 1.11, ADR-016): order and
// no duplicates, the batch limits, internet cuts, strange answers, revocation and the event the
// cloud cannot save. Timers and the clock are manual: nothing here waits.

const CLOCK = new Date('2026-10-29T15:00:00.000Z')

function setup(
  options: {
    events?: number
    padding?: number
    confirmed?: number
    credential?: string | null
    cloud?: Parameters<typeof fakeCloud>[0]
    uploader?: Partial<UploaderOptions>
  } = {},
) {
  const events = memoryEvents(options.padding ?? 0)
  events.add(options.events ?? 0)
  const counter = memoryCounter(options.confirmed ?? 0)
  const cloud = fakeCloud(options.cloud)
  const t = manualTimers()
  const statuses: CloudStatus[] = []
  const failures: unknown[] = []
  let ticks = 0
  const credential = {
    value: options.credential === undefined ? cloud.credential : options.credential,
  }
  const uploader = new CloudUploader({
    url: 'https://cloud.faro.test',
    events,
    credential: () => credential.value,
    confirmed: counter.confirmed,
    onStatus: (s) => statuses.push(s),
    onFailure: (e) => failures.push(e),
    fetch: cloud.fetch,
    // Each reading is one second later, so a new upload always changes `last_upload_at`.
    clock: () => new Date(CLOCK.getTime() + 1000 * ticks++),
    timers: t.timers,
    ...options.uploader,
  })
  /** Wakes the uploader and waits until the attempt in progress finishes. */
  const settle = async () => {
    uploader.wake()
    await uploader.idle()
  }
  /** Ends the current wait and lets the retry run. */
  const retry = async () => {
    t.fire()
    await uploader.idle()
  }
  return { events, counter, cloud, t, statuses, failures, credential, uploader, settle, retry }
}

const sequences = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

describe('order and no duplicates', () => {
  it('uploads more than 500 events in batches of 500, in order, each exactly once', async () => {
    const m = setup({ events: 1234 })
    await m.settle()
    expect(m.cloud.posts().map((c) => c.sequences.length)).toEqual([500, 500, 234])
    expect(m.cloud.sent()).toEqual(sequences(1, 1234))
    expect(m.cloud.gets()).toHaveLength(1)
    expect(m.uploader.current()).toEqual({
      state: 'up_to_date',
      pending: 0,
      last_upload_at: expect.any(String),
    })
    expect(m.counter.state.value).toBe(1234)
  })

  it('exactly 500 events go in one batch, 501 in two', async () => {
    const a = setup({ events: EVENTS_PER_BATCH })
    await a.settle()
    expect(a.cloud.posts()).toHaveLength(1)
    const b = setup({ events: EVENTS_PER_BATCH + 1 })
    await b.settle()
    expect(b.cloud.posts().map((c) => c.sequences.length)).toEqual([500, 1])
  })

  it('big events split the batch by bytes, in order, and no batch goes over the limit', async () => {
    const m = setup({
      events: 40,
      padding: 1_000,
      uploader: { maxBatchBytes: 5_000 },
    })
    await m.settle()
    const posts = m.cloud.posts()
    expect(posts.length).toBeGreaterThan(5)
    // The body is the batch plus a few bytes of envelope.
    for (const p of posts) expect(p.bytes).toBeLessThanOrEqual(5_000 + 64)
    expect(m.cloud.sent()).toEqual(sequences(1, 40))
    expect(m.uploader.current().state).toBe('up_to_date')
  })

  it('an event bigger than the limit goes alone instead of blocking the upload', async () => {
    const m = setup({ events: 3, padding: 10_000, uploader: { maxBatchBytes: 1_000 } })
    await m.settle()
    expect(m.cloud.posts().map((c) => c.sequences)).toEqual([[1], [2], [3]])
    expect(m.uploader.current().state).toBe('up_to_date')
  })

  it('a 413 halves the batch until the cloud takes it, and nothing is lost or repeated', async () => {
    const m = setup({ events: 500, cloud: { maxEventsPerRequest: 100 } })
    await m.settle()
    // 500 → 250 → 125 → 62; after each batch that goes in, it tries twice as many again.
    const sizes = m.cloud.posts().map((c) => c.sequences.length)
    expect(sizes.slice(0, 4)).toEqual([500, 250, 125, 62])
    expect(sizes.every((n) => n <= 500)).toBe(true)
    // What the cloud kept equals what the hub has, once each.
    expect(m.cloud.stored.size).toBe(500)
    expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
    // The 413s were not shown as an internet cut.
    expect(m.statuses.map((s) => s.state)).not.toContain('offline')
  })

  it('a 413 even for a single event is «stuck», not an internet cut: it retries in 5 minutes', async () => {
    const m = setup({ events: 3, cloud: { maxEventsPerRequest: 0 } })
    await m.settle()
    expect(m.uploader.current()).toMatchObject({ state: 'stuck', pending: 3 })
    expect(m.t.waits()).toEqual([STUCK_RETRY_MS])
    expect(m.cloud.posts().map((c) => c.sequences.length)).toEqual(expect.arrayContaining([1]))
    m.cloud.state.maxEventsPerRequest = Number.POSITIVE_INFINITY
    await m.retry()
    expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
  })

  it('a cut in the middle of the upload keeps what was confirmed and continues from there', async () => {
    const m = setup({ events: 1200 })
    // The question and the first batch go through, the second batch hits an internet cut.
    m.cloud.plan.push(
      () => undefined, // GET
      () => undefined, // POST 1
      new TypeError('fetch failed'), // POST 2
    )
    await m.settle()
    expect(m.uploader.current()).toMatchObject({ state: 'offline', pending: 700 })
    expect(m.counter.state.value).toBe(500)
    await m.retry()
    expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
    // The failed batch was sent again from 501; 1..500 were not resent.
    expect(m.cloud.sent().filter((s) => s <= 500)).toEqual(sequences(1, 500))
    expect(m.cloud.stored.size).toBe(1200)
    expect([...m.cloud.stored.keys()]).toEqual(sequences(1, 1200))
  })

  it('if the answer is lost after the cloud saved, the resend does not duplicate', async () => {
    const m = setup({ events: 10 })
    m.cloud.state.loseNextAnswers = 1
    await m.settle()
    expect(m.cloud.stored.size).toBe(10)
    // The hub does not know: it still counts everything as pending and offline.
    expect(m.uploader.current()).toMatchObject({ state: 'offline', pending: 10 })
    await m.retry()
    expect(m.cloud.stored.size).toBe(10)
    expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(m.counter.state.value).toBe(10)
  })

  it('the cloud confirming only part of the batch moves the counter to that point and keeps going', async () => {
    const m = setup({ events: 10 })
    m.cloud.plan.push(
      () => undefined,
      () => {
        // The cloud kept only the first 4 events of the batch.
        for (let s = 1; s <= 4; s++) m.cloud.stored.set(s, m.events.all[s - 1] as never)
        return jsonResponse({ results: [], last_sequence: 4 })
      },
    )
    await m.settle()
    expect(m.counter.state.writes).toContain(4)
    // The next batch started at 5.
    expect(m.cloud.posts()[1]?.sequences[0]).toBe(5)
    expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
  })

  it('events saved while a batch is in flight go up in the same run, never two requests at once', async () => {
    const m = setup({ events: 3 })
    m.cloud.plan.push(
      () => undefined,
      () => {
        m.events.add(2)
        m.uploader.wake()
        m.uploader.wake()
        return undefined
      },
    )
    await m.settle()
    expect(m.cloud.state.maxInFlight).toBe(1)
    expect(m.cloud.stored.size).toBe(5)
    expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
  })

  it('waking many times in a row starts a single attempt', async () => {
    const m = setup({ events: 5 })
    for (let i = 0; i < 20; i++) m.uploader.wake()
    await m.uploader.idle()
    expect(m.cloud.gets()).toHaveLength(1)
    expect(m.cloud.state.maxInFlight).toBe(1)
    expect(m.cloud.stored.size).toBe(5)
  })

  it('a single new event goes up right away without flickering through «uploading»', async () => {
    const m = setup({ events: 2 })
    await m.settle()
    m.statuses.length = 0
    m.events.add(1)
    await m.settle()
    expect(m.statuses.length).toBeGreaterThan(0)
    expect(m.statuses.every((s) => s.state === 'up_to_date')).toBe(true)
    expect(m.cloud.stored.size).toBe(3)
  })

  it('catching up after a cut is shown as «uploading» with the pending count going down', async () => {
    const m = setup({ events: 1200 })
    await m.settle()
    const uploading = m.statuses.filter((s) => s.state === 'uploading').map((s) => s.pending)
    expect(uploading.length).toBeGreaterThan(0)
    expect(uploading).toEqual([...uploading].sort((a, b) => b - a))
    expect(m.statuses.at(-1)).toMatchObject({ state: 'up_to_date', pending: 0 })
  })
})

describe('the request', () => {
  it('sends the credential only in the Authorization header, never in the body or the URL', async () => {
    const m = setup({ events: 2 })
    await m.settle()
    for (const c of m.cloud.calls) {
      expect(c.authorization).toBe(`Bearer ${m.cloud.credential}`)
      expect(c.route).not.toContain(m.cloud.credential)
    }
    expect(JSON.stringify(m.cloud.calls.map((c) => c.sequences))).not.toContain(m.cloud.credential)
  })

  it('every request carries a timeout signal', async () => {
    const signals: (AbortSignal | null | undefined)[] = []
    const m = setup({
      events: 1,
      uploader: {
        fetch: async (input, init) => {
          signals.push(init?.signal)
          return fakeOk(String(input))
        },
      },
    })
    await m.settle()
    expect(signals.length).toBeGreaterThan(0)
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal)
  })

  it('a request that never answers is cut at the timeout and treated as no internet', async () => {
    let calls = 0
    const m = setup({
      events: 2,
      uploader: {
        requestTimeoutMs: 5,
        fetch: (_input, init) => {
          calls += 1
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('timed out', 'TimeoutError')),
            )
          })
        },
      },
    })
    await m.settle()
    expect(calls).toBe(1)
    expect(m.uploader.current()).toMatchObject({ state: 'offline', pending: 2 })
    expect(m.t.waits()).toEqual([RETRY_DELAYS_MS[0]])
    expect(m.failures).toEqual([])
  })

  it('reads the credential at each attempt: a changed one is used from then on', async () => {
    const m = setup({ events: 1 })
    await m.settle()
    m.credential.value = 'otra-credencial'
    m.events.add(1)
    await m.settle()
    // The fake cloud rejects the unknown credential: the register PC is revoked.
    expect(m.cloud.calls.at(-1)?.authorization).toBe('Bearer otra-credencial')
    expect(m.uploader.current().state).toBe('revoked')
  })
})

function fakeOk(url: string): Response {
  return url.endsWith('/last')
    ? jsonResponse({ last_sequence: 0 })
    : jsonResponse({ results: [], last_sequence: 1 })
}

describe('without internet', () => {
  it('starts pending: with a credential and unsent events it shows offline with the count', () => {
    const m = setup({ events: 7, confirmed: 3 })
    expect(m.uploader.current()).toEqual({ state: 'offline', pending: 4, last_upload_at: null })
  })

  it('without a credential nothing is asked and the pending count is the whole history', async () => {
    const m = setup({ events: 5, credential: null })
    await m.settle()
    expect(m.cloud.calls).toHaveLength(0)
    expect(m.uploader.current()).toEqual({
      state: 'not_connected',
      pending: 5,
      last_upload_at: null,
    })
    m.events.add(2)
    await m.settle()
    expect(m.uploader.current().pending).toBe(7)
    expect(m.cloud.calls).toHaveLength(0)
  })

  it('the pending count keeps growing while it waits, without asking the cloud again', async () => {
    const m = setup({ events: 2 })
    m.cloud.plan.push(new TypeError('fetch failed'))
    await m.settle()
    expect(m.uploader.current()).toMatchObject({ state: 'offline', pending: 2 })
    const calls = m.cloud.calls.length
    for (let i = 0; i < 5; i++) {
      m.events.add(1)
      await m.settle()
    }
    expect(m.cloud.calls.length).toBe(calls)
    expect(m.uploader.current()).toMatchObject({ state: 'offline', pending: 7 })
    expect(m.t.count()).toBe(1)
  })

  it('backs off 1, 2, 5, 10, 20 and 30 seconds and stays at 30', async () => {
    const m = setup({ events: 1 })
    for (let i = 0; i < 9; i++) m.cloud.plan.push(new TypeError('fetch failed'))
    await m.settle()
    const waits = [...m.t.waits()]
    for (let i = 0; i < 8; i++) {
      await m.retry()
      waits.push(...m.t.waits())
    }
    expect(waits).toEqual([1000, 2000, 5000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000])
  })

  it('after a success the backoff starts over', async () => {
    const m = setup({ events: 1 })
    m.cloud.plan.push(new TypeError('x'), new TypeError('x'), new TypeError('x'))
    await m.settle()
    await m.retry()
    await m.retry()
    expect(m.t.waits()).toEqual([5000])
    await m.retry()
    expect(m.uploader.current().state).toBe('up_to_date')
    m.events.add(1)
    m.cloud.plan.push(new TypeError('x'))
    await m.settle()
    expect(m.t.waits()).toEqual([1000])
  })

  it('failing to ask the confirmed sequence is retried and asked again, not assumed', async () => {
    const m = setup({ events: 3 })
    m.cloud.plan.push(new TypeError('x'))
    await m.settle()
    expect(m.cloud.posts()).toHaveLength(0)
    await m.retry()
    expect(m.cloud.gets()).toHaveLength(2)
    expect(m.cloud.stored.size).toBe(3)
  })

  it('a timer firing after stop does nothing', async () => {
    const m = setup({ events: 1 })
    m.cloud.plan.push(new TypeError('x'))
    await m.settle()
    m.uploader.stop()
    const calls = m.cloud.calls.length
    m.t.fire()
    await m.uploader.idle()
    m.uploader.wake()
    await m.uploader.idle()
    expect(m.cloud.calls.length).toBe(calls)
  })
})

describe('strange answers', () => {
  const bad: [string, () => Response][] = [
    ['500 with JSON', () => jsonResponse({ error: 'internal_error' }, 500)],
    ['502 with an HTML page', () => new Response('<html>Bad gateway</html>', { status: 502 })],
    ['503 with an empty body', () => new Response(null, { status: 503 })],
    ['429', () => jsonResponse({ error: 'slow_down' }, 429)],
    ['200 with invalid JSON', () => new Response('{"last_seq', { status: 200 })],
    ['200 with an empty body', () => new Response('', { status: 200 })],
    ['200 with null', () => new Response('null', { status: 200 })],
    ['200 with a string', () => new Response('"ok"', { status: 200 })],
    ['200 without last_sequence', () => jsonResponse({ results: [] })],
    ['200 with last_sequence null', () => jsonResponse({ last_sequence: null })],
    ['200 with last_sequence as text', () => jsonResponse({ last_sequence: '3' })],
    ['200 with a negative last_sequence', () => jsonResponse({ last_sequence: -1 })],
    ['200 with a fractional last_sequence', () => jsonResponse({ last_sequence: 1.5 })],
    [
      '200 with a huge last_sequence',
      () => new Response('{"last_sequence": 1e400}', { status: 200 }),
    ],
  ]

  for (const [name, answer] of bad) {
    it(`${name} to the confirmed sequence: offline, retried, counter untouched, no crash`, async () => {
      const m = setup({ events: 4, confirmed: 2 })
      m.cloud.plan.push(answer)
      await m.settle()
      expect(m.uploader.current()).toMatchObject({ state: 'offline', pending: 2 })
      expect(m.counter.state.writes).toEqual([])
      expect(m.t.waits()).toEqual([RETRY_DELAYS_MS[0]])
      expect(m.failures).toEqual([])
      await m.retry()
      expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
    })

    it(`${name} to a batch: offline, retried, and the batch is sent again without duplicates`, async () => {
      const m = setup({ events: 4 })
      m.cloud.plan.push(() => undefined, answer)
      await m.settle()
      expect(m.uploader.current().state).toBe('offline')
      expect(m.failures).toEqual([])
      await m.retry()
      expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
      expect(m.cloud.stored.size).toBe(4)
    })
  }

  // The cloud answers but does not take the request: not the internet, and retrying soon gives the
  // same answer.
  for (const [name, answer] of [
    ['404', () => jsonResponse({ error: 'not_found' }, 404)],
    ['400', () => jsonResponse({ error: 'invalid_data' }, 400)],
    ['403', () => jsonResponse({ error: 'forbidden' }, 403)],
  ] as [string, () => Response][]) {
    it(`${name} to the confirmed sequence: «stuck», retried in 5 minutes, counter untouched`, async () => {
      const m = setup({ events: 4, confirmed: 2 })
      m.cloud.plan.push(answer)
      await m.settle()
      expect(m.uploader.current()).toMatchObject({ state: 'stuck', pending: 2 })
      expect(m.counter.state.writes).toEqual([])
      expect(m.t.waits()).toEqual([STUCK_RETRY_MS])
      expect(m.failures).toEqual([])
      await m.retry()
      expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
    })

    it(`${name} to a batch: «stuck», and the batch is sent again later without duplicates`, async () => {
      const m = setup({ events: 4 })
      m.cloud.plan.push(() => undefined, answer)
      await m.settle()
      expect(m.uploader.current().state).toBe('stuck')
      await m.retry()
      expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
      expect(m.cloud.stored.size).toBe(4)
    })
  }

  it('a last_sequence above the hub sequence stops the upload as «stuck» without sending anything', async () => {
    const m = setup({ events: 5 })
    m.cloud.plan.push(jsonResponse({ last_sequence: 9 }))
    await m.settle()
    expect(m.uploader.current()).toMatchObject({ state: 'stuck', pending: 0 })
    expect(m.cloud.posts()).toHaveLength(0)
    expect(m.t.waits()).toEqual([STUCK_RETRY_MS])
  })

  it('a batch answer with a last_sequence above the hub sequence is also «stuck»', async () => {
    const m = setup({ events: 5 })
    m.cloud.plan.push(() => undefined, jsonResponse({ results: [], last_sequence: 99 }))
    await m.settle()
    expect(m.uploader.current().state).toBe('stuck')
    expect(m.cloud.posts()).toHaveLength(1)
    await m.settle()
    expect(m.cloud.posts()).toHaveLength(1)
  })

  it('the hub catching up with the cloud (restored copy) does not unstick it by itself', async () => {
    // The cloud has up to 9; the hub, restored from an older copy, has 5. The sequences 6 to 9 of
    // the hub's new events would reuse numbers the cloud already has.
    const m = setup({ events: 5 })
    m.cloud.plan.push(jsonResponse({ last_sequence: 9 }))
    await m.settle()
    expect(m.uploader.current().state).toBe('stuck')
    m.events.add(2)
    await m.settle()
    // Still waiting for the 5-minute retry; nothing was sent.
    expect(m.cloud.posts()).toHaveLength(0)
    expect(m.uploader.current().state).toBe('stuck')
  })

  it('the cloud confirming less than before (it lost data) rewinds the counter and resends', async () => {
    const m = setup({ events: 10, confirmed: 8 })
    // Counter says 8; the cloud says it only has 3.
    m.cloud.plan.push(jsonResponse({ last_sequence: 3 }))
    await m.settle()
    expect(m.counter.state.writes[0]).toBe(3)
    expect(m.cloud.posts()[0]?.sequences[0]).toBe(4)
  })
})

describe('revoked', () => {
  it('a 401 to the question stops everything, with no retry scheduled', async () => {
    const m = setup({ events: 3 })
    m.cloud.plan.push(jsonResponse({ error: 'invalid_credential' }, 401))
    await m.settle()
    expect(m.uploader.current()).toMatchObject({ state: 'revoked', pending: 3 })
    expect(m.t.count()).toBe(0)
  })

  it('a 401 in the middle of the upload also stops it, keeping what was confirmed', async () => {
    const m = setup({ events: 1200 })
    m.cloud.plan.push(
      () => undefined,
      () => undefined,
      jsonResponse({ error: 'invalid_credential' }, 401),
    )
    await m.settle()
    expect(m.uploader.current()).toMatchObject({ state: 'revoked', pending: 700 })
    expect(m.counter.state.value).toBe(500)
    expect(m.t.count()).toBe(0)
  })

  it('while revoked, new events and timers never reach the network, but the count keeps rising', async () => {
    const m = setup({ events: 3 })
    m.cloud.plan.push(jsonResponse({}, 401))
    await m.settle()
    const calls = m.cloud.calls.length
    for (let i = 0; i < 4; i++) {
      m.events.add(1)
      await m.settle()
    }
    m.t.fire()
    await m.uploader.idle()
    expect(m.cloud.calls.length).toBe(calls)
    expect(m.uploader.current()).toMatchObject({ state: 'revoked', pending: 7 })
  })

  it('a revocation seen while waiting to retry cancels the retry', async () => {
    const m = setup({ events: 3 })
    m.cloud.plan.push(new TypeError('x'), jsonResponse({}, 401))
    await m.settle()
    expect(m.t.count()).toBe(1)
    await m.retry()
    expect(m.uploader.current().state).toBe('revoked')
    expect(m.t.count()).toBe(0)
  })

  it('restart (a new registration) asks again from the start and uploads everything pending', async () => {
    const m = setup({ events: 3 })
    m.cloud.plan.push(jsonResponse({}, 401))
    await m.settle()
    m.events.add(2)
    m.counter.state.value = 0
    m.uploader.restart()
    await m.uploader.idle()
    expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(m.cloud.stored.size).toBe(5)
    expect(m.cloud.gets().length).toBe(2)
  })

  it('restart also cancels a pending retry and resets the backoff and the batch size', async () => {
    const m = setup({ events: 3, cloud: { maxEventsPerRequest: 1 } })
    m.cloud.plan.push(new TypeError('x'), new TypeError('x'))
    await m.settle()
    await m.retry()
    expect(m.t.waits()).toEqual([2000])
    m.uploader.restart()
    await m.uploader.idle()
    // Only the periodic check of an up-to-date upload is left.
    expect(m.t.waits()).toEqual([CHECK_EVERY_MS])
    expect(m.uploader.current().state).toBe('up_to_date')
  })
})

describe('an event the cloud cannot save', () => {
  it('stops as «stuck», keeping the events before it, and retries only every 5 minutes', async () => {
    const m = setup({ events: 10 })
    m.cloud.state.invalidSequence = 6
    await m.settle()
    // 1..5 were saved; the answer's last_sequence did not move past 5.
    expect(m.uploader.current()).toMatchObject({ state: 'stuck', pending: 5 })
    expect(m.counter.state.value).toBe(5)
    expect(m.t.waits()).toEqual([STUCK_RETRY_MS])
  })

  it('does not hammer the cloud: new events and wakes in between make no requests', async () => {
    const m = setup({ events: 10 })
    m.cloud.state.invalidSequence = 6
    await m.settle()
    const calls = m.cloud.calls.length
    for (let i = 0; i < 30; i++) {
      m.events.add(1)
      await m.settle()
    }
    expect(m.cloud.calls.length).toBe(calls)
    expect(m.uploader.current()).toMatchObject({ state: 'stuck', pending: 35 })
  })

  it('each 5-minute retry makes exactly one more request and stays stuck', async () => {
    const m = setup({ events: 10 })
    m.cloud.state.invalidSequence = 6
    await m.settle()
    const posts = m.cloud.posts().length
    for (let i = 1; i <= 3; i++) {
      await m.retry()
      expect(m.cloud.posts()).toHaveLength(posts + i)
      expect(m.t.waits()).toEqual([STUCK_RETRY_MS])
      expect(m.uploader.current().state).toBe('stuck')
    }
  })

  it('goes on by itself when the cloud accepts the event at the next retry', async () => {
    const m = setup({ events: 10 })
    m.cloud.state.invalidSequence = 6
    await m.settle()
    m.cloud.state.invalidSequence = null
    await m.retry()
    expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(m.cloud.stored.size).toBe(10)
  })

  it('the first event invalid: stuck with everything pending and nothing confirmed', async () => {
    const m = setup({ events: 3 })
    m.cloud.state.invalidSequence = 1
    await m.settle()
    expect(m.uploader.current()).toMatchObject({ state: 'stuck', pending: 3 })
    expect(m.counter.state.value).toBe(0)
  })

  it('a stuck upload does not report the upload as confirmed when the cloud kept nothing new', async () => {
    const m = setup({ events: 3 })
    m.cloud.state.invalidSequence = 1
    await m.settle()
    // `last_upload_at` is «when the cloud last confirmed an upload»: nothing was confirmed.
    expect(m.uploader.current().last_upload_at).toBeNull()
  })
})

describe('restarting the hub', () => {
  it('a new uploader on the same counter shows the real pending count before any request', () => {
    const first = setup({ events: 10, confirmed: 6 })
    const restarted = new CloudUploader({
      url: 'https://cloud.faro.test',
      events: first.events,
      credential: () => first.cloud.credential,
      confirmed: first.counter.confirmed,
      fetch: first.cloud.fetch,
      timers: first.t.timers,
    })
    expect(restarted.current()).toEqual({ state: 'offline', pending: 4, last_upload_at: null })
    expect(first.cloud.calls).toHaveLength(0)
  })

  it('without internet at startup the pending count stays right and nothing is lost', async () => {
    const m = setup({ events: 10, confirmed: 6 })
    m.cloud.plan.push(new TypeError('x'))
    await m.settle()
    expect(m.uploader.current()).toMatchObject({ state: 'offline', pending: 4 })
    expect(m.counter.state.value).toBe(6)
  })

  it('on coming back it asks the cloud first and does not resend what the cloud already has', async () => {
    // Everything was saved in the cloud but the hub went down before writing the counter.
    const m = setup({ events: 10, confirmed: 0 })
    for (let s = 1; s <= 10; s++) m.cloud.stored.set(s, m.events.all[s - 1] as never)
    await m.settle()
    expect(m.cloud.gets()).toHaveLength(1)
    expect(m.cloud.posts()).toHaveLength(0)
    expect(m.counter.state.value).toBe(10)
    expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
  })

  it('resends only what the cloud lacks, even if the counter was behind', async () => {
    const m = setup({ events: 10, confirmed: 2 })
    for (let s = 1; s <= 7; s++) m.cloud.stored.set(s, m.events.all[s - 1] as never)
    await m.settle()
    expect(m.cloud.sent()).toEqual([8, 9, 10])
  })

  it('a second uploader started after the first one stopped continues without duplicates', async () => {
    const m = setup({ events: 10 })
    m.cloud.plan.push(
      () => undefined,
      () => {
        m.uploader.stop()
        return undefined
      },
    )
    await m.settle()
    m.events.add(5)
    const again = new CloudUploader({
      url: 'https://cloud.faro.test',
      events: m.events,
      credential: () => m.cloud.credential,
      confirmed: m.counter.confirmed,
      fetch: m.cloud.fetch,
      timers: m.t.timers,
    })
    again.wake()
    await again.idle()
    expect(m.cloud.stored.size).toBe(15)
    expect([...m.cloud.stored.keys()]).toEqual(sequences(1, 15))
    expect(again.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
  })
})

describe('unexpected failures', () => {
  it('a bug while reading events goes to the log, shows offline, and recovers on the next retry', async () => {
    const m = setup({ events: 3 })
    const original = m.events.eventsSince
    let broken = true
    m.events.eventsSince = (from, limit) => {
      if (broken) throw new Error('disk error')
      return original(from, limit)
    }
    await m.settle()
    expect(m.failures).toHaveLength(1)
    expect(m.uploader.current().state).toBe('offline')
    expect(m.t.waits()).toEqual([30_000])
    broken = false
    await m.retry()
    expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
  })

  it('failing to save the counter is a failure to log, not a crash, and the batch is not lost', async () => {
    const m = setup({ events: 3 })
    let broken = true
    const write = m.counter.confirmed.write
    m.counter.confirmed.write = (n) => {
      if (broken) throw new Error('database is locked')
      write(n)
    }
    await m.settle()
    expect(m.failures).toHaveLength(1)
    broken = false
    await m.retry()
    expect(m.uploader.current()).toMatchObject({ state: 'up_to_date', pending: 0 })
    expect(m.cloud.stored.size).toBe(3)
  })

  it('statuses are not repeated when nothing changed', async () => {
    const m = setup({ events: 2, uploader: { clock: () => CLOCK } })
    await m.settle()
    const n = m.statuses.length
    await m.settle()
    await m.settle()
    expect(m.statuses.length).toBe(n)
  })

  it('last_upload_at comes from the hub clock, however skewed it is', async () => {
    const m = setup({ events: 1, uploader: { clock: () => new Date('1999-01-01T00:00:00.000Z') } })
    await m.settle()
    expect(m.uploader.current().last_upload_at).toBe('1999-01-01T00:00:00.000Z')
    expect(m.uploader.current().state).toBe('up_to_date')
  })
})
