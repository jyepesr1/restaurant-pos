import { newId } from '@pos/core'
import { COLUMNS, readEscpos } from '@pos/printing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Device, type PrintingSetup, setupPrinting } from './printing-setup'
import { FAILURES_FOR_FALLBACK, TEST_TTL_MS } from './queue'

// The print queue (ADR-015): retries with growing delays, fallback, archived printers, the hub
// restarted with pending jobs, and a printer going down without holding back the others. The clock
// is manual (`t.advance`) and the printer network is fake: nothing really waits.

afterEach(() => {
  vi.useRealTimers()
})

const SEC = 1000

/** Sends the hub `n` sends of a dish to the station; each one leaves a job per printer. */
function sendN(t: PrintingSetup, ana: Device, n: number, station = t.kitchen, name = 'Plato') {
  for (let i = 0; i < n; i++) {
    const { order, items } = t.orderWith(ana, [{ name: `${name} ${i + 1}`, station }])
    t.send(ana, order, items)
  }
}

const stateOf = (t: PrintingSetup, id: string) => t.queue.status().find((e) => e.id === id)
const printedNames = (p: { texts(): string[] }) => p.texts().map((x) => /Plato (\d+)/.exec(x)?.[1])

describe('retries with growing delays', () => {
  it('waits 1, 2, 4, 8, 16 and 30 s between attempts, and stays at 30 s without giving up', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    kitchen.paper.off = true
    sendN(t, t.device(), 1)
    const delays = [1, 2, 4, 8, 16, 30, 30, 30].map((s) => s * SEC)
    expect(kitchen.paper.attempts).toBe(0)
    let attempts = 0
    for (const delay of delays) {
      await t.queue.runOnce()
      attempts += 1
      expect(kitchen.paper.attempts).toBe(attempts)
      // An instant before the delay expires it does not try again.
      t.advance(delay - 1)
      await t.queue.runOnce()
      expect(kitchen.paper.attempts).toBe(attempts)
      t.advance(1)
    }
    expect(t.pendingList()).toBe(1)
  })

  it('after 40 failures it is still pending, not discarded, and every attempt counts', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    kitchen.paper.off = true
    sendN(t, t.device(), 1)
    for (let i = 0; i < 40; i++) {
      await t.queue.runOnce()
      t.advance(31 * SEC)
    }
    const [row] = t.jobs()
    expect(row).toMatchObject({ status: 'pending', attempts: 40 })
    expect(String(row?.last_error)).toContain('rechazó la conexión')
    kitchen.paper.off = false
    await t.queue.runOnce()
    expect(t.pendingList()).toBe(0)
    expect(t.jobs()[0]).toMatchObject({
      status: 'printed',
      attempts: 41,
      printed_on_id: kitchen.id,
    })
  })

  it('when the printer comes back, it prints what is pending in the order it was sent', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    kitchen.paper.off = true
    sendN(t, t.device(), 4)
    await t.queue.runOnce()
    // While it is down it does not skip to the next one: only the first one is tried.
    expect(kitchen.paper.attempts).toBe(1)
    kitchen.paper.off = false
    t.advance(2 * SEC)
    await t.queue.runOnce()
    expect(printedNames(kitchen.paper)).toEqual(['1', '2', '3', '4'])
    expect(t.pendingList()).toBe(0)
  })

  it('a new ticket does not jump ahead of one waiting on the same printer', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    const ana = t.device()
    kitchen.paper.off = true
    sendN(t, ana, 1)
    await t.queue.runOnce()
    sendN(t, ana, 1)
    kitchen.paper.off = false
    t.advance(2 * SEC)
    await t.queue.runOnce()
    expect(kitchen.paper.texts().map((x) => /#(\d+)/.exec(x)?.[1])).toEqual(['1', '2'])
    expect(t.jobs().map((f) => f.status)).toEqual(['printed', 'printed'])
  })

  it("the order is the arrival order (rowid) even if the PC's clock was set back", async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    const ana = t.device()
    sendN(t, ana, 2)
    // The PC's clock was set back: the second one got a time earlier than the first.
    t.db
      .prepare(
        'UPDATE print_jobs SET created_at = ? WHERE rowid = (SELECT max(rowid) FROM print_jobs)',
      )
      .run('2026-10-24T10:00:00.000Z')
    await t.queue.runOnce()
    // The first to arrive prints first: its ticket numbers come out 1 and then 2.
    expect(kitchen.paper.texts().map((x) => /#(\d+)/.exec(x)?.[1])).toEqual(['1', '2'])
  })

  it('each printer keeps its own pace: one being down does not delay the other', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    const bar = t.newPrinter('Barra', [t.bar])
    kitchen.paper.off = true
    const ana = t.device()
    sendN(t, ana, 3, t.kitchen)
    sendN(t, ana, 3, t.bar)
    await t.queue.runOnce()
    expect(bar.paper.received).toHaveLength(3)
    expect(kitchen.paper.received).toHaveLength(0)
    expect(stateOf(t, kitchen.id)).toMatchObject({ status: 'failed', pendingList: 3 })
    expect(stateOf(t, bar.id)).toMatchObject({ status: 'ready', pendingList: 0, error: null })
  })

  it('the status counts the waiting tickets and says what happened, in words', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    kitchen.paper.off = true
    sendN(t, t.device(), 2)
    expect(stateOf(t, kitchen.id)).toMatchObject({ status: 'ready', pendingList: 2 })
    await t.queue.runOnce()
    expect(stateOf(t, kitchen.id)).toEqual({
      id: kitchen.id,
      name: 'Cocina',
      status: 'failed',
      error: 'La impresora rechazó la conexión: revisa el puerto (casi siempre 9100).',
      pendingList: 2,
    })
    kitchen.paper.off = false
    t.advance(5 * SEC)
    await t.queue.runOnce()
    expect(stateOf(t, kitchen.id)).toMatchObject({ status: 'ready', error: null, pendingList: 0 })
  })
})

describe('fallback printer', () => {
  async function setupWithFallback() {
    const t = setupPrinting()
    const fallback = t.newPrinter('Respaldo', [], { width: 58, code_page: 'wpc1252' })
    const kitchen = t.newPrinter('Cocina', [t.kitchen], { fallback_id: fallback.id })
    kitchen.paper.off = true
    const ana = t.device()
    return { t, fallback, kitchen, ana }
  }

  const fail = async (t: PrintingSetup, times = FAILURES_FOR_FALLBACK) => {
    for (let i = 0; i < times; i++) {
      await t.queue.runOnce()
      t.advance(60 * SEC)
    }
  }

  it("after 3 failures in a row the ticket prints on the fallback, with the fallback's width", async () => {
    const { t, fallback, kitchen, ana } = await setupWithFallback()
    sendN(t, ana, 1)
    await fail(t, 2)
    expect(fallback.paper.received).toHaveLength(0)
    await fail(t, 1)
    expect(kitchen.paper.attempts).toBe(3)
    // Right after the third failure the kitchen's delay has not expired: it prints on the fallback.
    t.advance(-60 * SEC + 1)
    await t.queue.runOnce()
    expect(fallback.paper.received).toHaveLength(1)
    const bytes = fallback.paper.received[0] as Uint8Array
    // 58 mm: no text line exceeds 32 columns; and it uses the wpc1252 table (ESC t 16).
    expect([...bytes.slice(2, 5)]).toEqual([0x1b, 0x74, 16])
    for (const line of readEscpos(bytes).text.split('\n'))
      expect(line.length).toBeLessThanOrEqual(COLUMNS[58])
    expect(t.jobs()[0]).toMatchObject({
      status: 'printed',
      printer_id: kitchen.id,
      printed_on_id: fallback.id,
    })
  })

  it('the alert to the devices still says the original printer is not responding', async () => {
    const { t, kitchen, ana } = await setupWithFallback()
    sendN(t, ana, 1)
    await fail(t)
    t.advance(-60 * SEC + 1)
    await t.queue.runOnce()
    expect(stateOf(t, kitchen.id)).toMatchObject({ status: 'failed' })
    const latest = t.notifiedStatuses.at(-1) as { id: string; status: string }[]
    expect(latest.find((e) => e.id === kitchen.id)?.status).toBe('failed')
  })

  it('when the original is fixed, the next ticket tests it and prints on it again', async () => {
    const { t, fallback, kitchen, ana } = await setupWithFallback()
    sendN(t, ana, 1)
    await fail(t)
    t.advance(-60 * SEC + 1)
    await t.queue.runOnce()
    expect(fallback.paper.received).toHaveLength(1)
    // The printer is turned on and three more tickets arrive.
    kitchen.paper.off = false
    t.advance(60 * SEC)
    sendN(t, ana, 3, t.kitchen, 'Nueva')
    await t.queue.runOnce()
    // The test carries only one ticket; the rest wait out that round.
    expect(kitchen.paper.received).toHaveLength(1)
    expect(fallback.paper.received).toHaveLength(1)
    await t.queue.runOnce()
    expect(kitchen.paper.received).toHaveLength(3)
    expect(fallback.paper.received).toHaveLength(1)
    expect(stateOf(t, kitchen.id)).toMatchObject({ status: 'ready', error: null })
    expect(t.pendingList()).toBe(0)
  })

  it('if the test of the original fails, that round prints nothing and the next one uses the fallback', async () => {
    const { t, fallback, kitchen, ana } = await setupWithFallback()
    sendN(t, ana, 2)
    await fail(t) // 3 failures
    t.advance(1) // the third failure's delay expires
    const before = kitchen.paper.attempts
    await t.queue.runOnce() // test (fails again): only one ticket is tried
    expect(kitchen.paper.attempts).toBe(before + 1)
    expect(fallback.paper.received).toHaveLength(0)
    await t.queue.runOnce() // no test due anymore: everything prints on the fallback
    expect(fallback.paper.received).toHaveLength(2)
    expect(kitchen.paper.attempts).toBe(before + 1)
  })

  it('a fallback that also fails: nothing prints, both are left failing and nothing is lost', async () => {
    const { t, fallback, kitchen, ana } = await setupWithFallback()
    fallback.paper.off = true
    sendN(t, ana, 2)
    await fail(t) // the 3 failures
    for (let i = 0; i < 4; i++) {
      await t.queue.runOnce() // test of the original
      await t.queue.runOnce() // and right after, the fallback
      t.advance(60 * SEC)
    }
    expect(kitchen.paper.received).toHaveLength(0)
    expect(fallback.paper.received).toHaveLength(0)
    expect(fallback.paper.attempts).toBeGreaterThan(0)
    expect(stateOf(t, kitchen.id)?.status).toBe('failed')
    expect(stateOf(t, fallback.id)?.status).toBe('failed')
    expect(t.pendingList()).toBe(2)
    // The fallback comes back: everything prints, in order.
    fallback.paper.off = false
    t.advance(60 * SEC)
    await t.queue.runOnce()
    await t.queue.runOnce()
    expect(printedNames(fallback.paper)).toEqual(['1', '2'])
    expect(t.pendingList()).toBe(0)
  })

  it('an archived fallback is not used: the ticket waits for the original', async () => {
    const { t, fallback, kitchen, ana } = await setupWithFallback()
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(fallback.id)
    sendN(t, ana, 1)
    await fail(t, 6)
    expect(fallback.paper.attempts).toBe(0)
    expect(t.pendingList()).toBe(1)
    kitchen.paper.off = false
    t.advance(60 * SEC)
    await t.queue.runOnce()
    expect(kitchen.paper.received).toHaveLength(1)
  })

  it('an archived printer with a fallback passes its pending tickets to the fallback without waiting for failures', async () => {
    const { t, fallback, kitchen, ana } = await setupWithFallback()
    kitchen.paper.off = false
    sendN(t, ana, 2)
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(kitchen.id)
    await t.queue.runOnce()
    expect(kitchen.paper.attempts).toBe(0)
    expect(printedNames(fallback.paper)).toEqual(['1', '2'])
    expect(t.jobs().every((f) => f.printed_on_id === fallback.id)).toBe(true)
  })

  it("the fallback's own tickets and those coming from another printer print together, in arrival order", async () => {
    const { t, fallback, kitchen, ana } = await setupWithFallback()
    t.db
      .prepare('UPDATE printers SET station_ids = ? WHERE id = ?')
      .run(JSON.stringify([t.bar]), fallback.id)
    sendN(t, ana, 1, t.kitchen, 'Cocina')
    await fail(t)
    sendN(t, ana, 1, t.bar, 'Barra')
    sendN(t, ana, 1, t.kitchen, 'Cocina')
    t.advance(-60 * SEC + 1)
    await t.queue.runOnce()
    expect(fallback.paper.received).toHaveLength(3)
    expect(kitchen.paper.received).toHaveLength(0)
    expect(fallback.paper.texts().map((x) => (x.includes('BARRA') ? 'barra' : 'cocina'))).toEqual([
      'cocina',
      'barra',
      'cocina',
    ])
  })

  it('with the original down, the timer alone takes the ticket to the fallback', async () => {
    // With 3 failures, each timer round lands right when the original's delay expires and
    // "tests" it with the oldest job; a round where the original is waiting never comes, and that
    // is the only one in which the fallback is used.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { t, fallback, kitchen, ana } = await setupWithFallback()
    sendN(t, ana, 1)
    t.queue.wake()
    await t.queue.ready()
    for (let i = 0; i < 120; i++) {
      t.advance(1 * SEC)
      await vi.advanceTimersByTimeAsync(1 * SEC)
      await t.queue.ready()
    }
    t.queue.stop()
    expect(kitchen.paper.attempts).toBeGreaterThanOrEqual(FAILURES_FOR_FALLBACK)
    expect(fallback.paper.received).toHaveLength(1)
  })

  it('test pages never print on the fallback', async () => {
    const { t, fallback, kitchen } = await setupWithFallback()
    t.db
      .prepare(
        `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
         VALUES ('01PRUEBA0000000000000000AA', ?, ?, 'test', '{"printer":"Cocina","stations":[],"time":"x"}', ?)`,
      )
      .run(t.restaurantId, kitchen.id, new Date(t.clock()).toISOString())
    await fail(t, 6)
    expect(fallback.paper.received).toHaveLength(0)
    expect(t.pendingList()).toBe(1)
  })
})

describe('test pages', () => {
  const insertTestJob = (t: PrintingSetup, printerId: string) =>
    t.db
      .prepare(
        `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
         VALUES ('01PRUEBA0000000000000000BB', ?, ?, 'test', '{"printer":"Cocina","stations":["Cocina"],"time":"3:00 p. m."}', ?)`,
      )
      .run(t.restaurantId, printerId, new Date(t.clock()).toISOString())

  it("prints with the printer's width ruler", async () => {
    const t = setupPrinting()
    const small = t.newPrinter('Chica', [], { width: 58 })
    insertTestJob(t, small.id)
    await t.queue.runOnce()
    const text = small.paper.texts()[0] as string
    expect(text.replaceAll('\n', ' ')).toContain('PRUEBA DE IMPRESIÓN')
    expect(text.split('\n')).toContain(`${'1234567890'.repeat(3)}12`)
  })

  it('if it does not print within 5 minutes it is discarded on its own, with the reason, and stops counting as pending', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    kitchen.paper.off = true
    insertTestJob(t, kitchen.id)
    await t.queue.runOnce()
    expect(t.pendingList()).toBe(1)
    t.advance(TEST_TTL_MS - 1000)
    kitchen.paper.off = true
    await t.queue.runOnce()
    expect(t.pendingList()).toBe(1)
    t.advance(2000)
    await t.queue.runOnce()
    expect(t.pendingList()).toBe(0)
    expect(t.jobs()[0]).toMatchObject({
      status: 'discarded',
      last_error: 'La prueba no salió en 5 minutos',
      discarded_by_id: null,
    })
  })

  it('an expired test does not hold back the tickets behind it', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    kitchen.paper.off = true
    insertTestJob(t, kitchen.id)
    t.advance(TEST_TTL_MS + 1000)
    sendN(t, t.device(), 1)
    kitchen.paper.off = false
    await t.queue.runOnce()
    expect(kitchen.paper.received).toHaveLength(1)
    expect(kitchen.paper.texts()[0]).toContain('Plato 1')
  })
})

describe('an archived printer without a fallback', () => {
  it('its tickets wait without being printed or tried, and are not lost', async () => {
    const t = setupPrinting()
    const old = t.newPrinter('Vieja', [t.kitchen])
    sendN(t, t.device(), 2)
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(old.id)
    await t.queue.runOnce()
    expect(old.paper.attempts).toBe(0)
    expect(t.pendingList()).toBe(2)
    // It does not appear among the active printers.
    expect(t.queue.status()).toEqual([])
  })

  it('does not spin at full speed: the next round is scheduled at 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = setupPrinting()
    const old = t.newPrinter('Vieja', [t.kitchen])
    sendN(t, t.device(), 1)
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(old.id)
    const runOnce = vi.spyOn(t.queue, 'runOnce')
    t.queue.wake()
    await t.queue.ready()
    expect(runOnce).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(runOnce).toHaveBeenCalledTimes(1)
    t.advance(30 * SEC)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(runOnce).toHaveBeenCalledTimes(2)
    t.queue.stop()
  })

  it('reactivating the printer (or reprinting on another) prints the tickets', async () => {
    const t = setupPrinting()
    const old = t.newPrinter('Vieja', [t.kitchen])
    sendN(t, t.device(), 1)
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(old.id)
    await t.queue.runOnce()
    t.db.prepare('UPDATE printers SET active = 1 WHERE id = ?').run(old.id)
    t.advance(31 * SEC)
    await t.queue.runOnce()
    expect(old.paper.received).toHaveLength(1)
  })

  it('the register sees why a ticket from an archived printer without a fallback does not print', async () => {
    // The reason lives only in the queue's memory and archived printers do not appear in
    // `status()`: the pending list shows the ticket without an error.
    const t = setupPrinting()
    const old = t.newPrinter('Vieja', [t.kitchen])
    sendN(t, t.device(), 1)
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(old.id)
    await t.queue.runOnce()
    expect(String(t.jobs()[0]?.last_error ?? '')).toMatch(/archivada/)
  })
})

describe('content that cannot be understood', () => {
  it.each(['null', '{}', '{"type":"nueva"}', '[1,2]', '"texto"'])(
    'the job with content %s is discarded and does not hold back the next one',
    async (content) => {
      const t = setupPrinting()
      const kitchen = t.newPrinter('Cocina', [t.kitchen])
      t.db
        .prepare(
          `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
           VALUES ('01MALO000000000000000000AA', ?, ?, 'ticket', ?, ?)`,
        )
        .run(t.restaurantId, kitchen.id, content, new Date(t.clock()).toISOString())
      sendN(t, t.device(), 1)
      await t.queue.runOnce()
      const badCase = t.jobs().find((f) => f.id === '01MALO000000000000000000AA')
      const good = t.jobs().find((f) => f.id !== '01MALO000000000000000000AA')
      expect(badCase).toMatchObject({
        status: 'discarded',
        last_error: 'No se pudo armar la comanda',
      })
      expect(good?.status).toBe('printed')
      expect(kitchen.paper.received).toHaveLength(1)
    },
  )
})

describe('the hub restarted with pending jobs', () => {
  it('on startup everything left in the queue prints, even if it had failed before', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    const bar = t.newPrinter('Barra', [t.bar])
    kitchen.paper.off = true
    const ana = t.device()
    sendN(t, ana, 2, t.kitchen)
    sendN(t, ana, 1, t.bar)
    // The hub goes down right after accepting the sends: the queue did not get to print.
    t.queue.stop()
    expect(t.pendingList()).toBe(3)

    // It starts again: another queue on the same database, without the memory of the failures.
    kitchen.paper.off = false
    const started = t.createQueue()
    started.wake()
    await started.ready()
    expect(printedNames(kitchen.paper)).toEqual(['1', '2'])
    expect(bar.paper.received).toHaveLength(1)
    expect(t.pendingList()).toBe(0)
    started.stop()
  })

  it("the new queue does not remember the previous one's delay: it retries immediately", async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    kitchen.paper.off = true
    sendN(t, t.device(), 1)
    for (let i = 0; i < 4; i++) {
      await t.queue.runOnce()
      t.advance(60 * SEC)
    }
    const before = kitchen.paper.attempts
    t.queue.stop()
    kitchen.paper.off = false
    const started = t.createQueue()
    await started.runOnce()
    expect(kitchen.paper.attempts).toBe(before + 1)
    expect(t.pendingList()).toBe(0)
    expect(t.jobs()[0]?.attempts).toBe(before + 1)
  })

  it('what was already printed is not printed again on restart', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    sendN(t, t.device(), 2)
    await t.queue.runOnce()
    const another = t.createQueue()
    await another.runOnce()
    await another.runOnce()
    expect(kitchen.paper.received).toHaveLength(2)
  })

  it('what the register discarded does not come back on restart', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    sendN(t, t.device(), 1)
    t.db
      .prepare("UPDATE print_jobs SET status = 'discarded', finished_at = ?")
      .run(new Date(t.clock()).toISOString())
    await t.createQueue().runOnce()
    expect(kitchen.paper.received).toHaveLength(0)
  })

  it('with a real printer halfway (the ticket arrived but was not confirmed), it reprints: better repeated than lost', async () => {
    let first = true
    const t = setupPrinting({
      send: (base) => async (target, bytes) => {
        await base(target, bytes)
        if (first) {
          first = false
          throw new Error('the connection dropped before closing')
        }
      },
    })
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    sendN(t, t.device(), 1)
    await t.queue.runOnce()
    t.advance(2 * SEC)
    await t.queue.runOnce()
    expect(kitchen.paper.received).toHaveLength(2)
    expect(t.jobs()[0]).toMatchObject({ status: 'printed', attempts: 2 })
  })
})

describe('a printer going down does not hold back sync', () => {
  it('with the queue stuck waiting for a printer, the hub keeps accepting events', async () => {
    let release: () => void = () => {}
    const door = new Promise<void>((r) => {
      release = r
    })
    const t = setupPrinting({
      send: (base) => async (target, bytes) => {
        await door
        return base(target, bytes)
      },
    })
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    const ana = t.device()
    sendN(t, ana, 1)
    t.queue.wake() // left waiting for the printer
    // Meanwhile, new orders come in and are confirmed, one after another.
    const results: string[] = []
    for (let i = 0; i < 10; i++) {
      const { order, items } = t.orderWith(ana, [{ name: `Otro ${i}`, station: t.kitchen }])
      results.push(t.send(ana, order, items).status as string)
    }
    expect(new Set(results)).toEqual(new Set(['confirmed']))
    expect(kitchen.paper.received).toHaveLength(0)
    expect(t.pendingList()).toBe(11)
    release()
    await t.queue.ready()
    // What piled up prints on the next round, in order.
    await t.queue.runOnce()
    expect(kitchen.paper.received).toHaveLength(11)
    expect(t.pendingList()).toBe(0)
  })

  it('with the printer off, connected devices keep receiving events', async () => {
    const { FloorSync } = await import('@pos/sync')
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    kitchen.paper.off = true
    const ana = t.device()
    const luis = t.device('waiter2')
    const floor = new FloorSync(t.hub, t.access.authenticate)
    const received: { type: string }[] = []
    const toAna = floor.connect(() => {})
    const toLuis = floor.connect((m) => received.push(m))
    toAna.receive({
      type: 'hello',
      token: ana.token,
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })
    toLuis.receive({
      type: 'hello',
      token: luis.token,
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    const base = Number(t.db.prepare('SELECT max(sequence) AS s FROM events').get()?.s)
    const sendEvent = t.event(
      ana.connection,
      ana.session,
      'ItemsSent',
      { tickets: [{ ticket_id: newId(), station_id: t.kitchen, item_ids: [items[0]?.id] }] },
      { aggregate_id: order, base_sequence: base },
    )
    toAna.receive({ type: 'push', batch_id: 'l1', events: [sendEvent] })
    expect(received.filter((m) => m.type === 'new')).toHaveLength(1)
    await t.queue.runOnce()
    expect(t.pendingList()).toBe(1)
  })

  it('a queue that blows up because of something in the hub alerts and brings nothing down', async () => {
    const t = setupPrinting()
    t.newPrinter('Cocina', [t.kitchen])
    sendN(t, t.device(), 1)
    const broken = t.createQueue({
      send: () => {
        throw new TypeError('transport bug') // throws synchronously, does not reject
      },
    })
    broken.wake()
    await expect(broken.ready()).resolves.toBeUndefined()
    // A synchronous throw from the transport counts as a printer failure, not a hub failure.
    expect(t.pendingList()).toBe(1)
    broken.stop()
  })
})

describe('wake-ups and simultaneous rounds', () => {
  it('many wake-ups in a row do not print a ticket twice', async () => {
    let inFlight = 0
    let maximum = 0
    const t = setupPrinting({
      send: (base) => async (target, bytes) => {
        inFlight += 1
        maximum = Math.max(maximum, inFlight)
        await Promise.resolve()
        await Promise.resolve()
        await base(target, bytes)
        inFlight -= 1
      },
    })
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    sendN(t, t.device(), 5)
    for (let i = 0; i < 20; i++) t.queue.wake()
    await t.queue.ready()
    expect(kitchen.paper.received).toHaveLength(5)
    expect(maximum).toBe(1)
    expect(t.pendingList()).toBe(0)
  })

  it('a new job that arrives during a round prints on the next round, without waiting', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    const ana = t.device()
    sendN(t, ana, 1)
    t.queue.wake()
    sendN(t, ana, 1) // arrives while the first round is running
    t.queue.wake()
    await t.queue.ready()
    expect(kitchen.paper.received).toHaveLength(2)
  })

  it('after stopping, waking does nothing', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    sendN(t, t.device(), 1)
    t.queue.stop()
    t.queue.wake()
    await t.queue.ready()
    expect(kitchen.paper.received).toHaveLength(0)
    expect(t.pendingList()).toBe(1)
  })

  it('the timer tries again when the delay expires, without anyone waking it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    kitchen.paper.off = true
    sendN(t, t.device(), 1)
    t.queue.wake()
    await t.queue.ready()
    expect(kitchen.paper.attempts).toBe(1)
    kitchen.paper.off = false
    t.advance(1 * SEC)
    await vi.advanceTimersByTimeAsync(1 * SEC)
    await t.queue.ready()
    expect(kitchen.paper.received).toHaveLength(1)
    expect(t.pendingList()).toBe(0)
    t.queue.stop()
  })
})

describe('alerts to the devices', () => {
  it('alerts on the first pass and afterwards only when something changes', async () => {
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    await t.queue.runOnce()
    expect(t.notifiedStatuses).toHaveLength(1)
    await t.queue.runOnce()
    await t.queue.runOnce()
    expect(t.notifiedStatuses).toHaveLength(1)
    kitchen.paper.off = true
    sendN(t, t.device(), 1)
    await t.queue.runOnce()
    expect(t.notifiedStatuses).toHaveLength(2)
    t.advance(31 * SEC)
    await t.queue.runOnce() // still just as bad: same message, not repeated... except the error
    const before = t.notifiedStatuses.length
    t.advance(31 * SEC)
    await t.queue.runOnce()
    expect(t.notifiedStatuses.length).toBe(before)
    kitchen.paper.off = false
    t.advance(31 * SEC)
    await t.queue.runOnce()
    expect(t.notifiedStatuses.at(-1)).toMatchObject([
      { id: kitchen.id, status: 'ready', pendingList: 0 },
    ])
  })

  it('«una comanda no se pudo armar» appears as a failing printer for 15 minutes', async () => {
    const t = setupPrinting()
    t.newPrinter('Cocina', [t.kitchen])
    expect(t.queue.status().map((e) => e.id)).not.toContain('tickets')
    t.queue.unbuiltTicket()
    const alert = t.queue.status().find((e) => e.id === 'tickets')
    expect(alert).toMatchObject({ status: 'failed', pendingList: 0 })
    expect(alert?.error).toMatch(/Pedidos en cocina/)
    expect(t.notifiedStatuses.at(-1)).toEqual(t.queue.status())
    t.advance(15 * 60 * SEC - 1)
    expect(t.queue.status().map((e) => e.id)).toContain('tickets')
    t.advance(1)
    expect(t.queue.status().map((e) => e.id)).not.toContain('tickets')
  })

  it('repeating the «no se pudo armar» alert restarts the 15 minutes and does not duplicate the entry', () => {
    const t = setupPrinting()
    t.queue.unbuiltTicket()
    t.advance(10 * 60 * SEC)
    t.queue.unbuiltTicket()
    t.advance(10 * 60 * SEC)
    expect(t.queue.status().filter((e) => e.id === 'tickets')).toHaveLength(1)
  })

  it('an archived printer does not appear in the status', () => {
    const t = setupPrinting()
    t.newPrinter('Vieja', [t.kitchen], { active: 0 })
    const activePrinter = t.newPrinter('Buena', [t.bar])
    expect(t.queue.status().map((e) => e.id)).toEqual([activePrinter.id])
  })
})

describe("the queue's alert reaches the devices through the floor (as main.ts wires it)", () => {
  it('whoever is connected receives it on change, and whoever connects later, on hello', async () => {
    const { FloorSync } = await import('@pos/sync')
    const t = setupPrinting()
    const kitchen = t.newPrinter('Cocina', [t.kitchen])
    const floor = new FloorSync(t.hub, t.access.authenticate)
    const queue = t.createQueue({ onChange: (statuses) => floor.notifyPrinters(statuses) })
    const ana = t.device()
    const luis = t.device('waiter2')
    const fromAna: { type: string; printers?: { status: string; pendingList: number }[] }[] = []
    const toAna = floor.connect((m) => fromAna.push(m as never))
    toAna.receive({
      type: 'hello',
      token: ana.token,
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })

    kitchen.paper.off = true
    sendN(t, ana, 1)
    await queue.runOnce()
    const latest = fromAna.filter((m) => m.type === 'printers').at(-1)
    expect(latest?.printers).toMatchObject([{ status: 'failed', pendingList: 1 }])

    const fromLuis: { type: string; printers?: { status: string }[] }[] = []
    const toLuis = floor.connect((m) => fromLuis.push(m as never))
    toLuis.receive({
      type: 'hello',
      token: luis.token,
      hub_instance: null,
      until: 0,
      version_app: 'x',
    })
    expect(fromLuis.map((m) => m.type)).toEqual(['welcome', 'printers'])
    expect(fromLuis[1]?.printers).toMatchObject([{ status: 'failed' }])

    kitchen.paper.off = false
    t.advance(2 * SEC)
    await queue.runOnce()
    expect(fromAna.filter((m) => m.type === 'printers').at(-1)?.printers).toMatchObject([
      { status: 'ready', pendingList: 0 },
    ])
    expect(fromLuis.filter((m) => m.type === 'printers').at(-1)?.printers).toMatchObject([
      { status: 'ready' },
    ])
  })
})
