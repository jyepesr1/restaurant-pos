import { useEffect, useState } from 'react'

// Modo claro u oscuro (brief §5: modo oscuro para bar y noche). Por defecto sigue al sistema; si
// la persona elige uno, se recuerda en este dispositivo. index.html aplica lo mismo antes de pintar.

export type Tema = 'system' | 'light' | 'dark'

const CLAVE = 'pos-theme'
const consulta = () => window.matchMedia('(prefers-color-scheme: dark)')

function leer(): Tema {
  try {
    const saved = localStorage.getItem(CLAVE)
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  } catch {
    return 'system'
  }
}

const resolver = (tema: Tema, sistemaOscuro: boolean) =>
  tema === 'dark' || (tema === 'system' && sistemaOscuro)

/** Pone o quita la clase `oscuro` en <html>. */
export function aplicarTema(tema: Tema = leer()) {
  document.documentElement.classList.toggle('oscuro', resolver(tema, consulta().matches))
}

/** El tema elegido, si la pantalla está en oscuro ahora mismo y cómo cambiarlo. */
export function useTema(): { tema: Tema; dark: boolean; select: (tema: Tema) => void } {
  const [tema, setTema] = useState<Tema>(leer)
  const [sistemaOscuro, setSistemaOscuro] = useState(() => consulta().matches)

  useEffect(() => {
    const media = consulta()
    const change = () => setSistemaOscuro(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])

  const dark = resolver(tema, sistemaOscuro)
  useEffect(() => {
    document.documentElement.classList.toggle('oscuro', dark)
  }, [dark])

  const select = (fresh: Tema) => {
    try {
      if (fresh === 'system') localStorage.removeItem(CLAVE)
      else localStorage.setItem(CLAVE, fresh)
    } catch {
      // Sin almacenamiento (modo privado): vale solo mientras la página esté abierta.
    }
    setTema(fresh)
  }
  return { tema, dark, select }
}
