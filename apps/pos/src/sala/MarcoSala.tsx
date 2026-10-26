import type { ConnectionState } from '@pos/sync'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Boton, claseBoton } from '../ui/Boton'
import { type ConnectionState as EstadoVisible, IndicadorConexion } from '../ui/IndicadorConexion'
import { Icono, type NombreIcono } from '../ui/iconos'
import { Logo } from '../ui/Logo'
import { navegar, useRuta } from '../ui/ruta'
import { useTema } from '../ui/tema'
import { floor, useSala } from './contexto'

// El marco de las pantallas de operación (tarea 1.3c): barra lateral con las secciones que el rol
// puede usar, y arriba el título, la conexión y el modo oscuro. En la caja y la tablet la barra
// lateral está siempre a la vista (solo íconos en tablet); en el celular se abre con el menú, para
// dejarle la pantalla al pedido.

// En la Fase 0 no hay nube: conectado al hub es "Solo red local", lo normal (brief §5, regla 7).
const STATUS: Record<ConnectionState, EstadoVisible> = {
  connected: 'local_only',
  connecting: 'connecting',
  no_response: 'offline',
  disconnected: 'offline',
}

/**
 * «Simular corte» es para probar y para la demo, no para el personal: se ve en desarrollo o si se
 * abrió la app una vez con `?demo=1` en este equipo (`?demo=0` lo quita).
 */
function modoDemo(): boolean {
  try {
    const order = new URLSearchParams(location.search).get('demo')
    if (order === '1') localStorage.setItem('pos:demo', '1')
    if (order === '0') localStorage.removeItem('pos:demo')
    return import.meta.env.DEV || localStorage.getItem('pos:demo') === '1'
  } catch {
    return import.meta.env.DEV
  }
}

interface Section {
  route: string
  name: string
  icono: NombreIcono
  /** Alguno de estos permisos la muestra; sin lista, la ve todo el que entra. */
  permissions?: readonly string[]
  /** Otras rutas que son parte de esta sección (el pedido es parte del salón). */
  tambien?: readonly string[]
}

const SECCIONES: readonly { group: string; sections: readonly Section[] }[] = [
  {
    group: 'Servicio',
    sections: [
      { route: '/', name: 'Salón', icono: 'table', tambien: ['/order', '/check'] },
      { route: '/kitchen', name: 'Pedidos en cocina', icono: 'fire' },
      {
        route: '/register',
        name: 'Caja',
        icono: 'bill',
        permissions: ['open_register_shift', 'record_payment'],
      },
    ],
  },
  {
    group: 'Administración',
    sections: [
      { route: '/reports', name: 'Reportes', icono: 'chart', permissions: ['view_reports'] },
      {
        route: '/menu',
        name: 'Carta',
        icono: 'menu',
        permissions: ['edit_catalog', 'edit_prices'],
      },
      {
        route: '/floor-plan',
        name: 'Plano del salón',
        icono: 'floorPlan',
        permissions: ['edit_catalog'],
      },
      {
        route: '/staff',
        name: 'Personal y roles',
        icono: 'people',
        permissions: ['manage_users'],
      },
      {
        route: '/kitchen/settings',
        name: 'Cocina e impresoras',
        icono: 'printer',
        permissions: ['manage_devices'],
      },
      {
        route: '/register/settings',
        name: 'Caja y pagos',
        icono: 'card',
        permissions: ['manage_devices'],
      },
      {
        route: '/brand',
        name: 'Marca del restaurante',
        icono: 'brand',
        permissions: ['manage_users'],
      },
    ],
  },
]

const iniciales = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')

export function MarcoSala({
  title,
  back,
  protegerSalida,
  actions,
  children,
}: {
  title: string
  back?: string
  /**
   * Volver, cambiar de sección y Salir pasan por aquí antes de dejar la pantalla (p. ej., para
   * avisar de cambios sin guardar): recibe lo que haría y decide si lo hace.
   */
  protegerSalida?: (action: () => void) => void
  /** Botones propios de la pantalla, arriba a la derecha. */
  actions?: ReactNode
  children: ReactNode
}) {
  const { dark, select } = useTema()
  const { connection, pendingList, session, simulandoSinConexion, catalog, printers } = useSala()
  const caidas = printers.filter((i) => i.status === 'failed')
  const { route } = useRuta()
  const [menuAbierto, setMenuAbierto] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const salirCon = (action: () => void) => (protegerSalida ? protegerSalida(action) : action())
  const ir = (target: string) =>
    salirCon(() => {
      setMenuAbierto(false)
      navegar(target)
    })
  const restaurant = catalog?.restaurant.name
  const permissions = session?.permissions ?? []
  const groups = SECCIONES.map((g) => ({
    ...g,
    sections: g.sections.filter(
      (s) => !s.permissions || s.permissions.some((p) => permissions.includes(p)),
    ),
  })).filter((g) => g.sections.length > 0)
  const conNavegacion = session !== null && groups.length > 0

  useEffect(() => {
    document.title = `${title} · ${restaurant ?? 'Faro'}`
  }, [title, restaurant])
  // El foco va al título al llegar a la pantalla, no cada vez que el título cambia (un pedido
  // para llevar recibe su número después): no se le roba el foco a quien está escribiendo.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])
  // El menú del celular es modal: el foco entra a él, lo de atrás queda inerte y sin desplazarse,
  // se cierra con Escape y el foco vuelve al botón del menú.
  const botonMenu = useRef<HTMLButtonElement>(null)
  const cerrarMenu = useRef<HTMLButtonElement>(null)
  const page = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuAbierto) return
    const fondo = page.current
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
      {groups.map((g) => (
        <div key={g.group} className="flex flex-col gap-1">
          <p
            className={`px-3 text-sm font-medium text-texto-suave ${compacta ? 'lg:block hidden' : ''}`}
          >
            {g.group}
          </p>
          {g.sections.map((s) => {
            const current = s.route === route || (s.tambien?.includes(route) ?? false)
            return (
              <button
                key={s.route}
                type="button"
                aria-current={current ? 'page' : undefined}
                aria-label={compacta ? s.name : undefined}
                title={compacta ? s.name : undefined}
                onClick={() => ir(s.route)}
                className={`flex min-h-12 items-center gap-3 rounded-xl px-3 text-left font-medium transition-colors focus-visible:outline-3 focus-visible:outline-foco ${
                  current ? 'bg-accion-suave text-accion-texto' : 'text-texto hover:bg-superficie-2'
                } ${compacta ? 'justify-center lg:justify-start' : ''}`}
              >
                <Icono name={s.icono} className="size-5 shrink-0" />
                <span className={compacta ? 'hidden lg:inline' : ''}>{s.name}</span>
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )

  const who = session && (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accion-suave font-semibold text-accion-texto"
      >
        {iniciales(session.user.name)}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate font-semibold">{session.user.name}</span>
        <span className="truncate text-sm text-texto-suave">{session.user.role}</span>
      </span>
    </div>
  )

  const exit = session && (
    <Boton
      variant="ghost"
      icono="exit"
      className="w-full justify-start"
      onClick={() => salirCon(() => void floor.exit())}
    >
      Salir
    </Boton>
  )

  return (
    <div className="flex min-h-dvh">
      <div ref={page} className="contents">
        {/* Caja y tablet: la barra lateral siempre a la vista (en tablet, solo íconos). */}
        {conNavegacion && (
          <aside className="sticky top-0 hidden h-dvh w-20 shrink-0 flex-col gap-6 border-r border-linea bg-lateral px-3 py-4 md:flex lg:w-64 lg:px-4">
            <div className="flex justify-center lg:justify-start lg:px-1">
              <span className="hidden lg:block">
                <Logo name={restaurant} brand={catalog?.restaurant.brand} />
              </span>
              <span className="lg:hidden" title={restaurant ?? 'Faro'}>
                <Logo brand={catalog?.restaurant.brand} soloMarca />
              </span>
            </div>
            <div className="hidden rounded-2xl bg-superficie-2 p-3 lg:block">{who}</div>
            <div className="-mx-1 flex-1 overflow-y-auto px-1 py-1">{navegacion(true)}</div>
            <div className="hidden lg:block">{exit}</div>
            <Boton
              variant="ghost"
              icono="exit"
              aria-label="Salir"
              className="lg:hidden"
              onClick={() => salirCon(() => void floor.exit())}
            />
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 border-b border-linea bg-lateral">
            <div className="flex min-h-16 flex-wrap items-center gap-2 px-3 py-2 md:px-5">
              {conNavegacion && (
                <Boton
                  ref={botonMenu}
                  variant="ghost"
                  icono="hamburger"
                  aria-label="Menú"
                  aria-expanded={menuAbierto}
                  className="md:hidden"
                  onClick={() => setMenuAbierto(true)}
                />
              )}
              {back && (
                <Boton
                  variant="ghost"
                  icono="back"
                  aria-label="Volver"
                  onClick={() => salirCon(() => navegar(back))}
                />
              )}
              {!conNavegacion && <Logo name={restaurant} brand={catalog?.restaurant.brand} />}
              <h1
                ref={heading}
                tabIndex={-1}
                className={`font-titulo mr-auto truncate text-xl font-bold tracking-tight outline-none md:text-2xl ${conNavegacion ? '' : 'sr-only'}`}
              >
                {title}
              </h1>
              <IndicadorConexion status={STATUS[connection]} pendingList={pendingList} compacto />
              <span aria-live="polite" className="contents">
                {caidas.length > 0 && (
                  <button
                    type="button"
                    onClick={() => ir('/kitchen')}
                    className="inline-flex min-h-12 items-center gap-2 rounded-full bg-alerta-fuerte px-3 text-sm font-semibold text-white focus-visible:outline-3 focus-visible:outline-foco"
                  >
                    <Icono name="printer" className="size-5" />
                    {caidas.length === 1
                      ? `${caidas[0]?.name} no imprime`
                      : `${caidas.length} impresoras no imprimen`}
                  </button>
                )}
              </span>
              <div className="flex items-center gap-1">
                {actions}
                {(simulandoSinConexion || modoDemo()) && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={simulandoSinConexion}
                    onClick={() => floor.simularSinConexion(!simulandoSinConexion)}
                    className={`${claseBoton(simulandoSinConexion ? 'danger' : 'secondary')} whitespace-nowrap`}
                  >
                    {simulandoSinConexion && <Icono name="check" />}
                    Simular corte
                  </button>
                )}
                <Boton
                  variant="ghost"
                  icono={dark ? 'sun' : 'moon'}
                  aria-label="Modo oscuro"
                  aria-pressed={dark}
                  onClick={() => select(dark ? 'light' : 'dark')}
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
              <Logo name={restaurant} brand={catalog?.restaurant.brand} />
              <Boton
                ref={cerrarMenu}
                variant="ghost"
                icono="close"
                aria-label="Cerrar el menú"
                onClick={() => setMenuAbierto(false)}
              />
            </div>
            <div className="rounded-2xl bg-superficie-2 p-3">{who}</div>
            <div className="-mx-1 flex-1 overflow-y-auto px-1 py-1">{navegacion(false)}</div>
            <Boton
              variant="ghost"
              icono={dark ? 'sun' : 'moon'}
              className="justify-start"
              onClick={() => select(dark ? 'light' : 'dark')}
            >
              {dark ? 'Modo claro' : 'Modo oscuro'}
            </Boton>
            {exit}
          </div>
        </div>
      )}
    </div>
  )
}
