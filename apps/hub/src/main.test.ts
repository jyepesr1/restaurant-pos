import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations, currentVersion, MIGRATIONS } from '@pos/db'
import { openDatabase } from '@pos/db/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const DIR_HUB = fileURLToPath(new URL('..', import.meta.url))
const LATEST = MIGRATIONS.length

/** A free system port, so as not to depend on 4000 (which may be in use). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

interface StartedHub {
  child: ChildProcess
  output: () => string
  stop: () => Promise<void>
}

/** Starts `src/main.ts` as a process and waits until it prints that it is running (or dies). */
function startHub(env: Record<string, string>): Promise<StartedHub> {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/main.ts'],
    { cwd: DIR_HUB, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let text = ''
  const accumulate = (chunk: Buffer) => {
    text += String(chunk)
  }
  child.stdout?.on('data', accumulate)
  child.stderr?.on('data', accumulate)
  const finished = new Promise<void>((resolve) => child.once('exit', () => resolve()))

  return new Promise((resolve, reject) => {
    const review = () => {
      if (text.includes('Hub en marcha')) {
        child.stdout?.off('data', review)
        resolve({
          child,
          output: () => text,
          stop: async () => {
            child.kill('SIGKILL')
            await finished
          },
        })
      }
    }
    child.stdout?.on('data', review)
    child.once('exit', (code) =>
      reject(new Error(`The hub exited with code ${code} before starting:\n${text}`)),
    )
  })
}

describe('hub startup (real process)', () => {
  let folder: string
  let hub: StartedHub | undefined

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'pos-hub-'))
  })

  afterEach(async () => {
    await hub?.stop()
    hub = undefined
    rmSync(folder, { recursive: true, force: true })
  })

  const environment = async (dataDir: string) => ({
    DATA_DIR: dataDir,
    DIR_APP: join(folder, 'sin-app'),
    PORT: String(await freePort()),
  })

  it('with DATA_DIR in a new folder it creates pos.sqlite migrated to the latest version', async () => {
    const dataDir = join(folder, 'nueva', 'data')
    expect(existsSync(dataDir)).toBe(false)

    hub = await startHub(await environment(dataDir))
    expect(hub.output()).toContain(`Base de datos actualizada a la versión ${LATEST}.`)
    await hub.stop()
    hub = undefined

    const route = join(dataDir, 'pos.sqlite')
    expect(existsSync(route)).toBe(true)
    const db = openDatabase(route)
    expect(currentVersion(db)).toBe(LATEST)
    expect(applyMigrations(db)).toEqual([])
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'events'").get()?.n,
    ).toBe(1)
    ;(db as unknown as { close(): void }).close()
  })

  it('restarting with the same folder does not migrate again and keeps the data', async () => {
    const dataDir = join(folder, 'data')
    hub = await startHub(await environment(dataDir))
    expect(hub.output()).toContain('Los datos del administrador quedaron en')
    await hub.stop()

    hub = await startHub(await environment(dataDir))
    expect(hub.output()).toContain(`Base de datos en la versión ${LATEST}.`)
    expect(hub.output()).not.toContain('actualizada')
    // The credentials were shown only once; the restaurant and its roles are not duplicated.
    expect(hub.output()).not.toContain('datos del administrador quedaron')
    await hub.stop()
    hub = undefined

    const after = openDatabase(join(dataDir, 'pos.sqlite'))
    expect(after.prepare('SELECT name FROM restaurants').all()).toEqual([
      { name: 'Mi restaurante' },
    ])
    expect(after.prepare('SELECT count(*) AS n FROM roles').get()?.n).toBe(4)
    ;(after as unknown as { close(): void }).close()
  })

  it('the user and password shown at startup sign in from a browser, without pairing it', async () => {
    const env = await environment(join(folder, 'data'))
    hub = await startHub(env)
    // Without a window (output to a process, as in a service) the credentials go to a separate file.
    const file = readFileSync(join(env.DATA_DIR, 'pin-administrador.txt'), 'utf8')
    const datum = (label: string) => new RegExp(`${label}:\\s+(\\S+)`).exec(file)?.[1] as string
    const url = `http://127.0.0.1:${env.PORT}`
    const signIn = await fetch(`${url}/api/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: datum('Usuario'), password: datum('Contraseña') }),
    })

    expect(signIn.status).toBe(201)
    const r = (await signIn.json()) as {
      user: { role: string }
      device: { token: string; type: string }
    }
    expect(r.user.role).toBe('Administrador')
    // The hub registered this browser as a register device and gave it its token.
    expect(r.device.type).toBe('register')
    expect(datum('PIN para autorizar')).toMatch(/^\d{4}$/)
    // The hub log does not record bodies: neither the password nor the token gets written.
    expect(hub.output()).not.toContain('"password"')
    expect(hub.output()).not.toContain(datum('Contraseña'))
    expect(hub.output()).not.toContain(r.device.token)
  })

  it('does not start if the database is newer than the application', async () => {
    const dataDir = join(folder, 'data')
    hub = await startHub(await environment(dataDir))
    await hub.stop()
    hub = undefined

    const db = openDatabase(join(dataDir, 'pos.sqlite'))
    db.prepare(
      "INSERT INTO migrations (version, name, hash, applied_at) VALUES (99, 'futura', 'x', 'h')",
    ).run()
    ;(db as unknown as { close(): void }).close()

    await expect(startHub(await environment(dataDir))).rejects.toThrow(
      /más nueva que esta aplicación/,
    )
  })
})
