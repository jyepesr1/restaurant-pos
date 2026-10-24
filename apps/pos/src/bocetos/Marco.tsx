import { type ReactNode, useEffect, useRef } from 'react'
import { Boton } from '../ui/Boton'
import { IndicadorConexion } from '../ui/IndicadorConexion'
import { navegar } from '../ui/ruta'
import { useTema } from '../ui/tema'
import { useSimulacion } from './estado'

// Marco de cada boceto: barra superior con volver, título, quién está, conexión e impresoras, y
// modo oscuro. Al cambiar de pantalla, el título de la pestaña y el foco pasan a la nueva (así el
// lector de pantalla la anuncia).

export function Marco({
  titulo,
  volver = '/bocetos',
  usuario = 'Mesero 1',
  acciones,
  children,
}: {
  titulo: string
  volver?: string
  usuario?: string
  acciones?: ReactNode
  children: ReactNode
}) {
  const { oscuro, elegir } = useTema()
  const { conexion, pendientes, impresorasConFalla } = useSimulacion()
  const encabezado = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    document.title = `${titulo} · POS`
    encabezado.current?.focus({ preventScroll: true })
  }, [titulo])

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-borde bg-superficie/95 px-2 py-2 backdrop-blur">
        <Boton
          variante="fantasma"
          icono="atras"
          aria-label="Volver"
          onClick={() => navegar(volver)}
        />
        <h1 ref={encabezado} tabIndex={-1} className="mr-auto text-lg font-semibold outline-none">
          {titulo}
        </h1>
        <IndicadorConexion
          estado={conexion}
          pendientes={pendientes}
          impresorasConFalla={impresorasConFalla}
        />
        <span className="hidden text-texto-suave sm:inline">{usuario}</span>
        {acciones}
        <Boton
          variante="fantasma"
          icono={oscuro ? 'sol' : 'luna'}
          aria-label="Modo oscuro"
          aria-pressed={oscuro}
          onClick={() => elegir(oscuro ? 'claro' : 'oscuro')}
        />
      </header>
      <main className="flex-1">{children}</main>
    </div>
  )
}
