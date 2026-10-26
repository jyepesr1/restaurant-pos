import { z } from 'zod'
import type { ModoRedondeo } from './dinero/aritmetica'
import type { ModoRedondeoEfectivo } from './dinero/efectivo'
import { MedioPago, Ulid } from './eventos/comun'

// Configuración del restaurante (`Restaurante.config`, docs/MODELO_DATOS.md#configuración-del-
// restaurante). Lo que no venga toma el valor por defecto del piloto. Lo tributario queda
// marcado para validar con el contador: nada de eso está cableado.

// Los mismos modos que acepta el código de dinero: si se agrega uno allá, TypeScript lo pide acá.
const MODOS_REDONDEO = ['mitad_arriba', 'mitad_par'] as const satisfies readonly ModoRedondeo[]
const MODOS_EFECTIVO = [
  'cercano_mitad_abajo',
  'cercano_mitad_arriba',
  'abajo',
  'arriba',
] as const satisfies readonly ModoRedondeoEfectivo[]

/** Las marcas que la app sabe dibujar (apps/pos/src/estilos.css). */
export const MARCAS = ['faro', 'la-spritzzeria'] as const

const Hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora en formato HH:MM')

export const ConfigRestaurante = z.strictObject({
  inicio_dia_operativo: Hora.default('06:00'),
  bloqueo_mesa_por_mesero: z.boolean().default(false),
  /** Múltiplo en pesos para cobros en efectivo (ADR-004). Solo los habituales en Colombia. */
  redondeo_efectivo: z
    .union([z.literal(1), z.literal(50), z.literal(100), z.literal(500), z.literal(1000)])
    .default(100),
  /**
   * Puntos básicos: 1000 = 10 %. Tope del 10 % (Ley 1935 de 2018) — (validar) con el contador.
   */
  propina_sugerida: z.int().min(0).max(1000).default(1000),
  /** Sobre la base sin INC (decisión del dueño). (validar) tope legal con el contador. */
  propina_base: z.literal('sin_impuesto').default('sin_impuesto'),
  /**
   * (validar) con el proveedor DIAN. Por documento aún no existe en `dinero/fiscal.ts`: solo se
   * acepta por línea hasta que exista.
   */
  granularidad_fiscal: z.literal('linea').default('linea'),
  ventas_por_mesero: z.enum(['quien_agrega', 'mesero_asignado']).default('quien_agrega'),
  redondeo_modo: z.enum(MODOS_REDONDEO).default('mitad_arriba'),
  /** Los que cobran de más (`arriba`, `cercano_mitad_arriba`): (validar) protección al consumidor. */
  redondeo_efectivo_modo: z.enum(MODOS_EFECTIVO).default('cercano_mitad_abajo'),
  sesion_inactividad_min: z
    .int()
    .min(1)
    .max(24 * 60)
    .default(30),
  /**
   * Con qué marca se ve el POS en todos los equipos (tarea 1.3c). Es opcional: `faro` es el
   * estilo del sistema; las demás son marcas de restaurantes ya preparadas en la app.
   */
  marca: z.enum(MARCAS).default('faro'),
  /**
   * Minutos desde el envío a cocina tras los que una comanda pasa a ámbar y a rojo en «Pedidos en
   * cocina» y en la pantalla de cocina (ADR-015).
   */
  cocina_amarillo_min: z.int().min(1).max(240).default(10),
  cocina_rojo_min: z.int().min(1).max(240).default(20),
  /**
   * Cursos (entrada, fuerte, postre; retener y marchar). En Colombia casi no se usan: apagados por
   * defecto, se prenden por restaurante (decisión del dueño del 25-oct-2026).
   */
  usar_cursos: z.boolean().default(false),
  /**
   * Medios de pago que recibe el restaurante (tarea 1.6). El efectivo siempre está: la caja
   * necesita poder cobrar aunque falle el datáfono.
   */
  medios_pago: z
    .array(MedioPago)
    .min(1)
    .refine((m) => m.includes('efectivo'), 'El efectivo siempre se recibe')
    .refine((m) => new Set(m).size === m.length, 'Hay medios repetidos')
    .refine((m) => !m.includes('otro'), 'Los medios propios van en medios_propios')
    .default(['efectivo', 'tarjeta', 'nequi', 'daviplata', 'breb', 'transferencia']),
  /**
   * Medios que crea el restaurante, con su nombre (Sodexo, QR Bancolombia, Rappi). Salen al cobrar
   * después de los de arriba; uno archivado ya no sale, pero sus pagos lo siguen nombrando.
   */
  medios_propios: z
    .array(
      z.strictObject({
        id: Ulid,
        nombre: z.string().trim().min(1).max(30),
        activo: z.boolean(),
      }),
    )
    .max(20)
    .refine((m) => new Set(m.map((x) => x.id)).size === m.length, 'Hay medios repetidos')
    .default([]),
  /** Dónde sale la precuenta impresa; sin impresora, la precuenta solo se ve en pantalla. */
  impresora_precuenta_id: Ulid.nullable().default(null),
})

export type ConfigRestaurante = z.infer<typeof ConfigRestaurante>

/** La configuración con todo lo que falte completado con los valores por defecto. */
export const configCompleta = (parcial: unknown = {}): ConfigRestaurante =>
  ConfigRestaurante.parse(parcial)
