import type { EstadoConexion } from '@pos/sync'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Boton, claseBoton } from '../ui/Boton'
import { type EstadoConexion as EstadoVisible, IndicadorConexion } from '../ui/IndicadorConexion'
import { Icono, type NombreIcono } from '../ui/iconos'
import { Logo } from '../ui/Logo'
import { navegar, useRuta } from '../ui/ruta'
import { useTema } from '../ui/tema'
import { sala, useSala } from './contexto'

// El marco de las pantallas de operación (tarea 1.3c): barra lateral con las secciones que el rol
// puede usar, y arriba el título, la conexión y el modo oscuro. En la caja y la tablet la barra
// lateral está siempre a la vista (solo íconos en tablet); en el celular se abre con el menú, para
// dejarle la pantalla al pedido.

// En la Fase 0 no hay nube: conectado al hub es "Solo red local", lo normal (brief §5, regla 7).
const ESTADO: Record<EstadoConexion, EstadoVisible> = {
  conectado: 'solo_local',
  conectando: 'conectando',
  sin_respuesta: 'sin_conexion',
  desconectado: 'sin_conexion',
}

/**
 * «Simular corte» es para probar y para la demo, no para el personal: se ve en desarrollo o si se
 * abrió la app una vez con `?demo=1` en este equipo (`?demo=0` lo quita).
 */
function modoDemo(): boolean {
  try {
    const pedido = new URLSearchParams(location.search).get('demo')
    if (pedido === '1') localStorage.setItem('pos:demo', '1')
    if (pedido === '0') localStorage.removeItem('pos:demo')
    return import.meta.env.DEV || localStorage.getItem('pos:demo') === '1'
  } catch {
    return import.meta.env.DEV
  }
}

interface Seccion {
  ruta: string
  nombre: string
  icono: NombreIcono
  /** Alguno de estos permisos la muestra; sin lista, la ve todo el que entra. */
  permisos?: readonly string[]
  /** Otras rutas que son parte de esta sección (el pedido es parte del salón). */
  tambien?: readonly string[]
}

const SECCIONES: readonly { grupo: string; secciones: readonly Seccion[] }[] = [
  {
    grupo: 'Servicio',
    secciones: [
      { ruta: '/', nombre: 'Salón', icono: 'mesa', tambien: ['/pedido', '/cuenta'] },
      { ruta: '/cocina', nombre: 'Pedidos en cocina', icono: 'fuego' },
      {
        ruta: '/caja',
        nombre: 'Caja',
        icono: 'billete',
        permisos: ['abrir_turno_caja', 'registrar_pago'],
      },
    ],
  },
  {
    grupo: 'Administración',
    secciones: [
      { ruta: '/reportes', nombre: 'Reportes', icono: 'grafica', permisos: ['ver_reportes'] },
      {
        ruta: '/carta',
        nombre: 'Carta',
        icono: 'carta',
        permisos: ['editar_catalogo', 'editar_precios'],
      },
      { ruta: '/plano', nombre: 'Plano del salón', icono: 'plano', permisos: ['editar_catalogo'] },
      {
        ruta: '/personal',
        nombre: 'Personal y roles',
        icono: 'personas',
        permisos: ['administrar_usuarios'],
      },
      {
        ruta: '/cocina/ajustes',
        nombre: 'Cocina e impresoras',
        icono: 'impresora',
        permisos: ['administrar_dispositivos'],
      },
      {
        ruta: '/caja/ajustes',
        nombre: 'Caja y pagos',
        icono: 'tarjeta',
        permisos: ['administrar_dispositivos'],
      },
      {
        ruta: '/marca',
        nombre: 'Marca del restaurante',
        icono: 'marca',
        permisos: ['administrar_usuarios'],
      },
    ],
  },
]

const iniciales = (nombre: string) =>
  nombre
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')

export function MarcoSala({
  titulo,
  volver,
  protegerSalida,
  acciones,
  children,
}: {
  titulo: string
  volver?: string
  /**
   * Volver, cambiar de sección y Salir pasan por aquí antes de dejar la pantalla (p. ej., para
   * avisar de cambios sin guardar): recibe lo que haría y decide si lo hace.
   */
  protegerSalida?: (accion: () => void) => void
  /** Botones propios de la pantalla, arriba a la derecha. */
  acciones?: ReactNode
  children: ReactNode
}) {
  const { oscuro, elegir } = useTema()
  const { conexion, pendientes, sesion, simulandoSinConexion, catalogo, impresoras } = useSala()
  const caidas = impresoras.filter((i) => i.estado === 'falla')
  const { ruta } = useRuta()
  const [menuAbierto, setMenuAbierto] = useState(false)
  const encabezado = useRef<HTMLHeadingElement>(null)
  const salirCon = (accion: () => void) => (protegerSalida ? protegerSalida(accion) : accion())
  const ir = (destino: string) =>
    salirCon(() => {
      setMenuAbierto(false)
      navegar(destino)
    })
  const restaurante = catalogo?.restaurante.nombre
  const permisos = sesion?.permisos ?? []
  const grupos = SECCIONES.map((g) => ({
    ...g,
    secciones: g.secciones.filter(
      (s) => !s.permisos || s.permisos.some((p) => permisos.includes(p)),
    ),
  })).filter((g) => g.secciones.length > 0)
  const conNavegacion = sesion !== null && grupos.length > 0

  useEffect(() => {
    document.title = `${titulo} · ${restaurante ?? 'Faro'}`
  }, [titulo, restaurante])
  // El foco va al título al llegar a la pantalla, no cada vez que el título cambia (un pedido
  // para llevar recibe su número después): no se le roba el foco a quien está escribiendo.
  useEffect(() => {
    encabezado.current?.focus({ preventScroll: true })
  }, [])
  // El menú del celular es modal: el foco entra a él, lo de atrás queda inerte y sin desplazarse,
  // se cierra con Escape y el foco vuelve al botón del menú.
  const botonMenu = useRef<HTMLButtonElement>(null)
  const cerrarMenu = useRef<HTMLButtonElement>(null)
  const pagina = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuAbierto) return
    const fondo = pagina.current
    const desplazamiento = document.body.style.overflow
    fondo?.setAttribute('inert', '')
    document.body.style.overflow = 'hidden'
    cerrarMenu.current?.focus()
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuAbierto(false)
    }
    window.addEventListener('keydown', alTeclear)
    return () => {
      window.removeEventListener('keydown', alTeclear)
      fondo?.removeAttribute('inert')
      document.body.style.overflow = desplazamiento
      botonMenu.current?.focus()
    }
  }, [menuAbierto])

  const navegacion = (compacta: boolean) => (
    <nav aria-label="Secciones" className="flex flex-col gap-5">
      {grupos.map((g) => (
        <div key={g.grupo} className="flex flex-col gap-1">
          <p
            className={`px-3 text-sm font-medium text-texto-suave ${compacta ? 'lg:block hidden' : ''}`}
          >
            {g.grupo}
          </p>
          {g.secciones.map((s) => {
            const actual = s.ruta === ruta || (s.tambien?.includes(ruta) ?? false)
            return (
              <button
                key={s.ruta}
                type="button"
                aria-current={actual ? 'page' : undefined}
                aria-label={compacta ? s.nombre : undefined}
                title={compacta ? s.nombre : undefined}
                onClick={() => ir(s.ruta)}
                className={`flex min-h-12 items-center gap-3 rounded-xl px-3 text-left font-medium transition-colors focus-visible:outline-3 focus-visible:outline-foco ${
                  actual ? 'bg-accion-suave text-accion-texto' : 'text-texto hover:bg-superficie-2'
                } ${compacta ? 'justify-center lg:justify-start' : ''}`}
              >
                <Icono nombre={s.icono} className="size-5 shrink-0" />
                <span className={compacta ? 'hidden lg:inline' : ''}>{s.nombre}</span>
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )

  const quien = sesion && (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accion-suave font-semibold text-accion-texto"
      >
        {iniciales(sesion.usuario.nombre)}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate font-semibold">{sesion.usuario.nombre}</span>
        <span className="truncate text-sm text-texto-suave">{sesion.usuario.rol}</span>
      </span>
    </div>
  )

  const salir = sesion && (
    <Boton
      variante="fantasma"
      icono="salir"
      className="w-full justify-start"
      onClick={() => salirCon(() => void sala.salir())}
    >
      Salir
    </Boton>
  )

  return (
    <div className="flex min-h-dvh">
      <div ref={pagina} className="contents">
        {/* Caja y tablet: la barra lateral siempre a la vista (en tablet, solo íconos). */}
        {conNavegacion && (
          <aside className="sticky top-0 hidden h-dvh w-20 shrink-0 flex-col gap-6 border-r border-linea bg-lateral px-3 py-4 md:flex lg:w-64 lg:px-4">
            <div className="flex justify-center lg:justify-start lg:px-1">
              <span className="hidden lg:block">
                <Logo nombre={restaurante} marca={catalogo?.restaurante.marca} />
              </span>
              <span className="lg:hidden" title={restaurante ?? 'Faro'}>
                <Logo marca={catalogo?.restaurante.marca} soloMarca />
              </span>
            </div>
            <div className="hidden rounded-2xl bg-superficie-2 p-3 lg:block">{quien}</div>
            <div className="-mx-1 flex-1 overflow-y-auto px-1 py-1">{navegacion(true)}</div>
            <div className="hidden lg:block">{salir}</div>
            <Boton
              variante="fantasma"
              icono="salir"
              aria-label="Salir"
              className="lg:hidden"
              onClick={() => salirCon(() => void sala.salir())}
            />
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 border-b border-linea bg-lateral">
            <div className="flex min-h-16 flex-wrap items-center gap-2 px-3 py-2 md:px-5">
              {conNavegacion && (
                <Boton
                  ref={botonMenu}
                  variante="fantasma"
                  icono="menu"
                  aria-label="Menú"
                  aria-expanded={menuAbierto}
                  className="md:hidden"
                  onClick={() => setMenuAbierto(true)}
                />
              )}
              {volver && (
                <Boton
                  variante="fantasma"
                  icono="atras"
                  aria-label="Volver"
                  onClick={() => salirCon(() => navegar(volver))}
                />
              )}
              {!conNavegacion && <Logo nombre={restaurante} marca={catalogo?.restaurante.marca} />}
              <h1
                ref={encabezado}
                tabIndex={-1}
                className={`font-titulo mr-auto truncate text-xl font-bold tracking-tight outline-none md:text-2xl ${conNavegacion ? '' : 'sr-only'}`}
              >
                {titulo}
              </h1>
              <IndicadorConexion estado={ESTADO[conexion]} pendientes={pendientes} compacto />
              <span aria-live="polite" className="contents">
                {caidas.length > 0 && (
                  <button
                    type="button"
                    onClick={() => ir('/cocina')}
                    className="inline-flex min-h-12 items-center gap-2 rounded-full bg-alerta-fuerte px-3 text-sm font-semibold text-white focus-visible:outline-3 focus-visible:outline-foco"
                  >
                    <Icono nombre="impresora" className="size-5" />
                    {caidas.length === 1
                      ? `${caidas[0]?.nombre} no imprime`
                      : `${caidas.length} impresoras no imprimen`}
                  </button>
                )}
              </span>
              <div className="flex items-center gap-1">
                {acciones}
                {(simulandoSinConexion || modoDemo()) && (
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
            <div className="firma-marca" aria-hidden="true" />
          </header>
          <main className="flex-1">{children}</main>
        </div>
      </div>

      {/* Celular: la barra lateral como cajón que se abre con el menú. */}
      {conNavegacion && menuAbierto && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="absolute inset-0 bg-black/40"
            onClick={() => setMenuAbierto(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Menú"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-6 bg-lateral p-4 shadow-flota"
          >
            <div className="flex items-center justify-between">
              <Logo nombre={restaurante} marca={catalogo?.restaurante.marca} />
              <Boton
                ref={cerrarMenu}
                variante="fantasma"
                icono="cerrar"
                aria-label="Cerrar el menú"
                onClick={() => setMenuAbierto(false)}
              />
            </div>
            <div className="rounded-2xl bg-superficie-2 p-3">{quien}</div>
            <div className="-mx-1 flex-1 overflow-y-auto px-1 py-1">{navegacion(false)}</div>
            <Boton
              variante="fantasma"
              icono={oscuro ? 'sol' : 'luna'}
              className="justify-start"
              onClick={() => elegir(oscuro ? 'claro' : 'oscuro')}
            >
              {oscuro ? 'Modo claro' : 'Modo oscuro'}
            </Boton>
            {salir}
          </div>
        </div>
      )}
    </div>
  )
}
