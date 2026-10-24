import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ESPERA_MAXIMA_MS, esperaTras, FALLOS_PARA_AVISO, Intentos } from './intentos'
import {
  ARCHIVO_CLAVE,
  cargarClave,
  esPinConFormato,
  esPinTrivial,
  generarPin,
  huellaPin,
  nuevoCodigoEmparejamiento,
} from './secretos'

describe('PIN', () => {
  it('descarta los triviales: todos iguales o seguidos', () => {
    for (const pin of ['0000', '7777', '1234', '6789', '9876', '3210'])
      expect(esPinTrivial(pin)).toBe(true)
    for (const pin of ['1235', '2468', '0911', '1212']) expect(esPinTrivial(pin)).toBe(false)
  })

  it('genera 4 dígitos, con ceros a la izquierda, y nunca uno trivial', () => {
    const azar = [1234, 7, 5555, 42]
    expect(generarPin(() => azar.shift() as number)).toBe('0007')
    expect(generarPin(() => azar.shift() as number)).toBe('0042')
    for (let i = 0; i < 2000; i++) {
      const pin = generarPin()
      expect(esPinConFormato(pin)).toBe(true)
      expect(esPinTrivial(pin)).toBe(false)
    }
  })

  it('la huella depende de la clave y del restaurante', () => {
    const a = Buffer.alloc(32, 1)
    const b = Buffer.alloc(32, 2)
    expect(huellaPin(a, 'r1', '4821')).toBe(huellaPin(a, 'r1', '4821'))
    expect(huellaPin(a, 'r1', '4821')).not.toBe(huellaPin(b, 'r1', '4821'))
    expect(huellaPin(a, 'r1', '4821')).not.toBe(huellaPin(a, 'r2', '4821'))
    expect(huellaPin(a, 'r1', '4821')).not.toContain('4821')
  })

  it('el código de emparejamiento no trae letras que se confundan', () => {
    for (let i = 0; i < 200; i++)
      expect(nuevoCodigoEmparejamiento()).toMatch(/^[A-HJKMNP-Z2-9]{8}$/)
  })
})

describe('clave del hub', () => {
  let carpeta = ''
  afterEach(() => rmSync(carpeta, { recursive: true, force: true }))

  it('se crea una vez, solo legible por el hub, y luego se lee igual', () => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-clave-'))
    const primera = cargarClave(carpeta)
    const segunda = cargarClave(carpeta)

    expect(primera.nueva).toBe(true)
    expect(segunda.nueva).toBe(false)
    expect(segunda.clave.equals(primera.clave)).toBe(true)
    if (process.platform !== 'win32')
      expect(statSync(join(carpeta, ARCHIVO_CLAVE)).mode & 0o777).toBe(0o600)
  })

  it('una clave dañada detiene el arranque con un mensaje claro', () => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-clave-'))
    writeFileSync(join(carpeta, ARCHIVO_CLAVE), 'corta')
    expect(() => cargarClave(carpeta)).toThrow(/dañada/)
  })
})

describe('espera tras intentos fallidos', () => {
  it('dos errores sin espera; luego 2, 4, 8… s hasta 60 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(esperaTras)).toEqual([
      0,
      0,
      2000,
      4000,
      8000,
      16_000,
      32_000,
      ESPERA_MAXIMA_MS,
      ESPERA_MAXIMA_MS,
    ])
  })

  it('es por quien intenta y se olvida tras 10 min sin fallos', () => {
    let ahora = 0
    const intentos = new Intentos(() => ahora)
    for (let i = 0; i < 3; i++) intentos.fallo('a')
    expect(intentos.esperaMs('a')).toBe(2000)
    expect(intentos.esperaMs('b')).toBe(0)

    ahora += 2000
    expect(intentos.esperaMs('a')).toBe(0)
    expect(intentos.fallo('a')).toBe(4000)

    ahora += 10 * 60_000
    expect(intentos.fallo('a')).toBe(0)
  })

  it('avisa al administrador cuando hay muchos fallos en 10 minutos, una vez', () => {
    const avisos: string[] = []
    const intentos = new Intentos(
      () => 0,
      (n) => avisos.push(n),
    )
    for (let i = 0; i < FALLOS_PARA_AVISO + 5; i++) intentos.fallo(`equipo-${i % 3}`)
    expect(avisos).toEqual([
      `${FALLOS_PARA_AVISO} PIN o códigos errados en 10 minutos en el restaurante`,
    ])
  })
})
