import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '@pos/db/node'
import { afterEach, describe, expect, it } from 'vitest'
import { passwordMatches } from './access/secrets'

// `pnpm reset-admin` as the user runs it: a separate process on the data folder.

const DIR_HUB = fileURLToPath(new URL('..', import.meta.url))

const run = (script: string, dataDir: string) => {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', script],
    { cwd: DIR_HUB, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' },
  )
  return { code: r.status, output: `${r.stdout}${r.stderr}` }
}

/** The password from a file the process left (without a window, they go to a file). */
const passwordOf = (dataDir: string, pattern: RegExp) => {
  const file = readdirSync(dataDir).find((f) => pattern.test(f)) as string
  return /Contraseña:\s+(\S+)/.exec(readFileSync(join(dataDir, file), 'utf8'))?.[1] as string
}

const savedHash = (dataDir: string) => {
  const db = openDatabase(join(dataDir, 'pos.sqlite'))
  const f = db.prepare("SELECT password_hash FROM user_credentials WHERE username = 'admin'").get()
  ;(db as unknown as { close(): void }).close()
  return String(f?.password_hash)
}

describe('pnpm reset-admin (real process)', { timeout: 60_000 }, () => {
  let folder = ''
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('gives the admin a new password; the previous one stops working', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-restablecer-'))
    expect(run('src/seed/main.ts', folder).code).toBe(0)
    const old = passwordOf(folder, /-administrador\.txt$/)

    const r = run('src/reset.ts', folder)
    expect(r.code).toBe(0)
    expect(r.output).toMatch(/La contraseña nueva quedó en/)
    const newOne = passwordOf(folder, /^restablecer-/)
    expect(newOne).not.toBe(old)
    expect(passwordMatches(newOne, savedHash(folder))).toBe(true)
    expect(passwordMatches(old, savedHash(folder))).toBe(false)
    // The password does not show on screen.
    expect(r.output).not.toContain(newOne)
  })

  it('with a freshly installed hub (no database) it creates the admin and shows their password', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-restablecer-'))
    const r = run('src/reset.ts', folder)
    expect(r.code).toBe(0)
    expect(passwordMatches(passwordOf(folder, /^restablecer-/), savedHash(folder))).toBe(true)
  })
})
