import { newId, type OrderEvent, validateNewEvent } from '@pos/core'
// El simulador del reductor de @pos/core: dos pedidos y dos turnos con eventos al azar. Solo para
// pruebas, por eso se importa por ruta y no desde el paquete.
import { type Action, Service } from '../../../core/src/testing/simulator'
import type { AlmacenHub } from '../hub/almacen'

// Historias al azar para probar lo que el hub lee de la base para los reportes (tarea 1.9): los
// eventos del simulador, con días operativos repartidos, turnos de caja abiertos y cerrados y los
// números de secuencia contiguos que exige la base.

export const DAYS = ['2026-10-23', '2026-10-24', '2026-10-25'] as const
const DEL_PERIODO = [
  'PaymentRecorded',
  'PaymentVoided',
  'RefundRecorded',
  'ItemVoided',
  'OrderCanceled',
]

export interface PlanDeHistoria {
  actions: Action[]
  /** Un día (0..2) por evento, según su posición. */
  days: number[]
  /** Cuáles de los dos turnos se cierran al final. */
  closes: [boolean, boolean]
  /** Con propinas pagadas desde la caja en cada turno. */
  tips: [number, number]
  /**
   * Días en orden, como en la vida real: los eventos de antes de `cortes[0]` son del primer día,
   * hasta `cortes[1]` del segundo y el resto del tercero (cada uno es una posición entre los
   * eventos aceptados). Así ningún evento nuevo cae en un día ya pasado. Sustituye a `dias`, y
   * también reparte el día de los cierres de mesa.
   */
  cuts?: [number, number]
}

export interface Story {
  service: Service
  /** Todos los eventos aceptados, con su secuencia contigua desde 1. */
  events: OrderEvent[]
  shifts: readonly [string, string]
}

const CAJA = newId()
const USUARIO = newId()

function crudo(
  type: string,
  aggregate: string,
  data: unknown,
  extras: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: newId(),
    type,
    schema_version: 1,
    aggregate_type: 'register_shift',
    aggregate_id: aggregate,
    related: [],
    data,
    session_id: null,
    user_id: USUARIO,
    device_id: CAJA,
    authorization_id: null,
    reason: null,
    device_time: '2026-10-24T20:00:00.000Z',
    hub_estimated_time: '2026-10-24T20:00:00.000Z',
    base_sequence: 0,
    received_at: '2026-10-24T20:00:00.000Z',
    assignments: {},
    affects: [],
    authorized_by_id: null,
    ...extras,
  }
}

/** Arma la historia: abre los turnos, corre al simulador, reparte los días y cierra los turnos. */
export function armarHistoria(plan: PlanDeHistoria): Story {
  const service = new Service()
  for (const a of plan.actions) service.step(a)
  const appliedEvents = new Set(service.appliedEvents.map((e) => e.id))
  const day = (i: number) => DAYS[plan.days[i % plan.days.length] ?? 1] as string

  const opening = service.shifts.map((t) =>
    crudo('ShiftOpened', t, { register_id: CAJA, base: 100_000 }, { business_day: DAYS[0] }),
  )
  const method = plan.cuts
    ? service.log
        .filter((e) => appliedEvents.has(e.id))
        .map((e, j) => {
          const [c1, c2] = plan.cuts as [number, number]
          const d = j < c1 ? DAYS[0] : j < c2 ? DAYS[1] : DAYS[2]
          return { ...e, business_day: d } as OrderEvent
        })
    : service.log
        .map((e, i) =>
          DEL_PERIODO.includes(e.type) ? ({ ...e, business_day: day(i) } as OrderEvent) : e,
        )
        .filter((e) => appliedEvents.has(e.id))
  const closeout = service.shifts.flatMap((t, n) => {
    const tips = plan.tips[n as 0 | 1]
    const events = []
    if (tips > 0)
      events.push(
        crudo(
          'CashMovementRecorded',
          t,
          {
            movement_id: newId(),
            type: 'tip_payout',
            amount: tips,
            description: 'Propinas',
            to_whom: 'Equipo',
            days: [DAYS[1]],
          },
          { business_day: DAYS[1] },
        ),
      )
    if (plan.closes[n as 0 | 1]) {
      const cashCount = newId()
      events.push(
        crudo(
          'CashCountRecorded',
          t,
          {
            cash_count_id: cashCount,
            tally: [{ value: 1_000, quantity: 100 }],
            counted_cash: 100_000,
          },
          { business_day: DAYS[2] },
        ),
        crudo(
          'ShiftClosed',
          t,
          {
            cash_count_id: cashCount,
            expected_cash: 100_000,
            counted_cash: 100_000,
            variance: 0,
            justification: null,
            other_methods: [],
          },
          { business_day: DAYS[2] },
        ),
      )
    }
    return events
  })

  const events = [...opening, ...method, ...closeout].map((e, i) => ({
    ...e,
    sequence: i + 1,
  })) as unknown as OrderEvent[]
  // Los de caja pasan por el esquema real: la historia nunca trae un evento que el hub rechazaría.
  for (const e of events.filter((x) => x.aggregate_type === 'register_shift')) {
    const {
      sequence: _s,
      received_at: _r,
      business_day: _d,
      assignments: _a,
      affects: _f,
      authorized_by_id: _p,
      ...fresh
    } = e as unknown as Record<string, unknown>
    const v = validateNewEvent(fresh)
    if (!v.ok) throw new Error(`Evento de caja inválido: ${v.errors.join('; ')}`)
  }
  return { service, events, shifts: service.shifts }
}

const pedidosDe = (e: OrderEvent) => [...new Set([e.aggregate_id, ...e.related])]

/** Guarda los eventos en un almacén, como los guardaría el hub. */
export function cargar(almacen: AlmacenHub, events: readonly OrderEvent[]) {
  for (const e of events) almacen.saveEvent(e, e.id, pedidosDe(e))
}

/** Les pone a los eventos la secuencia contigua desde 1 que exige la base. */
export const numerar = (events: readonly OrderEvent[]): OrderEvent[] =>
  events.map((e, i) => ({ ...e, sequence: i + 1 }))
