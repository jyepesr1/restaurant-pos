import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { Icon, type IconName } from '../ui/icons'
import { BrandMark } from '../ui/Logo'
import { navigate } from '../ui/route'
import { SidePanel } from '../ui/SidePanel'
import { useTheme } from '../ui/theme'
import type { Me } from './api'
import { type LiveState, useLiveState } from './live'

// The frame of the owner's panel: the restaurant and who entered at the top, with dark mode and
// «Salir». The sections go in a bar at the bottom on the phone (within reach of the thumb) and at
// the top on wider screens. Each one shows only to whoever has its permission (docs/PANEL.md):
// the floor and the kitchen ask only for «Entrar desde fuera del local».

export interface Section {
  route: string
  name: string
  icon: IconName
  /** The permission it asks for, besides the session. */
  needs: 'view_reports' | 'remote_access'
  /** On the phone it goes in «Más», not in the bar. */
  more?: boolean
}

export const SECTIONS: readonly Section[] = [
  { route: '/', name: 'Hoy', icon: 'gauge', needs: 'view_reports' },
  { route: '/floor', name: 'Salón', icon: 'floorPlan', needs: 'remote_access' },
  { route: '/kitchen', name: 'Cocina', icon: 'fire', needs: 'remote_access' },
  { route: '/alerts', name: 'Alertas', icon: 'warning', needs: 'view_reports' },
  { route: '/register', name: 'Caja', icon: 'bill', needs: 'view_reports', more: true },
  { route: '/reports', name: 'Reportes', icon: 'chart', needs: 'view_reports', more: true },
]

/** The sections this person can open, in order. */
export const sectionsFor = (me: Me) => SECTIONS.filter((s) => me.user.permissions.includes(s.needs))

export function PanelFrame({
  me,
  route,
  title,
  actions,
  onSignOut,
  children,
}: {
  me: Me
  route: string
  title: string
  /** The screen's own buttons, next to the title. */
  actions?: ReactNode
  onSignOut: () => void
  children: ReactNode
}) {
  const { dark, select } = useTheme()
  const liveState = useLiveState()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    document.title = `${title} · ${me.restaurant.name}`
  }, [title, me.restaurant.name])
  // Focus goes to the title on arriving at a section, as in the register.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the section changes
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [route])

  const [moreOpen, setMoreOpen] = useState(false)
  const sections = sectionsFor(me)
  const inBar = sections.filter((s) => !s.more)
  const inMore = sections.filter((s) => s.more)
  const tab = (s: Section, phone: boolean) => {
    const current = s.route === route
    return (
      <button
        key={s.route}
        type="button"
        aria-current={current ? 'page' : undefined}
        onClick={() => {
          setMoreOpen(false)
          navigate(s.route)
        }}
        className={`flex min-w-0 items-center gap-2 rounded-xl font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-focus ${
          current ? 'bg-action-soft text-action-text' : 'text-foreground hover:bg-surface-2'
        } ${phone ? 'min-h-14 flex-1 flex-col justify-center gap-0.5 text-sm' : 'min-h-12 px-4'}`}
      >
        <Icon name={s.icon} className="size-5 shrink-0" />
        {/* Five tabs on a 320 px phone: a long name is cut, never pushes the others out. */}
        <span className="max-w-full truncate">{s.name}</span>
      </button>
    )
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-divider bg-sidebar">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center gap-2 px-3 py-2 md:px-6">
          {/* The restaurant and who entered, where the logo with name says «con Faro». */}
          <span className="mr-auto flex min-w-0 items-center gap-2.5">
            <BrandMark brand={me.restaurant.brand} />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="font-heading truncate text-lg font-bold tracking-tight">
                {me.restaurant.name}
              </span>
              <span className="truncate text-sm text-muted">{me.user.name}</span>
            </span>
          </span>
          <nav aria-label="Secciones" className="hidden gap-1 md:flex">
            {sections.map((s) => tab(s, false))}
          </nav>
          <Button
            variant="ghost"
            icon={dark ? 'sun' : 'moon'}
            aria-label="Modo oscuro"
            aria-pressed={dark}
            onClick={() => select(dark ? 'light' : 'dark')}
          />
          <Button variant="ghost" icon="exit" onClick={onSignOut} className="max-sm:px-2">
            Salir
          </Button>
        </div>
        <div className="brand-signature" aria-hidden="true" />
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 pb-28 md:p-6 md:pb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1
              ref={heading}
              tabIndex={-1}
              className="font-heading text-2xl font-bold tracking-tight outline-none"
            >
              {title}
            </h1>
            <LiveMark state={liveState} />
          </div>
          {actions}
        </div>
        {children}
      </main>

      <nav
        aria-label="Secciones"
        className="fixed inset-x-0 bottom-0 z-30 flex gap-1 border-t border-divider bg-sidebar px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden"
      >
        {inBar.map((s) => tab(s, true))}
        {inMore.length > 0 && (
          <button
            type="button"
            aria-haspopup="dialog"
            aria-current={inMore.some((s) => s.route === route) ? 'page' : undefined}
            onClick={() => setMoreOpen(true)}
            className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-sm font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-focus ${
              inMore.some((s) => s.route === route)
                ? 'bg-action-soft text-action-text'
                : 'text-foreground hover:bg-surface-2'
            }`}
          >
            <Icon name="more" className="size-5 shrink-0" />
            Más
          </button>
        )}
      </nav>
      <SidePanel opened={moreOpen} title="Más" onClose={() => setMoreOpen(false)}>
        <nav aria-label="Más secciones" className="flex flex-col gap-2">
          {inMore.map((s) => tab(s, false))}
        </nav>
      </SidePanel>
    </div>
  )
}

const LIVE_TEXT: Record<LiveState, string> = {
  live: 'En vivo',
  connecting: 'Conectando…',
  // Without the socket the screen still reads by itself: it says how often, without alarm.
  down: 'Se actualiza cada 15 s',
}

/**
 * Whether the screen updates by itself as things happen (the live socket) or only every 15 s. Small
 * and quiet, in gray (green is «libre» and «listo» in Faro): the data's own state («Actualizado…»,
 * «Sin noticias…») is what matters.
 */
export function LiveMark({ state }: { state: LiveState | null }) {
  if (!state) return null
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted">
      {state === 'live' && (
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-foreground" />
      )}
      {LIVE_TEXT[state]}
    </span>
  )
}
