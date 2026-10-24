import { describe, expect, it } from 'vitest'
import { LIMITE_PRECIO, LIMITE_TOTAL_PEDIDO } from '../dinero'
import { nuevoId } from '../id'
import { copiaItem, HORA, pagoEfectivo, pagoTarjeta, TURNO } from '../pruebas/fabrica'
import { validarEventoNuevo } from './pedido'

// Esquemas: negativos donde no corresponde, fracciones, enteros no seguros y montos sobre el
// límite (docs/DINERO.md#principios, punto 6). Cada caso rechaza el valor malo y acepta el borde.

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

const acepta = (tipo: string, datos: unknown, extras?: Record<string, unknown>) =>
  validarEventoNuevo(sobre(tipo, datos, extras)).ok
const MOTIVO = { motivo: 'Motivo de prueba' }

/** Valores que ningún monto en pesos puede tomar. */
const MALOS = {
  negativo: -1,
  fracción: 1000.5,
  'entero no seguro': 2 ** 53,
  'sobre el límite': LIMITE_TOTAL_PEDIDO + 1,
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  texto: '1000',
} as const

const casosMalos = Object.entries(MALOS)

describe('montos de pago', () => {
  it.each(casosMalos)('PagoRegistrado rechaza monto %s', (_n, valor) => {
    expect(acepta('PagoRegistrado', { ...pagoTarjeta(1000), monto: valor })).toBe(false)
  })

  it.each(casosMalos)('PagoRegistrado rechaza propina %s', (_n, valor) => {
    expect(acepta('PagoRegistrado', { ...pagoTarjeta(1000), propina: valor })).toBe(false)
  })

  it.each(casosMalos)('PagoRegistrado en efectivo rechaza cambio %s', (_n, valor) => {
    expect(acepta('PagoRegistrado', { ...pagoEfectivo(1000), cambio: valor })).toBe(false)
  })

  it.each(casosMalos.filter(([nombre]) => nombre !== 'negativo'))(
    'PagoRegistrado rechaza ajuste de redondeo %s',
    (_n, valor) => {
      expect(acepta('PagoRegistrado', { ...pagoEfectivo(1000), ajuste_redondeo: valor })).toBe(
        false,
      )
    },
  )

  it('el ajuste de redondeo es el único monto que puede ser negativo, hasta el límite', () => {
    expect(acepta('PagoRegistrado', pagoEfectivo(1000, { ajuste_redondeo: -50 }))).toBe(true)
    const tarjetaGrande = pagoTarjeta(LIMITE_TOTAL_PEDIDO)
    expect(acepta('PagoRegistrado', tarjetaGrande)).toBe(true)
    expect(acepta('PagoRegistrado', { ...tarjetaGrande, monto: LIMITE_TOTAL_PEDIDO + 1 })).toBe(
      false,
    )
    expect(
      acepta('PagoRegistrado', {
        ...pagoEfectivo(LIMITE_TOTAL_PEDIDO),
        ajuste_redondeo: -(LIMITE_TOTAL_PEDIDO + 1),
        recibido: 0,
      }),
    ).toBe(false)
  })

  it('un pago sin turno o con un turno que no es ULID se rechaza', () => {
    expect(acepta('PagoRegistrado', { ...pagoTarjeta(1000), turno_caja_id: null })).toBe(false)
    expect(acepta('PagoRegistrado', { ...pagoTarjeta(1000), turno_caja_id: 'turno-1' })).toBe(false)
    const { turno_caja_id: _quitado, ...sinTurno } = pagoTarjeta(1000)
    expect(acepta('PagoRegistrado', sinTurno)).toBe(false)
    expect(acepta('PagoRegistrado', pagoTarjeta(1000, { turno_caja_id: TURNO }))).toBe(true)
  })

  it('anular un pago también exige el turno en que se registra la anulación', () => {
    expect(acepta('PagoAnulado', { pago_id: nuevoId(), turno_caja_id: nuevoId() }, MOTIVO)).toBe(
      true,
    )
    expect(acepta('PagoAnulado', { pago_id: nuevoId(), turno_caja_id: null }, MOTIVO)).toBe(false)
    expect(acepta('PagoAnulado', { pago_id: nuevoId() }, MOTIVO)).toBe(false)
  })
})

describe('reembolsos', () => {
  const reembolso = (campos: Record<string, unknown>) => ({
    pago_id: nuevoId(),
    reembolso_id: nuevoId(),
    monto_venta: 1000,
    monto_propina: 0,
    medio: 'tarjeta',
    turno_caja_id: TURNO,
    ...campos,
  })

  it.each(casosMalos)('rechaza monto_venta %s', (_n, valor) => {
    expect(acepta('ReembolsoRegistrado', reembolso({ monto_venta: valor }), MOTIVO)).toBe(false)
  })

  it.each(casosMalos)('rechaza monto_propina %s', (_n, valor) => {
    expect(acepta('ReembolsoRegistrado', reembolso({ monto_propina: valor }), MOTIVO)).toBe(false)
  })

  it('exige algo que devolver, en venta o en propina', () => {
    expect(
      acepta('ReembolsoRegistrado', reembolso({ monto_venta: 0, monto_propina: 0 }), MOTIVO),
    ).toBe(false)
    expect(
      acepta('ReembolsoRegistrado', reembolso({ monto_venta: 0, monto_propina: 500 }), MOTIVO),
    ).toBe(true)
  })
})

describe('descuentos, cuentas y precuenta', () => {
  const descuento = (campos: Record<string, unknown>, monto: unknown = 1000) => ({
    descuento_id: nuevoId(),
    alcance: 'item',
    regla: 'valor',
    valor: 1000,
    cantidad_unidades: null,
    montos: [{ item_id: nuevoId(), monto }],
    ...campos,
  })

  it.each(casosMalos)('DescuentoAplicado rechaza un monto por línea %s', (_n, valor) => {
    expect(acepta('DescuentoAplicado', descuento({}, valor), MOTIVO)).toBe(false)
  })

  it.each(casosMalos.filter(([nombre]) => nombre !== 'sobre el límite'))(
    'DescuentoAplicado rechaza un valor %s',
    (_n, valor) => {
      expect(acepta('DescuentoAplicado', descuento({ valor }), MOTIVO)).toBe(false)
    },
  )

  it('un descuento de $0 en una línea sí es válido (pedido de $0), pero sin líneas no', () => {
    expect(acepta('DescuentoAplicado', descuento({ valor: 0 }, 0), MOTIVO)).toBe(true)
    expect(acepta('DescuentoAplicado', descuento({ montos: [] }), MOTIVO)).toBe(false)
  })

  it.each(['monto', 'propina_sugerida'])('CuentaDividida rechaza %s malo', (campo) => {
    const cuenta = (valor: unknown) => ({
      cuenta_id: nuevoId(),
      nombre: 'Cuenta',
      monto: 1000,
      propina_sugerida: 0,
      items: [],
      [campo]: valor,
    })
    for (const [, valor] of casosMalos) {
      expect(acepta('CuentaDividida', { cuentas: [cuenta(valor), cuenta(1000)] })).toBe(false)
    }
    expect(acepta('CuentaDividida', { cuentas: [cuenta(LIMITE_TOTAL_PEDIDO), cuenta(0)] })).toBe(
      true,
    )
  })

  it('una división necesita al menos dos cuentas', () => {
    const cuenta = {
      cuenta_id: nuevoId(),
      nombre: 'Único',
      monto: 1000,
      propina_sugerida: 0,
      items: [],
    }
    expect(acepta('CuentaDividida', { cuentas: [cuenta] })).toBe(false)
    expect(acepta('CuentaDividida', { cuentas: [] })).toBe(false)
  })

  it.each(['subtotal', 'propina_sugerida'])('PrecuentaImpresa rechaza %s malo', (campo) => {
    for (const [, valor] of casosMalos) {
      expect(
        acepta('PrecuentaImpresa', {
          cuenta_id: null,
          subtotal: 1000,
          propina_sugerida: 0,
          [campo]: valor,
        }),
      ).toBe(false)
    }
  })
})

describe('ítems', () => {
  const item = (campos: Record<string, unknown>) => ({ ...copiaItem(), ...campos })

  it.each([
    ['negativo', -1],
    ['fracción', 40_900.5],
    ['entero no seguro', 2 ** 53],
    ['sobre el límite', LIMITE_PRECIO + 1],
    ['NaN', Number.NaN],
  ])('rechaza un precio_unitario %s', (_n, valor) => {
    expect(acepta('ItemAgregado', item({ precio_unitario: valor }))).toBe(false)
  })

  it.each([
    ['negativo', -1],
    ['fracción', 0.5],
    ['entero no seguro', 2 ** 53],
    ['sobre el límite', LIMITE_PRECIO + 1],
  ])('rechaza un precio_extra %s', (_n, valor) => {
    const modificador = { modificador_id: nuevoId(), nombre: 'Extra', precio_extra: valor }
    expect(acepta('ItemAgregado', item({ modificadores: [modificador] }))).toBe(false)
  })

  it.each([
    ['fracción', 1.5],
    ['entero no seguro', 2 ** 53],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['texto', '2'],
  ])('rechaza una cantidad %s', (_n, valor) => {
    expect(acepta('ItemAgregado', item({ cantidad: valor }))).toBe(false)
    expect(acepta('ItemCambiado', { item_id: nuevoId(), cantidad: valor })).toBe(false)
    expect(
      acepta(
        'ItemAnulado',
        { item_id: nuevoId(), cantidad: valor, ya_preparado: false, comanda_id: null },
        MOTIVO,
      ),
    ).toBe(false)
  })

  it('rechaza una tarifa con fracción o negativa', () => {
    expect(acepta('ItemAgregado', item({ tarifa: 800.5 }))).toBe(false)
    expect(acepta('ItemAgregado', item({ tarifa: -800 }))).toBe(false)
  })

  it('acepta los bordes: la unidad con extras en el tope, cantidad 1 y 999, precio 0', () => {
    const extra = (precio_extra: number) => ({
      modificador_id: nuevoId(),
      nombre: 'Extra',
      precio_extra,
    })
    expect(
      acepta(
        'ItemAgregado',
        item({ precio_unitario: LIMITE_PRECIO - 1000, modificadores: [extra(1000)] }),
      ),
    ).toBe(true)
    // El tope es de la unidad completa (precio + extras), no de cada parte.
    expect(
      acepta('ItemAgregado', item({ precio_unitario: LIMITE_PRECIO, modificadores: [extra(1)] })),
    ).toBe(false)
    expect(acepta('ItemAgregado', item({ cantidad: 999 }))).toBe(true)
    expect(acepta('ItemAgregado', item({ cantidad: 1, precio_unitario: 0 }))).toBe(true)
  })

  it('el ítem movido rechaza una cantidad anulada negativa o fraccionaria', () => {
    const destino = nuevoId()
    const { catalogo_version: _c, precio_canal_id: _p, ...copia } = copiaItem()
    const movido = (cantidad_anulada: number) => ({
      pedido_destino_id: destino,
      items: [
        {
          item: copia,
          estado: 'enviado',
          cantidad_anulada,
          agregado_por: nuevoId(),
        },
      ],
    })
    const conDestino = { relacionados: [destino] }
    expect(acepta('ItemsMovidos', movido(0), conDestino)).toBe(true)
    expect(acepta('ItemsMovidos', movido(-1), conDestino)).toBe(false)
    expect(acepta('ItemsMovidos', movido(0.5), conDestino)).toBe(false)
    // Un ítem anulado por completo (1 de 1) no se mueve.
    expect(acepta('ItemsMovidos', movido(1), conDestino)).toBe(false)
  })
})
