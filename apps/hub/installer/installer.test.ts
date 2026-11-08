import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appVersion, DOWNLOADS } from './build'
import { bundleHub } from './bundle'

// The installed hub runs from a bundle, not from the TypeScript sources: these tests build it and
// start it as the Windows service does (DATA_DIR, APP_DIR, no window), so a dependency that does
// not survive bundling fails here and not on the register PC.

const here = (path: string) => fileURLToPath(new URL(`./${path}`, import.meta.url))
const read = (path: string) => readFileSync(here(path), 'utf8')

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })

describe('installer files', () => {
  it('reads the app version that names the installer', () => {
    expect(appVersion("export const VERSION_APP = '0.11'\n")).toBe('0.11')
    expect(appVersion(read('../../pos/src/floor/engine.ts'))).toMatch(/^\d+\.\d+$/)
    expect(() => appVersion('const VERSION = 1')).toThrow('VERSION_APP')
  })

  it('pins every download to an https URL and a SHA-256', () => {
    for (const item of Object.values(DOWNLOADS)) {
      expect(item.url).toMatch(/^https:\/\//)
      expect(item.url).toContain(item.version)
      expect(item.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('the service and the installer agree on names, port and folders', () => {
    const service = read('faro-hub.xml')
    const nsis = read('faro.nsi')
    expect(service).toContain('<id>faro-hub</id>')
    expect(nsis).toContain('!define SERVICE "faro-hub"')
    // The hub reads these variables (startup.ts and main.ts).
    expect(service).toContain('<env name="DATA_DIR" value="%ProgramData%\\Faro\\data"/>')
    expect(service).toContain('<env name="APP_DIR" value="%BASE%\\app"/>')
    expect(nsis).toContain('StrCpy $Data "$APPDATA\\Faro\\data"')
    expect(read('../src/main.ts')).toContain('const DEFAULT_PORT = 4000')
    expect(nsis).toContain('!define PORT "4000"')
    expect(read('tools/reset-admin.cmd')).toContain('set "DATA_DIR=%ProgramData%\\Faro\\data"')
  })

  it('never copies the sign-in files of the other register PC', () => {
    const copies = read('faro.nsi')
      .split('\n')
      .filter((line) => line.includes('CopyFiles'))
    expect(copies.length).toBeGreaterThan(0)
    for (const line of copies) expect(line).not.toMatch(/pines|admin-pin|\$ImportDir\\\*/)
  })
})

describe('bundled hub', () => {
  let dir: string
  let hub: ChildProcess | null = null
  let output = ''

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faro-bundle-'))
    await bundleHub(join(dir, 'hub'))
    mkdirSync(join(dir, 'app'))
    writeFileSync(join(dir, 'app/index.html'), '<!doctype html><title>Faro</title>')
  }, 120_000)

  afterAll(() => {
    hub?.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  })

  const environment = (port: number) => ({
    ...process.env,
    DATA_DIR: join(dir, 'data'),
    APP_DIR: join(dir, 'app'),
    PORT: String(port),
    CLOUD_URL: '',
  })

  it('starts like the service, serves the app and stops cleanly', async () => {
    const port = await freePort()
    hub = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', join(dir, 'hub/hub.mjs')],
      { env: environment(port), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    hub.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    hub.stderr?.on('data', (chunk) => {
      output += String(chunk)
    })
    const exited = new Promise<number | null>((resolve) => hub?.once('exit', resolve))

    let health: Response | null = null
    for (let i = 0; i < 100 && !health; i++) {
      health = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null)
      if (!health) await new Promise((r) => setTimeout(r, 200))
    }
    expect(health?.status, output).toBe(200)
    expect(await health?.json()).toMatchObject({ status: 'ok', service: 'hub' })
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('<title>Faro</title>')

    // With no window, the new admin's details go to a file the installer shows and deletes.
    for (let i = 0; i < 50 && !output.includes('Hub running'); i++)
      await new Promise((r) => setTimeout(r, 100))
    expect(existsSync(join(dir, 'data/admin-pin.txt')), output).toBe(true)
    expect(output).not.toMatch(/Password:/)

    // WinSW stops the service with Ctrl+C, which Node receives as SIGINT.
    hub.kill('SIGINT')
    expect(await exited, output).toBe(0)
    hub = null
  }, 60_000)

  it('gives the admin a new password with the hub stopped', () => {
    const before = readdirSync(join(dir, 'data'))
    const result = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', join(dir, 'hub/reset.mjs')],
      { env: environment(1), encoding: 'utf8' },
    )
    expect(result.status, result.stderr).toBe(0)
    const created = readdirSync(join(dir, 'data')).filter((f) => !before.includes(f))
    expect(created.some((f) => /^reset-.*\.txt$/.test(f))).toBe(true)
  })
})
