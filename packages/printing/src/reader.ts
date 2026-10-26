import { type CodePage, decode } from './encoding'

// Reads what a printer would receive (the commands from `escpos.ts`) and turns it into text: for
// the hub's test printer and to check in tests what came out on paper.

const PAGE_OF: Record<number, CodePage> = { 2: 'pc850', 16: 'wpc1252' }

export interface ReadResult {
  text: string
  /** How many times the paper was cut (once per ticket). */
  cuts: number
}

export function readEscpos(bytes: Uint8Array): ReadResult {
  let page: CodePage = 'no_accents'
  let line: number[] = []
  const lines: string[] = []
  let cuts = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    if (b === 0x1b) {
      const position = bytes[i + 1]
      if (position === 0x40) i += 1
      else if (position === 0x74) {
        page = PAGE_OF[bytes[i + 2] as number] ?? 'no_accents'
        i += 2
      } else if (position === 0x64) {
        for (let n = 0; n < (bytes[i + 2] as number); n++) lines.push('')
        i += 2
      } else i += 2
      continue
    }
    if (b === 0x1d) {
      if (bytes[i + 1] === 0x56) {
        cuts += 1
        lines.push('✂ ─────────')
        i += 3
      } else i += 2
      continue
    }
    if (b === 0x0a) {
      lines.push(decode(line, page))
      line = []
      continue
    }
    line.push(b)
  }
  if (line.length > 0) lines.push(decode(line, page))
  return { text: lines.join('\n'), cuts }
}
