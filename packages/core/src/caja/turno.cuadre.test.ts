import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { EventoPedido } from '../eventos/pedido'
import { nuevoId } from '../id'
import { evento, pagoEfectivo, pagoTarjeta } from '../pruebas/fabrica'
import { type CobradoPorMedio, cobradoDelTurno, cuadreDeTurno, DENOMINACIONES } from './turno'

// El cuadre del turno (tarea 1.7, docs/DINERO.md#caja): anulaciones y reembolsos en el turno donde
// se registran, medios propios, varios conteos y propiedades. Complementa turno.test.ts.

type Datos<T extends EventoPedido['tipo']> = Extract<EventoPedido, { tipo: T }>['datos']
type Hub = { recibido_en?: string | null; hora_estimada_hub?: string }

/** Un turno con sus eventos de apertura y movimientos, listo para armar escenarios. */
function turnoNuevo(base = 0, extras: Hub = {}) {
  const id = nuevoId()
  const caja = nuevoId()
  const deTurno = <T extends EventoPedido['tipo']>(tipo: T, datos: unknown, hub: Hub = {}) =>
    evento(id, tipo, datos as never, { agregado_tipo: 'turno_caja', ...hub } as never)
  const apertura = deTurno('TurnoAbierto', { caja_id: caja, base }, extras)
  return {
    id,
    caja,
    apertura,
    deTurno,
    mover: (
      tipo: 'entrada' | 'salida' | 'pago_propinas',
      monto: number,
      campos: Partial<Datos<'MovimientoCajaRegistrado'>> = {},
      hub: Hub = {},
    ) =>
      deTurno(
        'MovimientoCajaRegistrado',
        {
          movimiento_id: nuevoId(),
          tipo,
          monto,
          descripcion: `Mov ${tipo}`,
          a_quien: tipo === 'pago_propinas' ? 'Equipo' : null,
          dias: tipo === 'pago_propinas' ? ['2026-10-25'] : [],
          ...campos,
        },
        hub,
      ),
    arqueo: (conteo: { valor: number; cantidad: number }[], hub: Hub = {}) => {
      const contado = conteo.reduce((s, c) => s + c.valor * c.cantidad, 0)
      return deTurno(
        'ArqueoRegistrado',
        { arqueo_id: nuevoId(), conteo, contado_efectivo: contado },
        hub,
      )
    },
  }
}

const pagar = (datos: Datos<'PagoRegistrado'>) => evento(nuevoId(), 'PagoRegistrado', datos)
const anular = (pago: Datos<'PagoRegistrado'>, turnoId: string) =>
  evento(
    nuevoId(),
    'PagoAnulado',
    { pago_id: pago.pago_id, turno_caja_id: turnoId },
    { motivo: 'Error de caja' },
  )
const reembolsar = (pago: Datos<'PagoRegistrado'>, turnoId: string, venta: number, propina = 0) =>
  evento(
    nuevoId(),
    'ReembolsoRegistrado',
    {
      pago_id: pago.pago_id,
      reembolso_id: nuevoId(),
      monto_venta: venta,
      monto_propina: propina,
      medio: pago.medio,
      turno_caja_id: turnoId,
    },
    { motivo: 'Devolución' },
  )
const tarjeta = (turno: string, monto: number, propina = 0) =>
  pagoTarjeta(monto, { turno_caja_id: turno, propina })
const propio = (turno: string, propioId: string, monto: number, propina = 0) =>
  pagoTarjeta(monto, {
    turno_caja_id: turno,
    medio: 'otro',
    medio_propio_id: propioId,
    propina,
    datafono: null,
  } as never)
const nequi = (turno: string, monto: number, propina = 0) =>
  pagoTarjeta(monto, { turno_caja_id: turno, medio: 'nequi', propina, datafono: null })

describe('cuadreDeTurno: lo básico', () => {
  it('solo la apertura: esperado = base, sin cobros, movimientos ni conteos', () => {
    const t = turnoNuevo(150_000)
    const c = cuadreDeTurno([t.apertura], t.id)
    expect(c).toMatchObject({
      turnoId: t.id,
      cajaId: t.caja,
      base: 150_000,
      porMedio: [],
      movimientos: [],
      arqueos: [],
      cerrado: null,
      efectivo: {
        cobrado: 0,
        devoluciones: 0,
        entradas: 0,
        salidas: 0,
        pagosPropinas: 0,
        esperado: 150_000,
      },
    })
  })

  it('base $0 es válida', () => {
    const t = turnoNuevo(0)
    expect(cuadreDeTurno([t.apertura], t.id)?.efectivo.esperado).toBe(0)
  })

  it('un turno que no es el pedido no tiene cuadre, aunque haya otros turnos', () => {
    const t = turnoNuevo(10)
    expect(cuadreDeTurno([t.apertura], nuevoId())).toBeNull()
  })

  it('con el cierre pero sin apertura, sin cuadre', () => {
    const t = turnoNuevo(10)
    const cierre = t.deTurno('TurnoCerrado', {
      arqueo_id: nuevoId(),
      esperado_efectivo: 10,
      contado_efectivo: 10,
      diferencia: 0,
      justificacion: null,
    })
    expect(cuadreDeTurno([cierre], t.id)).toBeNull()
  })

  it('en el efectivo cuenta monto + ajuste + propina, no lo recibido ni el cambio', () => {
    const t = turnoNuevo(0)
    const p = pagoEfectivo(36_810, {
      ajuste_redondeo: -10,
      propina: 3_000,
      cambio: 5_000,
      turno_caja_id: t.id,
    })
    // recibido = 36.810 − 10 + 3.000 + 5.000 = 44.800; el cajón se queda con 39.800.
    expect(p.recibido).toBe(44_800)
    const c = cuadreDeTurno([t.apertura, pagar(p)], t.id)
    expect(c?.efectivo.cobrado).toBe(39_800)
    expect(c?.efectivo.esperado).toBe(39_800)
  })

  it('una propina en tarjeta no entra al cajón pero sí a lo cobrado por medio', () => {
    const t = turnoNuevo(10_000)
    const c = cuadreDeTurno([t.apertura, pagar(tarjeta(t.id, 40_000, 4_000))], t.id)
    expect(c?.efectivo.esperado).toBe(10_000)
    expect(c?.porMedio).toEqual([
      { medio: 'tarjeta', medioPropioId: null, venta: 40_000, propina: 4_000, pagos: 1 },
    ])
  })

  it('un pago de otro turno (de otra caja) no entra', () => {
    const t = turnoNuevo(0)
    const c = cuadreDeTurno(
      [t.apertura, pagar(pagoEfectivo(9_000, { turno_caja_id: nuevoId() }))],
      t.id,
    )
    expect(c?.efectivo.esperado).toBe(0)
    expect(c?.porMedio).toEqual([])
  })

  it('cada movimiento, con su descripción, a quién y la hora del hub', () => {
    const t = turnoNuevo(0)
    const c = cuadreDeTurno(
      [
        t.apertura,
        t.mover(
          'entrada',
          5_000,
          { descripcion: 'Cambio' },
          { recibido_en: '2026-10-26T15:00:00Z' },
        ),
        t.mover('salida', 2_000, { descripcion: 'Hielo' }, { recibido_en: '2026-10-26T16:00:00Z' }),
        t.mover(
          'pago_propinas',
          1_000,
          { descripcion: 'Propinas', a_quien: 'Ana' },
          { recibido_en: null, hora_estimada_hub: '2026-10-26T17:00:00Z' },
        ),
      ],
      t.id,
    )
    expect(c?.movimientos.map((m) => [m.tipo, m.monto, m.descripcion, m.aQuien, m.hora])).toEqual([
      ['entrada', 5_000, 'Cambio', null, '2026-10-26T15:00:00Z'],
      ['salida', 2_000, 'Hielo', null, '2026-10-26T16:00:00Z'],
      ['pago_propinas', 1_000, 'Propinas', 'Ana', '2026-10-26T17:00:00Z'],
    ])
    expect(c?.efectivo).toMatchObject({
      entradas: 5_000,
      salidas: 2_000,
      pagosPropinas: 1_000,
      esperado: 2_000,
    })
  })

  it('los movimientos de otro turno no cuentan', () => {
    const a = turnoNuevo(100)
    const b = turnoNuevo(200)
    const todos = [a.apertura, b.apertura, a.mover('entrada', 50), b.mover('salida', 70)]
    expect(cuadreDeTurno(todos, a.id)?.efectivo.esperado).toBe(150)
    expect(cuadreDeTurno(todos, b.id)?.efectivo.esperado).toBe(130)
    expect(cuadreDeTurno(todos, a.id)?.base).toBe(100)
  })

  it('las salidas y el pago de propinas pueden dejar el esperado en negativo (se muestra tal cual)', () => {
    const t = turnoNuevo(1_000)
    const c = cuadreDeTurno([t.apertura, t.mover('salida', 5_000)], t.id)
    expect(c?.efectivo.esperado).toBe(-4_000)
  })

  it('los pagos del turno se cuentan aunque lleguen antes de la apertura en la lista', () => {
    const t = turnoNuevo(1_000)
    const p = pagoEfectivo(20_000, { turno_caja_id: t.id })
    expect(cuadreDeTurno([pagar(p), t.apertura], t.id)?.efectivo.esperado).toBe(21_000)
  })
})

describe('cuadreDeTurno: anulaciones', () => {
  it('anular en este turno un pago de este turno: el efectivo vuelve a la base', () => {
    const t = turnoNuevo(50_000)
    const p = pagoEfectivo(20_000, { turno_caja_id: t.id, propina: 2_000, ajuste_redondeo: -40 })
    const c = cuadreDeTurno([t.apertura, pagar(p), anular(p, t.id)], t.id)
    expect(c?.efectivo).toMatchObject({ cobrado: 21_960, devoluciones: 21_960, esperado: 50_000 })
    expect(c?.porMedio).toEqual([])
  })

  it('anular en este turno un pago de un turno ANTERIOR resta de este cajón, y el original no se cuenta aquí', () => {
    const viejo = turnoNuevo(0)
    const hoy = turnoNuevo(100_000)
    const p = pagoEfectivo(30_000, {
      turno_caja_id: viejo.id,
      propina: 3_000,
      ajuste_redondeo: -20,
    })
    const eventos = [viejo.apertura, hoy.apertura, pagar(p), anular(p, hoy.id)]
    const c = cuadreDeTurno(eventos, hoy.id)
    expect(c?.efectivo).toMatchObject({ cobrado: 0, devoluciones: 32_980, esperado: 67_020 })
    expect(c?.porMedio).toEqual([
      { medio: 'efectivo', medioPropioId: null, venta: -29_980, propina: -3_000, pagos: -1 },
    ])
    // El turno anterior sigue viendo su cobro completo: la anulación cae en el que la registra.
    const v = cuadreDeTurno(eventos, viejo.id)
    expect(v?.efectivo).toMatchObject({ cobrado: 32_980, devoluciones: 0, esperado: 32_980 })
    expect(v?.porMedio).toEqual([
      { medio: 'efectivo', medioPropioId: null, venta: 29_980, propina: 3_000, pagos: 1 },
    ])
  })

  it('la anulación de un pago en tarjeta no toca el efectivo y deja la tarjeta en cero (no sale)', () => {
    const t = turnoNuevo(10_000)
    const tj = tarjeta(t.id, 40_000, 4_000)
    const ef = pagoEfectivo(5_000, { turno_caja_id: t.id })
    const c = cuadreDeTurno([t.apertura, pagar(tj), pagar(ef), anular(tj, t.id)], t.id)
    expect(c?.efectivo).toMatchObject({ devoluciones: 0, esperado: 15_000 })
    expect(c?.porMedio.map((m) => m.medio)).toEqual(['efectivo'])
  })

  it('anular un pago de tarjeta de un turno anterior da negativos en tarjeta', () => {
    const viejo = turnoNuevo(0)
    const hoy = turnoNuevo(0)
    const tj = tarjeta(viejo.id, 40_000, 4_000)
    const c = cuadreDeTurno([viejo.apertura, hoy.apertura, pagar(tj), anular(tj, hoy.id)], hoy.id)
    expect(c?.porMedio).toEqual([
      { medio: 'tarjeta', medioPropioId: null, venta: -40_000, propina: -4_000, pagos: -1 },
    ])
    expect(c?.efectivo.esperado).toBe(0)
  })

  it('una anulación de un pago que no está entre los eventos se ignora sin lanzar', () => {
    const t = turnoNuevo(5_000)
    const fantasma = pagoEfectivo(1_000, { turno_caja_id: t.id })
    const c = cuadreDeTurno([t.apertura, anular(fantasma, t.id)], t.id)
    expect(c?.efectivo.esperado).toBe(5_000)
    expect(c?.porMedio).toEqual([])
  })

  it('una anulación registrada en otro turno no resta de este', () => {
    const t = turnoNuevo(0)
    const p = pagoEfectivo(8_000, { turno_caja_id: t.id })
    const c = cuadreDeTurno([t.apertura, pagar(p), anular(p, nuevoId())], t.id)
    expect(c?.efectivo).toMatchObject({ cobrado: 8_000, devoluciones: 0, esperado: 8_000 })
  })
})

describe('cuadreDeTurno: reembolsos', () => {
  it('un reembolso en efectivo resta venta y propina del cajón, sin contar como pago', () => {
    const t = turnoNuevo(0)
    const p = pagoEfectivo(50_000, { turno_caja_id: t.id, propina: 5_000 })
    const c = cuadreDeTurno([t.apertura, pagar(p), reembolsar(p, t.id, 10_000, 1_000)], t.id)
    expect(c?.efectivo).toMatchObject({ cobrado: 55_000, devoluciones: 11_000, esperado: 44_000 })
    expect(c?.porMedio).toEqual([
      { medio: 'efectivo', medioPropioId: null, venta: 40_000, propina: 4_000, pagos: 1 },
    ])
  })

  it('un reembolso de una propina sola (venta 0) también resta', () => {
    const t = turnoNuevo(0)
    const p = pagoEfectivo(20_000, { turno_caja_id: t.id, propina: 2_000 })
    const c = cuadreDeTurno([t.apertura, pagar(p), reembolsar(p, t.id, 0, 2_000)], t.id)
    expect(c?.efectivo.esperado).toBe(20_000)
  })

  it('varios reembolsos del mismo pago se suman', () => {
    const t = turnoNuevo(0)
    const p = pagoEfectivo(30_000, { turno_caja_id: t.id })
    const c = cuadreDeTurno(
      [t.apertura, pagar(p), reembolsar(p, t.id, 5_000), reembolsar(p, t.id, 7_000)],
      t.id,
    )
    expect(c?.efectivo).toMatchObject({ devoluciones: 12_000, esperado: 18_000 })
  })

  it('reembolsar en este turno un pago de un turno anterior resta de este cajón', () => {
    const viejo = turnoNuevo(0)
    const hoy = turnoNuevo(80_000)
    const p = pagoEfectivo(25_000, { turno_caja_id: viejo.id })
    const eventos = [viejo.apertura, hoy.apertura, pagar(p), reembolsar(p, hoy.id, 5_000)]
    expect(cuadreDeTurno(eventos, hoy.id)?.efectivo).toMatchObject({
      cobrado: 0,
      devoluciones: 5_000,
      esperado: 75_000,
    })
    expect(cuadreDeTurno(eventos, viejo.id)?.efectivo.esperado).toBe(25_000)
  })

  it('un reembolso de tarjeta no toca el efectivo y resta de lo cobrado en tarjeta', () => {
    const t = turnoNuevo(1_000)
    const tj = tarjeta(t.id, 40_000, 4_000)
    const c = cuadreDeTurno([t.apertura, pagar(tj), reembolsar(tj, t.id, 15_000, 500)], t.id)
    expect(c?.efectivo.esperado).toBe(1_000)
    expect(c?.porMedio).toEqual([
      { medio: 'tarjeta', medioPropioId: null, venta: 25_000, propina: 3_500, pagos: 1 },
    ])
  })

  it('un reembolso registrado en otro turno no resta de este', () => {
    const t = turnoNuevo(0)
    const p = pagoEfectivo(9_000, { turno_caja_id: t.id })
    const c = cuadreDeTurno([t.apertura, pagar(p), reembolsar(p, nuevoId(), 3_000)], t.id)
    expect(c?.efectivo.esperado).toBe(9_000)
  })

  it('anulación y reembolso en el mismo turno de pagos distintos: cada uno resta lo suyo', () => {
    const t = turnoNuevo(0)
    const a = pagoEfectivo(10_000, { turno_caja_id: t.id, propina: 1_000 })
    const b = pagoEfectivo(20_000, { turno_caja_id: t.id })
    const c = cuadreDeTurno(
      [t.apertura, pagar(a), pagar(b), anular(a, t.id), reembolsar(b, t.id, 4_000)],
      t.id,
    )
    expect(c?.efectivo).toMatchObject({ cobrado: 31_000, devoluciones: 15_000, esperado: 16_000 })
  })
})

describe('cuadreDeTurno: medios propios y varios medios', () => {
  const SODEXO = nuevoId()
  const QR = nuevoId()

  it('cada medio propio y cada medio estándar van en su renglón, sin mezclarse con el efectivo', () => {
    const t = turnoNuevo(5_000)
    const c = cuadreDeTurno(
      [
        t.apertura,
        pagar(propio(t.id, SODEXO, 10_000, 500)),
        pagar(propio(t.id, QR, 8_000)),
        pagar(propio(t.id, SODEXO, 2_000)),
        pagar(nequi(t.id, 7_000, 700)),
        pagar(pagoEfectivo(1_000, { turno_caja_id: t.id })),
      ],
      t.id,
    )
    expect(c?.porMedio).toEqual([
      { medio: 'otro', medioPropioId: SODEXO, venta: 12_000, propina: 500, pagos: 2 },
      { medio: 'otro', medioPropioId: QR, venta: 8_000, propina: 0, pagos: 1 },
      { medio: 'nequi', medioPropioId: null, venta: 7_000, propina: 700, pagos: 1 },
      { medio: 'efectivo', medioPropioId: null, venta: 1_000, propina: 0, pagos: 1 },
    ])
    expect(c?.efectivo.esperado).toBe(6_000)
  })

  it('anular un pago de medio propio (aun de otro turno) resta de ese medio propio', () => {
    const viejo = turnoNuevo(0)
    const hoy = turnoNuevo(0)
    const p = propio(viejo.id, SODEXO, 10_000, 1_000)
    const c = cuadreDeTurno([viejo.apertura, hoy.apertura, pagar(p), anular(p, hoy.id)], hoy.id)
    expect(c?.porMedio).toEqual([
      { medio: 'otro', medioPropioId: SODEXO, venta: -10_000, propina: -1_000, pagos: -1 },
    ])
  })

  it('reembolsar un medio propio queda en el mismo renglón que el pago', () => {
    const t = turnoNuevo(0)
    const p = propio(t.id, QR, 10_000)
    const c = cuadreDeTurno([t.apertura, pagar(p), reembolsar(p, t.id, 3_000)], t.id)
    expect(c?.porMedio).toEqual([
      { medio: 'otro', medioPropioId: QR, venta: 7_000, propina: 0, pagos: 1 },
    ])
  })

  it('cobradoDelTurno sin movimientos: [] y no cuenta pagos de otros turnos', () => {
    const t = turnoNuevo(0)
    expect(cobradoDelTurno([], t.id)).toEqual([])
    expect(cobradoDelTurno([pagar(nequi(nuevoId(), 100))], t.id)).toEqual([])
  })

  it('un medio que queda en 0 (pago y anulación) no sale, pero uno con venta y propina sí', () => {
    const t = turnoNuevo(0)
    const solaPropina = nequi(t.id, 100, 300)
    const c = cobradoDelTurno([pagar(solaPropina)], t.id)
    expect(c).toEqual([{ medio: 'nequi', medioPropioId: null, venta: 100, propina: 300, pagos: 1 }])
    const par = nequi(t.id, 100)
    expect(cobradoDelTurno([pagar(par), anular(par, t.id)], t.id)).toEqual([])
  })
})

describe('cuadreDeTurno: conteos y cierre', () => {
  it('varios conteos quedan todos, en orden, sin cambiar el esperado', () => {
    const t = turnoNuevo(50_000)
    const a1 = t.arqueo([{ valor: 20_000, cantidad: 2 }], { recibido_en: '2026-10-26T20:00:00Z' })
    const a2 = t.arqueo(
      [
        { valor: 20_000, cantidad: 2 },
        { valor: 10_000, cantidad: 1 },
      ],
      { recibido_en: '2026-10-26T20:05:00Z' },
    )
    const c = cuadreDeTurno([t.apertura, a1, a2], t.id)
    expect(c?.arqueos.map((a) => [a.id, a.contado, a.hora])).toEqual([
      [a1.datos.arqueo_id, 40_000, '2026-10-26T20:00:00Z'],
      [a2.datos.arqueo_id, 50_000, '2026-10-26T20:05:00Z'],
    ])
    expect(c?.arqueos[1]?.conteo).toEqual([
      { valor: 20_000, cantidad: 2 },
      { valor: 10_000, cantidad: 1 },
    ])
    expect(c?.efectivo.esperado).toBe(50_000)
    expect(c?.cerrado).toBeNull()
  })

  it('los conteos de otro turno no aparecen', () => {
    const a = turnoNuevo(0)
    const b = turnoNuevo(0)
    const c = cuadreDeTurno(
      [a.apertura, b.apertura, b.arqueo([{ valor: 1_000, cantidad: 1 }])],
      a.id,
    )
    expect(c?.arqueos).toEqual([])
  })

  it('el cierre se guarda con esperado, contado, diferencia, justificación y hora', () => {
    const t = turnoNuevo(10_000)
    const arq = t.arqueo([{ valor: 5_000, cantidad: 1 }])
    const cierre = t.deTurno(
      'TurnoCerrado',
      {
        arqueo_id: arq.datos.arqueo_id,
        esperado_efectivo: 10_000,
        contado_efectivo: 5_000,
        diferencia: -5_000,
        justificacion: 'Faltó un vale',
      },
      { recibido_en: '2026-10-26T21:00:00Z' },
    )
    const c = cuadreDeTurno([t.apertura, arq, cierre], t.id)
    expect(c?.cerrado).toEqual({
      esperado: 10_000,
      contado: 5_000,
      diferencia: -5_000,
      justificacion: 'Faltó un vale',
      hora: '2026-10-26T21:00:00Z',
    })
  })

  it('el cierre de otro turno no cierra este', () => {
    const a = turnoNuevo(0)
    const b = turnoNuevo(0)
    const cierreB = b.deTurno('TurnoCerrado', {
      arqueo_id: nuevoId(),
      esperado_efectivo: 0,
      contado_efectivo: 0,
      diferencia: 0,
      justificacion: null,
    })
    expect(cuadreDeTurno([a.apertura, b.apertura, cierreB], a.id)?.cerrado).toBeNull()
    expect(cuadreDeTurno([a.apertura, b.apertura, cierreB], b.id)?.cerrado).not.toBeNull()
  })
})

describe('cuadreDeTurno: propiedades', () => {
  type PagoGen = {
    medio: 'efectivo' | 'tarjeta' | 'nequi'
    monto: number
    ajuste: number
    propina: number
    este: boolean
  }

  type Op =
    | { k: 'anular'; i: number; este: boolean }
    | { k: 'reembolso'; i: number; este: boolean; venta: number; propina: number }
    | { k: 'mov'; tipo: 'entrada' | 'salida' | 'pago_propinas'; monto: number }

  const arbPago: fc.Arbitrary<PagoGen> = fc.record({
    medio: fc.constantFrom('efectivo', 'tarjeta', 'nequi'),
    monto: fc.integer({ min: 100, max: 500_000 }),
    ajuste: fc.integer({ min: -49, max: 50 }),
    propina: fc.integer({ min: 0, max: 50_000 }),
    este: fc.boolean(),
  })
  const arbOp: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ k: fc.constant('anular' as const), i: fc.nat(20), este: fc.boolean() }),
    fc.record({
      k: fc.constant('reembolso' as const),
      i: fc.nat(20),
      este: fc.boolean(),
      venta: fc.integer({ min: 1, max: 10_000 }),
      propina: fc.integer({ min: 0, max: 1_000 }),
    }),
    fc.record({
      k: fc.constant('mov' as const),
      tipo: fc.constantFrom('entrada', 'salida', 'pago_propinas'),
      monto: fc.integer({ min: 1, max: 100_000 }),
    }),
  )

  /** Arma los eventos y, a la vez, el esperado calculado a mano con la fórmula de DINERO.md. */
  function armar(base: number, pagos: PagoGen[], ops: Op[]) {
    const t = turnoNuevo(base)
    const otro = nuevoId()
    const eventos: EventoPedido[] = [t.apertura]
    const datos: Datos<'PagoRegistrado'>[] = []
    let esperado = base
    const porMedio = new Map<string, { venta: number; propina: number; pagos: number }>()
    const sumar = (medio: string, venta: number, propina: number, n: number) => {
      const m = porMedio.get(medio) ?? { venta: 0, propina: 0, pagos: 0 }
      m.venta += venta
      m.propina += propina
      m.pagos += n
      porMedio.set(medio, m)
    }
    for (const p of pagos) {
      const turno = p.este ? t.id : otro
      const d =
        p.medio === 'efectivo'
          ? pagoEfectivo(p.monto, {
              ajuste_redondeo: p.ajuste,
              propina: p.propina,
              turno_caja_id: turno,
            })
          : p.medio === 'tarjeta'
            ? tarjeta(turno, p.monto, p.propina)
            : nequi(turno, p.monto, p.propina)
      datos.push(d)
      eventos.push(pagar(d))
      if (p.este) {
        const venta = p.medio === 'efectivo' ? p.monto + p.ajuste : p.monto
        sumar(p.medio, venta, p.propina, 1)
        if (p.medio === 'efectivo') esperado += p.monto + p.ajuste + p.propina
      }
    }
    for (const op of ops) {
      if (op.k === 'mov') {
        eventos.push(t.mover(op.tipo, op.monto))
        esperado += op.tipo === 'entrada' ? op.monto : -op.monto
        continue
      }
      const d = datos[op.i % datos.length] as Datos<'PagoRegistrado'>
      const p = pagos[op.i % datos.length] as PagoGen
      const turno = op.este ? t.id : otro
      if (op.k === 'anular') {
        eventos.push(anular(d, turno))
        if (!op.este) continue
        const venta = p.medio === 'efectivo' ? p.monto + p.ajuste : p.monto
        sumar(p.medio, -venta, -p.propina, -1)
        if (p.medio === 'efectivo') esperado -= p.monto + p.ajuste + p.propina
      } else {
        eventos.push(reembolsar(d, turno, op.venta, op.propina))
        if (!op.este) continue
        sumar(p.medio, -op.venta, -op.propina, 0)
        if (p.medio === 'efectivo') esperado -= op.venta + op.propina
      }
    }
    return { t, eventos, esperado, porMedio }
  }
  fc.sample(arbPago, 1)[0] as ReturnType<typeof arbPago.generate> extends never
    ? never
    : { medio: string; monto: number; ajuste: number; propina: number; este: boolean }

  const normal = (lista: CobradoPorMedio[]) =>
    lista.map((m) => `${m.medio}|${m.medioPropioId}|${m.venta}|${m.propina}|${m.pagos}`).sort()

  it('el esperado es igual a la fórmula de DINERO.md y cada medio suma lo suyo', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(arbPago, { minLength: 1, maxLength: 6 }),
        fc.array(arbOp, { maxLength: 10 }),
        (base, pagos, ops) => {
          const { t, eventos, esperado, porMedio } = armar(base, pagos, ops)
          const c = cuadreDeTurno(eventos, t.id)
          expect(c?.efectivo.esperado).toBe(esperado)
          const querido = [...porMedio.entries()]
            .filter(([, m]) => m.venta !== 0 || m.propina !== 0 || m.pagos !== 0)
            .map(([medio, m]) => `${medio}|null|${m.venta}|${m.propina}|${m.pagos}`)
            .sort()
          expect(normal(c?.porMedio ?? [])).toEqual(querido)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('el orden de los eventos no cambia los totales', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(arbPago, { minLength: 1, maxLength: 6 }),
        fc.array(arbOp, { maxLength: 10 }),
        fc.infiniteStream(fc.integer()),
        (base, pagos, ops, azar) => {
          const { t, eventos } = armar(base, pagos, ops)
          const claves = azar.take(eventos.length)
          const barajados = [...eventos]
            .map((e, i) => ({ e, k: claves.next().value ?? i }))
            .sort((x, y) => x.k - y.k)
            .map((x) => x.e)
          const a = cuadreDeTurno(eventos, t.id)
          const b = cuadreDeTurno(barajados, t.id)
          expect(b?.efectivo).toEqual(a?.efectivo)
          expect(normal(b?.porMedio ?? [])).toEqual(normal(a?.porMedio ?? []))
          expect(b?.base).toBe(a?.base)
          expect([...(b?.movimientos ?? [])].map((m) => m.id).sort()).toEqual(
            [...(a?.movimientos ?? [])].map((m) => m.id).sort(),
          )
        },
      ),
      { numRuns: 200 },
    )
  })

  it('repetir el cálculo da lo mismo (sin estado escondido) y no cambia la lista de entrada', () => {
    fc.assert(
      fc.property(fc.array(arbPago, { minLength: 1, maxLength: 4 }), (pagos) => {
        const { t, eventos } = armar(1_000, pagos, [])
        const copia = JSON.stringify(eventos)
        expect(cuadreDeTurno(eventos, t.id)).toEqual(cuadreDeTurno(eventos, t.id))
        expect(JSON.stringify(eventos)).toBe(copia)
      }),
      { numRuns: 50 },
    )
  })
})

describe('DENOMINACIONES', () => {
  it('trae el billete y la moneda de $1.000, y ningún valor se repite con el mismo tipo', () => {
    const milres = DENOMINACIONES.filter((d) => d.valor === 1_000)
    expect(milres.map((d) => d.tipo).sort()).toEqual(['billete', 'moneda'])
    const claves = DENOMINACIONES.map((d) => `${d.valor}|${d.tipo}`)
    expect(new Set(claves).size).toBe(claves.length)
  })

  it('de mayor a menor, de $100.000 a $50', () => {
    const valores = DENOMINACIONES.map((d) => d.valor)
    expect(valores).toEqual([...valores].sort((a, b) => b - a))
    expect(valores[0]).toBe(100_000)
    expect(valores.at(-1)).toBe(50)
  })

  it('billete y moneda de $1.000 juntos en el conteo del arqueo suman un solo renglón de valor 1.000', () => {
    const t = turnoNuevo(0)
    // La pantalla junta billete y moneda del mismo valor: 3 billetes + 2 monedas = 5 × 1.000.
    const a = t.arqueo([{ valor: 1_000, cantidad: 5 }])
    expect(cuadreDeTurno([t.apertura, a], t.id)?.arqueos[0]?.contado).toBe(5_000)
  })
})
