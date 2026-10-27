import { z } from 'zod'
import { PaymentMethod, Ulid } from './events/common'
import type { RoundingMode } from './money/arithmetic'
import type { CashRoundingMode } from './money/cash'

// Restaurant config (`restaurants.config`, docs/MODELO_DATOS.md#configuración-del-
// restaurante). Anything missing takes the pilot default. Tax matters are flagged to be
// validated with the accountant: none of it is hard-coded.

// The same modes the money code accepts: if one is added there, TypeScript requires it here.
const ROUNDING_MODES = ['half_up', 'half_even'] as const satisfies readonly RoundingMode[]
const CASH_MODES = [
  'nearest_half_down',
  'nearest_half_up',
  'down',
  'up',
] as const satisfies readonly CashRoundingMode[]

/** The brands the app knows how to render (apps/pos/src/styles.css). */
export const BRANDS = ['faro', 'la-spritzzeria'] as const

const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora en formato HH:MM')

export const RestaurantConfig = z.strictObject({
  business_day_start: TimeOfDay.default('06:00'),
  table_lock_by_waiter: z.boolean().default(false),
  /** Multiple in pesos for cash charges (ADR-004). Only the usual ones in Colombia. */
  cash_rounding: z
    .union([z.literal(1), z.literal(50), z.literal(100), z.literal(500), z.literal(1000)])
    .default(100),
  /**
   * Basis points: 1000 = 10 %. 10 % cap (Ley 1935 de 2018) — (validate) with the accountant.
   */
  suggested_tip: z.int().min(0).max(1000).default(1000),
  /** On the base before INC (owner's decision). (validate) legal cap with the accountant. */
  tip_base: z.literal('pre_tax').default('pre_tax'),
  /**
   * (validate) with the DIAN provider. Per document does not exist yet in `money/fiscal.ts`: only
   * per line is accepted until it does.
   */
  tax_granularity: z.literal('line').default('line'),
  sales_by_waiter: z.enum(['added_by', 'assigned_waiter']).default('added_by'),
  rounding_mode: z.enum(ROUNDING_MODES).default('half_up'),
  /** The ones that overcharge (`up`, `nearest_half_up`): (validate) consumer protection. */
  cash_rounding_mode: z.enum(CASH_MODES).default('nearest_half_down'),
  session_idle_min: z
    .int()
    .min(1)
    .max(24 * 60)
    .default(30),
  /**
   * Which brand the POS shows on every device (task 1.3c). It is optional: `faro` is the
   * system style; the others are restaurant brands already built into the app.
   */
  brand: z.enum(BRANDS).default('faro'),
  /**
   * Minutes after sending to the kitchen at which a ticket turns amber and red in «Pedidos en
   * cocina» and on the kitchen screen (ADR-015).
   */
  kitchen_yellow_min: z.int().min(1).max(240).default(10),
  kitchen_red_min: z.int().min(1).max(240).default(20),
  /**
   * Courses (starter, main, dessert; hold and fire). Barely used in Colombia: off by default,
   * turned on per restaurant (owner's decision of 25-oct-2026).
   */
  courses_enabled: z.boolean().default(false),
  /**
   * Payment methods the restaurant accepts (task 1.6). Cash is always there: the register
   * must be able to charge even if the card terminal fails.
   */
  payment_methods: z
    .array(PaymentMethod)
    .min(1)
    .refine((m) => m.includes('cash'), 'El efectivo siempre se recibe')
    .refine((m) => new Set(m).size === m.length, 'Hay medios repetidos')
    .refine((m) => !m.includes('other'), 'Los medios propios van en medios_propios')
    .default(['cash', 'card', 'nequi', 'daviplata', 'breb', 'transfer']),
  /**
   * Methods the restaurant creates, with their name (Sodexo, QR Bancolombia, Rappi). They show at
   * checkout after the ones above; an archived one no longer shows, but its payments still name it.
   */
  custom_methods: z
    .array(
      z.strictObject({
        id: Ulid,
        name: z.string().trim().min(1).max(30),
        active: z.boolean(),
      }),
    )
    .max(20)
    .refine((m) => new Set(m.map((x) => x.id)).size === m.length, 'Hay medios repetidos')
    .default([]),
  /**
   * From what variance (over or short, in pesos) the register close asks for a reason
   * (task 1.7). Below it, it just closes.
   */
  register_variance_threshold: z.int().min(0).max(1_000_000).default(1000),
  /** Where the printed pre-bill comes out; without a printer, the pre-bill is only on screen. */
  pre_bill_printer_id: Ulid.nullable().default(null),
})

export type RestaurantConfig = z.infer<typeof RestaurantConfig>

/** The config with everything missing filled in with the defaults. */
export const fullConfig = (partial: unknown = {}): RestaurantConfig =>
  RestaurantConfig.parse(partial)
