import 'fake-indexeddb/auto'
import { newId, signEvent } from '@pos/core'
import {
  type AccessControl,
  type Channel,
  type DeviceMessage,
  FloorSync,
  type Handlers,
  HubSync,
  MemoryStore,
} from '@pos/sync'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseDispositivo } from './almacen'
import {
  cuadreDeCaja,
  pagoEnEfectivo,
  type ReglasCobro,
  resumenTurno,
  turnoDeCaja,
} from './cuentas'
import { type Device, Sala, type Session } from './motor'
import { catalogoDePrueba, datosItem } from './pruebas'

// De punta a punta, en memoria (tarea 1.7): la caja (motor + IndexedDB) habla con un hub de memoria
// con las reglas de cobro. Abrir turno → cobro en efectivo → entrada → pago de propinas → arqueo →
// cierre confirmado → turno nuevo; y los cierres que el hub rechaza, dichos en palabras. Los
// temporizadores son falsos: nada espera de verdad.

const T0 = new Date('2026-10-26T15:00:00.000Z')
const RULES: ReglasCobro = {
  paymentMethods: ['cash', 'card', 'nequi'],
  suggestedTip: 1000,
  roundingMode: 'half_up',
  cashRounding: 100,
  cashRoundingMode: 'nearest_half_down',
  printsPreBill: false,
}
const CARD_TERMINAL = newId()

const accesoConFirma: AccessControl = {
  verify: (_c, event) =>
    event.session_id && event.signature === signEvent(event, `secreto-${event.session_id}`)
      ? { ok: true, authorizedById: null, authorizationId: null }
      : { ok: false, reason: 'invalid_signature' },
  recordUse: () => {},
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: T0,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  )
})

async function asentar(vueltas = 4) {
  for (let i = 0; i < vueltas; i++) await new Promise((r) => setImmediate(r))
}
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    await vi.advanceTimersByTimeAsync(Math.min(100, ms - t))
    await asentar(3)
  }
}
async function until(condicion: () => Promise<boolean> | boolean, maxMs = 20_000) {
  for (let t = 0; t <= maxMs; t += 100) {
    if (await condicion()) return
    await advance(100)
  }
  throw new Error('No se cumplió en el tiempo simulado')
}
/** Deja correr el reloj simulado hasta que la promesa termine (bien o mal). */
async function resolve<T>(
  promesa: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  let r: { ok: true; value: T } | { ok: false; error: Error } | null = null
  promesa.then(
    (value) => {
      r = { ok: true, value }
    },
    (error) => {
      r = { ok: false, error }
    },
  )
  await until(() => r !== null)
  return r as never
}

function setupHub() {
  const tokens = new Map<string, Device>()
  const hub = new HubSync(new MemoryStore(), {
    restaurantId: newId(),
    timeZone: 'America/Bogota',
    businessDayStart: '06:00',
    instance: 'hub-test',
    clock: () => new Date(Date.now()).toISOString(),
    access: accesoConFirma,
    checkoutRules: () => ({
      multiple: 100,
      mode: 'nearest_half_down',
      methods: RULES.paymentMethods,
      cardTerminals: [CARD_TERMINAL],
      varianceThreshold: 1000,
    }),
  })
  const salaHub = new FloorSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { deviceId: e.deviceId, type: e.type, revokedAt: null } : null
  })
  const h = {
    hub,
    tokens,
    received: [] as DeviceMessage[],
    open(m: Handlers): Channel {
      let link: ReturnType<FloorSync['connect']> | null = null
      let closed = false
      setTimeout(() => {
        if (closed) return
        link = salaHub.connect((msg) => {
          const copy = JSON.parse(JSON.stringify(msg))
          setTimeout(() => {
            if (!closed) m.onMessage(copy)
          })
        })
        m.onOpen()
      })
      return {
        send: (msg) => {
          if (!link || closed) return
          const copy = JSON.parse(JSON.stringify(msg)) as DeviceMessage
          h.received.push(copy)
          link.receive(copy)
        },
        close: () => {
          closed = true
          link?.close()
          link = null
        },
      }
    },
  }
  return h
}
type Hub = ReturnType<typeof setupHub>

const salas: Sala[] = []
const bases: BaseDispositivo[] = []
afterEach(async () => {
  for (const s of salas.splice(0)) s.simularSinConexion(true)
  await asentar(10)
  vi.useRealTimers()
  await asentar(10)
  for (const b of bases.splice(0)) await b.delete()
  vi.unstubAllGlobals()
})

async function register(h: Hub, name = 'Caja 1') {
  const db = new BaseDispositivo(`closeout-${newId()}`)
  bases.push(db)
  const e: Device = { deviceId: newId(), token: newId(), name, type: 'register' }
  h.tokens.set(e.token, e)
  const sessionId = newId()
  const session: Session = {
    sessionId,
    secret: `secreto-${sessionId}`,
    user: { id: newId(), name: 'Carlos', role: 'Cajero' },
    permissions: [
      'take_order',
      'record_payment',
      'close_table',
      'split_check',
      'open_register_shift',
      'cash_movement',
      'close_register_shift',
    ],
    lastUsed: Date.now(),
  }
  await db.saveSetting('device', e)
  await db.saveSetting('session', session)
  await db.saveSetting('catalog', catalogoDePrueba())
  const floor = new Sala({ db, open: (m) => h.open(m) })
  salas.push(floor)
  await floor.load()
  await until(() => floor.instantanea().connection === 'connected')
  return { floor, e }
}

const locals = async (s: Sala) => (await s.sync?.locals()) ?? []
const sinPendientes = (s: Sala) => s.instantanea().pendingList === 0

/** Un pedido de dos productos que suma $100.050, ya en el hub. */
async function pedidoDeCien(floor: Sala) {
  const order = newId()
  await floor.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
  await floor.record('ItemAdded', order, datosItem({ unit_price: 60_050, name: 'Tagliata' }))
  await floor.record('ItemAdded', order, datosItem({ unit_price: 40_000, name: 'Pizza' }))
  await until(() => sinPendientes(floor))
  return order
}

const datosPago = (
  shift: string,
  checkId: string | null,
  method: 'cash' | 'card' | 'nequi',
  balance: number,
  tip: number,
  tendered = 0,
) => {
  const c = pagoEnEfectivo({ balance, amount: balance, tip, tendered }, RULES)
  const served = tendered || c.aEntregar
  const f = pagoEnEfectivo({ balance, amount: balance, tip, tendered: served }, RULES)
  return {
    payment_id: newId(),
    check_id: checkId,
    register_shift_id: shift,
    method,
    amount: balance,
    tip,
    tendered: method === 'cash' ? served : null,
    change: method === 'cash' ? f.change : null,
    rounding_adjustment: method === 'cash' ? f.adjustment : 0,
    rounding: method === 'cash' ? f.rounding : null,
    cardTerminal:
      method === 'card'
        ? {
            card_terminal_id: CARD_TERMINAL,
            franchise: null,
            last4: null,
            approval_code: null,
            receipt: null,
            card_type: 'credit' as const,
          }
        : null,
    charge_reference: null,
  }
}

const HOY = '2026-10-26'

/** Un cobro en efectivo del pedido de $100.050: se cobran 100.000 (−50) y 5.000 de propina. */
const cobroEfectivo = (shift: string) => datosPago(shift, null, 'cash', 100_050, 5_000, 105_000)

const tallyOf = (counted: number) =>
  [
    { value: 100_000, quantity: Math.floor(counted / 100_000) },
    { value: 50, quantity: (counted % 100_000) / 50 },
  ].filter((c) => c.quantity > 0)

async function count(floor: Sala, shift: string, counted: number) {
  const cashCount = newId()
  const r = await resolve(
    floor.registrarConfirmado('CashCountRecorded', shift, {
      cash_count_id: cashCount,
      tally: tallyOf(counted),
      counted_cash: counted,
    }),
  )
  return { cashCount, r }
}

const closeData = (
  cashCount: string,
  expected: number,
  counted: number,
  justification: string | null = null,
) => ({
  cash_count_id: cashCount,
  expected_cash: expected,
  counted_cash: counted,
  variance: counted - expected,
  justification,
})

const message = (r: { ok: boolean }) => (r as unknown as { error: Error }).error.message

describe('de punta a punta: abrir turno → cobro → entrada → propinas → arqueo → cierre → turno nuevo', () => {
  it('todo se confirma, el turno se cierra con diferencia 0 y la caja abre otro', async () => {
    const h = setupHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(200_000)
    await until(() => sinPendientes(floor))

    const order = await pedidoDeCien(floor)
    const payment = cobroEfectivo(shift)
    expect(payment).toMatchObject({ rounding_adjustment: -50, change: 0, tendered: 105_000 })
    expect((await resolve(floor.registrarConfirmado('PaymentRecorded', order, payment))).ok).toBe(
      true,
    )
    expect((await resolve(floor.registrarConfirmado('OrderClosed', order, {}))).ok).toBe(true)

    const entry = await resolve(
      floor.registrarConfirmado('CashMovementRecorded', shift, {
        movement_id: newId(),
        type: 'entry',
        amount: 20_000,
        description: 'Cambio para el turno',
        to_whom: null,
        days: [],
      }),
    )
    expect(entry.ok).toBe(true)
    const tips = await resolve(
      floor.registrarConfirmado('CashMovementRecorded', shift, {
        movement_id: newId(),
        type: 'tip_payout',
        amount: 5_000,
        description: 'Propinas de hoy',
        to_whom: 'Equipo de sala',
        days: [HOY],
      }),
    )
    expect(tips.ok).toBe(true)

    // 200.000 + (100.000 + 5.000) + 20.000 − 5.000 = 320.000, en la caja y en el hub.
    const before = cuadreDeCaja(await locals(floor), shift)
    expect(before?.cash).toMatchObject({
      charged: 105_000,
      entries: 20_000,
      tipPayouts: 5_000,
      expected: 320_000,
    })
    expect(h.hub.reconciliation(shift)).toEqual(before)

    const { cashCount, r: tally } = await count(floor, shift, 320_000)
    expect(tally.ok).toBe(true)
    const closeout = await resolve(
      floor.registrarConfirmado('ShiftClosed', shift, closeData(cashCount, 320_000, 320_000)),
    )
    expect(closeout.ok).toBe(true)
    await until(() => sinPendientes(floor))

    // Cerrado en el hub y en la caja; lo guardado aquí está confirmado.
    expect(h.hub.openShift(e.deviceId)).toBeNull()
    const savedList = await locals(floor)
    expect(savedList.every((l) => l.status === 'confirmed')).toBe(true)
    expect(turnoDeCaja(savedList, e.deviceId)).toBeNull()
    expect(cuadreDeCaja(savedList, shift)?.closed).toMatchObject({
      expected: 320_000,
      counted: 320_000,
      variance: 0,
    })
    expect(resumenTurno(savedList, shift).byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 100_000, tip: 5_000, payments: 1 },
    ])

    // Un pago más a ese turno ya no entra, y se dice en palabras.
    const anotherOrder = await pedidoDeCien(floor)
    const late = await resolve(
      floor.registrarConfirmado(
        'PaymentRecorded',
        anotherOrder,
        datosPago(shift, null, 'nequi', 100_050, 0),
      ),
    )
    expect(message(late)).toBe('La caja no tiene turno abierto: ábrela en «Caja».')

    // El turno nuevo empieza de cero.
    const fresh = await floor.openShift(50_000)
    await until(() => sinPendientes(floor))
    expect(h.hub.openShift(e.deviceId)).toMatchObject({ id: fresh, base: 50_000 })
    const after = await locals(floor)
    expect(turnoDeCaja(after, e.deviceId)).toMatchObject({ id: fresh, base: 50_000 })
    expect(cuadreDeCaja(after, fresh)).toMatchObject({
      cash: { charged: 0, entries: 0, expected: 50_000 },
      byMethod: [],
      cashCounts: [],
      closed: null,
    })
  })

  it('un faltante de $1.000 o más sin justificación lo rechaza el hub y con ella se cierra', async () => {
    const h = setupHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(100_000)
    const { cashCount } = await count(floor, shift, 98_000)
    const without = await resolve(
      floor.registrarConfirmado('ShiftClosed', shift, closeData(cashCount, 100_000, 98_000)),
    )
    expect(message(without)).toBe('Escribe por qué no cuadra la caja.')
    // El turno sigue abierto aquí y en el hub, y el cierre rechazado queda a la vista.
    expect(h.hub.openShift(e.deviceId)).not.toBeNull()
    const savedList = await locals(floor)
    expect(turnoDeCaja(savedList, e.deviceId)?.id).toBe(shift)
    expect(savedList.filter((l) => l.status === 'rejected').map((l) => l.reason)).toEqual([
      'missing_justification',
    ])
    const withIt = await resolve(
      floor.registrarConfirmado(
        'ShiftClosed',
        shift,
        closeData(cashCount, 100_000, 98_000, 'Se pagó un domicilio'),
      ),
    )
    expect(withIt.ok).toBe(true)
    expect(turnoDeCaja(await locals(floor), e.deviceId)).toBeNull()
  })

  it('un faltante por debajo del umbral ($999) se cierra sin justificación', async () => {
    const h = setupHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(100_000)
    const { cashCount } = await count(floor, shift, 99_050)
    const r = await resolve(
      floor.registrarConfirmado('ShiftClosed', shift, closeData(cashCount, 100_000, 99_050)),
    )
    expect(r.ok).toBe(true)
    expect(h.hub.openShift(e.deviceId)).toBeNull()
  })
})

describe('el cierre rechazado, con el motivo en palabras', () => {
  /** Turno con un cobro en efectivo (esperado 305.000: base 200.000 + 105.000) y un conteo. */
  async function ready() {
    const h = setupHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(200_000)
    const order = await pedidoDeCien(floor)
    await resolve(floor.registrarConfirmado('PaymentRecorded', order, cobroEfectivo(shift)))
    const { cashCount } = await count(floor, shift, 305_000)
    return { h, floor, e, shift, cashCount }
  }

  it('con un esperado viejo (sin la propina): esperado_distinto', async () => {
    const t = await ready()
    const r = await resolve(
      t.floor.registrarConfirmado(
        'ShiftClosed',
        t.shift,
        closeData(t.cashCount, 300_000, 305_000, 'x'),
      ),
    )
    expect(message(r)).toBe(
      'La caja registró algo que este equipo aún no tenía: espera un momento y vuelve a contar.',
    )
    expect(t.h.hub.openShift(t.e.deviceId)).not.toBeNull()
    expect(turnoDeCaja(await locals(t.floor), t.e.deviceId)?.id).toBe(t.shift)
  })

  it('con un conteo que no existe: arqueo_inexistente', async () => {
    const t = await ready()
    const r = await resolve(
      t.floor.registrarConfirmado('ShiftClosed', t.shift, closeData(newId(), 305_000, 305_000)),
    )
    expect(message(r)).toBe('La caja no tiene ese conteo: vuelve a contar.')
  })

  it('con un contado distinto del conteo: contado_distinto', async () => {
    const t = await ready()
    const r = await resolve(
      t.floor.registrarConfirmado(
        'ShiftClosed',
        t.shift,
        closeData(t.cashCount, 305_000, 300_000, 'x'),
      ),
    )
    expect(message(r)).toBe('Lo contado no coincide con el conteo guardado: vuelve a contar.')
  })

  it('con un conteo que no es el último: arqueo_no_es_el_ultimo', async () => {
    const t = await ready()
    await count(t.floor, t.shift, 305_000)
    const r = await resolve(
      t.floor.registrarConfirmado('ShiftClosed', t.shift, closeData(t.cashCount, 305_000, 305_000)),
    )
    expect(message(r)).toBe('La caja se cierra con el último conteo: vuelve a contar.')
  })

  it('con dinero movido después del conteo: arqueo_desactualizado', async () => {
    const t = await ready()
    await resolve(
      t.floor.registrarConfirmado('CashMovementRecorded', t.shift, {
        movement_id: newId(),
        type: 'output',
        amount: 5_000,
        description: 'Hielo',
        to_whom: null,
        days: [],
      }),
    )
    const r = await resolve(
      t.floor.registrarConfirmado(
        'ShiftClosed',
        t.shift,
        closeData(t.cashCount, 300_000, 305_000, 'x'),
      ),
    )
    expect(message(r)).toBe('Hubo pagos o movimientos después del conteo: vuelve a contar.')
    // Volviendo a contar, cierra.
    const fresh = await count(t.floor, t.shift, 300_000)
    const ok = await resolve(
      t.floor.registrarConfirmado(
        'ShiftClosed',
        t.shift,
        closeData(fresh.cashCount, 300_000, 300_000),
      ),
    )
    expect(ok.ok).toBe(true)
  })

  it('un movimiento o un conteo sin turno abierto: sin_turno', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const shift = newId()
    const m = await resolve(
      floor.registrarConfirmado('CashMovementRecorded', shift, {
        movement_id: newId(),
        type: 'entry',
        amount: 1_000,
        description: 'x',
        to_whom: null,
        days: [],
      }),
    )
    expect(message(m)).toBe('La caja no tiene turno abierto: ábrela en «Caja».')
    expect(message((await count(floor, shift, 1_000)).r)).toBe(
      'La caja no tiene turno abierto: ábrela en «Caja».',
    )
  })

  it('el movimiento rechazado desaparece del cuadre de la caja', async () => {
    const t = await ready()
    const another = await register(t.h, 'Caja 2')
    // La otra caja intenta mover efectivo en el turno de esta.
    const r = await resolve(
      another.floor.registrarConfirmado('CashMovementRecorded', t.shift, {
        movement_id: newId(),
        type: 'entry',
        amount: 1_000,
        description: 'x',
        to_whom: null,
        days: [],
      }),
    )
    expect(message(r)).toBe('Ese turno es de otra caja: cobra desde la caja donde se abrió.')
    expect(t.h.hub.reconciliation(t.shift)?.cash.entries).toBe(0)
  })
})

describe('sin conexión', () => {
  it('el cierre queda pendiente: el turno sigue abierto aquí hasta que el hub lo acepta', async () => {
    const h = setupHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(10_000)
    await until(() => sinPendientes(floor))
    const { cashCount } = await count(floor, shift, 10_000)

    floor.simularSinConexion(true)
    const r = await resolve(
      floor.registrarConfirmado('ShiftClosed', shift, closeData(cashCount, 10_000, 10_000)),
    )
    expect(message(r)).toMatch(/Quedó pendiente/)
    const pending = await locals(floor)
    expect(pending.at(-1)).toMatchObject({ status: 'pending' })
    expect(turnoDeCaja(pending, e.deviceId)?.id).toBe(shift)
    expect(h.hub.openShift(e.deviceId)).not.toBeNull()

    floor.simularSinConexion(false)
    await until(() => sinPendientes(floor))
    expect(h.hub.openShift(e.deviceId)).toBeNull()
    expect(turnoDeCaja(await locals(floor), e.deviceId)).toBeNull()
    // Llegó una sola vez.
    const closings = (await locals(floor)).filter((l) => l.event.type === 'ShiftClosed')
    expect(closings).toHaveLength(1)
  })

  it('un movimiento hecho sin conexión suma al cuadre local al guardarse y se confirma al volver', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const shift = await floor.openShift(10_000)
    await until(() => sinPendientes(floor))
    floor.simularSinConexion(true)
    await floor.record('CashMovementRecorded', shift, {
      movement_id: newId(),
      type: 'output',
      amount: 3_000,
      description: 'Taxi',
      to_whom: null,
      days: [],
    })
    expect(cuadreDeCaja(await locals(floor), shift)?.cash.expected).toBe(7_000)
    expect(h.hub.reconciliation(shift)?.cash.expected).toBe(10_000)
    floor.simularSinConexion(false)
    await until(() => sinPendientes(floor))
    expect(h.hub.reconciliation(shift)?.cash.expected).toBe(7_000)
  })
})
