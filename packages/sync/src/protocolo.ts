import type { AcceptanceData, OrderEvent } from '@pos/core'
import { z } from 'zod'

// Mensajes entre dispositivo y hub (docs/SYNC.md#mensajes-por-websocket). Lo que llega del otro
// lado se valida con estos esquemas; los eventos se validan aparte con su propio esquema.

export const TAMANO_LOTE = 100
export const TAMANO_PAGINA = 500

// ── Dispositivo → hub ───────────────────────────────────────────────────

export const MensajeDispositivo = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('hello'),
    token: z.string().min(1).max(500),
    hub_instancia: z.string().max(100).nullable(),
    until: z.int().min(0),
    version_app: z.string().max(50),
  }),
  z.strictObject({
    type: z.literal('push'),
    lote_id: z.string().min(1).max(100),
    // Cada evento se valida uno por uno: un evento inválido no debe tumbar el lote.
    events: z.array(z.unknown()).min(1).max(TAMANO_LOTE),
  }),
  z.strictObject({ type: z.literal('pull'), from: z.int().min(0) }),
  z.strictObject({ type: z.literal('ping'), brand: z.string().max(100) }),
])
export type MensajeDispositivo = z.infer<typeof MensajeDispositivo>

// ── Hub → dispositivo ───────────────────────────────────────────────────

/** Resultado de cada evento de un lote. */
export type ResultadoEvento =
  | { id: string; status: 'confirmed'; aceptacion: AcceptanceData; conflict: string | null }
  | { id: string; status: 'rejected'; reason: string }
  | { id: string; status: 'quarantine' }

export type CodigoError = 'invalid_token' | 'revoked_token' | 'invalid_message' | 'outdated_app'

export type MensajeHub =
  | { type: 'welcome'; hub_instancia: string; secuencia_max: number; hora_hub: string }
  | { type: 'error'; code: CodigoError; message: string }
  | { type: 'result'; lote_id: string; resultados: ResultadoEvento[] }
  | { type: 'events'; events: OrderEvent[]; until: number; hay_mas: boolean }
  /** `hasta_anterior`: hasta dónde llegaba el dispositivo para que este mensaje sea contiguo. */
  | { type: 'new'; event: OrderEvent; hasta_anterior: number; until: number }
  | { type: 'pong'; brand: string }
  | { type: 'heartbeat' }
  /** El catálogo cambió y quedó en esta versión: el dispositivo lo vuelve a pedir por HTTP. */
  | { type: 'catalog'; version: number }
  /** Cómo están las impresoras de comandas; llega al conectar y cada vez que una cambia (ADR-015). */
  | { type: 'printers'; printers: EstadoImpresora[] }

/** Una impresora de comandas vista desde los equipos. */
export interface EstadoImpresora {
  id: string
  name: string
  /** `falla`: no respondió al último intento; `lista`: imprimió o aún no tuvo trabajo. */
  status: 'ready' | 'failed'
  /** Qué pasó, en palabras para la caja. */
  error: string | null
  /** Comandas esperando en esa impresora. */
  pendingList: number
}

/** Tipos de dispositivo y lo que ve cada uno (docs/SYNC.md#mensajes-por-websocket). */
export type TipoDispositivo = 'waiter' | 'register' | 'kds'
