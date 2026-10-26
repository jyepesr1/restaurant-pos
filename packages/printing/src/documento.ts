import { caracteres, type PaginaCodigos } from './codificacion'

// Un documento impreso es una lista de líneas con estilo. Se arma ya partido al ancho de la
// impresora, y de ahí sale lo mismo en ESC/POS (`escpos.ts`) que en texto para verlo en pantalla.

export type Ancho = 58 | 80

/** Caracteres por línea con la letra normal (fuente A de 12 × 24 puntos). */
export const COLUMNAS: Record<Ancho, number> = { 58: 32, 80: 48 }

export interface Estilo {
  /** Doble de alto y de ancho: cabe la mitad de caracteres. */
  large?: boolean
  negrita?: boolean
  /** Blanco sobre negro: lo que la cocina no puede pasar por alto. */
  reversed?: boolean
  centro?: boolean
}

export type Linea = ({ text: string } & Estilo) | { separator: true } | { space: true }

export interface Formato {
  columnas: number
  pagina: PaginaCodigos
}

/** Caracteres que caben en una línea con ese estilo. */
export const anchoDe = (format: Formato, estilo: Estilo) =>
  estilo.large ? Math.floor(format.columnas / 2) : format.columnas

/**
 * Parte un texto en líneas de ese ancho, por palabras; una palabra más larga que la línea se
 * corta. Mide con los caracteres ya convertidos a la tabla de la impresora.
 */
export function partir(text: string, width: number, format: Formato): string[] {
  const palabras = caracteres(text, format.pagina).join('').split(' ').filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const palabra of palabras) {
    let rest = palabra
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

/** Un texto con estilo, partido en las líneas que hagan falta. */
export function parrafo(text: string, format: Formato, estilo: Estilo = {}): Linea[] {
  return partir(text, anchoDe(format, estilo), format).map((t) => ({ text: t, ...estilo }))
}

/**
 * Texto a la izquierda y a la derecha en la misma línea («Mesa 6 ··· #12»). Si no caben juntos,
 * la derecha baja a su propia línea.
 */
export function aLosLados(
  izquierda: string,
  derecha: string,
  format: Formato,
  estilo: Estilo = {},
): Linea[] {
  const width = anchoDe(format, estilo)
  const izq = partir(izquierda, width, format)
  const der = caracteres(derecha, format.pagina).join('')
  if (!der) return izq.map((t) => ({ text: t, ...estilo }))
  const last = izq.at(-1) ?? ''
  if (last.length + 1 + der.length <= width) {
    izq[izq.length - 1] = last + ' '.repeat(width - last.length - der.length) + der
    return izq.map((t) => ({ text: t, ...estilo }))
  }
  return [
    ...izq.map((t) => ({ text: t, ...estilo })),
    ...parrafo(derecha, format, { ...estilo, centro: false }),
  ]
}

/**
 * El documento como texto, para verlo en pantalla o en una prueba: lo grande va en mayúsculas,
 * lo invertido entre corchetes y el separador como guiones.
 */
export function comoTexto(lines: readonly Linea[], columnas: number): string {
  return lines
    .map((l) => {
      if ('separator' in l) return '-'.repeat(columnas)
      if ('space' in l) return ''
      let t = l.large ? l.text.toUpperCase() : l.text
      if (l.reversed) t = `[${t}]`
      if (l.centro) {
        const width = l.large ? Math.floor(columnas / 2) : columnas
        t = ' '.repeat(Math.max(0, Math.floor((width - t.length) / 2))) + t
      }
      return t.trimEnd()
    })
    .join('\n')
}
