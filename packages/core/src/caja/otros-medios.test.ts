import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { EventoPedido } from '../eventos/pedido'
import { nuevoId } from '../id'
import { evento, pagoEfectivo, pagoTarjeta } from '../pruebas/fabrica'
import {
  type ArqueoTurno,
  type CuadreTurno,
  claveDeMedio,
  cuadreDeOtrosMedios,
  cuadreDeTurno,
} from './turno'

// El cuadre de los demás medios (tarea 1.8, docs/DINERO.md#caja): por cada medio que no es efectivo,
// lo registrado (venta + propina − anulaciones y reembolsos), lo que dice su cierre y la diferencia
// (reportado − esperado).

type Datos<T extends EventoPedido['tipo']> = Extract<EventoPedido, { tipo: T }>['datos']
type Hub = { recibido_en?: string | null; hora_estimada_hub?: string }

const SODEXO = nuevoId()
const QR = nuevoId()

function turnoNuevo(base = 0) {
  const id = nuevoId()
  const deTurno = <T extends EventoPedido['tipo']>(tipo: T, datos: unknown, hub: Hub = {}) =>
    evento(id, tipo, datos as never, { agregado_tipo: 'turno_caja', ...hub } as never)
  return {
    id,
    deTurno,
    apertura: deTurno('TurnoAbierto', { caja_id: nuevoId(), base }),
    arqueo: (otros?: { medio: string; medio_propio_id: string | null; reportado: number }[]) =>
      deTurno('ArqueoRegistrado', {
        arqueo_id: nuevoId(),
        conteo: [],
        contado_efectivo: 0,
        ...(otros ? { otros } : {}),
      }),
  }
}

const reporte = (medio: string, reportado: number, propio: string | null = null) => ({
  medio,
  medio_propio_id: propio,
  reportado,
})
const pagar = (datos: Datos<'PagoRegistrado'>) => evento(nuevoId(), 'PagoRegistrado', datos)
const tarjeta = (turno: string, monto: number, propina = 0) =>
  pagoTarjeta(monto, { turno_caja_id: turno, propina })
const nequi = (turno: string, monto: number, propina = 0) =>
  pagoTarjeta(monto, { turno_caja_id: turno, medio: 'nequi', propina, datafono: null })
const propio = (turno: string, id: string, monto: number, propina = 0) =>
  pagoTarjeta(monto, {
    turno_caja_id: turno,
    medio: 'otro',
    medio_propio_id: id,
    propina,
    datafono: null,
  } as never)
const anular = (pago: Datos<'PagoRegistrado'>, turno: string) =>
  evento(
    nuevoId(),
    'PagoAnulado',
    { pago_id: pago.pago_id, turno_caja_id: turno },
    { motivo: 'Error de caja' },
  )
const reembolsar = (pago: Datos<'PagoRegistrado'>, turno: string, venta: number, propina = 0) =>
  evento(
    nuevoId(),
    'ReembolsoRegistrado',
    {
      pago_id: pago.pago_id,
      reembolso_id: nuevoId(),
      monto_venta: venta,
      monto_propina: propina,
      medio: pago.medio,
      turno_caja_id: turno,
    },
    { motivo: 'Devolución' },
  )

/** El cuadre del turno con sus pagos y un conteo con lo que reportó cada medio. */
function armar(
  construir: (t: ReturnType<typeof turnoNuevo>) => {
    eventos: unknown[]
    otros?: ReturnType<typeof reporte>[]
  },
) {
  const t = turnoNuevo()
  const { eventos, otros } = construir(t)
  const conteo = t.arqueo(otros)
  const todos = [t.apertura, ...eventos, conteo] as never[]
  const cuadre = cuadreDeTurno(todos, t.id) as CuadreTurno
  const arqueo = cuadre.arqueos[0] as ArqueoTurno
  return { t, cuadre, arqueo, otros: cuadreDeOtrosMedios(cuadre, arqueo) }
}

const buscar = (
  lista: ReturnType<typeof cuadreDeOtrosMedios>,
  medio: string,
  medioPropioId: string | null = null,
) => lista.find((l) => l.medio === medio && l.medioPropioId === medioPropioId)

describe('cuadreDeOtrosMedios: lo registrado contra lo reportado', () => {
  it('sin pagos ni reportes: no hay nada que cuadrar', () => {
    const { otros } = armar(() => ({ eventos: [] }))
    expect(otros).toEqual([])
  })

  it('tarjeta y Nequi que coinciden: diferencia 0 en cada uno, con propina dentro de lo esperado', () => {
    const { otros } = armar((t) => ({
      eventos: [
        pagar(tarjeta(t.id, 100_000, 10_000)),
        pagar(tarjeta(t.id, 50_000)),
        pagar(nequi(t.id, 30_000, 3_000)),
      ],
      otros: [reporte('tarjeta', 160_000), reporte('nequi', 33_000)],
    }))
    expect(buscar(otros, 'tarjeta')).toEqual({
      medio: 'tarjeta',
      medioPropioId: null,
      esperado: 160_000,
      reportado: 160_000,
      diferencia: 0,
    })
    expect(buscar(otros, 'nequi')).toMatchObject({
      esperado: 33_000,
      reportado: 33_000,
      diferencia: 0,
    })
    expect(otros).toHaveLength(2)
  })

  it('el efectivo nunca sale, aunque tenga pagos', () => {
    const { otros } = armar((t) => ({
      eventos: [pagar(pagoEfectivo(30_000, { turno_caja_id: t.id })), pagar(tarjeta(t.id, 1_000))],
      otros: [reporte('tarjeta', 1_000)],
    }))
    expect(otros.map((o) => o.medio)).toEqual(['tarjeta'])
  })

  it('con pagos y sin reporte: se esperaba algo y se reportó 0, la diferencia es negativa', () => {
    const { otros } = armar((t) => ({ eventos: [pagar(tarjeta(t.id, 80_000, 8_000))] }))
    expect(otros).toEqual([
      {
        medio: 'tarjeta',
        medioPropioId: null,
        esperado: 88_000,
        reportado: 0,
        diferencia: -88_000,
      },
    ])
  })

  it('un conteo de la 1.7 (sin `otros`) con pagos digitales: todo sale como no reportado', () => {
    const { otros } = armar((t) => ({
      eventos: [pagar(tarjeta(t.id, 5_000)), pagar(nequi(t.id, 7_000))],
    }))
    expect(otros.map((o) => [o.medio, o.reportado, o.diferencia])).toEqual([
      ['tarjeta', 0, -5_000],
      ['nequi', 0, -7_000],
    ])
  })

  it('reportado sin pagos: un cobro que no se registró en el POS, la diferencia es positiva', () => {
    const { otros } = armar(() => ({ eventos: [], otros: [reporte('nequi', 45_000)] }))
    expect(otros).toEqual([
      { medio: 'nequi', medioPropioId: null, esperado: 0, reportado: 45_000, diferencia: 45_000 },
    ])
  })

  it('un medio con pagos que dice otro valor: faltante y sobrante con su signo', () => {
    const { otros } = armar((t) => ({
      eventos: [pagar(tarjeta(t.id, 100_000)), pagar(nequi(t.id, 20_000))],
      otros: [reporte('tarjeta', 99_000), reporte('nequi', 25_000)],
    }))
    expect(buscar(otros, 'tarjeta')?.diferencia).toBe(-1_000)
    expect(buscar(otros, 'nequi')?.diferencia).toBe(5_000)
  })

  it('los dos en 0 no salen: reportó 0 y no hubo pagos', () => {
    const { otros } = armar(() => ({
      eventos: [],
      otros: [reporte('tarjeta', 0), reporte('nequi', 0), reporte('otro', 0, SODEXO)],
    }))
    expect(otros).toEqual([])
  })

  it('los dos en 0 por pagos que se anularon en el mismo turno: no salen', () => {
    const { otros } = armar((t) => {
      const p = tarjeta(t.id, 40_000, 4_000)
      return {
        eventos: [pagar(p), anular(p, t.id)],
        otros: [reporte('tarjeta', 0)],
      }
    })
    expect(otros).toEqual([])
  })

  it('esperado 0 pero reportó algo: sale (aunque los pagos se hayan anulado)', () => {
    const { otros } = armar((t) => {
      const p = tarjeta(t.id, 40_000)
      return { eventos: [pagar(p), anular(p, t.id)], otros: [reporte('tarjeta', 40_000)] }
    })
    expect(otros).toEqual([
      { medio: 'tarjeta', medioPropioId: null, esperado: 0, reportado: 40_000, diferencia: 40_000 },
    ])
  })

  it('un reporte en 0 de un medio con pagos sale con su faltante (no se confunde con "sin reporte")', () => {
    const { otros } = armar((t) => ({
      eventos: [pagar(nequi(t.id, 9_000))],
      otros: [reporte('nequi', 0)],
    }))
    expect(otros).toEqual([
      { medio: 'nequi', medioPropioId: null, esperado: 9_000, reportado: 0, diferencia: -9_000 },
    ])
  })

  it('un pago de otro turno no cuenta en lo esperado', () => {
    const { otros } = armar((t) => ({
      eventos: [pagar(tarjeta(t.id, 10_000)), pagar(tarjeta(nuevoId(), 99_000))],
      otros: [reporte('tarjeta', 10_000)],
    }))
    expect(otros).toEqual([
      { medio: 'tarjeta', medioPropioId: null, esperado: 10_000, reportado: 10_000, diferencia: 0 },
    ])
  })
})

describe('cuadreDeOtrosMedios: anulaciones y reembolsos', () => {
  it('una anulación en este turno resta venta y propina de lo esperado', () => {
    const { otros } = armar((t) => {
      const a = tarjeta(t.id, 60_000, 6_000)
      const b = tarjeta(t.id, 40_000)
      return {
        eventos: [pagar(a), pagar(b), anular(a, t.id)],
        otros: [reporte('tarjeta', 40_000)],
      }
    })
    expect(buscar(otros, 'tarjeta')).toMatchObject({ esperado: 40_000, diferencia: 0 })
  })

  it('un reembolso resta venta y propina, cada uno por separado', () => {
    const { otros } = armar((t) => {
      const a = tarjeta(t.id, 100_000, 10_000)
      return {
        eventos: [pagar(a), reembolsar(a, t.id, 30_000, 3_000)],
        otros: [reporte('tarjeta', 77_000)],
      }
    })
    expect(buscar(otros, 'tarjeta')).toMatchObject({ esperado: 77_000, diferencia: 0 })
  })

  it('un reembolso de solo la propina deja la venta entera', () => {
    const { otros } = armar((t) => {
      const a = nequi(t.id, 20_000, 2_000)
      return {
        eventos: [pagar(a), reembolsar(a, t.id, 0, 2_000)],
        otros: [reporte('nequi', 20_000)],
      }
    })
    expect(buscar(otros, 'nequi')).toMatchObject({ esperado: 20_000, diferencia: 0 })
  })

  it('anular en este turno un pago de un turno ANTERIOR: lo esperado queda negativo y, si no reportó nada, sobra', () => {
    const anterior = nuevoId()
    const { otros } = armar((t) => {
      const viejo = tarjeta(anterior, 25_000, 2_500)
      return { eventos: [pagar(viejo), anular(viejo, t.id)] }
    })
    expect(otros).toEqual([
      {
        medio: 'tarjeta',
        medioPropioId: null,
        esperado: -27_500,
        reportado: 0,
        diferencia: 27_500,
      },
    ])
  })

  it('un reembolso de un pago anterior, en este turno, resta de lo esperado de este', () => {
    const anterior = nuevoId()
    const { otros } = armar((t) => {
      const viejo = nequi(anterior, 25_000)
      return {
        eventos: [pagar(viejo), reembolsar(viejo, t.id, 5_000)],
        otros: [reporte('nequi', 0)],
      }
    })
    expect(buscar(otros, 'nequi')).toMatchObject({
      esperado: -5_000,
      reportado: 0,
      diferencia: 5_000,
    })
  })

  it('anulaciones y reembolsos de otro turno no restan aquí', () => {
    const otroTurno = nuevoId()
    const { otros } = armar((t) => {
      const a = tarjeta(t.id, 50_000)
      return {
        eventos: [pagar(a), anular(a, otroTurno), reembolsar(a, otroTurno, 10_000)],
        otros: [reporte('tarjeta', 50_000)],
      }
    })
    expect(buscar(otros, 'tarjeta')).toMatchObject({ esperado: 50_000, diferencia: 0 })
  })

  it('una anulación de un pago en efectivo no toca los demás medios', () => {
    const { otros } = armar((t) => {
      const ef = pagoEfectivo(10_000, { turno_caja_id: t.id })
      return {
        eventos: [pagar(ef), pagar(tarjeta(t.id, 5_000)), anular(ef, t.id)],
        otros: [reporte('tarjeta', 5_000)],
      }
    })
    expect(otros).toHaveLength(1)
    expect(otros[0]).toMatchObject({ medio: 'tarjeta', esperado: 5_000, diferencia: 0 })
  })
})

describe('cuadreDeOtrosMedios: un día de solo devoluciones', () => {
  it('lo esperado negativo y lo reportado negativo igual: cuadra', () => {
    const anterior = nuevoId()
    const { otros } = armar((t) => {
      const viejo = tarjeta(anterior, 25_000, 2_500)
      return { eventos: [pagar(viejo), anular(viejo, t.id)], otros: [reporte('tarjeta', -27_500)] }
    })
    expect(otros).toEqual([
      {
        medio: 'tarjeta',
        medioPropioId: null,
        esperado: -27_500,
        reportado: -27_500,
        diferencia: 0,
      },
    ])
  })

  it('reportado negativo sin pagos: sale con su diferencia negativa', () => {
    const { otros } = armar(() => ({ eventos: [], otros: [reporte('nequi', -4_000)] }))
    expect(otros).toEqual([
      { medio: 'nequi', medioPropioId: null, esperado: 0, reportado: -4_000, diferencia: -4_000 },
    ])
  })

  it('esperado y reportado de signo contrario que se anulan entre sí no son una línea en 0: sale', () => {
    const { otros } = armar((t) => ({
      eventos: [pagar(tarjeta(t.id, 5_000))],
      otros: [reporte('tarjeta', -5_000)],
    }))
    expect(otros).toEqual([
      {
        medio: 'tarjeta',
        medioPropioId: null,
        esperado: 5_000,
        reportado: -5_000,
        diferencia: -10_000,
      },
    ])
  })
})

describe('claveDeMedio', () => {
  it('distingue los medios y cada medio propio; el estándar no lleva id', () => {
    expect(claveDeMedio({ medio: 'tarjeta', medioPropioId: null })).toBe('tarjeta:')
    expect(claveDeMedio({ medio: 'otro', medioPropioId: SODEXO })).toBe(`otro:${SODEXO}`)
    expect(claveDeMedio({ medio: 'otro', medioPropioId: SODEXO })).not.toBe(
      claveDeMedio({ medio: 'otro', medioPropioId: QR }),
    )
    expect(claveDeMedio({ medio: 'nequi', medioPropioId: null })).not.toBe(
      claveDeMedio({ medio: 'daviplata', medioPropioId: null }),
    )
  })
})

describe('cuadreDeOtrosMedios: medios propios', () => {
  it('cada medio propio va en su línea, aparte de «otro» sin id y de los estándar', () => {
    const { otros } = armar((t) => ({
      eventos: [
        pagar(propio(t.id, SODEXO, 30_000)),
        pagar(propio(t.id, QR, 12_000, 1_000)),
        pagar(tarjeta(t.id, 5_000)),
      ],
      otros: [
        reporte('otro', 30_000, SODEXO),
        reporte('otro', 13_000, QR),
        reporte('tarjeta', 4_000),
      ],
    }))
    expect(otros).toHaveLength(3)
    expect(buscar(otros, 'otro', SODEXO)).toMatchObject({ esperado: 30_000, diferencia: 0 })
    expect(buscar(otros, 'otro', QR)).toMatchObject({ esperado: 13_000, diferencia: 0 })
    expect(buscar(otros, 'tarjeta')).toMatchObject({ esperado: 5_000, diferencia: -1_000 })
  })

  it('un medio propio con pagos y sin reporte, y otro reportado sin pagos', () => {
    const { otros } = armar((t) => ({
      eventos: [pagar(propio(t.id, SODEXO, 30_000))],
      otros: [reporte('otro', 8_000, QR)],
    }))
    expect(buscar(otros, 'otro', SODEXO)).toMatchObject({
      esperado: 30_000,
      reportado: 0,
      diferencia: -30_000,
    })
    expect(buscar(otros, 'otro', QR)).toMatchObject({
      esperado: 0,
      reportado: 8_000,
      diferencia: 8_000,
    })
  })

  it('anular un pago de un medio propio resta de ese medio, no de los demás', () => {
    const { otros } = armar((t) => {
      const a = propio(t.id, SODEXO, 30_000)
      return {
        eventos: [pagar(a), pagar(propio(t.id, QR, 10_000)), anular(a, t.id)],
        otros: [reporte('otro', 10_000, QR)],
      }
    })
    expect(otros).toHaveLength(1)
    expect(buscar(otros, 'otro', QR)).toMatchObject({ esperado: 10_000, diferencia: 0 })
  })

  it('reembolsar un medio propio lo resta de su línea', () => {
    const { otros } = armar((t) => {
      const a = propio(t.id, SODEXO, 30_000, 2_000)
      return {
        eventos: [pagar(a), reembolsar(a, t.id, 5_000, 500)],
        otros: [reporte('otro', 26_500, SODEXO)],
      }
    })
    expect(buscar(otros, 'otro', SODEXO)).toMatchObject({ esperado: 26_500, diferencia: 0 })
  })

  it('un medio propio archivado (que ya no está en las reglas) con pagos igual sale', () => {
    // El cálculo no consulta reglas: solo ve los pagos del turno.
    const { otros } = armar((t) => ({ eventos: [pagar(propio(t.id, nuevoId(), 7_000))] }))
    expect(otros).toHaveLength(1)
    expect(otros[0]?.diferencia).toBe(-7_000)
  })
})

describe('cuadreDeOtrosMedios: el orden y la pureza', () => {
  it('primero los medios con pagos (en el orden en que se cobraron) y después los solo reportados', () => {
    const { otros } = armar((t) => ({
      eventos: [pagar(nequi(t.id, 1_000)), pagar(tarjeta(t.id, 2_000))],
      otros: [reporte('daviplata', 3_000), reporte('tarjeta', 2_000)],
    }))
    expect(otros.map((o) => o.medio)).toEqual(['nequi', 'tarjeta', 'daviplata'])
  })

  it('no cambia el cuadre ni el conteo que recibe', () => {
    const { cuadre, arqueo } = armar((t) => ({
      eventos: [pagar(tarjeta(t.id, 2_000))],
      otros: [reporte('tarjeta', 1_000)],
    }))
    const antes = JSON.stringify([cuadre, arqueo])
    cuadreDeOtrosMedios(cuadre, arqueo)
    expect(JSON.stringify([cuadre, arqueo])).toBe(antes)
  })

  it('repetirlo da lo mismo', () => {
    const { cuadre, arqueo, otros } = armar((t) => ({
      eventos: [pagar(tarjeta(t.id, 2_000)), pagar(nequi(t.id, 500))],
      otros: [reporte('tarjeta', 1_000)],
    }))
    expect(cuadreDeOtrosMedios(cuadre, arqueo)).toEqual(otros)
  })

  it('con un arqueo cuyo `otros` repite un medio (no debería pasar por el esquema): el último reporte manda', () => {
    const t = turnoNuevo()
    const { cuadre } = armar(() => ({ eventos: [] }))
    const arqueo: ArqueoTurno = {
      id: nuevoId(),
      conteo: [],
      contado: 0,
      otros: [
        { medio: 'tarjeta', medioPropioId: null, reportado: 1_000 },
        { medio: 'tarjeta', medioPropioId: null, reportado: 2_000 },
      ],
      hora: '',
    }
    expect(t.id).toBeTruthy()
    expect(cuadreDeOtrosMedios(cuadre, arqueo)).toEqual([
      { medio: 'tarjeta', medioPropioId: null, esperado: 0, reportado: 2_000, diferencia: 2_000 },
    ])
  })
})

describe('cuadreDeOtrosMedios: propiedades', () => {
  type PagoGen = {
    medio: 'tarjeta' | 'nequi' | 'daviplata' | 'propio' | 'efectivo'
    monto: number
    propina: number
    accion: 'nada' | 'anular' | 'reembolsar' | 'anular_de_antes'
    venta: number
  }
  const pagoGen = fc.record<PagoGen>({
    medio: fc.constantFrom('tarjeta', 'nequi', 'daviplata', 'propio', 'efectivo'),
    monto: fc.integer({ min: 1, max: 500_000 }),
    propina: fc.integer({ min: 0, max: 50_000 }),
    accion: fc.constantFrom('nada', 'anular', 'reembolsar', 'anular_de_antes'),
    venta: fc.integer({ min: 1, max: 500_000 }),
  })
  const reportesGen = fc.record({
    tarjeta: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
    nequi: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
    daviplata: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
    propio: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
    qr: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
  })

  function escenario(pagos: PagoGen[], rep: Record<string, number | undefined>) {
    const t = turnoNuevo()
    const anterior = nuevoId()
    const eventos: unknown[] = []
    for (const p of pagos) {
      const base =
        p.medio === 'efectivo'
          ? pagoEfectivo(p.monto, { turno_caja_id: t.id, propina: p.propina })
          : p.medio === 'propio'
            ? propio(t.id, SODEXO, p.monto, p.propina)
            : p.medio === 'nequi'
              ? nequi(t.id, p.monto, p.propina)
              : p.medio === 'daviplata'
                ? { ...nequi(t.id, p.monto, p.propina), medio: 'daviplata' as const }
                : tarjeta(t.id, p.monto, p.propina)
      if (p.accion === 'anular_de_antes') {
        const viejo = { ...base, turno_caja_id: anterior }
        eventos.push(pagar(viejo), anular(viejo, t.id))
        continue
      }
      eventos.push(pagar(base))
      if (p.accion === 'anular') eventos.push(anular(base, t.id))
      if (p.accion === 'reembolsar')
        eventos.push(reembolsar(base, t.id, Math.min(p.venta, p.monto), 0))
    }
    const otros = [
      rep.tarjeta !== undefined && reporte('tarjeta', rep.tarjeta),
      rep.nequi !== undefined && reporte('nequi', rep.nequi),
      rep.daviplata !== undefined && reporte('daviplata', rep.daviplata),
      rep.propio !== undefined && reporte('otro', rep.propio, SODEXO),
      rep.qr !== undefined && reporte('otro', rep.qr, QR),
    ].filter(Boolean) as ReturnType<typeof reporte>[]
    const arqueo = t.arqueo(otros)
    const cuadre = cuadreDeTurno([t.apertura, ...eventos, arqueo] as never[], t.id) as CuadreTurno
    return { cuadre, arqueo: cuadre.arqueos[0] as ArqueoTurno, otros }
  }

  it('la suma de las diferencias es igual a lo reportado menos lo esperado (de las líneas que salen)', () => {
    fc.assert(
      fc.property(fc.array(pagoGen, { maxLength: 12 }), reportesGen, (pagos, rep) => {
        const { cuadre, arqueo } = escenario(pagos, rep)
        const lineas = cuadreDeOtrosMedios(cuadre, arqueo)
        const dif = lineas.reduce((s, l) => s + l.diferencia, 0)
        const reportado = lineas.reduce((s, l) => s + l.reportado, 0)
        const esperado = lineas.reduce((s, l) => s + l.esperado, 0)
        expect(dif).toBe(reportado - esperado)
        // Y cada línea es reportado − esperado.
        for (const l of lineas) expect(l.diferencia).toBe(l.reportado - l.esperado)
      }),
    )
  })

  it('lo reportado de todas las líneas es lo que se reportó, y lo esperado es lo registrado en los demás medios', () => {
    fc.assert(
      fc.property(fc.array(pagoGen, { maxLength: 12 }), reportesGen, (pagos, rep) => {
        const { cuadre, arqueo } = escenario(pagos, rep)
        const lineas = cuadreDeOtrosMedios(cuadre, arqueo)
        const reportado = arqueo.otros.reduce((s, o) => s + o.reportado, 0)
        const esperado = cuadre.porMedio
          .filter((m) => m.medio !== 'efectivo')
          .reduce((s, m) => s + m.venta + m.propina, 0)
        expect(lineas.reduce((s, l) => s + l.reportado, 0)).toBe(reportado)
        expect(lineas.reduce((s, l) => s + l.esperado, 0)).toBe(esperado)
      }),
    )
  })

  it('ninguna línea trae esperado 0 con reportado 0; el efectivo nunca aparece; sin claves repetidas', () => {
    fc.assert(
      fc.property(fc.array(pagoGen, { maxLength: 12 }), reportesGen, (pagos, rep) => {
        const { cuadre, arqueo } = escenario(pagos, rep)
        const lineas = cuadreDeOtrosMedios(cuadre, arqueo)
        expect(lineas.every((l) => l.esperado !== 0 || l.reportado !== 0)).toBe(true)
        expect(lineas.every((l) => (l.medio as string) !== 'efectivo')).toBe(true)
        const claves = lineas.map((l) => `${l.medio}:${l.medioPropioId ?? ''}`)
        expect(new Set(claves).size).toBe(claves.length)
      }),
    )
  })

  it('reportar justo lo esperado deja todas las diferencias en 0', () => {
    fc.assert(
      fc.property(fc.array(pagoGen, { maxLength: 12 }), (pagos) => {
        const { cuadre } = escenario(pagos, {})
        const exacto: ArqueoTurno = {
          id: nuevoId(),
          conteo: [],
          contado: 0,
          otros: cuadre.porMedio.flatMap((m) =>
            m.medio === 'efectivo'
              ? []
              : [
                  {
                    medio: m.medio,
                    medioPropioId: m.medioPropioId,
                    reportado: m.venta + m.propina,
                  },
                ],
          ),
          hora: '',
        }
        const lineas = cuadreDeOtrosMedios(cuadre, exacto)
        for (const l of lineas) expect(l.diferencia).toBe(0)
      }),
    )
  })

  it('el orden de los pagos no cambia las diferencias', () => {
    fc.assert(
      fc.property(
        fc.array(
          pagoGen.filter((p) => p.accion === 'nada'),
          { maxLength: 10 },
        ),
        reportesGen,
        (pagos, rep) => {
          const a = escenario(pagos, rep)
          const b = escenario([...pagos].reverse(), rep)
          const norm = (x: ReturnType<typeof escenario>) =>
            cuadreDeOtrosMedios(x.cuadre, x.arqueo)
              .map((l) => `${l.medio}:${l.medioPropioId ?? ''}:${l.esperado}:${l.reportado}`)
              .sort()
          expect(norm(a)).toEqual(norm(b))
        },
      ),
    )
  })
})

describe('cuadreDeTurno: `otros` del arqueo y `otrosMedios` del cierre', () => {
  it('un arqueo sin `otros` (de la 1.7) queda con `otros: []`', () => {
    const t = turnoNuevo()
    const c = cuadreDeTurno([t.apertura, t.arqueo()] as never[], t.id)
    expect(c?.arqueos[0]?.otros).toEqual([])
  })

  it('el arqueo guarda lo que dijo cada medio, con su medio propio, en orden', () => {
    const t = turnoNuevo()
    const c = cuadreDeTurno(
      [
        t.apertura,
        t.arqueo([
          reporte('tarjeta', 250_000),
          reporte('nequi', 0),
          reporte('otro', 30_000, SODEXO),
        ]),
      ] as never[],
      t.id,
    )
    expect(c?.arqueos[0]?.otros).toEqual([
      { medio: 'tarjeta', medioPropioId: null, reportado: 250_000 },
      { medio: 'nequi', medioPropioId: null, reportado: 0 },
      { medio: 'otro', medioPropioId: SODEXO, reportado: 30_000 },
    ])
  })

  it('varios conteos: cada uno con sus propios reportes', () => {
    const t = turnoNuevo()
    const c = cuadreDeTurno(
      [
        t.apertura,
        t.arqueo([reporte('tarjeta', 1_000)]),
        t.arqueo([reporte('tarjeta', 2_000), reporte('nequi', 3_000)]),
      ] as never[],
      t.id,
    )
    expect(c?.arqueos.map((a) => a.otros.map((o) => o.reportado))).toEqual([
      [1_000],
      [2_000, 3_000],
    ])
  })

  it('el conteo de otro turno no trae sus reportes aquí', () => {
    const a = turnoNuevo()
    const b = turnoNuevo()
    const c = cuadreDeTurno(
      [a.apertura, b.apertura, b.arqueo([reporte('tarjeta', 9_000)])] as never[],
      a.id,
    )
    expect(c?.arqueos).toEqual([])
  })

  it('el cierre guarda los demás medios con su esperado, reportado y diferencia con signo', () => {
    const t = turnoNuevo(10_000)
    const arq = t.arqueo()
    const cierre = t.deTurno(
      'TurnoCerrado',
      {
        arqueo_id: arq.datos.arqueo_id,
        esperado_efectivo: 10_000,
        contado_efectivo: 0,
        diferencia: -10_000,
        justificacion: 'Se pagó un domicilio',
        otros_medios: [
          {
            medio: 'tarjeta',
            medio_propio_id: null,
            esperado: 100_000,
            reportado: 98_000,
            diferencia: -2_000,
          },
          {
            medio: 'otro',
            medio_propio_id: SODEXO,
            esperado: 0,
            reportado: 5_000,
            diferencia: 5_000,
          },
        ],
      },
      { recibido_en: '2026-10-26T21:00:00Z' },
    )
    const c = cuadreDeTurno([t.apertura, arq, cierre] as never[], t.id)
    expect(c?.cerrado?.otrosMedios).toEqual([
      {
        medio: 'tarjeta',
        medioPropioId: null,
        esperado: 100_000,
        reportado: 98_000,
        diferencia: -2_000,
      },
      { medio: 'otro', medioPropioId: SODEXO, esperado: 0, reportado: 5_000, diferencia: 5_000 },
    ])
    expect(c?.cerrado?.hora).toBe('2026-10-26T21:00:00Z')
  })

  it('un cierre de la 1.7, sin `otros_medios`, queda con `otrosMedios: []`', () => {
    const t = turnoNuevo(0)
    const arq = t.arqueo()
    const cierre = t.deTurno('TurnoCerrado', {
      arqueo_id: arq.datos.arqueo_id,
      esperado_efectivo: 0,
      contado_efectivo: 0,
      diferencia: 0,
      justificacion: null,
    })
    expect(cuadreDeTurno([t.apertura, arq, cierre] as never[], t.id)?.cerrado?.otrosMedios).toEqual(
      [],
    )
  })

  it('el cierre de otro turno no deja sus medios en este', () => {
    const a = turnoNuevo()
    const b = turnoNuevo()
    const cierreB = b.deTurno('TurnoCerrado', {
      arqueo_id: nuevoId(),
      esperado_efectivo: 0,
      contado_efectivo: 0,
      diferencia: 0,
      justificacion: null,
      otros_medios: [
        { medio: 'tarjeta', medio_propio_id: null, esperado: 1, reportado: 1, diferencia: 0 },
      ],
    })
    expect(cuadreDeTurno([a.apertura, b.apertura, cierreB] as never[], a.id)?.cerrado).toBeNull()
  })

  it('los reportes del arqueo no cambian el esperado en efectivo ni lo cobrado por medio', () => {
    const t = turnoNuevo(50_000)
    const sin = cuadreDeTurno(
      [t.apertura, pagar(tarjeta(t.id, 1_000)), t.arqueo()] as never[],
      t.id,
    )
    const con = cuadreDeTurno(
      [t.apertura, pagar(tarjeta(t.id, 1_000)), t.arqueo([reporte('tarjeta', 9_999)])] as never[],
      t.id,
    )
    expect(con?.efectivo).toEqual(sin?.efectivo)
    expect(con?.porMedio).toEqual(sin?.porMedio)
  })
})
