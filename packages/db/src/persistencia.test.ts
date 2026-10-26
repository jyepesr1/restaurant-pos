import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId } from '@pos/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRACIONES } from './migraciones'
import { aplicarMigraciones, versionActual } from './migrar'

const TODAS = MIGRACIONES.map((m) => m.version)
const ULTIMA = TODAS.at(-1)

import { abrirBase } from './node'
import { insertarEvento, sembrar } from './pruebas/utiles'
import type { BaseSqlite } from './sqlite'

const HIJO = fileURLToPath(new URL('./pruebas/hijo-transaccion.mjs', import.meta.url))

describe('base en archivo', () => {
  let carpeta: string
  let ruta: string
  const abiertas: BaseSqlite[] = []

  const open = () => {
    const db = abrirBase(ruta)
    abiertas.push(db)
    return db
  }

  beforeEach(() => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-db-'))
    ruta = join(carpeta, 'pos.sqlite')
  })

  afterEach(() => {
    for (const db of abiertas.splice(0)) (db as unknown as { close(): void }).close()
    rmSync(carpeta, { recursive: true, force: true })
  })

  it('se abre en modo WAL con claves foráneas y sincronía completa', () => {
    const db = open()

    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
    expect(db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2)
  })

  it('reabrir un archivo ya migrado no repite migraciones y conserva los datos', () => {
    const first = open()
    expect(aplicarMigraciones(first, undefined, () => '2026-10-24T10:00:00.000Z')).toEqual(TODAS)
    const { restaurant } = sembrar(first)
    const event = insertarEvento(first, restaurant)
    ;(first as unknown as { close(): void }).close()
    abiertas.length = 0

    const segunda = open()
    expect(aplicarMigraciones(segunda, undefined, () => '2030-01-01T00:00:00.000Z')).toEqual([])

    expect(versionActual(segunda)).toBe(ULTIMA)
    expect(segunda.prepare('SELECT version, applied_at FROM migrations').all()).toEqual(
      TODAS.map((version) => ({ version, applied_at: '2026-10-24T10:00:00.000Z' })),
    )
    expect(
      segunda.prepare('SELECT id, data FROM events WHERE restaurant_id = ?').all(restaurant),
    ).toEqual([{ id: event.id, data: '{"channel":"salon"}' }])
    expect(segunda.prepare('SELECT name FROM products').all()).toEqual([{ name: 'Margarita' }])
  })

  it('una base migrada y reabierta sigue rechazando UPDATE de eventos', () => {
    const first = open()
    aplicarMigraciones(first)
    const { restaurant } = sembrar(first)
    insertarEvento(first, restaurant)
    ;(first as unknown as { close(): void }).close()
    abiertas.length = 0

    expect(() => open().exec("UPDATE events SET data = '{}'")).toThrow(/no se modifican/)
  })

  it('si el proceso muere a mitad de una transacción no queda nada a medias', async () => {
    const initial = open()
    aplicarMigraciones(initial)
    const { restaurant } = sembrar(initial)
    const confirmed = insertarEvento(initial, restaurant, { sequence: 1 })
    const pending = newId()

    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', HIJO, ruta, restaurant, pending],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let errors = ''
    child.stderr.on('data', (chunk) => {
      errors += String(chunk)
    })
    const salio = new Promise<NodeJS.Signals | null>((resolver) =>
      child.on('exit', (_codigo, senal) => resolver(senal)),
    )

    // El hijo avisa cuando ya hizo el INSERT dentro de BEGIN y todavía no confirma.
    await new Promise<void>((resolver, reject) => {
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
        if (output.includes('en-transaccion')) resolver()
      })
      child.on('exit', () => reject(new Error(`El hijo terminó antes de tiempo: ${errors}`)))
    })

    // Mientras la transacción sigue abierta, otro lector solo ve lo confirmado.
    const events = () =>
      initial
        .prepare('SELECT id FROM events ORDER BY sequence')
        .all()
        .map((row) => row.id)
    expect(events()).toEqual([confirmed.id])

    child.kill('SIGKILL')
    expect(await salio).toBe('SIGKILL')
    ;(initial as unknown as { close(): void }).close()
    abiertas.length = 0

    const reabierta = open()
    expect(aplicarMigraciones(reabierta)).toEqual([])
    expect(versionActual(reabierta)).toBe(ULTIMA)
    expect(
      reabierta
        .prepare('SELECT id FROM events ORDER BY sequence')
        .all()
        .map((row) => row.id),
    ).toEqual([confirmed.id])
    expect(reabierta.prepare('SELECT count(*) AS n FROM events WHERE id = ?').get(pending)?.n).toBe(
      0,
    )
    expect(reabierta.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')

    // La secuencia 2 que usaba el hijo queda libre para el siguiente evento real.
    expect(() => insertarEvento(reabierta, restaurant, { sequence: 2 })).not.toThrow()
  })

  it('crear la base en una carpeta nueva deja el archivo en la última versión', () => {
    const db = open()
    aplicarMigraciones(db)

    expect(existsSync(ruta)).toBe(true)
    expect(versionActual(db)).toBe(ULTIMA)
  })
})
