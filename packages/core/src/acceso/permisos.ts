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

/**
 * Qué dice cada permiso en la pantalla de roles, agrupado como se ve allí. Cada restaurante
 * decide qué roles tienen cuáles (ADR-013).
 */
export const DESCRIPCION_PERMISOS: readonly {
  grupo: string
  permisos: readonly { permiso: Permiso; nombre: string }[]
}[] = [
  {
    grupo: 'Pedidos',
    permisos: [
      { permiso: 'tomar_pedido', nombre: 'Tomar y enviar pedidos' },
      { permiso: 'quitar_item_no_enviado', nombre: 'Quitar lo que aún no se envió' },
      { permiso: 'anular_item_enviado', nombre: 'Anular lo ya enviado a cocina' },
      { permiso: 'cancelar_pedido', nombre: 'Cancelar un pedido completo' },
      { permiso: 'reasignar_mesa', nombre: 'Pasar una mesa a otro mesero' },
      { permiso: 'agotar_producto', nombre: 'Marcar productos agotados' },
    ],
  },
  {
    grupo: 'Cuenta y cobro',
    permisos: [
      { permiso: 'descontar', nombre: 'Dar descuentos' },
      { permiso: 'cortesia', nombre: 'Dar cortesías' },
      { permiso: 'dividir_cuenta', nombre: 'Dividir la cuenta' },
      { permiso: 'registrar_pago', nombre: 'Cobrar' },
      { permiso: 'anular_pago', nombre: 'Anular pagos y reembolsar' },
      { permiso: 'cerrar_mesa', nombre: 'Cerrar mesas' },
      { permiso: 'reabrir_cuenta', nombre: 'Reabrir una cuenta cerrada' },
    ],
  },
  {
    grupo: 'Caja',
    permisos: [
      { permiso: 'abrir_turno_caja', nombre: 'Abrir turno de caja' },
      { permiso: 'cerrar_turno_caja', nombre: 'Cerrar turno de caja' },
      { permiso: 'movimiento_caja', nombre: 'Entradas y salidas de efectivo' },
      { permiso: 'abrir_cajon_sin_venta', nombre: 'Abrir el cajón sin venta' },
    ],
  },
  {
    grupo: 'Cocina',
    permisos: [{ permiso: 'marcar_preparacion', nombre: 'Marcar platos en preparación y listos' }],
  },
  {
    grupo: 'Administración',
    permisos: [
      { permiso: 'editar_catalogo', nombre: 'Editar la carta y el plano' },
      { permiso: 'editar_precios', nombre: 'Cambiar precios' },
      { permiso: 'administrar_usuarios', nombre: 'Personal y roles (equivale a poder todo)' },
      { permiso: 'administrar_dispositivos', nombre: 'Retirar celulares y equipos' },
    ],
  },
  {
    grupo: 'Reportes',
    permisos: [
      { permiso: 'ver_reportes', nombre: 'Ver todos los reportes' },
      { permiso: 'ver_reportes_propios', nombre: 'Ver sus propias ventas' },
    ],
  },
]

/**
 * Permisos que no se pueden usar entrando solo con un PIN de 4 dígitos: quien tenga alguno entra
 * con usuario y contraseña (ADR-013). Un PIN se adivina más fácil que una contraseña, y estos
 * mueven plata, cambian la carta o administran el local.
 */
export const PERMISOS_CON_CONTRASENA: ReadonlySet<Permiso> = new Set<Permiso>([
  'registrar_pago',
  'anular_pago',
  'cerrar_mesa',
  'reabrir_cuenta',
  'abrir_turno_caja',
  'cerrar_turno_caja',
  'movimiento_caja',
  'abrir_cajon_sin_venta',
  'editar_catalogo',
  'editar_precios',
  'administrar_usuarios',
  'administrar_dispositivos',
  'ver_reportes',
])

/** Permisos de cobro: quien entra con alguno vuelve de caja el equipo (pagos y cierres). */
export const PERMISOS_DE_COBRO: ReadonlySet<Permiso> = new Set<Permiso>([
  'registrar_pago',
  'anular_pago',
  'cerrar_mesa',
])

/**
 * Lo único que puede hacer una pantalla de cocina (ADR-015): marcar listo, recuperar lo marcado
 * por error y marcar agotados. Su usuario técnico tiene un rol oculto con estos permisos.
 */
export const PERMISOS_PANTALLA: readonly Permiso[] = ['marcar_preparacion', 'agotar_producto']

export type ClaveRol = 'admin' | 'cajero' | 'reportes' | 'mesero'

/**
 * Roles con los que nace cada restaurante (ADR-013). Son un punto de partida: el administrador
 * cambia sus permisos y crea los roles que quiera. No se archivan.
 */
export const ROLES_DE_FABRICA: Record<ClaveRol, { nombre: string; permisos: readonly Permiso[] }> =
  {
    admin: { nombre: 'Administrador', permisos: todosMenos('ver_reportes_propios') },
    cajero: {
      nombre: 'Cajero',
      permisos: [
        'tomar_pedido',
        'quitar_item_no_enviado',
        'anular_item_enviado',
        'descontar',
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
    reportes: { nombre: 'Reportes', permisos: ['ver_reportes'] },
    mesero: {
      nombre: 'Mesero',
      permisos: [
        'tomar_pedido',
        'quitar_item_no_enviado',
        'marcar_preparacion',
        'ver_reportes_propios',
      ],
    },
  }

/**
 * Roles de fábrica de antes de ADR-013. Al arrancar, un hub que los tenga los convierte: Contador
 * pasa a llamarse Reportes, y Gerente y Cocina quedan como roles propios del restaurante (con sus
 * permisos y su gente), que el administrador puede cambiar o archivar.
 */
export const ROLES_RETIRADOS = {
  renombrar: { Contador: 'Reportes' },
  propios: ['Gerente', 'Cocina'],
} as const

/** `null`: ningún dispositivo puede crearlo; solo lo emite el hub. */
const PERMISO_POR_TIPO: Record<TipoEventoPedido, Permiso | null> = {
  PedidoAbierto: 'tomar_pedido',
  PedidoRescateCreado: null,
  MeseroAsignado: 'reasignar_mesa',
  ComensalesCambiados: 'tomar_pedido',
  NotaPedidoCambiada: 'tomar_pedido',
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
  MesasUnidas: 'tomar_pedido',
  MesasSeparadas: 'tomar_pedido',
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
  TurnoAbierto: 'abrir_turno_caja',
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
  'TurnoAbierto',
  'PagoRegistrado',
  'PagoAnulado',
  'ReembolsoRegistrado',
  'PedidoCerrado',
])
