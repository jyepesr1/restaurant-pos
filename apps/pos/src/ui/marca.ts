import { useState } from 'react'

// La marca del restaurante sobre el design system de Faro (`data-marca` en <html>, ver
// estilos.css). Es opcional: sin marca, el POS se ve como Faro. La elige el administrador para todo
// el restaurante y llega con la carta (tarea 1.3c); aquí se guarda para pintarla antes de cargar
// (index.html la lee) y para los bocetos, que la eligen en el equipo para comparar.

export type Marca = 'faro' | 'la-spritzzeria'

export const MARCAS: readonly { marca: Marca; nombre: string; descripcion: string }[] = [
  {
    marca: 'faro',
    nombre: 'Faro',
    descripcion: 'El estilo del sistema: claro, verde azulado, para cualquier restaurante.',
  },
  {
    marca: 'la-spritzzeria',
    nombre: 'La Spritzzería',
    descripcion: 'Arena y marino de día, la terraza de noche; títulos en League Gothic.',
  },
]
export const MARCA_POR_DEFECTO: Marca = 'faro'
const CLAVE = 'pos-marca'

export const esMarca = (valor: unknown): valor is Marca => MARCAS.some((m) => m.marca === valor)

function leer(): Marca {
  try {
    const guardada = localStorage.getItem(CLAVE)
    return esMarca(guardada) ? guardada : MARCA_POR_DEFECTO
  } catch {
    return MARCA_POR_DEFECTO
  }
}

/** Pone la marca en la página y la recuerda en el equipo (para pintarla antes de cargar). */
export function aplicarMarca(marca: Marca = leer()) {
  if (marca === 'faro') delete document.documentElement.dataset.marca
  else document.documentElement.dataset.marca = marca
  try {
    localStorage.setItem(CLAVE, marca)
  } catch {
    // Sin almacenamiento: vale mientras la página esté abierta.
  }
}

export function useMarca(): [Marca, (marca: Marca) => void] {
  const [marca, setMarca] = useState<Marca>(leer)
  const elegir = (nueva: Marca) => {
    aplicarMarca(nueva)
    setMarca(nueva)
  }
  return [marca, elegir]
}
