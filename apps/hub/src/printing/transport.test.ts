import { escpos, readEscpos, testLines } from '@pos/printing'
import { afterEach, describe, expect, it } from 'vitest'
import { setupPrinting } from './printing-setup'
import { PrintQueue } from './queue'
import { openTestPrinter, type TestPrinter } from './test-printer'
import { PrinterError, sendOverNetwork } from './transport'

// The network transport against the test printer (a fake TCP server that is turned off and
// on), and the full queue over real sockets.

const openHandles: TestPrinter[] = []
afterEach(async () => {
  for (const i of openHandles.splice(0)) await i.close()
})
const open = async () => {
  const i = await openTestPrinter()
  openHandles.push(i)
  return i
}
const target = (port: number) => ({ connection: 'network' as const, address: '127.0.0.1', port })
const testBytes = () => {
  const format = { columns: 48, page: 'pc850' as const }
  return escpos(
    testLines({ printer: 'X', stations: ['Cocina'], time: '3:00 p. m.' }, format),
    format,
  )
}

describe('sendOverNetwork', () => {
  it('delivers all the bytes, in a single job, and the printer reads them', async () => {
    const p = await open()
    const bytes = testBytes()
    await sendOverNetwork(target(p.port), bytes)
    await p.wait(1)
    expect(p.received).toHaveLength(1)
    expect([...(p.received[0] as Uint8Array)]).toEqual([...bytes])
    expect(readEscpos(p.received[0] as Uint8Array).cuts).toBe(1)
  })

  it('delivers a large document (500 KB) without loss', async () => {
    const p = await open()
    const large = Uint8Array.from({ length: 500_000 }, (_, i) => 0x20 + (i % 90))
    await sendOverNetwork(target(p.port), large)
    await p.wait(1)
    expect(p.received[0]?.length).toBe(500_000)
    expect([...(p.received[0] as Uint8Array).slice(0, 5)]).toEqual([...large.slice(0, 5)])
    expect(p.received[0]?.at(-1)).toBe(large.at(-1))
  })

  it('several concurrent sends arrive complete and separate', async () => {
    const p = await open()
    const bytes = testBytes()
    await Promise.all(Array.from({ length: 6 }, () => sendOverNetwork(target(p.port), bytes)))
    await p.wait(6)
    expect(p.received).toHaveLength(6)
    for (const r of p.received) expect(r.length).toBe(bytes.length)
  })

  it('an empty send does not blow up', async () => {
    const p = await open()
    await sendOverNetwork(target(p.port), new Uint8Array())
    await p.wait(1)
    expect(p.received[0]?.length).toBe(0)
  })

  it('with the printer off it fails with a message for the register, and works again once turned on', async () => {
    const p = await open()
    await p.shutDown(true)
    const error = await sendOverNetwork(target(p.port), testBytes()).catch((e) => e)
    expect(error).toBeInstanceOf(PrinterError)
    expect(error.message).toBe(
      'La impresora rechazó la conexión: revisa el puerto (casi siempre 9100).',
    )
    await p.shutDown(false)
    await sendOverNetwork(target(p.port), testBytes())
    await p.wait(1)
    expect(p.received).toHaveLength(1)
  })

  it('USB printers cannot be used yet and say so', async () => {
    const error = await sendOverNetwork(
      { connection: 'usb', address: 'POS-80', port: null },
      testBytes(),
    ).catch((e) => e)
    expect(error).toBeInstanceOf(PrinterError)
    expect(error.message).toMatch(/USB/)
  })

  it('a name that does not exist fails with a clear message (does not hang)', async () => {
    const error = await sendOverNetwork(
      { connection: 'network', address: 'no-existe.invalid', port: 9100 },
      testBytes(),
    ).catch((e) => e)
    expect(error).toBeInstanceOf(PrinterError)
    expect(error.message).toMatch(/dirección|impresora/i)
  })
})

describe('the queue against real sockets', () => {
  it('retries while the printer is off and prints in order when it is turned on', async () => {
    const t = setupPrinting()
    const p = await open()
    t.db
      .prepare(
        `INSERT INTO printers (id, restaurant_id, created_at, updated_at, version, name, connection, address, port, width, code_page, station_ids)
         VALUES ('01IMPRESORAREAL00000000AAA', ?, ?, ?, 9, 'Real', 'network', '127.0.0.1', ?, 80, 'pc850', ?)`,
      )
      .run(
        t.restaurantId,
        new Date(t.clock()).toISOString(),
        new Date(t.clock()).toISOString(),
        p.port,
        JSON.stringify([t.kitchen]),
      )
    const queue = new PrintQueue({
      db: t.db,
      restaurantId: t.restaurantId,
      clock: t.clock,
    })
    const ana = t.device('waiter')
    for (let i = 0; i < 3; i++) {
      const { order, items } = t.orderWith(ana, [{ name: `Plato ${i + 1}`, station: t.kitchen }])
      t.send(ana, order, items)
    }
    await p.shutDown(true)
    await queue.runOnce()
    expect(p.received).toHaveLength(0)
    expect(queue.status()[0]).toMatchObject({ status: 'failed', pendingList: 3 })
    await p.shutDown(false)
    t.advance(2000)
    await queue.runOnce()
    await p.wait(3)
    expect(p.received.map((b) => /Plato (\d)/.exec(readEscpos(b).text)?.[1])).toEqual([
      '1',
      '2',
      '3',
    ])
    expect(t.pendingList()).toBe(0)
    expect(queue.status()[0]).toMatchObject({ status: 'ready', error: null })
  })
})

describe('the test printer', () => {
  it('turning off and on keeps what was already received and the port', async () => {
    const p = await open()
    await sendOverNetwork(target(p.port), testBytes())
    await p.wait(1)
    await p.shutDown(true)
    await p.shutDown(false)
    await sendOverNetwork(target(p.port), testBytes())
    await p.wait(2)
    expect(p.received).toHaveLength(2)
  })

  it('notifies listeners of each job that arrives', async () => {
    const seenSet: number[] = []
    const p = await openTestPrinter(0, (b) => seenSet.push(b.length))
    openHandles.push(p)
    const bytes = testBytes()
    await sendOverNetwork(target(p.port), bytes)
    await p.wait(1)
    expect(seenSet).toEqual([bytes.length])
  })

  it('closing with open connections does not hang', async () => {
    const p = await openTestPrinter()
    await p.close()
    await p.close()
  })
})
