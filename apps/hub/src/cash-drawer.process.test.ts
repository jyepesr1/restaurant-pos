import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId, signEvent } from '@pos/core'
import { drawerPulse } from '@pos/printing'
import type { HubMessage } from '@pos/sync'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  adminFrom,
  call,
  freePort,
  type Person,
  type Proc,
  run,
  signIn,
  until,
} from '../installer/harness'
import { item, OPEN_ORDER } from './access/hub-setup'

// The real hub process (`src/main.ts`) with a fake printer on a local port: the wiring that only
// exists in `main.ts` (every saved event goes to the drawer once it is stored; a failure is logged
// and the hub keeps working; closing the hub waits for the pulse), driven the way a register does
// it, through the sync WebSocket with signed events. Task 1.13.

const HUB_DIR = fileURLToPath(new URL('..', import.meta.url))
const PULSE = Buffer.from(drawerPulse())

let folder: string
let hub: (Proc & { url: string; port: number; dataDir: string }) | undefined
const servers: Server[] = []
const sockets: WebSocket[] = []

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'faro-drawer-process-'))
})
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close()
  hub?.kill('SIGKILL')
  await hub?.exited
  hub = undefined
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  rmSync(folder, { recursive: true, force: true })
})

async function startHub() {
  const port = await freePort()
  const dataDir = join(folder, 'data')
  const proc = run(
    join(HUB_DIR, 'src/main.ts'),
    {
      DATA_DIR: dataDir,
      APP_DIR: join(folder, 'no-app'),
      PORT: String(port),
      CLOUD_URL: '',
      TEST_PRINTER: '1',
    },
    ['--import', 'tsx'],
    HUB_DIR,
  )
  await until(() => proc.output().includes('Hub running') || proc.hasExited(), 'the hub', 30_000)
  if (proc.hasExited()) throw new Error(`The hub exited:\n${proc.output()}`)
  hub = { ...proc, url: `http://127.0.0.1:${port}`, port, dataDir }
  return hub
}

/** A printer that records what each connection sent. */
async function fakePrinter(port?: number) {
  const received: Buffer[] = []
  const open = new Set<Socket>()
  const server = createServer((socket) => {
    open.add(socket)
    const chunks: Buffer[] = []
    socket.on('data', (c) => chunks.push(c))
    socket.on('end', () => {
      received.push(Buffer.concat(chunks))
      socket.end()
    })
    socket.on('close', () => open.delete(socket))
    socket.on('error', () => {})
  })
  const chosen = port ?? (await freePort())
  await new Promise<void>((resolve) => server.listen(chosen, '127.0.0.1', resolve))
  servers.push(server)
  return { port: chosen, received, pulses: () => received.filter((b) => b.equals(PULSE)).length }
}

async function admin(h: { url: string; dataDir: string }): Promise<Person> {
  const details = adminFrom(join(h.dataDir, 'admin-pin.txt'))
  return signIn(h.url, details.user, details.password)
}

/** Saves a printer, chooses it for the drawer, and returns its id. */
async function chooseDrawer(p: Person, printerPort: number) {
  const saved = await call(p, '/api/printers', {
    printer: {
      name: 'Caja',
      connection: 'network',
      address: '127.0.0.1',
      port: printerPort,
      width: 80,
      code_page: 'pc850',
      fallback_id: null,
      station_ids: [],
      active: true,
    },
  })
  expect(saved.status).toBe(200)
  const { id } = (await saved.json()) as { id: string }
  expect((await call(p, '/api/register/cash-drawer', { printer_id: id })).status).toBe(204)
  return id
}

/** The register's sync connection: sends signed events and collects the answers. */
async function register(p: Person) {
  const received: HubMessage[] = []
  const ws = new WebSocket(`ws://${p.url.replace('http://', '')}/api/sync/ws`)
  sockets.push(ws)
  ws.onmessage = (m) => received.push(JSON.parse(String(m.data)))
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('The WebSocket did not open'))
  })
  ws.send(
    JSON.stringify({
      type: 'hello',
      token: p.token,
      hub_instance: null,
      until: 0,
      version_app: 't',
    }),
  )
  let batches = 0
  const event = (
    aggregateType: 'order' | 'register_shift',
    aggregateId: string,
    type: string,
    data: unknown,
    extra: Record<string, unknown> = {},
  ) => {
    const now = new Date().toISOString()
    const base = {
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      related: [],
      data,
      session_id: p.sessionId,
      user_id: p.userId,
      device_id: p.deviceId,
      authorization_id: null,
      reason: null,
      device_time: now,
      hub_estimated_time: now,
      base_sequence: 0,
      ...extra,
    }
    return { ...base, signature: signEvent(base as never, p.secret) }
  }
  const push = (...events: object[]) => {
    batches += 1
    ws.send(JSON.stringify({ type: 'push', batch_id: `b${batches}`, events }))
  }
  const answers = () =>
    received.flatMap((m) =>
      m.type === 'result' ? m.results.map((x) => x as { id: string; status: string }) : [],
    )
  /** Sends events and waits until the hub answers each one; returns how each was answered. */
  const send = async (...events: { id: string }[]) => {
    push(...events)
    await until(
      () => events.every((e) => answers().some((a) => a.id === e.id)),
      'the hub answering the events',
    )
    return events.map((e) => answers().find((a) => a.id === e.id)?.status)
  }
  return { ws, received, event, push, send, answers }
}

const movement = (type: 'cash_in' | 'cash_out' = 'cash_out') => ({
  movement_id: newId(),
  type,
  amount: 5_000,
  description: 'Hielo',
  to_whom: null,
  days: [],
})

/** A shift opened by this register, so there is a drawer to open. */
async function openShift(r: Awaited<ReturnType<typeof register>>, p: Person) {
  const shift = newId()
  expect(
    await r.send(
      r.event('register_shift', shift, 'ShiftOpened', { register_id: p.deviceId, base: 100_000 }),
    ),
  ).toEqual(['confirmed'])
  return shift
}

type Register = Awaited<ReturnType<typeof register>>
const cashMovement = (
  r: Register,
  shift: string,
  type: 'cash_in' | 'cash_out' = 'cash_out',
  extra = {},
) => r.event('register_shift', shift, 'CashMovementRecorded', movement(type), extra)

describe('the hub process opens the drawer', () => {
  it('on a cash movement and on a cash payment, not on another method; one pulse each', async () => {
    const h = await startHub()
    const printer = await fakePrinter()
    const p = await admin(h)
    await chooseDrawer(p, printer.port)
    const r = await register(p)
    const shift = await openShift(r, p)

    expect(await r.send(cashMovement(r, shift))).toEqual(['confirmed'])
    await until(() => printer.pulses() === 1, 'the pulse for the cash movement')

    // A sale: open the order, add an item, pay part by Nequi (no pulse) and part in cash (pulse).
    const order = newId()
    const sale = { ...item(), unit_price: 40_000 }
    expect(
      await r.send(
        r.event('order', order, 'OrderOpened', OPEN_ORDER),
        r.event('order', order, 'ItemAdded', sale, { base_sequence: 1 }),
      ),
    ).toEqual(['confirmed', 'confirmed'])
    const pay = (method: 'cash' | 'nequi', amount: number) => ({
      payment_id: newId(),
      check_id: null,
      register_shift_id: shift,
      method,
      amount,
      tip: 0,
      tendered: method === 'cash' ? amount : null,
      change: method === 'cash' ? 0 : null,
      rounding_adjustment: 0,
      rounding: null,
      cardTerminal: null,
      charge_reference: null,
    })
    expect(
      await r.send(
        r.event('order', order, 'PaymentRecorded', pay('nequi', 10_000), { base_sequence: 2 }),
      ),
    ).toEqual(['confirmed'])
    expect(
      await r.send(
        r.event('order', order, 'PaymentRecorded', pay('cash', 30_000), { base_sequence: 3 }),
      ),
    ).toEqual(['confirmed'])
    await until(() => printer.pulses() === 2, 'the pulse for the cash payment')

    // Events are processed in order: when the last pulse is there, the Nequi payment had its turn.
    expect(await r.send(cashMovement(r, shift, 'cash_in'))).toEqual(['confirmed'])
    await until(() => printer.pulses() === 3, 'the last pulse')
    expect(printer.received).toHaveLength(3)
    expect(printer.received.every((b) => b.equals(PULSE))).toBe(true)
  })

  it('an event resent on a new connection (after a reconnection) does not open it again', async () => {
    const h = await startHub()
    const printer = await fakePrinter()
    const p = await admin(h)
    await chooseDrawer(p, printer.port)
    const first = await register(p)
    const shift = await openShift(first, p)
    const cash = cashMovement(first, shift)
    expect(await first.send(cash)).toEqual(['confirmed'])
    await until(() => printer.pulses() === 1, 'the first pulse')
    first.ws.close()

    const second = await register(p)
    expect(await second.send(cash)).toEqual(['confirmed'])
    expect(await second.send(cash, cash)).toEqual(['confirmed', 'confirmed'])
    // A distinct event after the resends: when its pulse is there, the resends had their turn.
    expect(await second.send(cashMovement(second, shift, 'cash_in'))).toEqual(['confirmed'])
    await until(() => printer.pulses() === 2, 'the pulse of the new event')
    expect(printer.received).toHaveLength(2)
  })

  it('after a restart of the hub, a register resending what it already sent opens nothing', async () => {
    let h = await startHub()
    const printer = await fakePrinter()
    const p = await admin(h)
    await chooseDrawer(p, printer.port)
    const r = await register(p)
    const shift = await openShift(r, p)
    const cash = cashMovement(r, shift)
    expect(await r.send(cash)).toEqual(['confirmed'])
    await until(() => printer.pulses() === 1, 'the first pulse')
    r.ws.close()
    h.kill('SIGINT')
    expect(await h.exited).toBe(0)

    h = await startHub()
    // Signed in again: a new device. The old register's events are resent from its own token.
    const same = await register({ ...p, url: h.url })
    expect(await same.send(cash)).toEqual(['confirmed'])
    // And a new device with its own shift, to show the drawer still works after the restart.
    const p2 = await admin(h)
    const fresh = await register(p2)
    const shift2 = await openShift(fresh, p2)
    expect(await fresh.send(cashMovement(fresh, shift2))).toEqual(['confirmed'])
    await until(() => printer.pulses() === 2, 'the pulse of the new event after the restart')
    expect(printer.received).toHaveLength(2)
  })

  it('with no drawer chosen nothing is sent; choosing one starts it; removing it stops it', async () => {
    const h = await startHub()
    const printer = await fakePrinter()
    const p = await admin(h)
    const r = await register(p)
    const shift = await openShift(r, p)
    // No drawer: stored, answered, nothing sent.
    expect(await r.send(cashMovement(r, shift))).toEqual(['confirmed'])
    const id = await chooseDrawer(p, printer.port)
    expect(await r.send(cashMovement(r, shift, 'cash_in'))).toEqual(['confirmed'])
    await until(() => printer.pulses() === 1, 'the pulse after choosing')
    // Removed: stored, answered, nothing sent.
    expect((await call(p, '/api/register/cash-drawer', { printer_id: null })).status).toBe(204)
    expect(await r.send(cashMovement(r, shift, 'cash_in'))).toEqual(['confirmed'])
    // Chosen again: the next one comes out, and the one in between never did.
    expect((await call(p, '/api/register/cash-drawer', { printer_id: id })).status).toBe(204)
    expect(await r.send(cashMovement(r, shift, 'cash_in'))).toEqual(['confirmed'])
    await until(() => printer.pulses() === 2, 'the pulse after choosing it again')
    expect(printer.received).toHaveLength(2)
  })

  it('the test button opens it through the real route', async () => {
    const h = await startHub()
    const printer = await fakePrinter()
    const p = await admin(h)
    expect((await call(p, '/api/register/cash-drawer/test')).status).toBe(400)
    await chooseDrawer(p, printer.port)
    expect((await call(p, '/api/register/cash-drawer/test')).status).toBe(204)
    await until(() => printer.pulses() === 1, 'the test pulse')
  })
})

describe('when the printer is off', () => {
  it('the hub logs it once, keeps serving, and the next pulse works when the printer is back', async () => {
    const h = await startHub()
    const printerPort = await freePort()
    const p = await admin(h)
    await chooseDrawer(p, printerPort)
    const r = await register(p)
    const shift = await openShift(r, p)
    expect(await r.send(cashMovement(r, shift))).toEqual(['confirmed'])
    await until(() => h.output().includes('The cash drawer did not open'), 'the failure in the log')
    expect((await fetch(`${h.url}/api/health`)).status).toBe(200)
    expect(h.output().match(/The cash drawer did not open/g)).toHaveLength(1)

    const printer = await fakePrinter(printerPort)
    expect(await r.send(cashMovement(r, shift, 'cash_in'))).toEqual(['confirmed'])
    await until(() => printer.pulses() === 1, 'the pulse once the printer is back')
    // Nothing from the failed one comes out later.
    expect(printer.received).toHaveLength(1)
  })

  it('stopping the hub while the retry is pending exits 0 in time, and does not leave a late pulse', async () => {
    const h = await startHub()
    const printerPort = await freePort()
    const p = await admin(h)
    await chooseDrawer(p, printerPort)
    const r = await register(p)
    const shift = await openShift(r, p)
    expect(await r.send(cashMovement(r, shift))).toEqual(['confirmed'])
    // The first attempt is refused (nothing listens) and the retry is 1.5 s away: stop now.
    const started = Date.now()
    h.kill('SIGINT')
    expect(await h.exited, h.output()).toBe(0)
    expect(Date.now() - started).toBeLessThan(15_000)
  })
})
