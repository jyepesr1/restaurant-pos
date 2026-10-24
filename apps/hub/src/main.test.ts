import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aplicarMigraciones, MIGRACIONES, versionActual } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const DIR_HUB = fileURLToPath(new URL('..', import.meta.url))
const ULTIMA = MIGRACIONES.length

/** Un puerto libre del sistema, para no depender del 4000 (que puede estar en uso). */
function puertoLibre(): Promise<number> {
  return new Promise((resolver, rechazar) => {
    const servidor = createServer()
    servidor.once('error', rechazar)
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address() as { port: number }
      servidor.close(() => resolver(port))
    })
  })
}

interface HubArrancado {
  hijo: ChildProcess
  salida: () => string
  detener: () => Promise<void>
}

/** Arranca `src/main.ts` como proceso y espera a que imprima que está en marcha (o que muera). */
function arrancarHub(env: Record<string, string>): Promise<HubArrancado> {
  const hijo = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/main.ts'],
    { cwd: DIR_HUB, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let texto = ''
  const acumular = (trozo: Buffer) => {
    texto += String(trozo)
  }
  hijo.stdout?.on('data', acumular)
  hijo.stderr?.on('data', acumular)
  const terminado = new Promise<void>((resolver) => hijo.once('exit', () => resolver()))

  return new Promise((resolver, rechazar) => {
    const revisar = () => {
      if (texto.includes('Hub en marcha')) {
        hijo.stdout?.off('data', revisar)
        resolver({
          hijo,
          salida: () => texto,
          detener: async () => {
            hijo.kill('SIGKILL')
            await terminado
          },
        })
      }
    }
    hijo.stdout?.on('data', revisar)
    hijo.once('exit', (codigo) =>
      rechazar(new Error(`El hub terminó con código ${codigo} antes de arrancar:\n${texto}`)),
    )
  })
}

describe('arranque del hub (proceso real)', () => {
  let carpeta: string
  let hub: HubArrancado | undefined

  beforeEach(() => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-hub-'))
  })

  afterEach(async () => {
    await hub?.detener()
    hub = undefined
    rmSync(carpeta, { recursive: true, force: true })
  })

  const entorno = async (dirDatos: string) => ({
    DIR_DATOS: dirDatos,
    DIR_APP: join(carpeta, 'sin-app'),
    PUERTO: String(await puertoLibre()),
  })

  it('con DIR_DATOS en una carpeta nueva crea pos.sqlite migrada a la última versión', async () => {
    const dirDatos = join(carpeta, 'nueva', 'datos')
    expect(existsSync(dirDatos)).toBe(false)

    hub = await arrancarHub(await entorno(dirDatos))
    expect(hub.salida()).toContain(`Base de datos actualizada a la versión ${ULTIMA}.`)
    await hub.detener()
    hub = undefined

    const ruta = join(dirDatos, 'pos.sqlite')
    expect(existsSync(ruta)).toBe(true)
    const db = abrirBase(ruta)
    expect(versionActual(db)).toBe(ULTIMA)
    expect(aplicarMigraciones(db)).toEqual([])
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'evento'").get()?.n,
    ).toBe(1)
    ;(db as unknown as { close(): void }).close()
  })

  it('al reiniciar con la misma carpeta no migra de nuevo y conserva los datos', async () => {
    const dirDatos = join(carpeta, 'datos')
    hub = await arrancarHub(await entorno(dirDatos))
    expect(hub.salida()).toContain('El PIN del administrador quedó en')
    await hub.detener()

    hub = await arrancarHub(await entorno(dirDatos))
    expect(hub.salida()).toContain(`Base de datos en la versión ${ULTIMA}.`)
    expect(hub.salida()).not.toContain('actualizada')
    // El PIN se mostró una sola vez; el restaurante y sus roles no se duplican.
    expect(hub.salida()).not.toContain('PIN del administrador quedó')
    await hub.detener()
    hub = undefined

    const despues = abrirBase(join(dirDatos, 'pos.sqlite'))
    expect(despues.prepare('SELECT nombre FROM restaurante').all()).toEqual([
      { nombre: 'Mi restaurante' },
    ])
    expect(despues.prepare('SELECT count(*) AS n FROM rol').get()?.n).toBe(6)
    ;(despues as unknown as { close(): void }).close()
  })

  it('con el PIN que muestra al arrancar se empareja la caja y se entra', async () => {
    const env = await entorno(join(carpeta, 'datos'))
    hub = await arrancarHub(env)
    // Sin ventana (salida a un proceso, como en un servicio) el PIN va a un archivo aparte.
    const pin = readFileSync(join(env.DIR_DATOS, 'pin-administrador.txt'), 'utf8').trim()
    const url = `http://127.0.0.1:${env.PUERTO}`
    const post = (ruta: string, cuerpo: object, token?: string) =>
      fetch(url + ruta, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(cuerpo),
      })

    const json = async (r: Promise<Response>) => (await (await r).json()) as Record<string, string>
    const codigo = await json(post('/api/emparejamientos', { pin, nombre: 'Caja', tipo: 'caja' }))
    const { token } = await json(post('/api/emparejar', { codigo: codigo.codigo }))
    const sesion = await post('/api/sesiones', { pin }, token)

    expect(sesion.status).toBe(201)
    expect(((await sesion.json()) as { usuario: { rol: string } }).usuario.rol).toBe(
      'Administrador',
    )
    // El log del hub no registra los cuerpos: ni el PIN ni el token quedan escritos.
    expect(hub.salida()).not.toContain('"pin"')
    expect(hub.salida()).not.toContain(token)
  })

  it('no arranca si la base es más nueva que la aplicación', async () => {
    const dirDatos = join(carpeta, 'datos')
    hub = await arrancarHub(await entorno(dirDatos))
    await hub.detener()
    hub = undefined

    const db = abrirBase(join(dirDatos, 'pos.sqlite'))
    db.prepare(
      "INSERT INTO migracion (version, nombre, hash, aplicada_en) VALUES (99, 'futura', 'x', 'h')",
    ).run()
    ;(db as unknown as { close(): void }).close()

    await expect(arrancarHub(await entorno(dirDatos))).rejects.toThrow(
      /más nueva que esta aplicación/,
    )
  })
})
