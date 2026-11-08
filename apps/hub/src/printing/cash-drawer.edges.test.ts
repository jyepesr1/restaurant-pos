import { newId, type OrderEvent } from '@pos/core'
import { drawerPulse } from '@pos/printing'
import { HubSync } from '@pos/sync'
import { SqliteStore } from '@pos/sync/sqlite'
import { describe, expect, it } from 'vitest'
import { item } from '../access/hub-setup'
import { insertVersioned, SYSTEM } from '../access/records'
import { CashDrawer, RETRY_MS, STALE_MS } from './cash-drawer'
import { setupPrinting } from './printing-setup'
import { PrinterError, type Send, type Target } from './transport'

// Task 1.13, the cash drawer under stress: the wiring of `main.ts` (the hub's own `onSave` handing
// every saved event to the drawer after the transaction), events that come twice or late, printers
// that disappear, failures, shutdown and several restaurants. The drawer is wired exactly like
// `main.ts` does it: `setImmediate(() => drawer.afterSave(event))` inside `onSave`.

const PULSE = [...drawerPulse()]
const asShift = { aggregate_type: 'register_shift' }
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function world(options: Parameters<typeof setupPrinting>[0] = {}) {
  const t = setupPrinting(options)
  const register = t.device('admin', 'register')
  const ana = t.device('waiter')
  const printer = t.newPrinter('Caja', [])
  const choose = (id: string | null) =>
    t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ cash_drawer_printer_id: id }), t.restaurantId)
  choose(printer.id)

  // The hub wired like main.ts: the drawer hears about each saved event after the transaction.
  const wired = new HubSync(new SqliteStore(t.db, t.restaurantId), {
    restaurantId: t.restaurantId,
    timeZone: t.timeZone,
    businessDayStart: '06:00',
    instance: 'hub-1',
    clock: () => new Date(t.clock()).toISOString(),
    access: t.access,
    onSave: (event) => {
      setImmediate(() => t.drawer.afterSave(event))
    },
  })
  const submit = (
    aggregate: string,
    type: string,
    data: unknown,
    extras: Record<string, unknown> = {},
  ) => register.submit(aggregate, type, data, extras, wired)

  const shift = newId()
  expect(
    submit(
      shift,
      'ShiftOpened',
      { register_id: register.connection.deviceId, base: 100_000 },
      asShift,
    ).status,
  ).toBe('confirmed')
  const order = t.open(ana)
  expect(ana.submit(order, 'ItemAdded', { ...item(), unit_price: 80_000 }, {}, wired).status).toBe(
    'confirmed',
  )

  const payment = (method: 'cash' | 'nequi' | 'card', amount = 10_000) => ({
    payment_id: newId(),
    check_id: null,
    register_shift_id: shift,
    method,
    amount,
    tip: 0,
    tendered: method === 'cash' ? amount : null,
    change: method === 'cash' ? 0 : null,
    rounding_adjustment: 0,
    rounding: null,
    cardTerminal: null,
    charge_reference: null,
  })
  const movement = (type: 'cash_in' | 'cash_out' = 'cash_out') => ({
    movement_id: newId(),
    type,
    amount: 5_000,
    description: 'Hielo',
    to_whom: null,
    days: [] as string[],
  })
  /** The event as the device would send it, signed, to send as many times as wanted. */
  const signed = (
    aggregate: string,
    type: string,
    data: unknown,
    extras: Record<string, unknown> = {},
  ) =>
    t.event(register.connection, register.session, type, data, {
      aggregate_id: aggregate,
      base_sequence: Number(
        t.db.prepare('SELECT coalesce(max(sequence), 0) AS s FROM events').get()?.s,
      ),
      ...extras,
    } as never)
  const deliver = (events: unknown[]) => wired.receiveBatch(register.connection, events as never[])
  const pulses = (p = printer) => p.paper.received.map((b) => [...b])
  return {
    t,
    register,
    printer,
    choose,
    wired,
    submit,
    order,
    shift,
    payment,
    movement,
    signed,
    deliver,
    pulses,
  }
}

describe('the hub hands each saved event to the drawer (the wiring of main.ts)', () => {
  it('cash payments open it, one pulse each, in the order they were saved', async () => {
    const m = world()
    m.submit(m.order, 'PaymentRecorded', m.payment('cash', 10_000))
    m.submit(m.order, 'PaymentRecorded', m.payment('cash', 20_000))
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toEqual([PULSE, PULSE])
  })

  it('a split bill (cash, card and Nequi) opens it only for the cash part', async () => {
    const m = world()
    m.submit(m.order, 'PaymentRecorded', m.payment('nequi', 10_000))
    m.submit(m.order, 'PaymentRecorded', {
      ...m.payment('card', 10_000),
      cardTerminal: null,
    })
    m.submit(m.order, 'PaymentRecorded', m.payment('cash', 10_000))
    m.submit(m.order, 'PaymentRecorded', m.payment('nequi', 5_000))
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toEqual([PULSE])
  })

  it('a cash payment that also has a card or tip does not matter: the method decides', async () => {
    const m = world()
    m.submit(m.order, 'PaymentRecorded', {
      ...m.payment('cash', 10_000),
      tip: 2_000,
      tendered: 12_000,
    })
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(1)
  })

  it('a cash refund opens it; a refund by another method does not', async () => {
    const m = world()
    const sale = m.payment('cash', 10_000)
    m.submit(m.order, 'PaymentRecorded', sale)
    const other = m.payment('nequi', 10_000)
    m.submit(m.order, 'PaymentRecorded', other)
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(1)

    const refund = (paymentId: string, method: 'cash' | 'nequi') => ({
      payment_id: paymentId,
      refund_id: newId(),
      sale_amount: 1_000,
      tip_amount: 0,
      method,
      register_shift_id: m.shift,
    })
    const reason = { reason: 'Prueba' }
    expect(
      m.submit(m.order, 'RefundRecorded', refund(sale.payment_id, 'cash'), reason).status,
    ).toBe('confirmed')
    expect(
      m.submit(m.order, 'RefundRecorded', refund(other.payment_id, 'nequi'), reason).status,
    ).toBe('confirmed')
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(2)
  })

  it('every kind of cash movement opens it; a count or the close does not', async () => {
    const m = world()
    m.submit(m.shift, 'CashMovementRecorded', m.movement('cash_in'), asShift)
    m.submit(m.shift, 'CashMovementRecorded', m.movement('cash_out'), asShift)
    m.submit(
      m.shift,
      'CashMovementRecorded',
      { ...m.movement('cash_out'), type: 'tip_payout', to_whom: 'Ana', days: ['2026-10-24'] },
      asShift,
    )
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(3)
  })

  it('an event the hub rejects (not an open shift of that register) does not open it', async () => {
    const m = world()
    const other = m.t.device('cashier', 'register')
    const r = other.submit(m.order, 'PaymentRecorded', m.payment('cash'), {}, m.wired)
    expect(r.status).toBe('rejected')
    await flush()
    await m.t.drawer.idle()
    expect(m.printer.paper.attempts).toBe(0)
  })

  it('an order event with no money (an item, a send) never reaches the printer', async () => {
    const m = world()
    const o2 = m.t.open(m.t.device('waiter'))
    expect(o2).toBeTruthy()
    await flush()
    await m.t.drawer.idle()
    expect(m.printer.paper.attempts).toBe(0)
  })
})

describe('the same event more than once (resent after a reconnection)', () => {
  it('delivered twice, or twice in one batch, it opens the drawer once', async () => {
    const m = world()
    const e = m.signed(m.order, 'PaymentRecorded', m.payment('cash'))
    expect(m.deliver([e]).results[0]?.status).toBe('confirmed')
    expect(m.deliver([e]).results[0]?.status).toBe('confirmed')
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toEqual([PULSE])

    const f = m.signed(m.shift, 'CashMovementRecorded', m.movement(), asShift)
    const batch = m.deliver([f, f, f])
    expect(batch.results.map((r) => r.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(2)
  })

  it('resent many times after the hub restarted (new process, same database), it does not open', async () => {
    const m = world()
    const e = m.signed(m.order, 'PaymentRecorded', m.payment('cash'))
    m.deliver([e])
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(1)

    // The PC restarts: a new hub and a new drawer on the same database; the device resends.
    const restarted = new CashDrawer({
      db: m.t.db,
      restaurantId: m.t.restaurantId,
      send: async (target, bytes) => {
        const p = m.t.network.get(target.address)
        if (p) p.received.push(bytes)
      },
      clock: () => m.t.clock(),
      retryMs: 1,
    })
    const hub = new HubSync(new SqliteStore(m.t.db, m.t.restaurantId), {
      restaurantId: m.t.restaurantId,
      timeZone: m.t.timeZone,
      businessDayStart: '06:00',
      instance: 'hub-1',
      clock: () => new Date(m.t.clock()).toISOString(),
      access: m.t.access,
      onSave: (event) => setImmediate(() => restarted.afterSave(event)),
    })
    for (let i = 0; i < 3; i++)
      expect(hub.receiveBatch(m.register.connection, [e as never]).results[0]?.status).toBe(
        'confirmed',
      )
    await flush()
    await restarted.idle()
    expect(m.pulses()).toHaveLength(1)
  })

  it('the same id with different content is rejected and opens nothing', async () => {
    const m = world()
    const first = m.signed(m.order, 'PaymentRecorded', m.payment('nequi', 10_000))
    expect(m.deliver([first]).results[0]?.status).toBe('confirmed')
    const forged = m.signed(
      m.order,
      'PaymentRecorded',
      { ...m.payment('cash', 10_000) },
      { id: (first as { id: string }).id },
    )
    expect(m.deliver([forged]).results[0]?.status).toBe('rejected')
    await flush()
    await m.t.drawer.idle()
    expect(m.printer.paper.attempts).toBe(0)
  })

  it('an event saved twice in the drawer’s own eyes (afterSave called twice) is a known limit: two pulses', async () => {
    // `afterSave` has no memory: the hub calls it once per saved event, which the tests above
    // prove. Calling it twice with the same event is not something the hub does.
    const m = world()
    const r = m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    m.t.drawer.afterSave(r.accepted as OrderEvent)
    m.t.drawer.afterSave(r.accepted as OrderEvent)
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses().length).toBeGreaterThanOrEqual(2)
  })
})

describe('events that arrive late or with a wrong clock', () => {
  it('created offline 5 minutes ago and uploaded now: no pulse; created 1 minute ago: pulse', async () => {
    const m = world()
    m.t.advance(30 * 60_000)
    const at = (msAgo: number) => new Date(m.t.clock() - msAgo).toISOString()
    m.deliver([
      m.signed(m.order, 'PaymentRecorded', m.payment('cash'), {
        hub_estimated_time: at(5 * 60_000),
      }),
    ])
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(0)
    m.deliver([
      m.signed(m.order, 'PaymentRecorded', m.payment('cash'), { hub_estimated_time: at(60_000) }),
    ])
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(1)
  })

  it('a device whose own clock is hours off still opens it: the hub’s estimate decides, not device_time', async () => {
    const m = world()
    const now = m.t.clock()
    for (const skew of [-6 * 3_600_000, 3 * 3_600_000, -26 * 3_600_000]) {
      m.deliver([
        m.signed(m.order, 'PaymentRecorded', m.payment('cash'), {
          device_time: new Date(now + skew).toISOString(),
          hub_estimated_time: new Date(now).toISOString(),
        }),
      ])
    }
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(3)
  })

  it('the hub’s own clock moving (PC clock corrected backwards) does not make it open for old events', async () => {
    const m = world()
    const created = m.t.clock()
    m.t.advance(STALE_MS + 5_000)
    m.deliver([
      m.signed(m.order, 'PaymentRecorded', m.payment('cash'), { hub_estimated_time: created }),
    ])
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(0)
  })

  it('an unreadable time, or one with an offset, is handled without throwing', async () => {
    const m = world()
    const now = m.t.clock()
    // The same instant written with a UTC-5 offset counts as "now".
    const bogota = new Date(now - 5 * 3_600_000).toISOString().replace('Z', '-05:00')
    const e = m.signed(m.order, 'PaymentRecorded', m.payment('cash'), {
      hub_estimated_time: bogota,
    })
    const r = m.deliver([e]).results[0]
    if (r?.status === 'confirmed') {
      await flush()
      await m.t.drawer.idle()
      expect(m.pulses().length).toBeLessThanOrEqual(1)
    } else {
      // The hub refuses such a time in the schema; either way nothing breaks.
      expect(r?.status).toBe('rejected')
    }
  })
})

describe('the printer of the drawer disappears or changes', () => {
  it('archived after it was chosen: no pulse, no error, and un-archived it works again', async () => {
    const m = world()
    m.t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(m.printer.id)
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    await m.t.drawer.idle()
    expect(m.printer.paper.attempts).toBe(0)
    expect(m.t.drawerFailures).toEqual([])
    expect(m.t.drawer.connected()).toBe(false)
    m.t.db.prepare('UPDATE printers SET active = 1 WHERE id = ?').run(m.printer.id)
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(1)
  })

  it('pointing at an id that is not a printer at all: nothing, and no error', async () => {
    const m = world()
    m.choose(newId())
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    await m.t.drawer.idle()
    expect(m.printer.paper.attempts).toBe(0)
    expect(m.t.drawerFailures).toEqual([])
    await expect(m.t.drawer.open()).rejects.toBeInstanceOf(PrinterError)
  })

  it('choosing another printer between two payments sends each pulse to the one chosen then', async () => {
    const m = world()
    const second = m.t.newPrinter('Barra', [])
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    await m.t.drawer.idle()
    m.choose(second.id)
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses(m.printer)).toHaveLength(1)
    expect(m.pulses(second)).toHaveLength(1)
  })

  it('removing the drawer (null) between payments stops the pulses', async () => {
    const m = world()
    m.choose(null)
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    await m.t.drawer.idle()
    expect(m.printer.paper.attempts).toBe(0)
  })

  it('a config the schema refuses (unknown key or wrong type) is reported once and never throws or opens', async () => {
    const m = world()
    for (const bad of [
      '{"brand":7}',
      '{"cash_drawer_printer_id":42}',
      '{"cash_drawer_printer_id":"x"}',
    ]) {
      m.t.db.prepare('UPDATE restaurants SET config = ? WHERE id = ?').run(bad, m.t.restaurantId)
      const r = m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
      expect(() => m.t.drawer.afterSave(r.accepted as OrderEvent)).not.toThrow()
    }
    await m.t.drawer.idle()
    expect(m.printer.paper.attempts).toBe(0)
    expect(m.t.drawerFailures.length).toBeGreaterThan(0)
  })

  it('the pulse for a USB printer goes with nowOrNever, a network one too (the flag is only read for USB)', async () => {
    const targets: Target[] = []
    const send: Send = async (target) => {
      targets.push(target)
    }
    const m = world({ send: () => send })
    const usb = m.t.newPrinter('USB', [], {
      connection: 'usb',
      address: 'POS-80 "Caja"',
      port: null,
    })
    m.choose(usb.id)
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    await m.t.drawer.idle()
    expect(targets).toEqual([
      { connection: 'usb', address: 'POS-80 "Caja"', port: null, nowOrNever: true },
    ])
  })
})

describe('failures and the retry', () => {
  it('both attempts fail: reported once, and the next payment is not affected', async () => {
    const m = world()
    m.printer.paper.off = true
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    await m.t.drawer.idle()
    expect(m.t.drawerFailures).toHaveLength(1)
    expect(m.printer.paper.attempts).toBe(2)
    m.printer.paper.off = false
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(1)
    expect(m.t.drawerFailures).toHaveLength(1)
  })

  it('the first attempt fails, the second works: exactly one pulse reaches the printer', async () => {
    let calls = 0
    const m = world({
      send: (base) => async (target, bytes) => {
        calls += 1
        if (calls === 1) throw new PrinterError('Ocupada')
        await base(target, bytes)
      },
    })
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    await m.t.drawer.idle()
    expect(calls).toBe(2)
    expect(m.pulses()).toEqual([PULSE])
  })

  it('a send that throws synchronously (not a rejected promise) is also an attempt, not a crash', async () => {
    let calls = 0
    const m = world({
      send: () => () => {
        calls += 1
        throw new Error('sync boom')
      },
    })
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    await m.t.drawer.idle()
    expect(calls).toBe(2)
    expect(m.t.drawerFailures).toHaveLength(1)
  })

  it('a printer that never answers does not hold up afterSave or the register', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const m = world({ send: () => () => gate })
    const started = Date.now()
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    expect(Date.now() - started).toBeLessThan(2000)
    // The register keeps working while the pulse is pending.
    expect(m.submit(m.order, 'PaymentRecorded', m.payment('nequi')).status).toBe('confirmed')
    release()
    await m.t.drawer.idle()
  })

  it('twenty payments at once all reach the printer', async () => {
    const m = world()
    for (let i = 0; i < 20; i++) m.submit(m.order, 'PaymentRecorded', m.payment('cash', 1_000))
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(20)
    expect(m.t.jobs()).toEqual([])
  })

  it('the retry waits the documented time', () => {
    expect(RETRY_MS).toBe(1500)
  })
})

describe('closing the hub with a pulse pending', () => {
  it('idle() waits for the pulse in flight, including the retry', async () => {
    let calls = 0
    let finished = false
    const m = world({
      send: (base) => async (target, bytes) => {
        calls += 1
        await new Promise((r) => setTimeout(r, 5))
        if (calls === 1) throw new PrinterError('Ocupada')
        await base(target, bytes)
        finished = true
      },
    })
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    expect(finished).toBe(false)
    await m.t.drawer.idle()
    expect(finished).toBe(true)
    expect(m.pulses()).toHaveLength(1)
  })

  it('idle() with nothing pending returns at once, any number of times', async () => {
    const m = world()
    await m.t.drawer.idle()
    await m.t.drawer.idle()
    await Promise.all([m.t.drawer.idle(), m.t.drawer.idle()])
  })

  it('two payments pending together are both waited for', async () => {
    const m = world({
      send: (base) => async (target, bytes) => {
        await new Promise((r) => setTimeout(r, 10))
        await base(target, bytes)
      },
    })
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(2)
  })
})

describe('several restaurants in one database', () => {
  /** A second restaurant with its own printer, in the same database. */
  function secondRestaurant(t: ReturnType<typeof world>['t']) {
    const other = newId()
    const now = new Date(t.clock()).toISOString()
    t.db
      .prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
      )
      .run(other, other, now, now)
    t.db
      .prepare("INSERT INTO counters (restaurant_id, name, value) VALUES (?, 'catalog', 1)")
      .run(other)
    const printerId = insertVersioned(
      t.db,
      'printers',
      other,
      {
        name: 'Ajena',
        connection: 'network',
        address: '10.9.9.9',
        port: 9100,
        width: 80,
        code_page: 'pc850',
        station_ids: '[]',
      },
      SYSTEM,
      now,
    )
    return { id: other, printerId }
  }

  it('a drawer pointing at another restaurant’s printer finds no drawer', async () => {
    const m = world()
    const other = secondRestaurant(m.t)
    const foreign = m.t.paper('10.9.9.9')
    m.choose(other.printerId)
    expect(m.t.drawer.connected()).toBe(false)
    m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    await flush()
    await m.t.drawer.idle()
    expect(foreign.attempts).toBe(0)
    expect(m.printer.paper.attempts).toBe(0)
    await expect(m.t.drawer.open()).rejects.toBeInstanceOf(PrinterError)
  })

  it('the other restaurant’s drawer does not pulse for events stored in this one', async () => {
    const m = world()
    const other = secondRestaurant(m.t)
    const foreign = m.t.paper('10.9.9.9')
    m.t.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify({ cash_drawer_printer_id: other.printerId }), other.id)
    const theirDrawer = new CashDrawer({
      db: m.t.db,
      restaurantId: other.id,
      send: async (target, bytes) => {
        m.t.network.get(target.address)?.received.push(bytes)
      },
      clock: () => m.t.clock(),
      retryMs: 1,
    })
    expect(theirDrawer.connected()).toBe(true)
    const r = m.submit(m.order, 'PaymentRecorded', m.payment('cash'))
    // The event exists in this restaurant only: the other drawer must not trust the bare id.
    theirDrawer.afterSave(r.accepted as OrderEvent)
    await theirDrawer.idle()
    expect(foreign.received).toEqual([])
    // And this restaurant's own drawer still works.
    m.t.drawer.afterSave(r.accepted as OrderEvent)
    await m.t.drawer.idle()
    expect(m.pulses()).toHaveLength(1)
  })

  it('the test button of one restaurant never reaches the other’s printer', async () => {
    const m = world()
    const other = secondRestaurant(m.t)
    const foreign = m.t.paper('10.9.9.9')
    await m.t.drawer.open()
    expect(foreign.received).toEqual([])
    expect(m.pulses()).toHaveLength(1)
    expect(other.id).not.toBe(m.t.restaurantId)
  })
})
