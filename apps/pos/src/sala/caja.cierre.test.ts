import { nuevoId } from '@pos/core'
import type { EstadoLocal, EventoLocal } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { cuadreDeCaja, resumenTurno, turnoDeCaja } from './cuentas'
import { HORA, local } from './pruebas'

// Lo que la caja ve del turno (tarea 1.7): cuál está abierto aunque haya cerrados, el cuadre con lo
// guardado aquí (confirmado y pendiente, nunca lo rechazado) y el resumen por medio.

const CAJA = nuevoId()
const hora = (h: number) => `2026-10-26T${String(h).padStart(2, '0')}:00:00.000Z`

const deTurno = <T extends Parameters<typeof local>[0]>(
  tipo: T,
  turno: string,
  datos: unknown,
  estado: EstadoLocal = 'confirmado',
  extras: object = {},
) => local(tipo, turno, datos as never, estado, { agregado_tipo: 'turno_caja', ...extras } as never)

const abrir = (base: number, caja = CAJA, estado: EstadoLocal = 'confirmado', h = 8) => {
  const turno = nuevoId()
  const e = deTurno('TurnoAbierto', turno, { caja_id: caja, base }, estado, {
    hora_estimada_hub: hora(h),
    ...(estado === 'confirmado' ? { recibido_en: hora(h) } : {}),
  })
  return { turno, e }
}
const mover = (
  turno: string,
  tipo: 'entrada' | 'salida' | 'pago_propinas',
  monto: number,
  estado: EstadoLocal = 'confirmado',
) =>
  deTurno(
    'MovimientoCajaRegistrado',
    turno,
    {
      movimiento_id: nuevoId(),
      tipo,
      monto,
      descripcion: `Mov ${tipo}`,
      a_quien: tipo === 'pago_propinas' ? 'Equipo' : null,
      dias: tipo === 'pago_propinas' ? ['2026-10-26'] : [],
    },
    estado,
  )
const contar = (turno: string, contado: number, estado: EstadoLocal = 'confirmado') => {
  const arqueo = nuevoId()
  return {
    arqueo,
    e: deTurno(
      'ArqueoRegistrado',
      turno,
      {
        arqueo_id: arqueo,
        conteo: [{ valor: 1, cantidad: contado }],
        contado_efectivo: contado,
      },
      estado,
    ),
  }
}
const cerrar = (
  turno: string,
  arqueo: string,
  esperado: number,
  contado: number,
  estado: EstadoLocal = 'confirmado',
  justificacion: string | null = null,
) =>
  deTurno(
    'TurnoCerrado',
    turno,
    {
      arqueo_id: arqueo,
      esperado_efectivo: esperado,
      contado_efectivo: contado,
      diferencia: contado - esperado,
      justificacion,
    },
    estado,
  )
const pago = (
  turno: string,
  campos: Record<string, unknown>,
  estado: EstadoLocal = 'confirmado',
  pedido = nuevoId(),
) => {
  const datos = {
    pago_id: nuevoId(),
    cuenta_id: null,
    turno_caja_id: turno,
    medio: 'efectivo',
    monto: 10_000,
    propina: 0,
    recibido: 10_000,
    cambio: 0,
    ajuste_redondeo: 0,
    redondeo: null,
    datafono: null,
    referencia_cobro: null,
    ...campos,
  }
  return { datos, e: local('PagoRegistrado', pedido, datos as never, estado) }
}

describe('turnoDeCaja: los turnos cerrados', () => {
  it('un turno con su TurnoCerrado confirmado ya no está abierto', () => {
    const t = abrir(100_000)
    const a = contar(t.turno, 100_000)
    expect(turnoDeCaja([t.e, a.e, cerrar(t.turno, a.arqueo, 100_000, 100_000)], CAJA)).toBeNull()
  })

  it('el cierre pendiente (aún sin confirmar) no lo cierra: sigue abierto hasta que el hub acepte', () => {
    const t = abrir(100_000)
    const a = contar(t.turno, 100_000)
    const r = turnoDeCaja(
      [t.e, a.e, cerrar(t.turno, a.arqueo, 100_000, 100_000, 'pendiente')],
      CAJA,
    )
    expect(r).toMatchObject({ id: t.turno, base: 100_000, porConfirmar: false })
  })

  it('el cierre rechazado deja el turno abierto', () => {
    const t = abrir(100_000)
    const a = contar(t.turno, 100_000)
    const rechazado = cerrar(t.turno, a.arqueo, 1, 100_000, 'rechazado')
    expect(turnoDeCaja([t.e, a.e, rechazado], CAJA)?.id).toBe(t.turno)
  })

  it('un cierre rechazado y luego uno confirmado: cerrado', () => {
    const t = abrir(100_000)
    const a = contar(t.turno, 100_000)
    expect(
      turnoDeCaja(
        [
          t.e,
          a.e,
          cerrar(t.turno, a.arqueo, 1, 100_000, 'rechazado'),
          cerrar(t.turno, a.arqueo, 100_000, 100_000),
        ],
        CAJA,
      ),
    ).toBeNull()
  })

  it('cerrado el primero y abierto el segundo: el segundo es el turno de la caja', () => {
    const viejo = abrir(100_000, CAJA, 'confirmado', 8)
    const nuevo = abrir(50_000, CAJA, 'confirmado', 20)
    const a = contar(viejo.turno, 100_000)
    const eventos = [viejo.e, a.e, cerrar(viejo.turno, a.arqueo, 100_000, 100_000), nuevo.e]
    expect(turnoDeCaja(eventos, CAJA)).toMatchObject({ id: nuevo.turno, base: 50_000 })
    // También si el orden de la lista es otro.
    expect(turnoDeCaja([...eventos].reverse(), CAJA)?.id).toBe(nuevo.turno)
  })

  it('un nuevo turno todavía pendiente, con el anterior cerrado, ya es el turno (por confirmar)', () => {
    const viejo = abrir(100_000, CAJA, 'confirmado', 8)
    const nuevo = abrir(50_000, CAJA, 'pendiente', 20)
    const a = contar(viejo.turno, 100_000)
    const r = turnoDeCaja(
      [viejo.e, a.e, cerrar(viejo.turno, a.arqueo, 100_000, 100_000), nuevo.e],
      CAJA,
    )
    expect(r).toMatchObject({ id: nuevo.turno, porConfirmar: true })
  })

  it('el cierre del turno de otra caja no cierra el mío, y el cierre de un turno no cierra al otro', () => {
    const mio = abrir(1_000)
    const ajeno = abrir(2_000, nuevoId())
    const a = contar(ajeno.turno, 2_000)
    const eventos = [mio.e, ajeno.e, a.e, cerrar(ajeno.turno, a.arqueo, 2_000, 2_000)]
    expect(turnoDeCaja(eventos, CAJA)?.id).toBe(mio.turno)
  })

  it('un cierre sin su apertura no inventa turno', () => {
    expect(turnoDeCaja([cerrar(nuevoId(), nuevoId(), 0, 0)], CAJA)).toBeNull()
  })

  it('movimientos y conteos no son turnos', () => {
    const t = abrir(100)
    expect(turnoDeCaja([mover(t.turno, 'entrada', 5), contar(t.turno, 5).e], CAJA)).toBeNull()
  })

  it('un turno cerrado por un cierre confirmado de OTRO turno con id distinto no se confunde', () => {
    const a = abrir(1_000, CAJA, 'confirmado', 8)
    const b = abrir(2_000, CAJA, 'confirmado', 9)
    const c = contar(a.turno, 1_000)
    // El primero se cerró; el segundo (por error de datos, también de esta caja) sigue.
    const r = turnoDeCaja([a.e, b.e, c.e, cerrar(a.turno, c.arqueo, 1_000, 1_000)], CAJA)
    expect(r?.id).toBe(b.turno)
  })
})

describe('cuadreDeCaja', () => {
  it('el ejemplo de DINERO.md con lo guardado aquí: 219.800', () => {
    const t = abrir(200_000)
    const p = pago(t.turno, {
      monto: 36_810,
      ajuste_redondeo: -10,
      propina: 3_000,
      recibido: 39_800,
      redondeo: { multiplo: 100, modo: 'cercano_mitad_abajo' },
    })
    const c = cuadreDeCaja([t.e, p.e, mover(t.turno, 'pago_propinas', 20_000)], t.turno)
    expect(c?.efectivo.esperado).toBe(219_800)
    expect(c?.porMedio).toEqual([
      { medio: 'efectivo', medioPropioId: null, venta: 36_800, propina: 3_000, pagos: 1 },
    ])
  })

  it('un movimiento o un pago pendiente cuenta (ya está guardado aquí)', () => {
    const t = abrir(10_000)
    const c = cuadreDeCaja(
      [
        t.e,
        mover(t.turno, 'entrada', 5_000, 'pendiente'),
        pago(t.turno, { monto: 1_000, recibido: 1_000 }, 'pendiente').e,
      ],
      t.turno,
    )
    expect(c?.efectivo.esperado).toBe(16_000)
    expect(c?.movimientos).toHaveLength(1)
  })

  it('lo rechazado por el hub no cuenta: ni el movimiento, ni el pago, ni el conteo, ni el cierre', () => {
    const t = abrir(10_000)
    const a = contar(t.turno, 10_000, 'rechazado')
    const c = cuadreDeCaja(
      [
        t.e,
        mover(t.turno, 'salida', 5_000, 'rechazado'),
        pago(t.turno, { monto: 1_000, recibido: 1_000 }, 'rechazado').e,
        a.e,
        cerrar(t.turno, a.arqueo, 10_000, 10_000, 'rechazado'),
      ],
      t.turno,
    )
    expect(c).toMatchObject({
      efectivo: { esperado: 10_000, salidas: 0, cobrado: 0 },
      movimientos: [],
      arqueos: [],
      porMedio: [],
      cerrado: null,
    })
  })

  it('una apertura rechazada: sin cuadre', () => {
    const t = abrir(10_000, CAJA, 'rechazado')
    expect(cuadreDeCaja([t.e], t.turno)).toBeNull()
  })

  it('una apertura pendiente sí da cuadre', () => {
    const t = abrir(10_000, CAJA, 'pendiente')
    expect(cuadreDeCaja([t.e], t.turno)?.efectivo.esperado).toBe(10_000)
  })

  it('con el cierre confirmado el cuadre lo dice; con el pendiente también (se ve que se envió)', () => {
    const t = abrir(10_000)
    const a = contar(t.turno, 9_000)
    const cierre = cerrar(t.turno, a.arqueo, 10_000, 9_000, 'confirmado', 'Falta un vale')
    expect(cuadreDeCaja([t.e, a.e, cierre], t.turno)?.cerrado).toMatchObject({
      esperado: 10_000,
      contado: 9_000,
      diferencia: -1_000,
      justificacion: 'Falta un vale',
    })
    const pendiente = cerrar(t.turno, a.arqueo, 10_000, 9_000, 'pendiente', 'Falta un vale')
    expect(cuadreDeCaja([t.e, a.e, pendiente], t.turno)?.cerrado?.diferencia).toBe(-1_000)
  })

  it('varios conteos: todos, en el orden de la lista, y el esperado no cambia', () => {
    const t = abrir(10_000)
    const a1 = contar(t.turno, 9_000)
    const a2 = contar(t.turno, 10_000)
    const c = cuadreDeCaja([t.e, a1.e, a2.e], t.turno)
    expect(c?.arqueos.map((a) => a.contado)).toEqual([9_000, 10_000])
    expect(c?.efectivo.esperado).toBe(10_000)
  })

  it('una anulación en este turno de un pago del turno anterior resta de este cajón', () => {
    const viejo = abrir(0, CAJA, 'confirmado', 8)
    const hoy = abrir(100_000, CAJA, 'confirmado', 20)
    const p = pago(viejo.turno, { monto: 30_000, propina: 2_000, recibido: 32_000 })
    const anulacion = local(
      'PagoAnulado',
      nuevoId(),
      { pago_id: p.datos.pago_id, turno_caja_id: hoy.turno } as never,
      'confirmado',
      { motivo: 'Error' },
    )
    const c = cuadreDeCaja([viejo.e, hoy.e, p.e, anulacion], hoy.turno)
    expect(c?.efectivo).toMatchObject({ devoluciones: 32_000, esperado: 68_000 })
  })

  it('sin apertura o de un turno desconocido, null', () => {
    expect(cuadreDeCaja([], nuevoId())).toBeNull()
  })
})

describe('resumenTurno: lo rechazado y los turnos', () => {
  it('un pago rechazado no suma; uno pendiente sí', () => {
    const t = abrir(0)
    const r = resumenTurno(
      [
        pago(t.turno, { monto: 5_000, recibido: 5_000 }, 'rechazado').e,
        pago(t.turno, { monto: 7_000, recibido: 7_000 }, 'pendiente').e,
      ],
      t.turno,
    )
    expect(r).toEqual({
      porMedio: [{ medio: 'efectivo', medioPropioId: null, venta: 7_000, propina: 0, pagos: 1 }],
      pagos: 1,
    })
  })

  it('los medios que quedan en cero (pago + anulación) no salen y los pagos netos suman 0', () => {
    const t = abrir(0)
    const p = pago(t.turno, { monto: 5_000, recibido: 5_000 })
    const anulacion = local(
      'PagoAnulado',
      nuevoId(),
      { pago_id: p.datos.pago_id, turno_caja_id: t.turno } as never,
      'confirmado',
      { motivo: 'Error' },
    )
    expect(resumenTurno([p.e, anulacion], t.turno)).toEqual({ porMedio: [], pagos: 0 })
  })

  it('un reembolso de un pago de medio propio de un turno anterior queda en el renglón del medio propio', () => {
    const SODEXO = nuevoId()
    const viejo = abrir(0, CAJA, 'confirmado', 8)
    const hoy = abrir(0, CAJA, 'confirmado', 20)
    const p = pago(viejo.turno, {
      medio: 'otro',
      medio_propio_id: SODEXO,
      monto: 20_000,
      recibido: null,
      cambio: null,
    })
    const reembolso = local(
      'ReembolsoRegistrado',
      nuevoId(),
      {
        pago_id: p.datos.pago_id,
        reembolso_id: nuevoId(),
        monto_venta: 5_000,
        monto_propina: 0,
        medio: 'otro',
        turno_caja_id: hoy.turno,
      } as never,
      'confirmado',
      { motivo: 'Devolución' },
    )
    expect(
      resumenTurno([viejo.e, hoy.e, p.e, reembolso] as EventoLocal[], hoy.turno).porMedio,
    ).toEqual([{ medio: 'otro', medioPropioId: SODEXO, venta: -5_000, propina: 0, pagos: 0 }])
  })
})

describe('los pagos de un turno cerrado siguen contando en su turno', () => {
  it('después del cierre, el resumen y el cuadre del turno cerrado no cambian', () => {
    const t = abrir(10_000)
    const p = pago(t.turno, { monto: 5_000, recibido: 5_000 })
    const a = contar(t.turno, 15_000)
    const cierre = cerrar(t.turno, a.arqueo, 15_000, 15_000)
    const eventos = [t.e, p.e, a.e, cierre]
    expect(cuadreDeCaja(eventos, t.turno)?.efectivo.esperado).toBe(15_000)
    expect(resumenTurno(eventos, t.turno).pagos).toBe(1)
    expect(HORA).toBeTruthy()
  })
})
