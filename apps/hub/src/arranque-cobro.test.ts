import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@pos/core'
import type { HubMessage } from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { montarAcceso } from './acceso/montaje'
import { ABRIR, item } from './acceso/montaje-hub'
import { insertVersioned, SISTEMA } from './acceso/registros'
import { prepararSincronizacion } from './arranque'

// `prepararSincronizacion` (lo que corre en el hub real): las reglas de cobro se leen de la base en
// cada pago, así que lo que el administrador cambie con el hub andando vale desde el siguiente
// pago: medios, datáfonos activos y la regla de redondeo del efectivo.

const carpetas: string[] = []
afterEach(() => {
  for (const c of carpetas.splice(0)) rmSync(c, { recursive: true, force: true })
})

function mundo() {
  const m = montarAcceso()
  const dir = mkdtempSync(join(tmpdir(), 'hub-checkout-'))
  carpetas.push(dir)
  const floor = prepararSincronizacion(m.db, dir, m.restaurantId, m.access)
  const register = m.emparejar('register')
  const session = m.entrar(register.connection, 'cashier')
  const received: HubMessage[] = []
  const link = floor.connect((message) => received.push(message))
  link.receive({
    type: 'hello',
    token: register.token,
    hub_instance: null,
    until: 0,
    version_app: 'pruebas',
  })
  let batch = 0
  const maxSequence = () =>
    Number(
      m.db
        .prepare('SELECT coalesce(max(sequence), 0) AS s FROM events WHERE restaurant_id = ?')
        .get(m.restaurantId)?.s,
    )
  /** Manda eventos al hub real y devuelve cómo le fue a cada uno. */
  const submit = (
    events: { type: string; aggregate: string; data: unknown; extras?: object }[],
  ): string[] => {
    batch += 1
    link.receive({
      type: 'push',
      batch_id: `lote-${batch}`,
      events: events.map((e) =>
        m.event(register.connection, session, e.type, e.data, {
          aggregate_id: e.aggregate,
          base_sequence: maxSequence(),
          ...(e.extras ?? {}),
        } as never),
      ),
    })
    const latest = received.filter((x) => x.type === 'result').at(-1)
    if (latest?.type !== 'result') throw new Error('Sin resultado')
    return latest.results.map((r) => (r.status === 'rejected' ? r.reason : r.status))
  }

  const shift = newId()
  expect(
    submit([
      {
        type: 'ShiftOpened',
        aggregate: shift,
        data: { register_id: register.connection.deviceId, base: 100_000 },
        extras: { aggregate_type: 'register_shift' },
      },
    ]),
  ).toEqual(['confirmed'])

  const orderWith = (price: number) => {
    const order = newId()
    expect(
      submit([
        { type: 'OrderOpened', aggregate: order, data: ABRIR },
        { type: 'ItemAdded', aggregate: order, data: { ...item(), unit_price: price } },
      ]),
    ).toEqual(['confirmed', 'confirmed'])
    return order
  }
  const cardTerminal = (name = 'Bold 1', extra: Record<string, string | number> = {}) =>
    insertVersioned(
      m.db,
      'card_terminals',
      m.restaurantId,
      { name, provider: 'bold', ...extra },
      SISTEMA,
      m.clock(),
    )
  const ponerConfig = (config: object) =>
    m.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify(config), m.restaurantId)

  const base = {
    check_id: null,
    register_shift_id: shift,
    tip: 0,
    charge_reference: null,
  }
  const nequi = (amount: number) => ({
    ...base,
    payment_id: newId(),
    method: 'nequi',
    amount,
    tendered: null,
    change: null,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: null,
  })
  const card = (amount: number, datafonoId: string, approval_code: string | null = null) => ({
    ...base,
    payment_id: newId(),
    method: 'card',
    amount,
    tendered: null,
    change: null,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: {
      card_terminal_id: datafonoId,
      franchise: null,
      last4: null,
      approval_code,
      receipt: null,
    },
  })
  /** Efectivo que cancela el saldo de $36.810: se cobra $36.800 (−10) con la regla que se diga. */
  const cash = (rounding: { multiple: number; mode: string } | null, amount = 36_810) => ({
    ...base,
    payment_id: newId(),
    method: 'cash',
    amount,
    tendered: amount - 10,
    change: 0,
    rounding_adjustment: -10,
    rounding,
    cardTerminal: null,
  })
  const pay = (order: string, data: unknown) =>
    submit([{ type: 'PaymentRecorded', aggregate: order, data }])[0]
  return { m, submit, orderWith, cardTerminal, ponerConfig, nequi, card, cash, pay, shift }
}

describe('reglas de cobro del hub real', () => {
  it('de fábrica acepta Nequi y el efectivo con la regla del restaurante (100, mitad abajo)', () => {
    const { orderWith, pay, nequi, cash } = mundo()
    expect(pay(orderWith(10_000), nequi(10_000))).toBe('confirmed')
    expect(pay(orderWith(36_810), cash({ multiple: 100, mode: 'nearest_half_down' }))).toBe(
      'confirmed',
    )
  })

  it('el administrador quita Nequi con el hub andando: el siguiente pago ya no pasa', () => {
    const { orderWith, pay, nequi, ponerConfig } = mundo()
    const order = orderWith(20_000)
    expect(pay(order, nequi(5_000))).toBe('confirmed')
    ponerConfig({ payment_methods: ['cash', 'card'] })
    expect(pay(order, nequi(5_000))).toBe('method_not_enabled')
    ponerConfig({ payment_methods: ['cash', 'card', 'nequi'] })
    expect(pay(order, nequi(5_000))).toBe('confirmed')
  })

  it('el bono solo se acepta si el restaurante lo incluye', () => {
    const { orderWith, pay, nequi, ponerConfig } = mundo()
    const order = orderWith(20_000)
    const voucher = { ...nequi(5_000), method: 'voucher' }
    expect(pay(order, voucher)).toBe('method_not_enabled')
    ponerConfig({ payment_methods: ['cash', 'voucher'] })
    expect(pay(order, voucher)).toBe('confirmed')
  })

  it('tarjeta con un datáfono activo del restaurante, sin número de aprobación: se acepta', () => {
    const { orderWith, pay, card, cardTerminal } = mundo()
    const bold = cardTerminal()
    expect(pay(orderWith(10_000), card(10_000, bold))).toBe('confirmed')
    expect(pay(orderWith(10_000), card(10_000, bold, '123456'))).toBe('confirmed')
  })

  it('tarjeta con un datáfono que no existe: datafono_desconocido', () => {
    const { orderWith, pay, card, cardTerminal } = mundo()
    cardTerminal()
    expect(pay(orderWith(10_000), card(10_000, newId()))).toBe('unknown_card_terminal')
  })

  it('tarjeta sin ningún datáfono registrado: datafono_desconocido', () => {
    const { orderWith, pay, card } = mundo()
    expect(pay(orderWith(10_000), card(10_000, newId()))).toBe('unknown_card_terminal')
  })

  it('un datáfono archivado ya no sirve, y vuelve a servir al reactivarlo', () => {
    const { m, orderWith, pay, card, cardTerminal } = mundo()
    const bold = cardTerminal()
    const order = orderWith(20_000)
    m.db.prepare('UPDATE card_terminals SET active = 0 WHERE id = ?').run(bold)
    expect(pay(order, card(5_000, bold))).toBe('unknown_card_terminal')
    m.db.prepare('UPDATE card_terminals SET active = 1 WHERE id = ?').run(bold)
    expect(pay(order, card(5_000, bold))).toBe('confirmed')
  })

  it('el datáfono de otro restaurante no sirve en este', () => {
    const { m, orderWith, pay, card } = mundo()
    const other = newId()
    m.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(other, other, m.clock(), m.clock())
    const outsider = newId()
    m.db
      .prepare(
        `INSERT INTO card_terminals (id, restaurant_id, created_at, updated_at, version, name, provider)
         VALUES (?, ?, ?, ?, 1, 'Bold ajeno', 'bold')`,
      )
      .run(outsider, other, m.clock(), m.clock())
    expect(pay(orderWith(10_000), card(10_000, outsider))).toBe('unknown_card_terminal')
  })

  it('la regla de redondeo viene de la configuración: otro múltiplo, redondeo_distinto', () => {
    const { orderWith, pay, cash } = mundo()
    expect(pay(orderWith(36_810), cash({ multiple: 50, mode: 'nearest_half_down' }))).toBe(
      'rounding_mismatch',
    )
    expect(pay(orderWith(36_810), cash({ multiple: 100, mode: 'up' }))).toBe('rounding_mismatch')
  })

  it('si el restaurante cambia el múltiplo a 50, la regla de 100 deja de valer y la de 50 vale', () => {
    const { orderWith, pay, cash, ponerConfig } = mundo()
    ponerConfig({ cash_rounding: 50 })
    expect(pay(orderWith(36_810), cash({ multiple: 100, mode: 'nearest_half_down' }))).toBe(
      'rounding_mismatch',
    )
    // Con múltiplo 50, $36.810 se cobra a $36.800 (−10) igual: la regla nueva se acepta.
    expect(pay(orderWith(36_810), cash({ multiple: 50, mode: 'nearest_half_down' }))).toBe(
      'confirmed',
    )
  })

  it('si cambia el modo del efectivo, también', () => {
    const { orderWith, pay, cash, ponerConfig } = mundo()
    ponerConfig({ cash_rounding_mode: 'nearest_half_up' })
    expect(pay(orderWith(36_810), cash({ multiple: 100, mode: 'nearest_half_down' }))).toBe(
      'rounding_mismatch',
    )
    expect(pay(orderWith(36_810), cash({ multiple: 100, mode: 'nearest_half_up' }))).toBe(
      'confirmed',
    )
  })

  it('un medio propio activo se acepta; archivado o inexistente, medio_no_habilitado', () => {
    const { orderWith, pay, nequi, ponerConfig } = mundo()
    const sodexo = newId()
    const order = orderWith(30_000)
    const conPropio = (id: string) => ({ ...nequi(5_000), method: 'other', custom_method_id: id })
    ponerConfig({ custom_methods: [{ id: sodexo, name: 'Sodexo', active: true }] })
    expect(pay(order, conPropio(sodexo))).toBe('confirmed')
    expect(pay(order, conPropio(newId()))).toBe('method_not_enabled')
    ponerConfig({ custom_methods: [{ id: sodexo, name: 'Sodexo', active: false }] })
    expect(pay(order, conPropio(sodexo))).toBe('method_not_enabled')
  })

  it('un pago sin turno sigue rechazándose antes que el medio', () => {
    const { m, orderWith, pay, nequi, ponerConfig } = mundo()
    ponerConfig({ payment_methods: ['cash'] })
    const order = orderWith(10_000)
    const withoutShift = { ...nequi(10_000), register_shift_id: newId() }
    expect(pay(order, withoutShift)).toBe('no_shift')
    expect(m.db.prepare('SELECT count(*) AS n FROM rejected_events').get()?.n).toBeGreaterThan(0)
  })

  it('una configuración dañada no deja sin servicio: toma los valores de fábrica', () => {
    const { m, orderWith, pay, nequi } = mundo()
    m.db.prepare("UPDATE restaurants SET config = '{}' WHERE id = ?").run(m.restaurantId)
    expect(pay(orderWith(10_000), nequi(10_000))).toBe('confirmed')
  })
})
