import type { Row, SqliteDatabase } from '@pos/db'
import {
  COLUMNS,
  type CodePage,
  escpos,
  type PreBill,
  preBillLines,
  type Ticket,
  testLines,
  ticketLines,
  type ZReport,
  zReportLines,
} from '@pos/printing'
import type { PrinterStatus } from '@pos/sync'
import { type Send, sendOverNetwork } from './transport'

// The hub's print queue (ADR-015). Jobs live in `print_jobs` and survive a restart. Each
// printer prints its own in order, one at a time. If it fails, it retries with a growing wait up
// to 30 s, without giving up; after 3 failures in a row its tickets go to the fallback printer,
// if it has one. Every device sees what happens with each printer.

/** Failures in a row after which tickets go to the fallback printer. */
export const FAILURES_FOR_FALLBACK = 3
const MAX_WAIT_MS = 30_000
/** A test page that did not print within this time is no longer awaited: it is discarded. */
export const TEST_TTL_MS = 5 * 60_000

export interface PrintTest {
  printer: string
  stations: string[]
  time: string
}

interface State {
  consecutiveFailures: number
  error: string | null
  /** No retry before this time (ms). */
  retryAt: number
}

export interface QueueOptions {
  db: SqliteDatabase
  restaurantId: string
  send?: Send
  clock?: () => number
  /** The status of some printer changed (to alert the devices). */
  onChange?: (statuses: PrinterStatus[]) => void
  /** A pass failed because of the hub, not the printer (for the log). */
  onFailure?: (error: unknown) => void
}

export class PrintQueue {
  private readonly o: Required<Omit<QueueOptions, 'onChange' | 'onFailure'>> &
    Pick<QueueOptions, 'onChange' | 'onFailure'>
  private readonly statuses = new Map<string, State>()
  private running: Promise<void> | null = null
  private anotherPass = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private lastAlert = ''
  /** When building a ticket failed (it never reached the queue): devices are alerted a while. */
  private unbuiltSince: number | null = null

  constructor(o: QueueOptions) {
    this.o = { send: sendOverNetwork, clock: Date.now, ...o }
  }

  /** There is new work (or a printer changed): print whatever can be printed now. */
  wake(): void {
    if (this.stopped) return
    if (this.running) {
      this.anotherPass = true
      return
    }
    this.running = this.runOnce()
      .catch((error) => this.o.onFailure?.(error))
      .finally(() => {
        this.running = null
        if (this.anotherPass) {
          this.anotherPass = false
          this.wake()
        } else this.schedule()
      })
  }

  /** Waits for the current pass to finish (for tests and when closing the hub). */
  async ready(): Promise<void> {
    while (this.running) await this.running
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  /**
   * A send was accepted but its ticket could not be built (a hub error): nobody is going to
   * print it. All devices see it for 15 minutes, so it can be reprinted from «Pedidos en
   * cocina».
   */
  unbuiltTicket(): void {
    this.unbuiltSince = this.o.clock()
    this.notify()
  }

  /** The status of each active printer, with its pending tickets. */
  status(): PrinterStatus[] {
    const unbuilt: PrinterStatus[] =
      this.unbuiltSince !== null && this.o.clock() - this.unbuiltSince < 15 * 60_000
        ? [
            {
              id: 'tickets',
              name: 'Una comanda',
              status: 'failed',
              error:
                'No se pudo armar una comanda y no salió: reimprímela desde «Pedidos en cocina».',
              pendingList: 0,
            },
          ]
        : []
    return [...this.printerStatuses(), ...unbuilt]
  }

  private printerStatuses(): PrinterStatus[] {
    const pendingList = new Map(
      this.o.db
        .prepare(
          `SELECT printer_id, count(*) AS n FROM print_jobs
           WHERE restaurant_id = ? AND status = 'pending' GROUP BY printer_id`,
        )
        .all(this.o.restaurantId)
        .map((f) => [String(f.printer_id), Number(f.n)]),
    )
    return this.printers()
      .filter((i) => i.active === 1)
      .map((i) => {
        const id = String(i.id)
        const e = this.statuses.get(id)
        return {
          id,
          name: String(i.name),
          status: e && e.consecutiveFailures > 0 ? 'failed' : 'ready',
          error: e?.consecutiveFailures ? e.error : null,
          pendingList: pendingList.get(id) ?? 0,
        }
      })
  }

  /** One pass over the pending jobs: each printer prints its own, in order. */
  async runOnce(): Promise<void> {
    const printers = new Map(this.printers().map((i) => [String(i.id), i]))
    // In the order they arrived (rowid), not by time: if the PC clock is corrected backward, a
    // void must not print before its ticket.
    const jobs = this.o.db
      .prepare(
        `SELECT * FROM print_jobs WHERE restaurant_id = ? AND status = 'pending'
         ORDER BY rowid`,
      )
      .all(this.o.restaurantId)

    // Which printer prints each job in this pass: its own, or its fallback if its own fails.
    const byTarget = new Map<string, Row[]>()
    const now = this.o.clock()
    // A down printer is retried with one job when its wait expires: if it responds, it prints
    // its own again; if not, the rest keeps going through the fallback.
    const tried = new Set<string>()
    for (const t of jobs) {
      if (t.type === 'test' && now - Date.parse(String(t.created_at)) > TEST_TTL_MS) {
        this.finish(t, 'discarded', String(t.printer_id), 'La prueba no salió en 5 minutos')
        continue
      }
      const target = this.target(String(t.printer_id), printers, now, t.type === 'test', tried)
      if (!target) continue
      byTarget.set(target, [...(byTarget.get(target) ?? []), t])
    }

    await Promise.all(
      [...byTarget].map(async ([targetId, list]) => {
        const printer = printers.get(targetId) as Row
        for (const t of list) {
          const ok = await this.print(t, printer)
          if (!ok) break
        }
      }),
    )
    this.notify()
  }

  // ── Internals ────────────────────────────────────────────────────────

  private printers(): Row[] {
    return this.o.db
      .prepare('SELECT * FROM printers WHERE restaurant_id = ? ORDER BY created_at, id')
      .all(this.o.restaurantId)
  }

  /**
   * The printer that prints a job of `printerId` now, or none if it must wait. An archived one,
   * or one with 3 failures in a row, passes its jobs to the fallback if it has one and it is
   * active.
   */
  private target(
    printerId: string,
    printers: Map<string, Row>,
    now: number,
    isTest: boolean,
    tried: Set<string>,
  ) {
    const ownItem = printers.get(printerId)
    if (!ownItem) return null
    const status = this.statuses.get(printerId)
    const isDown =
      ownItem.active !== 1 || (status?.consecutiveFailures ?? 0) >= FAILURES_FOR_FALLBACK
    // The test belongs to that printer: it never prints on another.
    if (isTest) return ownItem.active === 1 && this.canRetry(printerId, now) ? printerId : null
    if (isDown && ownItem.active === 1 && this.canRetry(printerId, now)) {
      // While it is being tried, the rest waits this pass: if it responds, it prints on its own.
      if (tried.has(printerId)) return null
      tried.add(printerId)
      return printerId
    }
    if (isDown && ownItem.fallback_id) {
      const fallback = printers.get(String(ownItem.fallback_id))
      if (fallback?.active === 1 && this.canRetry(String(fallback.id), now))
        return String(fallback.id)
    }
    if (ownItem.active !== 1) {
      const reason =
        'La impresora está archivada y no tiene respaldo: descarta la comanda o reimprímela en otra.'
      this.failure(printerId, reason, false)
      // So the register sees in the pending list why it does not print.
      this.o.db
        .prepare(
          `UPDATE print_jobs SET last_error = ? WHERE restaurant_id = ? AND printer_id = ?
           AND status = 'pending' AND last_error IS NOT ?`,
        )
        .run(reason, this.o.restaurantId, printerId, reason)
      return null
    }
    if (isDown) return null
    return this.canRetry(printerId, now) ? printerId : null
  }

  private canRetry(id: string, now: number) {
    return (this.statuses.get(id)?.retryAt ?? 0) <= now
  }

  private async print(job: Row, printer: Row): Promise<boolean> {
    const id = String(printer.id)
    let bytes: Uint8Array
    try {
      bytes = this.bytes(job, printer)
    } catch {
      // Content that cannot be understood must not hold up the jobs behind it.
      this.finish(job, 'discarded', id, 'No se pudo armar la comanda')
      return true
    }
    try {
      await this.o.send(
        {
          connection: printer.connection === 'usb' ? 'usb' : 'network',
          address: String(printer.address),
          port: printer.port === null ? null : Number(printer.port),
        },
        bytes,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.o.db
        .prepare(
          'UPDATE print_jobs SET attempts = attempts + 1, last_error = ? WHERE restaurant_id = ? AND id = ?',
        )
        .run(message, this.o.restaurantId, String(job.id))
      this.failure(id, message)
      return false
    }
    this.finish(job, 'printed', id, null)
    this.statuses.set(id, { consecutiveFailures: 0, error: null, retryAt: 0 })
    return true
  }

  private finish(
    job: Row,
    status: 'printed' | 'discarded',
    printerId: string,
    error: string | null,
  ) {
    if (status === 'printed')
      this.o.db
        .prepare(
          `UPDATE print_jobs SET status = 'printed', attempts = attempts + 1, finished_at = ?,
             printed_on_id = ? WHERE restaurant_id = ? AND id = ? AND status = 'pending'`,
        )
        .run(new Date(this.o.clock()).toISOString(), printerId, this.o.restaurantId, String(job.id))
    else
      this.o.db
        .prepare(
          `UPDATE print_jobs SET status = 'discarded', finished_at = ?, last_error = ?
           WHERE restaurant_id = ? AND id = ? AND status = 'pending'`,
        )
        .run(new Date(this.o.clock()).toISOString(), error, this.o.restaurantId, String(job.id))
  }

  private failure(id: string, error: string, count = true) {
    const previous = this.statuses.get(id)
    const failures = (previous?.consecutiveFailures ?? 0) + (count ? 1 : 0)
    const delay = Math.min(MAX_WAIT_MS, 1000 * 2 ** Math.max(0, failures - 1))
    this.statuses.set(id, {
      consecutiveFailures: Math.max(failures, 1),
      error,
      // Archived with no fallback: nothing to try; the pass does not repeat right away for it.
      retryAt: this.o.clock() + (count ? delay : MAX_WAIT_MS),
    })
  }

  private bytes(job: Row, printer: Row): Uint8Array {
    const width = Number(printer.width) === 58 ? 58 : 80
    const format = {
      columns: COLUMNS[width],
      page: String(printer.code_page) as CodePage,
    }
    const content = JSON.parse(String(job.content))
    const lines =
      job.type === 'test'
        ? testLines(content as PrintTest, format)
        : job.type === 'preBill'
          ? preBillLines(content as PreBill, format)
          : job.type === 'report'
            ? zReportLines(content as ZReport, format)
            : ticketLines(content as Ticket, format)
    return escpos(lines, format)
  }

  /** The next pass: when the shortest wait of a printer with work expires. */
  private schedule() {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const pendingList = this.o.db
      .prepare(
        "SELECT DISTINCT printer_id FROM print_jobs WHERE restaurant_id = ? AND status = 'pending'",
      )
      .all(this.o.restaurantId)
    if (pendingList.length === 0) return
    const now = this.o.clock()
    const printers = new Map(this.printers().map((i) => [String(i.id), i]))
    // Jobs of a down printer with a fallback print when the fallback can, not when it is time to
    // retry the down one.
    const when = (id: string) => {
      const ownItem = this.statuses.get(id)?.retryAt ?? now
      const row = printers.get(id)
      const isDown =
        row?.active !== 1 ||
        (this.statuses.get(id)?.consecutiveFailures ?? 0) >= FAILURES_FOR_FALLBACK
      const fallback = row?.fallback_id ? printers.get(String(row.fallback_id)) : undefined
      if (!isDown || fallback?.active !== 1) return ownItem
      return Math.min(ownItem, this.statuses.get(String(fallback.id))?.retryAt ?? now)
    }
    const delay = Math.max(
      250,
      Math.min(...pendingList.map((f) => when(String(f.printer_id)) - now), MAX_WAIT_MS),
    )
    this.timer = setTimeout(() => this.wake(), delay)
    this.timer.unref?.()
  }

  private notify() {
    const statuses = this.status()
    const alert = JSON.stringify(statuses)
    if (alert === this.lastAlert) return
    this.lastAlert = alert
    this.o.onChange?.(statuses)
  }
}
