/**
 * Congela un valor y todo lo que contiene. Un reductor que intente modificar su entrada lanza
 * TypeError (los módulos ES van en modo estricto), así que la mutación no puede pasar inadvertida.
 */
export function congelar<T>(valor: T): T {
  if (valor === null || typeof valor !== 'object' || Object.isFrozen(valor)) return valor
  Object.freeze(valor)
  for (const hijo of Object.values(valor)) congelar(hijo)
  return valor
}

/** Baraja una lista con un generador mulberry32: la misma semilla da siempre el mismo orden. */
export function barajar<T>(lista: readonly T[], semilla: number): T[] {
  const copia = [...lista]
  let s = semilla >>> 0
  const azar = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(azar() * (i + 1))
    const tmp = copia[i] as T
    copia[i] = copia[j] as T
    copia[j] = tmp
  }
  return copia
}
