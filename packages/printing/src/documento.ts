import { caracteres, type PaginaCodigos } from './codificacion'

// Un documento impreso es una lista de líneas con estilo. Se arma ya partido al ancho de la
// impresora, y de ahí sale lo mismo en ESC/POS (`escpos.ts`) que en texto para verlo en pantalla.

export type Ancho = 58 | 80

/** Caracteres por línea con la letra normal (fuente A de 12 × 24 puntos). */
export const COLUMNAS: Record<Ancho, number> = { 58: 32, 80: 48 }

export interface Estilo {
  /** Doble de alto y de ancho: cabe la mitad de caracteres. */
  grande?: boolean
  negrita?: boolean
  /** Blanco sobre negro: lo que la cocina no puede pasar por alto. */
  invertido?: boolean
  centro?: boolean
}

export type Linea = ({ texto: string } & Estilo) | { separador: true } | { espacio: true }

export interface Formato {
  columnas: number
  pagina: PaginaCodigos
}

/** Caracteres que caben en una línea con ese estilo. */
export const anchoDe = (formato: Formato, estilo: Estilo) =>
  estilo.grande ? Math.floor(formato.columnas / 2) : formato.columnas

/**
 * Parte un texto en líneas de ese ancho, por palabras; una palabra más larga que la línea se
 * corta. Mide con los caracteres ya convertidos a la tabla de la impresora.
 */
export function partir(texto: string, ancho: number, formato: Formato): string[] {
  const palabras = caracteres(texto, formato.pagina).join('').split(' ').filter(Boolean)
  const lineas: string[] = []
  let actual = ''
  for (const palabra of palabras) {
    let resto = palabra
    while (resto.length > ancho) {
      if (actual) {
        lineas.push(actual)
        actual = ''
      }
      lineas.push(resto.slice(0, ancho))
      resto = resto.slice(ancho)
    }
    if (!resto) continue
    if (!actual) actual = resto
    else if (actual.length + 1 + resto.length <= ancho) actual = `${actual} ${resto}`
    else {
      lineas.push(actual)
      actual = resto
    }
  }
  if (actual) lineas.push(actual)
  return lineas.length > 0 ? lineas : ['']
}

/** Un texto con estilo, partido en las líneas que hagan falta. */
export function parrafo(texto: string, formato: Formato, estilo: Estilo = {}): Linea[] {
  return partir(texto, anchoDe(formato, estilo), formato).map((t) => ({ texto: t, ...estilo }))
}

/**
 * Texto a la izquierda y a la derecha en la misma línea («Mesa 6 ··· #12»). Si no caben juntos,
 * la derecha baja a su propia línea.
 */
export function aLosLados(
  izquierda: string,
  derecha: string,
  formato: Formato,
  estilo: Estilo = {},
): Linea[] {
  const ancho = anchoDe(formato, estilo)
  const izq = partir(izquierda, ancho, formato)
  const der = caracteres(derecha, formato.pagina).join('')
  if (!der) return izq.map((t) => ({ texto: t, ...estilo }))
  const ultima = izq.at(-1) ?? ''
  if (ultima.length + 1 + der.length <= ancho) {
    izq[izq.length - 1] = ultima + ' '.repeat(ancho - ultima.length - der.length) + der
    return izq.map((t) => ({ texto: t, ...estilo }))
  }
  return [
    ...izq.map((t) => ({ texto: t, ...estilo })),
    ...parrafo(derecha, formato, { ...estilo, centro: false }),
  ]
}

/**
 * El documento como texto, para verlo en pantalla o en una prueba: lo grande va en mayúsculas,
 * lo invertido entre corchetes y el separador como guiones.
 */
export function comoTexto(lineas: readonly Linea[], columnas: number): string {
  return lineas
    .map((l) => {
      if ('separador' in l) return '-'.repeat(columnas)
      if ('espacio' in l) return ''
      let t = l.grande ? l.texto.toUpperCase() : l.texto
      if (l.invertido) t = `[${t}]`
      if (l.centro) {
        const ancho = l.grande ? Math.floor(columnas / 2) : columnas
        t = ' '.repeat(Math.max(0, Math.floor((ancho - t.length) / 2))) + t
      }
      return t.trimEnd()
    })
    .join('\n')
}
