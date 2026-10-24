import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// PIN, tokens y la clave del hub (ADR-008). Nada de esto sale del hub ni queda escrito en claro.

/** Decisión del dueño: 4 dígitos, un toque menos. Lo compensan el emparejamiento y la espera. */
export const DIGITOS_PIN = 4

/** Ni todos iguales ni seguidos (0000, 1234, 9876): son los primeros que alguien probaría. */
export function esPinTrivial(pin: string): boolean {
  const d = [...pin].map(Number)
  const pasos = d.slice(1).map((x, i) => x - (d[i] as number))
  return pasos.every((p) => p === 0) || pasos.every((p) => p === 1) || pasos.every((p) => p === -1)
}

/** PIN al azar con el generador criptográfico; el administrador no lo escoge. */
export function generarPin(azar: (max: number) => number = (max) => randomInt(max)): string {
  for (;;) {
    const pin = String(azar(10 ** DIGITOS_PIN)).padStart(DIGITOS_PIN, '0')
    if (!esPinTrivial(pin)) return pin
  }
}

export const esPinConFormato = (pin: unknown): pin is string =>
  typeof pin === 'string' && new RegExp(`^\\d{${DIGITOS_PIN}}$`).test(pin)

/** Huella del PIN: HMAC-SHA256 con la clave del hub. Sin la clave, la huella no sirve de nada. */
export const huellaPin = (clave: Buffer, restauranteId: string, pin: string) =>
  createHmac('sha256', clave).update(`${restauranteId}:${pin}`).digest('hex')

/** Token del dispositivo: 256 bits al azar. */
export const nuevoSecreto = () => randomBytes(32).toString('base64url')

/**
 * Secreto de una sesión: se deriva de la clave del hub, así el hub puede comprobar la firma de
 * los eventos sin guardar el secreto. Quien no tiene la clave no puede calcularlo.
 */
export const secretoDeSesion = (clave: Buffer, restauranteId: string, sesionId: string) =>
  createHmac('sha256', clave).update(`sesion:${restauranteId}:${sesionId}`).digest('base64url')

/** Basta SHA-256: un secreto de 256 bits al azar no se puede adivinar por fuerza bruta. */
export const huellaSecreto = (secreto: string) => createHash('sha256').update(secreto).digest('hex')

export function mismaHuella(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Sin letras que se confundan (0/O, 1/I/L): el código se puede dictar si el QR no lee. */
const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function nuevoCodigoEmparejamiento(): string {
  return Array.from({ length: 8 }, () => ALFABETO_CODIGO[randomInt(ALFABETO_CODIGO.length)]).join(
    '',
  )
}

export const ARCHIVO_CLAVE = 'clave-pin'

/**
 * Lee la clave HMAC de la carpeta de datos o la crea (solo legible por el usuario del hub). Va
 * en el respaldo junto con la base: sin ella, ningún PIN guardado sirve.
 */
export function cargarClave(dirDatos: string): {
  clave: Buffer
  nueva: boolean
  /** Desde cuándo existe esta clave: las sesiones anteriores se firmaron con otra. */
  creadaEn: string
} {
  const ruta = join(dirDatos, ARCHIVO_CLAVE)
  if (existsSync(ruta)) {
    const clave = readFileSync(ruta)
    if (clave.length !== 32) throw new Error(`La clave de los PIN (${ruta}) está dañada.`)
    return { clave, nueva: false, creadaEn: statSync(ruta).mtime.toISOString() }
  }
  const clave = randomBytes(32)
  writeFileSync(ruta, clave, { mode: 0o600, flag: 'wx' })
  return { clave, nueva: true, creadaEn: statSync(ruta).mtime.toISOString() }
}
