import type { EventoNuevo, TipoEventoPedido } from '../eventos/pedido'
import type { EstadoPedido } from '../pedido/estado'

// Permisos y roles de fábrica (docs/MODELO_DATOS.md#permisos). Las claves son fijas; cada
// restaurante solo decide qué roles las tienen (`RolPermiso`).

export const PERMISOS = [
  'tomar_pedido',
  'quitar_item_no_enviado',
  'anular_item_enviado',
  'cancelar_pedido',
  'descontar',
  'cortesia',
  'reasignar_mesa',
  'dividir_cuenta',
  'registrar_pago',
  'anular_pago',
  'cerrar_mesa',
  'reabrir_cuenta',
  'abrir_turno_caja',
  'cerrar_turno_caja',
  'movimiento_caja',
  'abrir_cajon_sin_venta',
  'marcar_preparacion',
  'agotar_producto',
  'editar_catalogo',
  'editar_precios',
  'administrar_usuarios',
  'administrar_dispositivos',
  'ver_reportes',
  'ver_reportes_propios',
] as const

export type Permiso = (typeof PERMISOS)[number]

export const esPermiso = (valor: unknown): valor is Permiso =>
  typeof valor === 'string' && (PERMISOS as readonly string[]).includes(valor)

const todosMenos = (...fuera: Permiso[]) => PERMISOS.filter((p) => !fuera.includes(p))

export type ClaveRol = 'admin' | 'gerente' | 'cajero' | 'mesero' | 'cocina' | 'contador'

/** Roles con los que nace cada restaurante. No se archivan; sus permisos sí se pueden ajustar. */
export const ROLES_DE_FABRICA: Record<ClaveRol, { nombre: string; permisos: readonly Permiso[] }> =
  {
    admin: { nombre: 'Administrador', permisos: todosMenos('ver_reportes_propios') },
    gerente: {
      nombre: 'Gerente',
      permisos: todosMenos(
        'administrar_usuarios',
        'administrar_dispositivos',
        'ver_reportes_propios',
      ),
    },
    cajero: {
      nombre: 'Cajero',
      permisos: [
        'tomar_pedido',
        'quitar_item_no_enviado',
        'reasignar_mesa',
        'dividir_cuenta',
        'registrar_pago',
        'cerrar_mesa',
        'abrir_turno_caja',
        'cerrar_turno_caja',
        'movimiento_caja',
        'agotar_producto',
        'ver_reportes_propios',
      ],
    },
    mesero: {
      nombre: 'Mesero',
      permisos: [
        'tomar_pedido',
        'quitar_item_no_enviado',
        'marcar_preparacion',
        'ver_reportes_propios',
      ],
    },
    cocina: { nombre: 'Cocina', permisos: ['marcar_preparacion', 'agotar_producto'] },
    contador: { nombre: 'Contador', permisos: ['ver_reportes'] },
  }

/** `null`: ningún dispositivo puede crearlo; solo lo emite el hub. */
const PERMISO_POR_TIPO: Record<TipoEventoPedido, Permiso | null> = {
  PedidoAbierto: 'tomar_pedido',
  PedidoRescateCreado: null,
  MeseroAsignado: 'reasignar_mesa',
  ComensalesCambiados: 'tomar_pedido',
  ItemAgregado: 'tomar_pedido',
  ItemCambiado: 'tomar_pedido',
  ItemQuitado: 'quitar_item_no_enviado',
  ItemsEnviados: 'tomar_pedido',
  ItemModificadoTrasEnvio: 'tomar_pedido',
  ComandaReimpresa: 'tomar_pedido',
  CursoRetenido: 'tomar_pedido',
  CursoMarchado: 'tomar_pedido',
  ItemEnPreparacion: 'marcar_preparacion',
  ItemListo: 'marcar_preparacion',
  ItemEntregado: 'marcar_preparacion',
  ItemDevueltoACola: 'marcar_preparacion',
  ItemAnulado: 'anular_item_enviado',
  ItemsMovidos: 'tomar_pedido',
  PedidoMovidoDeMesa: 'tomar_pedido',
  PedidosUnidos: 'tomar_pedido',
  DescuentoAplicado: 'descontar',
  DescuentoRetirado: 'descontar',
  PrecuentaImpresa: 'tomar_pedido',
  CuentaDividida: 'dividir_cuenta',
  DivisionDeshecha: 'dividir_cuenta',
  PagoRegistrado: 'registrar_pago',
  PagoAnulado: 'anular_pago',
  ReembolsoRegistrado: 'anular_pago',
  PedidoCerrado: 'cerrar_mesa',
  PedidoReabierto: 'reabrir_cuenta',
  PedidoCancelado: 'cancelar_pedido',
  ProductoAgotado: 'agotar_producto',
  ProductoDisponible: 'agotar_producto',
}

const sumaExtras = (precios: readonly number[]) => precios.reduce((a, b) => a + b, 0)

/**
 * Permiso que exige crear ese evento. Algunos dependen del contenido y del estado del pedido:
 * cambiar los modificadores de un ítem ya enviado de modo que cueste menos es una anulación
 * parcial, no un cambio cualquiera.
 */
export function permisoPara(
  evento: EventoNuevo,
  pedido: EstadoPedido | null = null,
): Permiso | null {
  if (evento.tipo === 'DescuentoAplicado' && evento.datos.regla === 'cortesia') return 'cortesia'
  if (evento.tipo === 'ItemModificadoTrasEnvio' && evento.datos.modificadores) {
    const item = pedido?.items[evento.datos.item_id]
    const antes = sumaExtras(item?.modificadores.map((m) => m.precioExtra) ?? [])
    const despues = sumaExtras(evento.datos.modificadores.map((m) => m.precio_extra))
    if (item && despues < antes) return 'anular_item_enviado'
  }
  return PERMISO_POR_TIPO[evento.tipo]
}

/** Pagos y cierres solo salen de un dispositivo de caja (docs/MODELO_DATOS.md#permisos). */
export const SOLO_DESDE_CAJA: ReadonlySet<TipoEventoPedido> = new Set([
  'PagoRegistrado',
  'PagoAnulado',
  'ReembolsoRegistrado',
  'PedidoCerrado',
])
