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
import { VERSIONED_TABLES } from '@pos/db'
import { openDatabase } from '@pos/db/node'
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
  return { code: r.status, signal: r.signal, output: `${r.stdout}${r.stderr}` }
}

/** Foto de la base cerrada: filas de catálogo, contador y credenciales. */
function photo(folder: string) {
  const db = openDatabase(join(folder, 'pos.sqlite'))
  try {
    const sqlTables = [...VERSIONED_TABLES, 'counters', 'user_credentials']
    return Object.fromEntries(
      sqlTables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]),
    )
  } finally {
    db.close()
  }
}
const check = (folder: string, tableName: string) => {
  const db = openDatabase(join(folder, 'pos.sqlite'))
  try {
    return Number(db.prepare(`SELECT count(*) AS n FROM ${tableName}`).get()?.n)
  } finally {
    db.close()
  }
}
const puertoLibre = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

describe('seed como proceso real, con otros casos', { timeout: 90_000 }, () => {
  let folder = ''
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'pos-seed-extra-'))
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  const seed = (env: Record<string, string> = {}) =>
    correr('src/seed/main.ts', { DATA_DIR: folder, ...env })
  const morirEn = (donde: string) =>
    correr('src/seed/morir-a-mitad.fixture.ts', { DATA_DIR: folder, MORIR_EN: donde })

  it('si el proceso muere a mitad del catálogo no queda nada a medias y el seed siguiente lo deja completo', () => {
    // Una corrida limpia en otra carpeta da el conteo esperado de referencia.
    const limpia = mkdtempSync(join(tmpdir(), 'pos-seed-limpia-'))
    try {
      expect(correr('src/seed/main.ts', { DATA_DIR: limpia }).code).toBe(0)

      const muerta = morirEn('products:50')
      expect(muerta.signal).toBe('SIGKILL')
      // Antes de morir, la preparación del hub (restaurante, roles, administrador) sí terminó,
      // pero el catálogo del seed no dejó ni un registro.
      for (const tableName of [
        'dining_tables',
        'zones',
        'stations',
        'taxes',
        'categories',
        'products',
      ])
        expect({ tableName, n: check(folder, tableName) }).toEqual({ tableName, n: 0 })

      const r = seed()
      expect(r.code).toBe(0)
      expect(r.output).toMatch(/products\s+98 nuevos, 0 cambiados, 0 iguales/)
      for (const tableName of ['dining_tables', 'categories', 'products', 'variants', 'modifiers'])
        expect(check(folder, tableName)).toBe(check(limpia, tableName))
    } finally {
      rmSync(limpia, { recursive: true, force: true })
    }
  })

  it('si muere creando al personal tampoco queda nada del seed, y el siguiente crea todo junto', () => {
    const muerta = morirEn('users:4')
    expect(muerta.signal).toBe('SIGKILL')
    // El catálogo y los tres usuarios que se alcanzaron a crear van en la misma transacción.
    for (const tableName of ['dining_tables', 'products', 'categories'])
      expect(check(folder, tableName)).toBe(0)
    // Solo el administrador que prepara el hub antes de sembrar.
    expect(check(folder, 'users')).toBe(1)

    const r = seed()
    expect(r.code).toBe(0)
    expect(r.output).toMatch(/users\s+5 nuevos/)
    expect(r.output).toMatch(/products\s+98 nuevos, 0 cambiados, 0 iguales/)
    expect(check(folder, 'products')).toBe(98)
    expect(check(folder, 'users')).toBe(6)
    // Los 5 llegaron al archivo de personal: nadie queda sin PIN o contraseña conocidos.
    const staff = readdirSync(folder).filter((f) => /^pines-.*-personal\.txt$/.test(f))
    expect(staff).toHaveLength(1)
    const pins = readFileSync(join(folder, staff[0] as string), 'utf8')
    for (const name of ['Mesero 1', 'Mesero 2', 'Mesero 3'])
      expect(pins).toMatch(new RegExp(`${name}\\s+PIN \\d{4}`))
    for (const name of ['Caja', 'Reportes'])
      expect(pins).toMatch(new RegExp(`${name}\\s+usuario \\S+\\s+contraseña \\S+`))
  })

  it('con --sin-personal carga la carta sin crear cuentas de ejemplo; después se pueden agregar', () => {
    const first = correr('src/seed/main.ts', { DATA_DIR: folder }, ['--no-staff'])
    expect(first.code).toBe(0)
    expect(first.output).toMatch(/products\s+98 nuevos/)
    expect(check(folder, 'users')).toBe(1)
    expect(readdirSync(folder).some((f) => /-personal\.txt$/.test(f))).toBe(false)

    const second = seed()
    expect(second.code).toBe(0)
    expect(second.output).toMatch(/users\s+5 nuevos/)
    expect(check(folder, 'users')).toBe(6)
  })

  it('si la carta ya no trae un plato con regla (Té Hatsu, Tagliata) avisa pero no falla', () => {
    const route = join(folder, 'minima.yaml')
    writeFileSync(
      route,
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
    const r = seed({ RUTA_CARTA: route })
    expect(r.code).toBe(0)
    for (const name of ['Tagliata di Manzo', 'Té Hatsu', 'Soda Hatsu'])
      expect(r.output).toContain(`La carta ya no tiene «${name}»`)
    expect(check(folder, 'products')).toBe(1)
  })

  it('un plato agotado se archiva en la corrida siguiente y el resumen lo cuenta', () => {
    const route = join(folder, 'dos.yaml')
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
    writeFileSync(route, menu(true))
    expect(seed({ RUTA_CARTA: route }).output).toMatch(/products\s+2 nuevos/)
    writeFileSync(route, menu(false))
    const r = seed({ RUTA_CARTA: route })
    expect(r.output).toMatch(/products\s+0 nuevos, 0 cambiados, 1 iguales, 1 archivados/)
    expect(check(folder, 'products')).toBe(2)
  })

  it('una carta que no existe o está dañada termina con código 1, un mensaje claro y sin crear la base', () => {
    const nonexistent = seed({ RUTA_CARTA: join(folder, 'no-existe.yaml') })
    expect(nonexistent.code).toBe(1)
    expect(nonexistent.output).toMatch(/No se cargaron los datos: la carta .* no sirve/)
    expect(existsSync(join(folder, 'pos.sqlite'))).toBe(false)

    const danada = join(folder, 'danada.yaml')
    writeFileSync(danada, 'secciones: [una carta sin cerrar')
    expect(seed({ RUTA_CARTA: danada }).code).toBe(1)

    const decimal = join(folder, 'decimal.yaml')
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
    expect(existsSync(join(folder, 'pos.sqlite'))).toBe(false)
  })

  it('los PIN van a dos archivos distintos por corrida, uno del administrador y otro del personal, con permisos 600', () => {
    const r = seed()
    expect(r.code).toBe(0)
    const archivos = readdirSync(folder).filter((f) => /^pines-.*\.txt$/.test(f))
    expect(archivos.filter((f) => f.endsWith('-administrador.txt'))).toHaveLength(1)
    expect(archivos.filter((f) => f.endsWith('-personal.txt'))).toHaveLength(1)
    expect(archivos).toHaveLength(2)
    expect(
      readFileSync(
        join(folder, archivos.find((f) => f.endsWith('-administrador.txt')) as string),
        'utf8',
      ),
    ).toMatch(/Contraseña:\s+\S+[\s\S]*PIN para autorizar:\s+\d{4}/)
    for (const f of archivos) {
      // En Windows el modo no se aplica; en macOS y Linux sí.
      if (process.platform !== 'win32') expect(statSync(join(folder, f)).mode & 0o777).toBe(0o600)
    }
    // Una segunda corrida sin personal nuevo no deja otro archivo.
    expect(seed().code).toBe(0)
    expect(readdirSync(folder).filter((f) => /^pines-.*\.txt$/.test(f))).toEqual(archivos)
  })

  it('el hub arranca después del seed sin pedir otro PIN y sin tocar los datos', async () => {
    expect(seed().code).toBe(0)
    const before = photo(folder)

    const port = await puertoLibre()
    const child = spawn(process.execPath, [...BASE, 'src/main.ts'], {
      cwd: DIR_HUB,
      env: {
        ...process.env,
        DATA_DIR: folder,
        DIR_APP: join(folder, 'sin-app'),
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const terminado = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      await new Promise<void>((resolve, reject) => {
        const alRecibir = (t: Buffer) => {
          output += String(t)
          if (output.includes('Hub en marcha')) resolve()
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
    expect(photo(folder)).toEqual(before)
  })

  it('el seed no corre si otro proceso tiene la base abierta y no cambia nada', async () => {
    expect(seed().code).toBe(0)
    const before = photo(folder)
    const bloqueada = openDatabase(join(folder, 'pos.sqlite'), { exclusive: true })
    try {
      const r = seed()
      expect(r.code).toBe(1)
      expect(r.output).toContain('el hub está abierto')
    } finally {
      bloqueada.close()
    }
    expect(photo(folder)).toEqual(before)
  })
})
