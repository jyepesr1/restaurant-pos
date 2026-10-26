// Text to bytes for thermal printers. Generic ones (Jaltech, Xprinter…) do not understand UTF-8:
// they print with a one-byte-per-character code page chosen with `ESC t n`. Which one each brand
// ships varies, so it is configured per printer and the test page shows the accents (ADR-015).

export const CODE_PAGES = ['pc850', 'wpc1252', 'no_accents'] as const
export type CodePage = (typeof CODE_PAGES)[number]

/** Code page number for `ESC t n` (Epson ESC/POS). Without accents it keeps the factory one. */
export const CODE_PAGE_NUMBER: Record<CodePage, number | null> = {
  pc850: 2,
  wpc1252: 16,
  no_accents: null,
}

// Only what gets written on a menu in Spanish (and some Portuguese for Latin America).
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

/** What is not in the code page and has a clear ASCII equivalent. */
const EQUIVALENTS: Record<string, string> = {
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

/** Strips the accent: «ñ» becomes «n», «Á» becomes «A»; anything without an equivalent, «?». */
function stripAccent(character: string): string {
  const equivalent = EQUIVALENTS[character]
  if (equivalent !== undefined) return equivalent
  if (character === '¿' || character === '¡') return ''
  const base = character.normalize('NFD').replace(/[̀-ͯ]/g, '')
  return /^[\x20-\x7e]*$/.test(base) && base.length > 0 ? base : '?'
}

/**
 * Keeps only printable characters: a name with a control byte (ESC, GS) would give the printer
 * commands (cut, open the drawer). Line breaks and tabs become spaces.
 */
export function clear(text: string): string {
  let output = ''
  for (const c of text) {
    const n = c.codePointAt(0) ?? 0
    if (n === 0x09 || n === 0x0a || n === 0x0b || n === 0x0c || n === 0x0d) output += ' '
    else if (!invisible(n)) output += c
  }
  return output
}

/** Control, format and directionality: invisible, and some are commands for the printer. */
const invisible = (n: number) =>
  n < 0x20 ||
  (n >= 0x7f && n <= 0x9f) ||
  (n >= 0x200b && n <= 0x200f) ||
  (n >= 0x2028 && n <= 0x202e) ||
  (n >= 0x2060 && n <= 0x206f) ||
  n === 0xfeff

/**
 * Each character, as that code page prints it (one per byte). Used to measure the real width of
 * a line before wrapping it.
 */
export function characters(text: string, page: CodePage): string[] {
  const output: string[] = []
  for (const c of clear(text)) {
    if (c >= ' ' && c <= '~') output.push(c)
    else if (page === 'pc850' && PC850[c] !== undefined) output.push(c)
    else if (page === 'wpc1252' && c.charCodeAt(0) >= 0xa1 && c.charCodeAt(0) <= 0xff)
      output.push(c)
    else output.push(...stripAccent(c))
  }
  return output
}

/** Bytes of a text in that code page. Never produces a control byte. */
export function encode(text: string, page: CodePage): number[] {
  return characters(text, page).map((c) => {
    if (page === 'pc850') return PC850[c] ?? c.charCodeAt(0)
    return c.charCodeAt(0)
  })
}

const FROM_PC850 = new Map(Object.entries(PC850).map(([c, b]) => [b, c]))

/** The reverse of `encode`: to read on screen what a test printer received. */
export function decode(bytes: Iterable<number>, page: CodePage): string {
  let text = ''
  for (const b of bytes) {
    if (b < 0x80) text += String.fromCharCode(b)
    else if (page === 'pc850') text += FROM_PC850.get(b) ?? '?'
    else text += String.fromCharCode(b)
  }
  return text
}
