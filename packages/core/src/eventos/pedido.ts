import { z } from 'zod'
import { LIMITE_PRECIO, sumarFracciones } from '../dinero/aritmetica'
import {
  Canal,
  Cantidad,
  Curso,
  Dia,
  FraccionItem,
  HoraIso,
  MedioPago,
  Pesos,
  PesosConSigno,
  Precio,
  PuntosBasicos,
  Texto,
  TipoImpuesto,
  Ulid,
} from './comun'

// Eventos del pedido, versión 1 (docs/MODELO_DATOS.md#eventos-del-pedido-versión-1). Todos los
// objetos son estrictos: un campo de más se rechaza en lugar de descartarse en silencio, así
// lo que se guarda es exactamente lo que llegó.

const Modificador = z.strictObject({
  modificador_id: Ulid,
  nombre: Texto,
  precio_extra: Precio,
})

const camposCopiaItem = {
  item_id: Ulid,
  producto_id: Ulid,
  variante_id: Ulid.nullable(),
  nombre: Texto,
  precio_unitario: Precio,
  impuesto_tipo: TipoImpuesto,
  tarifa: PuntosBasicos,
  cantidad: Cantidad,
  comensal: z.int().min(1).max(99).nullable(),
  curso: Curso.nullable(),
  modificadores: z.array(Modificador).max(30),
  notas: z.string().max(500).nullable(),
}

type CamposCopia = {
  impuesto_tipo: string
  tarifa: number
  precio_unitario: number
  modificadores: { precio_extra: number }[]
}

/** Exento sin tarifa, y la unidad completa (precio + extras) dentro del tope de precio. */
function validarCopia(item: CamposCopia, ctx: z.RefinementCtx) {
  if (item.impuesto_tipo === 'exento' && item.tarifa !== 0) {
    ctx.addIssue({ code: 'custom', path: ['tarifa'], message: 'Un ítem exento no lleva tarifa' })
  }
  const unidad = item.precio_unitario + item.modificadores.reduce((a, m) => a + m.precio_extra, 0)
  if (unidad > LIMITE_PRECIO) {
    ctx.addIssue({ code: 'custom', message: `El precio con extras pasa de ${LIMITE_PRECIO}` })
  }
}

/** Copia de un ítem: lo que viaja al moverlo o al unir pedidos. */
export const CopiaItem = z.strictObject(camposCopiaItem).superRefine(validarCopia)
export type CopiaItem = z.infer<typeof CopiaItem>

/** Ítem movido: además de la copia, su estado, lo anulado y quién lo agregó. */
const ItemMovido = z
  .strictObject({
    item: CopiaItem,
    estado: z.enum(['retenido', 'pendiente', 'enviado', 'en_preparacion', 'listo', 'entregado']),
    cantidad_anulada: z.int().min(0),
    agregado_por: Ulid,
  })
  .refine((m) => m.cantidad_anulada < m.item.cantidad, 'No se mueve un ítem anulado por completo')

const ItemIds = z.array(Ulid).min(1).max(200)
const Vacio = z.strictObject({})

const idsUnicos = (ids: readonly string[]) => new Set(ids).size === ids.length

const datosPorTipo = {
  PedidoAbierto: z.strictObject({
    canal: Canal,
    mesa_id: Ulid.nullable(),
    comensales: z.int().min(0).max(200),
  }),
  PedidoRescateCreado: z.strictObject({
    pedido_original_id: Ulid,
    canal: Canal,
    mesa_id: Ulid.nullable(),
    mesero_id: Ulid,
  }),
  MeseroAsignado: z.strictObject({ mesero_id: Ulid }),
  ComensalesCambiados: z.strictObject({ comensales: z.int().min(0).max(200) }),
  /** Nota para todo el pedido («alérgico al maní», «cumpleaños»); `null` la quita. */
  NotaPedidoCambiada: z.strictObject({ notas: z.string().max(500).nullable() }),
  ItemAgregado: z
    .strictObject({
      ...camposCopiaItem,
      catalogo_version: z.int().min(0),
      precio_canal_id: Ulid.nullable(),
    })
    .superRefine(validarCopia),
  ItemCambiado: z
    .strictObject({
      item_id: Ulid,
      cantidad: Cantidad.optional(),
      comensal: z.int().min(1).max(99).nullable().optional(),
      curso: Curso.nullable().optional(),
      notas: z.string().max(500).nullable().optional(),
    })
    .refine(
      (d) => Object.entries(d).some(([campo, valor]) => campo !== 'item_id' && valor !== undefined),
      'Debe cambiar al menos un campo',
    ),
  ItemQuitado: z.strictObject({ item_id: Ulid }),
  ItemsEnviados: z.strictObject({
    comandas: z
      .array(z.strictObject({ comanda_id: Ulid, estacion_id: Ulid, item_ids: ItemIds }))
      .min(1),
  }),
  ItemModificadoTrasEnvio: z
    .strictObject({
      item_id: Ulid,
      comanda_id: Ulid,
      notas: z.string().max(500).nullable().optional(),
      modificadores: z.array(Modificador).max(30).optional(),
    })
    .refine(
      (d) => d.notas !== undefined || d.modificadores !== undefined,
      'Debe cambiar notas o modificadores',
    ),
  ComandaReimpresa: z.strictObject({ comanda_id: Ulid }),
  CursoRetenido: z.strictObject({ curso: Curso }),
  CursoMarchado: z.strictObject({ curso: Curso }),
  ItemEnPreparacion: z.strictObject({ item_ids: ItemIds }),
  ItemListo: z.strictObject({ item_ids: ItemIds }),
  ItemEntregado: z.strictObject({ item_ids: ItemIds }),
  ItemDevueltoACola: z.strictObject({ item_ids: ItemIds }),
  ItemAnulado: z.strictObject({
    item_id: Ulid,
    cantidad: Cantidad,
    ya_preparado: z.boolean(),
    comanda_id: Ulid.nullable(),
  }),
  ItemsMovidos: z.strictObject({
    pedido_destino_id: Ulid,
    items: z
      .array(ItemMovido)
      .min(1)
      .max(200)
      .refine((items) => idsUnicos(items.map((m) => m.item.item_id)), 'Ítems repetidos'),
  }),
  PedidoMovidoDeMesa: z.strictObject({ mesa_destino_id: Ulid }),
  /**
   * Un grupo grande ocupa más mesas con el mismo pedido (tarea 1.5): las mesas que se suman a la
   * suya. `MesasSeparadas` las suelta.
   */
  MesasUnidas: z.strictObject({
    mesa_ids: z.array(Ulid).min(1).max(10).refine(idsUnicos, 'Mesas repetidas'),
  }),
  MesasSeparadas: z.strictObject({
    mesa_ids: z.array(Ulid).min(1).max(10).refine(idsUnicos, 'Mesas repetidas'),
  }),
  PedidosUnidos: z.strictObject({
    pedido_origen_id: Ulid,
    items: z
      .array(ItemMovido)
      .max(200)
      .refine((items) => idsUnicos(items.map((m) => m.item.item_id)), 'Ítems repetidos'),
  }),
  DescuentoAplicado: z
    .strictObject({
      descuento_id: Ulid,
      alcance: z.enum(['item', 'pedido']),
      regla: z.enum(['porcentaje', 'valor', 'cortesia']),
      valor: Pesos,
      cantidad_unidades: Cantidad.nullable(),
      montos: z
        .array(z.strictObject({ item_id: Ulid, monto: Pesos }))
        .min(1)
        .max(200),
    })
    .superRefine((d, ctx) => {
      const problema = (message: string) => ctx.addIssue({ code: 'custom', message })
      if (!idsUnicos(d.montos.map((m) => m.item_id)))
        problema('Un ítem aparece dos veces en montos')
      if (d.alcance === 'item' && d.montos.length !== 1)
        problema('Un descuento de ítem va en una sola línea')
      if (d.regla === 'valor' && d.montos.reduce((a, m) => a + m.monto, 0) !== d.valor) {
        problema('En un descuento por valor, los montos deben sumar el valor')
      }
      if (d.regla === 'porcentaje' && d.valor > 10_000)
        problema('El porcentaje va en puntos básicos (máx. 10.000)')
      if (d.regla === 'cortesia' && (d.cantidad_unidades === null || d.alcance !== 'item')) {
        problema('Una cortesía es de un ítem e indica cuántas unidades')
      }
      if (d.regla !== 'cortesia' && d.cantidad_unidades !== null)
        problema('Solo la cortesía indica unidades')
    }),
  DescuentoRetirado: z.strictObject({ descuento_id: Ulid }),
  PrecuentaImpresa: z.strictObject({
    cuenta_id: Ulid.nullable(),
    subtotal: Pesos,
    propina_sugerida: Pesos,
  }),
  CuentaDividida: z.strictObject({
    cuentas: z
      .array(
        z.strictObject({
          cuenta_id: Ulid,
          nombre: Texto,
          monto: Pesos,
          propina_sugerida: Pesos,
          items: z.array(z.strictObject({ item_id: Ulid, fraccion: FraccionItem })).max(200),
        }),
      )
      .min(2)
      .max(50)
      .superRefine((cuentas, ctx) => {
        if (!idsUnicos(cuentas.map((c) => c.cuenta_id))) {
          ctx.addIssue({ code: 'custom', message: 'Hay cuentas repetidas' })
        }
        const porItem = new Map<string, { n: bigint; d: bigint }>()
        for (const { item_id, fraccion } of cuentas.flatMap((c) => c.items)) {
          const suma = sumarFracciones(porItem.get(item_id) ?? { n: 0n, d: 1n }, {
            n: BigInt(fraccion.n),
            d: BigInt(fraccion.d),
          })
          porItem.set(item_id, suma)
          if (suma.n > suma.d)
            ctx.addIssue({ code: 'custom', message: `Las fracciones de ${item_id} pasan de 1` })
        }
      }),
  }),
  DivisionDeshecha: Vacio,
  PagoRegistrado: z
    .strictObject({
      pago_id: Ulid,
      cuenta_id: Ulid.nullable(),
      turno_caja_id: Ulid,
      medio: MedioPago,
      monto: Pesos.min(1),
      propina: Pesos,
      recibido: Pesos.nullable(),
      cambio: Pesos.nullable(),
      ajuste_redondeo: PesosConSigno,
      // Regla de redondeo del efectivo con la que se calculó el ajuste; el hub la toma de la
      // configuración del restaurante y el reductor comprueba el ajuste con ella.
      redondeo: z
        .strictObject({
          multiplo: z.int().min(1).max(10_000),
          modo: z.enum(['cercano_mitad_abajo', 'cercano_mitad_arriba', 'abajo', 'arriba']),
        })
        .nullable(),
      datafono: z
        .strictObject({
          datafono_id: Ulid,
          franquicia: Texto.nullable(),
          ultimos4: z
            .string()
            .regex(/^\d{4}$/)
            .nullable(),
          aprobacion: Texto,
          recibo: Texto.nullable(),
        })
        .nullable(),
      referencia_cobro: z.string().max(100).nullable(),
    })
    .superRefine((p, ctx) => {
      const problema = (message: string) => ctx.addIssue({ code: 'custom', message })
      if (p.medio === 'efectivo') {
        if (p.recibido === null || p.cambio === null) problema('En efectivo van recibido y cambio')
        else if (p.recibido !== p.monto + p.ajuste_redondeo + p.propina + p.cambio) {
          problema('recibido ≠ monto + ajuste + propina + cambio')
        }
      } else if (
        p.recibido !== null ||
        p.cambio !== null ||
        p.ajuste_redondeo !== 0 ||
        p.redondeo !== null
      ) {
        problema('Solo el efectivo lleva recibido, cambio y redondeo')
      }
      if (
        p.ajuste_redondeo !== 0 &&
        (p.redondeo === null || Math.abs(p.ajuste_redondeo) >= p.redondeo.multiplo)
      ) {
        problema('El ajuste de redondeo debe ser menor que el múltiplo de redondeo')
      }
      if (p.monto + p.ajuste_redondeo < 0) problema('Lo cobrado no puede ser negativo')
      if (p.medio === 'tarjeta' && p.datafono === null)
        problema('Un pago con tarjeta indica el datáfono')
    }),
  PagoAnulado: z.strictObject({ pago_id: Ulid, turno_caja_id: Ulid }),
  ReembolsoRegistrado: z
    .strictObject({
      pago_id: Ulid,
      reembolso_id: Ulid,
      monto_venta: Pesos,
      monto_propina: Pesos,
      medio: MedioPago,
      turno_caja_id: Ulid,
    })
    .refine((r) => r.monto_venta + r.monto_propina > 0, 'El reembolso debe ser mayor que 0'),
  PedidoCerrado: Vacio,
  PedidoReabierto: Vacio,
  PedidoCancelado: Vacio,
  // Agotado (86) y de vuelta: no son del pedido sino del producto (agregado `producto`). Van en la
  // misma secuencia para que lleguen a todos al instante, también a quien estaba sin conexión
  // (docs/MODELO_DATOS.md#eventos-de-mesa-producto-y-caja). Sin variante: todo el producto.
  ProductoAgotado: z.strictObject({ producto_id: Ulid, variante_id: Ulid.nullable() }),
  ProductoDisponible: z.strictObject({ producto_id: Ulid, variante_id: Ulid.nullable() }),
} as const

export type TipoEventoPedido = keyof typeof datosPorTipo
export const TIPOS_EVENTO_PEDIDO = Object.keys(datosPorTipo) as TipoEventoPedido[]

/** Los eventos cuyo agregado es un producto, no un pedido. */
export const TIPOS_EVENTO_PRODUCTO: readonly TipoEventoPedido[] = [
  'ProductoAgotado',
  'ProductoDisponible',
]
/** A qué agregado pertenece cada tipo de evento. */
export const agregadoDe = (tipo: TipoEventoPedido): 'pedido' | 'producto' =>
  TIPOS_EVENTO_PRODUCTO.includes(tipo) ? 'producto' : 'pedido'

/** Eventos que exigen un motivo en el sobre. */
export const TIPOS_CON_MOTIVO: readonly TipoEventoPedido[] = [
  'ItemAnulado',
  'DescuentoAplicado',
  'DescuentoRetirado',
  'PagoAnulado',
  'ReembolsoRegistrado',
  'PedidoReabierto',
  'PedidoCancelado',
]

/** Campos del sobre que pone quien crea el evento (docs/SYNC.md#sobre-del-evento). */
const sobre = {
  id: Ulid,
  version_esquema: z.literal(1),
  agregado_tipo: z.enum(['pedido', 'producto']),
  agregado_id: Ulid,
  relacionados: z.array(Ulid).max(20),
  sesion_id: Ulid.nullable(),
  usuario_id: Ulid,
  dispositivo_id: Ulid,
  autorizacion_id: Ulid.nullable(),
  motivo: Texto.nullable(),
  hora_dispositivo: HoraIso,
  hora_estimada_hub: HoraIso,
  secuencia_base: z.int().min(0),
  /**
   * HMAC del evento con el secreto de la sesión (`firmarEvento`): prueba que lo creó quien tenía
   * la sesión abierta. Solo viaja al hub; no se guarda con el evento.
   */
  firma: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
}

/** Campos que agrega el hub al aceptar el evento. */
export const Aceptacion = z.strictObject({
  secuencia: z.int().min(1),
  recibido_en: HoraIso,
  dia_operativo: Dia,
  asignaciones: z.strictObject({
    numero_dia: z.int().min(1).optional(),
    /** Número del día de cada comanda de un envío, por `comanda_id` (ADR-015). */
    numeros_comanda: z.record(Ulid, z.int().min(1)).optional(),
  }),
  afecta: z.array(Ulid).max(20),
  autorizado_por_id: Ulid.nullable(),
})

function variante<T extends TipoEventoPedido>(tipo: T) {
  return z.strictObject({ ...sobre, tipo: z.literal(tipo), datos: datosPorTipo[tipo] })
}

const variantes = TIPOS_EVENTO_PEDIDO.map(variante) as [
  ReturnType<typeof variante>,
  ...ReturnType<typeof variante>[],
]

/** El otro pedido de un evento que toca dos: destino al mover, origen al unir. */
function otroPedido(evento: { tipo: string; datos: unknown }): string | null {
  const datos = evento.datos as { pedido_destino_id?: string; pedido_origen_id?: string }
  if (evento.tipo === 'ItemsMovidos') return datos.pedido_destino_id ?? null
  if (evento.tipo === 'PedidosUnidos') return datos.pedido_origen_id ?? null
  return null
}

export const EventoPedidoNuevo = z
  .discriminatedUnion('tipo', variantes)
  .superRefine((evento, ctx) => {
    if (evento.agregado_tipo !== agregadoDe(evento.tipo)) {
      ctx.addIssue({
        code: 'custom',
        path: ['agregado_tipo'],
        message: `${evento.tipo} es de un ${agregadoDe(evento.tipo)}`,
      })
    }
    if (evento.tipo === 'ProductoAgotado' || evento.tipo === 'ProductoDisponible') {
      if (evento.agregado_id !== (evento.datos as { producto_id: string }).producto_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['agregado_id'],
          message: 'El agregado es el producto que se agota',
        })
      }
      // Si nombrara un pedido, el hub lo contaría como evento de ese pedido.
      if (evento.relacionados.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['relacionados'],
          message: 'Un evento de producto no toca pedidos',
        })
      }
    }
    if (TIPOS_CON_MOTIVO.includes(evento.tipo) && !evento.motivo) {
      ctx.addIssue({ code: 'custom', path: ['motivo'], message: `${evento.tipo} exige un motivo` })
    }
    const otro = otroPedido(evento)
    if (otro !== null && (otro === evento.agregado_id || !evento.relacionados.includes(otro))) {
      ctx.addIssue({
        code: 'custom',
        path: ['relacionados'],
        message: 'El otro pedido debe ser distinto y figurar en relacionados',
      })
    }
  })

type DatosDe<T extends TipoEventoPedido> = z.infer<(typeof datosPorTipo)[T]>
type SobreNuevo = z.infer<z.ZodObject<typeof sobre>>

/** Evento tal como lo crea un dispositivo, antes de que el hub lo acepte. */
export type EventoNuevo<T extends TipoEventoPedido = TipoEventoPedido> = {
  [K in T]: SobreNuevo & { tipo: K; datos: DatosDe<K> }
}[T]

export type DatosAceptacion = z.infer<typeof Aceptacion>

/** Evento aceptado por el hub: con secuencia y los demás campos del hub. */
export type EventoPedido<T extends TipoEventoPedido = TipoEventoPedido> = EventoNuevo<T> &
  DatosAceptacion

/**
 * Lo que acepta el reductor: un evento aceptado o uno propio aún pendiente de confirmar, que
 * el dispositivo proyecta antes de que el hub responda (docs/SYNC.md#orden-y-estado-local).
 */
export type EventoAplicable<T extends TipoEventoPedido = TipoEventoPedido> = EventoNuevo<T> &
  Partial<DatosAceptacion>

export type ResultadoValidacion =
  | { ok: true; evento: EventoNuevo }
  | { ok: false; errores: string[] }

/** Valida un evento nuevo contra su esquema. No lanza: devuelve los errores en español. */
export function validarEventoNuevo(entrada: unknown): ResultadoValidacion {
  const resultado = EventoPedidoNuevo.safeParse(entrada)
  if (resultado.success) return { ok: true, evento: resultado.data as EventoNuevo }
  return {
    ok: false,
    errores: resultado.error.issues.map((i) => `${i.path.join('.') || 'evento'}: ${i.message}`),
  }
}
