import { describe, expect, it } from 'vitest'
import { type EventoPedido, validarEventoNuevo } from '../eventos/pedido'
import { nuevoId } from '../id'
import { evento, pagoEfectivo } from '../pruebas/fabrica'
import { cuadreDeTurno, DENOMINACIONES } from './turno'

// El cuadre del turno (tarea 1.7, docs/DINERO.md#caja), que comparten el hub y la caja.

const turno = nuevoId()
const caja = nuevoId()
const deTurno = <T extends EventoPedido['tipo']>(tipo: T, datos: never) =>
  evento(turno, tipo, datos, { agregado_tipo: 'turno_caja' } as never)
const abrir = (base: number) => deTurno('TurnoAbierto', { caja_id: caja, base } as never)
const pagar = (datos: ReturnType<typeof pagoEfectivo>) => evento(nuevoId(), 'PagoRegistrado', datos)
const mover = (tipo: 'entrada' | 'salida' | 'pago_propinas', monto: number) =>
  deTurno('MovimientoCajaRegistrado', {
    movimiento_id: nuevoId(),
    tipo,
    monto,
    descripcion: 'Prueba',
    a_quien: tipo === 'pago_propinas' ? 'Equipo' : null,
    dias: tipo === 'pago_propinas' ? ['2026-10-26'] : [],
  } as never)

describe('cuadreDeTurno', () => {
  it('el ejemplo de DINERO.md: base 200.000, efectivo 36.810 (−10, propina 3.000), propinas 20.000 → 219.800', () => {
    const c = cuadreDeTurno(
      [
        abrir(200_000),
        pagar(pagoEfectivo(36_810, { ajuste_redondeo: -10, propina: 3_000, turno_caja_id: turno })),
        mover('pago_propinas', 20_000),
      ],
      turno,
    )
    expect(c?.efectivo.esperado).toBe(219_800)
    expect(c?.porMedio).toEqual([
      { medio: 'efectivo', medioPropioId: null, venta: 36_800, propina: 3_000, pagos: 1 },
    ])
  })

  it('entradas suman, salidas restan; la tarjeta no entra al efectivo', () => {
    const tarjeta = pagoEfectivo(50_000, {
      turno_caja_id: turno,
      medio: 'tarjeta',
      recibido: null,
      cambio: null,
      redondeo: null,
      datafono: {
        datafono_id: nuevoId(),
        franquicia: null,
        ultimos4: null,
        aprobacion: null,
        recibo: null,
      },
    })
    const c = cuadreDeTurno(
      [abrir(100_000), mover('entrada', 30_000), mover('salida', 12_000), pagar(tarjeta)],
      turno,
    )
    expect(c?.efectivo).toMatchObject({ entradas: 30_000, salidas: 12_000, esperado: 118_000 })
    expect(c?.porMedio.find((m) => m.medio === 'tarjeta')?.venta).toBe(50_000)
  })

  it('un pago en efectivo anulado en este turno devuelve lo cobrado; uno de otro turno no cuenta', () => {
    const pago = pagoEfectivo(20_000, { propina: 2_000, turno_caja_id: turno })
    const deOtro = pagoEfectivo(5_000, { turno_caja_id: nuevoId() })
    const c = cuadreDeTurno(
      [
        abrir(0),
        pagar(pago),
        pagar(deOtro),
        evento(
          nuevoId(),
          'PagoAnulado',
          { pago_id: pago.pago_id, turno_caja_id: turno },
          {
            motivo: 'Error',
          },
        ),
      ],
      turno,
    )
    expect(c?.efectivo).toMatchObject({ cobrado: 22_000, devoluciones: 22_000, esperado: 0 })
    expect(c?.porMedio).toEqual([])
  })

  it('guarda cada conteo y el cierre', () => {
    const arqueo = nuevoId()
    const c = cuadreDeTurno(
      [
        abrir(50_000),
        deTurno('ArqueoRegistrado', {
          arqueo_id: arqueo,
          conteo: [{ valor: 50_000, cantidad: 1 }],
          contado_efectivo: 50_000,
        } as never),
        deTurno('TurnoCerrado', {
          arqueo_id: arqueo,
          esperado_efectivo: 50_000,
          contado_efectivo: 50_000,
          diferencia: 0,
          justificacion: null,
        } as never),
      ],
      turno,
    )
    expect(c?.arqueos).toHaveLength(1)
    expect(c?.cerrado).toMatchObject({ esperado: 50_000, contado: 50_000, diferencia: 0 })
  })

  it('sin apertura no hay cuadre', () => {
    expect(cuadreDeTurno([], turno)).toBeNull()
  })

  it('las denominaciones de Colombia, de mayor a menor', () => {
    const valores = DENOMINACIONES.map((d) => d.valor)
    expect(valores).toEqual([...valores].sort((a, b) => b - a))
    expect(valores[0]).toBe(100_000)
  })
})

describe('esquemas de caja (tarea 1.7)', () => {
  const sobre = (tipo: string, datos: unknown) => {
    // Como lo crea la caja: sin los campos que agrega el hub.
    const {
      secuencia: _s,
      recibido_en: _r,
      dia_operativo: _d,
      asignaciones: _a,
      afecta: _f,
      autorizado_por_id: _p,
      ...nuevo
    } = abrir(0) as unknown as Record<string, unknown>
    return { ...nuevo, tipo, datos }
  }
  const ok = (e: unknown) => validarEventoNuevo(e).ok

  it('el conteo debe sumar lo contado', () => {
    const conteo = [{ valor: 20_000, cantidad: 3 }]
    expect(
      ok(sobre('ArqueoRegistrado', { arqueo_id: nuevoId(), conteo, contado_efectivo: 60_000 })),
    ).toBe(true)
    expect(
      ok(sobre('ArqueoRegistrado', { arqueo_id: nuevoId(), conteo, contado_efectivo: 50_000 })),
    ).toBe(false)
  })

  it('la diferencia es lo contado menos lo esperado', () => {
    const base = {
      arqueo_id: nuevoId(),
      esperado_efectivo: 100_000,
      contado_efectivo: 98_000,
      justificacion: null,
    }
    expect(ok(sobre('TurnoCerrado', { ...base, diferencia: -2_000 }))).toBe(true)
    expect(ok(sobre('TurnoCerrado', { ...base, diferencia: 2_000 }))).toBe(false)
  })

  it('solo el pago de propinas dice a quién y de qué días', () => {
    const m = { movimiento_id: nuevoId(), monto: 1_000, descripcion: 'x' }
    expect(
      ok(sobre('MovimientoCajaRegistrado', { ...m, tipo: 'salida', a_quien: null, dias: [] })),
    ).toBe(true)
    expect(
      ok(sobre('MovimientoCajaRegistrado', { ...m, tipo: 'salida', a_quien: 'Ana', dias: [] })),
    ).toBe(false)
    expect(
      ok(
        sobre('MovimientoCajaRegistrado', {
          ...m,
          tipo: 'pago_propinas',
          a_quien: null,
          dias: ['2026-10-26'],
        }),
      ),
    ).toBe(false)
    expect(
      ok(
        sobre('MovimientoCajaRegistrado', {
          ...m,
          tipo: 'pago_propinas',
          a_quien: 'Ana',
          dias: ['2026-10-26'],
        }),
      ),
    ).toBe(true)
  })
})
