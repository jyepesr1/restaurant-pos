import { useState } from 'react'

// La marca del restaurante sobre el design system (`data-marca` en <html>, ver estilos.css). Por
// ahora se elige en este dispositivo para comparar direcciones; en la Fase 1 sale de la
// configuración del restaurante. index.html la aplica antes de pintar.

export type Marca = 'neutra' | 'bagno' | 'taller' | 'noche'

export const MARCAS: readonly Marca[] = ['bagno', 'taller', 'noche', 'neutra']
const CLAVE = 'pos-marca'
/** La del piloto mientras no haya configuración. */
export const MARCA_POR_DEFECTO: Marca = 'bagno'

function leer(): Marca {
  try {
    const guardada = localStorage.getItem(CLAVE)
    return MARCAS.includes(guardada as Marca) ? (guardada as Marca) : MARCA_POR_DEFECTO
  } catch {
    return MARCA_POR_DEFECTO
  }
}

export function aplicarMarca(marca: Marca = leer()) {
  if (marca === 'neutra') delete document.documentElement.dataset.marca
  else document.documentElement.dataset.marca = marca
}

export function useMarca(): [Marca, (marca: Marca) => void] {
  const [marca, setMarca] = useState<Marca>(leer)
  const elegir = (nueva: Marca) => {
    try {
      localStorage.setItem(CLAVE, nueva)
    } catch {
      // Sin almacenamiento: vale mientras la página esté abierta.
    }
    aplicarMarca(nueva)
    setMarca(nueva)
  }
  return [marca, elegir]
}
