import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrirBase } from '@pos/db/node'
import { afterEach, describe, expect, it } from 'vitest'
import { contrasenaCoincide } from './acceso/secretos'

// `pnpm restablecer-admin` como lo corre el usuario: un proceso aparte sobre la carpeta de datos.

const DIR_HUB = fileURLToPath(new URL('..', import.meta.url))

const correr = (script: string, dirDatos: string) => {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', script],
    { cwd: DIR_HUB, env: { ...process.env, DATA_DIR: dirDatos }, encoding: 'utf8' },
  )
  return { code: r.status, output: `${r.stdout}${r.stderr}` }
}

/** La contraseña de un archivo que dejó el proceso (sin ventana, van a un archivo). */
const contrasenaDe = (dirDatos: string, patron: RegExp) => {
  const archivo = readdirSync(dirDatos).find((f) => patron.test(f)) as string
  return /Contraseña:\s+(\S+)/.exec(readFileSync(join(dirDatos, archivo), 'utf8'))?.[1] as string
}

const huellaGuardada = (dirDatos: string) => {
  const db = abrirBase(join(dirDatos, 'pos.sqlite'))
  const f = db.prepare("SELECT password_hash FROM user_credentials WHERE username = 'admin'").get()
  ;(db as unknown as { close(): void }).close()
  return String(f?.password_hash)
}

describe('pnpm restablecer-admin (proceso real)', { timeout: 60_000 }, () => {
  let carpeta = ''
  afterEach(() => rmSync(carpeta, { recursive: true, force: true }))

  it('da una contraseña nueva al administrador; la anterior deja de servir', () => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-restablecer-'))
    expect(correr('src/seed/main.ts', carpeta).code).toBe(0)
    const vieja = contrasenaDe(carpeta, /-administrador\.txt$/)

    const r = correr('src/restablecer.ts', carpeta)
    expect(r.code).toBe(0)
    expect(r.output).toMatch(/La contraseña nueva quedó en/)
    const newOne = contrasenaDe(carpeta, /^restablecer-/)
    expect(newOne).not.toBe(vieja)
    expect(contrasenaCoincide(newOne, huellaGuardada(carpeta))).toBe(true)
    expect(contrasenaCoincide(vieja, huellaGuardada(carpeta))).toBe(false)
    // La contraseña no sale en la pantalla.
    expect(r.output).not.toContain(newOne)
  })

  it('con un hub recién instalado (sin base) crea al administrador y muestra su contraseña', () => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-restablecer-'))
    const r = correr('src/restablecer.ts', carpeta)
    expect(r.code).toBe(0)
    expect(
      contrasenaCoincide(contrasenaDe(carpeta, /^restablecer-/), huellaGuardada(carpeta)),
    ).toBe(true)
  })
})
