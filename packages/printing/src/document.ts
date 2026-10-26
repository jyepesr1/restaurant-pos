import { type CodePage, characters } from './encoding'

// A printed document is a list of styled lines. It is built already wrapped to the printer
// width, and from it come both ESC/POS (`escpos.ts`) and text to view on screen.

export type Width = 58 | 80

/** Characters per line with the normal font (font A, 12 × 24 dots). */
export const COLUMNS: Record<Width, number> = { 58: 32, 80: 48 }

export interface Style {
  /** Double height and width: half as many characters fit. */
  large?: boolean
  bold?: boolean
  /** White on black: what the kitchen cannot miss. */
  reversed?: boolean
  center?: boolean
}

export type Line = ({ text: string } & Style) | { separator: true } | { space: true }

export interface Format {
  columns: number
  page: CodePage
}

/** Characters that fit on a line with that style. */
export const widthOf = (format: Format, style: Style) =>
  style.large ? Math.floor(format.columns / 2) : format.columns

/**
 * Wraps a text into lines of that width, by words; a word longer than the line is cut.
 * Measures with the characters already converted to the printer's code page.
 */
export function wrapText(text: string, width: number, format: Format): string[] {
  const words = characters(text, format.page).join('').split(' ').filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    let rest = word
    while (rest.length > width) {
      if (current) {
        lines.push(current)
        current = ''
      }
      lines.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
    if (!rest) continue
    if (!current) current = rest
    else if (current.length + 1 + rest.length <= width) current = `${current} ${rest}`
    else {
      lines.push(current)
      current = rest
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

/** A styled text, wrapped into as many lines as needed. */
export function paragraph(text: string, format: Format, style: Style = {}): Line[] {
  return wrapText(text, widthOf(format, style), format).map((t) => ({ text: t, ...style }))
}

/**
 * Text on the left and on the right of the same line («Mesa 6 ··· #12»). If they do not fit
 * together, the right side moves down to its own line.
 */
export function toSides(
  left: string,
  rightSide: string,
  format: Format,
  style: Style = {},
): Line[] {
  const width = widthOf(format, style)
  const leftPart = wrapText(left, width, format)
  const right = characters(rightSide, format.page).join('')
  if (!right) return leftPart.map((t) => ({ text: t, ...style }))
  const last = leftPart.at(-1) ?? ''
  if (last.length + 1 + right.length <= width) {
    leftPart[leftPart.length - 1] = last + ' '.repeat(width - last.length - right.length) + right
    return leftPart.map((t) => ({ text: t, ...style }))
  }
  return [
    ...leftPart.map((t) => ({ text: t, ...style })),
    ...paragraph(rightSide, format, { ...style, center: false }),
  ]
}

/**
 * The document as text, to view on screen or in a test: large text goes in uppercase,
 * reversed text in brackets and the separator as dashes.
 */
export function asText(lines: readonly Line[], columns: number): string {
  return lines
    .map((l) => {
      if ('separator' in l) return '-'.repeat(columns)
      if ('space' in l) return ''
      let t = l.large ? l.text.toUpperCase() : l.text
      if (l.reversed) t = `[${t}]`
      if (l.center) {
        const width = l.large ? Math.floor(columns / 2) : columns
        t = ' '.repeat(Math.max(0, Math.floor((width - t.length) / 2))) + t
      }
      return t.trimEnd()
    })
    .join('\n')
}
