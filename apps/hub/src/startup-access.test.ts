import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEY_FILE } from './access/secrets'

// Access (task 0.7) with the real hub process: restarts with the same data folder, with the PIN
// key deleted or corrupted, and a device paired before restarting.

const DIR_HUB = fileURLToPath(new URL('..', import.meta.url))

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
  url: string
  stop: () => Promise<void>
}

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
          url: `http://127.0.0.1:${env.PORT}`,
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

const ADMIN_PIN_FILE = 'pin-administrador.txt'

describe('access with the real hub process', () => {
  let folder: string
  let hub: StartedHub | undefined

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'pos-acceso-'))
  })
  afterEach(async () => {
    await hub?.stop()
    hub = undefined
    rmSync(folder, { recursive: true, force: true })
  })

  const dataDir = () => join(folder, 'data')
  const pinPath = () => join(dataDir(), ADMIN_PIN_FILE)
  /**
   * The admin's user, password and authorization PIN, as the hub left them in its folder
   * (what the installer would do). Only holds what the hub has just created.
   */
  const fileData = (erase = true) => {
    const text = readFileSync(pinPath(), 'utf8')
    if (erase) rmSync(pinPath())
    const datum = (label: string) => new RegExp(`${label}:\\s+(\\S+)`).exec(text)?.[1]
    return {
      user: datum('Usuario'),
      password: datum('Contraseña'),
      pin: datum('PIN para autorizar'),
    }
  }
  const environment = async () => ({
    DATA_DIR: dataDir(),
    DIR_APP: join(folder, 'sin-app'),
    PORT: String(await freePort()),
  })
  const post = (h: StartedHub, route: string, body: object, token?: string) =>
    fetch(h.url + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  /** Signs in (with or without a token) and returns the response. */
  const signIn = (h: StartedHub, body: object, token?: string) =>
    post(h, '/api/sign-in', body, token)
  type SignInResult = { session_id: string; secret: string; device: { token: string } | null }

  it('after restarting with the same folder, the admin password and the device token still work', async () => {
    hub = await startHub(await environment())
    const { user, password } = fileData()
    const first = (await (await signIn(hub, { user, password })).json()) as SignInResult
    const token = first.device?.token as string
    await hub.stop() // shuts down abruptly, without closing anything

    hub = await startHub({ ...(await environment()), DATA_DIR: dataDir() })
    // Nothing new is shown or written: the admin already exists.
    expect(existsSync(pinPath())).toBe(false)
    expect(hub.output()).not.toMatch(/datos del administrador|Contraseña:/)
    expect(hub.output()).not.toMatch(/clave de los PIN/)
    const another = await signIn(hub, { user, password }, token)
    expect(another.status).toBe(201)
    // With the token it does not register another device.
    expect(((await another.json()) as SignInResult).device).toBeNull()
    // The previous session was closed when this one opened; its secret no longer works, but the
    // hub answers clearly.
    const close = await post(
      hub,
      '/api/sessions/close',
      { session_id: first.session_id, secret: first.secret },
      token,
    )
    expect(close.status).toBe(401)
    expect(await close.json()).toMatchObject({ error: 'invalid_session' })
  })

  it('with the key deleted: new authorization PIN and an alert on startup; the password and the device still work', async () => {
    const env = await environment()
    hub = await startHub(env)
    const initial = fileData()
    const token = (
      (await (
        await signIn(hub, { user: initial.user, password: initial.password })
      ).json()) as SignInResult
    ).device?.token as string
    await hub.stop()
    expect(existsSync(join(dataDir(), KEY_FILE))).toBe(true)
    rmSync(join(dataDir(), KEY_FILE))

    hub = await startHub({ ...env, PORT: String(await freePort()) })
    expect(hub.output()).toMatch(/Falta la clave de los PIN/)
    const newer = fileData()
    expect(newer.pin).toMatch(/^\d{4}$/)
    // The password does not depend on that key: it is not changed or shown again.
    expect(newer.password).toBeUndefined()
    expect(existsSync(join(dataDir(), KEY_FILE))).toBe(true)
    const another = await signIn(hub, { user: initial.user, password: initial.password }, token)
    expect(another.status).toBe(201)
    expect(((await another.json()) as { user: { role: string } }).user.role).toBe('Administrador')
  })

  it('a corrupted key stops startup with a clear message', async () => {
    const env = await environment()
    hub = await startHub(env)
    await hub.stop()
    hub = undefined
    writeFileSync(join(dataDir(), KEY_FILE), 'corta')

    await expect(startHub({ ...env, PORT: String(await freePort()) })).rejects.toThrow(
      /No se pudo preparar el acceso del hub.*dañada/s,
    )
  })

  it('the hub log does not write PINs, passwords or tokens, not even wrong ones', async () => {
    hub = await startHub(await environment())
    const { user, password, pin } = fileData(false)
    const r = (await (await signIn(hub, { user, password })).json()) as SignInResult
    const token = r.device?.token as string
    await signIn(hub, { pin: '0001' }, token)
    await signIn(hub, { user, password: 'otra-cualquiera' }, token)

    const output = hub.output()
    // They go to the file in the data folder (readable only by the hub), not to the screen.
    expect(output).not.toMatch(/Contraseña:\s+\S|PIN para autorizar:\s+\d/)
    expect(output).toContain(ADMIN_PIN_FILE)
    if (process.platform !== 'win32') expect(statSync(pinPath()).mode & 0o777).toBe(0o600)
    expect(pin).toMatch(/^\d{4}$/)
    expect(output).not.toContain(token)
    expect(output).not.toContain(password)
    expect(output).not.toMatch(/"pin"|pin=|"0001"|otra-cualquiera|"password"/)
  })

  it('attempt delays live in memory: after restarting the hub, you can try again', async () => {
    hub = await startHub(await environment())
    const { user, password } = fileData()
    // Without a token, the delay is per IP and per user.
    for (const bad of ['mala-1-xx', 'mala-2-xx', 'mala-3-xx'])
      await signIn(hub, { user, password: bad })
    const delay = await signIn(hub, { user, password })
    expect(delay.status).toBe(429)
    expect(Number(delay.headers.get('retry-after'))).toBeGreaterThan(0)
    await hub.stop()

    hub = await startHub({ ...(await environment()), DATA_DIR: dataDir() })
    expect((await signIn(hub, { user, password })).status).toBe(201)
  })
})
