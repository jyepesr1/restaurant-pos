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
  /**
   * Usuario, contraseña y PIN para autorizar del administrador, como los dejó el hub en su
   * carpeta (lo que haría el instalador). Solo trae lo que el hub acaba de crear.
   */
  const datosDeArchivo = (borrar = true) => {
    const texto = readFileSync(rutaPin(), 'utf8')
    if (borrar) rmSync(rutaPin())
    const dato = (etiqueta: string) => new RegExp(`${etiqueta}:\\s+(\\S+)`).exec(texto)?.[1]
    return {
      usuario: dato('Usuario'),
      contrasena: dato('Contraseña'),
      pin: dato('PIN para autorizar'),
    }
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
  /** Entra (con token o sin él) y devuelve la respuesta. */
  const entrar = (h: HubArrancado, cuerpo: object, token?: string) =>
    post(h, '/api/entrar', cuerpo, token)
  type Entrada = { sesion_id: string; secreto: string; equipo: { token: string } | null }

  it('al reiniciar con la misma carpeta, la contraseña del administrador y el token del equipo siguen sirviendo', async () => {
    hub = await arrancarHub(await entorno())
    const { usuario, contrasena } = datosDeArchivo()
    const primera = (await (await entrar(hub, { usuario, contrasena })).json()) as Entrada
    const token = primera.equipo?.token as string
    await hub.detener() // se apaga de golpe, sin cerrar nada

    hub = await arrancarHub({ ...(await entorno()), DIR_DATOS: dirDatos() })
    // No se muestra ni se escribe nada nuevo: el administrador ya existe.
    expect(existsSync(rutaPin())).toBe(false)
    expect(hub.salida()).not.toMatch(/datos del administrador|Contraseña:/)
    expect(hub.salida()).not.toMatch(/clave de los PIN/)
    const otra = await entrar(hub, { usuario, contrasena }, token)
    expect(otra.status).toBe(201)
    // Con el token no registra otro equipo.
    expect(((await otra.json()) as Entrada).equipo).toBeNull()
    // La sesión anterior se cerró al abrir esta; su secreto ya no sirve, pero el hub responde claro.
    const cerrar = await post(
      hub,
      '/api/sesiones/cerrar',
      { sesion_id: primera.sesion_id, secreto: primera.secreto },
      token,
    )
    expect(cerrar.status).toBe(401)
    expect(await cerrar.json()).toMatchObject({ error: 'sesion_invalida' })
  })

  it('con la clave borrada: PIN nuevo para autorizar y aviso al arrancar; la contraseña y el equipo siguen sirviendo', async () => {
    const env = await entorno()
    hub = await arrancarHub(env)
    const primeros = datosDeArchivo()
    const token = (
      (await (
        await entrar(hub, { usuario: primeros.usuario, contrasena: primeros.contrasena })
      ).json()) as Entrada
    ).equipo?.token as string
    await hub.detener()
    expect(existsSync(join(dirDatos(), ARCHIVO_CLAVE))).toBe(true)
    rmSync(join(dirDatos(), ARCHIVO_CLAVE))

    hub = await arrancarHub({ ...env, PUERTO: String(await puertoLibre()) })
    expect(hub.salida()).toMatch(/Falta la clave de los PIN/)
    const nuevos = datosDeArchivo()
    expect(nuevos.pin).toMatch(/^\d{4}$/)
    // La contraseña no depende de esa clave: no se cambia ni se vuelve a mostrar.
    expect(nuevos.contrasena).toBeUndefined()
    expect(existsSync(join(dirDatos(), ARCHIVO_CLAVE))).toBe(true)
    const otra = await entrar(
      hub,
      { usuario: primeros.usuario, contrasena: primeros.contrasena },
      token,
    )
    expect(otra.status).toBe(201)
    expect(((await otra.json()) as { usuario: { rol: string } }).usuario.rol).toBe('Administrador')
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

  it('el log del hub no escribe PIN, contraseñas ni tokens, tampoco cuando están errados', async () => {
    hub = await arrancarHub(await entorno())
    const { usuario, contrasena, pin } = datosDeArchivo(false)
    const r = (await (await entrar(hub, { usuario, contrasena })).json()) as Entrada
    const token = r.equipo?.token as string
    await entrar(hub, { pin: '0001' }, token)
    await entrar(hub, { usuario, contrasena: 'otra-cualquiera' }, token)

    const salida = hub.salida()
    // Van al archivo de la carpeta de datos (solo legible por el hub), no a la pantalla.
    expect(salida).not.toMatch(/Contraseña:\s+\S|PIN para autorizar:\s+\d/)
    expect(salida).toContain(ARCHIVO_PIN_ADMIN)
    if (process.platform !== 'win32') expect(statSync(rutaPin()).mode & 0o777).toBe(0o600)
    expect(pin).toMatch(/^\d{4}$/)
    expect(salida).not.toContain(token)
    expect(salida).not.toContain(contrasena)
    expect(salida).not.toMatch(/"pin"|pin=|"0001"|otra-cualquiera|"contrasena"/)
  })

  it('las esperas por intentos viven en memoria: tras reiniciar el hub, se puede volver a intentar', async () => {
    hub = await arrancarHub(await entorno())
    const { usuario, contrasena } = datosDeArchivo()
    // Sin token, la espera va por la IP y por el usuario.
    for (const mala of ['mala-1-xx', 'mala-2-xx', 'mala-3-xx'])
      await entrar(hub, { usuario, contrasena: mala })
    const espera = await entrar(hub, { usuario, contrasena })
    expect(espera.status).toBe(429)
    expect(Number(espera.headers.get('retry-after'))).toBeGreaterThan(0)
    await hub.detener()

    hub = await arrancarHub({ ...(await entorno()), DIR_DATOS: dirDatos() })
    expect((await entrar(hub, { usuario, contrasena })).status).toBe(201)
  })
})
