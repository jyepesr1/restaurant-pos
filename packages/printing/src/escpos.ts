import type { Line } from './document'
import { CODE_PAGE_NUMBER, type CodePage, encode } from './encoding'

// ESC/POS commands from Epson's basic set, which generic thermal printers understand.
// Only what every 58 or 80 mm printer has is used: size, bold, reversed, alignment,
// feed and cut.

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

const begin = [ESC, 0x40]
const tableName = (n: number) => [ESC, 0x74, n]
const align = (center: boolean) => [ESC, 0x61, center ? 1 : 0]
const bold = (yes: boolean) => [ESC, 0x45, yes ? 1 : 0]
const reversed = (yes: boolean) => [GS, 0x42, yes ? 1 : 0]
const size = (large: boolean) => [GS, 0x21, large ? 0x11 : 0x00]
/** Feeds n lines: the cut lands below the printout and not in the middle of the last product. */
const advance = (n: number) => [ESC, 0x64, n]
/** Partial cut (leaves a tab): the paper does not fall on the kitchen floor. */
const cut = [GS, 0x56, 0x42, 0x00]

/** The document as bytes for the printer, with feed and cut at the end. */
export function escpos(
  lines: readonly Line[],
  format: { columns: number; page: CodePage },
): Uint8Array {
  const bytes: number[] = [...begin]
  const n = CODE_PAGE_NUMBER[format.page]
  if (n !== null) bytes.push(...tableName(n))
  for (const line of lines) {
    if ('separator' in line) {
      bytes.push(...align(false), ...size(false), ...bold(false), ...reversed(false))
      bytes.push(...Array(format.columns).fill(0x2d), LF)
      continue
    }
    if ('space' in line) {
      bytes.push(LF)
      continue
    }
    bytes.push(
      ...align(!!line.center),
      ...size(!!line.large),
      ...bold(!!line.bold),
      ...reversed(!!line.reversed),
      ...encode(line.text, format.page),
      // Turned off before the line feed: reversed mode does not paint the rest of the line black.
      ...reversed(false),
      LF,
    )
  }
  bytes.push(...size(false), ...bold(false), ...align(false), ...advance(4), ...cut)
  return Uint8Array.from(bytes)
}
