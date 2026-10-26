import 'fake-indexeddb/auto'
import { newId, orderTotals, signEvent } from '@pos/core'
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
  enPartesIguales,
  pagoEnEfectivo,
  type ReglasCobro,
  resumenTurno,
  turnoDeCaja,
} from './cuentas'
import { type Device, Sala, type Session } from './motor'
import { pedidosAbiertos } from './proyeccion'
import { catalogoDePrueba, datosItem } from './pruebas'

// De punta a punta, en memoria: la caja (motor + IndexedDB) habla con un hub de memoria con las
// reglas de cobro. Abrir turno → dividir → dos pagos (efectivo y tarjeta) → cerrar el pedido. Los
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
  const db = new BaseDispositivo(`checkout-${newId()}`)
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
const stateOf = async (s: Sala, id: string) =>
  pedidosAbiertos(await locals(s)).find((p) => p.status.id === id)?.status ?? null
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

describe('de punta a punta: abrir turno → dividir → efectivo y tarjeta → cerrar', () => {
  it('todo se confirma, el pedido queda cerrado y el resumen del turno cuadra', async () => {
    const h = setupHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(200_000)
    await until(() => sinPendientes(floor))
    expect(h.hub.openShift(e.deviceId)).toMatchObject({ id: shift, base: 200_000 })

    const order = await pedidoDeCien(floor)
    const status = await stateOf(floor, order)
    if (!status) throw new Error('sin pedido')
    const checks = enPartesIguales(status, 2, RULES, newId)
    expect(checks.map((c) => c.amount)).toEqual([50_025, 50_025])
    await floor.record('CheckSplit', order, { checks })
    await until(() => sinPendientes(floor))

    // Cuenta 1 en efectivo: 50.025 se cobra a 50.000 (−25) con la propina redondeada.
    const p1 = datosPago(shift, checks[0]?.check_id as string, 'cash', 50_025, 4_600, 60_000)
    expect(p1).toMatchObject({ rounding_adjustment: -25, change: 5_400 })
    const r1 = await resolve(floor.registrarConfirmado('PaymentRecorded', order, p1))
    expect(r1.ok).toBe(true)

    // Cuenta 2 con tarjeta.
    const p2 = datosPago(shift, checks[1]?.check_id as string, 'card', 50_025, 4_629)
    const r2 = await resolve(floor.registrarConfirmado('PaymentRecorded', order, p2))
    expect(r2.ok).toBe(true)

    const closeout = await resolve(floor.registrarConfirmado('OrderClosed', order, {}))
    expect(closeout.ok).toBe(true)
    await until(() => sinPendientes(floor))

    const closed = h.hub.order(order)
    expect(closed?.status).toBe('closed')
    expect(orderTotals(closed as never)).toMatchObject({
      balance: 0,
      paid: 100_050,
      settings: -25,
      tips: 9_229,
    })
    // El pedido ya no está abierto en la caja y todo lo guardado aquí está confirmado.
    expect(await stateOf(floor, order)).toBeNull()
    const savedList = await locals(floor)
    expect(savedList.every((l) => l.status === 'confirmed')).toBe(true)
    expect(savedList.map((l) => l.event.type)).toEqual([
      'ShiftOpened',
      'OrderOpened',
      'ItemAdded',
      'ItemAdded',
      'CheckSplit',
      'PaymentRecorded',
      'PaymentRecorded',
      'OrderClosed',
    ])
    const resumen = resumenTurno(savedList, shift)
    expect(resumen.payments).toBe(2)
    expect(resumen.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 50_000, tip: 4_600, payments: 1 },
      { method: 'card', customMethodId: null, sale: 50_025, tip: 4_629, payments: 1 },
    ])
    expect(turnoDeCaja(savedList, e.deviceId)).toMatchObject({
      id: shift,
      porConfirmar: false,
    })
  })

  it('cerrar con saldo pendiente: el hub lo rechaza y registrarConfirmado lanza el motivo en palabras', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const shift = await floor.openShift(0)
    const order = await pedidoDeCien(floor)
    const partial = datosPago(shift, null, 'nequi', 100_050, 0)
    const r = await resolve(
      floor.registrarConfirmado('PaymentRecorded', order, { ...partial, amount: 50_000 }),
    )
    expect(r.ok).toBe(true)
    const closeout = await resolve(floor.registrarConfirmado('OrderClosed', order, {}))
    expect(closeout).toMatchObject({ ok: false })
    expect((closeout as { error: Error }).error.message).toBe(
      'Todavía queda saldo: alguien agregó algo mientras cobrabas.',
    )
    expect(h.hub.order(order)?.status).toBe('open')
  })

  it('cobrar sin turno abierto: el hub lo rechaza con «sin_turno» dicho en palabras y el pago desaparece', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const order = await pedidoDeCien(floor)
    const fake = newId()
    const r = await resolve(
      floor.registrarConfirmado(
        'PaymentRecorded',
        order,
        datosPago(fake, null, 'nequi', 100_050, 0),
      ),
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: Error }).error.message).toBe(
      'La caja no tiene turno abierto: ábrela en «Caja».',
    )
    expect(Object.keys((await stateOf(floor, order))?.payments ?? {})).toEqual([])
  })

  it('un segundo turno de la misma caja se rechaza (turno_ya_abierto) y el primero sigue', async () => {
    const h = setupHub()
    const { floor, e } = await register(h)
    const firstOne = await floor.openShift(100)
    await until(() => sinPendientes(floor))
    await floor.openShift(999)
    await until(() => sinPendientes(floor))
    expect(h.hub.openShift(e.deviceId)).toMatchObject({ id: firstOne, base: 100 })
    const rejectedList = (await locals(floor)).filter((l) => l.status === 'rejected')
    expect(rejectedList).toHaveLength(1)
    expect(rejectedList[0]?.reason).toBe('shift_already_open')
    expect(turnoDeCaja(await locals(floor), e.deviceId)?.id).toBe(firstOne)
  })

  it('una tarjeta con un datáfono que ya no existe se rechaza con su mensaje', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const shift = await floor.openShift(0)
    const order = await pedidoDeCien(floor)
    const payment = datosPago(shift, null, 'card', 100_050, 0)
    const r = await resolve(
      floor.registrarConfirmado('PaymentRecorded', order, {
        ...payment,
        cardTerminal: { ...(payment.cardTerminal as object), card_terminal_id: newId() } as never,
      }),
    )
    expect((r as { error: Error }).error.message).toBe('Ese datáfono ya no está: elige otro.')
  })

  it('el mismo pago reenviado (mismo pago_id) no se cobra dos veces', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const shift = await floor.openShift(0)
    const order = await pedidoDeCien(floor)
    const partial = { ...datosPago(shift, null, 'nequi', 100_050, 0), amount: 30_000 }
    await resolve(floor.registrarConfirmado('PaymentRecorded', order, partial))
    const another = await resolve(floor.registrarConfirmado('PaymentRecorded', order, partial))
    expect(another).toMatchObject({ ok: false })
    expect(Object.keys(h.hub.order(order)?.payments ?? {})).toHaveLength(1)
    expect(orderTotals(h.hub.order(order) as never).paid).toBe(30_000)
  })

  it('sin que el hub conteste, registrarConfirmado falla diciendo que quedó pendiente (no cobrar otra vez)', async () => {
    const h = setupHub()
    const { floor } = await register(h)
    const shift = await floor.openShift(0)
    const order = await pedidoDeCien(floor)
    floor.simularSinConexion(true)
    const r = await resolve(
      floor.registrarConfirmado(
        'PaymentRecorded',
        order,
        datosPago(shift, null, 'nequi', 100_050, 0),
      ),
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: Error }).error.message).toMatch(/Quedó pendiente/)
    // Se guardó aquí: al volver la conexión llega al hub una sola vez.
    floor.simularSinConexion(false)
    await until(() => sinPendientes(floor))
    expect(Object.keys(h.hub.order(order)?.payments ?? {})).toHaveLength(1)
  })
})
