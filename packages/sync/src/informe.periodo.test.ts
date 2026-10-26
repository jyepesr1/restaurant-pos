import { type EventoPedido, informe, nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import {
  copiaItem,
  evento,
  MESERO,
  pagoEfectivo,
  pagoTarjeta,
  TURNO,
} from '../../core/src/pruebas/fabrica'
import { AlmacenMemoria } from './hub/almacen'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { cierreDeTurno, cuadreGuardado, datosDeInforme } from './hub/informe'
import { cargar, numerar } from './pruebas/historias'
import { baseSqlite } from './pruebas/montaje'

// El período de los reportes (docs/KPIS.md#período) con casos armados a mano, en los dos almacenes.
// Cada día es un día operativo: el 23 es «ayer», el 24 «hoy», el 25 «mañana».

const CONFIG = { ventas_por_mesero: 'quien_agrega', redondeo_modo: 'mitad_arriba' } as const
const D23 = '2026-10-23'
const D24 = '2026-10-24'
const D25 = '2026-10-25'
const D26 = '2026-10-26'

const aplicarEnAmbos = (eventos: EventoPedido[]) => {
  const memoria = new AlmacenMemoria()
  const { db, restauranteId } = baseSqlite()
  const sqlite = new AlmacenSqlite(db, restauranteId)
  const lista = numerar(eventos)
  cargar(memoria, lista)
  cargar(sqlite, lista)
  return [memoria, sqlite] as const
}

const abrir = (id: string) =>
  evento(id, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 2 })

/** Un pedido de `precio` pagado en efectivo y cerrado el `dia`. */
function pedidoCobrado(precio: number, dia: string, pagoDia = dia) {
  const id = nuevoId()
  const item = copiaItem({ precio_unitario: precio })
  const pago = pagoEfectivo(precio)
  return {
    id,
    item,
    pago,
    eventos: [
      abrir(id),
      evento(id, 'ItemAgregado', item),
      evento(id, 'PagoRegistrado', pago, { dia_operativo: pagoDia }),
      evento(id, 'PedidoCerrado', {}, { dia_operativo: dia }),
    ] as EventoPedido[],
  }
}
const reabrir = (id: string) => evento(id, 'PedidoReabierto', {}, { motivo: 'Se olvidó algo' })

const ventasDe = (a: AlmacenMemoria | AlmacenSqlite, desde: string, hasta = desde) =>
  informe({ ...datosDeInforme(a, desde, hasta), config: CONFIG })

const enviar = (id: string, itemId: string) =>
  evento(id, 'ItemsEnviados', {
    comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [itemId] }],
  })

describe('período: pedidos reabiertos (lo ya reportado de un día no cambia)', () => {
  /** Cerrada el 24 con $30.000; reabierta, agrega $10.000 y se cierra otra vez el 25. */
  function conAdicion() {
    const x = pedidoCobrado(30_000, D24)
    const extra = copiaItem({ precio_unitario: 10_000, nombre: 'Postre' })
    const pagoExtra = pagoEfectivo(10_000)
    const eventos = [
      ...x.eventos,
      reabrir(x.id),
      evento(x.id, 'ItemAgregado', extra),
      evento(x.id, 'PagoRegistrado', pagoExtra, { dia_operativo: D25 }),
      evento(x.id, 'PedidoCerrado', {}, { dia_operativo: D25 }),
    ]
    return { x, extra, eventos }
  }

  it('cerrada el 24 y vuelta a cerrar el 25: el 25 suma solo la diferencia', () => {
    const { eventos } = conAdicion()
    for (const a of aplicarEnAmbos(eventos)) {
      expect(ventasDe(a, D24).ventas).toMatchObject({
        neto: 30_000,
        bruto: 30_000,
        cuentas: 1,
        comensales: 2,
      })
      // El 25 suma lo nuevo, pero no es otra cuenta ni otros comensales.
      expect(ventasDe(a, D25).ventas).toMatchObject({
        neto: 10_000,
        bruto: 10_000,
        cuentas: 0,
        comensales: 0,
      })
      expect(ventasDe(a, D25).porProducto).toEqual([
        expect.objectContaining({ nombre: 'Postre', unidades: 1, neto: 10_000 }),
      ])
      expect(ventasDe(a, D23).ventas.neto).toBe(0)
      expect(ventasDe(a, D26).ventas.neto).toBe(0)
      // Los dos días juntos son el pedido final, una sola cuenta.
      expect(ventasDe(a, D24, D25).ventas).toMatchObject({
        neto: 40_000,
        cuentas: 1,
        comensales: 2,
      })
    }
  })

  it('cerrada, reabierta y cerrada de nuevo sin cambios: el segundo cierre suma cero', () => {
    const x = pedidoCobrado(12_000, D24)
    const eventos = [
      ...x.eventos,
      reabrir(x.id),
      evento(x.id, 'PedidoCerrado', {}, { dia_operativo: D25 }),
    ]
    for (const a of aplicarEnAmbos(eventos)) {
      expect(ventasDe(a, D24).ventas.neto).toBe(12_000)
      expect(ventasDe(a, D25).ventas).toMatchObject({
        neto: 0,
        bruto: 0,
        cuentas: 0,
        comensales: 0,
      })
      expect(ventasDe(a, D25).porProducto).toEqual([])
      expect(datosDeInforme(a, D25, D25).cierres).toHaveLength(1)
    }
  })

  it('reabierta y todavía abierta sigue contando el día de su cierre anterior, con lo que tenía', () => {
    const x = pedidoCobrado(30_000, D24)
    const extra = copiaItem({ precio_unitario: 5_000 })
    // Se reabre el 25 y se le agrega algo que aún no se paga ni se cierra.
    const eventos = [...x.eventos, reabrir(x.id), evento(x.id, 'ItemAgregado', extra)]
    for (const a of aplicarEnAmbos(eventos)) {
      expect(ventasDe(a, D24).ventas).toMatchObject({ neto: 30_000, cuentas: 1 })
      expect(ventasDe(a, D25).ventas).toMatchObject({ neto: 0, cuentas: 0 })
      expect(ventasDe(a, D23, D26).ventas.neto).toBe(30_000)
    }
  })

  it('al reabrir se anula un producto y se reembolsa: el segundo día resta, y nada del primero cambia', () => {
    const id = nuevoId()
    const item = copiaItem({ precio_unitario: 20_000, cantidad: 2, nombre: 'Cerveza' })
    const pago = pagoEfectivo(40_000)
    const eventos = [
      abrir(id),
      evento(id, 'ItemAgregado', item),
      enviar(id, item.item_id),
      evento(id, 'PagoRegistrado', pago, { dia_operativo: D24 }),
      evento(id, 'PedidoCerrado', {}, { dia_operativo: D24 }),
      reabrir(id),
      evento(
        id,
        'ReembolsoRegistrado',
        {
          pago_id: pago.pago_id,
          reembolso_id: nuevoId(),
          monto_venta: 20_000,
          monto_propina: 0,
          medio: 'efectivo',
          turno_caja_id: TURNO,
        },
        { motivo: 'Error', dia_operativo: D25 },
      ),
      evento(
        id,
        'ItemAnulado',
        { item_id: item.item_id, cantidad: 1, ya_preparado: false, comanda_id: null },
        { motivo: 'Error', dia_operativo: D25 },
      ),
      evento(id, 'PedidoCerrado', {}, { dia_operativo: D25 }),
    ]
    for (const a of aplicarEnAmbos(eventos)) {
      expect(ventasDe(a, D24).ventas).toMatchObject({ neto: 40_000, bruto: 40_000, anulado: 0 })
      const d25 = ventasDe(a, D25)
      expect(d25.ventas).toMatchObject({ neto: -20_000, bruto: 0, anulado: 20_000, cuentas: 0 })
      expect(d25.porProducto).toEqual([expect.objectContaining({ unidades: -1, neto: -20_000 })])
      expect(d25.porMedio).toEqual([expect.objectContaining({ medio: 'efectivo', venta: -20_000 })])
      expect(ventasDe(a, D24, D25).ventas.neto).toBe(20_000)
    }
  })

  it('un descuento quitado al reabrir sale en el segundo cierre con monto negativo', () => {
    const id = nuevoId()
    const item = copiaItem({ precio_unitario: 10_000 })
    const descuento = nuevoId()
    const eventos = [
      abrir(id),
      evento(id, 'ItemAgregado', item),
      evento(
        id,
        'DescuentoAplicado',
        {
          descuento_id: descuento,
          alcance: 'item',
          regla: 'valor',
          valor: 2_000,
          cantidad_unidades: null,
          montos: [{ item_id: item.item_id, monto: 2_000 }],
        },
        { motivo: 'Cliente frecuente' },
      ),
      evento(id, 'PagoRegistrado', pagoEfectivo(8_000)),
      evento(id, 'PedidoCerrado', {}, { dia_operativo: D24 }),
      reabrir(id),
      evento(id, 'DescuentoRetirado', { descuento_id: descuento }, { motivo: 'Se canceló' }),
      evento(id, 'PagoRegistrado', pagoEfectivo(2_000), { dia_operativo: D25 }),
      evento(id, 'PedidoCerrado', {}, { dia_operativo: D25 }),
    ]
    for (const a of aplicarEnAmbos(eventos)) {
      expect(ventasDe(a, D24).descuentos).toEqual([expect.objectContaining({ monto: 2_000 })])
      expect(ventasDe(a, D24).ventas).toMatchObject({ neto: 8_000, descuentos: 2_000 })
      expect(ventasDe(a, D25).descuentos).toEqual([expect.objectContaining({ monto: -2_000 })])
      expect(ventasDe(a, D25).ventas).toMatchObject({ neto: 2_000, descuentos: -2_000 })
    }
  })

  it('reabierta, con el pago anulado y cancelada: el día 24 no cambia y la cancelación cuenta el 25', () => {
    const x = pedidoCobrado(20_000, D24)
    const anulaPago = evento(
      x.id,
      'PagoAnulado',
      { pago_id: x.pago.pago_id, turno_caja_id: TURNO },
      { motivo: 'm', dia_operativo: D25 },
    )
    const eventos = [
      ...x.eventos,
      reabrir(x.id),
      anulaPago,
      evento(x.id, 'PedidoCancelado', {}, { motivo: 'Se fueron', dia_operativo: D25 }),
    ]
    for (const a of aplicarEnAmbos(eventos)) {
      expect(ventasDe(a, D24).ventas).toMatchObject({ neto: 20_000, cuentas: 1 })
      const r = ventasDe(a, D25)
      expect(r.ventas.neto).toBe(0)
      expect(r.porMedio).toEqual([expect.objectContaining({ venta: -20_000 })])
      expect(r.cancelaciones).toEqual([
        expect.objectContaining({ pedidoId: x.id, motivo: 'Se fueron' }),
      ])
    }
  })

  it('cada cierre trae el pedido al cerrar y como estaba en el anterior (null el primero)', () => {
    const { x, eventos } = conAdicion()
    for (const a of aplicarEnAmbos(eventos)) {
      const [primero] = datosDeInforme(a, D24, D24).cierres
      expect(primero?.antes).toBeNull()
      expect(primero?.despues.id).toBe(x.id)
      const [segundo] = datosDeInforme(a, D25, D25).cierres
      expect(Object.keys(segundo?.antes?.items ?? {})).toHaveLength(1)
      expect(Object.keys(segundo?.despues.items ?? {})).toHaveLength(2)
      // Un período que abarca los dos trae los dos, en orden.
      expect(datosDeInforme(a, D24, D25).cierres.map((c) => c.antes === null)).toEqual([
        true,
        false,
      ])
    }
  })

  it('el cierre del día 25 de una mesa nueva sí es una cuenta, aunque el 24 se haya cerrado otra', () => {
    const a1 = pedidoCobrado(10_000, D24)
    const b1 = pedidoCobrado(15_000, D25)
    for (const a of aplicarEnAmbos([...a1.eventos, ...b1.eventos])) {
      expect(ventasDe(a, D24).ventas.cuentas).toBe(1)
      expect(ventasDe(a, D25).ventas).toMatchObject({ cuentas: 1, neto: 15_000 })
    }
  })
})

describe('período: pagos, anulaciones y reembolsos', () => {
  it('una anulación de hoy de un pago de ayer resta hoy y no ayer, con el medio del pago original', () => {
    const id = nuevoId()
    const item = copiaItem({ precio_unitario: 25_000 })
    const pago = pagoTarjeta(25_000, { propina: 2_000 })
    const eventos = [
      abrir(id),
      evento(id, 'ItemAgregado', item),
      evento(id, 'PagoRegistrado', pago, { dia_operativo: D23 }),
      evento(
        id,
        'PagoAnulado',
        { pago_id: pago.pago_id, turno_caja_id: TURNO },
        { motivo: 'm', dia_operativo: D24 },
      ),
    ]
    for (const a of aplicarEnAmbos(eventos)) {
      const hoy = informe({ ...datosDeInforme(a, D24, D24), config: CONFIG })
      expect(hoy.porMedio).toEqual([
        { medio: 'tarjeta', medioPropioId: null, venta: -25_000, propina: -2_000, pagos: -1 },
      ])
      const ayer = informe({ ...datosDeInforme(a, D23, D23), config: CONFIG })
      expect(ayer.porMedio).toEqual([
        { medio: 'tarjeta', medioPropioId: null, venta: 25_000, propina: 2_000, pagos: 1 },
      ])
      // Los dos días juntos se compensan: no queda nada.
      expect(informe({ ...datosDeInforme(a, D23, D24), config: CONFIG }).porMedio).toEqual([])
      // Un día aparte no ve ni el pago ni la anulación.
      expect(datosDeInforme(a, D25, D25).eventos).toEqual([])
    }
  })

  it('un reembolso parcial de un pago de otro día resta ese día y su pago original no se cuenta dos veces', () => {
    const id = nuevoId()
    const item = copiaItem({ precio_unitario: 40_000 })
    const pago = pagoEfectivo(40_000, { propina: 4_000 })
    const eventos = [
      abrir(id),
      evento(id, 'ItemAgregado', item),
      evento(id, 'PagoRegistrado', pago, { dia_operativo: D23 }),
      evento(
        id,
        'ReembolsoRegistrado',
        {
          pago_id: pago.pago_id,
          reembolso_id: nuevoId(),
          monto_venta: 10_000,
          monto_propina: 1_000,
          medio: 'efectivo',
          turno_caja_id: TURNO,
        },
        { motivo: 'm', dia_operativo: D25 },
      ),
    ]
    for (const a of aplicarEnAmbos(eventos)) {
      const d = datosDeInforme(a, D25, D25)
      expect(d.eventos.map((e) => e.tipo)).toEqual(['PagoRegistrado', 'ReembolsoRegistrado'])
      const r = informe({ ...d, config: CONFIG })
      expect(r.porMedio).toEqual([
        { medio: 'efectivo', medioPropioId: null, venta: -10_000, propina: -1_000, pagos: 0 },
      ])
      expect(r.fondoPropinas.propinas).toBe(-1_000)
    }
  })

  it('un pago de una mesa que cierra otro día cuenta por medio el día del pago y en ventas el del cierre', () => {
    const x = pedidoCobrado(50_000, D25, D24)
    for (const a of aplicarEnAmbos(x.eventos)) {
      const d24 = informe({ ...datosDeInforme(a, D24, D24), config: CONFIG })
      const d25 = informe({ ...datosDeInforme(a, D25, D25), config: CONFIG })
      expect(d24.ventas.neto).toBe(0)
      expect(d24.porMedio).toEqual([expect.objectContaining({ medio: 'efectivo', venta: 50_000 })])
      expect(d25.ventas.neto).toBe(50_000)
      expect(d25.porMedio).toEqual([])
    }
  })

  it('un período sin eventos da un informe en ceros', () => {
    for (const a of aplicarEnAmbos([])) {
      const r = informe({ ...datosDeInforme(a, D24, D24), config: CONFIG })
      expect(r.ventas).toMatchObject({ neto: 0, cuentas: 0, ticketPromedio: 0 })
      expect(r.porMedio).toEqual([])
      expect(datosDeInforme(a, D24, D24).cierresDeCaja).toEqual([])
    }
  })
})

describe('período: turnos que cruzan días', () => {
  /** Un turno abierto el 24 y cerrado el 25, con un pago de cada día y uno de ayer. */
  function turno() {
    const t = nuevoId()
    const c = (tipo: string, datos: unknown, dia: string) => ({
      id: nuevoId(),
      tipo,
      version_esquema: 1,
      agregado_tipo: 'turno_caja',
      agregado_id: t,
      relacionados: [],
      datos,
      sesion_id: null,
      usuario_id: MESERO,
      dispositivo_id: nuevoId(),
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: '2026-10-24T20:00:00.000Z',
      hora_estimada_hub: '2026-10-24T20:00:00.000Z',
      secuencia_base: 0,
      recibido_en: '2026-10-24T20:00:00.000Z',
      dia_operativo: dia,
      asignaciones: {},
      afecta: [],
      autorizado_por_id: null,
      secuencia: 0,
    })
    const arqueo = nuevoId()
    const a = pedidoCobrado(10_000, D24)
    const b = pedidoCobrado(20_000, D25)
    const pa = { ...a.pago, turno_caja_id: t }
    const pb = { ...b.pago, turno_caja_id: t }
    const eventos = [
      c('TurnoAbierto', { caja_id: nuevoId(), base: 50_000 }, D24),
      evento(a.id, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 2 }),
      evento(a.id, 'ItemAgregado', a.item),
      evento(a.id, 'PagoRegistrado', pa, { dia_operativo: D24 }),
      evento(a.id, 'PedidoCerrado', {}, { dia_operativo: D24 }),
      evento(b.id, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 2 }),
      evento(b.id, 'ItemAgregado', b.item),
      evento(b.id, 'PagoRegistrado', pb, { dia_operativo: D25 }),
      evento(b.id, 'PedidoCerrado', {}, { dia_operativo: D25 }),
      c(
        'ArqueoRegistrado',
        { arqueo_id: arqueo, conteo: [{ valor: 1_000, cantidad: 80 }], contado_efectivo: 80_000 },
        D25,
      ),
      c(
        'TurnoCerrado',
        {
          arqueo_id: arqueo,
          esperado_efectivo: 80_000,
          contado_efectivo: 80_000,
          diferencia: 0,
          justificacion: null,
          otros_medios: [],
        },
        D25,
      ),
    ] as unknown as EventoPedido[]
    return { t, eventos }
  }

  it('el cierre se lista el día en que se cierra y conoce el día en que se abrió', () => {
    const { t, eventos } = turno()
    for (const a of aplicarEnAmbos(eventos)) {
      expect(datosDeInforme(a, D24, D24).cierresDeCaja).toEqual([])
      const [cierre] = datosDeInforme(a, D25, D25).cierresDeCaja
      expect(cierre).toMatchObject({ diaOperativo: D25, diaApertura: D24 })
      expect(cierre?.cuadre.efectivo).toMatchObject({ cobrado: 30_000, esperado: 80_000 })
      expect(cierreDeTurno(a, t)?.diaApertura).toBe(D24)
      expect(datosDeInforme(a, D24, D25).cierresDeCaja).toHaveLength(1)
    }
  })

  it('el cuadre cuenta los cobros de los dos días del turno', () => {
    const { t, eventos } = turno()
    for (const a of aplicarEnAmbos(eventos)) {
      expect(cuadreGuardado(a, t)?.efectivo.cobrado).toBe(30_000)
      expect(a.cobrosDeTurno(t, D24)).toHaveLength(2)
      // Cobros anteriores a la apertura no son de este turno.
      expect(a.cobrosDeTurno(t, D25)).toHaveLength(1)
      expect(a.cobrosDeTurno(t, D26)).toHaveLength(0)
    }
  })
})

describe('período: anulaciones de ítems que luego se unen o se mueven a otra mesa', () => {
  const anular = (id: string, itemId: string, cantidad: number) =>
    evento(
      id,
      'ItemAnulado',
      { item_id: itemId, cantidad, ya_preparado: true, comanda_id: null },
      { motivo: 'Se cayó' },
    )

  it('tras unir las mesas la anulación sigue con su producto y su valor, de punta a punta', () => {
    const origen = nuevoId()
    const destino = nuevoId()
    const item = copiaItem({ precio_unitario: 12_000, cantidad: 3, nombre: 'Limonada' })
    const eventos = [
      abrir(origen),
      abrir(destino),
      evento(origen, 'ItemAgregado', item),
      enviar(origen, item.item_id),
      anular(origen, item.item_id, 2),
      evento(
        destino,
        'PedidosUnidos',
        {
          pedido_origen_id: origen,
          items: [{ item, estado: 'enviado', cantidad_anulada: 2, agregado_por: MESERO }],
        },
        { relacionados: [origen] },
      ),
    ]
    for (const a of aplicarEnAmbos(eventos)) {
      const r = informe({ ...datosDeInforme(a, D24, D24), config: CONFIG })
      expect(r.anulaciones).toEqual([
        expect.objectContaining({ nombre: 'Limonada', unidades: 2, valor: 24_000 }),
      ])
    }
  })

  it('tras mover el ítem a otra mesa la anulación sigue con su producto y su valor', () => {
    const origen = nuevoId()
    const destino = nuevoId()
    const item = copiaItem({ precio_unitario: 9_000, cantidad: 2, nombre: 'Cerveza' })
    const eventos = [
      abrir(origen),
      abrir(destino),
      evento(origen, 'ItemAgregado', item),
      enviar(origen, item.item_id),
      anular(origen, item.item_id, 1),
      evento(
        origen,
        'ItemsMovidos',
        {
          pedido_destino_id: destino,
          items: [{ item, estado: 'enviado', cantidad_anulada: 1, agregado_por: MESERO }],
        },
        { relacionados: [destino] },
      ),
    ]
    for (const a of aplicarEnAmbos(eventos)) {
      const r = informe({ ...datosDeInforme(a, D24, D24), config: CONFIG })
      expect(r.anulaciones).toEqual([
        expect.objectContaining({ nombre: 'Cerveza', unidades: 1, valor: 9_000, pedidoId: origen }),
      ])
    }
  })

  it('dos anulaciones del mismo ítem cada una con el precio que tenía, y una de un pedido ajeno no se mezcla', () => {
    const id = nuevoId()
    const otro = nuevoId()
    const item = copiaItem({ precio_unitario: 5_000, cantidad: 4 })
    const itemOtro = copiaItem({ precio_unitario: 7_000, cantidad: 1, nombre: 'Otra cosa' })
    const eventos = [
      abrir(id),
      abrir(otro),
      evento(id, 'ItemAgregado', item),
      evento(otro, 'ItemAgregado', itemOtro),
      enviar(id, item.item_id),
      enviar(otro, itemOtro.item_id),
      anular(id, item.item_id, 1),
      anular(otro, itemOtro.item_id, 1),
      anular(id, item.item_id, 2),
    ]
    for (const a of aplicarEnAmbos(eventos)) {
      const r = informe({ ...datosDeInforme(a, D24, D24), config: CONFIG })
      expect(r.anulaciones.map((x) => [x.pedidoId === id, x.unidades, x.valor])).toEqual([
        [true, 1, 5_000],
        [false, 1, 7_000],
        [true, 2, 10_000],
      ])
    }
  })
})
