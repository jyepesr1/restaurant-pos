import { newId, orderTotals } from '@pos/core'
import fc from 'fast-check'
import type { NetNode } from './network'
import { type CrashingStore, eventsOf, item, type Setup, setup } from './setup'

// Random histories of three registers that go offline and come back and charge, void, refund and
// close the same two orders from stale copies (task 1.7b). Test-only: the sync and cloud property
// tests build their history here.

export type Act =
  | { t: 'pay'; reg: number; order: number; method: 'cash' | 'card'; tip: number; part: boolean }
  | { t: 'voidPayment'; reg: number; order: number; pick: number }
  | { t: 'refund'; reg: number; order: number; pick: number }
  | { t: 'close'; reg: number; order: number }
  | { t: 'reopen'; reg: number; order: number }
  | { t: 'cancel'; reg: number; order: number }
  | { t: 'voidItem'; reg: number; order: number }
  | { t: 'offline'; reg: number }
  | { t: 'online'; reg: number }
  | { t: 'settle' }
  | { t: 'crash' }
  | { t: 'crashOnSave'; at: number }
  | { t: 'serve'; reg: number; toHub: boolean; index: number }
  | { t: 'glitch'; reg: number; toHub: boolean; type: number; drop: boolean }

const reg = fc.nat({ max: 2 })
const order = fc.nat({ max: 1 })
export const arbAct: fc.Arbitrary<Act> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      t: fc.constant('pay' as const),
      reg,
      order,
      method: fc.constantFrom('cash' as const, 'card' as const),
      tip: fc.constantFrom(0, 0, 500),
      part: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant('voidPayment' as const), reg, order, pick: fc.nat(3) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant('refund' as const), reg, order, pick: fc.nat(3) }),
  },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('close' as const), reg, order }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('reopen' as const), reg, order }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('cancel' as const), reg, order }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('voidItem' as const), reg, order }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('offline' as const), reg }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('online' as const), reg }) },
  { weight: 3, arbitrary: fc.constant({ t: 'settle' as const }) },
  { weight: 1, arbitrary: fc.constant({ t: 'crash' as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('crashOnSave' as const),
      at: fc.integer({ min: 1, max: 4 }),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant('serve' as const),
      reg,
      toHub: fc.boolean(),
      index: fc.nat(9),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('glitch' as const),
      reg,
      toHub: fc.boolean(),
      type: fc.nat(9),
      drop: fc.boolean(),
    }),
  },
)

export const asShift = { aggregate_type: 'register_shift' } as const

export interface Outcome {
  m: Setup
  registers: NetNode[]
  waiter: NetNode
  shifts: string[]
  orders: string[]
  unappliedCount: number
}

export async function run(actions: Act[]): Promise<Outcome> {
  const m = setup()
  const waiter = m.network.device('waiter')
  const registers = [0, 1, 2].map((i) => m.network.device(`r${i}`))
  // The third register's clock is three hours off (a skewed device clock).
  ;(registers[2] as NetNode).offsetMs = 3 * 3_600_000
  await m.network.connectAll()
  const shifts = registers.map(() => newId())
  for (const [i, r] of registers.entries())
    await r.create(
      shifts[i] as string,
      'ShiftOpened',
      { register_id: r.deviceId, base: 100_000 },
      asShift,
    )
  const orders = [newId(), newId()]
  for (const o of orders) {
    const items = [item(40_900), item(20_000)]
    await waiter.create(o, 'OrderOpened', { channel: 'dine_in', table_id: newId(), guests: 2 })
    for (const it of items) await waiter.create(o, 'ItemAdded', it)
    await waiter.create(o, 'ItemsSent', {
      tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: items.map((i) => i.item_id) }],
    })
  }
  await m.network.settle()

  for (const a of actions) {
    if (a.t === 'settle') {
      await m.network.settle()
      continue
    }
    if (a.t === 'crash') {
      m.network.crashHub()
      continue
    }
    if (a.t === 'crashOnSave') {
      ;(m.store as CrashingStore).crashAt = a.at
      continue
    }
    if (a.t === 'serve') {
      await m.network.deliverOne(
        registers[a.reg] as NetNode,
        a.toHub ? 'to_hub' : 'to_device',
        a.index,
      )
      continue
    }
    if (a.t === 'glitch') {
      const types = a.toHub ? ['push', 'pull', 'hello'] : ['result', 'new', 'events', 'welcome']
      ;(registers[a.reg] as NetNode).rule(
        a.toHub ? 'to_hub' : 'to_device',
        types[a.type % types.length] as string,
        a.drop ? 'drop' : 'duplicate',
      )
      continue
    }
    const node = registers[a.reg] as NetNode
    if (a.t === 'offline') {
      if (node.online) node.disconnect()
      continue
    }
    if (a.t === 'online') {
      if (!node.online) {
        await node.connect()
        await m.network.settle()
      }
      continue
    }
    const id = orders[a.order] as string
    const shift = shifts[a.reg] as string
    const local = await node.client.order(id)
    if (!local) continue
    const reason = { reason: 'Prueba' }
    switch (a.t) {
      case 'pay': {
        if (local.status !== 'open') break
        const balance = orderTotals(local).balance
        if (balance <= 0) break
        const amount = a.part && balance > 1 ? Math.floor(balance / 2) : balance
        await node.create(id, 'PaymentRecorded', {
          payment_id: newId(),
          check_id: null,
          register_shift_id: shift,
          method: a.method,
          amount,
          tip: a.tip,
          tendered: a.method === 'cash' ? amount + a.tip : null,
          change: a.method === 'cash' ? 0 : null,
          rounding_adjustment: 0,
          rounding: null,
          cardTerminal:
            a.method === 'card'
              ? {
                  card_terminal_id: newId(),
                  franchise: 'Visa',
                  last4: '4242',
                  approval_code: null,
                  receipt: null,
                }
              : null,
          charge_reference: null,
        })
        break
      }
      case 'voidPayment': {
        const live = Object.values(local.payments).filter(
          (p) => !p.voided && p.refundedSale + p.refundedTip === 0,
        )
        const p = live[a.pick % Math.max(live.length, 1)]
        if (p)
          await node.create(
            id,
            'PaymentVoided',
            { payment_id: p.id, register_shift_id: shift },
            reason,
          )
        break
      }
      case 'refund': {
        const live = Object.values(local.payments).filter(
          (p) => !p.voided && p.refundedSale < p.amount,
        )
        const p = live[a.pick % Math.max(live.length, 1)]
        if (p)
          await node.create(
            id,
            'RefundRecorded',
            {
              payment_id: p.id,
              refund_id: newId(),
              sale_amount: 1,
              tip_amount: 0,
              method: p.method,
              register_shift_id: shift,
            },
            reason,
          )
        break
      }
      case 'close':
        if (local.status === 'open' && orderTotals(local).balance === 0)
          await node.create(id, 'OrderClosed', {})
        break
      case 'reopen':
        if (local.status === 'closed') await node.create(id, 'OrderReopened', {}, reason)
        break
      case 'cancel':
        if (local.status === 'open') await node.create(id, 'OrderCanceled', {}, reason)
        break
      case 'voidItem': {
        const it = Object.values(local.items).find((i) => i.status !== 'voided')
        if (local.status === 'open' && it)
          await node.create(
            id,
            'ItemVoided',
            { item_id: it.id, quantity: 1, already_prepared: false, ticket_id: null },
            reason,
          )
        break
      }
    }
  }
  // The network settles (no more losses or duplicates) and everyone reconnects.
  ;(m.store as CrashingStore).crashAt = 0
  for (const n of m.network.nodes) {
    n.rules = []
    n.disconnect()
  }
  await m.network.connectAll()
  const unappliedCount = eventsOf(m).filter((e) => e.unapplied).length
  return { m, registers, waiter, shifts, orders, unappliedCount }
}
