import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '@pos/db/node'
import { afterEach, describe, expect, it } from 'vitest'

// `pnpm seed` as the user runs it: a separate process on a data folder.

const DIR_HUB = fileURLToPath(new URL('../..', import.meta.url))

const seed = (dataDir: string) => {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/seed/main.ts'],
    { cwd: DIR_HUB, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' },
  )
  return { code: r.status, output: `${r.stdout}${r.stderr}` }
}

describe('pnpm seed (real process)', { timeout: 60_000 }, () => {
  let folder = ''
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('the first time it creates everything and leaves the PINs in a file; the second changes nothing', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-seed-'))
    const first = seed(folder)
    expect(first.code).toBe(0)
    expect(first.output).toMatch(/products\s+98 nuevos/)
    // Without a window, the PINs do not show in the console: they go to a file.
    expect(first.output).not.toMatch(/Mesero 1\s+PIN \d{4}/)
    // One file per run: first the admin one, then the staff one.
    const files = readdirSync(folder).filter((f) => /^pines-.*\.txt$/.test(f))
    const pins = files.map((f) => readFileSync(join(folder, f), 'utf8')).join('')
    expect(pins).toMatch(/Contraseña:\s+\S+[\s\S]*PIN para autorizar:\s+\d{4}/)
    expect(pins).toMatch(/Mesero 3\s+PIN \d{4}/)

    const second = seed(folder)
    expect(second.code).toBe(0)
    expect(second.output).toMatch(/products\s+0 nuevos, 0 cambiados, 98 iguales/)
    expect(second.output).toContain('No se creó personal nuevo')
  })

  it('with the hub open it touches nothing and says so', () => {
    folder = mkdtempSync(join(tmpdir(), 'pos-seed-'))
    const openHub = openDatabase(join(folder, 'pos.sqlite'), { exclusive: true })
    try {
      const r = seed(folder)
      expect(r.code).toBe(1)
      expect(r.output).toContain('el hub está abierto')
    } finally {
      ;(openHub as unknown as { close(): void }).close()
    }
  })
})
