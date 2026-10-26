import { describe, expect, it } from 'vitest'
import { nuevoId } from '../id'
import { copiaItem, HORA, pagoEfectivo, pagoTarjeta } from '../pruebas/fabrica'
import { TIPOS_EVENTO_PEDIDO, validarEventoNuevo } from './pedido'

const sobre = (tipo: string, datos: unknown, extras: Record<string, unknown> = {}) => ({
  id: nuevoId(),
  tipo,
  version_esquema: 1,
  agregado_tipo: 'pedido',
  agregado_id: nuevoId(),
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
})

const errores = (entrada: unknown) => {
  const r = validarEventoNuevo(entrada)
  return r.ok ? [] : r.errores
}

describe('esquemas de eventos del pedido', () => {
  it('acepta un ItemAgregado válido', () => {
    expect(errores(sobre('ItemAgregado', copiaItem()))).toEqual([])
  })

  it('cubre todos los tipos del catálogo v1: 34 del pedido, 2 del producto (agotado) y 1 de caja', () => {
    expect(TIPOS_EVENTO_PEDIDO).toHaveLength(37)
  })

  it('rechaza un tipo desconocido', () => {
    expect(errores(sobre('ItemBorrado', {}))).not.toEqual([])
  })

  it.each([
    ['precio con decimales', { precio_unitario: 40_900.5 }],
    ['precio negativo', { precio_unitario: -1 }],
    ['precio sobre el tope', { precio_unitario: 100_000_001 }],
    ['cantidad 0', { cantidad: 0 }],
    ['cantidad 1000', { cantidad: 1000 }],
    ['tarifa sobre 10.000', { tarifa: 10_001 }],
    ['exento con tarifa', { impuesto_tipo: 'exento', tarifa: 800 }],
  ])('rechaza un ítem con %s', (_caso, campos) => {
    expect(errores(sobre('ItemAgregado', { ...copiaItem(), ...campos }))).not.toEqual([])
  })

  it('rechaza ids que no son ULID canónicos', () => {
    expect(
      errores(sobre('ItemAgregado', copiaItem(), { id: nuevoId().toLowerCase() })),
    ).not.toEqual([])
    expect(errores(sobre('ItemQuitado', { item_id: 'mesa-5' }))).not.toEqual([])
  })

  it('exige motivo en anulaciones, descuentos, cancelaciones y reaperturas', () => {
    const anulacion = { item_id: nuevoId(), cantidad: 1, ya_preparado: false, comanda_id: null }
    expect(errores(sobre('ItemAnulado', anulacion))).toEqual([
      'motivo: ItemAnulado exige un motivo',
    ])
    expect(errores(sobre('ItemAnulado', anulacion, { motivo: 'Cliente cambió de idea' }))).toEqual(
      [],
    )
    expect(errores(sobre('PedidoCancelado', {}))).not.toEqual([])
    expect(errores(sobre('PedidoReabierto', {}, { motivo: 'Faltó cobrar' }))).toEqual([])
  })

  it('en efectivo exige recibido = monto + ajuste + propina + cambio', () => {
    expect(
      errores(
        sobre('PagoRegistrado', pagoEfectivo(36_810, { ajuste_redondeo: -10, cambio: 3200 })),
      ),
    ).toEqual([])
    expect(
      errores(
        sobre('PagoRegistrado', { ...pagoEfectivo(36_810, { cambio: 3200 }), recibido: 40_000 }),
      ),
    ).not.toEqual([])
    expect(errores(sobre('PagoRegistrado', { ...pagoEfectivo(100), recibido: null }))).not.toEqual(
      [],
    )
  })

  it('fuera del efectivo no admite recibido, cambio ni ajuste', () => {
    expect(errores(sobre('PagoRegistrado', pagoTarjeta(50_000)))).toEqual([])
    expect(errores(sobre('PagoRegistrado', { ...pagoTarjeta(50_000), cambio: 0 }))).not.toEqual([])
    expect(
      errores(sobre('PagoRegistrado', { ...pagoTarjeta(50_000), ajuste_redondeo: -10 })),
    ).not.toEqual([])
  })

  it('rechaza un pago de 0 y lo cobrado negativo', () => {
    expect(errores(sobre('PagoRegistrado', pagoTarjeta(0)))).not.toEqual([])
    expect(
      errores(sobre('PagoRegistrado', pagoEfectivo(30, { ajuste_redondeo: -50 }))),
    ).not.toEqual([])
    expect(errores(sobre('PagoRegistrado', pagoEfectivo(30, { ajuste_redondeo: -30 })))).toEqual([])
  })

  it('rechaza fracciones de ítem compartido mayores que 1', () => {
    const cuenta = (fraccion: { n: number; d: number }) => ({
      cuenta_id: nuevoId(),
      nombre: 'Comensal 1',
      monto: 1000,
      propina_sugerida: 0,
      items: [{ item_id: nuevoId(), fraccion }],
    })
    const dividir = (fraccion: { n: number; d: number }) =>
      sobre('CuentaDividida', { cuentas: [cuenta(fraccion), cuenta(fraccion)] })

    expect(errores(dividir({ n: 1, d: 3 }))).toEqual([])
    expect(errores(dividir({ n: 4, d: 3 }))).not.toEqual([])
  })

  it('un ItemCambiado debe cambiar algo', () => {
    expect(errores(sobre('ItemCambiado', { item_id: nuevoId() }))).not.toEqual([])
    expect(errores(sobre('ItemCambiado', { item_id: nuevoId(), cantidad: 2 }))).toEqual([])
  })

  it('no lanza con entradas basura', () => {
    for (const basura of [null, 42, 'evento', [], {}, { tipo: 'ItemAgregado' }]) {
      expect(validarEventoNuevo(basura).ok).toBe(false)
    }
  })
})
