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

// `pnpm seed` as a real process, with the data folder on disk: dying halfway, a hub that
// starts afterwards, and invalid inputs.

const DIR_HUB = fileURLToPath(new URL('../..', import.meta.url))
const BASE = ['--disable-warning=ExperimentalWarning', '--import', 'tsx']

const run = (file: string, env: Record<string, string>, args: string[] = []) => {
  const r = spawnSync(process.execPath, [...BASE, file, ...args], {
    cwd: DIR_HUB,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  return { code: r.status, signal: r.signal, output: `${r.stdout}${r.stderr}` }
}

/** Snapshot of the closed database: catalog rows, counter and credentials. */
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
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

describe('seed as a real process, with other cases', { timeout: 90_000 }, () => {
  let folder = ''
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'pos-seed-extra-'))
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  const seed = (env: Record<string, string> = {}) =>
    run('src/seed/main.ts', { DATA_DIR: folder, ...env })
  const dieAt = (where: string) =>
    run('src/seed/die-midway.fixture.ts', { DATA_DIR: folder, DIE_AT: where })

  it('if the process dies halfway through the catalog nothing is left half done and the next seed completes it', () => {
    // A clean run in another folder gives the expected reference count.
    const cleanDir = mkdtempSync(join(tmpdir(), 'pos-seed-limpia-'))
    try {
      expect(run('src/seed/main.ts', { DATA_DIR: cleanDir }).code).toBe(0)

      const dead = dieAt('products:50')
      expect(dead.signal).toBe('SIGKILL')
      // Before dying, the hub preparation (restaurant, roles, admin) did finish, but the seed's
      // catalog did not leave a single record.
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
        expect(check(folder, tableName)).toBe(check(cleanDir, tableName))
    } finally {
      rmSync(cleanDir, { recursive: true, force: true })
    }
  })

  it('if it dies while creating the staff nothing from the seed is left either, and the next one creates it all together', () => {
    const dead = dieAt('users:4')
    expect(dead.signal).toBe('SIGKILL')
    // The catalog and the three users that got created go in the same transaction.
    for (const tableName of ['dining_tables', 'products', 'categories'])
      expect(check(folder, tableName)).toBe(0)
    // Only the admin that the hub prepares before seeding.
    expect(check(folder, 'users')).toBe(1)

    const r = seed()
    expect(r.code).toBe(0)
    expect(r.output).toMatch(/users\s+5 nuevos/)
    expect(r.output).toMatch(/products\s+98 nuevos, 0 cambiados, 0 iguales/)
    expect(check(folder, 'products')).toBe(98)
    expect(check(folder, 'users')).toBe(6)
    // All 5 reached the staff file: nobody is left without a known PIN or password.
    const staff = readdirSync(folder).filter((f) => /^pines-.*-personal\.txt$/.test(f))
    expect(staff).toHaveLength(1)
    const pins = readFileSync(join(folder, staff[0] as string), 'utf8')
    for (const name of ['Mesero 1', 'Mesero 2', 'Mesero 3'])
      expect(pins).toMatch(new RegExp(`${name}\\s+PIN \\d{4}`))
    for (const name of ['Caja', 'Reportes'])
      expect(pins).toMatch(new RegExp(`${name}\\s+usuario \\S+\\s+contraseña \\S+`))
  })

  it('with --no-staff it loads the menu without creating sample accounts; they can be added later', () => {
    const first = run('src/seed/main.ts', { DATA_DIR: folder }, ['--no-staff'])
    expect(first.code).toBe(0)
    expect(first.output).toMatch(/products\s+98 nuevos/)
    expect(check(folder, 'users')).toBe(1)
    expect(readdirSync(folder).some((f) => /-personal\.txt$/.test(f))).toBe(false)

    const second = seed()
    expect(second.code).toBe(0)
    expect(second.output).toMatch(/users\s+5 nuevos/)
    expect(check(folder, 'users')).toBe(6)
  })

  it('if the menu no longer has a dish with a rule (Té Hatsu, Tagliata) it warns but does not fail', () => {
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
    const r = seed({ MENU_PATH: route })
    expect(r.code).toBe(0)
    for (const name of ['Tagliata di Manzo', 'Té Hatsu', 'Soda Hatsu'])
      expect(r.output).toContain(`La carta ya no tiene «${name}»`)
    expect(check(folder, 'products')).toBe(1)
  })

  it('a sold-out dish is archived on the next run and the summary counts it', () => {
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
    expect(seed({ MENU_PATH: route }).output).toMatch(/products\s+2 nuevos/)
    writeFileSync(route, menu(false))
    const r = seed({ MENU_PATH: route })
    expect(r.output).toMatch(/products\s+0 nuevos, 0 cambiados, 1 iguales, 1 archivados/)
    expect(check(folder, 'products')).toBe(2)
  })

  it('a menu that does not exist or is corrupted exits with code 1, a clear message and without creating the database', () => {
    const nonexistent = seed({ MENU_PATH: join(folder, 'no-existe.yaml') })
    expect(nonexistent.code).toBe(1)
    expect(nonexistent.output).toMatch(/No se cargaron los datos: la carta .* no sirve/)
    expect(existsSync(join(folder, 'pos.sqlite'))).toBe(false)

    const corrupted = join(folder, 'danada.yaml')
    writeFileSync(corrupted, 'secciones: [una carta sin cerrar')
    expect(seed({ MENU_PATH: corrupted }).code).toBe(1)

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
    const r = seed({ MENU_PATH: decimal })
    expect(r.code).toBe(1)
    expect(existsSync(join(folder, 'pos.sqlite'))).toBe(false)
  })

  it('the PINs go to two separate files per run, one for the admin and one for the staff, with mode 600', () => {
    const r = seed()
    expect(r.code).toBe(0)
    const files = readdirSync(folder).filter((f) => /^pines-.*\.txt$/.test(f))
    expect(files.filter((f) => f.endsWith('-administrador.txt'))).toHaveLength(1)
    expect(files.filter((f) => f.endsWith('-personal.txt'))).toHaveLength(1)
    expect(files).toHaveLength(2)
    expect(
      readFileSync(
        join(folder, files.find((f) => f.endsWith('-administrador.txt')) as string),
        'utf8',
      ),
    ).toMatch(/Contraseña:\s+\S+[\s\S]*PIN para autorizar:\s+\d{4}/)
    for (const f of files) {
      // On Windows the mode does not apply; on macOS and Linux it does.
      if (process.platform !== 'win32') expect(statSync(join(folder, f)).mode & 0o777).toBe(0o600)
    }
    // A second run without new staff does not leave another file.
    expect(seed().code).toBe(0)
    expect(readdirSync(folder).filter((f) => /^pines-.*\.txt$/.test(f))).toEqual(files)
  })

  it('the hub starts after the seed without asking for another PIN and without touching the data', async () => {
    expect(seed().code).toBe(0)
    const before = photo(folder)

    const port = await freePort()
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
    const finished = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      await new Promise<void>((resolve, reject) => {
        const onReceive = (t: Buffer) => {
          output += String(t)
          if (output.includes('Hub en marcha')) resolve()
        }
        child.stdout?.on('data', onReceive)
        child.stderr?.on('data', (t) => {
          output += String(t)
        })
        child.once('exit', (c) => reject(new Error(`The hub exited with code ${c}:\n${output}`)))
      })
      // It responds with the seed's database already open.
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      expect(r.status).toBe(200)
    } finally {
      child.kill('SIGKILL')
      await finished
    }
    expect(output).not.toMatch(/PIN del administrador/)
    expect(output).not.toMatch(/clave de los PIN/)
    expect(photo(folder)).toEqual(before)
  })

  it('the seed does not run if another process has the database open, and changes nothing', async () => {
    expect(seed().code).toBe(0)
    const before = photo(folder)
    const locked = openDatabase(join(folder, 'pos.sqlite'), { exclusive: true })
    try {
      const r = seed()
      expect(r.code).toBe(1)
      expect(r.output).toContain('el hub está abierto')
    } finally {
      locked.close()
    }
    expect(photo(folder)).toEqual(before)
  })
})
