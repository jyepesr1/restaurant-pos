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
  return { code: r.status, senal: r.signal, output: `${r.stdout}${r.stderr}` }
}

/** Foto de la base cerrada: filas de catálogo, contador y credenciales. */
function photo(carpeta: string) {
  const db = abrirBase(join(carpeta, 'pos.sqlite'))
  try {
    const sqlTables = [...TABLAS_VERSIONADAS, 'counters', 'user_credentials']
    return Object.fromEntries(
      sqlTables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]),
    )
  } finally {
    db.close()
  }
}
const check = (carpeta: string, tabla: string) => {
  const db = abrirBase(join(carpeta, 'pos.sqlite'))
  try {
    return Number(db.prepare(`SELECT count(*) AS n FROM ${tabla}`).get()?.n)
  } finally {
    db.close()
  }
}
const puertoLibre = () =>
  new Promise<number>((resolver, reject) => {
    const s = createServer()
    s.once('error', reject)
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
    correr('src/seed/main.ts', { DATA_DIR: carpeta, ...env })
  const morirEn = (donde: string) =>
    correr('src/seed/morir-a-mitad.fixture.ts', { DATA_DIR: carpeta, MORIR_EN: donde })

  it('si el proceso muere a mitad del catálogo no queda nada a medias y el seed siguiente lo deja completo', () => {
    // Una corrida limpia en otra carpeta da el conteo esperado de referencia.
    const limpia = mkdtempSync(join(tmpdir(), 'pos-seed-limpia-'))
    try {
      expect(correr('src/seed/main.ts', { DATA_DIR: limpia }).code).toBe(0)

      const muerta = morirEn('products:50')
      expect(muerta.senal).toBe('SIGKILL')
      // Antes de morir, la preparación del hub (restaurante, roles, administrador) sí terminó,
      // pero el catálogo del seed no dejó ni un registro.
      for (const tabla of ['dining_tables', 'zones', 'stations', 'taxes', 'categories', 'products'])
        expect({ tabla, n: check(carpeta, tabla) }).toEqual({ tabla, n: 0 })

      const r = seed()
      expect(r.code).toBe(0)
      expect(r.output).toMatch(/products\s+98 nuevos, 0 cambiados, 0 iguales/)
      for (const tabla of ['dining_tables', 'categories', 'products', 'variants', 'modifiers'])
        expect(check(carpeta, tabla)).toBe(check(limpia, tabla))
    } finally {
      rmSync(limpia, { recursive: true, force: true })
    }
  })

  it('si muere creando al personal tampoco queda nada del seed, y el siguiente crea todo junto', () => {
    const muerta = morirEn('users:4')
    expect(muerta.senal).toBe('SIGKILL')
    // El catálogo y los tres usuarios que se alcanzaron a crear van en la misma transacción.
    for (const tabla of ['dining_tables', 'products', 'categories'])
      expect(check(carpeta, tabla)).toBe(0)
    // Solo el administrador que prepara el hub antes de sembrar.
    expect(check(carpeta, 'users')).toBe(1)

    const r = seed()
    expect(r.code).toBe(0)
    expect(r.output).toMatch(/users\s+5 nuevos/)
    expect(r.output).toMatch(/products\s+98 nuevos, 0 cambiados, 0 iguales/)
    expect(check(carpeta, 'products')).toBe(98)
    expect(check(carpeta, 'users')).toBe(6)
    // Los 5 llegaron al archivo de personal: nadie queda sin PIN o contraseña conocidos.
    const staff = readdirSync(carpeta).filter((f) => /^pines-.*-personal\.txt$/.test(f))
    expect(staff).toHaveLength(1)
    const pins = readFileSync(join(carpeta, staff[0] as string), 'utf8')
    for (const name of ['Mesero 1', 'Mesero 2', 'Mesero 3'])
      expect(pins).toMatch(new RegExp(`${name}\\s+PIN \\d{4}`))
    for (const name of ['Caja', 'Reportes'])
      expect(pins).toMatch(new RegExp(`${name}\\s+usuario \\S+\\s+contraseña \\S+`))
  })

  it('con --sin-personal carga la carta sin crear cuentas de ejemplo; después se pueden agregar', () => {
    const first = correr('src/seed/main.ts', { DATA_DIR: carpeta }, ['--no-staff'])
    expect(first.code).toBe(0)
    expect(first.output).toMatch(/products\s+98 nuevos/)
    expect(check(carpeta, 'users')).toBe(1)
    expect(readdirSync(carpeta).some((f) => /-personal\.txt$/.test(f))).toBe(false)

    const segunda = seed()
    expect(segunda.code).toBe(0)
    expect(segunda.output).toMatch(/users\s+5 nuevos/)
    expect(check(carpeta, 'users')).toBe(6)
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
    expect(r.code).toBe(0)
    for (const name of ['Tagliata di Manzo', 'Té Hatsu', 'Soda Hatsu'])
      expect(r.output).toContain(`La carta ya no tiene «${name}»`)
    expect(check(carpeta, 'products')).toBe(1)
  })

  it('un plato agotado se archiva en la corrida siguiente y el resumen lo cuenta', () => {
    const ruta = join(carpeta, 'dos.yaml')
    const menu = (available: boolean) => `secciones:
  - clave: A
    nombre: A
    grupo: comida
    boton: { es: A }
    platos:
      - nombre: { es: Pizza }
        precio: 20900
      - nombre: { es: Pasta }
        precio: 25900
        disponible: ${available}
`
    writeFileSync(ruta, menu(true))
    expect(seed({ RUTA_CARTA: ruta }).output).toMatch(/products\s+2 nuevos/)
    writeFileSync(ruta, menu(false))
    const r = seed({ RUTA_CARTA: ruta })
    expect(r.output).toMatch(/products\s+0 nuevos, 0 cambiados, 1 iguales, 1 archivados/)
    expect(check(carpeta, 'products')).toBe(2)
  })

  it('una carta que no existe o está dañada termina con código 1, un mensaje claro y sin crear la base', () => {
    const nonexistent = seed({ RUTA_CARTA: join(carpeta, 'no-existe.yaml') })
    expect(nonexistent.code).toBe(1)
    expect(nonexistent.output).toMatch(/No se cargaron los datos: la carta .* no sirve/)
    expect(existsSync(join(carpeta, 'pos.sqlite'))).toBe(false)

    const danada = join(carpeta, 'danada.yaml')
    writeFileSync(danada, 'secciones: [una carta sin cerrar')
    expect(seed({ RUTA_CARTA: danada }).code).toBe(1)

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
    expect(r.code).toBe(1)
    expect(existsSync(join(carpeta, 'pos.sqlite'))).toBe(false)
  })

  it('los PIN van a dos archivos distintos por corrida, uno del administrador y otro del personal, con permisos 600', () => {
    const r = seed()
    expect(r.code).toBe(0)
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
    expect(seed().code).toBe(0)
    expect(readdirSync(carpeta).filter((f) => /^pines-.*\.txt$/.test(f))).toEqual(archivos)
  })

  it('el hub arranca después del seed sin pedir otro PIN y sin tocar los datos', async () => {
    expect(seed().code).toBe(0)
    const before = photo(carpeta)

    const port = await puertoLibre()
    const child = spawn(process.execPath, [...BASE, 'src/main.ts'], {
      cwd: DIR_HUB,
      env: {
        ...process.env,
        DATA_DIR: carpeta,
        DIR_APP: join(carpeta, 'sin-app'),
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const terminado = new Promise<void>((resolver) => child.once('exit', () => resolver()))
    try {
      await new Promise<void>((resolver, reject) => {
        const alRecibir = (t: Buffer) => {
          output += String(t)
          if (output.includes('Hub en marcha')) resolver()
        }
        child.stdout?.on('data', alRecibir)
        child.stderr?.on('data', (t) => {
          output += String(t)
        })
        child.once('exit', (c) => reject(new Error(`El hub terminó con código ${c}:\n${output}`)))
      })
      // Responde con la base del seed ya abierta.
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      expect(r.status).toBe(200)
    } finally {
      child.kill('SIGKILL')
      await terminado
    }
    expect(output).not.toMatch(/PIN del administrador/)
    expect(output).not.toMatch(/clave de los PIN/)
    expect(photo(carpeta)).toEqual(before)
  })

  it('el seed no corre si otro proceso tiene la base abierta y no cambia nada', async () => {
    expect(seed().code).toBe(0)
    const before = photo(carpeta)
    const bloqueada = abrirBase(join(carpeta, 'pos.sqlite'), { exclusiva: true })
    try {
      const r = seed()
      expect(r.code).toBe(1)
      expect(r.output).toContain('el hub está abierto')
    } finally {
      bloqueada.close()
    }
    expect(photo(carpeta)).toEqual(before)
  })
})
