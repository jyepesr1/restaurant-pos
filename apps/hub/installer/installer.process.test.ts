import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations, MIGRATIONS } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { prepareAccess } from '../src/startup'
import { bundleHub } from './bundle'
import {
  adminFrom,
  call,
  freePort,
  type Proc,
  type Running,
  run,
  signIn,
  signInRaw,
  startHub,
  until,
} from './harness'

// The hub as the Windows service runs it (task 1.13): the bundled `hub.mjs` with DATA_DIR and
// APP_DIR, no window. What happens when the service restarts, when a second copy starts on the
// same data folder, when it is stopped with a job in the printer queue, when the admin password
// is reset, and when the data comes from the unbundled hub of another PC.

const LATEST = MIGRATIONS.length
const HUB_DIR = fileURLToPath(new URL('..', import.meta.url))

let dir: string
let hubFile: string
let resetFile: string
const folders: string[] = []
const live: Proc[] = []
const servers: Server[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'faro-installed-'))
  await bundleHub(join(dir, 'hub'))
  hubFile = join(dir, 'hub/hub.mjs')
  resetFile = join(dir, 'hub/reset.mjs')
  mkdirSync(join(dir, 'app'))
  writeFileSync(join(dir, 'app/index.html'), '<!doctype html><title>Faro</title>')
}, 120_000)

afterAll(() => rmSync(dir, { recursive: true, force: true }))

afterEach(async () => {
  for (const p of live.splice(0)) {
    p.kill('SIGKILL')
    await p.exited
  }
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true })
})

/** A new data folder (it does not exist yet, like on a PC without Faro). */
function newData(): string {
  const base = mkdtempSync(join(tmpdir(), 'faro-data-'))
  folders.push(base)
  return join(base, 'data')
}

const environment = (dataDir: string, extra: Record<string, string> = {}) => ({
  DATA_DIR: dataDir,
  APP_DIR: join(dir, 'app'),
  NODE_ENV: 'production',
  ...extra,
})

async function start(dataDir: string, extra: Record<string, string> = {}, port?: number) {
  const hub = await startHub(hubFile, environment(dataDir, extra), port)
  live.push(hub)
  return hub
}

/** Stops it the way WinSW does and checks it left cleanly. */
async function stopCleanly(hub: Running) {
  hub.kill('SIGINT')
  expect(await hub.exited, hub.output()).toBe(0)
}

const rows = (dataDir: string, sql: string) => {
  const db = openDatabase(join(dataDir, 'pos.sqlite'))
  try {
    return db.prepare(sql).all()
  } finally {
    ;(db as unknown as { close(): void }).close()
  }
}
const versionOf = (dataDir: string) =>
  Number(rows(dataDir, 'SELECT max(version) AS v FROM migrations')[0]?.v)
const count = (dataDir: string, table: string) =>
  Number(rows(dataDir, `SELECT count(*) AS n FROM ${table}`)[0]?.n)

/** A printer that records what it receives; `onData` runs when bytes arrive. */
async function fakePrinter(onData?: () => void, wanted?: number) {
  const received: Buffer[] = []
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    const chunks: Buffer[] = []
    socket.on('data', (c) => {
      chunks.push(c)
      onData?.()
    })
    socket.on('end', () => {
      received.push(Buffer.concat(chunks))
      socket.end()
    })
    socket.on('error', () => {})
  })
  const port = wanted ?? (await freePort())
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  servers.push(server)
  return {
    port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}

/** Saves a network printer on 127.0.0.1 (the hub allows it with TEST_PRINTER=1) and a test page. */
async function queueTestPage(hub: Running, dataDir: string, printerPort: number) {
  const admin = adminFrom(join(dataDir, 'admin-pin.txt'))
  const person = await signIn(hub.url, admin.user, admin.password)
  const saved = await call(person, '/api/printers', {
    printer: {
      name: 'Cocina',
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
  expect(saved.status, await saved.clone().text()).toBe(200)
  const { id } = (await saved.json()) as { id: string }
  const test = await call(person, '/api/printers/test', { printer_id: id })
  expect(test.status).toBe(201)
  return { person, printerId: id, jobId: ((await test.json()) as { job_id: string }).job_id }
}

describe('restarting the service on the same data folder', () => {
  it('keeps the data and the admin, and does not create a new admin or a new identity', async () => {
    const dataDir = newData()
    const first = await start(dataDir)
    const pinFile = join(dataDir, 'admin-pin.txt')
    expect(existsSync(pinFile)).toBe(true)
    const admin = adminFrom(pinFile)
    // The installer shows this file once and deletes it.
    rmSync(pinFile)
    expect((await signInRaw(first.url, admin.user, admin.password)).status).toBe(201)
    await stopCleanly(first)

    const before = {
      instance: readFileSync(join(dataDir, 'hub-instance'), 'utf8'),
      key: readFileSync(join(dataDir, 'pin-key')),
      users: count(dataDir, 'users'),
      roles: count(dataDir, 'roles'),
      restaurants: count(dataDir, 'restaurants'),
    }

    const second = await start(dataDir)
    expect(second.output()).toContain(`Database at version ${LATEST}.`)
    expect(second.output()).not.toContain('updated')
    expect(second.output()).not.toContain('sign-in details')
    expect(existsSync(pinFile)).toBe(false)
    expect((await signInRaw(second.url, admin.user, admin.password)).status).toBe(201)
    expect((await signInRaw(second.url, admin.user, `${admin.password}x`)).status).not.toBe(201)
    await stopCleanly(second)

    expect(readFileSync(join(dataDir, 'hub-instance'), 'utf8')).toBe(before.instance)
    expect(readFileSync(join(dataDir, 'pin-key')).equals(before.key)).toBe(true)
    expect(count(dataDir, 'users')).toBe(before.users)
    expect(count(dataDir, 'roles')).toBe(before.roles)
    expect(count(dataDir, 'restaurants')).toBe(before.restaurants)
    expect(
      rows(
        dataDir,
        "SELECT count(*) AS n FROM users WHERE role_id IN (SELECT id FROM roles WHERE name = 'Administrador')",
      )[0]?.n,
    ).toBe(1)
  })

  it('survives being killed (power cut): the next start recovers and still has the admin', async () => {
    const dataDir = newData()
    const first = await start(dataDir)
    const admin = adminFrom(join(dataDir, 'admin-pin.txt'))
    const person = await signIn(first.url, admin.user, admin.password)
    const sold = await call(person, '/api/printers', {
      printer: {
        name: 'Barra',
        connection: 'usb',
        address: 'POS-80',
        port: null,
        width: 80,
        code_page: 'pc850',
        fallback_id: null,
        station_ids: [],
        active: true,
      },
    })
    expect(sold.status).toBe(200)
    first.kill('SIGKILL')
    await first.exited

    const second = await start(dataDir)
    expect(second.output()).toContain(`Database at version ${LATEST}.`)
    // The same pending file from the first start is not rewritten with a new password.
    expect(readFileSync(join(dataDir, 'admin-pin.txt'), 'utf8')).toContain(admin.password)
    expect((await signInRaw(second.url, admin.user, admin.password)).status).toBe(201)
    await stopCleanly(second)
    expect(rows(dataDir, 'SELECT name, connection, address, port FROM printers')).toEqual([
      { name: 'Barra', connection: 'usb', address: 'POS-80', port: null },
    ])
  })

  it('stopping right after starting (before any request) still exits 0 and releases the database', async () => {
    const dataDir = newData()
    const hub = await start(dataDir)
    await stopCleanly(hub)
    // Released: another process can take it exclusively again.
    const again = await start(dataDir)
    await stopCleanly(again)
  })

  it('SIGTERM stops it cleanly too', async () => {
    const hub = await start(newData())
    hub.kill('SIGTERM')
    expect(await hub.exited, hub.output()).toBe(0)
  })
})

describe('a second copy on the same data folder', () => {
  it('fails cleanly and leaves the first one serving, with nothing changed', async () => {
    const dataDir = newData()
    const first = await start(dataDir)
    const admin = adminFrom(join(dataDir, 'admin-pin.txt'))
    rmSync(join(dataDir, 'admin-pin.txt'))
    const files = readdirSync(dataDir).sort()

    const port = await freePort()
    const second = run(hubFile, { ...environment(dataDir), CLOUD_URL: '', PORT: String(port) })
    live.push(second)
    expect(await second.exited, second.output()).toBe(1)
    expect(second.output()).toContain('Could not open the hub database')
    expect(second.output()).toContain('Another hub is already using this database')
    expect(second.output()).not.toContain('Hub running')
    // It never got to listen, and it did not write the files of a new installation.
    expect(await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null)).toBeNull()
    expect(existsSync(join(dataDir, 'admin-pin.txt'))).toBe(false)
    expect(readdirSync(dataDir).sort()).toEqual(files)

    expect((await fetch(`${first.url}/api/health`)).status).toBe(200)
    expect((await signInRaw(first.url, admin.user, admin.password)).status).toBe(201)
    await stopCleanly(first)
  })

  it('a copy on another folder but the same port says the port is taken and keeps the first intact', async () => {
    const first = await start(newData())
    const otherData = newData()
    const second = run(hubFile, {
      ...environment(otherData),
      CLOUD_URL: '',
      PORT: String(first.port),
    })
    live.push(second)
    expect(await second.exited, second.output()).toBe(1)
    expect(second.output()).toContain(`Port ${first.port} is already in use`)
    // The loser released its own database on the way out.
    expect(versionOf(otherData)).toBe(LATEST)
    expect((await fetch(`${first.url}/api/health`)).status).toBe(200)
    await stopCleanly(first)
  })

  it('a PORT that is not a port stops it with a message before touching the data', async () => {
    const dataDir = newData()
    for (const port of ['0', '70000', 'abc', '40.5', '-1']) {
      const hub = run(hubFile, { ...environment(dataDir), CLOUD_URL: '', PORT: port })
      live.push(hub)
      expect(await hub.exited, `PORT=${port}`).toBe(1)
      expect(hub.output()).toContain('Invalid PORT')
    }
    expect(existsSync(dataDir)).toBe(false)
  })
})

describe('stopping the service with a job in the printer queue', () => {
  it('with the printer off: exits 0 on time, the job stays pending and prints once when the printer is back', async () => {
    const dataDir = newData()
    // Nothing listens on this port yet: the printer is "off".
    const printerPort = await freePort()
    const first = await start(dataDir, { TEST_PRINTER: '1' })
    const { person, jobId } = await queueTestPage(first, dataDir, printerPort)
    // The queue tried and the printer refused; the register can see why.
    await until(async () => {
      const pending = (await (await call(person, '/api/printing/pending')).json()) as {
        id: string
        attempts: number
      }[]
      return pending.some((j) => j.id === jobId && j.attempts >= 1)
    }, 'the first failed attempt')
    const stopping = Date.now()
    await stopCleanly(first)
    expect(Date.now() - stopping).toBeLessThan(10_000)
    expect(rows(dataDir, `SELECT status FROM print_jobs WHERE id = '${jobId}'`)[0]?.status).toBe(
      'pending',
    )

    // The printer comes back and the PC restarts: the job goes out, once.
    const printer = await fakePrinter(undefined, printerPort)
    const second = await start(dataDir, { TEST_PRINTER: '1' })
    await until(() => printer.received.length === 1, 'the pending page reaching the printer')
    await stopCleanly(second)
    expect(rows(dataDir, `SELECT status FROM print_jobs WHERE id = '${jobId}'`)[0]?.status).toBe(
      'printed',
    )

    // A third start does not print it again.
    const third = await start(dataDir, { TEST_PRINTER: '1' })
    await stopCleanly(third)
    expect(printer.received).toHaveLength(1)
  })

  it('a job being sent when the stop arrives finishes, is recorded once and the hub exits 0', async () => {
    const dataDir = newData()
    let hub: Running | undefined
    let signalled = false
    const printer = await fakePrinter(() => {
      // The first bytes of the page are in the printer: stop the service now.
      if (!signalled) {
        signalled = true
        hub?.kill('SIGINT')
      }
    })
    hub = await start(dataDir, { TEST_PRINTER: '1' })
    const { jobId } = await queueTestPage(hub, dataDir, printer.port)
    expect(await hub.exited, hub.output()).toBe(0)
    expect(signalled).toBe(true)
    expect(
      rows(dataDir, `SELECT status, attempts FROM print_jobs WHERE id = '${jobId}'`)[0],
    ).toEqual({
      status: 'printed',
      attempts: 1,
    })
    await until(() => printer.received.length === 1, 'the page being complete')
    expect(printer.received).toHaveLength(1)
  })
})

describe('the routes of task 1.13 in the bundled hub', () => {
  it('/api/addresses lists this PC’s private addresses with the hub’s own port, without signing in', async () => {
    const hub = await start(newData())
    const r = await fetch(`${hub.url}/api/addresses`)
    expect(r.status).toBe(200)
    const { addresses } = (await r.json()) as { addresses: string[] }
    for (const a of addresses)
      expect(a).toMatch(
        new RegExp(`^http://(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.)[\\d.]+:${hub.port}$`),
      )
    expect(new Set(addresses).size).toBe(addresses.length)
    await stopCleanly(hub)
  })

  it('off Windows the printer list says it is not available, and a USB printer can be saved by name', async () => {
    const dataDir = newData()
    const hub = await start(dataDir)
    const admin = adminFrom(join(dataDir, 'admin-pin.txt'))
    const person = await signIn(hub.url, admin.user, admin.password)
    expect(await (await call(person, '/api/printers/windows')).json()).toEqual({
      available: false,
      printers: [],
    })
    const saved = await call(person, '/api/printers', {
      printer: {
        name: 'Caja USB',
        connection: 'usb',
        address: 'POS-80',
        port: null,
        width: 80,
        code_page: 'pc850',
        fallback_id: null,
        station_ids: [],
        active: true,
      },
    })
    expect(saved.status).toBe(200)
    const { id } = (await saved.json()) as { id: string }
    expect((await call(person, '/api/register/cash-drawer', { printer_id: id })).status).toBe(204)
    // The test button on a USB printer from a Mac says why it cannot, with a message to read.
    const test = await call(person, '/api/register/cash-drawer/test')
    expect(test.status).toBe(502)
    expect(((await test.json()) as { message: string }).message).toMatch(/Windows/)
    await stopCleanly(hub)
  })
})

describe('reset.mjs (a new admin password)', () => {
  it('while the hub is running it refuses and changes nothing', async () => {
    const dataDir = newData()
    const hub = await start(dataDir)
    const admin = adminFrom(join(dataDir, 'admin-pin.txt'))
    rmSync(join(dataDir, 'admin-pin.txt'))
    const before = readdirSync(dataDir).sort()

    const reset = run(resetFile, environment(dataDir))
    live.push(reset)
    expect(await reset.exited, reset.output()).toBe(1)
    expect(reset.output()).toContain('Nothing was changed: the hub is open')
    expect(readdirSync(dataDir).sort()).toEqual(before)
    // The password still works and the hub never noticed.
    expect((await signInRaw(hub.url, admin.user, admin.password)).status).toBe(201)
    await stopCleanly(hub)
  })

  it('with the hub stopped it sets a new password: the old one stops working, the new one works', async () => {
    const dataDir = newData()
    const first = await start(dataDir)
    const admin = adminFrom(join(dataDir, 'admin-pin.txt'))
    rmSync(join(dataDir, 'admin-pin.txt'))
    await stopCleanly(first)

    const reset = run(resetFile, environment(dataDir))
    live.push(reset)
    expect(await reset.exited, reset.output()).toBe(0)
    const file = readdirSync(dataDir).find((f) => /^reset-.*\.txt$/.test(f))
    expect(file).toBeDefined()
    const renewed = adminFrom(join(dataDir, file as string))
    expect(renewed.user).toBe(admin.user)
    expect(renewed.password).not.toBe(admin.password)
    // Nothing of the password goes to the log.
    expect(reset.output()).not.toContain(renewed.password)

    const second = await start(dataDir)
    expect((await signInRaw(second.url, admin.user, admin.password)).status).not.toBe(201)
    expect((await signInRaw(second.url, renewed.user, renewed.password)).status).toBe(201)
    await stopCleanly(second)
    expect(count(dataDir, 'users')).toBe(1)
  })

  it('twice in a row gives two different passwords and only the last one works', async () => {
    const dataDir = newData()
    const first = await start(dataDir)
    await stopCleanly(first)
    const passwords: string[] = []
    for (let i = 0; i < 2; i++) {
      const before = readdirSync(dataDir)
      const reset = run(resetFile, environment(dataDir))
      live.push(reset)
      expect(await reset.exited, reset.output()).toBe(0)
      const created = readdirSync(dataDir).filter(
        (f) => /^reset-.*\.txt$/.test(f) && !before.includes(f),
      )
      expect(created).toHaveLength(1)
      passwords.push(adminFrom(join(dataDir, created[0] as string)).password)
    }
    expect(passwords[0]).not.toBe(passwords[1])
    const hub = await start(dataDir)
    const user = adminFrom(
      join(dataDir, readdirSync(dataDir).find((f) => f.startsWith('reset-')) as string),
    ).user
    expect((await signInRaw(hub.url, user, passwords[0] as string)).status).not.toBe(201)
    expect((await signInRaw(hub.url, user, passwords[1] as string)).status).toBe(201)
    await stopCleanly(hub)
  })
})

describe('bringing the data of another PC (the Mac or a former register)', () => {
  /** What the installer copies: never `-shm`, never the sign-in files (`pines-*`, `admin-pin`). */
  const COPIED = ['pos.sqlite', 'pos.sqlite-wal', 'pin-key', 'hub-instance']
  const copyLikeTheInstaller = (from: string, to: string) => {
    mkdirSync(to, { recursive: true })
    for (const file of COPIED)
      if (existsSync(join(from, file))) copyFileSync(join(from, file), join(to, file))
  }

  it('a database made by the unbundled hub (killed with its WAL still there) opens in the bundle with the same admin and data', async () => {
    const source = newData()
    const port = await freePort()
    const unbundled = run(
      join(HUB_DIR, 'src/main.ts'),
      {
        ...environment(source),
        APP_DIR: join(source, 'no-app'),
        CLOUD_URL: '',
        PORT: String(port),
      },
      ['--import', 'tsx'],
      HUB_DIR,
    )
    // `run` puts the script last: tsx needs to be imported first.
    live.push(unbundled)
    await until(
      () => unbundled.output().includes('Hub running') || unbundled.hasExited(),
      'the unbundled hub',
    )
    expect(unbundled.hasExited(), unbundled.output()).toBe(false)
    const admin = adminFrom(join(source, 'admin-pin.txt'))
    const person = await signIn(`http://127.0.0.1:${port}`, admin.user, admin.password)
    const saved = await call(person, '/api/printers', {
      printer: {
        name: 'Caja del Mac',
        connection: 'usb',
        address: 'POS-80',
        port: null,
        width: 80,
        code_page: 'pc850',
        fallback_id: null,
        station_ids: [],
        active: true,
      },
    })
    expect(saved.status).toBe(200)
    unbundled.kill('SIGKILL')
    await unbundled.exited
    expect(existsSync(join(source, 'pos.sqlite-wal'))).toBe(true)

    const target = newData()
    copyLikeTheInstaller(source, target)
    const hub = await start(target)
    expect(hub.output()).toContain(`Database at version ${LATEST}.`)
    // The admin is the Mac's, not a new one: no new sign-in file.
    expect(existsSync(join(target, 'admin-pin.txt'))).toBe(false)
    expect((await signInRaw(hub.url, admin.user, admin.password)).status).toBe(201)
    await stopCleanly(hub)
    expect(rows(target, 'SELECT name, connection, address FROM printers')).toEqual([
      { name: 'Caja del Mac', connection: 'usb', address: 'POS-80' },
    ])
    expect(readFileSync(join(target, 'hub-instance'), 'utf8')).toBe(
      readFileSync(join(source, 'hub-instance'), 'utf8'),
    )
  }, 60_000)

  it('a database from before the latest migrations is brought up to date and keeps its events', async () => {
    const source = newData()
    mkdirSync(source, { recursive: true })
    const db = openDatabase(join(source, 'pos.sqlite'), { exclusive: true })
    expect(applyMigrations(db, MIGRATIONS.slice(0, 1))).toEqual([1])
    const { admin } = prepareAccess(db, source)
    expect(admin.password).toBeTruthy()
    ;(db as unknown as { close(): void }).close()

    const target = newData()
    copyLikeTheInstaller(source, target)
    expect(versionOf(target)).toBe(1)

    const hub = await start(target)
    expect(hub.output()).toContain(`Database updated to version ${LATEST}.`)
    expect(existsSync(join(target, 'admin-pin.txt'))).toBe(false)
    expect((await signInRaw(hub.url, admin.user as string, admin.password as string)).status).toBe(
      201,
    )
    await stopCleanly(hub)
    expect(versionOf(target)).toBe(LATEST)
    // The columns the migrations added are there with their default.
    expect(rows(target, 'SELECT count(*) AS n FROM events WHERE unapplied <> 0')[0]?.n).toBe(0)
  })

  it('a database newer than the program does not start and is not touched', async () => {
    const dataDir = newData()
    await stopCleanly(await start(dataDir))
    const db = openDatabase(join(dataDir, 'pos.sqlite'))
    db.prepare(
      "INSERT INTO migrations (version, name, hash, applied_at) VALUES (99, 'future', 'x', 'h')",
    ).run()
    ;(db as unknown as { close(): void }).close()
    const before = readFileSync(join(dataDir, 'pos.sqlite'))

    const hub = run(hubFile, {
      ...environment(dataDir),
      CLOUD_URL: '',
      PORT: String(await freePort()),
    })
    live.push(hub)
    expect(await hub.exited, hub.output()).toBe(1)
    expect(hub.output()).toContain('newer than this app')
    expect(readFileSync(join(dataDir, 'pos.sqlite')).equals(before)).toBe(true)
  })

  it('a pos.sqlite that is not a database stops the hub with a message and is not overwritten', async () => {
    const dataDir = newData()
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, 'pos.sqlite'),
      'this is not a database, it is a lunch menu '.repeat(50),
    )
    const before = readFileSync(join(dataDir, 'pos.sqlite'))
    const hub = run(hubFile, {
      ...environment(dataDir),
      CLOUD_URL: '',
      PORT: String(await freePort()),
    })
    live.push(hub)
    expect(await hub.exited, hub.output()).toBe(1)
    expect(hub.output()).toContain('Could not open the hub database')
    expect(readFileSync(join(dataDir, 'pos.sqlite')).equals(before)).toBe(true)
    expect(existsSync(join(dataDir, 'admin-pin.txt'))).toBe(false)
  })

  it('copying only the database (the PIN key forgotten) still starts and loses no data', async () => {
    const source = newData()
    const first = await start(source)
    const admin = adminFrom(join(source, 'admin-pin.txt'))
    await stopCleanly(first)
    const target = newData()
    mkdirSync(target, { recursive: true })
    copyFileSync(join(source, 'pos.sqlite'), join(target, 'pos.sqlite'))

    const hub = await start(target)
    expect(hub.output()).toContain(`Database at version ${LATEST}.`)
    expect((await signInRaw(hub.url, admin.user, admin.password)).status).toBe(201)
    await stopCleanly(hub)
    expect(count(target, 'restaurants')).toBe(1)
    expect(count(target, 'users')).toBe(1)
  })
})
