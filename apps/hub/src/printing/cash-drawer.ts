import { fullConfig, type OrderEvent } from '@pos/core'
import type { SqliteDatabase } from '@pos/db'
import { drawerPulse } from '@pos/printing'
import { PrinterError } from './printer-error'
import { type Send, sendToPrinter, type Target } from './transport'

// The cash drawer (task 1.13): it is wired to a printer (the RJ11 port on its back) and opens with
// a pulse sent to that printer. The hub opens it on its own when cash goes in or out: a cash
// payment, a cash refund or a cash movement. The pulse is not a print job: it is not stored in
// `print_jobs` (a drawer that opens hours later, when the printer comes back, is worse than one
// that does not open) and it gets one attempt plus one retry. Over USB it goes "now or never":
// Windows would keep it queued while the printer is off and open the drawer when it comes back.

/** An event created longer ago than this (resent after being offline) does not open the drawer. */
export const STALE_MS = 2 * 60_000
/** The wait before the only retry: the printer may be busy printing the pre-bill. */
export const RETRY_MS = 1500

/**
 * Whether the hub opens the drawer for this event it just saved: cash moved, the hub applied it
 * (not saved as a conflict, task 1.7b) and it was created just now (by its `hub_estimated_time`).
 */
export function opensDrawer(event: OrderEvent, now: number): boolean {
  if (event.unapplied) return false
  const cash =
    (event.type === 'PaymentRecorded' && event.data.method === 'cash') ||
    (event.type === 'RefundRecorded' && event.data.method === 'cash') ||
    event.type === 'CashMovementRecorded'
  if (!cash) return false
  const created = Date.parse(event.hub_estimated_time)
  return Number.isFinite(created) && now - created <= STALE_MS
}

export interface CashDrawerOptions {
  db: SqliteDatabase
  restaurantId: string
  /** The same as the print queue's: over the network or through Windows. */
  send?: Send
  clock?: () => number
  retryMs?: number
  /** It did not open after the retry, or the hub failed (for the log). */
  onFailure?: (error: unknown) => void
}

export class CashDrawer {
  private readonly o: Required<Omit<CashDrawerOptions, 'onFailure'>> &
    Pick<CashDrawerOptions, 'onFailure'>
  private readonly running = new Set<Promise<void>>()

  constructor(o: CashDrawerOptions) {
    this.o = { send: sendToPrinter, clock: Date.now, retryMs: RETRY_MS, ...o }
  }

  /**
   * After the hub saved an event (outside its transaction): opens the drawer if cash moved just
   * now. Never throws: a drawer that does not open must not hold up the register.
   */
  afterSave(event: OrderEvent): void {
    let target: Target | null
    try {
      if (!opensDrawer(event, this.o.clock()) || !this.saved(event.id)) return
      target = this.target()
    } catch (error) {
      this.o.onFailure?.(error)
      return
    }
    if (!target) return
    const kick = this.kickWithRetry(target)
    this.running.add(kick)
    kick.finally(() => this.running.delete(kick))
  }

  /** Whether there is a drawer: its printer chosen and still active. */
  connected(): boolean {
    return this.target() !== null
  }

  /** Opens it now (the «Probar el cajón» button): fails with `PrinterError`, without retrying. */
  async open(): Promise<void> {
    const target = this.target()
    if (!target)
      throw new PrinterError('Elige primero a qué impresora está conectado el cajón monedero.')
    await this.o.send(target, drawerPulse())
  }

  /** Waits for the openings in progress (for tests and when closing the hub). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running)
  }

  /** The money moved only if the event is stored: a rolled-back save does not open the drawer. */
  private saved(eventId: string): boolean {
    return !!this.o.db
      .prepare('SELECT 1 FROM events WHERE restaurant_id = ? AND id = ?')
      .get(this.o.restaurantId, eventId)
  }

  /** The chosen printer, if it is still active; otherwise there is no drawer. */
  private target(): Target | null {
    const row = this.o.db
      .prepare('SELECT config FROM restaurants WHERE id = ?')
      .get(this.o.restaurantId)
    const id = fullConfig(JSON.parse(String(row?.config ?? '{}'))).cash_drawer_printer_id
    if (!id) return null
    const printer = this.o.db
      .prepare(
        'SELECT connection, address, port FROM printers WHERE restaurant_id = ? AND id = ? AND active = 1',
      )
      .get(this.o.restaurantId, id)
    if (!printer) return null
    return {
      connection: printer.connection === 'usb' ? 'usb' : 'network',
      address: String(printer.address),
      port: printer.port === null ? null : Number(printer.port),
      nowOrNever: true,
    }
  }

  private async kickWithRetry(target: Target): Promise<void> {
    try {
      await this.o.send(target, drawerPulse())
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, this.o.retryMs))
    }
    try {
      await this.o.send(target, drawerPulse())
    } catch (error) {
      this.o.onFailure?.(error)
    }
  }
}
