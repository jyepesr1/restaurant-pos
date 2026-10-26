import { describe, expect, it } from 'vitest'
import { LIMITE_TOTAL_PEDIDO } from '../dinero'
import { validarEventoNuevo } from '../eventos/pedido'
import { nuevoId } from '../id'
import { HORA } from '../pruebas/fabrica'

// Los cierres de los demás medios en los eventos de caja (tarea 1.8): `ArqueoRegistrado.otros`
// (lo que dicen el datáfono y las apps, escrito con el conteo) y `TurnoCerrado.otros_medios` (lo
// registrado, lo reportado y la diferencia con signo).

const sobre = (tipo: string, datos: unknown) => ({
  id: nuevoId(),
  tipo,
  version_esquema: 1,
  agregado_tipo: 'turno_caja',
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
})
const ok = (e: unknown) => validarEventoNuevo(e).ok
const errores = (e: unknown) => {
  const r = validarEventoNuevo(e)
  return r.ok ? [] : r.errores
}

const arqueo = (campos: Record<string, unknown> = {}) => ({
  arqueo_id: nuevoId(),
  conteo: [{ valor: 20_000, cantidad: 3 }],
  contado_efectivo: 60_000,
  ...campos,
})
const cierre = (campos: Record<string, unknown> = {}) => ({
  arqueo_id: nuevoId(),
  esperado_efectivo: 100_000,
  contado_efectivo: 100_000,
  diferencia: 0,
  justificacion: null,
  ...campos,
})
const reporte = (medio: string, reportado: number, propio: string | null = null) => ({
  medio,
  medio_propio_id: propio,
  reportado,
})
const linea = (
  medio: string,
  esperado: number,
  reportado: number,
  propio: string | null = null,
) => ({
  medio,
  medio_propio_id: propio,
  esperado,
  reportado,
  diferencia: reportado - esperado,
})
const conOtros = (otros: unknown) => sobre('ArqueoRegistrado', arqueo({ otros }))
const conMedios = (otros_medios: unknown) => sobre('TurnoCerrado', cierre({ otros_medios }))

describe('ArqueoRegistrado.otros: esquema', () => {
  it('es opcional: un conteo de la 1.7, sin el campo, sigue valiendo', () => {
    expect(ok(sobre('ArqueoRegistrado', arqueo()))).toBe(true)
  })

  it('una lista vacía vale', () => {
    expect(ok(conOtros([]))).toBe(true)
  })

  it('acepta la tarjeta y una app con su cierre', () => {
    expect(ok(conOtros([reporte('tarjeta', 250_000), reporte('nequi', 80_000)]))).toBe(true)
  })

  it.each(['tarjeta', 'nequi', 'daviplata', 'breb', 'transferencia', 'bono'])(
    'cada medio que no es efectivo vale: %s',
    (medio) => {
      expect(ok(conOtros([reporte(medio, 1_000)]))).toBe(true)
    },
  )

  it('el efectivo no va aquí: se cuenta con billetes y monedas', () => {
    expect(ok(conOtros([reporte('efectivo', 1_000)]))).toBe(false)
    expect(ok(conOtros([reporte('tarjeta', 1_000), reporte('efectivo', 0)]))).toBe(false)
  })

  it('un medio que no existe se rechaza', () => {
    expect(ok(conOtros([reporte('paypal', 1_000)]))).toBe(false)
  })

  it('un medio no puede repetirse', () => {
    expect(ok(conOtros([reporte('tarjeta', 1_000), reporte('tarjeta', 2_000)]))).toBe(false)
    expect(ok(conOtros([reporte('nequi', 0), reporte('nequi', 0)]))).toBe(false)
    expect(errores(conOtros([reporte('tarjeta', 1), reporte('tarjeta', 1)])).join()).toContain(
      'Un medio aparece dos veces',
    )
  })

  it('medios distintos no cuentan como repetidos', () => {
    expect(
      ok(conOtros([reporte('tarjeta', 1), reporte('nequi', 1), reporte('daviplata', 1)])),
    ).toBe(true)
  })

  describe('el medio propio dice cuál es, y solo ese', () => {
    const sodexo = nuevoId()
    const qr = nuevoId()

    it('«otro» con su id vale', () => {
      expect(ok(conOtros([reporte('otro', 30_000, sodexo)]))).toBe(true)
    })

    it('«otro» sin id se rechaza', () => {
      expect(ok(conOtros([reporte('otro', 30_000, null)]))).toBe(false)
    })

    it('un medio que no es «otro» con id se rechaza', () => {
      expect(ok(conOtros([reporte('tarjeta', 30_000, sodexo)]))).toBe(false)
      expect(ok(conOtros([reporte('nequi', 30_000, sodexo)]))).toBe(false)
    })

    it('dos medios propios distintos valen; el mismo dos veces, no', () => {
      expect(ok(conOtros([reporte('otro', 1, sodexo), reporte('otro', 2, qr)]))).toBe(true)
      expect(ok(conOtros([reporte('otro', 1, sodexo), reporte('otro', 2, sodexo)]))).toBe(false)
    })

    it('un medio propio y uno estándar juntos valen', () => {
      expect(ok(conOtros([reporte('otro', 1, sodexo), reporte('tarjeta', 2)]))).toBe(true)
    })

    it('el id del medio propio debe ser un ULID', () => {
      expect(ok(conOtros([reporte('otro', 1, 'sodexo')]))).toBe(false)
      expect(ok(conOtros([reporte('otro', 1, '')]))).toBe(false)
    })
  })

  it('lo reportado va de −tope a +tope (un día de solo devoluciones cierra en negativo); con fracción o pasado del tope se rechaza', () => {
    expect(ok(conOtros([reporte('tarjeta', 0)]))).toBe(true)
    expect(ok(conOtros([reporte('tarjeta', LIMITE_TOTAL_PEDIDO)]))).toBe(true)
    expect(ok(conOtros([reporte('tarjeta', -1)]))).toBe(true)
    expect(ok(conOtros([reporte('tarjeta', -LIMITE_TOTAL_PEDIDO)]))).toBe(true)
    expect(ok(conOtros([reporte('tarjeta', -LIMITE_TOTAL_PEDIDO - 1)]))).toBe(false)
    expect(ok(conOtros([reporte('tarjeta', -1.5)]))).toBe(false)
    expect(ok(conOtros([reporte('tarjeta', 1.5)]))).toBe(false)
    expect(ok(conOtros([reporte('tarjeta', LIMITE_TOTAL_PEDIDO + 1)]))).toBe(false)
    expect(ok(conOtros([reporte('tarjeta', Number.NaN)]))).toBe(false)
    expect(ok(conOtros([{ ...reporte('tarjeta', 1), reportado: '1000' }]))).toBe(false)
  })

  it('hasta 30 medios; con 31 se rechaza', () => {
    const propios = (n: number) => Array.from({ length: n }, () => reporte('otro', 1, nuevoId()))
    const estandar = ['tarjeta', 'nequi', 'daviplata', 'breb', 'transferencia', 'bono'].map((m) =>
      reporte(m, 1),
    )
    expect(ok(conOtros([...estandar, ...propios(24)]))).toBe(true)
    expect(ok(conOtros([...estandar, ...propios(25)]))).toBe(false)
  })

  it('esquema estricto: un campo de más en un medio se rechaza', () => {
    expect(ok(conOtros([{ ...reporte('tarjeta', 1), esperado: 1 }]))).toBe(false)
  })

  it('falta medio_propio_id: se rechaza (es nullable, no opcional)', () => {
    expect(ok(conOtros([{ medio: 'tarjeta', reportado: 1 }]))).toBe(false)
  })

  it('no es una lista: se rechaza', () => {
    expect(ok(conOtros(null))).toBe(false)
    expect(ok(conOtros({ medio: 'tarjeta', reportado: 1 }))).toBe(false)
  })

  it('el conteo del efectivo sigue exigiendo su suma exacta aunque haya otros medios', () => {
    expect(
      ok(
        sobre(
          'ArqueoRegistrado',
          arqueo({ contado_efectivo: 59_999, otros: [reporte('tarjeta', 1)] }),
        ),
      ),
    ).toBe(false)
  })
})

describe('TurnoCerrado.otros_medios: esquema', () => {
  it('es opcional: un cierre de la 1.7, sin el campo, sigue valiendo', () => {
    expect(ok(sobre('TurnoCerrado', cierre()))).toBe(true)
  })

  it('una lista vacía vale', () => {
    expect(ok(conMedios([]))).toBe(true)
  })

  it('acepta faltante, sobrante y cuadre exacto por medio', () => {
    expect(
      ok(
        conMedios([
          linea('tarjeta', 250_000, 250_000),
          linea('nequi', 80_000, 70_000),
          linea('daviplata', 10_000, 15_000),
        ]),
      ),
    ).toBe(true)
  })

  it('la diferencia es reportado − esperado, con signo: el signo cambiado o un peso de más se rechaza', () => {
    const mal = (d: number) => conMedios([{ ...linea('nequi', 80_000, 70_000), diferencia: d }])
    expect(ok(mal(-10_000))).toBe(true)
    expect(ok(mal(10_000))).toBe(false)
    expect(ok(mal(-9_999))).toBe(false)
    expect(ok(mal(0))).toBe(false)
    expect(errores(mal(10_000)).join()).toContain('lo reportado menos lo esperado')
  })

  it('una sola línea mal arruina el cierre aunque las demás estén bien', () => {
    expect(
      ok(
        conMedios([linea('tarjeta', 1_000, 1_000), { ...linea('nequi', 1_000, 0), diferencia: 0 }]),
      ),
    ).toBe(false)
  })

  it('lo esperado puede ser negativo (se anuló en este turno un pago de uno anterior)', () => {
    expect(ok(conMedios([linea('tarjeta', -5_000, 0)]))).toBe(true)
    expect(ok(conMedios([linea('tarjeta', -5_000, 2_000)]))).toBe(true)
  })

  it('lo reportado puede ser negativo (solo devoluciones) pero no fraccionado; lo esperado tampoco es fraccionado', () => {
    expect(ok(conMedios([linea('tarjeta', 1_000, -1)]))).toBe(true)
    expect(ok(conMedios([linea('tarjeta', -5_000, -5_000)]))).toBe(true)
    expect(ok(conMedios([linea('tarjeta', 1_000, -LIMITE_TOTAL_PEDIDO - 1)]))).toBe(false)
    expect(ok(conMedios([linea('tarjeta', 1_000, 0.5)]))).toBe(false)
    expect(ok(conMedios([linea('tarjeta', 1_000.5, 1_000)]))).toBe(false)
  })

  it('el efectivo no va entre los demás medios', () => {
    expect(ok(conMedios([linea('efectivo', 1_000, 1_000)]))).toBe(false)
  })

  it('los límites del tope: lo esperado va de −tope a +tope; uno más se rechaza', () => {
    expect(ok(conMedios([linea('tarjeta', LIMITE_TOTAL_PEDIDO, LIMITE_TOTAL_PEDIDO)]))).toBe(true)
    expect(ok(conMedios([linea('tarjeta', -LIMITE_TOTAL_PEDIDO, 0)]))).toBe(true)
    expect(ok(conMedios([linea('tarjeta', LIMITE_TOTAL_PEDIDO + 1, LIMITE_TOTAL_PEDIDO)]))).toBe(
      false,
    )
    expect(ok(conMedios([linea('tarjeta', -LIMITE_TOTAL_PEDIDO - 1, 0)]))).toBe(false)
    // La diferencia pasa del tope aunque esperado y reportado valgan.
    expect(ok(conMedios([linea('tarjeta', -LIMITE_TOTAL_PEDIDO, LIMITE_TOTAL_PEDIDO)]))).toBe(false)
  })

  it('un medio propio lleva su id (ULID) o null', () => {
    const sodexo = nuevoId()
    expect(ok(conMedios([linea('otro', 5_000, 5_000, sodexo)]))).toBe(true)
    expect(ok(conMedios([linea('otro', 5_000, 5_000, 'sodexo')]))).toBe(false)
  })

  it('falta un campo o sobra uno: se rechaza', () => {
    const { diferencia: _d, ...sinDiferencia } = linea('tarjeta', 1, 1)
    expect(ok(conMedios([sinDiferencia]))).toBe(false)
    expect(ok(conMedios([{ ...linea('tarjeta', 1, 1), extra: true }]))).toBe(false)
  })

  it('hasta 30 líneas', () => {
    const propios = (n: number) => Array.from({ length: n }, () => linea('otro', 1, 1, nuevoId()))
    expect(ok(conMedios(propios(30)))).toBe(true)
    expect(ok(conMedios(propios(31)))).toBe(false)
  })

  it('el efectivo sigue pidiendo su diferencia exacta aunque haya otros medios', () => {
    expect(
      ok(sobre('TurnoCerrado', cierre({ diferencia: 5, otros_medios: [linea('tarjeta', 1, 1)] }))),
    ).toBe(false)
  })
})
