// Búsqueda tolerante a tildes y errores (brief §5, regla 6): "hamburgesa" encuentra
// "Hamburguesa", "apero" encuentra "Aperol Spritz". Sin dependencias: corre en el celular.

/** Sin tildes, minúsculas y solo letras y números. */
export const normalizar = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Distancia de edición (inserción, borrado, cambio y letras vecinas intercambiadas). */
export function distancia(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const fila = rows[i] as number[]
      const above = rows[i - 1] as number[]
      const costo = a[i - 1] === b[j - 1] ? 0 : 1
      fila[j] = Math.min(
        (above[j] as number) + 1,
        (fila[j - 1] as number) + 1,
        (above[j - 1] as number) + costo,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        fila[j] = Math.min(fila[j] as number, ((rows[i - 2] as number[])[j - 2] as number) + 1)
    }
  }
  return (rows[a.length] as number[])[b.length] as number
}

/** Errores que se perdonan según el largo de lo escrito: ninguno en 3 letras, uno en 6, dos después. */
const tolerancia = (length: number) => (length <= 3 ? 0 : length <= 6 ? 1 : 2)

/** Qué tan bien una palabra buscada calza con una del nombre (0 = perfecto; null = no calza). */
function calce(buscada: string, palabra: string): number | null {
  if (palabra.startsWith(buscada)) return 0
  const t = tolerancia(buscada.length)
  if (t === 0) return null
  // Se compara también con el comienzo de la palabra: "apreol" contra "aperol" de "aperol spritz".
  const d = Math.min(
    distancia(buscada, palabra),
    distancia(buscada, palabra.slice(0, buscada.length)),
  )
  return d <= t ? d : null
}

/**
 * Los elementos cuyo texto calza con la búsqueda, del mejor al peor. Cada palabra buscada debe
 * calzar con alguna del texto. Sin búsqueda, devuelve todo en su orden.
 */
export function search<T>(elements: readonly T[], busqueda: string, text: (e: T) => string): T[] {
  const palabras = normalizar(busqueda).split(' ').filter(Boolean)
  if (palabras.length === 0) return [...elements]
  const puntuados: { element: T; puntos: number; position: number }[] = []
  elements.forEach((element, position) => {
    const del = normalizar(text(element)).split(' ')
    let puntos = 0
    for (const buscada of palabras) {
      const mejor = Math.min(...del.map((p) => calce(buscada, p) ?? Number.POSITIVE_INFINITY))
      if (!Number.isFinite(mejor)) return
      puntos += mejor
    }
    puntuados.push({ element, puntos, position })
  })
  return puntuados
    .sort((a, b) => a.puntos - b.puntos || a.position - b.position)
    .map((p) => p.element)
}
