import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '@pos/db/node'
import { afterEach, describe, expect, it } from 'vitest'
import { passwordMatches } from './access/secrets'

// `pnpm reset-admin` with the hub open: it changes nothing, says what to do and leaves no files
// with passwords. The "open hub" is this process holding the database exclusively.

const DIR_HUB = fileURLToPath(new URL('..', import.meta.url))

const run = (script: string, dataDir: string) => {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', script],
    { cwd: DIR_HUB, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' },
  )
  return { code: r.status, output: `${r.stdout}${r.stderr}` }
}

describe('reset-admin with the hub open', { timeout: 90_000 }, () => {
  let folder = ''
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('does not change the password, exits with code 1, explains the hub must be closed and writes no files', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-reset-open-'))
    expect(run('src/seed/main.ts', folder).code).toBe(0)
    const before = readdirSync(folder).sort()

    // The "hub": opens the database as main.ts does (exclusive) and holds it.
    const hub = openDatabase(join(folder, 'pos.sqlite'), { exclusive: true })
    const fingerprint = () =>
      String(
        hub
          .prepare("SELECT password_hash AS h FROM user_credentials WHERE username = 'admin'")
          .get()?.h,
      )
    const fingerprintBefore = fingerprint()
    try {
      const r = run('src/reset.ts', folder)
      expect(r.code).toBe(1)
      expect(r.output).toMatch(/el hub está abierto/)
      expect(r.output).toMatch(/No se cambió nada/)
      expect(r.output).not.toMatch(/Contraseña:/)
      expect(fingerprint()).toBe(fingerprintBefore)
    } finally {
      hub.close()
    }
    // No new password file.
    expect(readdirSync(folder).filter((f) => /^restablecer-/.test(f))).toEqual([])
    expect(
      readdirSync(folder)
        .sort()
        .filter((f) => !f.startsWith('pos.sqlite')),
    ).toEqual(before.filter((f) => !f.startsWith('pos.sqlite')))
  })

  it('once the hub is closed, the same command works and the old password stops working', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-reset-open-'))
    run('src/seed/main.ts', folder)
    const hub = openDatabase(join(folder, 'pos.sqlite'), { exclusive: true })
    expect(run('src/reset.ts', folder).code).toBe(1)
    hub.close()
    const r = run('src/reset.ts', folder)
    expect(r.code).toBe(0)
    const db = openDatabase(join(folder, 'pos.sqlite'))
    const fingerprint = String(
      db.prepare("SELECT password_hash AS h FROM user_credentials WHERE username = 'admin'").get()
        ?.h,
    )
    ;(db as unknown as { close(): void }).close()
    expect(passwordMatches('no-es-esta-clave', fingerprint)).toBe(false)
  })
})
