import type { DatosAceptacion, EventoPedido } from '@pos/core'
import { z } from 'zod'

// Mensajes entre dispositivo y hub (docs/SYNC.md#mensajes-por-websocket). Lo que llega del otro
// lado se valida con estos esquemas; los eventos se validan aparte con su propio esquema.

export const TAMANO_LOTE = 100
export const TAMANO_PAGINA = 500

// ── Dispositivo → hub ───────────────────────────────────────────────────

export const MensajeDispositivo = z.discriminatedUnion('tipo', [
  z.strictObject({
    tipo: z.literal('hola'),
    token: z.string().min(1).max(500),
    hub_instancia: z.string().max(100).nullable(),
    hasta: z.int().min(0),
    version_app: z.string().max(50),
  }),
  z.strictObject({
    tipo: z.literal('empujar'),
    lote_id: z.string().min(1).max(100),
    // Cada evento se valida uno por uno: un evento inválido no debe tumbar el lote.
    eventos: z.array(z.unknown()).min(1).max(TAMANO_LOTE),
  }),
  z.strictObject({ tipo: z.literal('traer'), desde: z.int().min(0) }),
  z.strictObject({ tipo: z.literal('ping'), marca: z.string().max(100) }),
])
export type MensajeDispositivo = z.infer<typeof MensajeDispositivo>

// ── Hub → dispositivo ───────────────────────────────────────────────────

/** Resultado de cada evento de un lote. */
export type ResultadoEvento =
  | { id: string; estado: 'confirmado'; aceptacion: DatosAceptacion; conflicto: string | null }
  | { id: string; estado: 'rechazado'; motivo: string }
  | { id: string; estado: 'cuarentena' }

export type CodigoError = 'token_invalido' | 'token_revocado' | 'mensaje_invalido' | 'app_vieja'

export type MensajeHub =
  | { tipo: 'bienvenido'; hub_instancia: string; secuencia_max: number; hora_hub: string }
  | { tipo: 'error'; codigo: CodigoError; mensaje: string }
  | { tipo: 'resultado'; lote_id: string; resultados: ResultadoEvento[] }
  | { tipo: 'eventos'; eventos: EventoPedido[]; hasta: number; hay_mas: boolean }
  /** `hasta_anterior`: hasta dónde llegaba el dispositivo para que este mensaje sea contiguo. */
  | { tipo: 'nuevo'; evento: EventoPedido; hasta_anterior: number; hasta: number }
  | { tipo: 'pong'; marca: string }
  | { tipo: 'latido' }
  /** El catálogo cambió y quedó en esta versión: el dispositivo lo vuelve a pedir por HTTP. */
  | { tipo: 'catalogo'; version: number }
  /** Cómo están las impresoras de comandas; llega al conectar y cada vez que una cambia (ADR-015). */
  | { tipo: 'impresoras'; impresoras: EstadoImpresora[] }

/** Una impresora de comandas vista desde los equipos. */
export interface EstadoImpresora {
  id: string
  nombre: string
  /** `falla`: no respondió al último intento; `lista`: imprimió o aún no tuvo trabajo. */
  estado: 'lista' | 'falla'
  /** Qué pasó, en palabras para la caja. */
  error: string | null
  /** Comandas esperando en esa impresora. */
  pendientes: number
}

/** Tipos de dispositivo y lo que ve cada uno (docs/SYNC.md#mensajes-por-websocket). */
export type TipoDispositivo = 'mesero' | 'caja' | 'kds'
