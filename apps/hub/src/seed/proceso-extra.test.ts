import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TABLAS_VERSIONADAS } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// `pnpm seed` como proceso real, con la carpeta de datos en disco: muerte a mitad, hub que
// arranca después y entradas inválidas.

const DIR_HUB = fileURLToPath(new URL('../..', import.meta.url))
const BASE = ['--disable-warning=ExperimentalWarning', '--import', 'tsx']

const correr = (archivo: string, env: Record<string, string>, args: string[] = []) => {
  const r = spawnSync(process.execPath, [...BASE, archivo, ...args], {
    cwd: DIR_HUB,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  return { codigo: r.status, senal: r.signal, salida: `${r.stdout}${r.stderr}` }
}

/** Foto de la base cerrada: filas de catálogo, contador y credenciales. */
function foto(carpeta: string) {
  const db = abrirBase(join(carpeta, 'pos.sqlite'))
  try {
    const tablas = [...TABLAS_VERSIONADAS, 'contador', 'usuario_credencial']
    return Object.fromEntries(
      tablas.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]),
    )
  } finally {
    db.close()
  }
}
const cuenta = (carpeta: string, tabla: string) => {
  const db = abrirBase(join(carpeta, 'pos.sqlite'))
  try {
    return Number(db.prepare(`SELECT count(*) AS n FROM ${tabla}`).get()?.n)
  } finally {
    db.close()
  }
}
const puertoLibre = () =>
  new Promise<number>((resolver, rechazar) => {
    const s = createServer()
    s.once('error', rechazar)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolver(port))
    })
  })

describe('seed como proceso real, con otros casos', { timeout: 90_000 }, () => {
  let carpeta = ''
  beforeEach(() => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-seed-extra-'))
  })
  afterEach(() => rmSync(carpeta, { recursive: true, force: true }))

  const seed = (env: Record<string, string> = {}) =>
    correr('src/seed/main.ts', { DIR_DATOS: carpeta, ...env })
  const morirEn = (donde: string) =>
    correr('src/seed/morir-a-mitad.fixture.ts', { DIR_DATOS: carpeta, MORIR_EN: donde })

  it('si el proceso muere a mitad del catálogo no queda nada a medias y el seed siguiente lo deja completo', () => {
    // Una corrida limpia en otra carpeta da el conteo esperado de referencia.
    const limpia = mkdtempSync(join(tmpdir(), 'pos-seed-limpia-'))
    try {
      expect(correr('src/seed/main.ts', { DIR_DATOS: limpia }).codigo).toBe(0)

      const muerta = morirEn('producto:50')
      expect(muerta.senal).toBe('SIGKILL')
      // Antes de morir, la preparación del hub (restaurante, roles, administrador) sí terminó,
      // pero el catálogo del seed no dejó ni un registro.
      for (const tabla of ['mesa', 'zona', 'estacion', 'impuesto', 'categoria', 'producto'])
        expect({ tabla, n: cuenta(carpeta, tabla) }).toEqual({ tabla, n: 0 })

      const r = seed()
      expect(r.codigo).toBe(0)
      expect(r.salida).toMatch(/producto\s+98 nuevos, 0 cambiados, 0 iguales/)
      for (const tabla of ['mesa', 'categoria', 'producto', 'variante', 'modificador'])
        expect(cuenta(carpeta, tabla)).toBe(cuenta(limpia, tabla))
    } finally {
      rmSync(limpia, { recursive: true, force: true })
    }
  })

  it('si muere creando al personal tampoco queda nada del seed, y el siguiente crea todo junto', () => {
    const muerta = morirEn('usuario:4')
    expect(muerta.senal).toBe('SIGKILL')
    // El catálogo y los tres usuarios que se alcanzaron a crear van en la misma transacción.
    for (const tabla of ['mesa', 'producto', 'categoria']) expect(cuenta(carpeta, tabla)).toBe(0)
    // Solo el administrador que prepara el hub antes de sembrar.
    expect(cuenta(carpeta, 'usuario')).toBe(1)

    const r = seed()
    expect(r.codigo).toBe(0)
    expect(r.salida).toMatch(/usuario\s+5 nuevos/)
    expect(r.salida).toMatch(/producto\s+98 nuevos, 0 cambiados, 0 iguales/)
    expect(cuenta(carpeta, 'producto')).toBe(98)
    expect(cuenta(carpeta, 'usuario')).toBe(6)
    // Los 5 llegaron al archivo de personal: nadie queda sin PIN o contraseña conocidos.
    const personal = readdirSync(carpeta).filter((f) => /^pines-.*-personal\.txt$/.test(f))
    expect(personal).toHaveLength(1)
    const pines = readFileSync(join(carpeta, personal[0] as string), 'utf8')
    for (const nombre of ['Mesero 1', 'Mesero 2', 'Mesero 3'])
      expect(pines).toMatch(new RegExp(`${nombre}\\s+PIN \\d{4}`))
    for (const nombre of ['Caja', 'Reportes'])
      expect(pines).toMatch(new RegExp(`${nombre}\\s+usuario \\S+\\s+contraseña \\S+`))
  })

  it('con --sin-personal carga la carta sin crear cuentas de ejemplo; después se pueden agregar', () => {
    const primera = correr('src/seed/main.ts', { DIR_DATOS: carpeta }, ['--sin-personal'])
    expect(primera.codigo).toBe(0)
    expect(primera.salida).toMatch(/producto\s+98 nuevos/)
    expect(cuenta(carpeta, 'usuario')).toBe(1)
    expect(readdirSync(carpeta).some((f) => /-personal\.txt$/.test(f))).toBe(false)

    const segunda = seed()
    expect(segunda.codigo).toBe(0)
    expect(segunda.salida).toMatch(/usuario\s+5 nuevos/)
    expect(cuenta(carpeta, 'usuario')).toBe(6)
  })

  it('si la carta ya no trae un plato con regla (Té Hatsu, Tagliata) avisa pero no falla', () => {
    const ruta = join(carpeta, 'minima.yaml')
    writeFileSync(
      ruta,
      `secciones:
  - clave: A
    nombre: A
    grupo: comida
    boton: { es: A }
    platos:
      - nombre: { es: Pizza }
        precio: 20900
`,
    )
    const r = seed({ RUTA_CARTA: ruta })
    expect(r.codigo).toBe(0)
    for (const nombre of ['Tagliata di Manzo', 'Té Hatsu', 'Soda Hatsu'])
      expect(r.salida).toContain(`La carta ya no tiene «${nombre}»`)
    expect(cuenta(carpeta, 'producto')).toBe(1)
  })

  it('un plato agotado se archiva en la corrida siguiente y el resumen lo cuenta', () => {
    const ruta = join(carpeta, 'dos.yaml')
    const carta = (disponible: boolean) => `secciones:
  - clave: A
    nombre: A
    grupo: comida
    boton: { es: A }
    platos:
      - nombre: { es: Pizza }
        precio: 20900
      - nombre: { es: Pasta }
        precio: 25900
        disponible: ${disponible}
`
    writeFileSync(ruta, carta(true))
    expect(seed({ RUTA_CARTA: ruta }).salida).toMatch(/producto\s+2 nuevos/)
    writeFileSync(ruta, carta(false))
    const r = seed({ RUTA_CARTA: ruta })
    expect(r.salida).toMatch(/producto\s+0 nuevos, 0 cambiados, 1 iguales, 1 archivados/)
    expect(cuenta(carpeta, 'producto')).toBe(2)
  })

  it('una carta que no existe o está dañada termina con código 1, un mensaje claro y sin crear la base', () => {
    const inexistente = seed({ RUTA_CARTA: join(carpeta, 'no-existe.yaml') })
    expect(inexistente.codigo).toBe(1)
    expect(inexistente.salida).toMatch(/No se cargaron los datos: la carta .* no sirve/)
    expect(existsSync(join(carpeta, 'pos.sqlite'))).toBe(false)

    const danada = join(carpeta, 'danada.yaml')
    writeFileSync(danada, 'secciones: [una carta sin cerrar')
    expect(seed({ RUTA_CARTA: danada }).codigo).toBe(1)

    const decimal = join(carpeta, 'decimal.yaml')
    writeFileSync(
      decimal,
      `secciones:
  - clave: A
    nombre: A
    grupo: comida
    boton: { es: A }
    platos:
      - nombre: { es: Pizza }
        precio: 20900.5
`,
    )
    const r = seed({ RUTA_CARTA: decimal })
    expect(r.codigo).toBe(1)
    expect(existsSync(join(carpeta, 'pos.sqlite'))).toBe(false)
  })

  it('los PIN van a dos archivos distintos por corrida, uno del administrador y otro del personal, con permisos 600', () => {
    const r = seed()
    expect(r.codigo).toBe(0)
    const archivos = readdirSync(carpeta).filter((f) => /^pines-.*\.txt$/.test(f))
    expect(archivos.filter((f) => f.endsWith('-administrador.txt'))).toHaveLength(1)
    expect(archivos.filter((f) => f.endsWith('-personal.txt'))).toHaveLength(1)
    expect(archivos).toHaveLength(2)
    expect(
      readFileSync(
        join(carpeta, archivos.find((f) => f.endsWith('-administrador.txt')) as string),
        'utf8',
      ),
    ).toMatch(/Contraseña:\s+\S+[\s\S]*PIN para autorizar:\s+\d{4}/)
    for (const f of archivos) {
      // En Windows el modo no se aplica; en macOS y Linux sí.
      if (process.platform !== 'win32') expect(statSync(join(carpeta, f)).mode & 0o777).toBe(0o600)
    }
    // Una segunda corrida sin personal nuevo no deja otro archivo.
    expect(seed().codigo).toBe(0)
    expect(readdirSync(carpeta).filter((f) => /^pines-.*\.txt$/.test(f))).toEqual(archivos)
  })

  it('el hub arranca después del seed sin pedir otro PIN y sin tocar los datos', async () => {
    expect(seed().codigo).toBe(0)
    const antes = foto(carpeta)

    const puerto = await puertoLibre()
    const hijo = spawn(process.execPath, [...BASE, 'src/main.ts'], {
      cwd: DIR_HUB,
      env: {
        ...process.env,
        DIR_DATOS: carpeta,
        DIR_APP: join(carpeta, 'sin-app'),
        PUERTO: String(puerto),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let salida = ''
    const terminado = new Promise<void>((resolver) => hijo.once('exit', () => resolver()))
    try {
      await new Promise<void>((resolver, rechazar) => {
        const alRecibir = (t: Buffer) => {
          salida += String(t)
          if (salida.includes('Hub en marcha')) resolver()
        }
        hijo.stdout?.on('data', alRecibir)
        hijo.stderr?.on('data', (t) => {
          salida += String(t)
        })
        hijo.once('exit', (c) => rechazar(new Error(`El hub terminó con código ${c}:\n${salida}`)))
      })
      // Responde con la base del seed ya abierta.
      const r = await fetch(`http://127.0.0.1:${puerto}/api/salud`)
      expect(r.status).toBe(200)
    } finally {
      hijo.kill('SIGKILL')
      await terminado
    }
    expect(salida).not.toMatch(/PIN del administrador/)
    expect(salida).not.toMatch(/clave de los PIN/)
    expect(foto(carpeta)).toEqual(antes)
  })

  it('el seed no corre si otro proceso tiene la base abierta y no cambia nada', async () => {
    expect(seed().codigo).toBe(0)
    const antes = foto(carpeta)
    const bloqueada = abrirBase(join(carpeta, 'pos.sqlite'), { exclusiva: true })
    try {
      const r = seed()
      expect(r.codigo).toBe(1)
      expect(r.salida).toContain('el hub está abierto')
    } finally {
      bloqueada.close()
    }
    expect(foto(carpeta)).toEqual(antes)
  })
})
