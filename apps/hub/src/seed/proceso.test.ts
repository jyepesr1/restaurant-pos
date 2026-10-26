import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '@pos/db/node'
import { afterEach, describe, expect, it } from 'vitest'

// `pnpm seed` como lo corre el usuario: un proceso aparte sobre una carpeta de datos.

const DIR_HUB = fileURLToPath(new URL('../..', import.meta.url))

const seed = (dirDatos: string) => {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/seed/main.ts'],
    { cwd: DIR_HUB, env: { ...process.env, DATA_DIR: dirDatos }, encoding: 'utf8' },
  )
  return { code: r.status, output: `${r.stdout}${r.stderr}` }
}

describe('pnpm seed (proceso real)', { timeout: 60_000 }, () => {
  let folder = ''
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('la primera vez crea todo y deja los PIN en un archivo; la segunda no cambia nada', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-seed-'))
    const first = seed(folder)
    expect(first.code).toBe(0)
    expect(first.output).toMatch(/products\s+98 nuevos/)
    // Sin ventana, los PIN no salen en la consola: van a un archivo.
    expect(first.output).not.toMatch(/Mesero 1\s+PIN \d{4}/)
    // Un archivo por corrida: primero el del administrador, luego el del personal.
    const archivos = readdirSync(folder).filter((f) => /^pines-.*\.txt$/.test(f))
    const pins = archivos.map((f) => readFileSync(join(folder, f), 'utf8')).join('')
    expect(pins).toMatch(/Contraseña:\s+\S+[\s\S]*PIN para autorizar:\s+\d{4}/)
    expect(pins).toMatch(/Mesero 3\s+PIN \d{4}/)

    const second = seed(folder)
    expect(second.code).toBe(0)
    expect(second.output).toMatch(/products\s+0 nuevos, 0 cambiados, 98 iguales/)
    expect(second.output).toContain('No se creó personal nuevo')
  })

  it('con el hub abierto no toca nada y lo dice', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-seed-'))
    const hubAbierto = openDatabase(join(folder, 'pos.sqlite'), { exclusive: true })
    try {
      const r = seed(folder)
      expect(r.code).toBe(1)
      expect(r.output).toContain('el hub está abierto')
    } finally {
      ;(hubAbierto as unknown as { close(): void }).close()
    }
  })
})
