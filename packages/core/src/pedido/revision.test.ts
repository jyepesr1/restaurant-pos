import { describe, expect, it } from 'vitest'
import { LIMITE_PRECIO } from '../dinero'
import { type EventoAplicable, type EventoPedido, validarEventoNuevo } from '../eventos/pedido'
import { nuevoId } from '../id'
import { aplicarTodos, pedidoAbierto, problemaDe } from '../pruebas/ayudas'
import {
  copiaItem,
  deNuevo,
  evento,
  MESERO,
  pagoEfectivo,
  pagoTarjeta,
  TURNO,
} from '../pruebas/fabrica'
import { aplicarEvento, reconstruir } from './aplicar'

// Reglas agregadas tras la revisión de la tarea 0.5 (revisor-codigo y auditor-dinero).

const enviar = (pedido: string, ids: string[]) =>
  evento(pedido, 'ItemsEnviados', {
    comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: ids }],
  })
const MOTIVO = { motivo: 'Motivo de prueba' }

describe('idempotencia y eventos ajenos', () => {
  it('un evento ya aplicado se ignora y uno de otro pedido no se aplica', () => {
    const { pedido, estado } = pedidoAbierto()
    const agregar = evento(pedido, 'ItemAgregado', copiaItem())
    const conItem = aplicarTodos([agregar], estado)

    expect(problemaDe(conItem, agregar)).toBe('evento_ya_aplicado')
    expect(problemaDe(conItem, evento(nuevoId(), 'ItemAgregado', copiaItem()))).toBe('evento_ajeno')
  })

  it('reconstruir no aplica dos veces el mismo evento', () => {
    const { pedido } = pedidoAbierto()
    const abrir = evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 2 })
    const item = copiaItem({ cantidad: 3 })
    const agregar = evento(pedido, 'ItemAgregado', item)
    const enviarlo = enviar(pedido, [item.item_id])
    const anular = evento(
      pedido,
      'ItemAnulado',
      { item_id: item.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
      MOTIVO,
    )

    expect(
      reconstruir([abrir, agregar, enviarlo, anular, anular], pedido)?.items[item.item_id]
        ?.cantidadAnulada,
    ).toBe(1)
  })

  it('un reembolso repetido no se aplica dos veces', () => {
    const { pedido, estado } = pedidoAbierto()
    const pago = pagoTarjeta(20_000)
    const pagado = aplicarTodos(
      [evento(pedido, 'ItemAgregado', copiaItem()), evento(pedido, 'PagoRegistrado', pago)],
      estado,
    )
    const reembolso = evento(
      pedido,
      'ReembolsoRegistrado',
      {
        pago_id: pago.pago_id,
        reembolso_id: nuevoId(),
        monto_venta: 1000,
        monto_propina: 0,
        medio: 'tarjeta',
        turno_caja_id: TURNO,
      },
      MOTIVO,
    )
    const una = aplicarTodos([reembolso], pagado)

    expect(problemaDe(una, deNuevo(reembolso))).toBe('reembolso_ya_existe')
  })

  it('proyecta un evento propio aún sin confirmar (sin secuencia ni campos del hub)', () => {
    const { pedido, estado } = pedidoAbierto()
    const {
      secuencia: _s,
      recibido_en: _r,
      dia_operativo: _d,
      asignaciones: _a,
      afecta: _f,
      autorizado_por_id: _p,
      ...pendiente
    } = evento(pedido, 'ItemAgregado', copiaItem())
    const r = aplicarEvento(estado, pendiente as EventoAplicable)

    expect(r.problema).toBeNull()
    expect(r.estado?.ultimaSecuencia).toBe(estado.ultimaSecuencia)
  })
})

describe('cocina y pedidos cerrados', () => {
  it('con la mesa ya pagada la cocina sigue marcando listo y entregado', () => {
    const { pedido, estado } = pedidoAbierto()
    const item = copiaItem({ precio_unitario: 10_000 })
    const cerrado = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', item),
        enviar(pedido, [item.item_id]),
        evento(pedido, 'PagoRegistrado', pagoTarjeta(10_000)),
        evento(pedido, 'PedidoCerrado', {}),
      ],
      estado,
    )
    const listo = aplicarTodos(
      [
        evento(pedido, 'ItemListo', { item_ids: [item.item_id] }),
        evento(pedido, 'ComandaReimpresa', { comanda_id: nuevoId() }),
      ],
      cerrado,
    )

    expect(listo.items[item.item_id]?.estado).toBe('listo')
    expect(problemaDe(cerrado, evento(pedido, 'MeseroAsignado', { mesero_id: nuevoId() }))).toBe(
      'pedido_cerrado',
    )
  })

  it('sin KDS el mesero entrega directo desde enviado', () => {
    const { pedido, estado } = pedidoAbierto()
    const item = copiaItem()
    const entregado = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', item),
        enviar(pedido, [item.item_id]),
        evento(pedido, 'ItemEntregado', { item_ids: [item.item_id] }),
      ],
      estado,
    )

    expect(entregado.items[item.item_id]?.estado).toBe('entregado')
  })

  it('un envío con un ítem quitado desde otro dispositivo igual manda los demás', () => {
    const { pedido, estado } = pedidoAbierto()
    const a = copiaItem()
    const b = copiaItem()
    const conItems = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', a),
        evento(pedido, 'ItemAgregado', b),
        evento(pedido, 'ItemQuitado', { item_id: b.item_id }),
      ],
      estado,
    )
    const r = aplicarEvento(conItems, enviar(pedido, [a.item_id, b.item_id]))

    expect(r.problema?.tipo).toBe('items_omitidos')
    expect(r.estado?.items[a.item_id]?.estado).toBe('enviado')
  })
})

describe('cambios de ítems', () => {
  it('cambiar el curso respeta la retención', () => {
    const { pedido, estado } = pedidoAbierto()
    const entrada = copiaItem({ curso: 'entrada' })
    const retenido = aplicarTodos(
      [
        evento(pedido, 'CursoRetenido', { curso: 'postre' }),
        evento(pedido, 'ItemAgregado', entrada),
      ],
      estado,
    )

    const aPostre = aplicarTodos(
      [evento(pedido, 'ItemCambiado', { item_id: entrada.item_id, curso: 'postre' })],
      retenido,
    )
    expect(aPostre.items[entrada.item_id]?.estado).toBe('retenido')
    const aFuerte = aplicarTodos(
      [evento(pedido, 'ItemCambiado', { item_id: entrada.item_id, curso: 'fuerte' })],
      aPostre,
    )
    expect(aFuerte.items[entrada.item_id]?.estado).toBe('pendiente')
  })

  it('con descuento o dividido se pueden cambiar notas, comensal y curso, pero no la cantidad', () => {
    const { pedido, estado } = pedidoAbierto()
    const item = copiaItem()
    const descontado = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', item),
        evento(
          pedido,
          'DescuentoAplicado',
          {
            descuento_id: nuevoId(),
            alcance: 'item',
            regla: 'valor',
            valor: 1000,
            cantidad_unidades: null,
            montos: [{ item_id: item.item_id, monto: 1000 }],
          },
          MOTIVO,
        ),
      ],
      estado,
    )

    expect(
      problemaDe(
        descontado,
        evento(pedido, 'ItemCambiado', { item_id: item.item_id, notas: 'Sin hielo', comensal: 2 }),
      ),
    ).toBeUndefined()
    expect(
      problemaDe(
        descontado,
        evento(pedido, 'ItemCambiado', { item_id: item.item_id, cantidad: 2 }),
      ),
    ).toBe('tiene_descuentos')
  })

  it('un pedido no pasa del tope total', () => {
    const { pedido, estado } = pedidoAbierto()
    const caro = copiaItem({ precio_unitario: LIMITE_PRECIO, cantidad: 100 })
    const conCaro = aplicarTodos([evento(pedido, 'ItemAgregado', caro)], estado)

    expect(
      problemaDe(conCaro, evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 1 }))),
    ).toBe('total_excede')
    expect(
      problemaDe(conCaro, evento(pedido, 'ItemCambiado', { item_id: caro.item_id, cantidad: 101 })),
    ).toBe('total_excede')
  })
})

describe('dinero: reglas nuevas', () => {
  it('el ajuste de redondeo debe ser exactamente el de la regla', () => {
    const { pedido, estado } = pedidoAbierto()
    const conItem = aplicarTodos(
      [evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 36_810 }))],
      estado,
    )
    // Con un ajuste de −36.810 se habría cerrado el pedido sin cobrar nada.
    const robo = {
      ...pagoEfectivo(36_810, { ajuste_redondeo: -10, cambio: 0 }),
      ajuste_redondeo: -36_810,
      recibido: 0,
    }

    expect(
      validarEventoNuevo({ ...evento(pedido, 'PagoRegistrado', pagoEfectivo(1)), datos: robo }).ok,
    ).toBe(false)
    expect(
      problemaDe(
        conItem,
        evento(pedido, 'PagoRegistrado', pagoEfectivo(36_810, { ajuste_redondeo: -20, cambio: 0 })),
      ),
    ).toBe('ajuste_invalido')
    expect(
      problemaDe(
        conItem,
        evento(
          pedido,
          'PagoRegistrado',
          pagoEfectivo(36_810, { ajuste_redondeo: -10, cambio: 3200 }),
        ),
      ),
    ).toBeUndefined()
  })

  it('un pago con reembolsos no se anula (se devolvería dos veces)', () => {
    const { pedido, estado } = pedidoAbierto()
    const pago = pagoEfectivo(40_900)
    const reembolsado = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', copiaItem()),
        evento(pedido, 'PagoRegistrado', pago),
        evento(
          pedido,
          'ReembolsoRegistrado',
          {
            pago_id: pago.pago_id,
            reembolso_id: nuevoId(),
            monto_venta: 10_000,
            monto_propina: 0,
            medio: 'efectivo',
            turno_caja_id: TURNO,
          },
          MOTIVO,
        ),
      ],
      estado,
    )

    expect(
      problemaDe(
        reembolsado,
        evento(pedido, 'PagoAnulado', { pago_id: pago.pago_id, turno_caja_id: TURNO }, MOTIVO),
      ),
    ).toBe('pago_con_reembolsos')
  })

  it('el reembolso va por el mismo medio del pago', () => {
    const { pedido, estado } = pedidoAbierto()
    const pago = pagoTarjeta(40_900)
    const pagado = aplicarTodos(
      [evento(pedido, 'ItemAgregado', copiaItem()), evento(pedido, 'PagoRegistrado', pago)],
      estado,
    )
    const enEfectivo = evento(
      pedido,
      'ReembolsoRegistrado',
      {
        pago_id: pago.pago_id,
        reembolso_id: nuevoId(),
        monto_venta: 1000,
        monto_propina: 0,
        medio: 'efectivo',
        turno_caja_id: TURNO,
      },
      MOTIVO,
    )

    expect(problemaDe(pagado, enEfectivo)).toBe('medio_distinto')
  })

  it('un pago en efectivo con ajuste, anulado, deja cancelar el pedido', () => {
    const { pedido, estado } = pedidoAbierto()
    const pago = pagoEfectivo(36_850, { ajuste_redondeo: -50 })
    const anulado = aplicarTodos(
      [
        evento(pedido, 'ItemAgregado', copiaItem({ precio_unitario: 36_850 })),
        evento(pedido, 'PagoRegistrado', pago),
        evento(pedido, 'PagoAnulado', { pago_id: pago.pago_id, turno_caja_id: TURNO }, MOTIVO),
      ],
      estado,
    )

    expect(aplicarTodos([evento(pedido, 'PedidoCancelado', {}, MOTIVO)], anulado).estado).toBe(
      'cancelado',
    )
  })

  it('una cortesía debe valer exactamente sus unidades', () => {
    const { pedido, estado } = pedidoAbierto()
    const cervezas = copiaItem({ precio_unitario: 14_900, cantidad: 3 })
    const conItem = aplicarTodos([evento(pedido, 'ItemAgregado', cervezas)], estado)
    const cortesia = (unidades: number, monto: number) =>
      evento(
        pedido,
        'DescuentoAplicado',
        {
          descuento_id: nuevoId(),
          alcance: 'item',
          regla: 'cortesia',
          valor: monto,
          cantidad_unidades: unidades,
          montos: [{ item_id: cervezas.item_id, monto }],
        },
        MOTIVO,
      )

    expect(problemaDe(conItem, cortesia(1, 14_900))).toBeUndefined()
    expect(problemaDe(conItem, cortesia(1, 20_000))).toBe('descuento_invalido')
    expect(problemaDe(conItem, cortesia(4, 59_600))).toBe('descuento_invalido')
  })

  it('una división no nombra ítems que no están', () => {
    const { pedido, estado } = pedidoAbierto()
    const conItem = aplicarTodos([evento(pedido, 'ItemAgregado', copiaItem())], estado)
    const cuenta = (monto: number) => ({
      cuenta_id: nuevoId(),
      nombre: 'C',
      monto,
      propina_sugerida: 0,
      items: [{ item_id: nuevoId(), fraccion: { n: 1, d: 2 } }],
    })

    expect(
      problemaDe(
        conItem,
        evento(pedido, 'CuentaDividida', { cuentas: [cuenta(1000), cuenta(1000)] }),
      ),
    ).toBe('item_inexistente')
  })
})

describe('mover y unir: la copia debe coincidir', () => {
  function conItem() {
    const origen = pedidoAbierto()
    const item = copiaItem({ cantidad: 2 })
    const estado = aplicarTodos([evento(origen.pedido, 'ItemAgregado', item)], origen.estado)
    return { origen: origen.pedido, item, estado }
  }
  const movido = (item: ReturnType<typeof copiaItem>, campos: Record<string, unknown> = {}) => ({
    item: { ...item, ...campos },
    estado: 'pendiente' as const,
    cantidad_anulada: 0,
    agregado_por: MESERO,
  })

  it('mover con un precio distinto al real se rechaza: no desaparece venta', () => {
    const { origen, item, estado } = conItem()
    const mover = evento(origen, 'ItemsMovidos', {
      pedido_destino_id: nuevoId(),
      items: [movido(item, { precio_unitario: 0 })],
    })

    expect(problemaDe(estado, mover)).toBe('copia_distinta')
  })

  it('unir sin traer todos los ítems se rechaza', () => {
    const { origen, item, estado } = conItem()
    const otro = copiaItem()
    const conDos = aplicarTodos([evento(origen, 'ItemAgregado', otro)], estado)
    const unir = evento(nuevoId(), 'PedidosUnidos', {
      pedido_origen_id: origen,
      items: [movido(item)],
    })

    expect(problemaDe(conDos, unir)).toBe('copia_distinta')
  })
})

describe('esquemas más estrictos', () => {
  const base = (tipo: string, datos: unknown, extras: Record<string, unknown> = {}) => {
    const plantilla = evento(nuevoId(), 'ComandaReimpresa', {
      comanda_id: nuevoId(),
    }) as EventoPedido
    const {
      secuencia: _s,
      recibido_en: _r,
      dia_operativo: _d,
      asignaciones: _a,
      afecta: _f,
      autorizado_por_id: _p,
      ...sobre
    } = plantilla
    return validarEventoNuevo({ ...sobre, tipo, datos, ...extras })
  }

  it('rechaza campos de más en lugar de descartarlos', () => {
    expect(base('ComensalesCambiados', { comensales: 2 }).ok).toBe(true)
    expect(base('ComensalesCambiados', { comensales: 2, extra: 'x' }).ok).toBe(false)
    expect(base('ComensalesCambiados', { comensales: 2 }, { campo_raro: 1 }).ok).toBe(false)
  })

  it('un pago con tarjeta indica el datáfono', () => {
    expect(base('PagoRegistrado', { ...pagoTarjeta(1000), datafono: null }).ok).toBe(false)
  })

  it('descuentos: ítems sin repetir, valor que cuadra y porcentaje en puntos básicos', () => {
    const descuento = (campos: Record<string, unknown>) => ({
      descuento_id: nuevoId(),
      alcance: 'pedido',
      regla: 'valor',
      valor: 2000,
      cantidad_unidades: null,
      montos: [],
      ...campos,
    })
    const a = nuevoId()
    const motivo = { motivo: 'm' }
    expect(
      base(
        'DescuentoAplicado',
        descuento({
          montos: [
            { item_id: a, monto: 1000 },
            { item_id: a, monto: 1000 },
          ],
        }),
        motivo,
      ).ok,
    ).toBe(false)
    expect(
      base('DescuentoAplicado', descuento({ montos: [{ item_id: a, monto: 1500 }] }), motivo).ok,
    ).toBe(false)
    expect(
      base(
        'DescuentoAplicado',
        descuento({ regla: 'porcentaje', valor: 50_000, montos: [{ item_id: a, monto: 1000 }] }),
        motivo,
      ).ok,
    ).toBe(false)
    expect(
      base(
        'DescuentoAplicado',
        descuento({
          alcance: 'item',
          montos: [
            { item_id: a, monto: 1000 },
            { item_id: nuevoId(), monto: 1000 },
          ],
        }),
        motivo,
      ).ok,
    ).toBe(false)
  })

  it('divisiones: cuentas sin repetir y fracciones de un ítem que no pasan de 1', () => {
    const item = nuevoId()
    const cuenta = (id: string, fraccion = { n: 1, d: 2 }) => ({
      cuenta_id: id,
      nombre: 'C',
      monto: 1000,
      propina_sugerida: 0,
      items: [{ item_id: item, fraccion }],
    })
    const repetida = nuevoId()
    expect(base('CuentaDividida', { cuentas: [cuenta(repetida), cuenta(repetida)] }).ok).toBe(false)
    expect(base('CuentaDividida', { cuentas: [cuenta(nuevoId()), cuenta(nuevoId())] }).ok).toBe(
      true,
    )
    expect(
      base('CuentaDividida', { cuentas: [cuenta(nuevoId(), { n: 2, d: 3 }), cuenta(nuevoId())] })
        .ok,
    ).toBe(false)
  })

  it('mover nombra al destino en relacionados', () => {
    const destino = nuevoId()
    const { catalogo_version: _c, precio_canal_id: _p, ...item } = copiaItem()
    const datos = {
      pedido_destino_id: destino,
      items: [{ item, estado: 'pendiente', cantidad_anulada: 0, agregado_por: MESERO }],
    }
    expect(base('ItemsMovidos', datos).ok).toBe(false)
    expect(base('ItemsMovidos', datos, { relacionados: [destino] }).ok).toBe(true)
  })

  it('un cambio de ítem debe cambiar algo de verdad', () => {
    expect(base('ItemCambiado', { item_id: nuevoId(), cantidad: undefined }).ok).toBe(false)
    expect(base('ItemModificadoTrasEnvio', { item_id: nuevoId(), comanda_id: nuevoId() }).ok).toBe(
      false,
    )
  })
})
