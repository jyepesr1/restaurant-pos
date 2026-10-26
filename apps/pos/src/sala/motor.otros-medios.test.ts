import 'fake-indexeddb/auto'
import { newId, otherMethodsReconciliation, signEvent } from '@pos/core'
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
import { conSigno, mediosDelCierre } from './Caja'
import { cuadreDeCaja, type ReglasCobro, resumenTurno, turnoDeCaja } from './cuentas'
import { type Equipo, Sala, type Sesion } from './motor'
import { catalogoDePrueba, datosItem } from './pruebas'

// De punta a punta, en memoria (tarea 1.8): la caja (motor + IndexedDB) habla con un hub de memoria
// con las reglas de cobro. Abrir turno → cobro con tarjeta y Nequi → conteo con los cierres del
// datáfono y de la app → cierre confirmado; y con un reporte distinto, que pide justificación. El
// cierre se arma como lo hace la pantalla de la caja (`mediosDelCierre`, `conSigno`,
// `otherMethodsReconciliation`). Los temporizadores son falsos: nada espera de verdad.

const T0 = new Date('2026-10-26T15:00:00.000Z')
const SODEXO = newId()
const REGLAS: ReglasCobro = {
  mediosPago: ['cash', 'card', 'nequi'],
  mediosPropios: [{ id: SODEXO, name: 'Sodexo' }],
  suggestedTip: 1000,
  redondeoModo: 'half_up',
  redondeoEfectivo: 100,
  cashRoundingMode: 'nearest_half_down',
  imprimePrecuenta: false,
}
const DATAFONO = newId()
const CATALOGO = catalogoDePrueba({
  cardTerminals: [{ id: DATAFONO, name: 'Datáfono 1', provider: 'bold' }],
})

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
async function avanzar(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    await vi.advanceTimersByTimeAsync(Math.min(100, ms - t))
    await asentar(3)
  }
}
async function until(condicion: () => Promise<boolean> | boolean, maxMs = 20_000) {
  for (let t = 0; t <= maxMs; t += 100) {
    if (await condicion()) return
    await avanzar(100)
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
      mediosPropios: [SODEXO],
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
  await db.saveSetting('catalog', CATALOGO)
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

const conteoDe = (counted: number) =>
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
          card_terminal_id: DATAFONO,
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
async function turnoCobrado(h: Hub) {
  const { sala, e } = await register(h)
  const shift = await sala.abrirTurno(50_000)
  const order = await pedidoDeCien(sala)
  expect(
    (
      await resolver(
        sala.registrarConfirmado('PaymentRecorded', order, payment(shift, 'card', 60_050, 6_000)),
      )
    ).ok,
  ).toBe(true)
  expect(
    (
      await resolver(
        sala.registrarConfirmado('PaymentRecorded', order, payment(shift, 'nequi', 40_000)),
      )
    ).ok,
  ).toBe(true)
  await until(() => sinPendientes(sala))
  return { sala, e, shift, order }
}

/**
 * Lo que hace la pantalla del cierre: arma los medios, lee lo escrito, guarda el conteo y cierra
 * con las líneas que salen del conteo. Devuelve el resultado de cada paso.
 */
async function cerrarComoCaja(
  sala: Sala,
  shift: string,
  counted: number,
  escrito: Record<string, string>,
  justification: string | null = null,
) {
  const guardados = await locales(sala)
  const reconciliation = cuadreDeCaja(guardados, shift)
  if (!reconciliation) throw new Error('Sin cuadre')
  const medios = mediosDelCierre(REGLAS, reconciliation, CATALOGO)
  const reportados = medios.map((m) => ({
    method: m.method,
    custom_method_id: m.customMethodId,
    reported: conSigno(escrito[m.key] ?? ''),
  }))
  const cashCount = newId()
  const tally = await resolver(
    sala.registrarConfirmado('CashCountRecorded', shift, {
      cash_count_id: cashCount,
      tally: conteoDe(counted),
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
  const closeout = await resolver(
    sala.registrarConfirmado('ShiftClosed', shift, {
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
  return { tally, closeout, others, cashCount, medios, reconciliation }
}

describe('de punta a punta (1.8): abrir turno → cobro con tarjeta y Nequi → conteo con los cierres → cierre', () => {
  it('con los cierres que coinciden: se confirma, queda guardado y el turno se cierra', async () => {
    const h = montarHub()
    const { sala, e, shift } = await turnoCobrado(h)

    // La caja y el hub ven lo mismo antes de cerrar.
    const before = cuadreDeCaja(await locales(sala), shift)
    expect(before?.byMethod).toEqual([
      { method: 'card', customMethodId: null, sale: 60_050, tip: 6_000, payments: 1 },
      { method: 'nequi', customMethodId: null, sale: 40_000, tip: 0, payments: 1 },
    ])
    expect(h.hub.reconciliation(shift)).toEqual(before)

    const r = await cerrarComoCaja(sala, shift, 50_000, {
      'card:': '66.050',
      'nequi:': '40.000',
    })
    expect(r.medios.map((m) => m.key)).toEqual(['card:', 'nequi:', `other:${SODEXO}`])
    expect(r.tally.ok).toBe(true)
    expect(r.closeout.ok).toBe(true)
    expect(r.others).toEqual([
      { method: 'card', customMethodId: null, expected: 66_050, reported: 66_050, variance: 0 },
      { method: 'nequi', customMethodId: null, expected: 40_000, reported: 40_000, variance: 0 },
    ])
    await until(() => sinPendientes(sala))

    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
    const guardados = await locales(sala)
    expect(guardados.every((l) => l.status === 'confirmed')).toBe(true)
    expect(turnoDeCaja(guardados, e.dispositivoId)).toBeNull()
    expect(cuadreDeCaja(guardados, shift)?.closed).toMatchObject({
      expected: 50_000,
      counted: 50_000,
      variance: 0,
      otherMethods: r.others,
    })
    expect(resumenTurno(guardados, shift).byMethod.map((m) => [m.method, m.sale + m.tip])).toEqual([
      ['card', 66_050],
      ['nequi', 40_000],
    ])
  })

  it('el Sodexo sin cobros y sin escribir no cuenta: el cierre lo omite', async () => {
    const h = montarHub()
    const { sala, shift } = await turnoCobrado(h)
    const r = await cerrarComoCaja(sala, shift, 50_000, {
      'card:': '66.050',
      'nequi:': '40.000',
    })
    expect(r.others.map((o) => o.method)).toEqual(['card', 'nequi'])
    expect(r.closeout.ok).toBe(true)
  })

  it('con un reporte distinto: el hub pide justificación y con ella cierra', async () => {
    const h = montarHub()
    const { sala, e, shift } = await turnoCobrado(h)
    const without = await cerrarComoCaja(sala, shift, 50_000, {
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
    expect(h.hub.turnoAbierto(e.dispositivoId)).not.toBeNull()
    let guardados = await locales(sala)
    expect(turnoDeCaja(guardados, e.dispositivoId)?.id).toBe(shift)
    expect(guardados.filter((l) => l.status === 'rejected').map((l) => l.reason)).toEqual([
      'missing_justification',
    ])

    // Con el mismo conteo y una justificación.
    const cashCount = without.cashCount
    const withIt = await resolver(
      sala.registrarConfirmado('ShiftClosed', shift, {
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
    await until(() => sinPendientes(sala))
    guardados = await locales(sala)
    expect(turnoDeCaja(guardados, e.dispositivoId)).toBeNull()
    expect(cuadreDeCaja(guardados, shift)?.closed).toMatchObject({
      justification: 'Nequi no mostró un pago de $5.000',
      otherMethods: [
        { method: 'card', variance: 0 },
        { method: 'nequi', expected: 40_000, reported: 35_000, variance: -5_000 },
      ],
    })
  })

  it('por debajo del umbral ($999 de diferencia en la tarjeta) se cierra sin justificación', async () => {
    const h = montarHub()
    const { sala, e, shift } = await turnoCobrado(h)
    const r = await cerrarComoCaja(sala, shift, 50_000, {
      'card:': '65.051',
      'nequi:': '40.000',
    })
    expect(r.closeout.ok).toBe(true)
    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
  })

  it('un medio propio (Sodexo) con cobro y con lo escrito distinto', async () => {
    const h = montarHub()
    const { sala, e } = await register(h)
    const shift = await sala.abrirTurno(0)
    const order = await pedidoDeCien(sala)
    expect(
      (
        await resolver(
          sala.registrarConfirmado('PaymentRecorded', order, payment(shift, 'own', 30_000)),
        )
      ).ok,
    ).toBe(true)
    const r = await cerrarComoCaja(sala, shift, 0, { [`other:${SODEXO}`]: '30.000' })
    expect(r.closeout.ok).toBe(true)
    expect(r.others).toEqual([
      { method: 'other', customMethodId: SODEXO, expected: 30_000, reported: 30_000, variance: 0 },
    ])
    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
  })

  it('un reporte escrito para un medio sin cobros (un cobro que no se registró): sobrante que pide justificación', async () => {
    const h = montarHub()
    const { sala, shift } = await turnoCobrado(h)
    const r = await cerrarComoCaja(sala, shift, 50_000, {
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
    const { sala, e, shift } = await turnoCobrado(h)
    const cashCount = newId()
    await resolver(
      sala.registrarConfirmado('CashCountRecorded', shift, {
        cash_count_id: cashCount,
        tally: conteoDe(50_000),
        counted_cash: 50_000,
        others: [
          { method: 'card', custom_method_id: null, reported: 66_050 },
          { method: 'nequi', custom_method_id: null, reported: 40_000 },
        ],
      }),
    )
    const r = await resolver(
      sala.registrarConfirmado('ShiftClosed', shift, {
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
    expect(h.hub.turnoAbierto(e.dispositivoId)).not.toBeNull()
  })

  it('un cobro con Nequi después del conteo desactualiza el cierre: se dice en palabras y, al volver a contar, cierra', async () => {
    const h = montarHub()
    const { sala, e, shift } = await turnoCobrado(h)
    const oldOne = await cerrarComoCaja(
      sala,
      shift,
      50_000,
      { 'card:': '66.050', 'nequi:': '40.000' },
      null,
    )
    // Ese cierre se aceptó; para probar el desfase se arma otro turno.
    expect(oldOne.closeout.ok).toBe(true)

    const t2 = await sala.abrirTurno(0)
    const order = await pedidoDeCien(sala)
    expect(
      (
        await resolver(
          sala.registrarConfirmado('PaymentRecorded', order, payment(t2, 'nequi', 10_000)),
        )
      ).ok,
    ).toBe(true)
    const cashCount = newId()
    await resolver(
      sala.registrarConfirmado('CashCountRecorded', t2, {
        cash_count_id: cashCount,
        tally: [],
        counted_cash: 0,
        others: [{ method: 'nequi', custom_method_id: null, reported: 10_000 }],
      }),
    )
    expect(
      (
        await resolver(
          sala.registrarConfirmado('PaymentRecorded', order, payment(t2, 'nequi', 5_000)),
        )
      ).ok,
    ).toBe(true)
    const tarde = await resolver(
      sala.registrarConfirmado('ShiftClosed', t2, {
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
    expect(message(tarde)).toBe('Hubo pagos o movimientos después del conteo: vuelve a contar.')
    expect(h.hub.turnoAbierto(e.dispositivoId)?.id).toBe(t2)
    const another = await cerrarComoCaja(sala, t2, 0, { 'nequi:': '15.000', 'card:': '' })
    expect(another.closeout.ok).toBe(true)
    expect(h.hub.turnoAbierto(e.dispositivoId)).toBeNull()
  })
})
