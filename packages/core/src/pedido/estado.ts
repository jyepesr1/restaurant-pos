import type { Canal, Curso, MedioPago, TipoImpuesto } from '../eventos/comun'

export type EstadoItem =
  | 'retenido'
  | 'pendiente'
  | 'enviado'
  | 'en_preparacion'
  | 'listo'
  | 'entregado'
  | 'anulado'

export interface ModificadorItem {
  modificadorId: string
  nombre: string
  precioExtra: number
}

export interface ItemPedido {
  id: string
  productoId: string
  varianteId: string | null
  nombre: string
  precioUnitario: number
  impuestoTipo: TipoImpuesto
  tarifa: number
  cantidad: number
  cantidadAnulada: number
  comensal: number | null
  curso: Curso | null
  estado: EstadoItem
  agregadoPor: string
  notas: string | null
  modificadores: ModificadorItem[]
  /** Orden en que se agregó: desempata los repartos. */
  orden: number
}

export interface DescuentoPedido {
  id: string
  alcance: 'item' | 'pedido'
  regla: 'porcentaje' | 'valor' | 'cortesia'
  valor: number
  /** Pesos ya calculados por ítem: la proyección nunca los recalcula. */
  montos: Record<string, number>
  motivo: string | null
}

export interface Cuenta {
  id: string
  nombre: string
  monto: number
  propinaSugerida: number
}

export interface Pago {
  id: string
  cuentaId: string | null
  turnoCajaId: string
  medio: MedioPago
  monto: number
  propina: number
  ajusteRedondeo: number
  anulado: boolean
  reembolsadoVenta: number
  reembolsadoPropina: number
  /** Reembolsos ya aplicados: el mismo no se aplica dos veces. */
  reembolsoIds: string[]
}

export interface EstadoPedido {
  id: string
  canal: Canal
  mesaId: string | null
  comensales: number
  meseroAsignadoId: string
  estado: 'abierto' | 'cerrado' | 'cancelado'
  abiertoEn: string
  cerradoEn: string | null
  /** Día operativo del primer cierre (docs/DINERO.md#día-operativo-e-informes). */
  diaOperativo: string | null
  numeroDia: number | null
  rescateDe: string | null
  unidoA: string | null
  /** Nota para todo el pedido: va en cada comanda y en la cocina. */
  notas: string | null
  items: Record<string, ItemPedido>
  descuentos: Record<string, DescuentoPedido>
  cursosRetenidos: Curso[]
  cuentas: Cuenta[] | null
  pagos: Record<string, Pago>
  ultimaPrecuenta: { cuentaId: string | null; subtotal: number; propinaSugerida: number } | null
  ultimaSecuencia: number
  siguienteOrden: number
}
