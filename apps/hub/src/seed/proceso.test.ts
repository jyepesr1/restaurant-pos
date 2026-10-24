import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrirBase } from '@pos/db/node'
import { afterEach, describe, expect, it } from 'vitest'

// `pnpm seed` como lo corre el usuario: un proceso aparte sobre una carpeta de datos.

const DIR_HUB = fileURLToPath(new URL('../..', import.meta.url))

const seed = (dirDatos: string) => {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/seed/main.ts'],
    { cwd: DIR_HUB, env: { ...process.env, DIR_DATOS: dirDatos }, encoding: 'utf8' },
  )
  return { codigo: r.status, salida: `${r.stdout}${r.stderr}` }
}

describe('pnpm seed (proceso real)', { timeout: 60_000 }, () => {
  let carpeta = ''
  afterEach(() => rmSync(carpeta, { recursive: true, force: true }))

  it('la primera vez crea todo y deja los PIN en un archivo; la segunda no cambia nada', () => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-seed-'))
    const primera = seed(carpeta)
    expect(primera.codigo).toBe(0)
    expect(primera.salida).toMatch(/producto\s+98 nuevos/)
    // Sin ventana, los PIN no salen en la consola: van a un archivo.
    expect(primera.salida).not.toMatch(/Mesero 1\s+\d{4}/)
    // Un archivo por corrida: primero el del administrador, luego el del personal.
    const archivos = readdirSync(carpeta).filter((f) => /^pines-.*\.txt$/.test(f))
    const pines = archivos.map((f) => readFileSync(join(carpeta, f), 'utf8')).join('')
    expect(pines).toMatch(/Administrador\s+\d{4}/)
    expect(pines).toMatch(/Mesero 3\s+\d{4}/)

    const segunda = seed(carpeta)
    expect(segunda.codigo).toBe(0)
    expect(segunda.salida).toMatch(/producto\s+0 nuevos, 0 cambiados, 98 iguales/)
    expect(segunda.salida).toContain('No se creó personal nuevo')
  })

  it('con el hub abierto no toca nada y lo dice', () => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-seed-'))
    const hubAbierto = abrirBase(join(carpeta, 'pos.sqlite'), { exclusiva: true })
    try {
      const r = seed(carpeta)
      expect(r.codigo).toBe(1)
      expect(r.salida).toContain('el hub está abierto')
    } finally {
      ;(hubAbierto as unknown as { close(): void }).close()
    }
  })
})
