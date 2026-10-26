import { useEffect, useState } from 'react'

// Navegación mínima sin recargar la página (aún no hace falta un enrutador completo).

const EVENTO = 'pos-navigate'

const rutaActual = () => location.pathname.replace(/\/+$/, '') || '/'

export function navegar(target: string) {
  if (target === location.pathname + location.search) return
  history.pushState(null, '', target)
  window.dispatchEvent(new Event(EVENTO))
}

/** La ruta (sin `/` final) y sus parámetros; cambia también si solo cambian los parámetros. */
export function useRuta(): { route: string; params: URLSearchParams } {
  const [current, setActual] = useState(() => ({ route: rutaActual(), busqueda: location.search }))
  useEffect(() => {
    const actualizar = () => setActual({ route: rutaActual(), busqueda: location.search })
    window.addEventListener('popstate', actualizar)
    window.addEventListener(EVENTO, actualizar)
    return () => {
      window.removeEventListener('popstate', actualizar)
      window.removeEventListener(EVENTO, actualizar)
    }
  }, [])
  return { route: current.route, params: new URLSearchParams(current.busqueda) }
}
