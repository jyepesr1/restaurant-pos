// Search tolerant of accents and typos (brief §5, rule 6): "hamburgesa" finds "Hamburguesa",
// "apero" finds "Aperol Spritz". No dependencies: it runs on the phone.

/** Without accents, lowercase and only letters and digits. */
export const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Edit distance (insertion, deletion, substitution and swapped adjacent letters). */
export function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = rows[i] as number[]
      const above = rows[i - 1] as number[]
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(
        (above[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (above[j - 1] as number) + cost,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j] as number, ((rows[i - 2] as number[])[j - 2] as number) + 1)
    }
  }
  return (rows[a.length] as number[])[b.length] as number
}

/** Typos forgiven by the length of the input: none at 3 letters, one at 6, two after that. */
const tolerance = (length: number) => (length <= 3 ? 0 : length <= 6 ? 1 : 2)

/** How well a search word matches one in the name (0 = perfect; null = no match). */
function matchScore(searchTerm: string, word: string): number | null {
  if (word.startsWith(searchTerm)) return 0
  const t = tolerance(searchTerm.length)
  if (t === 0) return null
  // Also compared with the start of the word: "apreol" against "aperol" of "aperol spritz".
  const d = Math.min(
    distance(searchTerm, word),
    distance(searchTerm, word.slice(0, searchTerm.length)),
  )
  return d <= t ? d : null
}

/**
 * The elements whose text matches the search, best to worst. Each search word must match one of
 * the text's words. With no search, returns everything in its order.
 */
export function search<T>(
  elements: readonly T[],
  searchQuery: string,
  text: (e: T) => string,
): T[] {
  const words = normalize(searchQuery).split(' ').filter(Boolean)
  if (words.length === 0) return [...elements]
  const scored: { element: T; points: number; position: number }[] = []
  elements.forEach((element, position) => {
    const elementWords = normalize(text(element)).split(' ')
    let points = 0
    for (const searchTerm of words) {
      const best = Math.min(
        ...elementWords.map((p) => matchScore(searchTerm, p) ?? Number.POSITIVE_INFINITY),
      )
      if (!Number.isFinite(best)) return
      points += best
    }
    scored.push({ element, points, position })
  })
  return scored.sort((a, b) => a.points - b.points || a.position - b.position).map((p) => p.element)
}
