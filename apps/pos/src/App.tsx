import { lazy, Suspense } from 'react'
import { Diagnostico } from './diagnostico/Diagnostico'
import { Operacion } from './sala/Operacion'
import { useRuta } from './ui/ruta'

// Los bocetos (con la carta y sus datos) solo se descargan si se abren, y un error en ellos no
// tumba el resto de la app.
const Bocetos = lazy(() => import('./bocetos/Bocetos'))

export function App() {
  const { route, params } = useRuta()
  if (route === '/diagnostics') return <Diagnostico />
  if (route === '/mockups' || route.startsWith('/mockups/'))
    return (
      <Suspense fallback={<p className="p-6 text-texto-suave">Cargando…</p>}>
        <Bocetos route={route} />
      </Suspense>
    )
  return <Operacion route={route} params={params} />
}
