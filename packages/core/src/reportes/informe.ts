import { type CobradoPorMedio, cobradoSegun } from '../caja/turno'
import { aEntero, type ModoRedondeo, redondear } from '../dinero/aritmetica'
import type { EventoAplicable } from '../eventos/pedido'
import type { EstadoPedido } from '../pedido/estado'
import {
  type ImpuestoDiscriminado,
  impuestosDePedidos,
  precioUnidad,
  totalesItem,
  totalesPedido,
} from '../pedido/totales'

// Los reportes básicos (tarea 1.9), con las fórmulas de docs/KPIS.md. El hub junta los pedidos y
// los eventos del período; aquí solo se calcula, para que la pantalla, el CSV y el cierre Z digan
// siempre lo mismo.

export interface EntradaInforme {
  /** Días operativos del período, inclusive (AAAA-MM-DD). */
  desde: string
  hasta: string
  /**
   * Cada `PedidoCerrado` del período: el pedido al cerrarse (`despues`) y como estaba en su cierre
   * anterior (`antes`, null si es el primero). Un pedido reabierto otro día suma en ese día solo
   * la diferencia: lo ya reportado de un día no cambia (DINERO.md#día-operativo-e-informes).
   */
  cierres?: readonly { antes: EstadoPedido | null; despues: EstadoPedido }[]
  /** Atajo para pruebas: pedidos cerrados por primera vez en el período (cierres sin `antes`). */
  cerrados?: readonly EstadoPedido[]
  /** Los pedidos que nombran los eventos del período (para anulaciones y cancelaciones). */
  relacionados: readonly EstadoPedido[]
  /**
   * Por cada `ItemAnulado` (su id), el pedido tal como estaba justo antes: el ítem anulado pudo
   * pasar después a otra mesa (mover o unir) y ya no estar en su pedido.
   */
  alAnular?: ReadonlyMap<string, EstadoPedido>
  /**
   * Los eventos registrados en el período (pagos, anulaciones de pago, reembolsos, anulaciones de
   * productos, cancelaciones y movimientos de caja) y, aunque sean de otro día, los pagos que esas
   * anulaciones y reembolsos reversan.
   */
  eventos: readonly EventoAplicable[]
  config: {
    ventas_por_mesero: 'quien_agrega' | 'mesero_asignado'
    redondeo_modo: ModoRedondeo
  }
}

export interface ResumenVentas {
  bruto: number
  anulado: number
  descuentos: number
  neto: number
  /** Σ ajuste por redondeo del efectivo en los pagos de esos pedidos (DINERO.md: renglón del Z). */
  ajustes: number
  impuestos: ImpuestoDiscriminado[]
  propinas: number
  cuentas: number
  comensales: number
  ticketPromedio: number
  gastoPorComensal: number
}

export interface VentasMesero {
  usuarioId: string
  neto: number
  cuentas: number
  ticketPromedio: number
}

export interface VentasProducto {
  productoId: string
  varianteId: string | null
  nombre: string
  unidades: number
  neto: number
}

export interface Anulacion {
  eventoId: string
  pedidoId: string
  /** El número del pedido en su día, si se sabe. */
  pedidoNumero: number | null
  nombre: string
  unidades: number
  valor: number
  motivo: string | null
  yaPreparado: boolean
  usuarioId: string
  autorizadoPorId: string | null
  hora: string
}

export interface Cancelacion {
  eventoId: string
  pedidoId: string
  pedidoNumero: number | null
  valor: number
  motivo: string | null
  usuarioId: string
  autorizadoPorId: string | null
  hora: string
}

export interface DescuentoInforme {
  pedidoId: string
  pedidoNumero: number | null
  regla: 'porcentaje' | 'valor' | 'cortesia'
  valor: number
  monto: number
  motivo: string | null
}

export interface Informe {
  desde: string
  hasta: string
  ventas: ResumenVentas
  porMedio: CobradoPorMedio[]
  porMesero: VentasMesero[]
  porProducto: VentasProducto[]
  anulaciones: Anulacion[]
  cancelaciones: Cancelacion[]
  descuentos: DescuentoInforme[]
  fondoPropinas: { propinas: number; pagadas: number; saldo: number }
}

/** a ÷ b redondeado a pesos con el modo del restaurante; 0 si b es 0. Con a negativo, simétrico. */
function promedio(a: number, b: number, modo: ModoRedondeo): number {
  if (b === 0) return 0
  const abs = aEntero(redondear(BigInt(Math.abs(a)), BigInt(b), modo))
  return a < 0 ? -abs : abs
}

const horaDe = (e: EventoAplicable) => e.recibido_en ?? e.hora_estimada_hub

/** Si un día operativo (AAAA-MM-DD) cae en el período. */
const enPeriodo = (dia: string | undefined, desde: string, hasta: string) =>
  dia !== undefined && dia >= desde && dia <= hasta

export function informe(entrada: EntradaInforme): Informe {
  const { config, desde, hasta } = entrada
  const modo = config.redondeo_modo
  const cierres = [
    ...(entrada.cierres ?? []),
    ...(entrada.cerrados ?? []).map((despues) => ({ antes: null, despues })),
  ]

  // Ventas: lo que sumó cada cierre del período (el pedido al cerrar menos su cierre anterior).
  let bruto = 0
  let anulado = 0
  let descuentos = 0
  let neto = 0
  let ajustes = 0
  let propinas = 0
  let cuentas = 0
  let comensales = 0
  const meseros = new Map<string, { neto: number; pedidos: Set<string> }>()
  const productos = new Map<string, VentasProducto>()
  const listaDescuentos: DescuentoInforme[] = []
  const sumar = (p: EstadoPedido, signo: 1 | -1, primero: boolean) => {
    const t = totalesPedido(p)
    bruto += signo * t.bruto
    anulado += signo * t.anulado
    descuentos += signo * t.descuento
    neto += signo * t.neto
    ajustes += signo * t.ajustes
    propinas += signo * t.propinas
    // Una cuenta y sus comensales se cuentan una vez: en el primer cierre.
    if (primero) {
      comensales += p.comensales
      if (t.neto > 0) cuentas += 1
    }
    for (const item of Object.values(p.items)) {
      const ti = totalesItem(p, item)
      const mesero =
        config.ventas_por_mesero === 'quien_agrega' ? item.agregadoPor : p.meseroAsignadoId
      const m = meseros.get(mesero) ?? { neto: 0, pedidos: new Set<string>() }
      m.neto += signo * ti.neto
      if (primero && ti.neto > 0) m.pedidos.add(p.id)
      meseros.set(mesero, m)
      const unidades = Math.max(0, item.cantidad - item.cantidadAnulada)
      if (unidades === 0 && ti.neto === 0) continue
      const clave = `${item.productoId}:${item.varianteId ?? ''}`
      const v = productos.get(clave) ?? {
        productoId: item.productoId,
        varianteId: item.varianteId,
        nombre: item.nombre,
        unidades: 0,
        neto: 0,
      }
      v.unidades += signo * unidades
      v.neto += signo * ti.neto
      productos.set(clave, v)
    }
  }
  const montoDe = (d: EstadoPedido['descuentos'][string]) =>
    Object.values(d.montos).reduce((a, b) => a + b, 0)
  for (const { antes, despues } of cierres) {
    sumar(despues, 1, antes === null)
    if (antes) sumar(antes, -1, false)
    // Los descuentos nuevos desde el cierre anterior; uno quitado al reabrir resta.
    for (const d of Object.values(despues.descuentos))
      if (!antes?.descuentos[d.id])
        listaDescuentos.push({
          pedidoId: despues.id,
          pedidoNumero: despues.numeroDia,
          regla: d.regla,
          valor: d.valor,
          monto: montoDe(d),
          motivo: d.motivo,
        })
    for (const d of Object.values(antes?.descuentos ?? {}))
      if (!despues.descuentos[d.id])
        listaDescuentos.push({
          pedidoId: despues.id,
          pedidoNumero: despues.numeroDia,
          regla: d.regla,
          valor: d.valor,
          monto: -montoDe(d),
          motivo: d.motivo,
        })
  }

  // Lo registrado en el período: pagos por medio, anulaciones, cancelaciones y el fondo.
  const delPeriodo = (e: EventoAplicable) => enPeriodo(e.dia_operativo, desde, hasta)
  const porMedio = cobradoSegun(entrada.eventos, delPeriodo)
  const pedidosPorId = new Map(
    [...entrada.relacionados, ...cierres.map((c) => c.despues)].map((p) => [p.id, p] as const),
  )
  const anulaciones: Anulacion[] = []
  const cancelaciones: Cancelacion[] = []
  let pagadas = 0
  for (const e of entrada.eventos) {
    if (!delPeriodo(e)) continue
    if (e.tipo === 'ItemAnulado') {
      const pedido = entrada.alAnular?.get(e.id) ?? pedidosPorId.get(e.agregado_id)
      const item = pedido?.items[e.datos.item_id]
      anulaciones.push({
        eventoId: e.id,
        pedidoId: e.agregado_id,
        pedidoNumero: pedido?.numeroDia ?? null,
        nombre: item?.nombre ?? 'Producto',
        unidades: e.datos.cantidad,
        valor: item ? e.datos.cantidad * precioUnidad(item) : 0,
        motivo: e.motivo,
        yaPreparado: e.datos.ya_preparado,
        usuarioId: e.usuario_id,
        autorizadoPorId: e.autorizado_por_id ?? null,
        hora: horaDe(e),
      })
    } else if (e.tipo === 'PedidoCancelado') {
      const pedido = pedidosPorId.get(e.agregado_id)
      cancelaciones.push({
        eventoId: e.id,
        pedidoId: e.agregado_id,
        pedidoNumero: pedido?.numeroDia ?? null,
        valor: pedido ? totalesPedido(pedido).neto : 0,
        motivo: e.motivo,
        usuarioId: e.usuario_id,
        autorizadoPorId: e.autorizado_por_id ?? null,
        hora: horaDe(e),
      })
    } else if (e.tipo === 'MovimientoCajaRegistrado' && e.datos.tipo === 'pago_propinas') {
      pagadas += e.datos.monto
    }
  }
  const propinasRegistradas = porMedio.reduce((a, m) => a + m.propina, 0)

  return {
    desde,
    hasta,
    ventas: {
      bruto,
      anulado,
      descuentos,
      neto,
      ajustes,
      impuestos: impuestosDePedidos(
        cierres.map((c) => c.despues),
        modo,
        cierres.flatMap((c) => (c.antes ? [c.antes] : [])),
      ),
      propinas,
      cuentas,
      comensales,
      ticketPromedio: promedio(neto, cuentas, modo),
      gastoPorComensal: promedio(neto, comensales, modo),
    },
    porMedio,
    porMesero: [...meseros]
      .filter(([, m]) => m.neto !== 0 || m.pedidos.size > 0)
      .map(([usuarioId, m]) => ({
        usuarioId,
        neto: m.neto,
        cuentas: m.pedidos.size,
        ticketPromedio: promedio(m.neto, m.pedidos.size, modo),
      }))
      .sort((a, b) => b.neto - a.neto),
    porProducto: [...productos.values()]
      .filter((p) => p.unidades !== 0 || p.neto !== 0)
      .sort((a, b) => b.neto - a.neto || b.unidades - a.unidades),
    anulaciones,
    cancelaciones,
    descuentos: listaDescuentos,
    fondoPropinas: {
      propinas: propinasRegistradas,
      pagadas,
      saldo: propinasRegistradas - pagadas,
    },
  }
}
