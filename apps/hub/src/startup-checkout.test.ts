import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@pos/core'
import type { HubMessage } from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { item, OPEN_ORDER } from './access/hub-setup'
import { insertVersioned, SYSTEM } from './access/records'
import { setupAccess } from './access/setup'
import { prepareSync } from './startup'

// `prepareSync` (what runs on the real hub): the checkout rules are read from the database on
// every payment, so whatever the admin changes while the hub is running applies from the next
// payment on: payment methods, active card terminals and the cash rounding rule.

const folders: string[] = []
afterEach(() => {
  for (const c of folders.splice(0)) rmSync(c, { recursive: true, force: true })
})

function world() {
  const m = setupAccess()
  const dir = mkdtempSync(join(tmpdir(), 'hub-checkout-'))
  folders.push(dir)
  const floor = prepareSync(m.db, dir, m.restaurantId, m.access)
  const register = m.pair('register')
  const session = m.signIn(register.connection, 'cashier')
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
  /** Sends events to the real hub and returns how each one fared. */
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
    if (latest?.type !== 'result') throw new Error('No result')
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
        { type: 'OrderOpened', aggregate: order, data: OPEN_ORDER },
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
      SYSTEM,
      m.clock(),
    )
  const putConfig = (config: object) =>
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
  const card = (amount: number, cardTerminalId: string, approval_code: string | null = null) => ({
    ...base,
    payment_id: newId(),
    method: 'card',
    amount,
    tendered: null,
    change: null,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: {
      card_terminal_id: cardTerminalId,
      franchise: null,
      last4: null,
      approval_code,
      receipt: null,
    },
  })
  /** Cash that pays off the $36,810 balance: $36,800 is charged (−10) with the given rule. */
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
  return { m, submit, orderWith, cardTerminal, putConfig, nequi, card, cash, pay, shift }
}

describe('checkout rules of the real hub', () => {
  it('by default accepts Nequi and cash with the restaurant rule (100, half down)', () => {
    const { orderWith, pay, nequi, cash } = world()
    expect(pay(orderWith(10_000), nequi(10_000))).toBe('confirmed')
    expect(pay(orderWith(36_810), cash({ multiple: 100, mode: 'nearest_half_down' }))).toBe(
      'confirmed',
    )
  })

  it('the admin removes Nequi while the hub is running: the next payment no longer passes', () => {
    const { orderWith, pay, nequi, putConfig } = world()
    const order = orderWith(20_000)
    expect(pay(order, nequi(5_000))).toBe('confirmed')
    putConfig({ payment_methods: ['cash', 'card'] })
    expect(pay(order, nequi(5_000))).toBe('method_not_enabled')
    putConfig({ payment_methods: ['cash', 'card', 'nequi'] })
    expect(pay(order, nequi(5_000))).toBe('confirmed')
  })

  it('the voucher is accepted only if the restaurant includes it', () => {
    const { orderWith, pay, nequi, putConfig } = world()
    const order = orderWith(20_000)
    const voucher = { ...nequi(5_000), method: 'voucher' }
    expect(pay(order, voucher)).toBe('method_not_enabled')
    putConfig({ payment_methods: ['cash', 'voucher'] })
    expect(pay(order, voucher)).toBe('confirmed')
  })

  it('card with an active card terminal of the restaurant, without an approval number: accepted', () => {
    const { orderWith, pay, card, cardTerminal } = world()
    const bold = cardTerminal()
    expect(pay(orderWith(10_000), card(10_000, bold))).toBe('confirmed')
    expect(pay(orderWith(10_000), card(10_000, bold, '123456'))).toBe('confirmed')
  })

  it('card with a card terminal that does not exist: unknown_card_terminal', () => {
    const { orderWith, pay, card, cardTerminal } = world()
    cardTerminal()
    expect(pay(orderWith(10_000), card(10_000, newId()))).toBe('unknown_card_terminal')
  })

  it('card with no card terminal registered: unknown_card_terminal', () => {
    const { orderWith, pay, card } = world()
    expect(pay(orderWith(10_000), card(10_000, newId()))).toBe('unknown_card_terminal')
  })

  it('an archived card terminal no longer works, and works again once reactivated', () => {
    const { m, orderWith, pay, card, cardTerminal } = world()
    const bold = cardTerminal()
    const order = orderWith(20_000)
    m.db.prepare('UPDATE card_terminals SET active = 0 WHERE id = ?').run(bold)
    expect(pay(order, card(5_000, bold))).toBe('unknown_card_terminal')
    m.db.prepare('UPDATE card_terminals SET active = 1 WHERE id = ?').run(bold)
    expect(pay(order, card(5_000, bold))).toBe('confirmed')
  })

  it("another restaurant's card terminal does not work in this one", () => {
    const { m, orderWith, pay, card } = world()
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

  it('the rounding rule comes from the configuration: another multiple, rounding_mismatch', () => {
    const { orderWith, pay, cash } = world()
    expect(pay(orderWith(36_810), cash({ multiple: 50, mode: 'nearest_half_down' }))).toBe(
      'rounding_mismatch',
    )
    expect(pay(orderWith(36_810), cash({ multiple: 100, mode: 'up' }))).toBe('rounding_mismatch')
  })

  it('if the restaurant changes the multiple to 50, the 100 rule stops being valid and the 50 one is valid', () => {
    const { orderWith, pay, cash, putConfig } = world()
    putConfig({ cash_rounding: 50 })
    expect(pay(orderWith(36_810), cash({ multiple: 100, mode: 'nearest_half_down' }))).toBe(
      'rounding_mismatch',
    )
    // With multiple 50, $36,810 is still charged as $36,800 (−10): the new rule is accepted.
    expect(pay(orderWith(36_810), cash({ multiple: 50, mode: 'nearest_half_down' }))).toBe(
      'confirmed',
    )
  })

  it('the same if the cash mode changes', () => {
    const { orderWith, pay, cash, putConfig } = world()
    putConfig({ cash_rounding_mode: 'nearest_half_up' })
    expect(pay(orderWith(36_810), cash({ multiple: 100, mode: 'nearest_half_down' }))).toBe(
      'rounding_mismatch',
    )
    expect(pay(orderWith(36_810), cash({ multiple: 100, mode: 'nearest_half_up' }))).toBe(
      'confirmed',
    )
  })

  it('an active custom method is accepted; archived or nonexistent, method_not_enabled', () => {
    const { orderWith, pay, nequi, putConfig } = world()
    const sodexo = newId()
    const order = orderWith(30_000)
    const withCustom = (id: string) => ({ ...nequi(5_000), method: 'other', custom_method_id: id })
    putConfig({ custom_methods: [{ id: sodexo, name: 'Sodexo', active: true }] })
    expect(pay(order, withCustom(sodexo))).toBe('confirmed')
    expect(pay(order, withCustom(newId()))).toBe('method_not_enabled')
    putConfig({ custom_methods: [{ id: sodexo, name: 'Sodexo', active: false }] })
    expect(pay(order, withCustom(sodexo))).toBe('method_not_enabled')
  })

  it('a payment without a shift is still rejected before the payment method', () => {
    const { m, orderWith, pay, nequi, putConfig } = world()
    putConfig({ payment_methods: ['cash'] })
    const order = orderWith(10_000)
    const withoutShift = { ...nequi(10_000), register_shift_id: newId() }
    expect(pay(order, withoutShift)).toBe('no_shift')
    expect(m.db.prepare('SELECT count(*) AS n FROM rejected_events').get()?.n).toBeGreaterThan(0)
  })

  it('a corrupted configuration does not take the service down: it uses the defaults', () => {
    const { m, orderWith, pay, nequi } = world()
    m.db.prepare("UPDATE restaurants SET config = '{}' WHERE id = ?").run(m.restaurantId)
    expect(pay(orderWith(10_000), nequi(10_000))).toBe('confirmed')
  })
})
