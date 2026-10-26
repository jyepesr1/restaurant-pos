import 'fake-indexeddb/auto'
import { newId, signEvent } from '@pos/core'
import {
  AlmacenMemoria,
  type Channel,
  type ControlAcceso,
  HubSync,
  type Manejadores,
  type MensajeDispositivo,
  SalaSync,
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
import { type Equipo, Sala, type Sesion } from './motor'
import { catalogoDePrueba, datosItem } from './pruebas'

// De punta a punta, en memoria (tarea 1.7): la caja (motor + IndexedDB) habla con un hub de memoria
// con las reglas de cobro. Abrir turno → cobro en efectivo → entrada → pago de propinas → arqueo →
// cierre confirmado → turno nuevo; y los cierres que el hub rechaza, dichos en palabras. Los
// temporizadores son falsos: nada espera de verdad.

const T0 = new Date('2026-10-26T15:00:00.000Z')
const REGLAS: ReglasCobro = {
  mediosPago: ['cash', 'card', 'nequi'],
  suggestedTip: 1000,
  redondeoModo: 'half_up',
  redondeoEfectivo: 100,
  cashRoundingMode: 'nearest_half_down',
  imprimePrecuenta: false,
}
const DATAFONO = newId()

const accesoConFirma: ControlAcceso = {
  verify: (_c, event) =>
    event.session_id && event.signature === signEvent(event, `secreto-${event.session_id}`)
      ? { ok: true, authorizedById: null, autorizacionId: null }
      : { ok: false, reason: 'invalid_signature' },
  registrarUso: () => {},
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
async function resolver<T>(
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
  const hub = new HubSync(new AlmacenMemoria(), {
    restauranteId: newId(),
    timeZone: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-test',
    clock: () => new Date(Date.now()).toISOString(),
    access: accesoConFirma,
    reglasCobro: () => ({
      multiple: 100,
      mode: 'nearest_half_down',
      medios: REGLAS.mediosPago,
      cardTerminals: [DATAFONO],
      umbralDiferencia: 1000,
    }),
  })
  const salaHub = new SalaSync(hub, (token) => {
    const e = tokens.get(token)
    return e ? { dispositivoId: e.dispositivoId, type: e.type, revocadoEn: null } : null
  })
  const h = {
    hub,
    tokens,
    recibidos: [] as MensajeDispositivo[],
    open(m: Manejadores): Channel {
      let enlace: ReturnType<SalaSync['connect']> | null = null
      let closed = false
      setTimeout(() => {
        if (closed) return
        enlace = salaHub.connect((msg) => {
          const copy = JSON.parse(JSON.stringify(msg))
          setTimeout(() => {
            if (!closed) m.alMensaje(copy)
          })
        })
        m.alAbrir()
      })
      return {
        send: (msg) => {
          if (!enlace || closed) return
          const copy = JSON.parse(JSON.stringify(msg)) as MensajeDispositivo
          h.recibidos.push(copy)
          enlace.recibir(copy)
        },
        close: () => {
          closed = true
          enlace?.close()
          enlace = null
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
  const e: Equipo = { dispositivoId: newId(), token: newId(), name, type: 'register' }
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
  await db.saveSetting('catalog', catalogoDePrueba())
  const sala = new Sala({ db, open: (m) => h.open(m) })
  salas.push(sala)
  await sala.cargar()
  await until(() => sala.instantanea().connection === 'connected')
  return { sala, e }
}

const locales = async (s: Sala) => (await s.sync?.locales()) ?? []
const sinPendientes = (s: Sala) => s.instantanea().pendingList === 0

/** Un pedido de dos productos que suma $100.050, ya en el hub. */
async function pedidoDeCien(sala: Sala) {
  const order = newId()
  await sala.record('OrderOpened', order, { channel: 'dine_in', table_id: null, guests: 2 })
  await sala.record('ItemAdded', order, datosItem({ unit_price: 60_050, name: 'Tagliata' }))
  await sala.record('ItemAdded', order, datosItem({ unit_price: 40_000, name: 'Pizza' }))
  await until(() => sinPendientes(sala))
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
  const c = pagoEnEfectivo({ balance, amount: balance, tip, tendered }, REGLAS)
  const served = tendered || c.aEntregar
  const f = pagoEnEfectivo({ balance, amount: balance, tip, tendered: served }, REGLAS)
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
            card_terminal_id: DATAFONO,
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

const conteoDe = (counted: number) =>
  [
    { value: 100_000, quantity: Math.floor(counted / 100_000) },
    { value: 50, quantity: (counted % 100_000) / 50 },
  ].filter((c) => c.quantity > 0)

async function contar(sala: Sala, shift: string, counted: number) {
  const cashCount = newId()
  const r = await resolver(
    sala.registrarConfirmado('CashCountRecorded', shift, {
      cash_count_id: cashCount,
      tally: conteoDe(counted),
      counted_cash: counted,
    }),
  )
  return { cashCount, r }
}

const datosCierre = (
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
    const h = montarHub()
    const { sala, e } = await register(h)
    const shift = await sala.abrirTurno(200_000)
    await until(() => sinPendientes(sala))

    const order = await pedidoDeCien(sala)
    const payment = cobroEfectivo(shift)
    expect(payment).toMatchObject({ rounding_adjustment: -50, change: 0, tendered: 105_000 })
    expect((await resolver(sala.registrarConfirmado('PaymentRecorded', order, payment))).ok).toBe(
      true,
    )
    expect((await resolver(sala.registrarConfirmado('OrderClosed', order, {}))).ok).toBe(true)

    const entry = await resolver(
      sala.registrarConfirmado('CashMovementRecorded', shift, {
        movement_id: newId(),
        type: 'entry',
        amount: 20_000,
        description: 'Cambio para el turno',
        to_whom: null,
        days: [],
      }),
    )
    expect(entry.ok).toBe(true)
    const tips = await resolver(
      sala.registrarConfirmado('CashMovementRecorded', shift, {
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
    const before = cuadreDeCaja(await locales(sala), shift)
    expect(before?.cash).toMatchObject({
      charged: 105_000,
      entries: 20_000,
      tipPayouts: 5_000,
      expected: 320_000,
    })
    expect(h.hub.reconciliation(shift)).toEqual(before)

    const { cashCount, r: tally } = await contar(sala, shift, 320_000)
    expect(tally.ok).toBe(true)
    const closeout = await resolver(
      sala.registrarConfirmado('ShiftClosed', shift, datosCierre(cashCount, 320_000, 320_000)),
    )
    expect(closeout.ok).toBe(true)
    await until(() => sinPendientes(sala))

    // Cerrado en el hub y en la caja; lo guardado aquí está confirmado.
    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
    const guardados = await locales(sala)
    expect(guardados.every((l) => l.status === 'confirmed')).toBe(true)
    expect(turnoDeCaja(guardados, e.dispositivoId)).toBeNull()
    expect(cuadreDeCaja(guardados, shift)?.closed).toMatchObject({
      expected: 320_000,
      counted: 320_000,
      variance: 0,
    })
    expect(resumenTurno(guardados, shift).byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 100_000, tip: 5_000, payments: 1 },
    ])

    // Un pago más a ese turno ya no entra, y se dice en palabras.
    const anotherOrder = await pedidoDeCien(sala)
    const tarde = await resolver(
      sala.registrarConfirmado(
        'PaymentRecorded',
        anotherOrder,
        datosPago(shift, null, 'nequi', 100_050, 0),
      ),
    )
    expect(message(tarde)).toBe('La caja no tiene turno abierto: ábrela en «Caja».')

    // El turno nuevo empieza de cero.
    const fresh = await sala.abrirTurno(50_000)
    await until(() => sinPendientes(sala))
    expect(h.hub.turnoAbierto(e.dispositivoId)).toMatchObject({ id: fresh, base: 50_000 })
    const after = await locales(sala)
    expect(turnoDeCaja(after, e.dispositivoId)).toMatchObject({ id: fresh, base: 50_000 })
    expect(cuadreDeCaja(after, fresh)).toMatchObject({
      cash: { charged: 0, entries: 0, expected: 50_000 },
      byMethod: [],
      cashCounts: [],
      closed: null,
    })
  })

  it('un faltante de $1.000 o más sin justificación lo rechaza el hub y con ella se cierra', async () => {
    const h = montarHub()
    const { sala, e } = await register(h)
    const shift = await sala.abrirTurno(100_000)
    const { cashCount } = await contar(sala, shift, 98_000)
    const without = await resolver(
      sala.registrarConfirmado('ShiftClosed', shift, datosCierre(cashCount, 100_000, 98_000)),
    )
    expect(message(without)).toBe('Escribe por qué no cuadra la caja.')
    // El turno sigue abierto aquí y en el hub, y el cierre rechazado queda a la vista.
    expect(h.hub.turnoAbierto(e.dispositivoId)).not.toBeNull()
    const guardados = await locales(sala)
    expect(turnoDeCaja(guardados, e.dispositivoId)?.id).toBe(shift)
    expect(guardados.filter((l) => l.status === 'rejected').map((l) => l.reason)).toEqual([
      'missing_justification',
    ])
    const withIt = await resolver(
      sala.registrarConfirmado(
        'ShiftClosed',
        shift,
        datosCierre(cashCount, 100_000, 98_000, 'Se pagó un domicilio'),
      ),
    )
    expect(withIt.ok).toBe(true)
    expect(turnoDeCaja(await locales(sala), e.dispositivoId)).toBeNull()
  })

  it('un faltante por debajo del umbral ($999) se cierra sin justificación', async () => {
    const h = montarHub()
    const { sala, e } = await register(h)
    const shift = await sala.abrirTurno(100_000)
    const { cashCount } = await contar(sala, shift, 99_050)
    const r = await resolver(
      sala.registrarConfirmado('ShiftClosed', shift, datosCierre(cashCount, 100_000, 99_050)),
    )
    expect(r.ok).toBe(true)
    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
  })
})

describe('el cierre rechazado, con el motivo en palabras', () => {
  /** Turno con un cobro en efectivo (esperado 305.000: base 200.000 + 105.000) y un conteo. */
  async function ready() {
    const h = montarHub()
    const { sala, e } = await register(h)
    const shift = await sala.abrirTurno(200_000)
    const order = await pedidoDeCien(sala)
    await resolver(sala.registrarConfirmado('PaymentRecorded', order, cobroEfectivo(shift)))
    const { cashCount } = await contar(sala, shift, 305_000)
    return { h, sala, e, shift, cashCount }
  }

  it('con un esperado viejo (sin la propina): esperado_distinto', async () => {
    const t = await ready()
    const r = await resolver(
      t.sala.registrarConfirmado(
        'ShiftClosed',
        t.shift,
        datosCierre(t.cashCount, 300_000, 305_000, 'x'),
      ),
    )
    expect(message(r)).toBe(
      'La caja registró algo que este equipo aún no tenía: espera un momento y vuelve a contar.',
    )
    expect(t.h.hub.turnoAbierto(t.e.dispositivoId)).not.toBeNull()
    expect(turnoDeCaja(await locales(t.sala), t.e.dispositivoId)?.id).toBe(t.shift)
  })

  it('con un conteo que no existe: arqueo_inexistente', async () => {
    const t = await ready()
    const r = await resolver(
      t.sala.registrarConfirmado('ShiftClosed', t.shift, datosCierre(newId(), 305_000, 305_000)),
    )
    expect(message(r)).toBe('La caja no tiene ese conteo: vuelve a contar.')
  })

  it('con un contado distinto del conteo: contado_distinto', async () => {
    const t = await ready()
    const r = await resolver(
      t.sala.registrarConfirmado(
        'ShiftClosed',
        t.shift,
        datosCierre(t.cashCount, 305_000, 300_000, 'x'),
      ),
    )
    expect(message(r)).toBe('Lo contado no coincide con el conteo guardado: vuelve a contar.')
  })

  it('con un conteo que no es el último: arqueo_no_es_el_ultimo', async () => {
    const t = await ready()
    await contar(t.sala, t.shift, 305_000)
    const r = await resolver(
      t.sala.registrarConfirmado(
        'ShiftClosed',
        t.shift,
        datosCierre(t.cashCount, 305_000, 305_000),
      ),
    )
    expect(message(r)).toBe('La caja se cierra con el último conteo: vuelve a contar.')
  })

  it('con dinero movido después del conteo: arqueo_desactualizado', async () => {
    const t = await ready()
    await resolver(
      t.sala.registrarConfirmado('CashMovementRecorded', t.shift, {
        movement_id: newId(),
        type: 'output',
        amount: 5_000,
        description: 'Hielo',
        to_whom: null,
        days: [],
      }),
    )
    const r = await resolver(
      t.sala.registrarConfirmado(
        'ShiftClosed',
        t.shift,
        datosCierre(t.cashCount, 300_000, 305_000, 'x'),
      ),
    )
    expect(message(r)).toBe('Hubo pagos o movimientos después del conteo: vuelve a contar.')
    // Volviendo a contar, cierra.
    const fresh = await contar(t.sala, t.shift, 300_000)
    const ok = await resolver(
      t.sala.registrarConfirmado(
        'ShiftClosed',
        t.shift,
        datosCierre(fresh.cashCount, 300_000, 300_000),
      ),
    )
    expect(ok.ok).toBe(true)
  })

  it('un movimiento o un conteo sin turno abierto: sin_turno', async () => {
    const h = montarHub()
    const { sala } = await register(h)
    const shift = newId()
    const m = await resolver(
      sala.registrarConfirmado('CashMovementRecorded', shift, {
        movement_id: newId(),
        type: 'entry',
        amount: 1_000,
        description: 'x',
        to_whom: null,
        days: [],
      }),
    )
    expect(message(m)).toBe('La caja no tiene turno abierto: ábrela en «Caja».')
    expect(message((await contar(sala, shift, 1_000)).r)).toBe(
      'La caja no tiene turno abierto: ábrela en «Caja».',
    )
  })

  it('el movimiento rechazado desaparece del cuadre de la caja', async () => {
    const t = await ready()
    const another = await register(t.h, 'Caja 2')
    // La otra caja intenta mover efectivo en el turno de esta.
    const r = await resolver(
      another.sala.registrarConfirmado('CashMovementRecorded', t.shift, {
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
    const h = montarHub()
    const { sala, e } = await register(h)
    const shift = await sala.abrirTurno(10_000)
    await until(() => sinPendientes(sala))
    const { cashCount } = await contar(sala, shift, 10_000)

    sala.simularSinConexion(true)
    const r = await resolver(
      sala.registrarConfirmado('ShiftClosed', shift, datosCierre(cashCount, 10_000, 10_000)),
    )
    expect(message(r)).toMatch(/Quedó pendiente/)
    const pending = await locales(sala)
    expect(pending.at(-1)).toMatchObject({ status: 'pending' })
    expect(turnoDeCaja(pending, e.dispositivoId)?.id).toBe(shift)
    expect(h.hub.turnoAbierto(e.dispositivoId)).not.toBeNull()

    sala.simularSinConexion(false)
    await until(() => sinPendientes(sala))
    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
    expect(turnoDeCaja(await locales(sala), e.dispositivoId)).toBeNull()
    // Llegó una sola vez.
    const closings = (await locales(sala)).filter((l) => l.event.type === 'ShiftClosed')
    expect(closings).toHaveLength(1)
  })

  it('un movimiento hecho sin conexión suma al cuadre local al guardarse y se confirma al volver', async () => {
    const h = montarHub()
    const { sala } = await register(h)
    const shift = await sala.abrirTurno(10_000)
    await until(() => sinPendientes(sala))
    sala.simularSinConexion(true)
    await sala.record('CashMovementRecorded', shift, {
      movement_id: newId(),
      type: 'output',
      amount: 3_000,
      description: 'Taxi',
      to_whom: null,
      days: [],
    })
    expect(cuadreDeCaja(await locales(sala), shift)?.cash.expected).toBe(7_000)
    expect(h.hub.reconciliation(shift)?.cash.expected).toBe(10_000)
    sala.simularSinConexion(false)
    await until(() => sinPendientes(sala))
    expect(h.hub.reconciliation(shift)?.cash.expected).toBe(7_000)
  })
})
