import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrirBase } from '@pos/db/node'
import { afterEach, describe, expect, it } from 'vitest'
import { contrasenaCoincide } from './acceso/secretos'

// `pnpm restablecer-admin` con el hub abierto: no cambia nada, avisa qué hacer y no deja
// archivos con contraseñas. El «hub abierto» es este proceso con la base tomada en exclusiva.

const DIR_HUB = fileURLToPath(new URL('..', import.meta.url))

const correr = (script: string, dirDatos: string) => {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', script],
    { cwd: DIR_HUB, env: { ...process.env, DIR_DATOS: dirDatos }, encoding: 'utf8' },
  )
  return { codigo: r.status, salida: `${r.stdout}${r.stderr}` }
}

describe('restablecer-admin con el hub abierto', { timeout: 90_000 }, () => {
  let carpeta = ''
  afterEach(() => rmSync(carpeta, { recursive: true, force: true }))

  it('no cambia la contraseña, sale con código 1, explica que hay que cerrar el hub y no escribe archivos', () => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-restablecer-abierto-'))
    expect(correr('src/seed/main.ts', carpeta).codigo).toBe(0)
    const antes = readdirSync(carpeta).sort()

    // El «hub»: abre la base como lo hace main.ts (exclusiva) y la mantiene.
    const hub = abrirBase(join(carpeta, 'pos.sqlite'), { exclusiva: true })
    const huella = () =>
      String(
        hub
          .prepare(
            "SELECT contrasena_huella AS h FROM usuario_credencial WHERE nombre_usuario = 'admin'",
          )
          .get()?.h,
      )
    const huellaAntes = huella()
    try {
      const r = correr('src/restablecer.ts', carpeta)
      expect(r.codigo).toBe(1)
      expect(r.salida).toMatch(/el hub está abierto/)
      expect(r.salida).toMatch(/No se cambió nada/)
      expect(r.salida).not.toMatch(/Contraseña:/)
      expect(huella()).toBe(huellaAntes)
    } finally {
      hub.close()
    }
    // Sin archivo nuevo de contraseña.
    expect(readdirSync(carpeta).filter((f) => /^restablecer-/.test(f))).toEqual([])
    expect(
      readdirSync(carpeta)
        .sort()
        .filter((f) => !f.startsWith('pos.sqlite')),
    ).toEqual(antes.filter((f) => !f.startsWith('pos.sqlite')))
  })

  it('al cerrar el hub, el mismo comando sí funciona y la contraseña anterior deja de servir', () => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-restablecer-abierto-'))
    correr('src/seed/main.ts', carpeta)
    const hub = abrirBase(join(carpeta, 'pos.sqlite'), { exclusiva: true })
    expect(correr('src/restablecer.ts', carpeta).codigo).toBe(1)
    hub.close()
    const r = correr('src/restablecer.ts', carpeta)
    expect(r.codigo).toBe(0)
    const db = abrirBase(join(carpeta, 'pos.sqlite'))
    const huella = String(
      db
        .prepare(
          "SELECT contrasena_huella AS h FROM usuario_credencial WHERE nombre_usuario = 'admin'",
        )
        .get()?.h,
    )
    ;(db as unknown as { close(): void }).close()
    expect(contrasenaCoincide('no-es-esta-clave', huella)).toBe(false)
  })
})
