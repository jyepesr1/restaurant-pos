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
    expect(hub.salida()).toContain('Los datos del administrador quedaron en')
    await hub.detener()

    hub = await arrancarHub(await entorno(dirDatos))
    expect(hub.salida()).toContain(`Base de datos en la versión ${ULTIMA}.`)
    expect(hub.salida()).not.toContain('actualizada')
    // Los datos se mostraron una sola vez; el restaurante y sus roles no se duplican.
    expect(hub.salida()).not.toContain('datos del administrador quedaron')
    await hub.detener()
    hub = undefined

    const despues = abrirBase(join(dirDatos, 'pos.sqlite'))
    expect(despues.prepare('SELECT nombre FROM restaurante').all()).toEqual([
      { nombre: 'Mi restaurante' },
    ])
    expect(despues.prepare('SELECT count(*) AS n FROM rol').get()?.n).toBe(4)
    ;(despues as unknown as { close(): void }).close()
  })

  it('con el usuario y la contraseña que muestra al arrancar se entra desde un navegador, sin emparejarlo', async () => {
    const env = await entorno(join(carpeta, 'datos'))
    hub = await arrancarHub(env)
    // Sin ventana (salida a un proceso, como en un servicio) los datos van a un archivo aparte.
    const archivo = readFileSync(join(env.DIR_DATOS, 'pin-administrador.txt'), 'utf8')
    const dato = (etiqueta: string) =>
      new RegExp(`${etiqueta}:\\s+(\\S+)`).exec(archivo)?.[1] as string
    const url = `http://127.0.0.1:${env.PUERTO}`
    const entrar = await fetch(`${url}/api/entrar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usuario: dato('Usuario'), contrasena: dato('Contraseña') }),
    })

    expect(entrar.status).toBe(201)
    const r = (await entrar.json()) as {
      usuario: { rol: string }
      equipo: { token: string; tipo: string }
    }
    expect(r.usuario.rol).toBe('Administrador')
    // El hub registró este navegador como equipo de caja y le dio su token.
    expect(r.equipo.tipo).toBe('caja')
    expect(dato('PIN para autorizar')).toMatch(/^\d{4}$/)
    // El log del hub no registra los cuerpos: ni la contraseña ni el token quedan escritos.
    expect(hub.salida()).not.toContain('"contrasena"')
    expect(hub.salida()).not.toContain(dato('Contraseña'))
    expect(hub.salida()).not.toContain(r.equipo.token)
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
