import { useEffect, useState } from 'react'

// Navegación mínima sin recargar la página (aún no hace falta un enrutador completo).

const EVENTO = 'pos-navegar'

const rutaActual = () => location.pathname.replace(/\/+$/, '') || '/'

export function navegar(destino: string) {
  if (destino === location.pathname + location.search) return
  history.pushState(null, '', destino)
  window.dispatchEvent(new Event(EVENTO))
}

/** La ruta (sin `/` final) y sus parámetros; cambia también si solo cambian los parámetros. */
export function useRuta(): { ruta: string; parametros: URLSearchParams } {
  const [actual, setActual] = useState(() => ({ ruta: rutaActual(), busqueda: location.search }))
  useEffect(() => {
    const actualizar = () => setActual({ ruta: rutaActual(), busqueda: location.search })
    window.addEventListener('popstate', actualizar)
    window.addEventListener(EVENTO, actualizar)
    return () => {
      window.removeEventListener('popstate', actualizar)
      window.removeEventListener(EVENTO, actualizar)
    }
  }, [])
  return { ruta: actual.ruta, parametros: new URLSearchParams(actual.busqueda) }
}
