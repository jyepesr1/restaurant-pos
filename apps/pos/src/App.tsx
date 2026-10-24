import { lazy, Suspense } from 'react'
import { Diagnostico } from './diagnostico/Diagnostico'
import { claseBoton } from './ui/Boton'
import { useRuta } from './ui/ruta'
import { type EstadoHub, useEstadoHub } from './useEstadoHub'

const indicador: Record<EstadoHub, { icono: string; texto: string; clase: string }> = {
  conectando: {
    icono: '…',
    texto: 'Buscando el hub',
    clase: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  },
  conectado: {
    icono: '✓',
    texto: 'Conectado al hub',
    clase: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200',
  },
  'sin-conexion': {
    icono: '✕',
    texto: 'Sin conexión con el hub',
    clase: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  },
}

function Inicio() {
  const estado = useEstadoHub()
  const { icono, texto, clase } = indicador[estado]

  return (
    <main className="min-h-dvh bg-slate-50 p-4 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">POS</h1>
        <output className={`rounded-full px-4 py-2 text-base font-semibold ${clase}`}>
          <span aria-hidden="true">{icono}</span> {texto}
        </output>
      </header>
      {estado === 'sin-conexion' && (
        <p className="mt-3 text-slate-700 dark:text-slate-300">
          Revisa que este equipo esté en el Wi-Fi del local y que el computador de caja (el hub)
          esté encendido.
        </p>
      )}
      <nav className="mt-6 flex flex-wrap gap-3">
        <a href="/bocetos" className={claseBoton('principal')}>
          Bocetos de las pantallas
        </a>
        <a href="/diagnostico" className={claseBoton('secundario')}>
          Diagnóstico del dispositivo
        </a>
      </nav>
    </main>
  )
}

// Los bocetos (con la carta y sus datos) solo se descargan si se abren, y un error en ellos no
// tumba el resto de la app.
const Bocetos = lazy(() => import('./bocetos/Bocetos'))

export function App() {
  const { ruta } = useRuta()
  if (ruta === '/diagnostico') return <Diagnostico />
  if (ruta === '/bocetos' || ruta.startsWith('/bocetos/'))
    return (
      <Suspense fallback={<p className="p-6 text-texto-suave">Cargando…</p>}>
        <Bocetos ruta={ruta} />
      </Suspense>
    )
  return <Inicio />
}
