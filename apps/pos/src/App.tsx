import { lazy, Suspense } from 'react'
import { Diagnostics } from './diagnostics/Diagnostics'
import { Operation } from './floor/Operation'
import { useRoute } from './ui/route'

// The mockups (with the menu and their data) are only downloaded if opened, and an error in them
// does not bring down the rest of the app.
const Mockups = lazy(() => import('./mockups/Mockups'))

export function App() {
  const { route, params } = useRoute()
  if (route === '/diagnostics') return <Diagnostics />
  if (route === '/mockups' || route.startsWith('/mockups/'))
    return (
      <Suspense fallback={<p className="p-6 text-texto-suave">Cargando…</p>}>
        <Mockups route={route} />
      </Suspense>
    )
  return <Operation route={route} params={params} />
}
