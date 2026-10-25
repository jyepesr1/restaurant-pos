import fc from 'fast-check'
import { expect } from 'vitest'
import {
  cobradoEnEfectivo,
  cortesia,
  partesIguales,
  porcentaje,
  repartirDescuentoPedido,
} from '../dinero'
import type { EventoPedido } from '../eventos/pedido'
import { nuevoId } from '../id'
import { aplicarEvento } from '../pedido/aplicar'
import type { EstadoItem, EstadoPedido, ItemPedido } from '../pedido/estado'
import { saldoCuenta, totalesItem, totalesPedido } from '../pedido/totales'
import { congelar } from './congelar'
import { copiaItem, evento, MESERO, pagoEfectivo, pagoTarjeta, TURNO } from './fabrica'

// Simulador de servicio con dos pedidos (A y B) para pruebas de propiedades. Una `Accion` es una
// tupla de enteros que se interpreta contra el estado actual (así casi todas las acciones son
// eventos aplicables y fast-check puede reducir los casos fallidos). Cada estado y cada evento
// se congela en profundidad: si el reductor modifica su entrada, lanza y queda como
// `evento_invalido`, que el simulador cuenta en `invalidos`.

export interface Accion {
  tipo: number
  /** Pedido sobre el que actúa (origen en mover y unir). */
  p: 0 | 1
  a: number
  b: number
  c: number
}

export const TIPOS_ACCION = 27

// Más peso a agregar, enviar y cobrar para llegar a estados profundos; cerrar y cancelar pesan
// poco porque terminan el pedido.
const PESOS: readonly [number, number][] = [
  [0, 8],
  [1, 6],
  [13, 6],
  [24, 4],
  [4, 3],
  [5, 2],
  [6, 2],
  [7, 2],
  [8, 3],
  [9, 2],
  [10, 1],
  [11, 2],
  [12, 1],
  [14, 1],
  [15, 2],
  [16, 1],
  [17, 2],
  [18, 1],
  [19, 3],
  [20, 1],
  [25, 1],
]
const TIPOS_PONDERADOS = PESOS.flatMap(([tipo, peso]) => Array<number>(peso).fill(tipo))
for (let t = 0; t < TIPOS_ACCION; t++) if (!TIPOS_PONDERADOS.includes(t)) TIPOS_PONDERADOS.push(t)

export const accionArb: fc.Arbitrary<Accion> = fc.record({
  tipo: fc.constantFrom(...TIPOS_PONDERADOS),
  p: fc.constantFrom<0 | 1>(0, 1),
  a: fc.nat(999),
  b: fc.nat(999),
  c: fc.nat(999),
})

/** Movimiento entre pedidos que ambos aceptaron: antes y después de los dos estados. */
export interface Movimiento {
  tipo: 'ItemsMovidos' | 'PedidosUnidos'
  origen: 0 | 1
  destino: 0 | 1
  evento: EventoPedido
  antes: readonly [EstadoPedido, EstadoPedido]
  despues: readonly [EstadoPedido, EstadoPedido]
}

const PRECIOS = [0, 200, 12_900, 12_950, 14_900, 16_000, 29_900, 40_900, 100_000]
const TARIFAS = [800, 1900, 0] as const
const CURSOS = [null, 'entrada', 'fuerte', 'postre'] as const
const BPS = [500, 1000, 1500, 5000, 9500, 10_000]
const DIAS = ['2026-10-24', '2026-10-25']

const ACTIVOS: readonly EstadoItem[] = [
  'retenido',
  'pendiente',
  'enviado',
  'en_preparacion',
  'listo',
  'entregado',
]

const itemsDe = (estado: EstadoPedido): ItemPedido[] =>
  Object.values(estado.items).sort((x, y) => x.orden - y.orden)

const elegir = <T>(lista: readonly T[], n: number): T | undefined => lista[n % lista.length]

/** Neto de la línea después de sus propios descuentos, sin los del pedido. */
function netoTrasLinea(estado: EstadoPedido, item: ItemPedido): number {
  const t = totalesItem(estado, item)
  const delPedido = Object.values(estado.descuentos)
    .filter((d) => d.alcance === 'pedido')
    .reduce((a, d) => a + (d.montos[item.id] ?? 0), 0)
  return t.neto + delPedido
}

/** Lo que un pago sin cuenta, o con ella, puede cubrir hoy. */
function disponible(estado: EstadoPedido, cuentaId: string | null): number {
  if (cuentaId === null && estado.cuentas) {
    const enCuentas = estado.cuentas.reduce(
      (a, c) => a + Math.max(0, saldoCuenta(estado, c.id) ?? 0),
      0,
    )
    return totalesPedido(estado).saldo - enCuentas
  }
  return saldoCuenta(estado, cuentaId) ?? 0
}

const aCopia = (it: ItemPedido) => ({
  item_id: it.id,
  producto_id: it.productoId,
  variante_id: it.varianteId,
  nombre: it.nombre,
  precio_unitario: it.precioUnitario,
  impuesto_tipo: it.impuestoTipo,
  tarifa: it.tarifa,
  cantidad: it.cantidad,
  comensal: it.comensal,
  curso: it.curso,
  modificadores: it.modificadores.map((m) => ({
    modificador_id: m.modificadorId,
    nombre: m.nombre,
    precio_extra: m.precioExtra,
  })),
  notas: it.notas,
})

const aMovido = (it: ItemPedido) => ({
  item: aCopia(it),
  estado: it.estado as Exclude<EstadoItem, 'anulado'>,
  cantidad_anulada: it.cantidadAnulada,
  agregado_por: it.agregadoPor,
})

type Plan =
  | { clase: 'solo'; p: 0 | 1; evento: EventoPedido }
  | { clase: 'cruzado'; origen: 0 | 1; destino: 0 | 1; evento: EventoPedido }

export class Servicio {
  readonly pedidos: readonly [string, string] = [nuevoId(), nuevoId()]
  readonly turnos: readonly [string, string] = [TURNO, nuevoId()]
  estados: [EstadoPedido | null, EstadoPedido | null] = [null, null]
  /** Todos los eventos emitidos que el hub habría aceptado, en orden de secuencia. */
  readonly log: EventoPedido[] = []
  /** Eventos que el reductor aplicó sin problema, en cualquiera de los dos pedidos. */
  readonly aplicados: EventoPedido[] = []
  readonly movimientos: Movimiento[] = []
  readonly tiposAplicados = new Set<string>()
  readonly problemas = new Map<string, number>()
  /** Eventos válidos que el reductor trató como inválidos (lanzó, p. ej. por mutar su entrada). */
  readonly invalidos: string[] = []
  /** Eventos entre pedidos que un pedido aceptó y el otro no: el hub los habría rechazado. */
  descartados = 0

  constructor() {
    for (const p of [0, 1] as const) {
      this.aplicarSolo(
        p,
        evento(this.pedidos[p], 'PedidoAbierto', {
          canal: 'salon',
          mesa_id: nuevoId(),
          comensales: 2,
        }),
      )
    }
  }

  private aplicar(p: 0 | 1, e: EventoPedido) {
    const previo = this.estados[p]
    const copiaPrevia = previo ? structuredClone(previo) : null
    const r = aplicarEvento(previo, e)
    // La entrada no cambia, ni siquiera un campo.
    expect(previo).toEqual(copiaPrevia)
    if (r.problema) {
      this.problemas.set(r.problema.tipo, (this.problemas.get(r.problema.tipo) ?? 0) + 1)
      if (r.problema.tipo === 'evento_invalido') {
        this.invalidos.push(`${e.tipo}: ${r.problema.descripcion}`)
      }
    }
    return r
  }

  private confirmar(p: 0 | 1, estado: EstadoPedido | null) {
    this.estados[p] = estado ? congelar(estado) : null
  }

  private aplicarSolo(p: 0 | 1, e: EventoPedido) {
    congelar(e)
    const r = this.aplicar(p, e)
    this.confirmar(p, r.estado)
    this.log.push(e)
    if (!r.problema) {
      this.aplicados.push(e)
      this.tiposAplicados.add(e.tipo)
    }
  }

  private aplicarCruzado(origen: 0 | 1, destino: 0 | 1, e: EventoPedido) {
    congelar(e)
    const antes = [this.estados[0], this.estados[1]] as const
    const ro = this.aplicar(origen, e)
    const rd = this.aplicar(destino, e)
    if (!ro.problema !== !rd.problema) {
      this.descartados += 1
      return
    }
    this.log.push(e)
    if (ro.problema) return
    this.confirmar(origen, ro.estado)
    this.confirmar(destino, rd.estado)
    this.aplicados.push(e)
    this.tiposAplicados.add(e.tipo)
    this.movimientos.push({
      tipo: e.tipo as Movimiento['tipo'],
      origen,
      destino,
      evento: e,
      antes: antes as unknown as Movimiento['antes'],
      despues: [this.estados[0], this.estados[1]] as unknown as Movimiento['despues'],
    })
  }

  private turno(n: number): string {
    return this.turnos[n % 2] ?? TURNO
  }

  paso(accion: Accion) {
    const plan = this.planear(accion)
    if (!plan) return
    if (plan.clase === 'solo') this.aplicarSolo(plan.p, plan.evento)
    else this.aplicarCruzado(plan.origen, plan.destino, plan.evento)
  }

  private planear({ tipo, p, a, b, c }: Accion): Plan | null {
    const est = this.estados[p]
    if (!est) return null
    const id = this.pedidos[p]
    const q: 0 | 1 = p === 0 ? 1 : 0
    const items = itemsDe(est)
    const vivos = items.filter((i) => i.estado !== 'anulado')
    const solo = (e: EventoPedido): Plan => ({ clase: 'solo', p, evento: e })
    const item = elegir(items, a)
    const motivo = { motivo: 'Motivo de prueba' }

    switch (tipo) {
      case 0: {
        const tarifa = TARIFAS[c % TARIFAS.length] ?? 800
        return solo(
          evento(
            id,
            'ItemAgregado',
            copiaItem({
              precio_unitario: PRECIOS[a % PRECIOS.length] ?? 0,
              cantidad: 1 + (b % 4),
              tarifa,
              impuesto_tipo: tarifa === 0 ? 'exento' : tarifa === 1900 ? 'iva' : 'inc',
              curso: CURSOS[(a + c) % CURSOS.length] ?? null,
              modificadores:
                b % 2 === 0
                  ? []
                  : [
                      {
                        modificador_id: nuevoId(),
                        nombre: 'Extra',
                        precio_extra: b % 4 === 1 ? 3000 : 0,
                      },
                    ],
            }),
          ),
        )
      }
      case 1: {
        const pendientes = items.filter((i) => i.estado === 'pendiente')
        const ids = b % 2 === 0 ? pendientes.map((i) => i.id) : [elegir(items, a)?.id]
        const validos = ids.filter((x): x is string => x !== undefined)
        return validos.length ? solo(enviarEvento(id, validos)) : null
      }
      case 2:
        return item ? solo(evento(id, 'ItemQuitado', { item_id: item.id })) : null
      case 3:
        return item
          ? solo(evento(id, 'ItemCambiado', { item_id: item.id, cantidad: 1 + (b % 5) }))
          : null
      case 4:
        return item
          ? solo(
              evento(
                id,
                'ItemAnulado',
                {
                  item_id: item.id,
                  cantidad: 1 + (b % item.cantidad),
                  ya_preparado: c % 2 === 0,
                  comanda_id: null,
                },
                motivo,
              ),
            )
          : null
      case 5: {
        if (!item) return null
        const monto = porcentaje(totalesItem(est, item).bruto, BPS[b % BPS.length] ?? 1000)
        return solo(
          descuentoEvento(id, 'item', 'porcentaje', BPS[b % BPS.length] ?? 1000, null, [
            { item_id: item.id, monto },
          ]),
        )
      }
      case 6: {
        if (!item) return null
        const neto = totalesItem(est, item).neto
        // Hasta un 10 % por encima del neto: algunos deben rechazarse.
        const monto = Math.floor((neto * 11 * (b % 91)) / 900)
        return solo(
          descuentoEvento(id, 'item', 'valor', monto, null, [{ item_id: item.id, monto }]),
        )
      }
      case 7: {
        if (!item) return null
        const unidades = 1 + (b % item.cantidad)
        const monto = cortesia(
          unidades,
          item.precioUnitario,
          item.modificadores.map((m) => m.precioExtra),
        )
        return solo(
          descuentoEvento(id, 'item', 'cortesia', monto, unidades, [{ item_id: item.id, monto }]),
        )
      }
      case 8:
      case 9: {
        if (!vivos.length) return null
        const base = vivos.reduce((s, i) => s + netoTrasLinea(est, i), 0)
        const restantes = vivos.map((i) => totalesItem(est, i).neto)
        const totalRestante = restantes.reduce((s, r) => s + r, 0)
        const regla = tipo === 8 ? 'porcentaje' : 'valor'
        const bp = BPS[b % BPS.length] ?? 1000
        const pesos =
          regla === 'porcentaje'
            ? porcentaje(base, bp)
            : Math.floor((totalRestante * (c % 101)) / 100)
        const partes =
          repartirDescuentoPedido(pesos, restantes) ??
          // Más de lo que queda: el reductor debe rechazarlo.
          restantes.map((r, i) => (i === 0 ? r + 1 : r))
        // En un porcentaje el valor va en puntos básicos; por valor, es la suma de las partes.
        const valor = regla === 'porcentaje' ? bp : partes.reduce((x, y) => x + y, 0)
        return solo(
          descuentoEvento(
            id,
            'pedido',
            regla,
            valor,
            null,
            vivos.map((i, k) => ({ item_id: i.id, monto: partes[k] ?? 0 })),
          ),
        )
      }
      case 10: {
        const ids = Object.keys(est.descuentos)
        const descuento = elegir(ids, a)
        return descuento
          ? solo(evento(id, 'DescuentoRetirado', { descuento_id: descuento }, motivo))
          : null
      }
      case 11: {
        const n = 2 + (a % 4)
        const saldo = totalesPedido(est).saldo
        if (saldo < 2 && a % 5 !== 0) return null
        const total = b % 3 === 0 ? Math.floor(saldo * 0.8) : saldo
        const montos = partesIguales(total, n)
        const propinas = partesIguales(Math.floor(total / 10), n)
        return solo(
          evento(id, 'CuentaDividida', {
            cuentas: montos.map((monto, i) => ({
              cuenta_id: nuevoId(),
              nombre: `Cuenta ${i + 1}`,
              monto,
              propina_sugerida: propinas[i] ?? 0,
              items:
                i === 0 && vivos[0] ? [{ item_id: vivos[0].id, fraccion: { n: 1, d: n } }] : [],
            })),
          }),
        )
      }
      case 12:
        return solo(evento(id, 'DivisionDeshecha', {}))
      case 13: {
        const cuentaId = est.cuentas && a % 3 !== 0 ? (elegir(est.cuentas, b)?.id ?? null) : null
        const libre = disponible(est, cuentaId)
        // Sin saldo solo se intenta de vez en cuando, para probar el rechazo.
        if (libre <= 0 && c % 8 !== 0) return null
        const monto = Math.max(
          1,
          [libre, Math.floor(libre / 2), Math.floor(libre / 3) + 1, 1, libre + 1][c % 5] ?? 1,
        )
        const turno = this.turno(b)
        const propina = [0, 500, 1000][a % 3] ?? 0
        const medioEfectivo = b % 2 === 0
        if (medioEfectivo) {
          const cierra = monto === libre
          const ajuste = cierra ? cobradoEnEfectivo(monto, 100) - monto : 0
          return solo(
            evento(
              id,
              'PagoRegistrado',
              pagoEfectivo(monto, {
                cuenta_id: cuentaId,
                turno_caja_id: turno,
                propina,
                ajuste_redondeo: ajuste,
                cambio: [0, 1000, 20_000][c % 3] ?? 0,
              }),
            ),
          )
        }
        return solo(
          evento(
            id,
            'PagoRegistrado',
            pagoTarjeta(monto, {
              cuenta_id: cuentaId,
              turno_caja_id: turno,
              propina,
              ...(c % 2 === 0 ? { medio: 'nequi', datafono: null } : {}),
            }),
          ),
        )
      }
      case 14: {
        const pago = elegir(Object.values(est.pagos), a)
        return pago
          ? solo(
              evento(id, 'PagoAnulado', { pago_id: pago.id, turno_caja_id: this.turno(b) }, motivo),
            )
          : null
      }
      case 15: {
        const pago = elegir(Object.values(est.pagos), a)
        if (!pago) return null
        const venta = b % (pago.monto + 1)
        const propina = c % (pago.propina + 1)
        return solo(
          evento(
            id,
            'ReembolsoRegistrado',
            {
              pago_id: pago.id,
              reembolso_id: nuevoId(),
              monto_venta: venta + propina === 0 ? 1 : venta,
              monto_propina: propina,
              medio: pago.medio,
              turno_caja_id: this.turno(a),
            },
            motivo,
          ),
        )
      }
      case 16:
        return solo(evento(id, 'PedidoCerrado', {}, { dia_operativo: DIAS[a % 2] }))
      case 17:
        return solo(evento(id, 'PedidoReabierto', {}, motivo))
      case 18:
        return solo(evento(id, 'PedidoCancelado', {}, motivo))
      case 19: {
        const elegibles = items.filter((i) => ACTIVOS.includes(i.estado))
        const lote = b % 3 === 0 ? elegibles : [elegir(elegibles, a)].filter((i) => i !== undefined)
        if (!lote.length) return null
        return {
          clase: 'cruzado',
          origen: p,
          destino: q,
          evento: evento(
            id,
            'ItemsMovidos',
            { pedido_destino_id: this.pedidos[q], items: lote.map(aMovido) },
            { relacionados: [this.pedidos[q]] },
          ),
        }
      }
      case 20:
        return {
          clase: 'cruzado',
          origen: p,
          destino: q,
          evento: evento(
            this.pedidos[q],
            'PedidosUnidos',
            { pedido_origen_id: id, items: vivos.map(aMovido) },
            { relacionados: [id] },
          ),
        }
      case 21:
        return solo(
          a % 3 === 0
            ? evento(id, 'MeseroAsignado', { mesero_id: b % 2 === 0 ? MESERO : nuevoId() })
            : a % 3 === 1
              ? b % 4 === 0
                ? evento(id, 'NotaPedidoCambiada', {
                    notas: b % 8 === 0 ? null : 'alérgico al maní',
                  })
                : evento(id, 'ComensalesCambiados', { comensales: b % 20 })
              : evento(id, 'PedidoMovidoDeMesa', { mesa_destino_id: nuevoId() }),
        )
      case 22: {
        const t = totalesPedido(est)
        return solo(
          evento(id, 'PrecuentaImpresa', {
            cuenta_id: est.cuentas ? (elegir(est.cuentas, a)?.id ?? null) : null,
            subtotal: t.neto,
            propina_sugerida: porcentaje(t.neto, 1000),
          }),
        )
      }
      case 23: {
        const curso = (['entrada', 'fuerte', 'postre'] as const)[a % 3] ?? 'entrada'
        return solo(evento(id, b % 2 === 0 ? 'CursoRetenido' : 'CursoMarchado', { curso }))
      }
      case 24: {
        if (!item) return null
        const tipos = [
          'ItemEnPreparacion',
          'ItemListo',
          'ItemEntregado',
          'ItemDevueltoACola',
        ] as const
        // Casi siempre el paso natural del ítem; a veces uno al azar para probar el rechazo.
        const natural = {
          enviado: 'ItemEnPreparacion',
          en_preparacion: 'ItemListo',
          listo: 'ItemEntregado',
          entregado: 'ItemDevueltoACola',
        } as const
        const siguiente =
          b % 4 === 0 || !(item.estado in natural)
            ? tipos[c % 4]
            : natural[item.estado as keyof typeof natural]
        return solo(evento(id, siguiente ?? 'ItemListo', { item_ids: [item.id] }))
      }
      case 25:
        return item
          ? solo(
              evento(id, 'ItemModificadoTrasEnvio', {
                item_id: item.id,
                comanda_id: nuevoId(),
                notas: 'Sin hielo',
                ...(b % 2 === 0
                  ? {}
                  : {
                      modificadores: [
                        {
                          modificador_id: nuevoId(),
                          nombre: 'Extra',
                          precio_extra: [0, 3000][c % 2] ?? 0,
                        },
                      ],
                    }),
              }),
            )
          : null
      default:
        return solo(evento(id, 'ComandaReimpresa', { comanda_id: nuevoId() }))
    }
  }
}

function enviarEvento(pedido: string, itemIds: string[]) {
  return evento(pedido, 'ItemsEnviados', {
    comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: itemIds }],
  })
}

function descuentoEvento(
  pedido: string,
  alcance: 'item' | 'pedido',
  regla: 'porcentaje' | 'valor' | 'cortesia',
  valor: number,
  unidades: number | null,
  montos: { item_id: string; monto: number }[],
) {
  return evento(
    pedido,
    'DescuentoAplicado',
    {
      descuento_id: nuevoId(),
      alcance,
      regla,
      valor,
      cantidad_unidades: unidades,
      montos,
    },
    { motivo: 'Motivo de prueba' },
  )
}
