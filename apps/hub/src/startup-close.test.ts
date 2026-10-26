import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@pos/core'
import type { HubMessage } from '@pos/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { setupAccess } from './access/setup'
import { prepareSync } from './startup'

// The register close (task 1.7) on the real hub: `prepareSync` reads the threshold from the
// configuration on every close, so whatever the admin changes while the hub is running applies
// from the next close on. Complements packages/sync/src/register.close.test.ts.

const folders: string[] = []
afterEach(() => {
  for (const c of folders.splice(0)) rmSync(c, { recursive: true, force: true })
})

function world() {
  const m = setupAccess()
  const dir = mkdtempSync(join(tmpdir(), 'hub-closeout-'))
  folders.push(dir)
  const floor = prepareSync(m.db, dir, m.restaurantId, m.access)
  const register = m.pair('register')
  const session = m.signIn(register.connection, 'cashier')
  const received: HubMessage[] = []
  const link = floor.connect((message) => received.push(message))
  link.receive({
    type: 'hello',
    token: register.token,
    hub_instance: null,
    until: 0,
    version_app: 'pruebas',
  })
  let batch = 0
  const maxSequence = () =>
    Number(
      m.db
        .prepare('SELECT coalesce(max(sequence), 0) AS s FROM events WHERE restaurant_id = ?')
        .get(m.restaurantId)?.s,
    )
  const submit = (type: string, aggregate: string, data: unknown): string => {
    batch += 1
    link.receive({
      type: 'push',
      batch_id: `lote-${batch}`,
      events: [
        m.event(register.connection, session, type, data, {
          aggregate_id: aggregate,
          aggregate_type: 'register_shift',
          base_sequence: maxSequence(),
        } as never),
      ],
    })
    const latest = received.filter((x) => x.type === 'result').at(-1)
    if (latest?.type !== 'result') throw new Error('No result')
    const r = latest.results[0]
    return r?.status === 'rejected' ? r.reason : (r?.status ?? 'no result')
  }
  const putConfig = (config: object) =>
    m.db
      .prepare('UPDATE restaurants SET config = ? WHERE id = ?')
      .run(JSON.stringify(config), m.restaurantId)

  /** Opens a shift with a 100,000 float and counts `counted` pesos ($1,000 bills and $1 coins). */
  const countedShift = (counted: number) => {
    const shift = newId()
    expect(
      submit('ShiftOpened', shift, {
        register_id: register.connection.deviceId,
        base: 100_000,
      }),
    ).toBe('confirmed')
    const cashCount = newId()
    const tally = [
      { value: 1_000, quantity: Math.floor(counted / 1_000) },
      { value: 1, quantity: counted % 1_000 },
    ].filter((c) => c.quantity > 0)
    expect(
      submit('CashCountRecorded', shift, {
        cash_count_id: cashCount,
        tally,
        counted_cash: counted,
      }),
    ).toBe('confirmed')
    const close = (justification: string | null = null) =>
      submit('ShiftClosed', shift, {
        cash_count_id: cashCount,
        expected_cash: 100_000,
        counted_cash: counted,
        variance: counted - 100_000,
        justification,
      })
    return { shift, cashCount, close }
  }
  return { m, putConfig, countedShift, submit }
}

describe('the variance threshold is read from the configuration on every close', () => {
  it('default ($1,000): a $999 shortage closes on its own; $1,000 asks for a justification', () => {
    const e = world()
    expect(e.countedShift(99_001).close()).toBe('confirmed')
    const t = e.countedShift(99_000)
    expect(t.close()).toBe('missing_justification')
    expect(t.close('Propina de la mesa 3')).toBe('confirmed')
  })

  it('an old configuration, without the field, also uses $1,000', () => {
    const e = world()
    e.putConfig({})
    expect(e.countedShift(99_500).close()).toBe('confirmed')
    expect(e.countedShift(99_000).close()).toBe('missing_justification')
  })

  it('if the admin lowers it to $0 while the hub is running, the next close already asks for a justification', () => {
    const e = world()
    const t = e.countedShift(99_999)
    e.putConfig({ register_variance_threshold: 0 })
    expect(t.close()).toBe('missing_justification')
    expect(t.close('Faltó un peso')).toBe('confirmed')
  })

  it('if raised to $5,000, a $4,999 shortage passes and a $5,000 one does not', () => {
    const e = world()
    e.putConfig({ register_variance_threshold: 5_000 })
    expect(e.countedShift(95_001).close()).toBe('confirmed')
    const short = e.countedShift(95_000)
    expect(short.close()).toBe('missing_justification')
    expect(short.close('Se pagó un proveedor')).toBe('confirmed')
    const surplus = e.countedShift(105_000)
    expect(surplus.close()).toBe('missing_justification')
  })

  it('with threshold 0, a register that balances exactly closes without a justification', () => {
    const e = world()
    e.putConfig({ register_variance_threshold: 0 })
    expect(e.countedShift(100_000).close()).toBe('confirmed')
  })
})
