import type { OrderEvent } from '@pos/core'
import type { CloudState, CloudStatus } from '@pos/sync'

// The upload hub → cloud (task 1.11, ADR-016). There is no separate queue: the hub's events are
// already numbered without gaps, so what is pending is everything after the last sequence the
// cloud confirmed (`GET /v1/events/last`). The hub uploads it in order, in batches, as soon as it
// saves each event; without internet it retries on its own, with a growing wait, and the
// dining room never waits for it.

/** What the cloud takes in one batch (`MAX_EVENTS_PER_BATCH` in `@pos/cloud`). */
export const EVENTS_PER_BATCH = 500
/** Below the cloud's 4 MB per request, with room to spare. */
export const MAX_BATCH_BYTES = 3 * 1024 * 1024
/** Waits after each failure in a row; the last one repeats. Short: internet usually comes back. */
export const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000]
/** An event the cloud cannot save does not fix itself: it is retried every 5 minutes. */
export const STUCK_RETRY_MS = 5 * 60 * 1000
export const REQUEST_TIMEOUT_MS = 15_000
/**
 * Up to date and with nothing new, it asks the cloud every minute anyway: if internet drops
 * while the register is idle, the bar stops saying «Nube al día».
 */
export const CHECK_EVERY_MS = 60_000

export interface UploaderOptions {
  /** The cloud's address, without the trailing slash. */
  url: string
  events: {
    maxSequence(): number
    eventsSince(from: number, limit: number): OrderEvent[]
  }
  /** The credential; null if this PC is not connected to the cloud. */
  credential: () => string | null
  /** The last sequence the cloud confirmed, kept by the hub (to know what is pending offline). */
  confirmed: { read(): number; write(sequence: number): void }
  onStatus?: (status: CloudStatus) => void
  /** Something unexpected (not a network failure): goes to the hub's log. */
  onFailure?: (error: unknown) => void
  fetch?: typeof fetch
  clock?: () => Date
  timers?: {
    set: (job: () => void, ms: number) => unknown
    clear: (handle: unknown) => void
  }
  retryDelaysMs?: readonly number[]
  stuckRetryMs?: number
  requestTimeoutMs?: number
  maxBatchBytes?: number
  checkEveryMs?: number
}

class Unauthorized extends Error {}
class TooLarge extends Error {}
/** The cloud did not answer, or answered with a server error or something it does not understand. */
class NoAnswer extends Error {}
/** The cloud answered that it does not take the request (another 4xx): retrying soon is useless. */
class Refused extends Error {}

const encoder = new TextEncoder()

const isSequence = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0

export class CloudUploader {
  private readonly o: UploaderOptions
  private readonly retryDelaysMs: readonly number[]
  private readonly stuckRetryMs: number
  private readonly requestTimeoutMs: number
  private readonly maxBatchBytes: number
  private readonly checkEveryMs: number
  private readonly fetch: typeof fetch
  private readonly clock: () => Date
  private readonly timers: NonNullable<UploaderOptions['timers']>
  private status: CloudStatus
  private running = false
  private again = false
  private stopped = false
  private timer: unknown = null
  /** Until the timer fires, a new event does not trigger another attempt (offline or stuck). */
  private waiting = false
  /** The periodic check while up to date: unlike `timer`, a new event does not wait for it. */
  private checkTimer: unknown = null
  /** The request in flight, to cut it when the hub closes. */
  private inFlight: AbortController | null = null
  private failures = 0
  /** Whether the confirmed sequence was asked to the cloud since this credential was set. */
  private asked = false
  private revoked = false
  private batchLimit = EVENTS_PER_BATCH

  constructor(options: UploaderOptions) {
    this.o = options
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS
    this.stuckRetryMs = options.stuckRetryMs ?? STUCK_RETRY_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.maxBatchBytes = options.maxBatchBytes ?? MAX_BATCH_BYTES
    this.checkEveryMs = options.checkEveryMs ?? CHECK_EVERY_MS
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.clock = options.clock ?? (() => new Date())
    this.timers = options.timers ?? {
      set: (job, ms) => setTimeout(job, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    this.status = {
      state: options.credential() ? 'offline' : 'not_connected',
      pending: 0,
      last_upload_at: null,
    }
    this.status.pending = this.pending()
  }

  current(): CloudStatus {
    return this.status
  }

  /** There is something new to upload (or it is starting): uploads it unless it is waiting. */
  wake() {
    if (this.stopped) return
    if (this.revoked) {
      // Nothing goes up, but the register still sees how much is waiting.
      this.publish('revoked')
      return
    }
    if (this.running) {
      this.again = true
      return
    }
    if (this.waiting) {
      // The pending count still goes up on the register's screen.
      this.publish(this.status.state)
      return
    }
    // `run` handles its own failures; this catch is the last guard so a cloud upload can never
    // take the hub down with an unhandled rejection.
    this.run().catch((error) => this.o.onFailure?.(error))
  }

  /** The credential changed (it was just registered): starts over and uploads at once. */
  restart() {
    this.cancelTimer()
    this.revoked = false
    this.asked = false
    this.failures = 0
    this.batchLimit = EVENTS_PER_BATCH
    // Said right away: whoever asks for the status now must not get the old «not connected».
    this.publish('uploading')
    this.wake()
  }

  /** Stops for good: cancels the waits and cuts the request in flight (closing the hub). */
  stop() {
    this.stopped = true
    this.cancelTimer()
    this.inFlight?.abort()
  }

  /** Resolves once the attempt in progress finishes (for closing the hub and the tests). */
  async idle() {
    while (this.running) await new Promise((r) => setTimeout(r, 5))
  }

  /** What is waiting; if the database does not answer, the last known count. */
  private pending() {
    try {
      return Math.max(0, this.o.events.maxSequence() - this.o.confirmed.read())
    } catch {
      return this.status?.pending ?? 0
    }
  }

  private publish(state: CloudState, uploadedNow = false) {
    const next: CloudStatus = {
      state,
      pending: this.pending(),
      last_upload_at: uploadedNow ? this.clock().toISOString() : this.status.last_upload_at,
    }
    const same =
      next.state === this.status.state &&
      next.pending === this.status.pending &&
      next.last_upload_at === this.status.last_upload_at
    this.status = next
    if (!same) this.o.onStatus?.(next)
  }

  private cancelTimer() {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
    this.waiting = false
    if (this.checkTimer !== null) this.timers.clear(this.checkTimer)
    this.checkTimer = null
  }

  /** Up to date: in a while it asks the cloud again, even with nothing new. */
  private checkLater() {
    if (this.stopped) return
    if (this.checkTimer !== null) this.timers.clear(this.checkTimer)
    this.checkTimer = this.timers.set(() => {
      this.checkTimer = null
      this.asked = false
      this.wake()
    }, this.checkEveryMs)
  }

  private retryIn(ms: number) {
    this.cancelTimer()
    this.waiting = true
    this.timer = this.timers.set(() => {
      this.timer = null
      this.waiting = false
      this.wake()
    }, ms)
  }

  private async run() {
    this.running = true
    if (this.checkTimer !== null) {
      this.timers.clear(this.checkTimer)
      this.checkTimer = null
    }
    try {
      do {
        this.again = false
        await this.attempt()
      } while (this.again && !this.stopped && !this.waiting && !this.revoked)
    } catch (error) {
      // A bug, not the network: it is logged and retried later, the hub keeps running.
      this.o.onFailure?.(error)
      this.publish('offline')
      this.retryIn(this.retryDelaysMs.at(-1) ?? 30_000)
    } finally {
      this.running = false
    }
  }

  private async attempt() {
    const credential = this.o.credential()
    if (!credential) {
      this.publish('not_connected')
      return
    }
    try {
      if (!this.asked) {
        const r = await this.call(credential, 'GET', '/v1/events/last')
        if (!isSequence(r.last_sequence)) throw new NoAnswer('last_sequence')
        this.o.confirmed.write(r.last_sequence)
        this.asked = true
      }
      while (!this.stopped) {
        const confirmed = this.o.confirmed.read()
        const max = this.o.events.maxSequence()
        if (confirmed > max) {
          // The cloud has more of this hub than the hub itself (its database was restored from an
          // older copy): the next events would reuse sequences already up there. Someone must look
          // before anything else is uploaded (restoring a hub is task 1.12).
          this.publish('stuck')
          // It asks again next time: the cloud's figure may have been fixed meanwhile.
          this.asked = false
          this.retryIn(this.stuckRetryMs)
          return
        }
        if (confirmed === max) {
          this.failures = 0
          this.publish('up_to_date', true)
          this.checkLater()
          return
        }
        // Catching up after a cut is shown; a single event uploaded right away is not, so the
        // register's bar does not flicker with every order.
        if (this.status.state !== 'up_to_date') this.publish('uploading')
        const events = this.batch(confirmed)
        const r = await this.call(credential, 'POST', '/v1/events', { events })
        if (!isSequence(r.last_sequence)) throw new NoAnswer('last_sequence')
        this.failures = 0
        this.o.confirmed.write(r.last_sequence)
        if (r.last_sequence <= confirmed) {
          // The cloud kept the batch but the next event did not go in (invalid or with other
          // content than the stored one): resending it would give the same. Someone must look.
          // Nothing new is in the cloud, so the last upload time stays as it was.
          this.publish('stuck')
          this.retryIn(this.stuckRetryMs)
          return
        }
        // After a 413 it went down to smaller batches; it goes back up little by little.
        this.batchLimit = Math.min(EVENTS_PER_BATCH, this.batchLimit * 2)
        this.publish(this.status.state === 'up_to_date' ? 'up_to_date' : 'uploading', true)
      }
    } catch (error) {
      if (error instanceof Unauthorized) {
        // Revoked (or the cloud lost it): nothing more is sent until it is registered again.
        this.revoked = true
        this.asked = false
        this.publish('revoked')
        return
      }
      if (error instanceof TooLarge && this.batchLimit > 1) {
        this.batchLimit = Math.max(1, Math.floor(this.batchLimit / 2))
        this.again = true
        return
      }
      if (error instanceof Refused || error instanceof TooLarge) {
        // The cloud answers but does not take it (a single event too big for it, another API
        // version): it is not the internet, and retrying soon gives the same.
        this.publish('stuck')
        this.retryIn(this.stuckRetryMs)
        return
      }
      if (!(error instanceof NoAnswer)) throw error
      this.failures += 1
      this.publish('offline')
      const delays = this.retryDelaysMs
      this.retryIn(delays[Math.min(this.failures, delays.length) - 1] ?? 30_000)
    }
  }

  /** The next events in order, without going over the batch's events or bytes. */
  private batch(confirmed: number): OrderEvent[] {
    const events = this.o.events.eventsSince(confirmed, this.batchLimit)
    const batch: OrderEvent[] = []
    let bytes = 0
    for (const e of events) {
      bytes += encoder.encode(JSON.stringify(e)).length + 1
      if (batch.length > 0 && bytes > this.maxBatchBytes) break
      batch.push(e)
    }
    return batch
  }

  private async call(
    credential: string,
    method: 'GET' | 'POST',
    route: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    this.inFlight = controller
    try {
      let r: Response
      try {
        r = await this.fetch(`${this.o.url}${route}`, {
          method,
          headers: {
            authorization: `Bearer ${credential}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.requestTimeoutMs)]),
        })
      } catch {
        throw new NoAnswer('network')
      }
      if (r.status === 401) throw new Unauthorized()
      if (r.status === 413) throw new TooLarge()
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429)
        throw new Refused(String(r.status))
      const data = await r.json().catch(() => null)
      if (!r.ok || !data || typeof data !== 'object') throw new NoAnswer(String(r.status))
      return data as Record<string, unknown>
    } finally {
      if (this.inFlight === controller) this.inFlight = null
    }
  }
}
