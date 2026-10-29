import type { DeviceMessage, HubMessage } from '../protocol'

/** Timings from docs/SYNC.md#conexión-aprendido-en-celulares-reales, measured in ADR-001. */
export const TIMINGS = {
  maxOpenMs: 4000,
  checkOnReturnMs: 3000,
  noResponseMs: 15_000,
  watchdogMs: 1000,
  maxWaitMs: 5000,
  /** The first close within this window after returning to the screen is retried at once. */
  windowAfterReturnMs: 5000,
}

/** An open channel with the hub (a WebSocket in the browser). */
export interface Channel {
  send(message: DeviceMessage): void
  close(): void
}

export interface Handlers {
  onOpen(): void
  onMessage(message: HubMessage): void
  onClose(): void
}

export interface TimerFns {
  now(): number
  setTimeout(job: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
  setInterval(job: () => void, ms: number): unknown
  clearInterval(id: unknown): void
}

const globalTimers: TimerFns = {
  now: () => Date.now(),
  setTimeout: (t, ms) => setTimeout(t, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (t, ms) => setInterval(t, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
}

export type ConnectionState = 'connecting' | 'connected' | 'no_response' | 'disconnected'

export interface ManagerOptions {
  /** Opens a new channel; the handlers are called as each thing happens. */
  open(handlers: Handlers): Channel
  onConnect(channel: Channel): void
  onDisconnect(): void
  onMessage(message: HubMessage): void
  onStateChange?(status: ConnectionState): void
  timerFns?: TimerFns
}

/**
 * Keeps the channel with the hub: reconnects on its own, abandons hung attempts, discards silent
 * channels and, on returning to the screen, catches up at once (docs/SYNC.md). The screen locks
 * often and the connection is always lost (ADR-001): this is normal, not an error.
 */
export class ConnectionManager {
  private readonly o: ManagerOptions
  private readonly t: TimerFns
  private channel: Channel | null = null
  private opened = false
  private active = false
  private visible = true
  private attempts = 0
  private lastMessageAt = 0
  /** On returning to the screen, the first retry goes out without waiting; later ones do not. */
  private immediateRetry = false
  private returnedAt = 0
  /** Identifies the attempt in progress: an old channel that reports late is ignored. */
  private attempt: object | null = null
  private retry: unknown = null
  private openTimeout: unknown = null
  private pendingCheck: unknown = null
  private watchdog: unknown = null

  constructor(options: ManagerOptions) {
    this.o = options
    this.t = options.timerFns ?? globalTimers
  }

  begin() {
    if (this.active) return
    this.active = true
    this.watchdog = this.t.setInterval(() => this.watch(), TIMINGS.watchdogMs)
    this.connect()
  }

  stop() {
    if (!this.active) return
    this.active = false
    this.t.clearInterval(this.watchdog)
    this.t.clearTimeout(this.retry)
    this.t.clearTimeout(this.openTimeout)
    this.t.clearTimeout(this.pendingCheck)
    this.release()
    this.patch('disconnected')
  }

  /** The screen was hidden (lock, another app) or came back. */
  changeVisibility(visible: boolean) {
    this.visible = visible
    if (!visible || !this.active) return
    this.immediateRetry = true
    this.returnedAt = this.t.now()
    // After sleeping, the watchdog must not kill the connection before messages arrive.
    this.lastMessageAt = this.t.now()
    if (!this.opened) {
      this.reconnectNow()
      return
    }
    // Looks open: check with a ping that it responds soon.
    const channel = this.channel
    channel?.send({ type: 'ping', stamp: String(this.t.now()) })
    const from = this.lastMessageAt
    this.t.clearTimeout(this.pendingCheck)
    this.pendingCheck = this.t.setTimeout(() => {
      if (this.channel === channel && this.opened && this.lastMessageAt <= from)
        this.discard('no_response')
    }, TIMINGS.checkOnReturnMs)
  }

  private connect() {
    if (!this.active) return
    this.patch('connecting')
    const attempt = {}
    this.attempt = attempt
    const isThis = () => this.attempt === attempt
    // If `open` reports something before returning the channel, it is handled as soon as the
    // channel is returned.
    let queued: (() => void)[] | null = []
    const when = (job: () => void) => (queued ? queued.push(job) : job())
    const channel = this.o.open({
      onOpen: () =>
        when(() => {
          if (!isThis() || this.opened) return
          this.t.clearTimeout(this.openTimeout)
          this.opened = true
          this.attempts = 0
          this.lastMessageAt = this.t.now()
          this.patch('connected')
          this.o.onConnect(channel)
        }),
      onMessage: (message) =>
        when(() => {
          if (!isThis()) return
          this.lastMessageAt = this.t.now()
          this.o.onMessage(message)
        }),
      onClose: () =>
        when(() => {
          if (isThis()) this.onLose('disconnected')
        }),
    })
    this.channel = channel
    this.openTimeout = this.t.setTimeout(() => {
      if (isThis() && !this.opened) this.discard('disconnected')
    }, TIMINGS.maxOpenMs)
    const alerts = queued
    queued = null
    for (const job of alerts) job()
  }

  private watch() {
    if (!this.visible || !this.opened) return
    if (this.t.now() - this.lastMessageAt >= TIMINGS.noResponseMs) this.discard('no_response')
  }

  /** Drops the current channel without waiting for the browser to close it; schedules another. */
  private discard(status: ConnectionState) {
    this.release()
    this.onLose(status)
  }

  private onLose(status: ConnectionState) {
    const wasOpen = this.opened
    this.opened = false
    this.channel = null
    this.attempt = null
    this.t.clearTimeout(this.openTimeout)
    if (wasOpen) this.o.onDisconnect()
    this.patch(status)
    if (!this.active) return
    const immediate =
      this.immediateRetry &&
      this.visible &&
      this.t.now() - this.returnedAt < TIMINGS.windowAfterReturnMs
    this.immediateRetry = false
    this.attempts += 1
    const delay = immediate ? 0 : Math.min(1000 * this.attempts, TIMINGS.maxWaitMs)
    this.t.clearTimeout(this.retry)
    this.retry = this.t.setTimeout(() => this.connect(), delay)
  }

  private reconnectNow() {
    this.t.clearTimeout(this.retry)
    this.attempts = 0
    this.immediateRetry = false
    this.release()
    this.connect()
  }

  private release() {
    const channel = this.channel
    this.channel = null
    this.attempt = null
    if (this.opened) {
      this.opened = false
      this.o.onDisconnect()
    }
    channel?.close()
  }

  private patch(status: ConnectionState) {
    this.o.onStateChange?.(status)
  }
}
