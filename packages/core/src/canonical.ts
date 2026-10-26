/** Deeper than this is not an event: rejected without walking it (avoids exhausting the stack). */
export const MAX_DEPTH = 32

/** JSON with sorted keys: the same content always yields the same text. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (depth >= MAX_DEPTH) throw new RangeError('Contenido demasiado anidado')
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, depth + 1)}`).join(',')}}`
}
