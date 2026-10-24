/** Más anidado que esto no es un evento: se rechaza sin recorrerlo (evita agotar la pila). */
export const PROFUNDIDAD_MAXIMA = 32

/** JSON con las claves ordenadas: el mismo contenido da siempre el mismo texto. */
export function jsonCanonico(valor: unknown, profundidad = 0): string {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor) ?? 'null'
  if (profundidad >= PROFUNDIDAD_MAXIMA) throw new RangeError('Contenido demasiado anidado')
  if (Array.isArray(valor))
    return `[${valor.map((v) => jsonCanonico(v, profundidad + 1)).join(',')}]`
  const entradas = Object.entries(valor as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${jsonCanonico(v, profundidad + 1)}`).join(',')}}`
}
