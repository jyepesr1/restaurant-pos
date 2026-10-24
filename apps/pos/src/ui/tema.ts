import { useEffect, useState } from 'react'

// Modo claro u oscuro (brief §5: modo oscuro para bar y noche). Por defecto sigue al sistema; si
// la persona elige uno, se recuerda en este dispositivo. index.html aplica lo mismo antes de pintar.

export type Tema = 'sistema' | 'claro' | 'oscuro'

const CLAVE = 'pos-tema'
const consulta = () => window.matchMedia('(prefers-color-scheme: dark)')

function leer(): Tema {
  try {
    const guardado = localStorage.getItem(CLAVE)
    return guardado === 'claro' || guardado === 'oscuro' ? guardado : 'sistema'
  } catch {
    return 'sistema'
  }
}

const resolver = (tema: Tema, sistemaOscuro: boolean) =>
  tema === 'oscuro' || (tema === 'sistema' && sistemaOscuro)

/** Pone o quita la clase `oscuro` en <html>. */
export function aplicarTema(tema: Tema = leer()) {
  document.documentElement.classList.toggle('oscuro', resolver(tema, consulta().matches))
}

/** El tema elegido, si la pantalla está en oscuro ahora mismo y cómo cambiarlo. */
export function useTema(): { tema: Tema; oscuro: boolean; elegir: (tema: Tema) => void } {
  const [tema, setTema] = useState<Tema>(leer)
  const [sistemaOscuro, setSistemaOscuro] = useState(() => consulta().matches)

  useEffect(() => {
    const media = consulta()
    const cambio = () => setSistemaOscuro(media.matches)
    media.addEventListener('change', cambio)
    return () => media.removeEventListener('change', cambio)
  }, [])

  const oscuro = resolver(tema, sistemaOscuro)
  useEffect(() => {
    document.documentElement.classList.toggle('oscuro', oscuro)
  }, [oscuro])

  const elegir = (nuevo: Tema) => {
    try {
      if (nuevo === 'sistema') localStorage.removeItem(CLAVE)
      else localStorage.setItem(CLAVE, nuevo)
    } catch {
      // Sin almacenamiento (modo privado): vale solo mientras la página esté abierta.
    }
    setTema(nuevo)
  }
  return { tema, oscuro, elegir }
}
