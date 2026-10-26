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

/** Un puerto libre del sistema, para no depender del 4000 (que puede estar en uso). */
function puertoLibre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const servidor = createServer()
    servidor.once('error', reject)
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address() as { port: number }
      servidor.close(() => resolve(port))
    })
  })
}

interface HubArrancado {
  child: ChildProcess
  output: () => string
  stop: () => Promise<void>
}

/** Arranca `src/main.ts` como proceso y espera a que imprima que está en marcha (o que muera). */
function arrancarHub(env: Record<string, string>): Promise<HubArrancado> {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/main.ts'],
    { cwd: DIR_HUB, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let text = ''
  const acumular = (chunk: Buffer) => {
    text += String(chunk)
  }
  child.stdout?.on('data', acumular)
  child.stderr?.on('data', acumular)
  const terminado = new Promise<void>((resolve) => child.once('exit', () => resolve()))

  return new Promise((resolve, reject) => {
    const review = () => {
      if (text.includes('Hub en marcha')) {
        child.stdout?.off('data', review)
        resolve({
          child,
          output: () => text,
          stop: async () => {
            child.kill('SIGKILL')
            await terminado
          },
        })
      }
    }
    child.stdout?.on('data', review)
    child.once('exit', (code) =>
      reject(new Error(`El hub terminó con código ${code} antes de arrancar:\n${text}`)),
    )
  })
}

describe('arranque del hub (proceso real)', () => {
  let folder: string
  let hub: HubArrancado | undefined

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'pos-hub-'))
  })

  afterEach(async () => {
    await hub?.stop()
    hub = undefined
    rmSync(folder, { recursive: true, force: true })
  })

  const environment = async (dirDatos: string) => ({
    DATA_DIR: dirDatos,
    DIR_APP: join(folder, 'sin-app'),
    PORT: String(await puertoLibre()),
  })

  it('con DIR_DATOS en una carpeta nueva crea pos.sqlite migrada a la última versión', async () => {
    const dirDatos = join(folder, 'nueva', 'data')
    expect(existsSync(dirDatos)).toBe(false)

    hub = await arrancarHub(await environment(dirDatos))
    expect(hub.output()).toContain(`Base de datos actualizada a la versión ${LATEST}.`)
    await hub.stop()
    hub = undefined

    const route = join(dirDatos, 'pos.sqlite')
    expect(existsSync(route)).toBe(true)
    const db = openDatabase(route)
    expect(currentVersion(db)).toBe(LATEST)
    expect(applyMigrations(db)).toEqual([])
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'events'").get()?.n,
    ).toBe(1)
    ;(db as unknown as { close(): void }).close()
  })

  it('al reiniciar con la misma carpeta no migra de nuevo y conserva los datos', async () => {
    const dirDatos = join(folder, 'data')
    hub = await arrancarHub(await environment(dirDatos))
    expect(hub.output()).toContain('Los datos del administrador quedaron en')
    await hub.stop()

    hub = await arrancarHub(await environment(dirDatos))
    expect(hub.output()).toContain(`Base de datos en la versión ${LATEST}.`)
    expect(hub.output()).not.toContain('actualizada')
    // Los datos se mostraron una sola vez; el restaurante y sus roles no se duplican.
    expect(hub.output()).not.toContain('datos del administrador quedaron')
    await hub.stop()
    hub = undefined

    const after = openDatabase(join(dirDatos, 'pos.sqlite'))
    expect(after.prepare('SELECT name FROM restaurants').all()).toEqual([
      { name: 'Mi restaurante' },
    ])
    expect(after.prepare('SELECT count(*) AS n FROM roles').get()?.n).toBe(4)
    ;(after as unknown as { close(): void }).close()
  })

  it('con el usuario y la contraseña que muestra al arrancar se entra desde un navegador, sin emparejarlo', async () => {
    const env = await environment(join(folder, 'data'))
    hub = await arrancarHub(env)
    // Sin ventana (salida a un proceso, como en un servicio) los datos van a un archivo aparte.
    const archivo = readFileSync(join(env.DATA_DIR, 'pin-administrador.txt'), 'utf8')
    const datum = (etiqueta: string) =>
      new RegExp(`${etiqueta}:\\s+(\\S+)`).exec(archivo)?.[1] as string
    const url = `http://127.0.0.1:${env.PORT}`
    const entrar = await fetch(`${url}/api/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: datum('Usuario'), password: datum('Contraseña') }),
    })

    expect(entrar.status).toBe(201)
    const r = (await entrar.json()) as {
      user: { role: string }
      device: { token: string; type: string }
    }
    expect(r.user.role).toBe('Administrador')
    // El hub registró este navegador como equipo de caja y le dio su token.
    expect(r.device.type).toBe('register')
    expect(datum('PIN para autorizar')).toMatch(/^\d{4}$/)
    // El log del hub no registra los cuerpos: ni la contraseña ni el token quedan escritos.
    expect(hub.output()).not.toContain('"contrasena"')
    expect(hub.output()).not.toContain(datum('Contraseña'))
    expect(hub.output()).not.toContain(r.device.token)
  })

  it('no arranca si la base es más nueva que la aplicación', async () => {
    const dirDatos = join(folder, 'data')
    hub = await arrancarHub(await environment(dirDatos))
    await hub.stop()
    hub = undefined

    const db = openDatabase(join(dirDatos, 'pos.sqlite'))
    db.prepare(
      "INSERT INTO migrations (version, name, hash, applied_at) VALUES (99, 'futura', 'x', 'h')",
    ).run()
    ;(db as unknown as { close(): void }).close()

    await expect(arrancarHub(await environment(dirDatos))).rejects.toThrow(
      /más nueva que esta aplicación/,
    )
  })
})
