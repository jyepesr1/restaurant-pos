import { newId, type OrderEvent } from '@pos/core'
import type { ZReport } from '@pos/printing'
import { SqliteStore } from '@pos/sync/sqlite'
import { describe, expect, it, vi } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../../packages/core/src/testing/factory'
import { INICIO } from '../acceso/montaje'
import { item } from '../acceso/montaje-hub'
import { trabajosDeEvento } from '../impresion/comandas'
import { type Equipo, montarImpresion } from '../impresion/montaje-impresion'

// El cierre Z y las rutas de reportes cuando algo sale mal (tarea 1.9): el mismo cierre reenviado,
// el hub que se reinicia, sin impresora o con una que no sirve, otro restaurante en la misma base,
// los dos anchos de papel, los permisos y las fechas que no son fechas.

function mundo(options: { width?: 58 | 80; conImpresora?: boolean } = {}) {
  const t = montarImpresion()
  const ana = t.device('waiter')
  const admin = t.device('admin', 'register')
  const cashier = t.device('cashier', 'register')
  const printer = t.impresoraNueva('Caja', [], options.width ? { width: options.width } : {})
  const select = (id: string | null) =>
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify(id ? { pre_bill_printer_id: id } : {}), t.restaurantId)
  if (options.conImpresora !== false) select(printer.id)

  /** Abre un turno, cobra un pedido y deja el turno listo para cerrar (sin cerrarlo). */
  const shiftCharged = (register: Equipo, price = 40_000, tipAmount = 4_000, base = 100_000) => {
    const shift = newId()
    register.submit(
      shift,
      'ShiftOpened',
      { register_id: register.connection.deviceId, base },
      { aggregate_type: 'register_shift' },
    )
    const vender = (amount: number, tip: number) => {
      const order = t.open(ana)
      ana.submit(order, 'ItemAdded', { ...item(), unit_price: amount })
      const payment = {
        payment_id: newId(),
        check_id: null,
        register_shift_id: shift,
        method: 'cash',
        amount,
        tip: tip,
        tendered: amount + tip,
        change: 0,
        rounding_adjustment: 0,
        rounding: { multiple: 100, mode: 'nearest_half_down' },
        cardTerminal: null,
        charge_reference: null,
      }
      expect(register.submit(order, 'PaymentRecorded', payment).status).toBe('confirmed')
      expect(register.submit(order, 'OrderClosed', {}).status).toBe('confirmed')
      return order
    }
    vender(price, tipAmount)
    return { shift, vender, expected: base + price + tipAmount }
  }

  /** Cierra el turno enviando el evento a mano (así se puede reenviar tal cual). */
  const cerrarConEvento = (register: Equipo, shift: string, expected: number) => {
    const cashCount = newId()
    register.submit(
      shift,
      'CashCountRecorded',
      {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: expected / 1_000 }],
        counted_cash: expected,
      },
      { aggregate_type: 'register_shift' },
    )
    const raw = t.event(
      register.connection,
      register.session,
      'ShiftClosed',
      {
        cash_count_id: cashCount,
        expected_cash: expected,
        counted_cash: expected,
        variance: 0,
        justification: null,
        other_methods: [],
      },
      { aggregate_id: shift, aggregate_type: 'register_shift', base_sequence: 0 } as never,
    )
    return raw
  }

  const cierresZ = () => t.trabajos("WHERE type = 'report'").map((f) => t.content(f) as ZReport)
  return { t, ana, admin, cashier, printer, select, shiftCharged, cerrarConEvento, cierresZ }
}

const maxSequence = (t: ReturnType<typeof montarImpresion>) =>
  Number(
    t.db
      .prepare('SELECT coalesce(max(sequence), 0) AS s FROM events WHERE restaurant_id = ?')
      .get(t.restaurantId)?.s,
  )

describe('cierre Z: una sola vez', () => {
  it('el TurnoCerrado reenviado (mismo evento) no crea otro cierre Z', () => {
    const { t, admin, shiftCharged, cerrarConEvento, cierresZ } = mundo()
    const x = shiftCharged(admin)
    const raw = {
      ...cerrarConEvento(admin, x.shift, x.expected),
      base_sequence: maxSequence(t),
    }
    const firstOne = t.hub.receiveBatch(admin.connection, [raw as never])
    expect(firstOne.results[0]?.status).toBe('confirmed')
    expect(cierresZ()).toHaveLength(1)
    const another = t.hub.receiveBatch(admin.connection, [raw as never])
    // El reenvío no es un evento nuevo: no se guarda otra vez ni dispara el gancho.
    expect(another.acceptedEvents).toEqual([])
    expect(cierresZ()).toHaveLength(1)
    expect(t.fallosGuardar).toEqual([])
  })

  it('entregar el mismo evento al gancho dos veces, o desde un hub reiniciado, deja un solo trabajo', () => {
    const { t, admin, shiftCharged, cerrarConEvento, cierresZ } = mundo()
    const x = shiftCharged(admin)
    const raw = {
      ...cerrarConEvento(admin, x.shift, x.expected),
      base_sequence: maxSequence(t),
    }
    const r = t.hub.receiveBatch(admin.connection, [raw as never])
    const accepted = r.acceptedEvents[0] as OrderEvent
    expect(trabajosDeEvento(t.opcionesComandas, accepted, [])).toBe(1)
    expect(trabajosDeEvento(t.opcionesComandas, accepted, [])).toBe(1)
    const restarted = t.crearHub()
    restarted.receiveBatch(admin.connection, [raw as never])
    expect(trabajosDeEvento(t.opcionesComandas, accepted, [])).toBe(1)
    expect(cierresZ()).toHaveLength(1)
    expect(t.trabajos("WHERE type = 'report'")).toHaveLength(1)
  })

  it('con dos turnos cerrados salen dos cierres Z, cada uno con lo suyo', () => {
    const { t, admin, shiftCharged, cerrarConEvento, cierresZ } = mundo()
    const a = shiftCharged(admin, 40_000, 4_000)
    const ca = { ...cerrarConEvento(admin, a.shift, a.expected), base_sequence: maxSequence(t) }
    expect(t.hub.receiveBatch(admin.connection, [ca as never]).results[0]?.status).toBe('confirmed')
    const b = shiftCharged(admin, 10_000, 0, 20_000)
    const cb = { ...cerrarConEvento(admin, b.shift, b.expected), base_sequence: maxSequence(t) }
    expect(t.hub.receiveBatch(admin.connection, [cb as never]).results[0]?.status).toBe('confirmed')
    const z = cierresZ()
    expect(z).toHaveLength(2)
    expect(z.map((x) => x.cash.base)).toEqual([100_000, 20_000])
    expect(z.map((x) => x.cash.expected)).toEqual([a.expected, b.expected])
  })
})

describe('cierre Z: sin impresora o con una que no sirve', () => {
  const close = (m: ReturnType<typeof mundo>) => {
    const x = m.shiftCharged(m.admin)
    const raw = {
      ...m.cerrarConEvento(m.admin, x.shift, x.expected),
      base_sequence: maxSequence(m.t),
    }
    return { x, r: m.t.hub.receiveBatch(m.admin.connection, [raw as never]) }
  }

  it('sin impresora elegida no se crea nada y el cierre se acepta; la reimpresión pide elegirla', async () => {
    const m = mundo({ conImpresora: false })
    const { x, r } = close(m)
    expect(r.results[0]?.status).toBe('confirmed')
    expect(m.cierresZ()).toEqual([])
    expect(m.t.fallosGuardar).toEqual([])
    const res = await m.t.post(
      '/api/reports/z-report',
      { ...m.admin.cuerpoSesion, turno_id: x.shift },
      m.admin.token,
    )
    expect(res.statusCode).toBe(409)
    expect(m.cierresZ()).toEqual([])
    // Elegida la impresora después, ya se puede reimprimir.
    m.select(m.printer.id)
    const another = await m.t.post(
      '/api/reports/z-report',
      { ...m.admin.cuerpoSesion, turno_id: x.shift },
      m.admin.token,
    )
    expect(another.statusCode).toBe(204)
    expect(m.cierresZ()).toHaveLength(1)
  })

  it('con una impresora archivada o que no existe tampoco se crea nada, y el cierre se acepta', () => {
    const archivada = mundo()
    archivada.t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(archivada.printer.id)
    expect(close(archivada).r.results[0]?.status).toBe('confirmed')
    expect(archivada.cierresZ()).toEqual([])

    const ghost = mundo()
    ghost.select(newId())
    expect(close(ghost).r.results[0]?.status).toBe('confirmed')
    expect(ghost.cierresZ()).toEqual([])
  })

  it('si armar el cierre falla, el cierre de caja se acepta igual y el error se registra', () => {
    const m = mundo()
    // Una configuración que no se puede leer: el cierre de caja nunca debe quedar a medias por esto.
    m.t.db.prepare('UPDATE restaurants SET config = ? WHERE id = ?').run('[1,2]', m.t.restaurantId)
    const entry = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { r } = close(m)
      expect(r.results[0]?.status).toBe('confirmed')
      expect(m.cierresZ()).toEqual([])
    } finally {
      entry.mockRestore()
    }
    // El turno quedó cerrado de verdad.
    expect(m.t.hub.openShift(m.admin.connection.deviceId)).toBeNull()
  })

  it('la impresora apagada deja el cierre Z pendiente, con su nombre, y sale al volver', async () => {
    const m = mundo()
    m.printer.papel.apagada = true
    const { x } = close(m)
    await m.t.queue.runOnce()
    expect(m.printer.papel.received).toHaveLength(0)
    const list = await m.t.post('/api/printing/pending', { ...m.admin.cuerpoSesion }, m.admin.token)
    expect(list.json().map((p: { que: string }) => p.que)).toEqual(['Cierre de caja'])
    // Una reimpresión mientras sigue apagada.
    await m.t.post(
      '/api/reports/z-report',
      { ...m.admin.cuerpoSesion, turno_id: x.shift },
      m.admin.token,
    )
    await m.t.queue.ready()
    const two = await m.t.post('/api/printing/pending', { ...m.admin.cuerpoSesion }, m.admin.token)
    expect(two.json().map((p: { que: string }) => p.que)).toEqual([
      'Cierre de caja',
      'Cierre de caja (reimpresión)',
    ])
    m.printer.papel.apagada = false
    m.t.advance(60 * 60 * 1000)
    m.t.queue.despertar()
    await m.t.queue.ready()
    expect(m.printer.papel.texts()).toHaveLength(2)
    expect(m.t.pendingList()).toBe(0)
  })
})

describe('reimpresión del cierre Z', () => {
  it('cada reimpresión es un trabajo nuevo marcado, con las mismas cifras que el original', async () => {
    const m = mundo()
    const x = m.shiftCharged(m.admin, 55_000, 5_000)
    const raw = {
      ...m.cerrarConEvento(m.admin, x.shift, x.expected),
      base_sequence: maxSequence(m.t),
    }
    m.t.hub.receiveBatch(m.admin.connection, [raw as never])
    for (let i = 0; i < 3; i++) {
      const r = await m.t.post(
        '/api/reports/z-report',
        { ...m.admin.cuerpoSesion, turno_id: x.shift },
        m.admin.token,
      )
      expect(r.statusCode).toBe(204)
    }
    const z = m.cierresZ()
    expect(z).toHaveLength(4)
    expect(z.filter((c) => c.reprinted === null)).toHaveLength(1)
    expect(z.filter((c) => c.reprinted !== null)).toHaveLength(3)
    const { reprinted: _a, ...original } = z.find((c) => c.reprinted === null) as ZReport
    for (const c of z.filter((c) => c.reprinted !== null)) {
      const { reprinted: _b, ...rest } = c
      expect(rest).toEqual(original)
    }
    await m.t.queue.runOnce()
    const papel = m.printer.papel.texts()
    expect(papel).toHaveLength(4)
    expect(papel.filter((p) => p.includes('Reimpresión'))).toHaveLength(3)
    // La reimpresión del turno de otro día no cambia al agregar ventas después.
    expect(papel.every((p) => p.includes('CIERRE DE CAJA'))).toBe(true)
  })

  it('un turno abierto da 404 y no deja nada en la cola', async () => {
    const m = mundo()
    const register = m.admin
    const shift = newId()
    register.submit(
      shift,
      'ShiftOpened',
      { register_id: register.connection.deviceId, base: 1_000 },
      { aggregate_type: 'register_shift' },
    )
    const r = await m.t.post(
      '/api/reports/z-report',
      { ...register.cuerpoSesion, turno_id: shift },
      register.token,
    )
    expect(r.statusCode).toBe(404)
    expect(m.cierresZ()).toEqual([])
  })
})

describe('papel de 58 y de 80 mm', () => {
  it.each([58, 80] as const)('el cierre Z en %i mm sale sin líneas que se pasen', async (width) => {
    const m = mundo({ width })
    const x = m.shiftCharged(m.admin, 5_000_000, 500_000, 9_999_000)
    // Tanto dinero cabe: el contado se cuadra con el esperado.
    const raw = {
      ...m.cerrarConEvento(m.admin, x.shift, x.expected),
      base_sequence: maxSequence(m.t),
    }
    expect(m.t.hub.receiveBatch(m.admin.connection, [raw as never]).results[0]?.status).toBe(
      'confirmed',
    )
    await m.t.queue.runOnce()
    const [papel] = m.printer.papel.texts()
    expect(papel).toContain('CIERRE DE CAJA')
    const columns = width === 58 ? 32 : 48
    for (const line of (papel ?? '').split('\n')) expect(line.length).toBeLessThanOrEqual(columns)
  })
})

describe('otro restaurante en la misma base', () => {
  /** Un segundo restaurante con un turno ya cerrado y una venta, el mismo día operativo. */
  function otroRestaurante(t: ReturnType<typeof montarImpresion>) {
    const other = newId()
    const now = '2026-10-24T20:00:00.000Z'
    t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro restaurante', '{}')`,
      )
      .run(other, other, now, now)
    const store = new SqliteStore(t.db, other)
    const shift = newId()
    const order = newId()
    const raw = (type: string, aggregate: string, tipoAgregado: string, data: unknown) => ({
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: tipoAgregado,
      aggregate_id: aggregate,
      related: [],
      data,
      session_id: null,
      user_id: newId(),
      device_id: newId(),
      authorization_id: null,
      reason: null,
      device_time: now,
      hub_estimated_time: now,
      base_sequence: 0,
      received_at: now,
      business_day: '2026-10-24',
      assignments: {},
      affects: [],
      authorized_by_id: null,
    })
    const cashCount = newId()
    const it = itemCopy({ unit_price: 99_000 })
    const payment = cashPaymentData(99_000, { register_shift_id: shift })
    const base = [
      raw('ShiftOpened', shift, 'register_shift', { register_id: newId(), base: 1 }),
      event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 9 }),
      event(order, 'ItemAdded', it),
      event(order, 'PaymentRecorded', payment),
      event(order, 'OrderClosed', {}, { business_day: '2026-10-24' }),
      raw('CashCountRecorded', shift, 'register_shift', {
        cash_count_id: cashCount,
        tally: [{ value: 1_000, quantity: 99 }],
        counted_cash: 99_000,
      }),
      raw('ShiftClosed', shift, 'register_shift', {
        cash_count_id: cashCount,
        expected_cash: 99_001,
        counted_cash: 99_000,
        variance: -1,
        justification: 'Del otro restaurante',
        other_methods: [],
      }),
    ]
    for (const [i, e] of base.entries())
      store.saveEvent(
        { ...e, sequence: i + 1, received_at: now } as unknown as OrderEvent,
        `h${i}`,
        [e.aggregate_id],
      )
    return { other, shift, order }
  }

  it('el informe no suma ventas ni cierres de otro restaurante, y su cierre Z no se reimprime', async () => {
    const m = mundo()
    const own = m.shiftCharged(m.admin)
    const raw = {
      ...m.cerrarConEvento(m.admin, own.shift, own.expected),
      base_sequence: maxSequence(m.t),
    }
    m.t.hub.receiveBatch(m.admin.connection, [raw as never])
    const other = otroRestaurante(m.t)
    const r = await m.t.post(
      '/api/reports',
      { ...m.admin.cuerpoSesion, from: '2026-10-24', until: '2026-10-24' },
      m.admin.token,
    )
    const cuerpo = r.json()
    expect(cuerpo.report.sales).toMatchObject({ net: 40_000, checks: 1, guests: 2 })
    expect(cuerpo.closings.map((c: { shiftId: string }) => c.shiftId)).toEqual([own.shift])
    expect(JSON.stringify(cuerpo)).not.toContain('Del otro restaurante')
    // Reimprimir el turno de otro restaurante es como si no existiera.
    const res = await m.t.post(
      '/api/reports/z-report',
      { ...m.admin.cuerpoSesion, turno_id: other.shift },
      m.admin.token,
    )
    expect(res.statusCode).toBe(404)
    expect(m.cierresZ()).toHaveLength(1)
  })
})

describe('cierre Z: el día de las ventas es el de la apertura del turno', () => {
  it('un turno que abre un día y cierra al siguiente imprime las ventas del día que abrió', () => {
    const m = mundo()
    const register = m.admin
    const shift = newId()
    register.submit(
      shift,
      'ShiftOpened',
      { register_id: register.connection.deviceId, base: 100_000 },
      { aggregate_type: 'register_shift' },
    )
    const vender = (amount: number) => {
      const order = m.t.open(m.ana)
      m.ana.submit(order, 'ItemAdded', { ...item(), unit_price: amount })
      register.submit(order, 'PaymentRecorded', {
        payment_id: newId(),
        check_id: null,
        register_shift_id: shift,
        method: 'cash',
        amount,
        tip: 0,
        tendered: amount,
        change: 0,
        rounding_adjustment: 0,
        rounding: { multiple: 100, mode: 'nearest_half_down' },
        cardTerminal: null,
        charge_reference: null,
      })
      expect(register.submit(order, 'OrderClosed', {}).status).toBe('confirmed')
    }
    vender(40_000)
    // Pasa la madrugada: son las 6:30 a. m. del 25.
    m.t.advance(Date.parse('2026-10-25T11:30:00.000Z') - INICIO)
    vender(25_000)
    const { cerrarConEvento } = m
    const raw = { ...cerrarConEvento(register, shift, 165_000), base_sequence: maxSequence(m.t) }
    expect(m.t.hub.receiveBatch(register.connection, [raw as never]).results[0]?.status).toBe(
      'confirmed',
    )
    const [z] = m.cierresZ()
    expect(z?.sales.net).toBe(40_000)
    expect(z?.cash.charged).toBe(65_000)
  })
})

describe('rutas de reportes: permisos, cuerpos y fechas', () => {
  const report = (
    m: ReturnType<typeof mundo>,
    cuerpo: Record<string, unknown>,
    token = m.admin.token,
  ) => m.t.post('/api/reports', { ...m.admin.cuerpoSesion, ...cuerpo }, token)

  it('sin token 401, el cajero sin el permiso 403, y también para reimprimir', async () => {
    const m = mundo()
    const x = m.shiftCharged(m.admin)
    const raw = {
      ...m.cerrarConEvento(m.admin, x.shift, x.expected),
      base_sequence: maxSequence(m.t),
    }
    m.t.hub.receiveBatch(m.admin.connection, [raw as never])
    const before = m.cierresZ().length
    expect((await m.t.post('/api/reports', { ...m.admin.cuerpoSesion })).statusCode).toBe(401)
    expect(
      (await m.t.post('/api/reports', { ...m.admin.cuerpoSesion }, 'token-falso')).statusCode,
    ).toBe(401)
    expect(
      (await m.t.post('/api/reports/z-report', { ...m.admin.cuerpoSesion, turno_id: x.shift }))
        .statusCode,
    ).toBe(401)
    expect(
      (await m.t.post('/api/reports', { ...m.cashier.cuerpoSesion }, m.cashier.token)).statusCode,
    ).toBe(403)
    expect(
      (
        await m.t.post(
          '/api/reports/z-report',
          { ...m.cashier.cuerpoSesion, turno_id: x.shift },
          m.cashier.token,
        )
      ).statusCode,
    ).toBe(403)
    // El mesero tampoco.
    expect(
      (await m.t.post('/api/reports', { ...m.ana.cuerpoSesion }, m.ana.token)).statusCode,
    ).toBe(403)
    expect(m.cierresZ()).toHaveLength(before)
  })

  it('una sesión de otro equipo, o con el secreto equivocado, no sirve', async () => {
    const m = mundo()
    expect((await report(m, {}, m.cashier.token)).statusCode).toBeGreaterThanOrEqual(401)
    expect((await report(m, {}, m.cashier.token)).statusCode).not.toBe(200)
    expect((await report(m, { secret: 'otro-secreto' })).statusCode).toBe(401)
    expect((await report(m, { session_id: newId() })).statusCode).toBe(401)
  })

  it('cuerpos mal formados dan 400, no 500', async () => {
    const m = mundo()
    const crudos = [
      { session_id: m.admin.cuerpoSesion.session_id },
      { ...m.admin.cuerpoSesion, extra: 1 },
      { ...m.admin.cuerpoSesion, from: 5 },
      { ...m.admin.cuerpoSesion, from: null },
      { ...m.admin.cuerpoSesion, until: ['2026-10-24'] },
      { session_id: 5, secret: 6 },
      {},
    ]
    for (const c of crudos)
      expect((await m.t.post('/api/reports', c, m.admin.token)).statusCode).toBe(400)
    for (const c of [
      { ...m.admin.cuerpoSesion },
      { ...m.admin.cuerpoSesion, turno_id: 'corto' },
      { ...m.admin.cuerpoSesion, turno_id: newId(), extra: 1 },
      { ...m.admin.cuerpoSesion, turno_id: 7 },
    ])
      expect((await m.t.post('/api/reports/z-report', c, m.admin.token)).statusCode).toBe(400)
  })

  it('las fechas que no son fechas dan 400 y las bisiestas y de borde dan 200', async () => {
    const m = mundo()
    for (const bad of ['2026-02-29', '2026-04-31', '2026-06-31', '2027-02-29'])
      expect((await report(m, { from: bad })).statusCode, JSON.stringify(bad)).toBe(400)
    expect((await report(m, { from: '2026-10-24', until: '2026-02-29' })).statusCode).toBe(400)
    for (const goodOne of ['2028-02-29', '2026-12-31', '2027-01-01', '2026-01-01', '2036-12-31']) {
      const r = await report(m, { from: goodOne })
      expect(r.statusCode, goodOne).toBe(200)
      expect(r.json().report).toMatchObject({ from: goodOne, until: goodOne })
    }
  })

  // Hallazgo de la tarea 1.9: `Dia` en rutas.ts llama a `toISOString()` dentro del `refine`, que
  // también corre cuando el texto no cumple el formato (zod 4 no corta en el primer fallo): con un
  // texto que no es fecha (mes 13, «hoy», «2026-2-3») `toISOString()` lanza RangeError y la ruta
  // da 500 en vez de 400.
  it('un texto que no es fecha da 400, no 500', async () => {
    const m = mundo()
    for (const bad of [
      '2026-13-01',
      '2026-00-10',
      '2026-10-32',
      '2026-2-3',
      'today',
      '',
      ' 2026-10-24',
      '2026-10-24\n',
      '2026-10-24T00:00:00Z',
      '2026/10/24',
    ])
      expect((await report(m, { from: bad })).statusCode, JSON.stringify(bad)).toBe(400)
  })

  it('al revés da 400; solo "hasta" cuenta desde hoy; solo "desde" es un solo día', async () => {
    const m = mundo()
    expect((await report(m, { from: '2026-10-25', until: '2026-10-24' })).statusCode).toBe(400)
    // hoy es el 24: hasta antes de hoy queda al revés.
    expect((await report(m, { until: '2026-10-23' })).statusCode).toBe(400)
    const hastaFuturo = await report(m, { until: '2026-10-26' })
    expect(hastaFuturo.json().report).toMatchObject({ from: '2026-10-24', until: '2026-10-26' })
    expect((await report(m, { from: '2026-10-20' })).json().report).toMatchObject({
      from: '2026-10-20',
      until: '2026-10-20',
    })
    expect((await report(m, { from: '2026-10-24', until: '2026-10-24' })).statusCode).toBe(200)
  })

  it('el período máximo son 62 días: 62 pasa, 63 no, también cruzando año', async () => {
    const m = mundo()
    expect((await report(m, { from: '2026-09-01', until: '2026-11-01' })).statusCode).toBe(200) // 62 días
    expect((await report(m, { from: '2026-09-01', until: '2026-11-02' })).statusCode).toBe(400) // 63
    expect((await report(m, { from: '2026-12-01', until: '2027-01-31' })).statusCode).toBe(200) // 62
    expect((await report(m, { from: '2026-12-01', until: '2027-02-01' })).statusCode).toBe(400) // 63
    // En un año bisiesto febrero tiene un día más.
    expect((await report(m, { from: '2028-01-15', until: '2028-03-15' })).statusCode).toBe(200) // 61
    expect((await report(m, { from: '2028-01-15', until: '2028-03-17' })).statusCode).toBe(400) // 63
    expect((await report(m, { from: '2000-01-01', until: '2026-10-24' })).statusCode).toBe(400)
  })

  it('"hoy" cambia a las 6:00 a. m. de Bogotá, no a medianoche', async () => {
    const m = mundo()
    const today = async () => (await report(m, {})).json().today
    m.t.advance(Date.parse('2026-10-25T04:59:00.000Z') - INICIO) // 11:59 p. m. del 24
    expect(await today()).toBe('2026-10-24')
    m.t.advance(Date.parse('2026-10-25T10:59:00.000Z') - Date.parse('2026-10-25T04:59:00.000Z')) // 5:59 a. m.
    expect(await today()).toBe('2026-10-24')
    m.t.advance(60_000) // 6:00 a. m. del 25
    expect(await today()).toBe('2026-10-25')
    expect((await report(m, {})).json().report).toMatchObject({
      from: '2026-10-25',
      until: '2026-10-25',
    })
  })

  it('un día sin movimiento da un informe en ceros y sin cierres', async () => {
    const m = mundo()
    const r = (await report(m, { from: '2026-10-01' })).json()
    expect(r.report.sales).toMatchObject({
      net: 0,
      checks: 0,
      guests: 0,
      averageTicket: 0,
    })
    expect(r.report.byMethod).toEqual([])
    expect(r.closings).toEqual([])
    expect(r.printer).toBe(true)
  })
})
