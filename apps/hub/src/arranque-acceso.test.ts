import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ARCHIVO_CLAVE } from './acceso/secretos'

// El acceso (tarea 0.7) con el proceso real del hub: reinicios con la misma carpeta de datos, con
// la clave de los PIN borrada o dañada, y un dispositivo emparejado antes de reiniciar.

const DIR_HUB = fileURLToPath(new URL('..', import.meta.url))

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
  url: string
  detener: () => Promise<void>
}

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
          url: `http://127.0.0.1:${env.PUERTO}`,
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

const ARCHIVO_PIN_ADMIN = 'pin-administrador.txt'

describe('acceso con el proceso real del hub', () => {
  let carpeta: string
  let hub: HubArrancado | undefined

  beforeEach(() => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-acceso-'))
  })
  afterEach(async () => {
    await hub?.detener()
    hub = undefined
    rmSync(carpeta, { recursive: true, force: true })
  })

  const dirDatos = () => join(carpeta, 'datos')
  const rutaPin = () => join(dirDatos(), ARCHIVO_PIN_ADMIN)
  /** El PIN del administrador que dejó el hub en su carpeta (como lo haría el instalador). */
  const pinDeArchivo = (borrar = true) => {
    const pin = readFileSync(rutaPin(), 'utf8').trim()
    if (borrar) rmSync(rutaPin())
    return pin
  }
  const entorno = async () => ({
    DIR_DATOS: dirDatos(),
    DIR_APP: join(carpeta, 'sin-app'),
    PUERTO: String(await puertoLibre()),
  })
  const post = (h: HubArrancado, ruta: string, cuerpo: object, token?: string) =>
    fetch(h.url + ruta, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(cuerpo),
    })
  const emparejar = async (h: HubArrancado, pin: string, tipo: string) => {
    const c = (await (
      await post(h, '/api/emparejamientos', { pin, nombre: `Equipo ${tipo}`, tipo })
    ).json()) as { codigo: string }
    const e = (await (await post(h, '/api/emparejar', { codigo: c.codigo })).json()) as {
      token: string
    }
    return e.token
  }

  it('al reiniciar con la misma carpeta, el PIN del administrador y el token del equipo siguen sirviendo', async () => {
    hub = await arrancarHub(await entorno())
    const pin = pinDeArchivo()
    const token = await emparejar(hub, pin, 'caja')
    const sesion = (await (await post(hub, '/api/sesiones', { pin }, token)).json()) as {
      sesion_id: string
      secreto: string
    }
    await hub.detener() // se apaga de golpe, sin cerrar nada

    hub = await arrancarHub({ ...(await entorno()), DIR_DATOS: dirDatos() })
    // No se muestra ni se escribe otro PIN: el administrador ya existe.
    expect(existsSync(rutaPin())).toBe(false)
    expect(hub.salida()).not.toMatch(/PIN del administrador/)
    expect(hub.salida()).not.toMatch(/clave de los PIN/)
    const entra = await post(hub, '/api/sesiones', { pin }, token)
    expect(entra.status).toBe(201)
    // La sesión anterior se cerró al abrir esta; su secreto ya no sirve, pero el hub responde claro.
    const cerrar = await post(
      hub,
      '/api/sesiones/cerrar',
      { sesion_id: sesion.sesion_id, secreto: sesion.secreto },
      token,
    )
    expect(cerrar.status).toBe(401)
    expect(await cerrar.json()).toMatchObject({ error: 'sesion_invalida' })
  })

  it('con la clave borrada: PIN nuevo y aviso al arrancar; el PIN viejo ya no entra; el equipo sigue emparejado', async () => {
    const env = await entorno()
    hub = await arrancarHub(env)
    const pinViejo = pinDeArchivo()
    const token = await emparejar(hub, pinViejo, 'caja')
    await hub.detener()
    expect(existsSync(join(dirDatos(), ARCHIVO_CLAVE))).toBe(true)
    rmSync(join(dirDatos(), ARCHIVO_CLAVE))

    hub = await arrancarHub({ ...env, PUERTO: String(await puertoLibre()) })
    expect(hub.salida()).toMatch(/Falta la clave de los PIN/)
    const pinNuevo = pinDeArchivo()
    expect(pinNuevo).toMatch(/^\d{4}$/)
    expect(existsSync(join(dirDatos(), ARCHIVO_CLAVE))).toBe(true)

    if (pinNuevo !== pinViejo) {
      const viejo = await post(hub, '/api/sesiones', { pin: pinViejo }, token)
      expect(viejo.status).toBe(401)
    }
    const nuevo = await post(hub, '/api/sesiones', { pin: pinNuevo }, token)
    expect(nuevo.status).toBe(201)
    expect(((await nuevo.json()) as { usuario: { rol: string } }).usuario.rol).toBe('Administrador')
  })

  it('una clave dañada detiene el arranque con un mensaje claro', async () => {
    const env = await entorno()
    hub = await arrancarHub(env)
    await hub.detener()
    hub = undefined
    writeFileSync(join(dirDatos(), ARCHIVO_CLAVE), 'corta')

    await expect(arrancarHub({ ...env, PUERTO: String(await puertoLibre()) })).rejects.toThrow(
      /No se pudo preparar el acceso del hub.*dañada/s,
    )
  })

  it('el log del hub no escribe PIN ni tokens, tampoco cuando el PIN es errado', async () => {
    hub = await arrancarHub(await entorno())
    const pin = pinDeArchivo(false)
    const token = await emparejar(hub, pin, 'caja')
    await post(hub, '/api/sesiones', { pin: '0001' }, token)
    await post(hub, '/api/sesiones', { pin: '0002' }, token)

    const salida = hub.salida()
    // El PIN va al archivo de la carpeta de datos (solo legible por el hub), no a la pantalla.
    expect(salida).not.toMatch(/PIN del administrador: \d/)
    expect(salida).toContain(ARCHIVO_PIN_ADMIN)
    if (process.platform !== 'win32') expect(statSync(rutaPin()).mode & 0o777).toBe(0o600)
    expect(pin).toMatch(/^\d{4}$/)
    expect(salida).not.toContain(token)
    expect(salida).not.toMatch(/"pin"|pin=|"0001"|"0002"/)
  })

  it('las esperas por intentos viven en memoria: tras reiniciar el hub, el equipo puede volver a intentar', async () => {
    hub = await arrancarHub(await entorno())
    const pin = pinDeArchivo()
    const token = await emparejar(hub, pin, 'mesero')
    for (const malo of ['0001', '0002', '0003'])
      await post(hub, '/api/sesiones', { pin: malo }, token)
    const espera = await post(hub, '/api/sesiones', { pin }, token)
    expect(espera.status).toBe(429)
    expect(Number(espera.headers.get('retry-after'))).toBeGreaterThan(0)
    await hub.detener()

    hub = await arrancarHub({ ...(await entorno()), DIR_DATOS: dirDatos() })
    expect((await post(hub, '/api/sesiones', { pin }, token)).status).toBe(201)
  })
})
