import { newId } from '@pos/core'
import type { ZReport } from '@pos/printing'
import { describe, expect, it } from 'vitest'
import { item } from '../acceso/montaje-hub'
import { type Equipo, montarImpresion } from '../impresion/montaje-impresion'

// Reportes (tarea 1.9): el cierre Z sale solo al cerrar la caja, se reimprime desde Reportes y la
// ruta del informe pide «Ver todos los reportes».

function mundo(options: { conImpresora?: boolean } = {}) {
  const t = montarImpresion()
  const ana = t.device('waiter')
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const printer = t.impresoraNueva('Caja', [])
  if (options.conImpresora !== false)
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: printer.id }), t.restaurantId)

  /** Abre un turno en la caja, cobra un pedido de `precio` en efectivo y cierra el turno cuadrado. */
  const day = (register: Equipo, price = 40_000, tip = 4_000) => {
    const shift = newId()
    expect(
      register.submit(
        shift,
        'ShiftOpened',
        { register_id: register.connection.deviceId, base: 100_000 },
        { aggregate_type: 'register_shift' },
      ).status,
    ).toBe('confirmed')
    const order = t.open(ana)
    expect(ana.submit(order, 'ItemAdded', { ...item(), unit_price: price }).status).toBe(
      'confirmed',
    )
    expect(
      register.submit(order, 'PaymentRecorded', {
        payment_id: newId(),
        check_id: null,
        register_shift_id: shift,
        method: 'cash',
        amount: price,
        tip,
        tendered: price + tip,
        change: 0,
        rounding_adjustment: 0,
        rounding: { multiple: 100, mode: 'nearest_half_down' },
        cardTerminal: null,
        charge_reference: null,
      }).status,
    ).toBe('confirmed')
    expect(register.submit(order, 'OrderClosed', {}).status).toBe('confirmed')
    const counted = 100_000 + price + tip
    const cashCount = newId()
    register.submit(
      shift,
      'CashCountRecorded',
      {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: counted / 1_000 }],
        counted_cash: counted,
      },
      { aggregate_type: 'register_shift' },
    )
    const closeout = register.submit(
      shift,
      'ShiftClosed',
      {
        cash_count_id: cashCount,
        expected_cash: counted,
        counted_cash: counted,
        variance: 0,
        justification: null,
        other_methods: [],
      },
      { aggregate_type: 'register_shift' },
    )
    return { shift, order, closeout }
  }
  const cierresZ = () => t.trabajos("WHERE type = 'report'").map((f) => t.content(f) as ZReport)
  return { t, ana, admin, cashier, printer, day, cierresZ }
}

describe('cierre Z al cerrar la caja', () => {
  it('cerrar el turno pone el cierre Z en la impresora de precuentas, y se imprime', async () => {
    const { t, admin, printer, day, cierresZ } = mundo()
    const { closeout } = day(admin)
    expect(closeout.status).toBe('confirmed')
    const [z] = cierresZ()
    expect(z).toMatchObject({
      reprinted: null,
      cash: { base: 100_000, charged: 44_000, expected: 144_000, variance: 0 },
      charged: [{ name: 'Efectivo', sale: 40_000, tip: 4_000 }],
      sales: { net: 40_000, tips: 4_000, checks: 1 },
    })
    await t.queue.runOnce()
    const [papel] = printer.papel.texts()
    expect(papel).toContain('CIERRE DE CAJA')
    expect(papel).toContain('$144.000')
  })

  it('sin impresora de precuentas no se crea nada y el cierre se acepta igual', () => {
    const { t, admin, day, cierresZ } = mundo({ conImpresora: false })
    expect(day(admin).closeout.status).toBe('confirmed')
    expect(cierresZ()).toEqual([])
    expect(t.fallosGuardar).toEqual([])
  })
})

describe('rutas de reportes', () => {
  it('el informe de hoy, con los cierres y los nombres; el cajero sin el permiso no lo ve', async () => {
    const { t, admin, cashier, day } = mundo()
    const { shift } = day(admin)
    const r = await t.post('/api/reports', { ...admin.cuerpoSesion }, admin.token)
    expect(r.statusCode).toBe(200)
    const cuerpo = r.json()
    expect(cuerpo.report.sales).toMatchObject({ net: 40_000, checks: 1 })
    expect(cuerpo.closings).toEqual([
      expect.objectContaining({
        shiftId: shift,
        closed: expect.objectContaining({ variance: 0 }),
      }),
    ])
    expect(Object.values(cuerpo.usuarios)).toContain('Ana')
    expect(cuerpo.printer).toBe(true)

    const sinPermiso = await t.post('/api/reports', { ...cashier.cuerpoSesion }, cashier.token)
    expect(sinPermiso.statusCode).toBe(403)
    expect((await t.post('/api/reports', { ...admin.cuerpoSesion })).statusCode).toBe(401)
  })

  it('rechaza fechas al revés, inválidas o un período de más de 62 días', async () => {
    const { t, admin } = mundo()
    const request = (from: string, until: string) =>
      t.post('/api/reports', { ...admin.cuerpoSesion, from, until }, admin.token)
    expect((await request('2026-10-24', '2026-10-23')).statusCode).toBe(400)
    expect((await request('2026-02-30', '2026-03-01')).statusCode).toBe(400)
    expect((await request('2026-01-01', '2026-03-04')).statusCode).toBe(400)
    expect((await request('2026-01-01', '2026-03-03')).statusCode).toBe(200)
  })

  it('reimprime el cierre Z de un turno cerrado; uno abierto o inexistente da 404', async () => {
    const { t, admin, day, cierresZ } = mundo()
    const { shift } = day(admin)
    const request = (turno_id: string) =>
      t.post('/api/reports/z-report', { ...admin.cuerpoSesion, turno_id }, admin.token)
    expect((await request(shift)).statusCode).toBe(204)
    expect(cierresZ()).toHaveLength(2)
    expect(cierresZ()[1]?.reprinted).not.toBeNull()
    expect((await request(newId())).statusCode).toBe(404)
  })

  it('sin impresora de precuentas, la reimpresión lo dice', async () => {
    const { t, admin, day } = mundo({ conImpresora: false })
    const { shift } = day(admin)
    const r = await t.post(
      '/api/reports/z-report',
      { ...admin.cuerpoSesion, turno_id: shift },
      admin.token,
    )
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('no_printer')
  })
})
