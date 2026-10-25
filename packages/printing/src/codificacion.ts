// Texto a bytes para impresoras térmicas. Las genéricas (Jaltech, Xprinter…) no entienden UTF-8:
// imprimen con una tabla de un byte por carácter que se elige con `ESC t n`. Cuál trae cada marca
// varía, así que se configura por impresora y la página de prueba muestra las tildes (ADR-015).

export const PAGINAS_CODIGOS = ['pc850', 'wpc1252', 'sin_tildes'] as const
export type PaginaCodigos = (typeof PAGINAS_CODIGOS)[number]

/** Número de la tabla para `ESC t n` (Epson ESC/POS). Sin tildes se queda en la de fábrica. */
export const NUMERO_PAGINA: Record<PaginaCodigos, number | null> = {
  pc850: 2,
  wpc1252: 16,
  sin_tildes: null,
}

// Solo lo que se escribe en una carta en español (y algo de portugués para Latam).
const PC850: Record<string, number> = {
  Ç: 0x80,
  ü: 0x81,
  é: 0x82,
  â: 0x83,
  ä: 0x84,
  à: 0x85,
  ç: 0x87,
  ê: 0x88,
  è: 0x8a,
  ï: 0x8b,
  î: 0x8c,
  ì: 0x8d,
  É: 0x90,
  ô: 0x93,
  ò: 0x95,
  û: 0x96,
  ù: 0x97,
  Ü: 0x9a,
  á: 0xa0,
  í: 0xa1,
  ó: 0xa2,
  ú: 0xa3,
  ñ: 0xa4,
  Ñ: 0xa5,
  ª: 0xa6,
  º: 0xa7,
  '¿': 0xa8,
  '¡': 0xad,
  '«': 0xae,
  '»': 0xaf,
  Á: 0xb5,
  Â: 0xb6,
  À: 0xb7,
  ã: 0xc6,
  Ã: 0xc7,
  Ê: 0xd2,
  Í: 0xd6,
  Ó: 0xe0,
  Ô: 0xe2,
  õ: 0xe4,
  Õ: 0xe5,
  Ú: 0xe9,
  '°': 0xf8,
  '·': 0xfa,
}

/** Lo que no está en la tabla y tiene un equivalente claro en ASCII. */
const EQUIVALENTES: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  '·': '-',
  '×': 'x',
  ' ': ' ',
  '€': 'EUR',
}

/** Quita la tilde: «ñ» queda «n», «Á» queda «A»; lo que no tiene equivalente, «?». */
function sinTilde(caracter: string): string {
  const equivalente = EQUIVALENTES[caracter]
  if (equivalente !== undefined) return equivalente
  if (caracter === '¿' || caracter === '¡') return ''
  const base = caracter.normalize('NFD').replace(/[̀-ͯ]/g, '')
  return /^[\x20-\x7e]*$/.test(base) && base.length > 0 ? base : '?'
}

/**
 * Deja solo caracteres imprimibles: un nombre con un byte de control (ESC, GS) le daría órdenes
 * a la impresora (cortar, abrir el cajón). Saltos de línea y tabuladores pasan a espacios.
 */
export function limpiar(texto: string): string {
  let salida = ''
  for (const c of texto) {
    const n = c.codePointAt(0) ?? 0
    if (n === 0x09 || n === 0x0a || n === 0x0b || n === 0x0c || n === 0x0d) salida += ' '
    else if (!invisible(n)) salida += c
  }
  return salida
}

/** Control, formato y direccionalidad: no se ven y algunos son órdenes para la impresora. */
const invisible = (n: number) =>
  n < 0x20 ||
  (n >= 0x7f && n <= 0x9f) ||
  (n >= 0x200b && n <= 0x200f) ||
  (n >= 0x2028 && n <= 0x202e) ||
  (n >= 0x2060 && n <= 0x206f) ||
  n === 0xfeff

/**
 * Cada carácter, ya como lo imprime esa tabla (uno por byte). Sirve para medir el ancho real de
 * una línea antes de partirla.
 */
export function caracteres(texto: string, pagina: PaginaCodigos): string[] {
  const salida: string[] = []
  for (const c of limpiar(texto)) {
    if (c >= ' ' && c <= '~') salida.push(c)
    else if (pagina === 'pc850' && PC850[c] !== undefined) salida.push(c)
    else if (pagina === 'wpc1252' && c.charCodeAt(0) >= 0xa1 && c.charCodeAt(0) <= 0xff)
      salida.push(c)
    else salida.push(...sinTilde(c))
  }
  return salida
}

/** Bytes de un texto en esa tabla. Nunca produce un byte de control. */
export function codificar(texto: string, pagina: PaginaCodigos): number[] {
  return caracteres(texto, pagina).map((c) => {
    if (pagina === 'pc850') return PC850[c] ?? c.charCodeAt(0)
    return c.charCodeAt(0)
  })
}

const DESDE_PC850 = new Map(Object.entries(PC850).map(([c, b]) => [b, c]))

/** Lo contrario de `codificar`: para leer en pantalla lo que recibió una impresora de prueba. */
export function decodificar(bytes: Iterable<number>, pagina: PaginaCodigos): string {
  let texto = ''
  for (const b of bytes) {
    if (b < 0x80) texto += String.fromCharCode(b)
    else if (pagina === 'pc850') texto += DESDE_PC850.get(b) ?? '?'
    else texto += String.fromCharCode(b)
  }
  return texto
}
