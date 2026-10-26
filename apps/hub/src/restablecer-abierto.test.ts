import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '@pos/db/node'
import { afterEach, describe, expect, it } from 'vitest'
import { contrasenaCoincide } from './acceso/secretos'

// `pnpm restablecer-admin` con el hub abierto: no cambia nada, avisa qué hacer y no deja
// archivos con contraseñas. El «hub abierto» es este proceso con la base tomada en exclusiva.

const DIR_HUB = fileURLToPath(new URL('..', import.meta.url))

const correr = (script: string, dirDatos: string) => {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', script],
    { cwd: DIR_HUB, env: { ...process.env, DATA_DIR: dirDatos }, encoding: 'utf8' },
  )
  return { code: r.status, output: `${r.stdout}${r.stderr}` }
}

describe('restablecer-admin con el hub abierto', { timeout: 90_000 }, () => {
  let folder = ''
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('no cambia la contraseña, sale con código 1, explica que hay que cerrar el hub y no escribe archivos', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-restablecer-abierto-'))
    expect(correr('src/seed/main.ts', folder).code).toBe(0)
    const before = readdirSync(folder).sort()

    // El «hub»: abre la base como lo hace main.ts (exclusiva) y la mantiene.
    const hub = openDatabase(join(folder, 'pos.sqlite'), { exclusive: true })
    const fingerprint = () =>
      String(
        hub
          .prepare("SELECT password_hash AS h FROM user_credentials WHERE username = 'admin'")
          .get()?.h,
      )
    const huellaAntes = fingerprint()
    try {
      const r = correr('src/restablecer.ts', folder)
      expect(r.code).toBe(1)
      expect(r.output).toMatch(/el hub está abierto/)
      expect(r.output).toMatch(/No se cambió nada/)
      expect(r.output).not.toMatch(/Contraseña:/)
      expect(fingerprint()).toBe(huellaAntes)
    } finally {
      hub.close()
    }
    // Sin archivo nuevo de contraseña.
    expect(readdirSync(folder).filter((f) => /^restablecer-/.test(f))).toEqual([])
    expect(
      readdirSync(folder)
        .sort()
        .filter((f) => !f.startsWith('pos.sqlite')),
    ).toEqual(before.filter((f) => !f.startsWith('pos.sqlite')))
  })

  it('al cerrar el hub, el mismo comando sí funciona y la contraseña anterior deja de servir', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-restablecer-abierto-'))
    correr('src/seed/main.ts', folder)
    const hub = openDatabase(join(folder, 'pos.sqlite'), { exclusive: true })
    expect(correr('src/restablecer.ts', folder).code).toBe(1)
    hub.close()
    const r = correr('src/restablecer.ts', folder)
    expect(r.code).toBe(0)
    const db = openDatabase(join(folder, 'pos.sqlite'))
    const fingerprint = String(
      db.prepare("SELECT password_hash AS h FROM user_credentials WHERE username = 'admin'").get()
        ?.h,
    )
    ;(db as unknown as { close(): void }).close()
    expect(contrasenaCoincide('no-es-esta-clave', fingerprint)).toBe(false)
  })
})
