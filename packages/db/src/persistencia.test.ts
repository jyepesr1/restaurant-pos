import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nuevoId } from '@pos/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aplicarMigraciones, versionActual } from './migrar'
import { abrirBase } from './node'
import { insertarEvento, sembrar } from './pruebas/utiles'
import type { BaseSqlite } from './sqlite'

const HIJO = fileURLToPath(new URL('./pruebas/hijo-transaccion.mjs', import.meta.url))

describe('base en archivo', () => {
  let carpeta: string
  let ruta: string
  const abiertas: BaseSqlite[] = []

  const abrir = () => {
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
    const db = abrir()

    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
    expect(db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2)
  })

  it('reabrir un archivo ya migrado no repite migraciones y conserva los datos', () => {
    const primera = abrir()
    expect(aplicarMigraciones(primera, undefined, () => '2026-10-24T10:00:00.000Z')).toEqual([1])
    const { restaurante } = sembrar(primera)
    const evento = insertarEvento(primera, restaurante)
    ;(primera as unknown as { close(): void }).close()
    abiertas.length = 0

    const segunda = abrir()
    expect(aplicarMigraciones(segunda, undefined, () => '2030-01-01T00:00:00.000Z')).toEqual([])

    expect(versionActual(segunda)).toBe(1)
    expect(segunda.prepare('SELECT version, aplicada_en FROM migracion').all()).toEqual([
      { version: 1, aplicada_en: '2026-10-24T10:00:00.000Z' },
    ])
    expect(
      segunda.prepare('SELECT id, datos FROM evento WHERE restaurante_id = ?').all(restaurante),
    ).toEqual([{ id: evento.id, datos: '{"canal":"salon"}' }])
    expect(segunda.prepare('SELECT nombre FROM producto').all()).toEqual([{ nombre: 'Margarita' }])
  })

  it('una base migrada y reabierta sigue rechazando UPDATE de eventos', () => {
    const primera = abrir()
    aplicarMigraciones(primera)
    const { restaurante } = sembrar(primera)
    insertarEvento(primera, restaurante)
    ;(primera as unknown as { close(): void }).close()
    abiertas.length = 0

    expect(() => abrir().exec("UPDATE evento SET datos = '{}'")).toThrow(/no se modifican/)
  })

  it('si el proceso muere a mitad de una transacción no queda nada a medias', async () => {
    const inicial = abrir()
    aplicarMigraciones(inicial)
    const { restaurante } = sembrar(inicial)
    const confirmado = insertarEvento(inicial, restaurante, { secuencia: 1 })
    const pendiente = nuevoId()

    const hijo = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', HIJO, ruta, restaurante, pendiente],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let errores = ''
    hijo.stderr.on('data', (trozo) => {
      errores += String(trozo)
    })
    const salio = new Promise<NodeJS.Signals | null>((resolver) =>
      hijo.on('exit', (_codigo, senal) => resolver(senal)),
    )

    // El hijo avisa cuando ya hizo el INSERT dentro de BEGIN y todavía no confirma.
    await new Promise<void>((resolver, rechazar) => {
      let salida = ''
      hijo.stdout.on('data', (trozo) => {
        salida += String(trozo)
        if (salida.includes('en-transaccion')) resolver()
      })
      hijo.on('exit', () => rechazar(new Error(`El hijo terminó antes de tiempo: ${errores}`)))
    })

    // Mientras la transacción sigue abierta, otro lector solo ve lo confirmado.
    const eventos = () =>
      inicial
        .prepare('SELECT id FROM evento ORDER BY secuencia')
        .all()
        .map((fila) => fila.id)
    expect(eventos()).toEqual([confirmado.id])

    hijo.kill('SIGKILL')
    expect(await salio).toBe('SIGKILL')
    ;(inicial as unknown as { close(): void }).close()
    abiertas.length = 0

    const reabierta = abrir()
    expect(aplicarMigraciones(reabierta)).toEqual([])
    expect(versionActual(reabierta)).toBe(1)
    expect(
      reabierta
        .prepare('SELECT id FROM evento ORDER BY secuencia')
        .all()
        .map((fila) => fila.id),
    ).toEqual([confirmado.id])
    expect(
      reabierta.prepare('SELECT count(*) AS n FROM evento WHERE id = ?').get(pendiente)?.n,
    ).toBe(0)
    expect(reabierta.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')

    // La secuencia 2 que usaba el hijo queda libre para el siguiente evento real.
    expect(() => insertarEvento(reabierta, restaurante, { secuencia: 2 })).not.toThrow()
  })

  it('crear la base en una carpeta nueva deja el archivo en la versión 1', () => {
    const db = abrir()
    aplicarMigraciones(db)

    expect(existsSync(ruta)).toBe(true)
    expect(versionActual(db)).toBe(1)
  })
})
