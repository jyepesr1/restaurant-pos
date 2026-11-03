import { newId, type OrderEvent } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { cashPaymentData, event, itemCopy } from '../../../packages/core/src/testing/factory'
import { Panel } from './panel'
import { panelRequest, putSnapshot, remoteUser, slugOf } from './testing/panel'
import { createWorld } from './testing/world'

// How long the dashboard (`GET /v1/panel/summary`, review 1.11c-2 point 7) takes on a pilot-sized
// day: ~1,500 events today and as many the same weekday last week, with tables still open and a few
// alerts. It prints the time of each read; it only fails if it is absurdly slow, and it checks that
// two reads in a row give the same numbers.

const ORDERS_PER_DAY = 214
const OPEN_NOW = 15
const CASHIER = newId()

function day(dayIso: string, open: number): OrderEvent[] {
  const events: OrderEvent[] = []
  const register = newId()
  const shift = newId()
  const push = (e: OrderEvent, minute: number) =>
    events.push({
      ...e,
      business_day: dayIso,
      received_at: new Date(Date.parse(`${dayIso}T11:00:00.000Z`) + minute * 1_000).toISOString(),
    })
  push(
    event(
      shift,
      'ShiftOpened',
      { register_id: register, base: 100_000 },
      { aggregate_type: 'register_shift', user_id: CASHIER, device_id: register },
    ),
    0,
  )
  for (let o = 0; o < ORDERS_PER_DAY + open; o++) {
    const order = newId()
    const items = [itemCopy(), itemCopy({ unit_price: 14_900 }), itemCopy({ unit_price: 29_900 })]
    const total = 40_900 + 14_900 + 29_900
    push(event(order, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 }), o)
    for (const item of items) push(event(order, 'ItemAdded', item), o)
    push(
      event(order, 'ItemsSent', {
        tickets: [
          { ticket_id: newId(), station_id: newId(), item_ids: items.map((i) => i.item_id) },
        ],
      }),
      o,
    )
    if (o % 40 === 0)
      push(
        event(
          order,
          'ItemVoided',
          {
            item_id: items[1]?.item_id as string,
            quantity: 1,
            already_prepared: true,
            ticket_id: null,
          },
          { reason: 'Se quemó' },
        ),
        o,
      )
    if (o >= ORDERS_PER_DAY) continue
    const due = o % 40 === 0 ? total - 14_900 : total
    push(event(order, 'PaymentRecorded', cashPaymentData(due, { register_shift_id: shift })), o + 1)
    push(event(order, 'OrderClosed', {}), o + 1)
  }
  return events
}

describe('performance', () => {
  it('the dashboard on a pilot-sized day', { timeout: 600_000 }, async () => {
    const m = await createWorld()
    const hub = await m.newHub()
    const events = [...day('2026-10-19', 0), ...day('2026-10-26', OPEN_NOW)].map((e, i) => ({
      ...e,
      sequence: i + 1,
    }))
    for (let i = 0; i < events.length; i += 500) {
      const r = await m.cloud.receiveEvents(hub.hub, events.slice(i, i + 500))
      expect(r.every((x) => x.status === 'saved')).toBe(true)
    }
    const user = remoteUser('jefe', 'clave-del-jefe-1', ['remote_access', 'view_reports'])
    expect(await putSnapshot(m, hub, 'remote_users', [user])).toBe(204)
    const r = await panelRequest(m, 'POST', '/v1/panel/sign-in', {
      body: {
        restaurant: await slugOf(m, hub.restaurantId),
        username: 'jefe',
        password: 'clave-del-jefe-1',
      },
    })
    expect(r.status).toBe(200)
    const panel = new Panel(m.sql, () => m.clock.now)
    const session = await panel.session(
      (r.headers.get('set-cookie') ?? '').split(';')[0]?.split('=').slice(1).join('=') ?? null,
    )
    if (!session) throw new Error('no session')

    const times: number[] = []
    const answers: unknown[] = []
    for (let run = 0; run < 3; run++) {
      const started = performance.now()
      const s = await panel.summary(session)
      times.push(performance.now() - started)
      answers.push({ ...s, server_now: null })
    }
    expect(answers[1]).toEqual(answers[0])
    expect(answers[2]).toEqual(answers[0])
    const first = answers[0] as { open: { orders: number }; alerts: number }
    expect(first.open.orders).toBe(OPEN_NOW)
    expect(first.alerts).toBe(Math.ceil((ORDERS_PER_DAY + OPEN_NOW) / 40))
    console.log(
      `Tablero de Hoy con ${events.length} eventos (hoy y el mismo día de la semana pasada): ` +
        `${times.map((t) => Math.round(t)).join(' / ')} ms`,
    )
    expect(Math.min(...times)).toBeLessThan(60_000)
  })
})
