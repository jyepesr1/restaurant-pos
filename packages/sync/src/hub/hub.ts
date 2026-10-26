import {
  applyEvent,
  businessDay,
  fullConfig,
  type IssueType,
  type NewEvent,
  newId,
  type OrderEvent,
  type OrderState,
  otherMethodsReconciliation,
  rebuild,
  type ShiftReconciliation,
  shiftReconciliation,
  validateNewEvent,
} from '@pos/core'
import { eventFingerprint } from '../fingerprint'
import { type DeviceType, type EventResult, type HubMessage, PAGE_SIZE } from '../protocol'
import {
  type ReportData,
  reportData,
  type ShiftClose,
  savedReconciliation,
  shiftClose,
} from './report'
import type { ConflictType, HubStore } from './store'

export interface ConfigHub {
  restaurantId: string
  timeZone: string
  businessDayStart: string
  /**
   * Changes when the hub is reinstalled or restored; stored outside the database
   * (docs/SYNC.md#fallas-y-qué-pasa).
   */
  instance: string
  clock: () => string
  /** Sessions, permissions and supervisor approvals (docs/SYNC.md#seguridad). */
  access: AccessControl
  /** An event made the hub fail and was rejected as `internal_error`: for the log. */
  onInternalError?: (error: unknown, eventId: string) => void
  /**
   * Compares what an item copied (price, extras, tax) with the catalog at its
   * `catalog_version` (docs/DINERO.md#precio-copiado). Without it, nothing is checked.
   */
  prices?: PriceChecker
  /**
   * Runs inside the event's transaction, once it is saved: whatever it writes is kept or lost with
   * it (the print jobs for the tickets, ADR-015). It receives each order the event touches, before
   * and after applying it. If it fails, the event is still accepted and the failure goes to
   * `onSaveFailure`: a misconfigured printer cannot hold up orders.
   */
  onSave?: (event: OrderEvent, orders: OrderChange[]) => void
  onSaveFailure?: (error: unknown, eventId: string) => void
  /**
   * The restaurant's current checkout rules (task 1.6): a cash payment carries its rounding
   * rule (docs/DINERO.md#pagos), the method is enabled and the card names an active
   * card terminal. Without them, nothing is checked.
   */
  checkoutRules?: () => {
    multiple: number
    mode: string
    methods: readonly string[]
    /** The restaurant's active custom methods. */
    customMethods?: readonly string[]
    cardTerminals: readonly string[]
    /** Variance from which the register close asks for a justification (task 1.7). */
    varianceThreshold?: number
  }
}

/** An open register shift (tasks 1.6 and 1.7): closed with `ShiftClosed`. */
export interface RegisterShift {
  id: string
  /** The register device where it was opened (for now each register is one device). */
  registerId: string
  base: number
  openedAt: string
  userId: string
}

export interface OrderChange {
  before: OrderState | null
  after: OrderState | null
}

/** Returns what does not match the catalog, or `null` if everything matches. */
export interface PriceChecker {
  review(event: NewEvent): string | null
}

/** What the hub knows about a connection's device (given by its token). */
export interface Connection {
  deviceId: string
  type: DeviceType
  /** If the device was revoked, when. */
  revokedAt: string | null
}

export type AccessVerdict =
  | { ok: true; authorizedById: string | null; authorizationId: string | null }
  | { ok: false; reason: string; quarantine?: boolean }

/**
 * Who can create each event. The hub does not trust the user the event claims: it compares it
 * with the session, which must belong to that device and be open at the event's time. The
 * permission is checked against the role on receipt; without it, a supervisor approval is valid.
 */
export interface AccessControl {
  /** `order`: the order's state before the event (some permissions depend on it). */
  verify(connection: Connection, event: NewEvent, order: OrderState | null): AccessVerdict
  /** The event was saved: runs in the same transaction (uses the approval and the session). */
  recordUse(event: NewEvent, verdict: Extract<AccessVerdict, { ok: true }>): void
}

/** Window in which the device's estimated time is accepted for the business day. */
const BEFORE_MAX_MS = 12 * 60 * 60 * 1000
const AFTER_MAX_MS = 60 * 1000

/** A real event takes a few hundred bytes; more than this is a bug or abuse. */
const MAX_CONTENT = 64 * 1024
/** Quarantined events per device: more than this is rejected. */
const MAX_QUARANTINE = 500

/**
 * Reducer issues that, if the device was not up to date, are a conflict (accepted and flagged
 * at the register) rather than a rejection (docs/SYNC.md#rechazos-cuarentena-y-conflictos).
 */
const CONFLICTS: Partial<Record<IssueType, ConflictType>> = {
  item_not_found: 'item_not_found',
  item_already_sent: 'item_already_sent',
  invalid_item_status: 'item_already_sent',
  item_already_voided: 'item_already_voided',
  // Removing more than what is left: another device already removed part of it.
  invalid_quantity: 'item_already_voided',
  order_closed: 'order_closed',
}

/**
 * Whether an open order occupies that table: its own or one merged into it (task 1.5). One that
 * moved all its products to another table, or had all of them voided, no longer occupies it; one
 * just opened, or one where the waiter removed what had not been sent yet, does.
 */
const occupies = (p: OrderState, tableId: string) =>
  p.status === 'open' &&
  (p.tableId === tableId || p.mergedTables.includes(tableId)) &&
  (Object.values(p.items).some((i) => i.status !== 'voided') ||
    (Object.keys(p.items).length === 0 && !p.emptiedOnMove))

/**
 * The tables an event makes an order occupy that it did not occupy before: on opening, moving or
 * merging, but also on reopening a check or adding to an emptied order.
 */
function tablesItTakes(before: OrderState | null, after: OrderState | null): string[] {
  if (!after || after.tableId === null) return []
  return [after.tableId, ...after.mergedTables].filter(
    (m) => occupies(after, m) && !(before && occupies(before, m)),
  )
}

/** Moving to or merging with an occupied table requires being up to date: done online. */
const ENTRY_ONLINE = new Set(['OrderMovedTable', 'TablesMerged'])

/** The close justification threshold if the restaurant's does not arrive (the default one). */
const REGISTER_VARIANCE_THRESHOLD = fullConfig().register_variance_threshold

/** Moving and merging require a connection with the hub: they are never a conflict. */
const ALWAYS_ONLINE = new Set(['ItemsMoved', 'OrdersMerged'])

/** Orders an event touches: its aggregate, the related ones and those the hub put in `affects`. */
export const ordersOf = (e: {
  aggregate_id: string
  related: readonly string[]
  affects?: readonly string[]
}) => [...new Set([e.aggregate_id, ...e.related, ...(e.affects ?? [])])]

/**
 * Orders named by an event that may be malformed (a format rejection must not sink the
 * batch or the hub).
 */
function aggregatesFromRaw(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return []
  const { aggregate_id, related } = raw as { aggregate_id?: unknown; related?: unknown }
  return [
    ...(typeof aggregate_id === 'string' ? [aggregate_id] : []),
    ...(Array.isArray(related) ? related.filter((r): r is string => typeof r === 'string') : []),
  ]
}

/** What the hub needs from an event before validating it: id, fingerprint and if it is usable. */
interface Identified {
  id: string
  fingerprint: string
  /** What is stored in the rejection (valid JSON). */
  content: string
  /** Whether it is too large or too deeply nested to even validate. */
  issue: string | null
}

function identify(raw: unknown): Identified {
  const candidate = (raw as { id?: unknown } | null)?.id
  const id = typeof candidate === 'string' && candidate.length <= 100 ? candidate : ''
  let content: string
  try {
    content = JSON.stringify(raw) ?? 'null'
  } catch {
    return { id, fingerprint: 'no-fingerprint', content: '"omitted"', issue: 'too_deeply_nested' }
  }
  if (content.length > MAX_CONTENT)
    return { id, fingerprint: 'no-fingerprint', content: '"omitted"', issue: 'too_large' }
  try {
    return { id, fingerprint: eventFingerprint(raw), content, issue: null }
  } catch {
    return { id, fingerprint: 'no-fingerprint', content: '"omitted"', issue: 'too_deeply_nested' }
  }
}

/** Other devices do not receive the session of whoever created the event. */
const forDevice = (event: OrderEvent, deviceId: string | null): OrderEvent =>
  event.device_id === deviceId || event.session_id === null ? event : { ...event, session_id: null }

/**
 * The sync hub: authority over the floor. Validates, numbers and saves each event. Keeps in memory
 * the projection of the open orders (rebuilt from the events at startup); that of a closed order
 * is rebuilt from the database when needed.
 */
export class HubSync {
  /** Only open orders: closed ones are rebuilt from the database. */
  private readonly orders = new Map<string, OrderState>()
  /** Open register shifts, by id. */
  private readonly shifts = new Map<string, RegisterShift>()
  /** The events of each open shift: its opening, payments, movements and counts. */
  private readonly shiftEvents = new Map<string, OrderEvent[]>()
  private readonly store: HubStore
  private readonly config: ConfigHub

  constructor(store: HubStore, config: ConfigHub) {
    this.store = store
    this.config = config
    this.rebuildProjections()
  }

  /**
   * Whether the table has an open order, its own or a merged group's (then it is not archived in
   * the floor plan).
   */
  hasOpenOrder(tableId: string): boolean {
    for (const p of this.orders.values()) if (occupies(p, tableId)) return true
    return false
  }

  /** The open shift of a register, if any. */
  openShift(registerId: string): RegisterShift | null {
    for (const t of this.shifts.values()) if (t.registerId === registerId) return t
    return null
  }

  /** Current projection of an order. */
  order(id: string): OrderState | null {
    return this.orders.get(id) ?? rebuild(this.store.aggregateEvents(id), id)
  }

  welcomeMessage(): Extract<HubMessage, { type: 'welcome' }> {
    return {
      type: 'welcome',
      hub_instance: this.config.instance,
      max_sequence: this.store.maxSequence(),
      hub_time: this.config.clock(),
    }
  }

  /** Events after `from`, by pages, with `until` even if the view filters some out. */
  pull(
    from: number,
    type: DeviceType,
    deviceId: string | null = null,
  ): Extract<HubMessage, { type: 'events' }> {
    const page = this.store.eventsSince(from, PAGE_SIZE)
    return {
      type: 'events',
      events: page.filter((e) => this.sees(type, e)).map((e) => forDevice(e, deviceId)),
      until: page.at(-1)?.sequence ?? from,
      has_more: page.length === PAGE_SIZE,
    }
  }

  /**
   * Which events each device type sees. For now there are only order events and everyone sees
   * them; register and audit events will be filtered once they exist (Phase 1).
   */
  sees(_type: DeviceType, _event: OrderEvent): boolean {
    return true
  }

  /**
   * `new` message to broadcast an accepted event. `previous_until` assumes the device sees every
   * event; once `sees` filters (Phase 1) it will have to be per device.
   */
  fresh(event: OrderEvent, deviceId: string | null = null): Extract<HubMessage, { type: 'new' }> {
    return {
      type: 'new',
      event: forDevice(event, deviceId),
      previous_until: event.sequence - 1,
      until: event.sequence,
    }
  }

  /**
   * Processes a batch: one event per transaction, in order. If one is rejected, the following ones
   * for the same order in the batch are too (they depend on it). Returns the result of each one and
   * the accepted ones, to broadcast them.
   */
  receiveBatch(
    connection: Connection,
    events: readonly unknown[],
  ): { results: EventResult[]; acceptedEvents: OrderEvent[] } {
    const rejectedList = new Set<string>()
    const results: EventResult[] = []
    const acceptedEvents: OrderEvent[] = []
    for (const raw of events) {
      const data = identify(raw)
      let processed: { result: EventResult; accepted: OrderEvent | null }
      try {
        processed = this.store.transaction(() =>
          this.processEvent(connection, raw, data, rejectedList),
        )
      } catch (error) {
        // If the rejection cannot be saved either, the store is down: let the hub restart
        // (it throws). If it can, the problem is this event: rejecting it keeps it from crashing
        // the hub every time the device resends it.
        processed = this.store.transaction(() =>
          this.reject(connection, data, 'internal_error', this.config.clock()),
        )
        this.config.onInternalError?.(error, data.id)
      }
      const { result, accepted } = processed
      results.push(result)
      if (accepted) {
        acceptedEvents.push(accepted)
        this.applyToProjections(accepted)
      }
      if (result.status === 'rejected') {
        for (const id of aggregatesFromRaw(raw)) rejectedList.add(id)
      }
    }
    return { results, acceptedEvents }
  }

  conflicts() {
    return this.store.conflicts()
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Goes through every event and keeps the open orders. With years of data this gets slow:
   * in Phase 1 the projections are stored in the database.
   */
  private rebuildProjections() {
    const all = new Map<string, OrderState>()
    let from = 0
    for (;;) {
      const page = this.store.eventsSince(from, PAGE_SIZE)
      for (const event of page) {
        this.applyToShifts(event)
        if (event.aggregate_type !== 'order') continue
        for (const id of ordersOf(event)) {
          const r = applyEvent(all.get(id) ?? null, event)
          if (r.status) all.set(id, r.status)
        }
      }
      if (page.length < PAGE_SIZE) break
      from = page.at(-1)?.sequence ?? from
    }
    for (const [id, order] of all) if (order.status === 'open') this.orders.set(id, order)
  }

  /**
   * Tracks the open shifts and the events of each one (task 1.7): the reconciliation at close is
   * computed from them. A close removes the shift; a payment can no longer land in it.
   */
  private applyToShifts(event: OrderEvent) {
    const add = (shiftId: string, ...events: OrderEvent[]) =>
      this.shiftEvents.get(shiftId)?.push(...events)
    switch (event.type) {
      case 'ShiftOpened':
        this.shifts.set(event.aggregate_id, {
          id: event.aggregate_id,
          registerId: event.data.register_id,
          base: event.data.base,
          openedAt: event.received_at,
          userId: event.user_id,
        })
        this.shiftEvents.set(event.aggregate_id, [event])
        break
      case 'PaymentRecorded':
        add(event.data.register_shift_id, event)
        break
      case 'PaymentVoided':
      case 'RefundRecorded': {
        // The void or refund lands in the shift where it is recorded: that shift needs the payment
        // it reverses (its method), even if it was charged in another shift.
        const payment = this.store
          .aggregateEvents(event.aggregate_id)
          .find((e) => e.type === 'PaymentRecorded' && e.data.payment_id === event.data.payment_id)
        const list = this.shiftEvents.get(event.data.register_shift_id)
        if (payment && list && !list.some((e) => e.id === payment.id))
          add(event.data.register_shift_id, payment)
        add(event.data.register_shift_id, event)
        break
      }
      case 'CashMovementRecorded':
      case 'CashCountRecorded':
        add(event.aggregate_id, event)
        break
      case 'ShiftClosed':
        this.shifts.delete(event.aggregate_id)
        this.shiftEvents.delete(event.aggregate_id)
        break
    }
  }

  /**
   * The reconciliation of a shift (what was charged, the movements and the expected cash): an open
   * one from memory; a closed one from the database.
   */
  reconciliation(shiftId: string): ShiftReconciliation | null {
    const opened = this.shiftEvents.get(shiftId)
    return opened ? shiftReconciliation(opened, shiftId) : savedReconciliation(this.store, shiftId)
  }

  /** What the report for a period of business days needs (task 1.9). */
  reportData(from: string, until: string): ReportData {
    return reportData(this.store, from, until)
  }

  /** The close of an already closed shift, to reprint its Z report. */
  shiftClose(shiftId: string): ShiftClose | null {
    return shiftClose(this.store, shiftId)
  }

  /**
   * Register rules that do not depend on the order (task 1.6): a register opens one shift at a
   * time, and each payment, void or refund lands in an open shift of the register recording it.
   * A payment uses an enabled method, an active card terminal and the restaurant's rounding rule.
   */
  private registerIssue(event: NewEvent): string | null {
    if (event.type === 'ShiftOpened') {
      if (event.data.register_id !== event.device_id) return 'register_mismatch'
      if (
        this.shifts.has(event.aggregate_id) ||
        this.store.aggregateEvents(event.aggregate_id).length > 0
      )
        return 'shift_already_exists'
      if (this.openShift(event.data.register_id)) return 'shift_already_open'
      return null
    }
    if (
      event.type === 'CashMovementRecorded' ||
      event.type === 'CashCountRecorded' ||
      event.type === 'ShiftClosed'
    ) {
      const shift = this.shifts.get(event.aggregate_id)
      if (!shift) return 'no_shift'
      if (shift.registerId !== event.device_id) return 'other_register_shift'
      if (event.type !== 'ShiftClosed') return null
      // The close must match what the hub recorded: the count exists and is the same one, the
      // expected amount is what the reconciliation gives, and a large variance has a justification.
      const reconciliation = this.reconciliation(shift.id)
      const cashCount = reconciliation?.cashCounts.find((a) => a.id === event.data.cash_count_id)
      if (!reconciliation || !cashCount) return 'cash_count_not_found'
      // With the latest count, made after the shift's last cash movement.
      if (reconciliation.cashCounts.at(-1)?.id !== cashCount.id) return 'cash_count_not_latest'
      const events = this.shiftEvents.get(shift.id) ?? []
      const placement = (types: readonly string[]) =>
        events.findLastIndex((e) => types.includes(e.type))
      if (
        placement(['PaymentRecorded', 'PaymentVoided', 'RefundRecorded', 'CashMovementRecorded']) >
        placement(['CashCountRecorded'])
      )
        return 'stale_cash_count'
      if (cashCount.counted !== event.data.counted_cash) return 'counted_mismatch'
      if (reconciliation.cash.expected !== event.data.expected_cash) return 'expected_mismatch'
      // The other methods (task 1.8): each one with what the hub recorded and what its close said
      // in the count, no more and no less.
      const asText = (l: {
        method: string
        customMethodId: string | null
        expected: number
        reported: number
      }) => `${l.method}:${l.customMethodId ?? ''}:${l.expected}:${l.reported}`
      const others = otherMethodsReconciliation(reconciliation, cashCount)
      const fromEvent = (event.data.other_methods ?? []).map((o) => ({
        method: o.method,
        customMethodId: o.custom_method_id,
        expected: o.expected,
        reported: o.reported,
      }))
      if (others.map(asText).sort().join('|') !== fromEvent.map(asText).sort().join('|'))
        return 'other_methods_mismatch'
      const threshold =
        this.config.checkoutRules?.().varianceThreshold ?? REGISTER_VARIANCE_THRESHOLD
      const large = (d: number) => Math.abs(d) >= Math.max(1, threshold)
      if (
        (large(event.data.variance) || others.some((o) => large(o.variance))) &&
        !event.data.justification
      )
        return 'missing_justification'
      return null
    }
    if (
      event.type !== 'PaymentRecorded' &&
      event.type !== 'PaymentVoided' &&
      event.type !== 'RefundRecorded'
    )
      return null
    const shift = this.shifts.get(event.data.register_shift_id)
    if (!shift) return 'no_shift'
    if (shift.registerId !== event.device_id) return 'other_register_shift'
    if (event.type === 'PaymentRecorded' && this.config.checkoutRules) {
      const rules = this.config.checkoutRules()
      const { rounding, method, cardTerminal, custom_method_id } = event.data
      if (
        method === 'other'
          ? !custom_method_id || !(rules.customMethods ?? []).includes(custom_method_id)
          : !rules.methods.includes(method)
      )
        return 'method_not_enabled'
      if (cardTerminal && !rules.cardTerminals.includes(cardTerminal.card_terminal_id))
        return 'unknown_card_terminal'
      if (rounding && (rounding.multiple !== rules.multiple || rounding.mode !== rules.mode))
        return 'rounding_mismatch'
    }
    return null
  }

  private applyToProjections(event: OrderEvent) {
    this.applyToShifts(event)
    if (event.aggregate_type !== 'order') return
    for (const id of ordersOf(event)) {
      const r = applyEvent(this.order(id), event)
      if (r.status?.status === 'open') this.orders.set(id, r.status)
      else this.orders.delete(id)
    }
  }

  private processEvent(
    connection: Connection,
    raw: unknown,
    data: Identified,
    rejectedInBatch: ReadonlySet<string>,
  ): { result: EventResult; accepted: OrderEvent | null } {
    const receivedAt = this.config.clock()
    const { id, fingerprint: content } = data
    if (data.issue) return this.reject(connection, data, `schema: ${data.issue}`, receivedAt)

    // 1. Idempotency: the same id with the same content gets the same response.
    const previous = this.store.rejection(this.rejectionKey(data), content)
    if (previous)
      return { result: { id, status: 'rejected', reason: previous.reason }, accepted: null }
    const saved = id ? this.store.byId(id) : undefined
    if (saved) {
      if (saved.fingerprint === content)
        return { result: this.confirmed(saved.event), accepted: null }
      return this.reject(connection, data, 'duplicate_id', receivedAt)
    }

    // 2. Format.
    const validation = validateNewEvent(raw)
    if (!validation.ok)
      return this.reject(connection, data, `schema: ${validation.errors[0]}`, receivedAt)
    const event = validation.event

    // 3. Device.
    if (event.device_id !== connection.deviceId) {
      return this.reject(connection, data, 'device_mismatch', receivedAt)
    }
    if (connection.revokedAt) {
      // What was done before revoking it is reviewed by the manager; what came after is not valid.
      const before = Date.parse(event.hub_estimated_time) < Date.parse(connection.revokedAt)
      return before
        ? this.toQuarantine(connection, data, 'revoked_device', receivedAt)
        : this.reject(connection, data, 'revoked_device', receivedAt)
    }

    // 3b. Session and permission. A session the hub does not know (e.g. after restoring it) goes
    // to quarantine: the event may have been legitimate.
    // A product event has no order: nothing needs rebuilding to judge it.
    const previousOrder = event.aggregate_type === 'order' ? this.order(event.aggregate_id) : null
    const access = this.config.access.verify(connection, event, previousOrder)
    if (!access.ok) {
      return access.quarantine
        ? this.toQuarantine(connection, data, access.reason, receivedAt)
        : this.reject(connection, data, access.reason, receivedAt)
    }

    // 4. Dependencies within the batch and base sequence.
    const aggregates = ordersOf(event)
    if (aggregates.some((a) => rejectedInBatch.has(a))) {
      return this.reject(connection, data, 'depends_on_rejected', receivedAt)
    }
    const max = this.store.maxSequence()
    if (event.base_sequence > max) {
      return this.reject(connection, data, 'invalid_base_sequence', receivedAt)
    }

    // 5. What the hub adds.
    const day = businessDay(
      this.timeForDay(event.hub_estimated_time, receivedAt),
      this.config.timeZone,
      this.config.businessDayStart,
    )
    const candidate = {
      ...event,
      sequence: max + 1,
      received_at: receivedAt,
      business_day: day,
      assignments: this.assignments(event, day),
      affects: [],
      authorized_by_id: access.authorizedById,
    } as OrderEvent

    // 5b. Register: open shift and the restaurant's rounding.
    const fromRegister = this.registerIssue(event)
    if (fromRegister) return this.reject(connection, data, fromRegister, receivedAt)

    // 6. Apply to each order and decide. A product event (sold out) does not touch orders.
    const isOrder = event.aggregate_type === 'order'
    const before = isOrder ? aggregates.map((orderId) => this.order(orderId)) : []
    const results = before.map((order) => applyEvent(order, candidate))
    const issue = results.find((r) => r.issue && r.issue.type !== 'items_omitted')?.issue
    // Up to date: there is nothing from other devices in those orders that it did not know about.
    const upToDate =
      this.store.lastSequenceOf(aggregates, connection.deviceId) <= event.base_sequence

    let conflict: { type: ConflictType; description: string; aggregateId: string } | null = null
    if (issue) {
      const type = CONFLICTS[issue.type]
      if (!type || upToDate || ALWAYS_ONLINE.has(event.type)) {
        return this.reject(connection, data, issue.type, receivedAt)
      }
      conflict = { type, description: issue.description, aggregateId: event.aggregate_id }
    }
    const table = issue
      ? null
      : this.occupiedTable(
          event,
          aggregates,
          before.flatMap((order, i) => tablesItTakes(order, results[i]?.status ?? null)),
        )
    if (table === 'reject') return this.reject(connection, data, 'table_occupied', receivedAt)
    // A price that does not match the catalog is accepted (the item was already ordered, maybe
    // offline) and the register reviews it (docs/SYNC.md#rechazos-cuarentena-y-conflictos). An
    // event stores a single conflict: if there are also two orders on the table, it goes in the
    // same description.
    const variance = !issue && event.type === 'ItemAdded' ? this.config.prices?.review(event) : null
    if (table)
      conflict = variance
        ? { ...table, description: `${table.description}. Revisa también el precio: ${variance}` }
        : table
    else if (variance)
      conflict = {
        type: 'price_mismatch',
        description: variance,
        aggregateId: event.aggregate_id,
      }

    // 7. Save.
    this.store.saveEvent(candidate, content, aggregates)
    this.config.access.recordUse(event, access)
    if (conflict) {
      this.store.saveConflict({
        id: newId(),
        eventId: id,
        detectedAt: receivedAt,
        ...conflict,
      })
    }
    if (this.config.onSave) {
      try {
        this.config.onSave(
          candidate,
          before.map((order, i) => ({ before: order, after: results[i]?.status ?? null })),
        )
      } catch (error) {
        this.config.onSaveFailure?.(error, id)
      }
    }
    return { result: this.confirmed(candidate), accepted: candidate }
  }

  /**
   * Two open orders on the same table: if the device already knew about the other one, it is
   * rejected; if it did not (it was offline), both are accepted and the register is alerted.
   */
  private occupiedTable(
    event: NewEvent,
    aggregates: readonly string[],
    tables: readonly string[],
  ): { type: ConflictType; description: string; aggregateId: string } | 'reject' | null {
    if (tables.length === 0) return null
    let other: OrderState | undefined
    for (const p of this.orders.values())
      if (!aggregates.includes(p.id) && tables.some((m) => occupies(p, m))) {
        other = p
        break
      }
    if (!other) return null
    if (ENTRY_ONLINE.has(event.type) || ALWAYS_ONLINE.has(event.type)) return 'reject'
    const knewIt = this.store.lastSequenceOf([other.id], event.device_id) <= event.base_sequence
    if (knewIt) return 'reject'
    return {
      type: 'duplicate_table',
      description: 'Dos pedidos abiertos en la misma mesa: únelos en caja',
      aggregateId: event.aggregate_id,
    }
  }

  /**
   * Numbers the hub assigns: the order's daily number on opening, and one per ticket on sending,
   * consecutive within the business day (ADR-006 and ADR-015).
   */
  private assignments(event: NewEvent, day: string): OrderEvent['assignments'] {
    if (event.type === 'OrderOpened') return { day_number: this.store.dayOpenings(day) + 1 }
    if (event.type === 'ItemsSent') {
      // Only tickets that actually send something to the kitchen: what another device already sent
      // uses no number, and the kitchen sees no gaps (#1, #3).
      const before = this.order(event.aggregate_id)
      const nonEmpty = event.data.tickets.filter((c) =>
        c.item_ids.some((id) => before?.items[id]?.status === 'pending'),
      )
      const base = this.store.ticketsOfDay(day)
      return {
        ticket_numbers: Object.fromEntries(nonEmpty.map((c, i) => [c.ticket_id, base + i + 1])),
      }
    }
    return {}
  }

  /** The corrected device time is used if it falls in a reasonable window; otherwise the hub's. */
  private timeForDay(estimatedTime: string, receivedAt: string): string {
    const variance = Date.parse(receivedAt) - Date.parse(estimatedTime)
    return variance <= BEFORE_MAX_MS && variance >= -AFTER_MAX_MS ? estimatedTime : receivedAt
  }

  private confirmed(event: OrderEvent): EventResult {
    const { sequence, received_at, business_day, assignments, affects, authorized_by_id } = event
    return {
      id: event.id,
      status: 'confirmed',
      acceptance: {
        sequence,
        received_at,
        business_day,
        assignments,
        affects,
        authorized_by_id,
      },
      conflict: this.store.conflictOf(event.id)?.type ?? null,
    }
  }

  /** The device sets the time: that is why quarantine has a per-device cap. */
  private toQuarantine(
    connection: Connection,
    data: Identified,
    reason: string,
    receivedAt: string,
  ): { result: EventResult; accepted: null } {
    if (this.store.quarantinesOf(connection.deviceId) >= MAX_QUARANTINE)
      return this.reject(connection, data, reason, receivedAt)
    this.store.saveQuarantine({
      eventId: data.id,
      deviceId: connection.deviceId,
      reason,
      content: data.content,
      receivedAt,
    })
    return { result: { id: data.id, status: 'quarantine' }, accepted: null }
  }

  /** An event without an id is identified by its fingerprint. */
  private rejectionKey(data: Identified) {
    return data.id || `no-id-${data.fingerprint}`
  }

  private reject(
    connection: Connection,
    data: Identified,
    reason: string,
    receivedAt: string,
  ): { result: EventResult; accepted: null } {
    this.store.saveRejection({
      eventId: this.rejectionKey(data),
      fingerprint: data.fingerprint,
      deviceId: connection.deviceId,
      reason,
      content: data.content,
      receivedAt,
    })
    return { result: { id: data.id, status: 'rejected', reason }, accepted: null }
  }
}
