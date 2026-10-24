import { type EventoPedido, type TipoEventoPedido, validarEventoNuevo } from '../eventos/pedido'
import { nuevoId } from '../id'

// Fábrica de eventos para las pruebas: cada evento pasa por el esquema real, así que una prueba
// nunca usa un evento que el hub rechazaría por formato.

export const HORA = '2026-10-24T20:00:00.000Z'
export const MESERO = nuevoId()
export const DISPOSITIVO = nuevoId()
export const TURNO = nuevoId()

let secuencia = 0

type Datos<T extends TipoEventoPedido> = Extract<EventoPedido, { tipo: T }>['datos']

const CAMPOS_HUB = [
  'secuencia',
  'recibido_en',
  'dia_operativo',
  'asignaciones',
  'afecta',
  'autorizado_por_id',
]

/** Al mover o unir, la copia de un ítem no lleva los campos de catálogo de ItemAgregado. */
function limpiarMovidos(datos: unknown): unknown {
  const d = datos as { items?: { item: Record<string, unknown> }[] }
  if (!Array.isArray(d.items)) return datos
  return {
    ...d,
    items: d.items.map((m) => {
      const { catalogo_version: _c, precio_canal_id: _p, ...item } = m.item
      return { ...m, item }
    }),
  }
}

export function evento<T extends TipoEventoPedido>(
  pedidoId: string,
  tipo: T,
  datos: Datos<T>,
  extras: Partial<EventoPedido> = {},
): Extract<EventoPedido, { tipo: T }> {
  const delHub = Object.fromEntries(Object.entries(extras).filter(([k]) => CAMPOS_HUB.includes(k)))
  const delSobre = Object.fromEntries(
    Object.entries(extras).filter(([k]) => !CAMPOS_HUB.includes(k)),
  )
  const otro =
    (datos as { pedido_destino_id?: string; pedido_origen_id?: string }).pedido_destino_id ??
    (datos as { pedido_origen_id?: string }).pedido_origen_id
  const nuevo = {
    id: nuevoId(),
    tipo,
    version_esquema: 1,
    agregado_tipo: 'pedido',
    agregado_id: pedidoId,
    // Mover y unir nombran al otro pedido en relacionados (lo exige el esquema).
    relacionados: otro && otro !== pedidoId ? [otro] : [],
    datos: limpiarMovidos(datos),
    sesion_id: null,
    usuario_id: MESERO,
    dispositivo_id: DISPOSITIVO,
    autorizacion_id: null,
    motivo: null,
    hora_dispositivo: HORA,
    hora_estimada_hub: HORA,
    secuencia_base: 0,
    ...delSobre,
  }
  const validacion = validarEventoNuevo(nuevo)
  if (!validacion.ok) throw new Error(`Evento de prueba inválido: ${validacion.errores.join('; ')}`)
  secuencia += 1
  return {
    ...nuevo,
    secuencia: secuencia,
    recibido_en: HORA,
    dia_operativo: '2026-10-24',
    asignaciones: {},
    afecta: [],
    autorizado_por_id: null,
    ...delHub,
  } as unknown as Extract<EventoPedido, { tipo: T }>
}

/**
 * El mismo evento con un id y una secuencia nuevos: para volver a aplicar un evento ya creado a
 * un estado que avanzó (el reductor ignora secuencias ya aplicadas).
 */
export function deNuevo<E extends EventoPedido>(e: E): E {
  secuencia += 1
  return { ...e, id: nuevoId(), secuencia }
}

/**
 * El evento con la siguiente secuencia, conservando su id: los ayudantes de prueba lo usan para
 * aplicar los eventos en el orden en que se listan, aunque se hayan creado en otro orden. Si el
 * evento ya tiene una secuencia mayor que la del estado, se deja igual.
 */
export function enOrden<E extends EventoPedido>(e: E, ultimaSecuencia: number): E {
  if (e.secuencia > ultimaSecuencia) return e
  secuencia = Math.max(secuencia, ultimaSecuencia) + 1
  return { ...e, secuencia }
}

export function copiaItem(campos: Partial<Datos<'ItemAgregado'>> = {}): Datos<'ItemAgregado'> {
  return {
    item_id: nuevoId(),
    producto_id: nuevoId(),
    variante_id: null,
    nombre: 'Garden Margarita',
    precio_unitario: 40_900,
    impuesto_tipo: 'inc',
    tarifa: 800,
    cantidad: 1,
    comensal: null,
    curso: null,
    modificadores: [],
    notas: null,
    catalogo_version: 1,
    precio_canal_id: null,
    ...campos,
  }
}

export function pagoEfectivo(
  monto: number,
  campos: Partial<Datos<'PagoRegistrado'>> = {},
): Datos<'PagoRegistrado'> {
  const ajuste = campos.ajuste_redondeo ?? 0
  const propina = campos.propina ?? 0
  const cambio = campos.cambio ?? 0
  return {
    pago_id: nuevoId(),
    cuenta_id: null,
    turno_caja_id: TURNO,
    medio: 'efectivo',
    monto,
    propina,
    recibido: monto + ajuste + propina + cambio,
    cambio,
    ajuste_redondeo: ajuste,
    redondeo: ajuste === 0 ? null : { multiplo: 100, modo: 'cercano_mitad_abajo' },
    datafono: null,
    referencia_cobro: null,
    ...campos,
  }
}

export function pagoTarjeta(
  monto: number,
  campos: Partial<Datos<'PagoRegistrado'>> = {},
): Datos<'PagoRegistrado'> {
  return {
    pago_id: nuevoId(),
    cuenta_id: null,
    turno_caja_id: TURNO,
    medio: 'tarjeta',
    monto,
    propina: 0,
    recibido: null,
    cambio: null,
    ajuste_redondeo: 0,
    redondeo: null,
    datafono: {
      datafono_id: nuevoId(),
      franquicia: 'Visa',
      ultimos4: '4242',
      aprobacion: '123456',
      recibo: null,
    },
    referencia_cobro: null,
    ...campos,
  }
}
