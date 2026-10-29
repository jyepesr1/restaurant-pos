import type { ConnectionState } from '@pos/sync'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button, buttonClass } from '../ui/Button'
import {
  ConnectionIndicator,
  type ConnectionState as VisibleStatus,
} from '../ui/ConnectionIndicator'
import { Icon, type IconName } from '../ui/icons'
import { SOFT_TONES } from '../ui/Label'
import { Logo } from '../ui/Logo'
import { navigate, useRoute } from '../ui/route'
import { useTheme } from '../ui/theme'
import { cloudLabel, SEES_CLOUD } from './cloud'
import { floor, useFloor } from './context'

// The frame of the operation screens (task 1.3c): a sidebar with the sections the role can use,
// and at the top the title, the connection and dark mode. On the register and the tablet the
// sidebar is always visible (icons only on tablet); on the phone it opens from the menu, to leave
// the screen to the order.

// Connected to the hub is "Solo red local" until the hub says it reaches the cloud (up to date or
// uploading, task 1.11): then it is "En línea" (brief §5, rule 7).
const STATUS: Record<ConnectionState, VisibleStatus> = {
  connected: 'local_only',
  connecting: 'connecting',
  no_response: 'offline',
  disconnected: 'offline',
}

/**
 * «Simular corte» is for testing and for the demo, not for staff: it shows in development or if the
 * app was opened once with `?demo=1` on this device (`?demo=0` removes it).
 */
function demoMode(): boolean {
  try {
    const demo = new URLSearchParams(location.search).get('demo')
    if (demo === '1') localStorage.setItem('pos:demo', '1')
    if (demo === '0') localStorage.removeItem('pos:demo')
    return import.meta.env.DEV || localStorage.getItem('pos:demo') === '1'
  } catch {
    return import.meta.env.DEV
  }
}

interface Section {
  route: string
  name: string
  icon: IconName
  /** Any of these permissions shows it; without a list, everyone who signs in sees it. */
  permissions?: readonly string[]
  /** Other routes that are part of this section (the order is part of the dining room). */
  also?: readonly string[]
}

const SECTIONS: readonly { group: string; sections: readonly Section[] }[] = [
  {
    group: 'Servicio',
    sections: [
      { route: '/', name: 'Salón', icon: 'table', also: ['/order', '/check'] },
      { route: '/kitchen', name: 'Pedidos en cocina', icon: 'fire' },
      {
        route: '/register',
        name: 'Caja',
        icon: 'bill',
        permissions: ['open_register_shift', 'record_payment'],
      },
    ],
  },
  {
    group: 'Administración',
    sections: [
      { route: '/reports', name: 'Reportes', icon: 'chart', permissions: ['view_reports'] },
      {
        route: '/menu',
        name: 'Carta',
        icon: 'menu',
        permissions: ['edit_catalog', 'edit_prices'],
      },
      {
        route: '/floor-plan',
        name: 'Plano del salón',
        icon: 'floorPlan',
        permissions: ['edit_catalog'],
      },
      {
        route: '/staff',
        name: 'Personal y roles',
        icon: 'people',
        permissions: ['manage_users'],
      },
      {
        route: '/kitchen/settings',
        name: 'Cocina e impresoras',
        icon: 'printer',
        permissions: ['manage_devices'],
      },
      {
        route: '/register/settings',
        name: 'Caja y pagos',
        icon: 'card',
        permissions: ['manage_devices'],
      },
      {
        route: '/brand',
        name: 'Marca del restaurante',
        icon: 'brand',
        permissions: ['manage_users'],
      },
      { route: '/cloud', name: 'Nube', icon: 'cloud', permissions: ['manage_devices'] },
    ],
  },
]

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')

export function FloorFrame({
  title,
  back,
  guardExit,
  actions,
  children,
}: {
  title: string
  back?: string
  /**
   * Back, changing section and Salir go through here before leaving the screen (e.g., to
   * warn about unsaved changes): it receives what it would do and decides whether to do it.
   */
  guardExit?: (action: () => void) => void
  /** The screen's own buttons, at the top right. */
  actions?: ReactNode
  children: ReactNode
}) {
  const { dark, select } = useTheme()
  const { connection, pendingList, session, simulatingOffline, catalog, printers, cloud } =
    useFloor()
  const downPrinters = printers.filter((i) => i.status === 'failed')
  const { route } = useRoute()
  const [menuOpen, setMenuOpen] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const exitWith = (action: () => void) => (guardExit ? guardExit(action) : action())
  const go = (target: string) =>
    exitWith(() => {
      setMenuOpen(false)
      navigate(target)
    })
  const restaurant = catalog?.restaurant.name
  const permissions = session?.permissions ?? []
  const groups = SECTIONS.map((g) => ({
    ...g,
    sections: g.sections.filter(
      (s) => !s.permissions || s.permissions.some((p) => permissions.includes(p)),
    ),
  })).filter((g) => g.sections.length > 0)
  const withNavigation = session !== null && groups.length > 0
  const inLine =
    connection === 'connected' && (cloud?.state === 'up_to_date' || cloud?.state === 'uploading')
  // The register sees how the upload goes; with no link to the hub, what it last heard is stale.
  const cloudStatus =
    connection === 'connected' && cloud && SEES_CLOUD.some((p) => permissions.includes(p))
      ? cloudLabel(cloud)
      : null
  // The admin goes from the label to the «Nube» screen, where a problem is fixed.
  const cloudLink = cloudStatus !== null && permissions.includes('manage_devices')

  useEffect(() => {
    document.title = `${title} · ${restaurant ?? 'Faro'}`
  }, [title, restaurant])
  // Focus goes to the title on arriving at the screen, not every time the title changes (a takeout
  // order gets its number later): focus is not stolen from whoever is typing.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])
  // The phone menu is modal: focus moves into it, what is behind becomes inert and does not scroll,
  // it closes with Escape and focus returns to the menu button.
  const menuButton = useRef<HTMLButtonElement>(null)
  const closeMenuButton = useRef<HTMLButtonElement>(null)
  const page = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const background = page.current
    const savedOverflow = document.body.style.overflow
    background?.setAttribute('inert', '')
    document.body.style.overflow = 'hidden'
    closeMenuButton.current?.focus()
    const onKeystroke = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKeystroke)
    return () => {
      window.removeEventListener('keydown', onKeystroke)
      background?.removeAttribute('inert')
      document.body.style.overflow = savedOverflow
      menuButton.current?.focus()
    }
  }, [menuOpen])

  const navigation = (isCompact: boolean) => (
    <nav aria-label="Secciones" className="flex flex-col gap-5">
      {groups.map((g) => (
        <div key={g.group} className="flex flex-col gap-1">
          <p
            className={`px-3 text-sm font-medium text-muted ${isCompact ? 'lg:block hidden' : ''}`}
          >
            {g.group}
          </p>
          {g.sections.map((s) => {
            const current = s.route === route || (s.also?.includes(route) ?? false)
            return (
              <button
                key={s.route}
                type="button"
                aria-current={current ? 'page' : undefined}
                aria-label={isCompact ? s.name : undefined}
                title={isCompact ? s.name : undefined}
                onClick={() => go(s.route)}
                className={`flex min-h-12 items-center gap-3 rounded-xl px-3 text-left font-medium transition-colors focus-visible:outline-3 focus-visible:outline-focus ${
                  current ? 'bg-action-soft text-action-text' : 'text-foreground hover:bg-surface-2'
                } ${isCompact ? 'justify-center lg:justify-start' : ''}`}
              >
                <Icon name={s.icon} className="size-5 shrink-0" />
                <span className={isCompact ? 'hidden lg:inline' : ''}>{s.name}</span>
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
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-action-soft font-semibold text-action-text"
      >
        {initials(session.user.name)}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate font-semibold">{session.user.name}</span>
        <span className="truncate text-sm text-muted">{session.user.role}</span>
      </span>
    </div>
  )

  const exit = session && (
    <Button
      variant="ghost"
      icon="exit"
      className="w-full justify-start"
      onClick={() => exitWith(() => void floor.exit())}
    >
      Salir
    </Button>
  )

  return (
    <div className="flex min-h-dvh">
      <div ref={page} className="contents">
        {/* Register and tablet: the sidebar always visible (on tablet, icons only). */}
        {withNavigation && (
          <aside className="sticky top-0 hidden h-dvh w-20 shrink-0 flex-col gap-6 border-r border-divider bg-sidebar px-3 py-4 md:flex lg:w-64 lg:px-4">
            <div className="flex justify-center lg:justify-start lg:px-1">
              <span className="hidden lg:block">
                <Logo name={restaurant} brand={catalog?.restaurant.brand} />
              </span>
              <span className="lg:hidden" title={restaurant ?? 'Faro'}>
                <Logo brand={catalog?.restaurant.brand} brandOnly />
              </span>
            </div>
            <div className="hidden rounded-2xl bg-surface-2 p-3 lg:block">{who}</div>
            <div className="-mx-1 flex-1 overflow-y-auto px-1 py-1">{navigation(true)}</div>
            <div className="hidden lg:block">{exit}</div>
            <Button
              variant="ghost"
              icon="exit"
              aria-label="Salir"
              className="lg:hidden"
              onClick={() => exitWith(() => void floor.exit())}
            />
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 border-b border-divider bg-sidebar">
            <div className="flex min-h-16 flex-wrap items-center gap-2 px-3 py-2 md:px-5">
              {withNavigation && (
                <Button
                  ref={menuButton}
                  variant="ghost"
                  icon="hamburger"
                  aria-label="Menú"
                  aria-expanded={menuOpen}
                  className="md:hidden"
                  onClick={() => setMenuOpen(true)}
                />
              )}
              {back && (
                <Button
                  variant="ghost"
                  icon="back"
                  aria-label="Volver"
                  onClick={() => exitWith(() => navigate(back))}
                />
              )}
              {!withNavigation && <Logo name={restaurant} brand={catalog?.restaurant.brand} />}
              <h1
                ref={heading}
                tabIndex={-1}
                className={`font-heading mr-auto truncate text-xl font-bold tracking-tight outline-none md:text-2xl ${withNavigation ? '' : 'sr-only'}`}
              >
                {title}
              </h1>
              <ConnectionIndicator
                status={inLine ? 'online' : STATUS[connection]}
                pendingList={pendingList}
                compact
                hideStatus={cloudStatus !== null}
              />
              {cloudStatus &&
                (() => {
                  const content = (
                    <>
                      <Icon name={cloudStatus.icon} />
                      <span className="sm:hidden" aria-hidden="true">
                        {cloudStatus.short}
                      </span>
                      <span className="max-sm:sr-only">{cloudStatus.text}</span>
                    </>
                  )
                  const look = `inline-flex items-center gap-1.5 rounded-full px-3 text-sm font-semibold whitespace-nowrap ${SOFT_TONES[cloudStatus.tone]}`
                  return cloudLink ? (
                    <button
                      type="button"
                      onClick={() => go('/cloud')}
                      className={`${look} min-h-12 focus-visible:outline-3 focus-visible:outline-focus`}
                    >
                      {content}
                    </button>
                  ) : (
                    <span className={`${look} py-1`}>{content}</span>
                  )
                })()}
              <span aria-live="polite" className="contents">
                {downPrinters.length > 0 && (
                  <button
                    type="button"
                    onClick={() => go('/kitchen')}
                    className="inline-flex min-h-12 items-center gap-2 rounded-full bg-alert-strong px-3 text-sm font-semibold text-white focus-visible:outline-3 focus-visible:outline-focus"
                  >
                    <Icon name="printer" className="size-5" />
                    {downPrinters.length === 1
                      ? `${downPrinters[0]?.name} no imprime`
                      : `${downPrinters.length} impresoras no imprimen`}
                  </button>
                )}
              </span>
              <div className="flex items-center gap-1">
                {actions}
                {(simulatingOffline || demoMode()) && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={simulatingOffline}
                    onClick={() => floor.simulateOffline(!simulatingOffline)}
                    className={`${buttonClass(simulatingOffline ? 'danger' : 'secondary')} whitespace-nowrap`}
                  >
                    {simulatingOffline && <Icon name="check" />}
                    Simular corte
                  </button>
                )}
                <Button
                  variant="ghost"
                  icon={dark ? 'sun' : 'moon'}
                  aria-label="Modo oscuro"
                  aria-pressed={dark}
                  onClick={() => select(dark ? 'light' : 'dark')}
                />
              </div>
            </div>
            <div className="brand-signature" aria-hidden="true" />
          </header>
          <main className="flex-1">{children}</main>
        </div>
      </div>

      {/* Phone: the sidebar as a drawer that opens from the menu. */}
      {withNavigation && menuOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="absolute inset-0 bg-black/40"
            onClick={() => setMenuOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Menú"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-6 bg-sidebar p-4 shadow-float"
          >
            <div className="flex items-center justify-between">
              <Logo name={restaurant} brand={catalog?.restaurant.brand} />
              <Button
                ref={closeMenuButton}
                variant="ghost"
                icon="close"
                aria-label="Cerrar el menú"
                onClick={() => setMenuOpen(false)}
              />
            </div>
            <div className="rounded-2xl bg-surface-2 p-3">{who}</div>
            <div className="-mx-1 flex-1 overflow-y-auto px-1 py-1">{navigation(false)}</div>
            <Button
              variant="ghost"
              icon={dark ? 'sun' : 'moon'}
              className="justify-start"
              onClick={() => select(dark ? 'light' : 'dark')}
            >
              {dark ? 'Modo claro' : 'Modo oscuro'}
            </Button>
            {exit}
          </div>
        </div>
      )}
    </div>
  )
}
