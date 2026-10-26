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
  back = '/mockups',
  user = 'Mesero 1',
  actions,
  children,
}: {
  titulo: string
  back?: string
  user?: string
  actions?: ReactNode
  children: ReactNode
}) {
  const { dark, select } = useTema()
  const { connection, pendingList, impresorasConFalla } = useSimulacion()
  const encabezado = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    document.title = `${titulo} · POS`
    encabezado.current?.focus({ preventScroll: true })
  }, [titulo])

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-borde bg-superficie/95 px-2 py-2 backdrop-blur">
        <Boton variant="ghost" icono="back" aria-label="Volver" onClick={() => navegar(back)} />
        {/* La insignia del restaurante: el logo en su círculo crema, como en la carta. */}
        <img
          src="/marca/la-spritzzeria.svg"
          alt=""
          className="logo-marca size-10 rounded-full border-2 border-marca bg-[#fff8ec] p-0.5"
        />
        <h1
          ref={encabezado}
          tabIndex={-1}
          className="font-titulo mr-auto text-2xl font-semibold leading-none outline-none"
        >
          {titulo}
        </h1>
        <IndicadorConexion
          status={connection}
          pendingList={pendingList}
          impresorasConFalla={impresorasConFalla}
        />
        <span className="hidden text-texto-suave sm:inline">{user}</span>
        {actions}
        <Boton
          variant="ghost"
          icono={dark ? 'sun' : 'moon'}
          aria-label="Modo oscuro"
          aria-pressed={dark}
          onClick={() => select(dark ? 'light' : 'dark')}
        />
      </header>
      <div className="firma-marca" aria-hidden="true" />
      <main className="flex-1">{children}</main>
    </div>
  )
}
