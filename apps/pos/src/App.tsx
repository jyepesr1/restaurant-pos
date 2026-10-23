import { type EstadoHub, useEstadoHub } from './useEstadoHub'

const indicador: Record<EstadoHub, { icono: string; texto: string; clase: string }> = {
  conectando: { icono: '…', texto: 'Buscando el hub', clase: 'bg-amber-100 text-amber-900' },
  conectado: { icono: '✓', texto: 'Conectado al hub', clase: 'bg-green-100 text-green-900' },
  'sin-conexion': {
    icono: '✕',
    texto: 'Sin conexión con el hub',
    clase: 'bg-red-100 text-red-900',
  },
}

export function App() {
  const { icono, texto, clase } = indicador[useEstadoHub()]

  return (
    <main className="min-h-dvh bg-slate-50 p-4 text-slate-900">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">POS</h1>
        <output className={`rounded-full px-3 py-1 text-sm font-medium ${clase}`}>
          <span aria-hidden="true">{icono}</span> {texto}
        </output>
      </header>
    </main>
  )
}
