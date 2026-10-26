import 'fake-indexeddb/auto'
import { newId, otherMethodsReconciliation, signEvent } from '@pos/core'
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
import { mediosDelCierre, withSign } from './Caja'
import { cuadreDeCaja, type ReglasCobro, resumenTurno, turnoDeCaja } from './cuentas'
import { type Equipo, Sala, type Sesion } from './motor'
import { catalogoDePrueba, datosItem } from './pruebas'

// De punta a punta, en memoria (tarea 1.8): la caja (motor + IndexedDB) habla con un hub de memoria
// con las reglas de cobro. Abrir turno → cobro con tarjeta y Nequi → conteo con los cierres del
// datáfono y de la app → cierre confirmado; y con un reporte distinto, que pide justificación. El
// cierre se arma como lo hace la pantalla de la caja (`mediosDelCierre`, `withSign`,
// `otherMethodsReconciliation`). Los temporizadores son falsos: nada espera de verdad.

const T0 = new Date('2026-10-26T15:00:00.000Z')
const SODEXO = newId()
const RULES: ReglasCobro = {
  paymentMethods: ['cash', 'card', 'nequi'],
  customMethods: [{ id: SODEXO, name: 'Sodexo' }],
  suggestedTip: 1000,
  roundingMode: 'half_up',
  cashRounding: 100,
  cashRoundingMode: 'nearest_half_down',
  printsPreBill: false,
}
const CARD_TERMINAL = newId()
const CATALOGO = catalogoDePrueba({
  cardTerminals: [{ id: CARD_TERMINAL, name: 'Datáfono 1', provider: 'bold' }],
})

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

function montarHub() {
  const tokens = new Map<string, Equipo>()
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
      customMethods: [SODEXO],
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
type Hub = ReturnType<typeof montarHub>

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
  const e: Equipo = { deviceId: newId(), token: newId(), name, type: 'register' }
  h.tokens.set(e.token, e)
  const sesionId = newId()
  const session: Sesion = {
    sesionId,
    secret: `secreto-${sesionId}`,
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
    ultimoUso: Date.now(),
  }
  await db.saveSetting('device', e)
  await db.saveSetting('session', session)
  await db.saveSetting('catalog', CATALOGO)
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

const tallyOf = (counted: number) =>
  [
    { value: 100_000, quantity: Math.floor(counted / 100_000) },
    { value: 50, quantity: (counted % 100_000) / 50 },
  ].filter((c) => c.quantity > 0)

const message = (r: { ok: boolean }) => (r as unknown as { error: Error }).error.message

/** Un pago parcial de `monto` con el medio dado, sin redondeo: tarjeta (con datáfono), Nequi o Sodexo. */
const payment = (shift: string, method: 'card' | 'nequi' | 'own', amount: number, tip = 0) => ({
  payment_id: newId(),
  check_id: null,
  register_shift_id: shift,
  method: method === 'own' ? ('other' as const) : method,
  ...(method === 'own' ? { custom_method_id: SODEXO } : {}),
  amount,
  tip,
  tendered: null,
  change: null,
  rounding_adjustment: 0,
  rounding: null,
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
})

/** Un turno con $50.000 de base y un pedido de $100.050 cobrado con tarjeta (60.050 + 6.000) y Nequi. */
async function shiftCharged(h: Hub) {
  const { floor, e } = await register(h)
  const shift = await floor.openShift(50_000)
  const order = await pedidoDeCien(floor)
  expect(
    (
      await resolve(
        floor.registrarConfirmado('PaymentRecorded', order, payment(shift, 'card', 60_050, 6_000)),
      )
    ).ok,
  ).toBe(true)
  expect(
    (
      await resolve(
        floor.registrarConfirmado('PaymentRecorded', order, payment(shift, 'nequi', 40_000)),
      )
    ).ok,
  ).toBe(true)
  await until(() => sinPendientes(floor))
  return { floor, e, shift, order }
}

/**
 * Lo que hace la pantalla del cierre: arma los medios, lee lo escrito, guarda el conteo y cierra
 * con las líneas que salen del conteo. Devuelve el resultado de cada paso.
 */
async function cerrarComoCaja(
  floor: Sala,
  shift: string,
  counted: number,
  escrito: Record<string, string>,
  justification: string | null = null,
) {
  const savedList = await locals(floor)
  const reconciliation = cuadreDeCaja(savedList, shift)
  if (!reconciliation) throw new Error('Sin cuadre')
  const methods = mediosDelCierre(RULES, reconciliation, CATALOGO)
  const reportados = methods.map((m) => ({
    method: m.method,
    custom_method_id: m.customMethodId,
    reported: withSign(escrito[m.key] ?? ''),
  }))
  const cashCount = newId()
  const tally = await resolve(
    floor.registrarConfirmado('CashCountRecorded', shift, {
      cash_count_id: cashCount,
      tally: tallyOf(counted),
      counted_cash: counted,
      others: reportados,
    }),
  )
  const others = otherMethodsReconciliation(reconciliation, {
    id: cashCount,
    tally: [],
    counted,
    others: reportados.map((r) => ({
      method: r.method,
      customMethodId: r.custom_method_id,
      reported: r.reported,
    })),
    time: '',
  })
  const closeout = await resolve(
    floor.registrarConfirmado('ShiftClosed', shift, {
      cash_count_id: cashCount,
      expected_cash: reconciliation.cash.expected,
      counted_cash: counted,
      variance: counted - reconciliation.cash.expected,
      justification,
      other_methods: others.map((o) => ({
        method: o.method,
        custom_method_id: o.customMethodId,
        expected: o.expected,
        reported: o.reported,
        variance: o.variance,
      })),
    }),
  )
  return { tally, closeout, others, cashCount, methods, reconciliation }
}

describe('de punta a punta (1.8): abrir turno → cobro con tarjeta y Nequi → conteo con los cierres → cierre', () => {
  it('con los cierres que coinciden: se confirma, queda guardado y el turno se cierra', async () => {
    const h = montarHub()
    const { floor, e, shift } = await shiftCharged(h)

    // La caja y el hub ven lo mismo antes de cerrar.
    const before = cuadreDeCaja(await locals(floor), shift)
    expect(before?.byMethod).toEqual([
      { method: 'card', customMethodId: null, sale: 60_050, tip: 6_000, payments: 1 },
      { method: 'nequi', customMethodId: null, sale: 40_000, tip: 0, payments: 1 },
    ])
    expect(h.hub.reconciliation(shift)).toEqual(before)

    const r = await cerrarComoCaja(floor, shift, 50_000, {
      'card:': '66.050',
      'nequi:': '40.000',
    })
    expect(r.methods.map((m) => m.key)).toEqual(['card:', 'nequi:', `other:${SODEXO}`])
    expect(r.tally.ok).toBe(true)
    expect(r.closeout.ok).toBe(true)
    expect(r.others).toEqual([
      { method: 'card', customMethodId: null, expected: 66_050, reported: 66_050, variance: 0 },
      { method: 'nequi', customMethodId: null, expected: 40_000, reported: 40_000, variance: 0 },
    ])
    await until(() => sinPendientes(floor))

    expect(h.hub.openShift(e.deviceId)).toBeNull()
    const savedList = await locals(floor)
    expect(savedList.every((l) => l.status === 'confirmed')).toBe(true)
    expect(turnoDeCaja(savedList, e.deviceId)).toBeNull()
    expect(cuadreDeCaja(savedList, shift)?.closed).toMatchObject({
      expected: 50_000,
      counted: 50_000,
      variance: 0,
      otherMethods: r.others,
    })
    expect(resumenTurno(savedList, shift).byMethod.map((m) => [m.method, m.sale + m.tip])).toEqual([
      ['card', 66_050],
      ['nequi', 40_000],
    ])
  })

  it('el Sodexo sin cobros y sin escribir no cuenta: el cierre lo omite', async () => {
    const h = montarHub()
    const { floor, shift } = await shiftCharged(h)
    const r = await cerrarComoCaja(floor, shift, 50_000, {
      'card:': '66.050',
      'nequi:': '40.000',
    })
    expect(r.others.map((o) => o.method)).toEqual(['card', 'nequi'])
    expect(r.closeout.ok).toBe(true)
  })

  it('con un reporte distinto: el hub pide justificación y con ella cierra', async () => {
    const h = montarHub()
    const { floor, e, shift } = await shiftCharged(h)
    const without = await cerrarComoCaja(floor, shift, 50_000, {
      'card:': '66.050',
      'nequi:': '35.000',
    })
    expect(without.others.find((o) => o.method === 'nequi')).toMatchObject({
      expected: 40_000,
      reported: 35_000,
      variance: -5_000,
    })
    expect(without.closeout.ok).toBe(false)
    expect(message(without.closeout)).toBe('Escribe por qué no cuadra la caja.')
    // El turno sigue abierto aquí y en el hub; el cierre rechazado queda a la vista.
    expect(h.hub.openShift(e.deviceId)).not.toBeNull()
    let savedList = await locals(floor)
    expect(turnoDeCaja(savedList, e.deviceId)?.id).toBe(shift)
    expect(savedList.filter((l) => l.status === 'rejected').map((l) => l.reason)).toEqual([
      'missing_justification',
    ])

    // Con el mismo conteo y una justificación.
    const cashCount = without.cashCount
    const withIt = await resolve(
      floor.registrarConfirmado('ShiftClosed', shift, {
        cash_count_id: cashCount,
        expected_cash: 50_000,
        counted_cash: 50_000,
        variance: 0,
        justification: 'Nequi no mostró un pago de $5.000',
        other_methods: without.others.map((o) => ({
          method: o.method,
          custom_method_id: o.customMethodId,
          expected: o.expected,
          reported: o.reported,
          variance: o.variance,
        })),
      }),
    )
    expect(withIt.ok).toBe(true)
    await until(() => sinPendientes(floor))
    savedList = await locals(floor)
    expect(turnoDeCaja(savedList, e.deviceId)).toBeNull()
    expect(cuadreDeCaja(savedList, shift)?.closed).toMatchObject({
      justification: 'Nequi no mostró un pago de $5.000',
      otherMethods: [
        { method: 'card', variance: 0 },
        { method: 'nequi', expected: 40_000, reported: 35_000, variance: -5_000 },
      ],
    })
  })

  it('por debajo del umbral ($999 de diferencia en la tarjeta) se cierra sin justificación', async () => {
    const h = montarHub()
    const { floor, e, shift } = await shiftCharged(h)
    const r = await cerrarComoCaja(floor, shift, 50_000, {
      'card:': '65.051',
      'nequi:': '40.000',
    })
    expect(r.closeout.ok).toBe(true)
    expect(h.hub.openShift(e.deviceId)).toBeNull()
  })

  it('un medio propio (Sodexo) con cobro y con lo escrito distinto', async () => {
    const h = montarHub()
    const { floor, e } = await register(h)
    const shift = await floor.openShift(0)
    const order = await pedidoDeCien(floor)
    expect(
      (
        await resolve(
          floor.registrarConfirmado('PaymentRecorded', order, payment(shift, 'own', 30_000)),
        )
      ).ok,
    ).toBe(true)
    const r = await cerrarComoCaja(floor, shift, 0, { [`other:${SODEXO}`]: '30.000' })
    expect(r.closeout.ok).toBe(true)
    expect(r.others).toEqual([
      { method: 'other', customMethodId: SODEXO, expected: 30_000, reported: 30_000, variance: 0 },
    ])
    expect(h.hub.openShift(e.deviceId)).toBeNull()
  })

  it('un reporte escrito para un medio sin cobros (un cobro que no se registró): sobrante que pide justificación', async () => {
    const h = montarHub()
    const { floor, shift } = await shiftCharged(h)
    const r = await cerrarComoCaja(floor, shift, 50_000, {
      'card:': '66.050',
      'nequi:': '40.000',
      [`other:${SODEXO}`]: '12.000',
    })
    expect(r.others.at(-1)).toMatchObject({
      method: 'other',
      expected: 0,
      reported: 12_000,
      variance: 12_000,
    })
    expect(message(r.closeout)).toBe('Escribe por qué no cuadra la caja.')
  })

  it('un cierre con las líneas de otro conteo (desactualizadas): otros_medios_distintos, dicho en palabras', async () => {
    const h = montarHub()
    const { floor, e, shift } = await shiftCharged(h)
    const cashCount = newId()
    await resolve(
      floor.registrarConfirmado('CashCountRecorded', shift, {
        cash_count_id: cashCount,
        tally: tallyOf(50_000),
        counted_cash: 50_000,
        others: [
          { method: 'card', custom_method_id: null, reported: 66_050 },
          { method: 'nequi', custom_method_id: null, reported: 40_000 },
        ],
      }),
    )
    const r = await resolve(
      floor.registrarConfirmado('ShiftClosed', shift, {
        cash_count_id: cashCount,
        expected_cash: 50_000,
        counted_cash: 50_000,
        variance: 0,
        justification: null,
        other_methods: [],
      }),
    )
    expect(message(r)).toBe(
      'Los demás medios no coinciden con lo que registró la caja: recarga la app (puede estar desactualizada) y vuelve a contar.',
    )
    expect(h.hub.openShift(e.deviceId)).not.toBeNull()
  })

  it('un cobro con Nequi después del conteo desactualiza el cierre: se dice en palabras y, al volver a contar, cierra', async () => {
    const h = montarHub()
    const { floor, e, shift } = await shiftCharged(h)
    const oldOne = await cerrarComoCaja(
      floor,
      shift,
      50_000,
      { 'card:': '66.050', 'nequi:': '40.000' },
      null,
    )
    // Ese cierre se aceptó; para probar el desfase se arma otro turno.
    expect(oldOne.closeout.ok).toBe(true)

    const t2 = await floor.openShift(0)
    const order = await pedidoDeCien(floor)
    expect(
      (
        await resolve(
          floor.registrarConfirmado('PaymentRecorded', order, payment(t2, 'nequi', 10_000)),
        )
      ).ok,
    ).toBe(true)
    const cashCount = newId()
    await resolve(
      floor.registrarConfirmado('CashCountRecorded', t2, {
        cash_count_id: cashCount,
        tally: [],
        counted_cash: 0,
        others: [{ method: 'nequi', custom_method_id: null, reported: 10_000 }],
      }),
    )
    expect(
      (
        await resolve(
          floor.registrarConfirmado('PaymentRecorded', order, payment(t2, 'nequi', 5_000)),
        )
      ).ok,
    ).toBe(true)
    const late = await resolve(
      floor.registrarConfirmado('ShiftClosed', t2, {
        cash_count_id: cashCount,
        expected_cash: 0,
        counted_cash: 0,
        variance: 0,
        justification: null,
        other_methods: [
          {
            method: 'nequi',
            custom_method_id: null,
            expected: 10_000,
            reported: 10_000,
            variance: 0,
          },
        ],
      }),
    )
    expect(message(late)).toBe('Hubo pagos o movimientos después del conteo: vuelve a contar.')
    expect(h.hub.openShift(e.deviceId)?.id).toBe(t2)
    const another = await cerrarComoCaja(floor, t2, 0, { 'nequi:': '15.000', 'card:': '' })
    expect(another.closeout.ok).toBe(true)
    expect(h.hub.openShift(e.deviceId)).toBeNull()
  })
})
