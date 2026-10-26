import {
  newId,
  type OrderEvent,
  type OrderState,
  orderTotals,
  rebuild,
  report,
  shiftReconciliation,
} from '@pos/core'
import { aplicarMigraciones } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { actionArb } from '../../core/src/testing/simulator'
import { AlmacenMemoria } from './hub/almacen'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { cierreDeTurno, cuadreGuardado, datosDeInforme } from './hub/informe'
import { armarHistoria, cargar, DAYS, type PlanDeHistoria } from './pruebas/historias'
import { AHORA, baseSqlite } from './pruebas/montaje'

// Lo que el hub lee de la base para los reportes (tarea 1.9, docs/KPIS.md#período), con historias
// al azar del simulador del reductor: pagos, anulaciones y reembolsos de otro día, pedidos
// reabiertos y vueltos a cerrar, y turnos de caja. Lo mismo con el almacén en memoria y con SQLite.

const CONFIG = { seed: 20_261_041, numRuns: 120 }
const CONFIG_INFORME = { sales_by_waiter: 'added_by', rounding_mode: 'half_up' } as const

const plan = fc.record<PlanDeHistoria>({
  actions: fc.array(actionArb, { minLength: 10, maxLength: 70, size: 'max' }),
  days: fc.array(fc.nat(2), { minLength: 1, maxLength: 150 }),
  closes: fc.tuple(fc.boolean(), fc.boolean()),
  tips: fc.tuple(fc.constantFrom(0, 1_000), fc.constantFrom(0, 2_500)),
})
const ventana = fc.record({ from: fc.nat(2), length: fc.nat(2) })
const range = (v: { from: number; length: number }) => ({
  from: DAYS[Math.min(v.from, 2)] as string,
  until: DAYS[Math.min(v.from + v.length, 2)] as string,
})

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

function almacenes(events: readonly OrderEvent[]) {
  const memory = new AlmacenMemoria()
  cargar(memory, events)
  const { db, restauranteId } = baseSqlite()
  const sqlite = new AlmacenSqlite(db, restauranteId)
  cargar(sqlite, events)
  return { memory, sqlite, db, restauranteId }
}

describe('datosDeInforme con historias al azar', () => {
  it('es igual con el almacén en memoria, con SQLite y tras reabrir la base', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { memory, sqlite, db, restauranteId } = almacenes(h.events)
        const { from, until } = range(v)
        const enMemoria = datosDeInforme(memory, from, until)
        const enSqlite = datosDeInforme(sqlite, from, until)
        expect(enSqlite).toEqual(enMemoria)
        // «Reiniciar el hub»: otro almacén sobre la misma base da lo mismo.
        expect(datosDeInforme(new AlmacenSqlite(db, restauranteId), from, until)).toEqual(enMemoria)
        // Y el informe que sale de ellos.
        expect(report({ ...enSqlite, config: CONFIG_INFORME })).toEqual(
          report({ ...enMemoria, config: CONFIG_INFORME }),
        )
      }),
      CONFIG,
    )
  })

  it('hay un cierre por cada PedidoCerrado del período, con el pedido al cerrar y en su cierre anterior', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { memory, sqlite } = almacenes(h.events)
        const { from, until } = range(v)
        const data = datosDeInforme(memory, from, until)
        expect(datosDeInforme(sqlite, from, until).closings).toEqual(data.closings)
        const closings = h.events.filter(
          (e) => e.type === 'OrderClosed' && e.business_day >= from && e.business_day <= until,
        )
        expect(data.closings).toHaveLength(closings.length)
        for (const [i, c] of closings.entries()) {
          const dato = data.closings[i]
          const previos = h.events.filter(
            (e) =>
              e.type === 'OrderClosed' &&
              e.aggregate_id === c.aggregate_id &&
              e.sequence < c.sequence,
          )
          const hasta1 = (sequence: number) =>
            rebuild(
              h.events.filter((e) => e.sequence <= sequence),
              c.aggregate_id,
            )
          expect(dato?.after).toEqual(hasta1(c.sequence))
          // El primer cierre no tiene anterior; los demás parten del cierre inmediatamente anterior.
          const previous = previos.at(-1)
          expect(dato?.before ?? null).toEqual(previous ? hasta1(previous.sequence) : null)
          expect(dato?.after.status).toBe('closed')
        }
      }),
      { ...CONFIG, seed: 20_261_042 },
    )
  })

  it('los eventos del período son los de su día, en orden, y cada reverso trae su pago', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { sqlite } = almacenes(h.events)
        const { from, until } = range(v)
        const data = datosDeInforme(sqlite, from, until)
        const secuencias = data.events.map((e) => e.sequence)
        expect(secuencias).toEqual([...secuencias].sort((a, b) => (a ?? 0) - (b ?? 0)))
        expect(new Set(data.events.map((e) => e.id)).size).toBe(data.events.length)
        const payments = new Set(
          data.events.filter((e) => e.type === 'PaymentRecorded').map((e) => e.data.payment_id),
        )
        const fromPeriod = h.events.filter(
          (e) =>
            e.business_day >= from &&
            e.business_day <= until &&
            [
              'PaymentRecorded',
              'PaymentVoided',
              'RefundRecorded',
              'ItemVoided',
              'OrderCanceled',
              'CashMovementRecorded',
            ].includes(e.type),
        )
        // Todo lo del período está, y lo que sobra son solo pagos de otro día que alguien reversó.
        const ids = new Set(data.events.map((e) => e.id))
        for (const e of fromPeriod) expect(ids).toContain(e.id)
        const delDia = new Set(fromPeriod.map((e) => e.id))
        for (const e of data.events) {
          if (delDia.has(e.id)) continue
          expect(e.type).toBe('PaymentRecorded')
          expect(
            data.events.some(
              (x) =>
                (x.type === 'PaymentVoided' || x.type === 'RefundRecorded') &&
                x.data.payment_id === (e.data as { payment_id: string }).payment_id,
            ),
          ).toBe(true)
        }
        for (const e of data.events) {
          if (e.type === 'PaymentVoided' || e.type === 'RefundRecorded')
            expect(payments).toContain(e.data.payment_id)
        }
      }),
      { ...CONFIG, seed: 20_261_043 },
    )
  })

  it('las anulaciones y reembolsos de un pago de otro día restan el día en que se registran', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { sqlite } = almacenes(h.events)
        const { from, until } = range(v)
        const r = report({ ...datosDeInforme(sqlite, from, until), config: CONFIG_INFORME })
        // Aparte, sobre todos los eventos: el dinero que entró o salió por medio en esos días.
        const payments = new Map(
          h.events
            .filter((e) => e.type === 'PaymentRecorded')
            .map((e) => [e.data.payment_id, e.data] as const),
        )
        const expected = new Map<string, number>()
        const move = (key: string, n: number) => expected.set(key, (expected.get(key) ?? 0) + n)
        for (const e of h.events) {
          if (e.business_day < from || e.business_day > until) continue
          if (e.type === 'PaymentRecorded')
            move(
              `${e.data.method}:${e.data.custom_method_id ?? ''}`,
              e.data.amount + e.data.rounding_adjustment,
            )
          else if (e.type === 'PaymentVoided') {
            const o = payments.get(e.data.payment_id)
            if (o)
              move(`${o.method}:${o.custom_method_id ?? ''}`, -(o.amount + o.rounding_adjustment))
          } else if (e.type === 'RefundRecorded') {
            const o = payments.get(e.data.payment_id)
            move(`${e.data.method}:${o?.custom_method_id ?? ''}`, -e.data.sale_amount)
          }
        }
        for (const m of r.byMethod)
          expect(m.sale, `${m.method}`).toBe(
            expected.get(`${m.method}:${m.customMethodId ?? ''}`) ?? 0,
          )
        // Lo que no salió en el informe tiene que ser 0 en el oráculo.
        const salieron = new Set(r.byMethod.map((m) => `${m.method}:${m.customMethodId ?? ''}`))
        for (const [key, n] of expected) if (!salieron.has(key)) expect(n).toBe(0)
      }),
      { ...CONFIG, seed: 20_261_044 },
    )
  })

  it('cada anulación vale unidades × el precio con extras que tenía el ítem, esté donde esté hoy', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { sqlite } = almacenes(h.events)
        const { from, until } = range(v)
        const r = report({ ...datosDeInforme(sqlite, from, until), config: CONFIG_INFORME })
        // El precio de cada ítem, tomado de su alta o de la copia que viajó al mover o unir.
        const prices = new Map<string, number>()
        const copy = (i: {
          item_id: string
          unit_price: number
          modifiers: { extra_price: number }[]
        }) => prices.set(i.item_id, i.unit_price + sum(i.modifiers.map((m) => m.extra_price)))
        for (const e of h.events) {
          if (e.type === 'ItemAdded') copy(e.data)
          else if (e.type === 'ItemsMoved' || e.type === 'OrdersMerged')
            for (const m of e.data.items) copy(m.item)
        }
        const voidedEvents = h.events.filter(
          (e) => e.type === 'ItemVoided' && e.business_day >= from && e.business_day <= until,
        )
        expect(r.voids.map((a) => a.eventId)).toEqual(voidedEvents.map((e) => e.id))
        for (const [i, a] of r.voids.entries()) {
          const e = voidedEvents[i]
          if (e?.type !== 'ItemVoided') throw new Error('desorden')
          expect(a.value).toBe(e.data.quantity * (prices.get(e.data.item_id) ?? Number.NaN))
          expect(a.name).not.toBe('Producto')
        }
      }),
      { ...CONFIG, seed: 20_261_049 },
    )
  })

  it('el neto del período es lo pagado de más en cada cierre que en el anterior, sin reembolsos', () => {
    const paid = (p: OrderState | null) =>
      sum(
        Object.values(p?.payments ?? {})
          .filter((x) => !x.voided)
          .map((x) => x.amount - x.refundedSale),
      )
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { memory } = almacenes(h.events)
        const { from, until } = range(v)
        const data = datosDeInforme(memory, from, until)
        const r = report({ ...data, config: CONFIG_INFORME })
        expect(r.sales.net).toBe(sum(data.closings.map((c) => paid(c.after) - paid(c.before))))
        expect(sum(r.byProduct.map((x) => x.net))).toBe(r.sales.net)
        expect(sum(r.byWaiter.map((x) => x.net))).toBe(r.sales.net)
        expect(sum(r.sales.taxes.map((x) => x.base + x.tax))).toBe(r.sales.net)
        // Una cuenta y sus comensales se cuentan una vez: en el primer cierre.
        expect(r.sales.guests).toBe(
          sum(data.closings.filter((c) => c.before === null).map((c) => c.after.guests)),
        )
      }),
      { ...CONFIG, seed: 20_261_045 },
    )
  })
})

describe('turnos de caja leídos de la base', () => {
  it('el cuadre guardado, los cobros del turno y el cierre son los mismos en memoria y en SQLite', () => {
    fc.assert(
      fc.property(plan, (p) => {
        const h = armarHistoria(p)
        const { memory, sqlite } = almacenes(h.events)
        for (const [n, shift] of h.shifts.entries()) {
          const opening = DAYS[0]
          const cobrosEsperados = h.events.filter(
            (e) =>
              ['PaymentRecorded', 'PaymentVoided', 'RefundRecorded'].includes(e.type) &&
              (e.data as { register_shift_id?: string }).register_shift_id === shift,
          )
          expect(memory.cobrosDeTurno(shift, opening).map((e) => e.id)).toEqual(
            cobrosEsperados.map((e) => e.id),
          )
          expect(sqlite.cobrosDeTurno(shift, opening).map((e) => e.id)).toEqual(
            cobrosEsperados.map((e) => e.id),
          )
          // El cuadre desde la base es el del turno calculado con todos los eventos.
          const completo = shiftReconciliation(h.events, shift)
          expect(cuadreGuardado(sqlite, shift)).toEqual(completo)
          expect(cuadreGuardado(memory, shift)).toEqual(completo)
          const closeout = cierreDeTurno(sqlite, shift)
          expect(cierreDeTurno(memory, shift)).toEqual(closeout)
          if (p.closes[n as 0 | 1]) {
            expect(closeout?.reconciliation.closed).not.toBeNull()
            expect(closeout?.businessDay).toBe(DAYS[2])
            expect(closeout?.diaApertura).toBe(DAYS[0])
          } else expect(closeout).toBeNull()
        }
      }),
      { ...CONFIG, seed: 20_261_046 },
    )
  })

  it('un turno sin abrir o inventado no tiene cuadre ni cierre ni cobros', () => {
    const { memory, sqlite } = almacenes([])
    for (const a of [memory, sqlite]) {
      const id = newId()
      expect(cuadreGuardado(a, id)).toBeNull()
      expect(cierreDeTurno(a, id)).toBeNull()
      expect(a.cobrosDeTurno(id, DAYS[0])).toEqual([])
      expect(a.eventosDelPeriodo(['OrderClosed'], DAYS[0], DAYS[2])).toEqual([])
      expect(a.eventosDelPeriodo([], DAYS[0], DAYS[2])).toEqual([])
    }
  })
})

describe('multirestaurante: el informe de uno no ve al otro', () => {
  /** Una base con dos restaurantes: el segundo se agrega a la del montaje. */
  function dosRestaurantes() {
    const { db, restauranteId: a } = baseSqlite()
    const b = newId()
    db.prepare(
      `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
       VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
    ).run(b, b, AHORA, AHORA)
    return { db, a, b }
  }

  it('con historias distintas, cada informe es el mismo que sin el otro restaurante', () => {
    fc.assert(
      fc.property(plan, plan, ventana, (pa, pb, v) => {
        const ha = armarHistoria(pa)
        const hb = armarHistoria(pb)
        const { db, a, b } = dosRestaurantes()
        const almA = new AlmacenSqlite(db, a)
        const almB = new AlmacenSqlite(db, b)
        // Entrelazados: A, B, A, B...
        const n = Math.max(ha.events.length, hb.events.length)
        for (let i = 0; i < n; i++) {
          const ea = ha.events[i]
          const eb = hb.events[i]
          if (ea) cargar(almA, [ea])
          if (eb) cargar(almB, [eb])
        }
        const only = (events: OrderEvent[]) => {
          const m = new AlmacenMemoria()
          cargar(m, events)
          return m
        }
        const { from, until } = range(v)
        expect(datosDeInforme(almA, from, until)).toEqual(
          datosDeInforme(only(ha.events), from, until),
        )
        expect(datosDeInforme(almB, from, until)).toEqual(
          datosDeInforme(only(hb.events), from, until),
        )
        // Los turnos del uno no existen para el otro (el simulador comparte el id TURNO: los cuadres
        // de cada restaurante cuentan solo sus propios pagos).
        for (const t of ha.shifts) {
          expect(cuadreGuardado(almA, t)).toEqual(cuadreGuardado(only(ha.events), t))
          expect(cuadreGuardado(almB, t)).toEqual(cuadreGuardado(only(hb.events), t))
        }
      }),
      { ...CONFIG, numRuns: 40, seed: 20_261_047 },
    )
  })

  it('con los mismos ids en los dos, lo de uno nunca aparece en el otro', () => {
    const h = armarHistoria({
      actions: [],
      days: [1],
      closes: [true, true],
      tips: [0, 0],
    })
    const { db, a, b } = dosRestaurantes()
    const almA = new AlmacenSqlite(db, a)
    const almB = new AlmacenSqlite(db, b)
    cargar(almA, h.events)
    for (const t of h.shifts) {
      expect(cierreDeTurno(almA, t)).not.toBeNull()
      expect(cierreDeTurno(almB, t)).toBeNull()
      expect(cuadreGuardado(almB, t)).toBeNull()
      expect(almB.cobrosDeTurno(t, DAYS[0])).toEqual([])
    }
    const empty = datosDeInforme(almB, DAYS[0], DAYS[2])
    expect(empty).toMatchObject({
      closings: [],
      related: [],
      events: [],
      cierresDeCaja: [],
    })
    expect(datosDeInforme(almA, DAYS[0], DAYS[2]).cierresDeCaja).toHaveLength(2)
  })

  it('misma base en un archivo: reabrirla sigue separando los restaurantes', () => {
    // Una base nueva por prueba, sin tocar la de nadie más.
    const db = abrirBase(':memory:')
    aplicarMigraciones(db)
    const ids = [newId(), newId()] as const
    for (const id of ids)
      db.prepare(
        `INSERT INTO restaurants (id, restaurant_id, created_at, updated_at, version, name, config)
         VALUES (?, ?, ?, ?, 1, 'R', '{}')`,
      ).run(id, id, AHORA, AHORA)
    const h = armarHistoria({
      actions: [],
      days: [2],
      closes: [true, false],
      tips: [500, 0],
    })
    cargar(new AlmacenSqlite(db, ids[0]), h.events)
    const reopened = new AlmacenSqlite(db, ids[1])
    expect(datosDeInforme(reopened, DAYS[0], DAYS[2]).events).toEqual([])
    expect(
      datosDeInforme(new AlmacenSqlite(db, ids[0]), DAYS[0], DAYS[2]).cierresDeCaja,
    ).toHaveLength(1)
  })
})

describe('las historias llegan a los casos que importan', () => {
  it('hay cierres en otro día, reaperturas, reversos de otro día, turnos cerrados y propinas', () => {
    const seen = {
      closedIds: 0,
      cierreDeUnaReapertura: 0,
      reabiertoSinCerrar: 0,
      reversoDeOtroDia: 0,
      turnoCerrado: 0,
    }
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { memory } = almacenes(h.events)
        const { from, until } = range(v)
        const data = datosDeInforme(memory, from, until)
        if (data.closings.length > 0) seen.closedIds += 1
        if (data.closings.some((c) => c.before !== null)) seen.cierreDeUnaReapertura += 1
        if (data.cierresDeCaja.length > 0) seen.turnoCerrado += 1
        for (const status of h.service.statuses) {
          if (!status) continue
          const closings = h.events.filter(
            (e) => e.type === 'OrderClosed' && e.aggregate_id === status.id,
          )
          const reopened = h.events.some(
            (e) => e.type === 'OrderReopened' && e.aggregate_id === status.id,
          )
          if (reopened && status.status === 'open' && closings.length > 0)
            seen.reabiertoSinCerrar += 1
        }
        const registrados = new Map(
          h.events
            .filter((e) => e.type === 'PaymentRecorded')
            .map((e) => [e.data.payment_id, e.business_day] as const),
        )
        if (
          data.events.some(
            (e) =>
              (e.type === 'PaymentVoided' || e.type === 'RefundRecorded') &&
              registrados.get(e.data.payment_id) !== e.business_day,
          )
        )
          seen.reversoDeOtroDia += 1
      }),
      { ...CONFIG, numRuns: 300, seed: 20_261_048 },
    )
    for (const [caseName, n] of Object.entries(seen)) expect(n, caseName).toBeGreaterThan(0)
  })
})

// ── Lo ya reportado de un día no cambia (DINERO.md#día-operativo-e-informes) ──────────────────

const ventasDe = (a: AlmacenMemoria | AlmacenSqlite, from: string, until = from) =>
  report({ ...datosDeInforme(a, from, until), config: CONFIG_INFORME })

/** Historias con los días en orden, como en la vida real: nada nuevo cae en un día ya pasado. */
const planOrdenado = fc.record<PlanDeHistoria>({
  actions: fc.array(actionArb, { minLength: 10, maxLength: 80, size: 'max' }),
  days: fc.constant([1]),
  closes: fc.constant<[boolean, boolean]>([false, false]),
  tips: fc.constant<[number, number]>([0, 0]),
  cuts: fc
    .tuple(fc.nat(50), fc.nat(50))
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]),
})

const CAMPOS = ['gross', 'voided', 'discounts', 'net', 'settings', 'tips'] as const

describe('lo reportado de un día no cambia', () => {
  it('el informe de un día es el mismo hoy que tras cualquier evento posterior en otros días', () => {
    fc.assert(
      fc.property(planOrdenado, (p) => {
        const h = armarHistoria(p)
        const { memory, sqlite } = almacenes(h.events)
        for (const day of DAYS) {
          // Lo que se sabía al terminar ese día: todo lo registrado hasta él.
          const hastaElDia = h.events.filter((e) => e.business_day <= day)
          const { memory: yesterday, sqlite: ayerSqlite } = almacenes(hastaElDia)
          const entonces = ventasDe(yesterday, day)
          expect(ventasDe(memory, day)).toEqual(entonces)
          expect(ventasDe(sqlite, day)).toEqual(entonces)
          expect(ventasDe(ayerSqlite, day)).toEqual(entonces)
        }
      }),
      { ...CONFIG, seed: 20_261_050, numRuns: 60 },
    )
  })

  it('ni los cierres de mesa de ese día cambian: cada uno parte del cierre anterior y llega al suyo', () => {
    fc.assert(
      fc.property(planOrdenado, (p) => {
        const h = armarHistoria(p)
        const { memory } = almacenes(h.events)
        for (const day of DAYS) {
          const { memory: yesterday } = almacenes(h.events.filter((e) => e.business_day <= day))
          expect(datosDeInforme(memory, day, day).closings).toEqual(
            datosDeInforme(yesterday, day, day).closings,
          )
          expect(datosDeInforme(memory, day, day).events).toEqual(
            datosDeInforme(yesterday, day, day).events,
          )
        }
      }),
      { ...CONFIG, seed: 20_261_051, numRuns: 40 },
    )
  })
})

describe('Σ por días = el estado final', () => {
  it('lo que suman los días de un pedido reabierto es su estado al último cierre', () => {
    fc.assert(
      fc.property(plan, (p) => {
        const h = armarHistoria(p)
        const { memory } = almacenes(h.events)
        const days = DAYS.map((d) => ventasDe(memory, d).sales)
        const expected = { gross: 0, voided: 0, discounts: 0, net: 0, settings: 0, tips: 0 }
        let checks = 0
        let guests = 0
        for (const id of h.service.orders) {
          const closings = h.events.filter((e) => e.type === 'OrderClosed' && e.aggregate_id === id)
          const firstOne = closings.at(0)
          const latest = closings.at(-1)
          if (!firstOne || !latest) continue
          const estadoEn = (sequence: number) =>
            rebuild(
              h.events.filter((e) => e.sequence <= sequence),
              id,
            ) as OrderState
          const final = orderTotals(estadoEn(latest.sequence))
          expected.gross += final.gross
          expected.voided += final.voided
          expected.discounts += final.discount
          expected.net += final.net
          expected.settings += final.settings
          expected.tips += final.tips
          const initial = estadoEn(firstOne.sequence)
          guests += initial.guests
          if (orderTotals(initial).net > 0) checks += 1
        }
        for (const field of CAMPOS)
          expect(sum(days.map((d) => d[field])), field).toBe(expected[field])
        expect(sum(days.map((d) => d.checks))).toBe(checks)
        expect(sum(days.map((d) => d.guests))).toBe(guests)
      }),
      { ...CONFIG, seed: 20_261_052, numRuns: 100 },
    )
  })

  it('cada día, base + impuesto es su neto, también cuando el neto del día es negativo', () => {
    fc.assert(
      fc.property(plan, (p) => {
        const h = armarHistoria(p)
        const { memory } = almacenes(h.events)
        for (const d of DAYS) {
          const v = ventasDe(memory, d).sales
          expect(sum(v.taxes.map((i) => i.base + i.tax))).toBe(v.net)
        }
      }),
      { ...CONFIG, seed: 20_261_054 },
    )
  })
})

describe('un rango es la suma de sus días', () => {
  it('neto, bruto, anulado, descuentos, ajustes, propinas, cuentas y comensales', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { memory, sqlite } = almacenes(h.events)
        const { from, until } = range(v)
        const days = DAYS.filter((d) => d >= from && d <= until)
        const everything = ventasDe(sqlite, from, until).sales
        const porDia = days.map((d) => ventasDe(memory, d).sales)
        for (const field of [...CAMPOS, 'checks', 'guests'] as const)
          expect(everything[field], field).toBe(sum(porDia.map((d) => d[field])))
      }),
      { ...CONFIG, seed: 20_261_055 },
    )
  })

  it('por medio, por mesero, por producto, anulaciones, cancelaciones, descuentos y fondo', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { memory } = almacenes(h.events)
        const { from, until } = range(v)
        const days = DAYS.filter((d) => d >= from && d <= until)
        const everything = ventasDe(memory, from, until)
        const porDia = days.map((d) => ventasDe(memory, d))
        const sumarPor = <T>(list: T[][], key: (x: T) => string, fields: ((x: T) => number)[]) => {
          const m = new Map<string, number[]>()
          for (const row of list.flat()) {
            const acc = m.get(key(row)) ?? fields.map(() => 0)
            fields.forEach((c, i) => {
              acc[i] = (acc[i] ?? 0) + c(row)
            })
            m.set(key(row), acc)
          }
          // Lo que suma cero no sale en el informe.
          return new Map([...m].filter(([, a]) => a.some((n) => n !== 0)))
        }
        const comoMapa = <T>(list: T[], key: (x: T) => string, fields: ((x: T) => number)[]) =>
          sumarPor([list], key, fields)

        const method = (m: { method: string; customMethodId: string | null }) =>
          `${m.method}:${m.customMethodId ?? ''}`
        expect(
          comoMapa(everything.byMethod, method, [(m) => m.sale, (m) => m.tip, (m) => m.payments]),
        ).toEqual(
          sumarPor(
            porDia.map((d) => d.byMethod),
            method,
            [(m) => m.sale, (m) => m.tip, (m) => m.payments],
          ),
        )
        expect(
          comoMapa(everything.byWaiter, (m) => m.userId, [(m) => m.net, (m) => m.checks]),
        ).toEqual(
          sumarPor(
            porDia.map((d) => d.byWaiter),
            (m) => m.userId,
            [(m) => m.net, (m) => m.checks],
          ),
        )
        const product = (x: { productId: string; variantId: string | null }) =>
          `${x.productId}:${x.variantId ?? ''}`
        expect(comoMapa(everything.byProduct, product, [(x) => x.units, (x) => x.net])).toEqual(
          sumarPor(
            porDia.map((d) => d.byProduct),
            product,
            [(x) => x.units, (x) => x.net],
          ),
        )
        expect(everything.voids.map((a) => a.eventId)).toEqual(
          porDia.flatMap((d) => d.voids.map((a) => a.eventId)),
        )
        expect(everything.cancellations.map((a) => a.eventId)).toEqual(
          porDia.flatMap((d) => d.cancellations.map((a) => a.eventId)),
        )
        expect(everything.discounts).toHaveLength(sum(porDia.map((d) => d.discounts.length)))
        for (const field of ['tips', 'paidOut', 'balance'] as const)
          expect(everything.tipPool[field]).toBe(sum(porDia.map((d) => d.tipPool[field])))
      }),
      { ...CONFIG, seed: 20_261_056 },
    )
  })
})
