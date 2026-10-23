import { monotonicFactory } from 'ulidx'

// Monotónico: dos IDs creados en el mismo milisegundo en este dispositivo
// conservan el orden de creación.
const generar = monotonicFactory()

// Solo la forma canónica (mayúsculas, Crockford base32, primer carácter 0-7):
// el mismo ID escrito en minúsculas sería otra clave y rompería la idempotencia.
const ULID_CANONICO = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

/** ID ULID generado en el dispositivo; funciona sin conexión y sin colisiones. */
export function nuevoId(): string {
  return generar()
}

export function esIdValido(valor: string): boolean {
  return ULID_CANONICO.test(valor)
}
