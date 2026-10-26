import { z } from 'zod'
import { LIMITE_CANTIDAD, LIMITE_PRECIO, LIMITE_TOTAL_PEDIDO, PUNTOS_BASICOS } from '../dinero'
import { esIdValido } from '../id'

// Tipos base de los eventos. Los nombres de campo van en snake_case porque es el formato que se
// guarda y viaja (docs/MODELO_DATOS.md, docs/SYNC.md).

export const Ulid = z.string().refine(esIdValido, 'Debe ser un ULID canónico')
export const HoraIso = z.iso.datetime()
export const Dia = z.iso.date()

/** Monto en pesos enteros, ≥ 0, hasta el tope de un pedido. */
export const Pesos = z.int().min(0).max(LIMITE_TOTAL_PEDIDO)
/** Monto con signo (ajuste de redondeo). */
export const PesosConSigno = z.int().min(-LIMITE_TOTAL_PEDIDO).max(LIMITE_TOTAL_PEDIDO)
export const Precio = z.int().min(0).max(LIMITE_PRECIO)
export const Cantidad = z.int().min(1).max(LIMITE_CANTIDAD)
export const PuntosBasicos = z.int().min(0).max(PUNTOS_BASICOS)
export const Texto = z.string().trim().min(1).max(500)

export const Canal = z.enum(['salon', 'para_llevar', 'domicilio', 'barra'])
export const Curso = z.enum(['entrada', 'fuerte', 'postre'])
export const TipoImpuesto = z.enum(['inc', 'iva', 'exento'])
export const MedioPago = z.enum([
  'efectivo',
  'tarjeta',
  'nequi',
  'daviplata',
  'breb',
  'transferencia',
  'bono',
  // Un medio que crea el restaurante (Sodexo, QR del banco…): el pago dice cuál (tarea 1.6).
  'otro',
])

/** Fracción de un ítem compartido: 1/3 de botella → { n: 1, d: 3 }. */
export const FraccionItem = z
  .object({ n: z.int().min(1), d: z.int().min(1).max(100) })
  .refine(({ n, d }) => n <= d, 'La fracción no puede ser mayor que 1')

export type Canal = z.infer<typeof Canal>
export type Curso = z.infer<typeof Curso>
export type TipoImpuesto = z.infer<typeof TipoImpuesto>
export type MedioPago = z.infer<typeof MedioPago>
