import 'fake-indexeddb/auto'
import { newId, orderTotals, signEvent } from '@pos/core'
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
  enPartesIguales,
  pagoEnEfectivo,
  type ReglasCobro,
  resumenTurno,
  turnoDeCaja,
} from './cuentas'
import { type Equipo, Sala, type Sesion } from './motor'
import { pedidosAbiertos } from './proyeccion'
import { catalogoDePrueba, datosItem } from './pruebas'

// De punta a punta, en memoria: la caja (motor + IndexedDB) habla con un hub de memoria con las
// reglas de cobro. Abrir turno → dividir → dos pagos (efectivo y tarjeta) → cerrar el pedido. Los
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
  const db = new BaseDispositivo(`checkout-${newId()}`)
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
const stateOf = async (s: Sala, id: string) =>
  pedidosAbiertos(await locales(s)).find((p) => p.status.id === id)?.status ?? null
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

describe('de punta a punta: abrir turno → dividir → efectivo y tarjeta → cerrar', () => {
  it('todo se confirma, el pedido queda cerrado y el resumen del turno cuadra', async () => {
    const h = montarHub()
    const { sala, e } = await register(h)
    const shift = await sala.abrirTurno(200_000)
    await until(() => sinPendientes(sala))
    expect(h.hub.turnoAbierto(e.dispositivoId)).toMatchObject({ id: shift, base: 200_000 })

    const order = await pedidoDeCien(sala)
    const status = await stateOf(sala, order)
    if (!status) throw new Error('sin pedido')
    const checks = enPartesIguales(status, 2, REGLAS, newId)
    expect(checks.map((c) => c.amount)).toEqual([50_025, 50_025])
    await sala.record('CheckSplit', order, { checks })
    await until(() => sinPendientes(sala))

    // Cuenta 1 en efectivo: 50.025 se cobra a 50.000 (−25) con la propina redondeada.
    const p1 = datosPago(shift, checks[0]?.check_id as string, 'cash', 50_025, 4_600, 60_000)
    expect(p1).toMatchObject({ rounding_adjustment: -25, change: 5_400 })
    const r1 = await resolver(sala.registrarConfirmado('PaymentRecorded', order, p1))
    expect(r1.ok).toBe(true)

    // Cuenta 2 con tarjeta.
    const p2 = datosPago(shift, checks[1]?.check_id as string, 'card', 50_025, 4_629)
    const r2 = await resolver(sala.registrarConfirmado('PaymentRecorded', order, p2))
    expect(r2.ok).toBe(true)

    const closeout = await resolver(sala.registrarConfirmado('OrderClosed', order, {}))
    expect(closeout.ok).toBe(true)
    await until(() => sinPendientes(sala))

    const closed = h.hub.order(order)
    expect(closed?.status).toBe('closed')
    expect(orderTotals(closed as never)).toMatchObject({
      balance: 0,
      paid: 100_050,
      settings: -25,
      tips: 9_229,
    })
    // El pedido ya no está abierto en la caja y todo lo guardado aquí está confirmado.
    expect(await stateOf(sala, order)).toBeNull()
    const guardados = await locales(sala)
    expect(guardados.every((l) => l.status === 'confirmed')).toBe(true)
    expect(guardados.map((l) => l.event.type)).toEqual([
      'ShiftOpened',
      'OrderOpened',
      'ItemAdded',
      'ItemAdded',
      'CheckSplit',
      'PaymentRecorded',
      'PaymentRecorded',
      'OrderClosed',
    ])
    const resumen = resumenTurno(guardados, shift)
    expect(resumen.payments).toBe(2)
    expect(resumen.byMethod).toEqual([
      { method: 'cash', customMethodId: null, sale: 50_000, tip: 4_600, payments: 1 },
      { method: 'card', customMethodId: null, sale: 50_025, tip: 4_629, payments: 1 },
    ])
    expect(turnoDeCaja(guardados, e.dispositivoId)).toMatchObject({
      id: shift,
      porConfirmar: false,
    })
  })

  it('cerrar con saldo pendiente: el hub lo rechaza y registrarConfirmado lanza el motivo en palabras', async () => {
    const h = montarHub()
    const { sala } = await register(h)
    const shift = await sala.abrirTurno(0)
    const order = await pedidoDeCien(sala)
    const partial = datosPago(shift, null, 'nequi', 100_050, 0)
    const r = await resolver(
      sala.registrarConfirmado('PaymentRecorded', order, { ...partial, amount: 50_000 }),
    )
    expect(r.ok).toBe(true)
    const closeout = await resolver(sala.registrarConfirmado('OrderClosed', order, {}))
    expect(closeout).toMatchObject({ ok: false })
    expect((closeout as { error: Error }).error.message).toBe(
      'Todavía queda saldo: alguien agregó algo mientras cobrabas.',
    )
    expect(h.hub.order(order)?.status).toBe('open')
  })

  it('cobrar sin turno abierto: el hub lo rechaza con «sin_turno» dicho en palabras y el pago desaparece', async () => {
    const h = montarHub()
    const { sala } = await register(h)
    const order = await pedidoDeCien(sala)
    const falso = newId()
    const r = await resolver(
      sala.registrarConfirmado(
        'PaymentRecorded',
        order,
        datosPago(falso, null, 'nequi', 100_050, 0),
      ),
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: Error }).error.message).toBe(
      'La caja no tiene turno abierto: ábrela en «Caja».',
    )
    expect(Object.keys((await stateOf(sala, order))?.payments ?? {})).toEqual([])
  })

  it('un segundo turno de la misma caja se rechaza (turno_ya_abierto) y el primero sigue', async () => {
    const h = montarHub()
    const { sala, e } = await register(h)
    const firstOne = await sala.abrirTurno(100)
    await until(() => sinPendientes(sala))
    await sala.abrirTurno(999)
    await until(() => sinPendientes(sala))
    expect(h.hub.turnoAbierto(e.dispositivoId)).toMatchObject({ id: firstOne, base: 100 })
    const rechazados = (await locales(sala)).filter((l) => l.status === 'rejected')
    expect(rechazados).toHaveLength(1)
    expect(rechazados[0]?.reason).toBe('shift_already_open')
    expect(turnoDeCaja(await locales(sala), e.dispositivoId)?.id).toBe(firstOne)
  })

  it('una tarjeta con un datáfono que ya no existe se rechaza con su mensaje', async () => {
    const h = montarHub()
    const { sala } = await register(h)
    const shift = await sala.abrirTurno(0)
    const order = await pedidoDeCien(sala)
    const payment = datosPago(shift, null, 'card', 100_050, 0)
    const r = await resolver(
      sala.registrarConfirmado('PaymentRecorded', order, {
        ...payment,
        cardTerminal: { ...(payment.cardTerminal as object), card_terminal_id: newId() } as never,
      }),
    )
    expect((r as { error: Error }).error.message).toBe('Ese datáfono ya no está: elige otro.')
  })

  it('el mismo pago reenviado (mismo pago_id) no se cobra dos veces', async () => {
    const h = montarHub()
    const { sala } = await register(h)
    const shift = await sala.abrirTurno(0)
    const order = await pedidoDeCien(sala)
    const partial = { ...datosPago(shift, null, 'nequi', 100_050, 0), amount: 30_000 }
    await resolver(sala.registrarConfirmado('PaymentRecorded', order, partial))
    const another = await resolver(sala.registrarConfirmado('PaymentRecorded', order, partial))
    expect(another).toMatchObject({ ok: false })
    expect(Object.keys(h.hub.order(order)?.payments ?? {})).toHaveLength(1)
    expect(orderTotals(h.hub.order(order) as never).paid).toBe(30_000)
  })

  it('sin que el hub conteste, registrarConfirmado falla diciendo que quedó pendiente (no cobrar otra vez)', async () => {
    const h = montarHub()
    const { sala } = await register(h)
    const shift = await sala.abrirTurno(0)
    const order = await pedidoDeCien(sala)
    sala.simularSinConexion(true)
    const r = await resolver(
      sala.registrarConfirmado(
        'PaymentRecorded',
        order,
        datosPago(shift, null, 'nequi', 100_050, 0),
      ),
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: Error }).error.message).toMatch(/Quedó pendiente/)
    // Se guardó aquí: al volver la conexión llega al hub una sola vez.
    sala.simularSinConexion(false)
    await until(() => sinPendientes(sala))
    expect(Object.keys(h.hub.order(order)?.payments ?? {})).toHaveLength(1)
  })
})
