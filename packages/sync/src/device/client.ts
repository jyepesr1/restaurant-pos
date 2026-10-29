import {
  type ApplicableEvent,
  type NewEvent,
  newId,
  type OrderEvent,
  type OrderState,
  rebuild,
  validateNewEvent,
} from '@pos/core'
import { ordersOf } from '../hub/hub'
import { BATCH_SIZE, type DeviceMessage, type ErrorCode, type HubMessage } from '../protocol'
import { type DeviceStore, type LocalEvent, withoutAcceptance } from './store'

export interface ClientOptions {
  store: DeviceStore
  /** Sends a message to the hub (over the WebSocket). Only called while connected. */
  send: (message: DeviceMessage) => void
  token: string
  versionApp: string
  /** Device clock, in ms. */
  now?: () => number
  /**
   * The hub replied with an error. With `invalid_token` or `outdated_app` the client stops sending
   * and the app must close the channel and show what to do; with `revoked_token` it keeps
   * delivering what is pending (it goes to quarantine) but no longer receives anything.
   */
  onHubError?: (code: ErrorCode, message: string) => void
  /** Processing a hub message failed (for the diagnostics log). */
  onFailure?: (error: unknown) => void
  /** Something stored may have changed (a new event, a confirmed one…): the screen rereads. */
  onChange?: () => void
}

/**
 * Device side of sync (docs/SYNC.md#flujo-de-una-acción): stores each event as pending, sends it
 * in batches (one at a time), applies what the hub confirms, and catches up by its cursor. Hub
 * messages are processed in order, one by one.
 *
 * Each connection has a number (`generation`): what arrived over a connection that already closed
 * is discarded, and a job left halfway when the connection dropped sends nothing over the new one.
 */
export class SyncClient {
  private readonly store: DeviceStore
  private readonly sendToHub: (message: DeviceMessage) => void
  private readonly token: string
  private readonly versionApp: string
  private readonly now: () => number
  private readonly onHubError: ClientOptions['onHubError']
  private readonly onFailure: ClientOptions['onFailure']
  private readonly onChange: ClientOptions['onChange']

  private connected = false
  private generation = 0
  private inFlightBatch: { id: string; events: string[] } | null = null
  private fetching = false
  /** A `new` with a gap arrived while pulling: when done, pull up to it if still missing. */
  private missingUntil = 0
  private offsetMs = 0
  private queue: Promise<void> = Promise.resolve()
  private nextPosition = 0

  constructor(o: ClientOptions) {
    this.store = o.store
    this.sendToHub = o.send
    this.token = o.token
    this.versionApp = o.versionApp
    this.now = o.now ?? Date.now
    this.onHubError = o.onHubError
    this.onFailure = o.onFailure
    this.onChange = o.onChange
  }

  /**
   * Persist before showing: the event is stored as pending and sent if possible.
   * Recording the same id twice does nothing.
   */
  async record(event: NewEvent): Promise<{ ok: true } | { ok: false; errors: string[] }> {
    const validation = validateNewEvent(event)
    if (!validation.ok) return validation
    await this.queued(async () => {
      if (await this.store.get(validation.event.id)) return
      // If the cursor dropped between the event's creation and now (restored hub), do not promise
      // the hub more than what is known.
      const { until } = await this.store.cursor()
      const base_sequence = Math.min(validation.event.base_sequence, until)
      await this.store.save([
        {
          event: { ...validation.event, base_sequence },
          status: 'pending',
          own: true,
          position: await this.position(),
        },
      ])
      await this.sendBatch(this.generation)
    })
    return { ok: true }
  }

  /** Sequence this device knows: goes as `base_sequence` of new events. */
  async known(): Promise<number> {
    return (await this.store.cursor()).until
  }

  /** Hub time estimated with the offset learned on connect (`hub_estimated_time`). */
  hubEstimatedTime(deviceTimeMs = this.now()): string {
    return new Date(deviceTimeMs + this.offsetMs).toISOString()
  }

  /** Loads what is stored (the clock offset). Best called when the app opens. */
  begin(): Promise<void> {
    return this.queued(async () => {
      this.offsetMs = (await this.store.cursor()).offsetMs ?? this.offsetMs
    })
  }

  onConnect(): Promise<void> {
    const generation = this.newGeneration()
    this.connected = true
    return this.queued(async () => {
      const cursor = await this.store.cursor()
      if (generation !== this.generation) return
      this.send({
        type: 'hello',
        token: this.token,
        hub_instance: cursor.instance,
        until: cursor.until,
        version_app: this.versionApp,
      })
    })
  }

  onDisconnect(): void {
    this.newGeneration()
    this.connected = false
  }

  /** Processes a hub message in order. Never rejects: failures go to `onFailure`. */
  receive(message: HubMessage): Promise<void> {
    const generation = this.generation
    // A heartbeat or a pong changes nothing stored: the screen has no reason to reread.
    const writes = !['heartbeat', 'pong', 'catalog', 'printers'].includes(message.type)
    return this.queued(async () => {
      if (generation === this.generation) await this.processEvent(message, generation)
    }, writes).catch((error) => this.onFailure?.(error))
  }

  /** State of an order: confirmed events by sequence and, on top, its own pending ones. */
  async order(id: string): Promise<OrderState | null> {
    const live = (await this.store.ofOrder(id)).filter(
      (l) => l.status === 'confirmed' || l.status === 'pending',
    )
    return rebuild(
      live.map((l) => l.event),
      id,
    )
  }

  async pendingList(): Promise<number> {
    return (await this.store.ownPending()).length
  }

  async locals(): Promise<LocalEvent[]> {
    return this.store.listAll()
  }

  /** Waits until in-flight messages are processed. */
  async ready(): Promise<void> {
    await this.queue
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Queues a job. The queue goes on even if one fails; the failure reaches whoever queued it. When
   * done it calls `onChange`, unless the job cannot have changed anything stored.
   */
  private queued(job: () => Promise<void>, notify = true): Promise<void> {
    const result = this.queue.then(job).finally(() => {
      if (notify) this.onChange?.()
    })
    this.queue = result.catch(() => {})
    return result
  }

  private newGeneration() {
    this.generation += 1
    this.inFlightBatch = null
    this.fetching = false
    this.missingUntil = 0
    return this.generation
  }

  private async position(): Promise<number> {
    if (this.nextPosition === 0) {
      const all = await this.store.listAll()
      this.nextPosition = (all.at(-1)?.position ?? 0) + 1
    }
    return this.nextPosition++
  }

  private send(message: DeviceMessage) {
    if (this.connected) this.sendToHub(message)
  }

  private async processEvent(m: HubMessage, generation: number): Promise<void> {
    switch (m.type) {
      case 'welcome': {
        const cursor = await this.store.cursor()
        const restored =
          (cursor.instance !== null && cursor.instance !== m.hub_instance) ||
          cursor.until > m.max_sequence
        if (restored) await this.resendAll()
        const offset = Date.parse(m.hub_time) - this.now()
        if (Number.isFinite(offset)) this.offsetMs = offset
        const fresh = {
          instance: m.hub_instance,
          until: restored ? 0 : cursor.until,
          offsetMs: this.offsetMs,
        }
        await this.store.saveCursor(fresh)
        if (generation !== this.generation) return
        this.pull(fresh.until)
        await this.sendBatch(generation)
        return
      }

      case 'events': {
        await this.incorporate(m.events, generation)
        const cursor = await this.store.cursor()
        const until = Math.max(cursor.until, m.until)
        await this.store.saveCursor({ ...cursor, until })
        if (generation !== this.generation) return
        this.fetching = false
        if (m.has_more || this.missingUntil > until) this.pull(until)
        return
      }

      case 'new': {
        const cursor = await this.store.cursor()
        if (m.until <= cursor.until) return
        if (m.previous_until !== cursor.until) {
          // Gap: something is missing between the cursor and this event. Do not advance; pull what
          // is missing.
          this.missingUntil = Math.max(this.missingUntil, m.until)
          this.pull(cursor.until)
          return
        }
        await this.incorporate([m.event], generation)
        await this.store.saveCursor({ ...cursor, until: m.until })
        return
      }

      case 'result': {
        if (!this.inFlightBatch || this.inFlightBatch.id !== m.batch_id) return
        const rejectedList: string[] = []
        for (const r of m.results) {
          const local = await this.store.get(r.id)
          if (!local) continue
          if (r.status === 'confirmed') {
            await this.store.save([
              {
                ...local,
                status: 'confirmed',
                event: { ...local.event, ...r.acceptance },
                conflict: r.conflict,
              },
            ])
            continue
          }
          // What the hub already confirmed (arrived via `events` or `new`) is not undone.
          if (local.status === 'confirmed') continue
          if (r.status === 'rejected') {
            await this.store.save([{ ...local, status: 'rejected', reason: r.reason }])
            rejectedList.push(r.id)
          } else {
            await this.store.save([{ ...local, status: 'quarantine' }])
          }
        }
        if (rejectedList.length > 0) await this.rejectDependents(rejectedList)
        if (generation !== this.generation) return
        this.inFlightBatch = null
        await this.sendBatch(generation)
        return
      }

      case 'error':
        if (m.code === 'invalid_token' || m.code === 'outdated_app') this.onDisconnect()
        this.onHubError?.(m.code, m.message)
        return

      // The app handles these (the catalog is fetched over HTTP); here they change nothing stored.
      case 'pong':
      case 'heartbeat':
      case 'catalog':
      case 'printers':
        return
    }
  }

  /**
   * Stores confirmed events from the hub. The hub's copy wins: it replaces the own one (pending or
   * already confirmed, which may differ in `base_sequence` after a resend to a restored hub).
   */
  private async incorporate(events: readonly OrderEvent[], generation: number) {
    const newer: LocalEvent[] = []
    for (const event of events) {
      const local = await this.store.get(event.id)
      newer.push(
        local
          ? { ...local, event: { ...local.event, ...event }, status: 'confirmed' }
          : { event, status: 'confirmed', own: false, position: await this.position() },
      )
    }
    await this.store.save(newer)
    // If the batch response was lost but its events already came back confirmed, move on.
    const batch = this.inFlightBatch
    if (batch && generation === this.generation) {
      const inFlight = await Promise.all(batch.events.map((id) => this.store.get(id)))
      if (this.inFlightBatch === batch && inFlight.every((l) => l?.status === 'confirmed')) {
        this.inFlightBatch = null
        await this.sendBatch(generation)
      }
    }
  }

  /**
   * A rejection drags along the own pending events that touch the same orders: they depend on it
   * (docs/SYNC.md#rechazos-cuarentena-y-conflictos).
   */
  private async rejectDependents(rejectedList: readonly string[]) {
    const all = await this.store.listAll()
    const affected = new Set(
      all.filter((l) => rejectedList.includes(l.event.id)).flatMap((l) => ordersOf(l.event)),
    )
    const dependents = all.filter(
      (l) => l.own && l.status === 'pending' && ordersOf(l.event).some((p) => affected.has(p)),
    )
    await this.store.save(
      dependents.map((l) => ({
        ...l,
        status: 'rejected' as const,
        reason: 'depends_on_rejected',
      })),
    )
  }

  /**
   * The hub was restored from a backup or reinstalled: all own events are resent and other
   * devices' events are forgotten; they come back with the cursor at 0. The restored hub does not
   * know what was there, so the device was not "up to date": `base_sequence` drops to 0. The hub
   * fingerprint does not include it, so what the backup already had is recognized as the same
   * event.
   */
  private async resendAll() {
    const all = await this.store.listAll()
    await this.store.erase(all.filter((l) => !l.own).map((l) => l.event.id))
    await this.store.save(
      all
        .filter((l) => l.own && (l.status === 'confirmed' || l.status === 'pending'))
        .map((l) => ({
          ...l,
          status: 'pending' as const,
          event: { ...withoutAcceptance(l.event), base_sequence: 0 },
        })),
    )
  }

  private pull(from: number) {
    if (this.fetching) return
    this.fetching = true
    this.send({ type: 'pull', from })
  }

  private async sendBatch(generation: number) {
    if (!this.connected || this.inFlightBatch || generation !== this.generation) return
    const pendingList = await this.store.ownPending(BATCH_SIZE)
    // While reading, the connection may have dropped, or another batch may have gone out.
    if (!this.connected || this.inFlightBatch || generation !== this.generation) return
    if (pendingList.length === 0) return
    this.inFlightBatch = { id: newId(), events: pendingList.map((l) => l.event.id) }
    this.send({
      type: 'push',
      batch_id: this.inFlightBatch.id,
      events: pendingList.map((l) => withoutAcceptance(l.event as ApplicableEvent)),
    })
  }
}
