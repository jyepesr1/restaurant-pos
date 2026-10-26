import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// PIN, tokens y la clave del hub (ADR-008). Nada de esto sale del hub ni queda escrito en claro.

/** Decisión del dueño: 4 dígitos, un toque menos. Lo compensan el emparejamiento y la espera. */
export const DIGITOS_PIN = 4

/** Ni todos iguales ni seguidos (0000, 1234, 9876): son los primeros que alguien probaría. */
export function esPinTrivial(pin: string): boolean {
  const d = [...pin].map(Number)
  const steps = d.slice(1).map((x, i) => x - (d[i] as number))
  return steps.every((p) => p === 0) || steps.every((p) => p === 1) || steps.every((p) => p === -1)
}

/** PIN al azar con el generador criptográfico; el administrador no lo escoge. */
export function generarPin(random: (max: number) => number = (max) => randomInt(max)): string {
  for (;;) {
    const pin = String(random(10 ** DIGITOS_PIN)).padStart(DIGITOS_PIN, '0')
    if (!esPinTrivial(pin)) return pin
  }
}

export const esPinConFormato = (pin: unknown): pin is string =>
  typeof pin === 'string' && new RegExp(`^\\d{${DIGITOS_PIN}}$`).test(pin)

/** Huella del PIN: HMAC-SHA256 con la clave del hub. Sin la clave, la huella no sirve de nada. */
export const huellaPin = (key: Buffer, restauranteId: string, pin: string) =>
  createHmac('sha256', key).update(`${restauranteId}:${pin}`).digest('hex')

/** Token del dispositivo: 256 bits al azar. */
export const nuevoSecreto = () => randomBytes(32).toString('base64url')

/**
 * Secreto de una sesión: se deriva de la clave del hub, así el hub puede comprobar la firma de
 * los eventos sin guardar el secreto. Quien no tiene la clave no puede calcularlo.
 */
export const secretoDeSesion = (key: Buffer, restauranteId: string, sesionId: string) =>
  createHmac('sha256', key).update(`sesion:${restauranteId}:${sesionId}`).digest('base64url')

/** Basta SHA-256: un secreto de 256 bits al azar no se puede adivinar por fuerza bruta. */
export const huellaSecreto = (secret: string) => createHash('sha256').update(secret).digest('hex')

export function mismaHuella(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// ── Usuario y contraseña (ADR-013) ────────────────────────────────────

export const LARGO_MINIMO_CONTRASENA = 8
export const LARGO_MAXIMO_CONTRASENA = 200

/**
 * Costo de scrypt (N = 2^costo). 15 tarda unos 50 ms en un PC de caja: frena a quien tenga la
 * base y pruebe contraseñas, sin que entrar se sienta lento. Las pruebas usan menos.
 */
export const COSTO_CONTRASENA = 15

/** El largo se cuenta como se guarda (NFC): «ñ» es una letra aunque llegue como n + tilde. */
export const esContrasenaValida = (c: string) => {
  const n = c.normalize('NFC').length
  return n >= LARGO_MINIMO_CONTRASENA && n <= LARGO_MAXIMO_CONTRASENA
}

/**
 * El usuario como se guarda: sin espacios a los lados, en minúsculas y sin tildes («María» es
 * «maria»); solo letras, números, punto, guion y guion bajo, de 3 a 40. `null` si no sirve.
 */
export function normalizarUsuario(user: string): string | null {
  const u = user
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  return /^[a-z0-9._-]{3,40}$/.test(u) ? u : null
}

/** Huella lenta con sal: `scrypt$costo$r$p$sal$huella`, todo lo que hace falta para comprobarla. */
export function huellaContrasena(password: string, costo = COSTO_CONTRASENA): string {
  const sal = randomBytes(16)
  const fingerprint = scryptSync(password.normalize('NFC'), sal, 32, opcionesScrypt(costo))
  return ['scrypt', costo, 8, 1, sal.toString('base64url'), fingerprint.toString('base64url')].join(
    '$',
  )
}

/** Si la contraseña da esa huella, comparando en tiempo constante. */
export function contrasenaCoincide(password: string, guardada: string): boolean {
  const [esquema, costo, r, p, sal, fingerprint] = guardada.split('$')
  if (esquema !== 'scrypt' || !sal || !fingerprint || r !== '8' || p !== '1') return false
  const n = Number(costo)
  if (!Number.isInteger(n) || n < 1 || n > 20) return false
  const expected = Buffer.from(fingerprint, 'base64url')
  const calculada = scryptSync(
    password.normalize('NFC'),
    Buffer.from(sal, 'base64url'),
    expected.length,
    opcionesScrypt(n),
  )
  return calculada.length === expected.length && timingSafeEqual(calculada, expected)
}

const opcionesScrypt = (costo: number) => ({
  N: 2 ** costo,
  r: 8,
  p: 1,
  // scrypt usa 128·N·r bytes; el doble deja margen sin pasar de lo razonable.
  maxmem: Math.max(32 * 1024 * 1024, 2 * 128 * 2 ** costo * 8),
})

/** Sin letras que se confundan: la primera contraseña del administrador se copia de la ventana. */
const ALFABETO_CONTRASENA = 'abcdefghjkmnpqrstuvwxyz23456789'

/** Tres grupos de cuatro (`k7mp-x9rt-4hwa`): unos 59 bits, fácil de copiar a mano. */
export function generarContrasena(): string {
  const group = () =>
    Array.from(
      { length: 4 },
      () => ALFABETO_CONTRASENA[randomInt(ALFABETO_CONTRASENA.length)],
    ).join('')
  return [group(), group(), group()].join('-')
}

/** Sin letras que se confundan (0/O, 1/I/L): el código se puede dictar si el QR no lee. */
const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function nuevoCodigoEmparejamiento(): string {
  return Array.from({ length: 8 }, () => ALFABETO_CODIGO[randomInt(ALFABETO_CODIGO.length)]).join(
    '',
  )
}

export const ARCHIVO_CLAVE = 'pin-key'

/**
 * Lee la clave HMAC de la carpeta de datos o la crea (solo legible por el usuario del hub). Va
 * en el respaldo junto con la base: sin ella, ningún PIN guardado sirve.
 */
export function cargarClave(dirDatos: string): {
  key: Buffer
  newOne: boolean
  /** Desde cuándo existe esta clave: las sesiones anteriores se firmaron con otra. */
  creadaEn: string
} {
  const ruta = join(dirDatos, ARCHIVO_CLAVE)
  if (existsSync(ruta)) {
    const key = readFileSync(ruta)
    if (key.length !== 32) throw new Error(`La clave de los PIN (${ruta}) está dañada.`)
    return { key, newOne: false, creadaEn: statSync(ruta).mtime.toISOString() }
  }
  const key = randomBytes(32)
  writeFileSync(ruta, key, { mode: 0o600, flag: 'wx' })
  return { key, newOne: true, creadaEn: statSync(ruta).mtime.toISOString() }
}
