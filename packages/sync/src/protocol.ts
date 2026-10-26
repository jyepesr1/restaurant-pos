import type { AcceptanceData, OrderEvent } from '@pos/core'
import { z } from 'zod'

// Messages between device and hub (docs/SYNC.md#mensajes-por-websocket). Whatever arrives from the
// other side is validated with these schemas; events are validated separately with their own
// schema.

export const BATCH_SIZE = 100
export const PAGE_SIZE = 500

// ── Device → hub ───────────────────────────────────────────────────────

export const DeviceMessage = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('hello'),
    token: z.string().min(1).max(500),
    hub_instance: z.string().max(100).nullable(),
    until: z.int().min(0),
    version_app: z.string().max(50),
  }),
  z.strictObject({
    type: z.literal('push'),
    batch_id: z.string().min(1).max(100),
    // Each event is validated one by one: an invalid event must not sink the batch.
    events: z.array(z.unknown()).min(1).max(BATCH_SIZE),
  }),
  z.strictObject({ type: z.literal('pull'), from: z.int().min(0) }),
  z.strictObject({ type: z.literal('ping'), brand: z.string().max(100) }),
])
export type DeviceMessage = z.infer<typeof DeviceMessage>

// ── Hub → device ────────────────────────────────────────────────────────

/** Result of each event in a batch. */
export type EventResult =
  | { id: string; status: 'confirmed'; acceptance: AcceptanceData; conflict: string | null }
  | { id: string; status: 'rejected'; reason: string }
  | { id: string; status: 'quarantine' }

export type ErrorCode = 'invalid_token' | 'revoked_token' | 'invalid_message' | 'outdated_app'

export type HubMessage =
  | { type: 'welcome'; hub_instance: string; max_sequence: number; hub_time: string }
  | { type: 'error'; code: ErrorCode; message: string }
  | { type: 'result'; batch_id: string; results: EventResult[] }
  | { type: 'events'; events: OrderEvent[]; until: number; has_more: boolean }
  /** `previous_until`: how far the device must have reached for this message to be contiguous. */
  | { type: 'new'; event: OrderEvent; previous_until: number; until: number }
  | { type: 'pong'; brand: string }
  | { type: 'heartbeat' }
  /** The catalog changed and is now at this version: the device fetches it again over HTTP. */
  | { type: 'catalog'; version: number }
  /** Status of the ticket printers; sent on connect and every time one changes (ADR-015). */
  | { type: 'printers'; printers: PrinterStatus[] }

/** A ticket printer as seen from the devices. */
export interface PrinterStatus {
  id: string
  name: string
  /** `failed`: did not respond to the last attempt; `ready`: printed or has had no job yet. */
  status: 'ready' | 'failed'
  /** What happened, in words for the register. */
  error: string | null
  /** Tickets waiting on that printer. */
  pendingList: number
}

/** Device types and what each one sees (docs/SYNC.md#mensajes-por-websocket). */
export type DeviceType = 'waiter' | 'register' | 'kds'
