import { type EventoAplicable, type EventoNuevo, nuevoId, type TipoEventoPedido } from '@pos/core'
import type { Catalogo, EstadoLocal, EventoLocal } from '@pos/sync'

// Utilidades de las pruebas de la sala: eventos locales y un catálogo mínimo, sin red ni base.

export const HORA = '2026-10-24T15:00:00.000Z'

let orden = 0
let secuencia = 0

/** Un evento local. Con `estado: 'confirmado'` lleva los campos del hub y su secuencia. */
export function local<T extends TipoEventoPedido>(
  tipo: T,
  pedidoId: string,
  datos: Extract<EventoNuevo, { tipo: T }>['datos'],
  estado: EstadoLocal = 'confirmado',
  extras: Partial<EventoNuevo> = {},
): EventoLocal {
  const base = {
    id: nuevoId(),
    tipo,
    version_esquema: 1,
    agregado_tipo: 'pedido',
    agregado_id: pedidoId,
    relacionados: [],
    datos,
    sesion_id: null,
    usuario_id: nuevoId(),
    dispositivo_id: nuevoId(),
    autorizacion_id: null,
    motivo: null,
    hora_dispositivo: HORA,
    hora_estimada_hub: HORA,
    secuencia_base: 0,
    ...extras,
  }
  const aceptado =
    estado === 'confirmado'
      ? {
          secuencia: ++secuencia,
          recibido_en: HORA,
          dia_operativo: '2026-10-24',
          asignaciones: tipo === 'PedidoAbierto' ? { numero_dia: 1 } : {},
          afecta: [],
          autorizado_por_id: null,
        }
      : {}
  return {
    evento: { ...base, ...aceptado } as EventoAplicable,
    estado,
    propio: true,
    orden: ++orden,
  }
}

export const datosItem = (campos: Record<string, unknown> = {}) => ({
  item_id: nuevoId(),
  producto_id: nuevoId(),
  variante_id: null,
  nombre: 'Limonada',
  precio_unitario: 9_900,
  impuesto_tipo: 'inc' as const,
  tarifa: 800,
  cantidad: 1,
  comensal: null,
  curso: null,
  modificadores: [],
  notas: null,
  catalogo_version: 1,
  precio_canal_id: null,
  ...campos,
})

export const apertura = { canal: 'salon' as const, mesa_id: null, comensales: 2 }

/** Catálogo mínimo: Cocina y Barra, una categoría de cada una y otra sin estación. */
export function catalogoDePrueba(campos: Partial<Catalogo> = {}): Catalogo {
  return {
    version: 4,
    restaurante: { nombre: 'Prueba', sesionInactividadMin: 30 },
    zonas: [],
    mesas: [],
    elementos: [],
    personal: [],
    estaciones: [
      { id: 'E-COCINA', nombre: 'Cocina' },
      { id: 'E-BARRA', nombre: 'Barra' },
    ],
    categorias: [],
    ...campos,
  }
}

/**
 * Numera de nuevo la secuencia de los confirmados según su posición: las pruebas arman los
 * eventos en cualquier orden, pero el hub los numera en el orden en que los acepta.
 */
export function enOrden(locales: readonly EventoLocal[]): EventoLocal[] {
  let n = 0
  return locales.map((l) =>
    l.estado === 'confirmado' ? { ...l, evento: { ...l.evento, secuencia: ++n } } : l,
  )
}
