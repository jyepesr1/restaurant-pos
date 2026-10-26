import { useState } from 'react'

// La marca del restaurante sobre el design system de Faro (`data-marca` en <html>, ver
// estilos.css). Es opcional: sin marca, el POS se ve como Faro. La elige el administrador para todo
// el restaurante y llega con la carta (tarea 1.3c); aquí se guarda para pintarla antes de cargar
// (index.html la lee) y para los bocetos, que la eligen en el equipo para comparar.

export type Marca = 'faro' | 'la-spritzzeria'

export const BRANDS: readonly { brand: Marca; name: string; description: string }[] = [
  {
    brand: 'faro',
    name: 'Faro',
    description: 'El estilo del sistema: claro, verde azulado, para cualquier restaurante.',
  },
  {
    brand: 'la-spritzzeria',
    name: 'La Spritzzería',
    description: 'Arena y marino de día, la terraza de noche; títulos en League Gothic.',
  },
]
export const MARCA_POR_DEFECTO: Marca = 'faro'
const CLAVE = 'pos-brand'

export const esMarca = (value: unknown): value is Marca => BRANDS.some((m) => m.brand === value)

function leer(): Marca {
  try {
    const guardada = localStorage.getItem(CLAVE)
    return esMarca(guardada) ? guardada : MARCA_POR_DEFECTO
  } catch {
    return MARCA_POR_DEFECTO
  }
}

/** Pone la marca en la página y la recuerda en el equipo (para pintarla antes de cargar). */
export function aplicarMarca(brand: Marca = leer()) {
  if (brand === 'faro') delete document.documentElement.dataset.marca
  else document.documentElement.dataset.marca = brand
  try {
    localStorage.setItem(CLAVE, brand)
  } catch {
    // Sin almacenamiento: vale mientras la página esté abierta.
  }
}

export function useMarca(): [Marca, (brand: Marca) => void] {
  const [brand, setMarca] = useState<Marca>(leer)
  const select = (newOne: Marca) => {
    aplicarMarca(newOne)
    setMarca(newOne)
  }
  return [brand, select]
}
