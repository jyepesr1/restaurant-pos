import { Diagnostico } from './diagnostico/Diagnostico'
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
      <a
        href="/diagnostico"
        className="mt-6 inline-flex min-h-12 items-center rounded-lg bg-slate-200 px-4 font-semibold dark:bg-slate-800"
      >
        Diagnóstico del dispositivo
      </a>
    </main>
  )
}

// Todavía no hay router: solo dos pantallas.
export function App() {
  const ruta = location.pathname.replace(/\/+$/, '')
  return ruta === '/diagnostico' ? <Diagnostico /> : <Inicio />
}
