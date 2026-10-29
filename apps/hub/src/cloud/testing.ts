import type { OrderEvent } from '@pos/core'
import type { UploaderOptions } from './uploader'

// Test helpers for the hub → cloud upload (task 1.11): timers the test fires by hand, the hub's
// events in memory and a fake cloud that keeps what it receives and can fail on command.
// Tests only.

/** Timers run by hand: the test decides when each wait ends. */
export function manualTimers() {
  const pending = new Map<number, { job: () => void; ms: number }>()
  let next = 0
  const timers: NonNullable<UploaderOptions['timers']> = {
    set: (job, ms) => {
      next += 1
      pending.set(next, { job, ms })
      return next
    },
    clear: (handle) => {
      pending.delete(handle as number)
    },
  }
  return {
    timers,
    /** The waits scheduled right now. */
    waits: () => [...pending.values()].map((p) => p.ms),
    count: () => pending.size,
    /** Ends every wait scheduled right now. */
    fire: () => {
      const jobs = [...pending.values()]
      pending.clear()
      for (const p of jobs) p.job()
    },
  }
}

/** The events of a hub, numbered without gaps, in memory (the uploader only reads them). */
export function memoryEvents(padding = 0) {
  const all: OrderEvent[] = []
  const event = (sequence: number, pad = padding): OrderEvent =>
    ({
      id: `E${String(sequence).padStart(25, '0')}`,
      type: 'OrderOpened',
      sequence,
      pad: pad > 0 ? 'x'.repeat(pad) : undefined,
    }) as unknown as OrderEvent
  return {
    all,
    add(howMany = 1, pad = padding) {
      for (let i = 0; i < howMany; i++) all.push(event(all.length + 1, pad))
    },
    maxSequence: () => all.length,
    eventsSince: (from: number, limit: number) =>
      all.filter((e) => e.sequence > from).slice(0, limit),
  }
}

/** The counter the hub keeps with the last sequence the cloud confirmed. */
export function memoryCounter(initial = 0) {
  const state = { value: initial, writes: [] as number[] }
  return {
    state,
    confirmed: {
      read: () => state.value,
      write: (sequence: number) => {
        state.value = sequence
        state.writes.push(sequence)
      },
    },
  }
}

export interface CloudCall {
  method: string
  route: string
  authorization: string | null
  /** The sequences the batch carried (POST only). */
  sequences: number[]
  bytes: number
}

export type Reply = Response | Error | ((call: CloudCall) => Response | Error | undefined)

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * A cloud that stores events by sequence and answers like the real one: the confirmed sequence
 * is the highest with no gap from 1. `plan` queues replies for the next requests (an error, a
 * strange answer); `loseNextAnswers` makes the cloud save but the answer never arrive.
 */
export function fakeCloud(options: { maxEventsPerRequest?: number; credential?: string } = {}) {
  const stored = new Map<number, OrderEvent>()
  const calls: CloudCall[] = []
  const plan: Reply[] = []
  const state = {
    /** A sequence the cloud refuses to save (an invalid event). */
    invalidSequence: null as number | null,
    loseNextAnswers: 0,
    inFlight: 0,
    maxInFlight: 0,
    maxEventsPerRequest: options.maxEventsPerRequest ?? Number.POSITIVE_INFINITY,
  }
  const credential = options.credential ?? 'credencial-secreta-de-prueba'
  const contiguous = () => {
    let n = 0
    while (stored.has(n + 1)) n += 1
    return n
  }
  const fetchCloud: typeof fetch = async (input, init) => {
    state.inFlight += 1
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
    try {
      // Yields like a real request, so overlapping attempts would show up.
      await Promise.resolve()
      const url = new URL(String(input))
      const headers = (init?.headers ?? {}) as Record<string, string>
      const body = init?.body ? (JSON.parse(String(init.body)) as { events: OrderEvent[] }) : null
      const call: CloudCall = {
        method: init?.method ?? 'GET',
        route: url.pathname,
        authorization: headers.authorization ?? null,
        sequences: body?.events.map((e) => e.sequence) ?? [],
        bytes: init?.body ? new TextEncoder().encode(String(init.body)).length : 0,
      }
      calls.push(call)
      const queued = plan.shift()
      const reply = typeof queued === 'function' ? queued(call) : queued
      if (reply instanceof Error) throw reply
      if (reply) return reply
      if (call.authorization !== `Bearer ${credential}`)
        return jsonResponse({ error: 'invalid_credential' }, 401)
      if (call.route === '/v1/events/last' && call.method === 'GET')
        return jsonResponse({ last_sequence: contiguous() })
      if (call.route === '/v1/events' && call.method === 'POST' && body) {
        if (body.events.length > state.maxEventsPerRequest)
          return jsonResponse({ error: 'batch_too_large' }, 413)
        const results = body.events.map((e) => {
          if (e.sequence === state.invalidSequence) return { id: e.id, status: 'invalid' }
          const had = stored.has(e.sequence)
          stored.set(e.sequence, e)
          return { id: e.id, status: had ? 'already_stored' : 'saved' }
        })
        if (state.loseNextAnswers > 0) {
          state.loseNextAnswers -= 1
          throw new TypeError('the answer was lost')
        }
        return jsonResponse({ results, last_sequence: contiguous() })
      }
      return jsonResponse({ error: 'not_found' }, 404)
    } finally {
      state.inFlight -= 1
    }
  }
  return {
    fetch: fetchCloud,
    stored,
    calls,
    plan,
    state,
    credential,
    posts: () => calls.filter((c) => c.method === 'POST'),
    gets: () => calls.filter((c) => c.method === 'GET'),
    /** Every sequence sent in a POST, in the order they were sent. */
    sent: () => calls.flatMap((c) => c.sequences),
    contiguous,
  }
}

/** Yields to the event loop until the work chained by promises has finished. */
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
