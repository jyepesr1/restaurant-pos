/** Cap on the wait after failed attempts (ADR-008). */
export const MAX_WAIT_MS = 60_000
/** Window in which failures are counted to alert the admin. */
export const ALERT_WINDOW_MS = 10 * 60_000
/** Failures in the window (across the whole hub) that trigger an alert. */
export const FAILURES_FOR_ALERT = 20
/**
 * Consecutive failures from one device (without 10 quiet minutes between them) that trigger an
 * alert: catches someone guessing slowly while respecting the 60 s wait.
 */
export const DEVICE_FAILURES_FOR_ALERT = 15

/** Two errors with no wait (a slipped finger); then 2, 4, 8… s, up to 60 s. */
export const delayAfter = (failures: number) =>
  failures < 3 ? 0 : Math.min(MAX_WAIT_MS, 1000 * 2 ** (failures - 2))

interface Registration {
  failures: number
  until: number
  latest: number
}

/**
 * Growing wait after failed PINs or codes, per whoever is trying (a device, or an IP when
 * redeeming a pairing code). A success does not clear the failures: they are forgotten on their
 * own after 10 minutes without errors. The whole restaurant is never locked: a phone must not be
 * able to lock everyone out in the middle of service. Lives in memory: restarting the hub clears
 * it, but nobody can restart it from a phone.
 */
export class Attempts {
  private readonly entries = new Map<string, Registration>()
  private recentTimes: number[] = []
  private readonly now: () => number
  private readonly onNotify: (alert: string) => void

  constructor(now: () => number = Date.now, onNotify: (alert: string) => void = () => {}) {
    this.now = now
    this.onNotify = onNotify
  }

  /** How long until another attempt is allowed (0 if it already is). */
  waitMs(who: string): number {
    const r = this.entries.get(who)
    return r ? Math.max(0, r.until - this.now()) : 0
  }

  /**
   * Records a failure and returns the remaining wait. With `count: false` it does not add to the
   * hub-wide alert: the same attempt is recorded for the device and for the account, and counts
   * only once. `cap` shortens the wait of that entry (an account's, so nobody locks out someone
   * else).
   */
  failure(
    who: string,
    { count = true, cap = MAX_WAIT_MS }: { count?: boolean; cap?: number } = {},
  ): number {
    const now = this.now()
    const previous = this.entries.get(who)
    // After a window with no failures, start from zero.
    const failures = previous && now - previous.latest < ALERT_WINDOW_MS ? previous.failures + 1 : 1
    const delay = Math.min(cap, delayAfter(failures))
    this.entries.set(who, { failures, until: now + delay, latest: now })
    this.clear(now)

    if (count) this.recentTimes.push(now)
    this.recentTimes = this.recentTimes.filter((t) => now - t < ALERT_WINDOW_MS)
    if (count && this.recentTimes.length === FAILURES_FOR_ALERT)
      this.onNotify(`${FAILURES_FOR_ALERT} PIN o códigos errados en 10 minutos en el restaurante`)
    if (failures === DEVICE_FAILURES_FOR_ALERT)
      this.onNotify(`${failures} PIN o códigos errados seguidos desde ${who}`)
    return delay
  }

  /** So an IP that keeps guessing does not grow memory without limit. */
  private clear(now: number) {
    if (this.entries.size < 1000) return
    for (const [who, r] of this.entries)
      if (now - r.latest >= ALERT_WINDOW_MS) this.entries.delete(who)
  }
}
