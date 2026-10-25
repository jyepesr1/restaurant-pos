import type { EstadoConexion } from '@pos/sync'
import { type ReactNode, useEffect, useRef } from 'react'
import { Boton, claseBoton } from '../ui/Boton'
import { type EstadoConexion as EstadoVisible, IndicadorConexion } from '../ui/IndicadorConexion'
import { Icono } from '../ui/iconos'
import { navegar } from '../ui/ruta'
import { useTema } from '../ui/tema'
import { sala, useSala } from './contexto'

// En la Fase 0 no hay nube: conectado al hub es "Solo red local", lo normal (brief §5, regla 7).
const ESTADO: Record<EstadoConexion, EstadoVisible> = {
  conectado: 'solo_local',
  conectando: 'conectando',
  sin_respuesta: 'sin_conexion',
  desconectado: 'sin_conexion',
}

// Barra superior de las pantallas de operación: volver, título, conexión y pendientes, quién está
// y el interruptor de la demo para simular que se cae el Wi-Fi.

export function MarcoSala({
  titulo,
  volver,
  protegerSalida,
  children,
}: {
  titulo: string
  volver?: string
  /**
   * Volver y Salir pasan por aquí antes de dejar la pantalla (p. ej., para avisar de cambios sin
   * guardar): recibe lo que haría y decide si lo hace.
   */
  protegerSalida?: (accion: () => void) => void
  children: ReactNode
}) {
  const { oscuro, elegir } = useTema()
  const { conexion, pendientes, sesion, simulandoSinConexion } = useSala()
  const encabezado = useRef<HTMLHeadingElement>(null)
  const salirCon = (accion: () => void) => (protegerSalida ? protegerSalida(accion) : accion())

  useEffect(() => {
    document.title = `${titulo} · POS`
  }, [titulo])
  // El foco va al título al llegar a la pantalla, no cada vez que el título cambia (un pedido
  // para llevar recibe su número después): no se le roba el foco a quien está escribiendo.
  useEffect(() => {
    encabezado.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-borde bg-superficie/95 px-2 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-1 items-center gap-2">
            {volver && (
              <Boton
                variante="fantasma"
                icono="atras"
                aria-label="Volver"
                onClick={() => salirCon(() => navegar(volver))}
              />
            )}
            <img
              src="/marca/la-spritzzeria.svg"
              alt=""
              className="logo-marca size-10 rounded-full border-2 border-marca bg-[#fff8ec] p-0.5"
            />
            <h1
              ref={encabezado}
              tabIndex={-1}
              className="font-titulo shrink-0 text-2xl font-semibold leading-none whitespace-nowrap outline-none"
            >
              {titulo}
            </h1>
          </div>
          <IndicadorConexion estado={ESTADO[conexion]} pendientes={pendientes} />
          {/* En el celular las herramientas bajan a una segunda fila; en tablet y caja, al lado. */}
          <div className="flex w-full items-center gap-1 sm:w-auto">
            <button
              type="button"
              role="switch"
              aria-checked={simulandoSinConexion}
              onClick={() => sala.simularSinConexion(!simulandoSinConexion)}
              className={`${claseBoton(simulandoSinConexion ? 'peligro' : 'secundario')} whitespace-nowrap`}
            >
              {simulandoSinConexion && <Icono nombre="check" />}
              Simular corte
            </button>
            <span className="flex-1" />
            {sesion && (
              <Boton variante="fantasma" onClick={() => salirCon(() => void sala.salir())}>
                <span className="hidden max-w-40 truncate text-texto-suave sm:inline">
                  {sesion.usuario.nombre}
                </span>
                Salir
              </Boton>
            )}
            <Boton
              variante="fantasma"
              icono={oscuro ? 'sol' : 'luna'}
              aria-label="Modo oscuro"
              aria-pressed={oscuro}
              onClick={() => elegir(oscuro ? 'claro' : 'oscuro')}
            />
          </div>
        </div>
      </header>
      <div className="firma-marca" aria-hidden="true" />
      <main className="flex-1">{children}</main>
    </div>
  )
}
