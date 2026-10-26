import { fullConfig, newId, orderTaxes, orderTip, orderTotals } from '@pos/core'
import { COLUMNAS, type Precuenta } from '@pos/printing'
import { describe, expect, it } from 'vitest'
import { item } from '../acceso/montaje-hub'
import { trabajosDeEvento } from './comandas'
import { type Equipo, type MontajeImpresion, montarImpresion } from './montaje-impresion'

// La precuenta impresa (tarea 1.6): `PreBillPrinted` crea un trabajo `precuenta` en la cola con
// los montos que calcula el hub, la cola lo imprime y la lista de pendientes lo nombra.

const turnoYPago = (register: Equipo, order: string, amount: number, extra: object = {}) => {
  const shift = newId()
  const opened = register.mandar(
    shift,
    'ShiftOpened',
    { register_id: register.connection.dispositivoId, base: 0 },
    { aggregate_type: 'register_shift' },
  )
  expect(opened.status).toBe('confirmed')
  return payment(register, order, shift, amount, extra)
}
const payment = (
  register: Equipo,
  order: string,
  shift: string,
  amount: number,
  extra: object = {},
) =>
  register.mandar(order, 'PaymentRecorded', {
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    method: 'nequi',
    amount,
    tip: 0,
    tendered: null,
    change: null,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: null,
    charge_reference: null,
    ...extra,
  })

function mundo(options: { width?: 58 | 80; conImpresora?: boolean } = {}) {
  const t = montarImpresion()
  const ana = t.device('waiter')
  const cashier = t.device('cashier', 'register')
  const admin = t.device('admin', 'register')
  const printer = t.impresoraNueva('Caja', [], { width: options.width ?? 80 })
  const select = (id: string | null) =>
    t.post('/api/register/pre-bill', { ...admin.cuerpoSesion, printer_id: id }, admin.token)
  if (options.conImpresora !== false) {
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: printer.id }), t.restauranteId)
  }
  const agregarCon = (order: string, price: number, fields: object = {}) => {
    const it = { ...item(), unit_price: price, ...fields }
    const r = ana.mandar(order, 'ItemAdded', it)
    expect(r.status).toBe('confirmed')
    return it
  }
  const preBill = (order: string, checkId: string | null = null, extra: object = {}) =>
    ana.mandar(order, 'PreBillPrinted', {
      check_id: checkId,
      subtotal: 0,
      suggested_tip: 0,
      ...extra,
    })
  const guardada = (): Precuenta[] =>
    t.trabajos("WHERE type = 'preBill'").map((f) => t.content(f) as Precuenta)
  return { t, ana, cashier, admin, printer, select, agregarCon, preBill, guardada }
}

describe('trabajoDePrecuenta: cuándo se crea', () => {
  it('sin impresora de precuentas elegida no se crea nada, y el evento se acepta', () => {
    const { t, ana, preBill, agregarCon } = mundo({ conImpresora: false })
    const order = t.open(ana)
    agregarCon(order, 40_900)
    const r = preBill(order)
    expect(r.status).toBe('confirmed')
    expect(t.trabajos()).toEqual([])
    expect(t.fallosGuardar).toEqual([])
  })

  it('con una impresora elegida crea un trabajo precuenta para esa impresora, pendiente', () => {
    const { t, ana, preBill, agregarCon, printer } = mundo()
    const order = t.open(ana)
    agregarCon(order, 40_900)
    preBill(order)
    const trabajos = t.trabajos()
    expect(trabajos).toHaveLength(1)
    expect(trabajos[0]).toMatchObject({
      type: 'preBill',
      printer_id: printer.id,
      status: 'pending',
      attempts: 0,
      ticket_id: 'preBill',
      restaurant_id: t.restauranteId,
    })
    expect(trabajos[0]?.event_id).toBeTruthy()
  })

  it('una impresora archivada no recibe precuentas', () => {
    const { t, ana, preBill, agregarCon, printer } = mundo()
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(printer.id)
    const order = t.open(ana)
    agregarCon(order, 40_900)
    expect(preBill(order).status).toBe('confirmed')
    expect(t.trabajos()).toEqual([])
  })

  it('si la impresora se vuelve a activar, la siguiente precuenta sí sale', () => {
    const { t, ana, preBill, agregarCon, printer } = mundo()
    const order = t.open(ana)
    agregarCon(order, 40_900)
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(printer.id)
    preBill(order)
    t.db.prepare('UPDATE printers SET active = 1 WHERE id = ?').run(printer.id)
    preBill(order)
    expect(t.trabajos()).toHaveLength(1)
  })

  it('una impresora de otro restaurante (configuración manipulada) no recibe nada', () => {
    const { t, ana, preBill, agregarCon } = mundo({ conImpresora: false })
    const other = newId()
    t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(other, other, new Date(t.clock()).toISOString(), new Date(t.clock()).toISOString())
    const ajena = newId()
    t.db
      .prepare(
        `INSERT INTO printers (id, restaurant_id, created_at, updated_at, version, name, connection, address, port, width)
         VALUES (?, ?, ?, ?, 1, 'Ajena', 'network', '10.9.9.9', 9100, 80)`,
      )
      .run(ajena, other, new Date(t.clock()).toISOString(), new Date(t.clock()).toISOString())
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: ajena }), t.restauranteId)
    const order = t.open(ana)
    agregarCon(order, 40_900)
    expect(preBill(order).status).toBe('confirmed')
    expect(t.trabajos()).toEqual([])
  })

  it('elegirla por la ruta y quitarla por la ruta enciende y apaga la impresión', async () => {
    const { t, ana, preBill, agregarCon, printer, select } = mundo({ conImpresora: false })
    const order = t.open(ana)
    agregarCon(order, 40_900)
    preBill(order)
    expect(t.trabajos()).toHaveLength(0)
    expect((await select(printer.id)).statusCode).toBe(204)
    preBill(order)
    expect(t.trabajos()).toHaveLength(1)
    expect((await select(null)).statusCode).toBe(204)
    preBill(order)
    expect(t.trabajos()).toHaveLength(1)
  })

  it('otros eventos del pedido no crean precuentas', () => {
    const { t, ana, agregarCon } = mundo()
    const order = t.open(ana)
    agregarCon(order, 40_900)
    ana.mandar(order, 'GuestsChanged', { guests: 3 })
    expect(t.trabajos("WHERE type = 'preBill'")).toEqual([])
  })
})

describe('trabajoDePrecuenta: los montos cuadran con el pedido', () => {
  it('lleva restaurante, mesa, mesero, número del pedido, comensales y las líneas', () => {
    const { t, ana, agregarCon, preBill, guardada } = mundo()
    const table = t.table('5')
    const order = t.open(ana, table)
    agregarCon(order, 40_900, { name: 'Garden Margarita', quantity: 2 })
    agregarCon(order, 58_900, { name: 'Tagliata' })
    preBill(order)
    const [p] = guardada()
    expect(p).toMatchObject({
      target: 'Mesa 5',
      waiter: 'Ana',
      order: 1,
      guests: 2,
      check: null,
    })
    expect(p?.restaurant).toBeTruthy()
    expect(p?.time).toMatch(/\d/)
    expect(p?.lines).toEqual([
      { quantity: 2, name: 'Garden Margarita', options: [], value: 81_800 },
      { quantity: 1, name: 'Tagliata', options: [], value: 58_900 },
    ])
  })

  it('total, subtotal y propina salen del pedido: 140.700 al 10 % da 13.028', () => {
    const { t, ana, agregarCon, preBill, guardada } = mundo()
    const order = t.open(ana)
    agregarCon(order, 81_800)
    agregarCon(order, 58_900)
    preBill(order, null, { suggested_tip: 13_028 })
    const [p] = guardada()
    const status = t.hub.order(order)
    if (!status) throw new Error('sin pedido')
    expect(p).toMatchObject({ total: 140_700, paid: 0, subtotal: 140_700, tasaPropina: 1000 })
    expect(p?.tip).toBe(orderTip(status, 140_700, fullConfig()))
    expect(p?.tip).toBe(13_028)
  })

  it('lo que se debe lo calcula el hub: el subtotal del evento se ignora', () => {
    const { t, ana, agregarCon, preBill, guardada } = mundo()
    const order = t.open(ana)
    agregarCon(order, 40_900)
    preBill(order, null, { subtotal: 1, suggested_tip: 3_787 })
    const [p] = guardada()
    expect(p?.subtotal).toBe(40_900)
    expect(p?.total).toBe(40_900)
  })

  it('la propina es la que se eligió al pedir la precuenta: la sugerida lleva su tasa; otra, no', () => {
    const { t, ana, agregarCon, preBill, guardada } = mundo()
    const order = t.open(ana)
    agregarCon(order, 40_900)
    preBill(order, null, { suggested_tip: 3_787 })
    preBill(order, null, { suggested_tip: 5_000 })
    preBill(order, null, { suggested_tip: 0 })
    expect(guardada().map((p) => [p.tip, p.tasaPropina])).toEqual([
      [3_787, 1000],
      [5_000, null],
      [0, null],
    ])
    // El saldo y el total no dependen de la propina elegida.
    for (const p of guardada()) expect(p).toMatchObject({ subtotal: 40_900, total: 40_900 })
  })

  it('la suma de las líneas es el total, y base + impuesto de cada grupo suma el total', () => {
    const { t, ana, agregarCon, preBill, guardada } = mundo()
    const order = t.open(ana)
    agregarCon(order, 12_900, { quantity: 3 })
    agregarCon(order, 16_000)
    agregarCon(order, 10_000, { tax_type: 'iva', rate: 1900 })
    agregarCon(order, 5_000, { tax_type: 'exempt', rate: 0 })
    preBill(order)
    const [p] = guardada()
    expect(p?.lines.reduce((a, l) => a + l.value, 0)).toBe(p?.total)
    expect(p?.taxes?.reduce((a, i) => a + i.base + i.value, 0)).toBe(p?.total)
    expect(p?.taxes?.map((i) => i.name).sort()).toEqual(['Exento', 'INC 8 %', 'IVA 19 %'])
    expect(p?.taxes?.find((i) => i.name === 'Exento')?.value).toBe(0)
    const status = t.hub.order(order)
    if (!status) throw new Error('sin pedido')
    expect(p?.taxes?.map((i) => i.value).sort()).toEqual(
      orderTaxes(status, 'half_up')
        .map((i) => i.tax)
        .sort(),
    )
  })

  it('las opciones del plato salen en su línea', () => {
    const { t, ana, agregarCon, preBill, guardada } = mundo()
    const order = t.open(ana)
    agregarCon(order, 58_900, {
      name: 'Tagliata',
      modifiers: [{ modifier_id: newId(), name: 'Término medio', extra_price: 0 }],
    })
    preBill(order)
    expect(guardada()[0]?.lines[0]?.options).toEqual(['Término medio'])
  })

  it('un plato anulado no sale; uno anulado en parte sale con las unidades que quedan', () => {
    const { t, ana, agregarCon, preBill, guardada } = mundo()
    const order = t.open(ana)
    const beers = agregarCon(order, 14_900, { name: 'Heineken', quantity: 3 })
    const dish = agregarCon(order, 40_900, { name: 'Pizza' })
    t.send(ana, order, [
      { id: beers.item_id, station: t.bar },
      { id: dish.item_id, station: t.kitchen },
    ])
    const voidItem = (item_id: string, quantity: number) =>
      ana.mandar(order, 'ItemVoided', {
        item_id,
        quantity,
        already_prepared: false,
        ticket_id: null,
      })
    // El mesero no puede anular lo enviado: lo hace quien tiene el permiso.
    const cashier = t.device('cashier', 'register')
    const anulaCajero = (item_id: string, quantity: number) =>
      cashier.mandar(order, 'ItemVoided', {
        item_id,
        quantity,
        already_prepared: false,
        ticket_id: null,
      })
    expect(voidItem(dish.item_id, 1).status).toBe('rejected')
    expect(anulaCajero(beers.item_id, 1).status).toBe('confirmed')
    expect(anulaCajero(dish.item_id, 1).status).toBe('confirmed')
    preBill(order, null, { suggested_tip: 2_759 })
    const [p] = guardada()
    expect(p?.lines).toEqual([{ quantity: 2, name: 'Heineken', options: [], value: 29_800 }])
    expect(p?.total).toBe(29_800)
    expect(p?.subtotal).toBe(29_800)
    expect(p?.tip).toBe(2_759)
  })

  it('un descuento baja el total y la propina', () => {
    const { t, ana, agregarCon, preBill, guardada } = mundo()
    const cashier = t.device('cashier', 'register')
    const order = t.open(ana)
    const dish = agregarCon(order, 53_800)
    const r = cashier.mandar(
      order,
      'DiscountApplied',
      {
        discount_id: newId(),
        scope: 'order',
        rule: 'percent',
        value: 1000,
        unit_count: null,
        amounts: [{ item_id: dish.item_id, amount: 5_380 }],
      },
      { reason: 'Cumpleaños' },
    )
    expect(r.status).toBe('confirmed')
    preBill(order, null, { suggested_tip: 4_483 })
    const [p] = guardada()
    expect(p).toMatchObject({ total: 48_420, subtotal: 48_420, tip: 4_483, tasaPropina: 1000 })
    expect(p?.lines).toEqual([expect.objectContaining({ name: 'Aperol Spritz', value: 48_420 })])
  })

  it('con pagos previos: total entero, lo ya pagado, el saldo y la propina del saldo', () => {
    const { t, ana, cashier, agregarCon, preBill, guardada } = mundo()
    const order = t.open(ana)
    agregarCon(order, 100_000)
    expect(turnoYPago(cashier, order, 40_000).status).toBe('confirmed')
    preBill(order, null, { suggested_tip: 5_556 })
    const [p] = guardada()
    expect(p).toMatchObject({
      total: 100_000,
      paid: 40_000,
      subtotal: 60_000,
      tip: 5_556,
      tasaPropina: 1000,
      check: null,
    })
    // Σ líneas = total (la precuenta muestra todo lo que se consumió, no solo el saldo).
    expect(p?.lines.reduce((a, l) => a + l.value, 0)).toBe(100_000)
  })

  it('un pago con propina propia no cambia la propina sugerida del saldo', () => {
    const { t, ana, cashier, agregarCon, preBill, guardada } = mundo()
    const order = t.open(ana)
    agregarCon(order, 100_000)
    turnoYPago(cashier, order, 40_000, { tip: 4_000 })
    preBill(order, null, { suggested_tip: 5_556 })
    expect(guardada()[0]).toMatchObject({
      paid: 40_000,
      subtotal: 60_000,
      tip: 5_556,
      tasaPropina: 1000,
    })
  })

  it('un pedido pagado por completo: saldo 0 y propina 0', () => {
    const { t, ana, cashier, agregarCon, preBill, guardada } = mundo()
    const order = t.open(ana)
    agregarCon(order, 40_900)
    turnoYPago(cashier, order, 40_900)
    preBill(order)
    expect(guardada()[0]).toMatchObject({ total: 40_900, paid: 40_900, subtotal: 0, tip: 0 })
  })

  it('una mesa vacía (sin productos) tampoco rompe: todo en cero', () => {
    const { t, ana, preBill, guardada } = mundo()
    const order = t.open(ana)
    expect(preBill(order).status).toBe('confirmed')
    expect(guardada()[0]).toMatchObject({
      lines: [],
      total: 0,
      subtotal: 0,
      tip: 0,
      taxes: [],
    })
    expect(t.fallosGuardar).toEqual([])
  })

  it('tasa de propina distinta en el restaurante: la precuenta usa la vigente', () => {
    const { t, ana, agregarCon, preBill, guardada, printer } = mundo()
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: printer.id, suggested_tip: 500 }), t.restauranteId)
    const order = t.open(ana)
    agregarCon(order, 100_000)
    preBill(order, null, { suggested_tip: 4_630 })
    expect(guardada()[0]).toMatchObject({ tasaPropina: 500, tip: 4_630 })
  })

  it('con propina sugerida en 0 %, la precuenta lleva propina 0', () => {
    const { t, ana, agregarCon, preBill, guardada, printer } = mundo()
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ pre_bill_printer_id: printer.id, suggested_tip: 0 }), t.restauranteId)
    const order = t.open(ana)
    agregarCon(order, 100_000)
    preBill(order, null, { suggested_tip: 0 })
    expect(guardada()[0]).toMatchObject({ tasaPropina: 0, tip: 0, subtotal: 100_000 })
  })

  it('el destino sigue al pedido: para llevar, varias mesas unidas', () => {
    const { t, ana, agregarCon, preBill, guardada } = mundo()
    const llevar = t.open(ana, null, 'takeout')
    agregarCon(llevar, 10_000)
    preBill(llevar)
    const m5 = t.table('5')
    const m6 = t.table('6')
    const group = t.open(ana, m5)
    agregarCon(group, 10_000)
    expect(ana.mandar(group, 'TablesMerged', { table_ids: [m6] }).status).toBe('confirmed')
    preBill(group)
    expect(guardada().map((p) => p.target)).toEqual(['Para llevar', 'Mesa 5 + 6'])
  })
})

describe('trabajoDePrecuenta: cuenta dividida', () => {
  /** Un pedido de $100.000 dividido en dos cuentas de $50.000 (propinas 4.630 y 4.629). */
  function divided() {
    const m = mundo()
    const { t, ana, cashier, agregarCon } = m
    const order = t.open(ana)
    agregarCon(order, 100_000)
    const checks = [
      {
        check_id: newId(),
        name: 'Cuenta 1',
        amount: 50_000,
        suggested_tip: 4_630,
        items: [],
      },
      {
        check_id: newId(),
        name: 'Cuenta 2',
        amount: 50_000,
        suggested_tip: 4_629,
        items: [],
      },
    ]
    expect(cashier.mandar(order, 'CheckSplit', { checks }).status).toBe('confirmed')
    return { ...m, order, checks }
  }

  it('la precuenta de una cuenta lleva su nombre, su monto y su propina fijada al dividir', () => {
    const { preBill, guardada, order, checks } = divided()
    preBill(order, checks[0]?.check_id, { suggested_tip: 4_630 })
    preBill(order, checks[1]?.check_id, { suggested_tip: 4_629 })
    const [a, b] = guardada()
    expect(a).toMatchObject({
      check: { name: 'Cuenta 1', amount: 50_000 },
      subtotal: 50_000,
      tip: 4_630,
      tasaPropina: 1000,
      total: 100_000,
    })
    expect(b).toMatchObject({
      check: { name: 'Cuenta 2', amount: 50_000 },
      subtotal: 50_000,
      tip: 4_629,
      tasaPropina: 1000,
    })
    // Las dos propinas suman la del pedido entero (9.259).
    expect((a?.tip ?? 0) + (b?.tip ?? 0)).toBe(9_259)
  })

  it('la precuenta del pedido dividido sin pedir una cuenta lleva el saldo entero', () => {
    const { preBill, guardada, order } = divided()
    preBill(order, null, { suggested_tip: 9_259 })
    expect(guardada()[0]).toMatchObject({ check: null, subtotal: 100_000, tip: 9_259 })
  })

  it('una cuenta con un pago parcial: queda su saldo y la parte proporcional de su propina', () => {
    const { t, cashier, preBill, guardada, order, checks } = divided()
    const check = checks[0]?.check_id as string
    const shift = newId()
    cashier.mandar(
      shift,
      'ShiftOpened',
      { register_id: cashier.connection.dispositivoId, base: 0 },
      { aggregate_type: 'register_shift' },
    )
    expect(payment(cashier, order, shift, 20_000, { check_id: check }).status).toBe('confirmed')
    preBill(order, check, { suggested_tip: 2_778 })
    const [p] = guardada()
    // Quedan 30.000 de 50.000: la propina de la cuenta (4.630) repartida entre lo pagado y lo que falta.
    expect(p).toMatchObject({
      check: { name: 'Cuenta 1', amount: 30_000 },
      subtotal: 30_000,
      tip: 2_778,
      tasaPropina: 1000,
      paid: 20_000,
    })
    expect(t.fallosGuardar).toEqual([])
  })

  it('una cuenta pagada del todo imprime saldo 0 y propina 0', () => {
    const { cashier, preBill, guardada, order, checks } = divided()
    const check = checks[1]?.check_id as string
    turnoYPago(cashier, order, 50_000, { check_id: check })
    preBill(order, check)
    expect(guardada()[0]).toMatchObject({ subtotal: 0, tip: 0, check: { amount: 0 } })
  })

  it('una cuenta que ya no existe (se deshizo la división) imprime el saldo del pedido', () => {
    const { cashier, preBill, guardada, order, checks } = divided()
    expect(cashier.mandar(order, 'SplitUndone', {}).status).toBe('confirmed')
    preBill(order, checks[0]?.check_id, { suggested_tip: 9_259 })
    expect(guardada()[0]).toMatchObject({ check: null, subtotal: 100_000, tip: 9_259 })
  })

  it('con pagos previos en la cuenta general, la cuenta dividida sigue en lo que se dividió', () => {
    const m = mundo()
    const { t, ana, cashier, agregarCon, preBill, guardada } = m
    const order = t.open(ana)
    agregarCon(order, 100_000)
    turnoYPago(cashier, order, 40_000)
    const checks = [
      {
        check_id: newId(),
        name: 'Cuenta 1',
        amount: 30_000,
        suggested_tip: 2_778,
        items: [],
      },
      {
        check_id: newId(),
        name: 'Cuenta 2',
        amount: 30_000,
        suggested_tip: 2_778,
        items: [],
      },
    ]
    expect(cashier.mandar(order, 'CheckSplit', { checks }).status).toBe('confirmed')
    preBill(order, checks[0]?.check_id, { suggested_tip: 2_778 })
    expect(guardada()[0]).toMatchObject({
      total: 100_000,
      paid: 40_000,
      subtotal: 30_000,
      tip: 2_778,
      check: { name: 'Cuenta 1', amount: 30_000 },
    })
  })
})

describe('trabajoDePrecuenta: sin repetirse', () => {
  it('el mismo evento reenviado por el equipo no crea otro trabajo', () => {
    const { t, ana, agregarCon } = mundo()
    const order = t.open(ana)
    agregarCon(order, 40_900)
    const event = t.device('waiter')
    const data = { check_id: null, subtotal: 0, suggested_tip: 0 }
    const crudo = t.event(event.connection, event.session, 'PreBillPrinted', data, {
      aggregate_id: order,
      base_sequence: Number(t.db.prepare('SELECT max(sequence) AS s FROM events').get()?.s ?? 0),
    } as never)
    const a = t.hub.recibirLote(event.connection, [crudo])
    const b = t.hub.recibirLote(event.connection, [crudo])
    expect(a.resultados[0]?.status).toBe('confirmed')
    expect(b.resultados[0]?.status).toBe('confirmed')
    expect(b.aceptados).toEqual([])
    expect(t.trabajos("WHERE type = 'preBill'")).toHaveLength(1)
  })

  it('volver a procesar el mismo evento aceptado (reintento del gancho) no duplica el trabajo', () => {
    const { t, ana, agregarCon, preBill } = mundo()
    const order = t.open(ana)
    agregarCon(order, 40_900)
    const r = preBill(order)
    const after = t.hub.order(order)
    expect(r.accepted && after).toBeTruthy()
    trabajosDeEvento(t.opcionesComandas, r.accepted as never, [{ before: after, after }])
    trabajosDeEvento(t.opcionesComandas, r.accepted as never, [{ before: after, after }])
    expect(t.trabajos("WHERE type = 'preBill'")).toHaveLength(1)
  })

  it('pedir la precuenta dos veces son dos eventos: dos trabajos (se puede reimprimir)', () => {
    const { t, ana, agregarCon, preBill } = mundo()
    const order = t.open(ana)
    agregarCon(order, 40_900)
    preBill(order)
    preBill(order)
    expect(t.trabajos("WHERE type = 'preBill'")).toHaveLength(2)
  })

  it('una precuenta no mezcla con las comandas: enviar a cocina no crea precuentas', () => {
    const { t, ana, agregarCon } = mundo()
    t.impresoraNueva('Cocina', [t.kitchen])
    const order = t.open(ana)
    const dish = agregarCon(order, 40_900)
    t.send(ana, order, [{ id: dish.item_id, station: t.kitchen }])
    expect(t.trabajos("WHERE type = 'preBill'")).toEqual([])
    expect(t.trabajos("WHERE type = 'ticket'")).toHaveLength(1)
  })
})

describe('la cola imprime la precuenta', () => {
  it('sale en el papel de la impresora de precuentas con los montos y se marca impresa', async () => {
    const { t, ana, agregarCon, preBill, printer } = mundo()
    const order = t.open(ana, t.table('5'))
    agregarCon(order, 40_900, { name: 'Garden Margarita', quantity: 2 })
    preBill(order, null, { suggested_tip: 7_574 })
    await t.cola.runOnce()
    const [papel] = printer.papel.textos()
    expect(papel).toContain('PRECUENTA')
    expect(papel).toContain('Mesa 5')
    expect(papel).toContain('2 x Garden Margarita')
    expect(papel).toContain('$81.800')
    expect(papel).toContain('Propina sugerida (10 %)')
    expect(papel).toContain('$7.574')
    expect(papel).toContain('$89.374')
    expect(t.pendingList()).toBe(0)
    expect(t.trabajos("WHERE type = 'preBill'")[0]).toMatchObject({
      status: 'printed',
      attempts: 1,
      printed_on_id: printer.id,
    })
    expect(printer.papel.recibidos).toHaveLength(1)
  })

  it('si el cliente pidió otra propina, el papel dice «Propina» (no «sugerida») y suma esa', async () => {
    const { t, ana, agregarCon, preBill, printer } = mundo()
    const order = t.open(ana, t.table('5'))
    agregarCon(order, 40_900)
    preBill(order, null, { suggested_tip: 5_000 })
    await t.cola.runOnce()
    const papel = (printer.papel.textos()[0] ?? '').replace(/[ ]+/g, ' ')
    expect(papel).toContain('Propina $5.000')
    expect(papel).not.toContain('Propina sugerida')
    expect(papel).toContain('$45.900')
  })

  it('sin propina el papel dice «A pagar» con el saldo', async () => {
    const { t, ana, agregarCon, preBill, printer } = mundo()
    const order = t.open(ana, t.table('5'))
    agregarCon(order, 40_900)
    preBill(order, null, { suggested_tip: 0 })
    await t.cola.runOnce()
    const papel = (printer.papel.textos()[0] ?? '').replace(/[ ]+/g, ' ')
    expect(papel).toContain('A pagar $40.900')
    expect(papel).not.toContain('Propina')
  })

  it('en una impresora de 58 mm las líneas caben en 32 columnas', async () => {
    const { t, ana, agregarCon, preBill, printer } = mundo({ width: 58 })
    const order = t.open(ana, t.table('5'))
    agregarCon(order, 40_900, { name: 'Garden Margarita con nombre bien largo', quantity: 2 })
    preBill(order)
    await t.cola.runOnce()
    const text = printer.papel.textos()[0] ?? ''
    expect(text).toContain('$81.800')
    for (const line of text.split('\n')) expect(line.length, line).toBeLessThanOrEqual(COLUMNAS[58])
  })

  it('imprime una sola vez aunque la cola dé más vueltas, y corta el papel una vez', async () => {
    const { t, ana, agregarCon, preBill, printer } = mundo()
    const order = t.open(ana)
    agregarCon(order, 40_900)
    preBill(order)
    await t.cola.runOnce()
    await t.cola.runOnce()
    t.avanzar(60_000)
    await t.cola.runOnce()
    expect(printer.papel.recibidos).toHaveLength(1)
  })

  it('con la impresora apagada se queda pendiente y sale cuando vuelve, con los mismos montos', async () => {
    const { t, ana, agregarCon, preBill, printer } = mundo()
    const order = t.open(ana)
    agregarCon(order, 40_900)
    printer.papel.apagada = true
    preBill(order)
    await t.cola.runOnce()
    expect(t.pendingList()).toBe(1)
    expect(t.trabajos()[0]).toMatchObject({ attempts: 1 })
    // El pedido cambia mientras tanto: la precuenta ya quedó fijada con lo de ese momento.
    agregarCon(order, 10_000)
    printer.papel.apagada = false
    t.avanzar(5_000)
    await t.cola.runOnce()
    expect(t.pendingList()).toBe(0)
    const text = printer.papel.textos()[0] ?? ''
    expect(text).toContain('$40.900')
    expect(text).not.toContain('$50.900')
  })

  it('la precuenta pasa a la impresora de respaldo si la principal sigue caída', async () => {
    const { t, ana, agregarCon, preBill, printer } = mundo()
    const respaldo = t.impresoraNueva('Barra', [])
    t.db.prepare('UPDATE printers SET fallback_id = ? WHERE id = ?').run(respaldo.id, printer.id)
    printer.papel.apagada = true
    const order = t.open(ana)
    agregarCon(order, 40_900)
    preBill(order)
    // Tres fallos seguidos; justo después, con la espera de la principal sin vencer, sale por el respaldo.
    for (let i = 0; i < 3; i++) {
      await t.cola.runOnce()
      t.avanzar(60_000)
    }
    t.avanzar(-60_000 + 1)
    await t.cola.runOnce()
    expect(respaldo.papel.textos()[0]).toContain('PRECUENTA')
    expect(t.trabajos("WHERE type = 'preBill'")[0]).toMatchObject({
      status: 'printed',
      printed_on_id: respaldo.id,
    })
  })

  it('un contenido que no se entiende no frena a las comandas de detrás', async () => {
    const { t, ana, printer } = mundo()
    t.impresoraNueva('Cocina', [t.kitchen])
    const broken = newId()
    t.db
      .prepare(
        `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, event_id, ticket_id, content, created_at)
         VALUES (?, ?, ?, 'preBill', ?, 'preBill', '{"lines":"no es lista"}', ?)`,
      )
      .run(broken, t.restauranteId, printer.id, newId(), new Date(t.clock()).toISOString())
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    t.send(ana, order, items)
    await t.cola.runOnce()
    await t.cola.runOnce()
    expect(t.trabajos("WHERE type = 'ticket'")[0]).toMatchObject({ status: 'printed' })
  })
})

describe('«Pedidos que no han salido»: la precuenta se nombra', () => {
  const pendingList = async (t: MontajeImpresion, e: Equipo) =>
    (await t.post('/api/printing/pending', e.cuerpoSesion, e.token)).json() as {
      id: string
      printer: string
      que: string
      attempts: number
      error: string | null
    }[]

  it('«Precuenta · Mesa 5», con la impresora y el error', async () => {
    const { t, ana, admin, agregarCon, preBill, printer } = mundo()
    printer.papel.apagada = true
    const order = t.open(ana, t.table('5'))
    agregarCon(order, 40_900)
    preBill(order)
    await t.cola.runOnce()
    const list = await pendingList(t, admin)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ que: 'Precuenta · Mesa 5', printer: 'Caja', attempts: 1 })
    expect(list[0]?.error).toContain('rechazó la conexión')
  })

  it('para llevar: «Precuenta · Para llevar»; el cajero con registrar_pago también la ve', async () => {
    const { t, ana, cashier, agregarCon, preBill, printer } = mundo()
    printer.papel.apagada = true
    const order = t.open(ana, null, 'takeout')
    agregarCon(order, 40_900)
    preBill(order)
    const list = await pendingList(t, cashier)
    expect(list.map((x) => x.que)).toEqual(['Precuenta · Para llevar'])
  })

  it('se puede descartar una precuenta que ya no sirve', async () => {
    const { t, ana, admin, agregarCon, preBill, printer } = mundo()
    printer.papel.apagada = true
    const order = t.open(ana, t.table('5'))
    agregarCon(order, 40_900)
    preBill(order)
    const [trabajo] = await pendingList(t, admin)
    const r = await t.post(
      '/api/printing/discard',
      { ...admin.cuerpoSesion, trabajo_id: trabajo?.id },
      admin.token,
    )
    expect(r.statusCode).toBe(204)
    expect(await pendingList(t, admin)).toEqual([])
    expect(t.trabajos("WHERE type = 'preBill'")[0]).toMatchObject({ status: 'discarded' })
  })

  it('comandas y precuentas conviven en la misma lista, cada una con su nombre', async () => {
    const { t, ana, admin, agregarCon, preBill, printer } = mundo()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    kitchen.papel.apagada = true
    printer.papel.apagada = true
    const table = t.table('7')
    const order = t.open(ana, table)
    const dish = agregarCon(order, 40_900, { name: 'Pizza' })
    t.send(ana, order, [{ id: dish.item_id, station: t.kitchen }])
    t.avanzar(1_000)
    preBill(order)
    const list = (await pendingList(t, admin)).map((x) => x.que)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatch(/^Cocina · Mesa 7/)
    expect(list[1]).toBe('Precuenta · Mesa 7')
  })

  it('una Precuenta con un destino vacío no deja «Precuenta · » colgando', async () => {
    const { t, admin, printer } = mundo()
    printer.papel.apagada = true
    t.db
      .prepare(
        `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
         VALUES (?, ?, ?, 'preBill', '{}', ?)`,
      )
      .run(newId(), t.restauranteId, printer.id, new Date(t.clock()).toISOString())
    const list = await pendingList(t, admin)
    expect(list[0]?.que).toBe('Precuenta')
  })

  it('totalesPedido del hub y la precuenta impresa coinciden en el saldo', () => {
    const { t, ana, cashier, agregarCon, preBill, guardada } = mundo()
    const order = t.open(ana)
    agregarCon(order, 73_400)
    turnoYPago(cashier, order, 13_400)
    preBill(order)
    const status = t.hub.order(order)
    if (!status) throw new Error('sin pedido')
    expect(guardada()[0]?.subtotal).toBe(orderTotals(status).balance)
  })
})
