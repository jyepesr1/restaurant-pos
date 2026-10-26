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
  return new Promise((resolver, reject) => {
    const servidor = createServer()
    servidor.once('error', reject)
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address() as { port: number }
      servidor.close(() => resolver(port))
    })
  })
}

interface HubArrancado {
  child: ChildProcess
  output: () => string
  url: string
  detener: () => Promise<void>
}

function arrancarHub(env: Record<string, string>): Promise<HubArrancado> {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/main.ts'],
    { cwd: DIR_HUB, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let text = ''
  const acumular = (trozo: Buffer) => {
    text += String(trozo)
  }
  child.stdout?.on('data', acumular)
  child.stderr?.on('data', acumular)
  const terminado = new Promise<void>((resolver) => child.once('exit', () => resolver()))

  return new Promise((resolver, reject) => {
    const revisar = () => {
      if (text.includes('Hub en marcha')) {
        child.stdout?.off('data', revisar)
        resolver({
          child,
          output: () => text,
          url: `http://127.0.0.1:${env.PORT}`,
          detener: async () => {
            child.kill('SIGKILL')
            await terminado
          },
        })
      }
    }
    child.stdout?.on('data', revisar)
    child.once('exit', (code) =>
      reject(new Error(`El hub terminó con código ${code} antes de arrancar:\n${text}`)),
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

  const dirDatos = () => join(carpeta, 'data')
  const rutaPin = () => join(dirDatos(), ARCHIVO_PIN_ADMIN)
  /**
   * Usuario, contraseña y PIN para autorizar del administrador, como los dejó el hub en su
   * carpeta (lo que haría el instalador). Solo trae lo que el hub acaba de crear.
   */
  const datosDeArchivo = (erase = true) => {
    const text = readFileSync(rutaPin(), 'utf8')
    if (erase) rmSync(rutaPin())
    const dato = (etiqueta: string) => new RegExp(`${etiqueta}:\\s+(\\S+)`).exec(text)?.[1]
    return {
      user: dato('Usuario'),
      password: dato('Contraseña'),
      pin: dato('PIN para autorizar'),
    }
  }
  const entorno = async () => ({
    DATA_DIR: dirDatos(),
    DIR_APP: join(carpeta, 'sin-app'),
    PORT: String(await puertoLibre()),
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
  /** Entra (con token o sin él) y devuelve la respuesta. */
  const entrar = (h: HubArrancado, cuerpo: object, token?: string) =>
    post(h, '/api/sign-in', cuerpo, token)
  type Entrada = { session_id: string; secret: string; device: { token: string } | null }

  it('al reiniciar con la misma carpeta, la contraseña del administrador y el token del equipo siguen sirviendo', async () => {
    hub = await arrancarHub(await entorno())
    const { user, password } = datosDeArchivo()
    const first = (await (await entrar(hub, { user, password })).json()) as Entrada
    const token = first.device?.token as string
    await hub.detener() // se apaga de golpe, sin cerrar nada

    hub = await arrancarHub({ ...(await entorno()), DATA_DIR: dirDatos() })
    // No se muestra ni se escribe nada nuevo: el administrador ya existe.
    expect(existsSync(rutaPin())).toBe(false)
    expect(hub.output()).not.toMatch(/datos del administrador|Contraseña:/)
    expect(hub.output()).not.toMatch(/clave de los PIN/)
    const another = await entrar(hub, { user, password }, token)
    expect(another.status).toBe(201)
    // Con el token no registra otro equipo.
    expect(((await another.json()) as Entrada).device).toBeNull()
    // La sesión anterior se cerró al abrir esta; su secreto ya no sirve, pero el hub responde claro.
    const close = await post(
      hub,
      '/api/sessions/close',
      { session_id: first.session_id, secret: first.secret },
      token,
    )
    expect(close.status).toBe(401)
    expect(await close.json()).toMatchObject({ error: 'invalid_session' })
  })

  it('con la clave borrada: PIN nuevo para autorizar y aviso al arrancar; la contraseña y el equipo siguen sirviendo', async () => {
    const env = await entorno()
    hub = await arrancarHub(env)
    const primeros = datosDeArchivo()
    const token = (
      (await (
        await entrar(hub, { user: primeros.user, password: primeros.password })
      ).json()) as Entrada
    ).device?.token as string
    await hub.detener()
    expect(existsSync(join(dirDatos(), ARCHIVO_CLAVE))).toBe(true)
    rmSync(join(dirDatos(), ARCHIVO_CLAVE))

    hub = await arrancarHub({ ...env, PORT: String(await puertoLibre()) })
    expect(hub.output()).toMatch(/Falta la clave de los PIN/)
    const nuevos = datosDeArchivo()
    expect(nuevos.pin).toMatch(/^\d{4}$/)
    // La contraseña no depende de esa clave: no se cambia ni se vuelve a mostrar.
    expect(nuevos.password).toBeUndefined()
    expect(existsSync(join(dirDatos(), ARCHIVO_CLAVE))).toBe(true)
    const another = await entrar(hub, { user: primeros.user, password: primeros.password }, token)
    expect(another.status).toBe(201)
    expect(((await another.json()) as { user: { role: string } }).user.role).toBe('Administrador')
  })

  it('una clave dañada detiene el arranque con un mensaje claro', async () => {
    const env = await entorno()
    hub = await arrancarHub(env)
    await hub.detener()
    hub = undefined
    writeFileSync(join(dirDatos(), ARCHIVO_CLAVE), 'corta')

    await expect(arrancarHub({ ...env, PORT: String(await puertoLibre()) })).rejects.toThrow(
      /No se pudo preparar el acceso del hub.*dañada/s,
    )
  })

  it('el log del hub no escribe PIN, contraseñas ni tokens, tampoco cuando están errados', async () => {
    hub = await arrancarHub(await entorno())
    const { user, password, pin } = datosDeArchivo(false)
    const r = (await (await entrar(hub, { user, password })).json()) as Entrada
    const token = r.device?.token as string
    await entrar(hub, { pin: '0001' }, token)
    await entrar(hub, { user, password: 'otra-cualquiera' }, token)

    const output = hub.output()
    // Van al archivo de la carpeta de datos (solo legible por el hub), no a la pantalla.
    expect(output).not.toMatch(/Contraseña:\s+\S|PIN para autorizar:\s+\d/)
    expect(output).toContain(ARCHIVO_PIN_ADMIN)
    if (process.platform !== 'win32') expect(statSync(rutaPin()).mode & 0o777).toBe(0o600)
    expect(pin).toMatch(/^\d{4}$/)
    expect(output).not.toContain(token)
    expect(output).not.toContain(password)
    expect(output).not.toMatch(/"pin"|pin=|"0001"|otra-cualquiera|"contrasena"/)
  })

  it('las esperas por intentos viven en memoria: tras reiniciar el hub, se puede volver a intentar', async () => {
    hub = await arrancarHub(await entorno())
    const { user, password } = datosDeArchivo()
    // Sin token, la espera va por la IP y por el usuario.
    for (const mala of ['mala-1-xx', 'mala-2-xx', 'mala-3-xx'])
      await entrar(hub, { user, password: mala })
    const delay = await entrar(hub, { user, password })
    expect(delay.status).toBe(429)
    expect(Number(delay.headers.get('retry-after'))).toBeGreaterThan(0)
    await hub.detener()

    hub = await arrancarHub({ ...(await entorno()), DATA_DIR: dirDatos() })
    expect((await entrar(hub, { user, password })).status).toBe(201)
  })
})
