import { z } from 'zod'
import { isValidId } from '../id'
import { BASIS_POINTS, ORDER_TOTAL_LIMIT, PRICE_LIMIT, QUANTITY_LIMIT } from '../money'

// Base types of the events. Field names are snake_case because that is the format that is
// stored and sent over the wire (docs/MODELO_DATOS.md, docs/SYNC.md).

export const Ulid = z.string().refine(isValidId, 'Debe ser un ULID canónico')
export const IsoTime = z.iso.datetime()
export const Day = z.iso.date()

/** Amount in whole pesos, ≥ 0, up to the limit of an order. */
export const Pesos = z.int().min(0).max(ORDER_TOTAL_LIMIT)
/** Signed amount (rounding adjustment). */
export const SignedPesos = z.int().min(-ORDER_TOTAL_LIMIT).max(ORDER_TOTAL_LIMIT)
export const Price = z.int().min(0).max(PRICE_LIMIT)
export const Quantity = z.int().min(1).max(QUANTITY_LIMIT)
export const BasisPoints = z.int().min(0).max(BASIS_POINTS)
export const LocalizedText = z.string().trim().min(1).max(500)

export const Channel = z.enum(['dine_in', 'takeout', 'delivery', 'bar'])
export const Course = z.enum(['starter', 'main', 'dessert'])
export const TaxType = z.enum(['inc', 'iva', 'exempt'])
export const PaymentMethod = z.enum([
  'cash',
  'card',
  'nequi',
  'daviplata',
  'breb',
  'transfer',
  'voucher',
  // A method the restaurant creates (Sodexo, bank QR…): the payment says which one (task 1.6).
  'other',
])

/** Fraction of a shared item: 1/3 of a bottle → { n: 1, d: 3 }. */
export const ItemFraction = z
  .object({ n: z.int().min(1), d: z.int().min(1).max(100) })
  .refine(({ n, d }) => n <= d, 'La fracción no puede ser mayor que 1')

export type Channel = z.infer<typeof Channel>
export type Course = z.infer<typeof Course>
export type TaxType = z.infer<typeof TaxType>
export type PaymentMethod = z.infer<typeof PaymentMethod>
